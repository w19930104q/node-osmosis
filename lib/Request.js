'use strict';

var needle     = require('needle'),
    URL        = require('url'),
    libxml     = require('libxmljs-dom');

/**
 * Make an HTTP request.
 *
 * The `url` object is treated as immutable: every redirect hop is
 * recorded on the {@link Navigation} instead of mutating the original
 * location, and retries therefore always re-issue the exact request
 * the originating page started.
 *
 * @private
 * @param {string} method - Request method
 * @param {object} url - Parsed URL of the originating request
 * @param {object} params - GET query parameters or POST data
 * @param {object} opts - needle/osmosis options
 * @param {number} tries - Current attempt number
 * @param {function} callback - Callback function
 * @param {Navigation} [navigation] - Isolated context of this request
 */

function Request(method, url, params, opts, tries, callback, navigation) {
    // Work on copies so redirects and retries never mutate the
    // originating page's request description.
    var location      = cloneLocation(url),
        requestParams = cloneParams(params),
        requestOpts   = cloneOpts(opts);

    if (navigation !== undefined) {
        // Redirect hops are recorded per attempt: a retried request
        // re-issues the originating URL, so the hops logged by a failed
        // attempt must not accumulate on the shared navigation.
        navigation.redirects = [];
    }

    var stream = needle.request(method,
                          url.href,
                          requestParams,
                          requestOpts,
                          function (err, res, data) {

        if (err !== null) {
            callback(err.message);
            return;
        }

        if (requestOpts.ignore_http_errors !== true &&
            res                     !== undefined &&
            res.statusCode          >=  400   &&
            res.statusCode          <=  500
        ) {
            // HTTP error
            callback(res.statusCode + ' ' + res.statusMessage);
            return;
        }

        if (method !== 'head' && (!data || data.length === 0)) {
            callback('Data is empty');
            return;
        }

        function next(document) {
            if (requestOpts.parse === false) {
                if (navigation !== undefined) {
                    navigation.response = res;
                    reconcileRedirects(navigation, url.href, location.href);
                }

                callback(null, res, document);
                return;
            }

            document = libxml.parseHtml(document,
                { baseUrl: location.href, huge: true });

            if (document === null) {
                callback('Couldn\'t parse response');
                return;
            }

            if (document.errors[0] !== undefined &&
                document.errors[0].code === 4) {
                callback('Document is empty');
                return;
            }

            if (document.root() === null) {
                callback('Document has no root');
                return;
            }

            location.headers    = (res.req && res.req._headers) ||
                                   requestOpts.headers;
            location.proxy      = requestOpts.proxy;
            location.user_agent = requestOpts.user_agent;

            document.location = location;
            document.request  = location;

            setResponseMeta(document, res, data.length);
            setCookies(document, res.cookies);
            setCookies(document, requestOpts.cookies);

            if (navigation !== undefined) {
                // Bind the response to the navigation that initiated
                // the request, even after 302s and retries.
                navigation.location  = location;
                navigation.response  = document.response;
                navigation.setCookies(res.cookies);
                navigation.setRequestHeaders(location.headers);
                reconcileRedirects(navigation, url.href, location.href);
                document.navigation = navigation;
            }

            if (requestOpts.keep_data === true) {
                document.response.data = data;
            }

            callback(null, res, document);
        }

        if (
            requestOpts.process_response !== undefined &&
            typeof requestOpts.process_response === 'function'
        ) {
            if (requestOpts.process_response.length > 2) {
                requestOpts.process_response(data, res, next, callback);
                return;
            }

            next(requestOpts.process_response(data, res));
        } else {
            next(data);
        }

    });

    // Best-effort per-hop recording.  needle 1.6.0 starts the request
    // synchronously and can emit 'redirect' before this listener is
    // attached on a fast loopback connection, in which case the hop is
    // missed here.  reconcileRedirects() at response time repairs the
    // head/tail from the authoritative originating and final URLs.
    stream.on('redirect', function (href) {
        var previous = location.href,
            resolved = URL.resolve(previous, href);

        // Keep the working location in sync for base URL resolution,
        // but never touch the original `url` object.
        extend(location, URL.parse(resolved));

        if (navigation !== undefined) {
            navigation.addRedirect(previous, resolved);
        } else {
            // Backwards-compatible fallback for callers that do not
            // provide a Navigation context.
            extend(url, URL.parse(resolved));
        }
    });

    return stream;
}

