'use strict';

/**
 * A Navigation represents the isolated context of a single logical
 * navigation (one page load, including its redirects and retries).
 *
 * Every HTTP request triggered by {@link Command.request} creates a
 * child Navigation of the document that initiated it.  Concurrent
 * branches therefore get independent page counters, parameters,
 * responses and stop states, while cookies and headers are inherited
 * (cloned) from the originating page.
 *
 * @constructor Navigation
 * @protected
 * @param {Navigation} [parent] - The Navigation that issued this request
 * @returns Navigation
 */

function Navigation(parent, initialHref) {
    this.parent      = parent;
    // The chain root identifies one independent crawl chain.
    // `.follow()` starts a fresh chain root for every link, so a
    // paginate `limit` is counted per branch; plain pagination keeps
    // sharing the same root across its own pages.
    this.chainRoot   = parent ? parent.chainRoot : this;
    this.stopped     = false;
    this.count       = 1;
    this.submitted   = 0;
    this.urls        = [];
    this.cookies     = {};
    this.headers     = {};
    this.location    = null;
    this.response    = null;
    this.redirects   = [];

    if (parent !== undefined) {
        this.cookies = Navigation.clone(parent.cookies);
        this.headers = Navigation.clone(parent.headers);
        this.count   = parent.count + 1;
        // Visit history and page budgets belong to the whole chain,
        // so pagination loops and limits survive across navigations.
        this.urls      = parent.urls;
        this.submitted = parent.submitted;
    } else if (initialHref !== undefined) {
        this.urls.push(initialHref);
    }

    return this;
}

Navigation.prototype = {
    isNavigation: true,

    /**
     * Start a new independent chain.
     *
     * Used by `.follow()`: each followed link gets its own page
     * budget and visit history while still inheriting cookies and
     * headers from the originating page.
     *
     * @returns Navigation
     */

    branch: function () {
        var navigation = new Navigation(this);

        navigation.chainRoot = navigation;
        navigation.urls      = [];
        navigation.submitted = 0;

        return navigation;
    },

    /**
     * Record an outgoing URL against the whole navigation chain.
     *
     * @param {string} href - Absolute URL being requested
     * @returns bool - true when the URL has already been visited by
     *                 this chain (a pagination loop / missing link)
     */

    track: function (href) {
        var duplicate = this.chainRoot.urls.indexOf(href) !== -1;

        this.chainRoot.urls.push(href);

        return duplicate;
    },

    /**
     * Whether this chain has already requested the given URL.
     * Unlike {@link Navigation.track} this does not record anything.
     *
     * @param {string} href
     * @returns bool
     */

    hasVisited: function (href) {
        return this.chainRoot.urls.indexOf(href) !== -1;
    },

    /**
     * Number of pages already submitted by this navigation chain.
     *
     * @returns number
     */

    submittedPages: function () {
        return this.chainRoot.submitted;
    },

    /**
     * Stop only this navigation chain.  Already queued requests of
     * sibling branches keep running; the global instance stop state
     * remains untouched.
     */

    stop: function () {
        this.stopped = true;
    },

    /**
     * Whether this chain or any ancestor has been stopped.
     *
     * @returns bool
     */

    isStopped: function () {
        var navigation = this;

        while (navigation !== undefined && navigation !== null) {
            if (navigation.stopped === true) {
                return true;
            }

            navigation = navigation.parent;
        }

        return false;
    },

    /**
     * Merge Set-Cookie values back into this navigation.  Because each
     * request got a cloned cookie jar, this never mutates siblings.
     *
     * @param {object} cookies
     */

    setCookies: function (cookies) {
        var key, keys;

        if (cookies === undefined || cookies === null) {
            return;
        }

        keys = Object.keys(cookies);

        while (keys.length) {
            key = keys.pop();
            this.cookies[key] = cookies[key];
        }
    },

    /**
     * Snapshot the request headers that actually reached the server
     * after the final redirect hop.
     *
     * @param {object} headers
     */

    setRequestHeaders: function (headers) {
        this.requestHeaders = Navigation.clone(headers);
    },

    /**
     * Record one redirect hop without mutating the original URL
     * object, so retries always re-issue the originating request.
     *
     * @param {string} from
     * @param {string} to
     */

    addRedirect: function (from, to) {
        this.redirects.push({ from: from, to: to });
    }
};

/**
 * Deep-ish clone of a flat headers/cookies object.
 *
 * @param {object} object
 * @returns object
 */

Navigation.clone = function (object) {
    var clone = {}, key;

    if (object === undefined || object === null) {
        return clone;
    }

    // for-in also walks inherited enumerable properties, which matters
    // because osmosis options are prototype-chained via Object.create.
    for (key in object) {
        if (object[key] instanceof Object) {
            clone[key] = Navigation.clone(object[key]);
        } else {
            clone[key] = object[key];
        }
    }

    return clone;
};

/**
 * Resolve the Navigation attached to a libxmljs Document or Element.
 *
 * @param {object} document
 * @returns Navigation|undefined
 */

Navigation.fromDocument = function (document) {
    if (document === undefined || document === null) {
        return undefined;
    }

    if (document.navigation !== undefined) {
        return document.navigation;
    }

    if (document.doc !== undefined) {
        document = document.doc();

        if (document !== undefined && document !== null &&
            document.navigation !== undefined) {
            return document.navigation;
        }
    }

    return undefined;
};

module.exports = Navigation;