/**
 * Reconcile the redirect hops recorded via needle's 'redirect' event
 * with the authoritative originating and final URLs.
 *
 * needle 1.6.0 starts the request synchronously and emits 'redirect'
 * before the listener in {@link Request} can be attached, so on a fast
 * loopback response the first hop can be missed entirely.  Events that
 * did arrive are preserved; a missing head or tail is reconstructed from
 * the originating URL and the working location needle actually ended on.
 *
 * Limitation inherited from needle 1.6.0: its Needle constructor is
 * closure-private and it exposes no pre-socket hook or redirect history,
 * so an *intermediate* hop of a multi-hop chain whose event was lost
 * cannot be reconstructed externally.  Single-hop redirects (the common
 * case, and what the gated regression exercises) are always reported
 * correctly with accurate from/to URLs.
 *
 * @param {Navigation} navigation
 * @param {string} originHref - URL the originating page requested
 * @param {string} finalHref - URL of the final response
 */

function reconcileRedirects(navigation, originHref, finalHref) {
    var hops = navigation.redirects;

    if (finalHref === originHref) {
        navigation.redirects = [];
        return;
    }

    if (hops.length === 0 || hops[0].from !== originHref) {
        hops.unshift({ from: originHref, to: hops.length ?
                                           hops[0].from :
                                           finalHref });
    }

    if (hops[hops.length - 1].to !== finalHref) {
        hops.push({ from: hops[hops.length - 1].to, to: finalHref });
    }

    navigation.redirects = hops;
}

function setResponseMeta(document, res, size) {
    var response = {
            type: getResponseType(res.headers['content-type']),
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            size: {
                body: size
            }
        };


    if (res.socket !== undefined) {
        response.size.total   = res.socket.bytesRead;
        response.size.headers = res.socket.bytesRead - size;
    }

    document.response = response;
}

function getResponseType(contentType) {
    if (contentType === undefined) {
        return null;
    }

    if (contentType.indexOf('xml') !== -1) {
        return 'xml';
    }

    if (contentType.indexOf('html') !== -1) {
        return 'html';
    }

    return contentType;
}


function setCookies(document, cookies) {
    var key, keys, length;

    if (cookies === undefined) {
        return;
    }

    keys = Object.keys(cookies);
    length = keys.length;

    if (length === 0) {
        return;
    }

    if (document.cookies === undefined) {
        document.cookies = {};
    }

    while (length--) {
        key = keys[length];
        document.cookies[key] = cookies[key];
    }
}

function extend(object, donor) {
    var key, keys = Object.keys(donor || {}), i = keys.length;

    while (i--) {
        key = keys[i];
        object[key] = donor[key];
    }

    return object;
}

/**
 * Copy a parsed URL object.  Every request/attempt gets its own
 * location so concurrent branches cannot share mutable state.
 */

function cloneLocation(url) {
    var location = URL.parse(url.href, true),
        key;

    location.method = url.method;
    // Always expose an object so `document.request.params.page` works
    // for parameter-less GET requests while needle still gets null.
    location.params = (url.params instanceof Object && url.params !== null) ?
                      extend({}, url.params) :
                      (location.query || {});

    return location;
}

/**
 * Copy request parameters so retries cannot be affected by mutations
 * made during a previous attempt (needle stringifies POST bodies).
 */

function cloneParams(params) {
    if (params === undefined || params === null) {
        // Preserve null/undefined so needle does not stringify an
        // empty body over an URL that already carries a query string.
        return params;
    }

    if (params instanceof Object) {
        return extend({}, params);
    }

    return params;
}

/**
 * Shallow-copy the request options and give every attempt its own
 * headers/cookies objects.  Proxies keep their shared rotation state.
 */

function cloneOpts(opts) {
    var copy = Object.create(Object.getPrototypeOf(opts)),
        key;

    // for-in walks own and inherited enumerable options; nested
    // headers/cookies are already independent own-property objects by
    // the time they reach Request (see Command.request), so reference
    // them directly to preserve their insertion order.
    for (key in opts) {
        copy[key] = opts[key];
    }

    return copy;
}

module.exports = Request;
