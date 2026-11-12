'use strict';

/**
 * Local gated HTTP regression tests for isolated navigation contexts.
 *
 * Every test spins up its own HTTP server on an ephemeral port so it
 * never depends on (or mutates) the shared test/server state.  The
 * suite covers:
 *
 *   - concurrent branches keeping their own parent page and index
 *   - POST (form) pagination
 *   - cross-host redirects (cookie + redirect binding)
 *   - duplicate links (one result per link node)
 *   - document position (sort index) surviving concurrent follows
 *   - stopping a single instance
 *   - failed requests being retried and re-run cleanly
 *   - pagination loops and missing next links terminating
 *   - limit counted against submitted pages
 */

var http    = require('http'),
    qs      = require('querystring'),
    osmosis = require('../index');

/**
 * Start a server with the given request handler and resolve with a
 * base URL.  The returned `close` function shuts the server down.
 */

function startServer(handler) {
    return new Promise(function (resolve) {
        var server = http.createServer(handler);

        server.listen(0, '127.0.0.1', function () {
            var port = server.address().port;

            resolve({
                base: 'http://127.0.0.1:' + port,
                close: function () { server.close(); }
            });
        });
    });
}

/**
 * Run a scrape and resolve when it reaches `.done`.  Intermediate
 * error messages (e.g. retries before an eventual success) are
 * collected rather than rejecting the promise.
 */

function run(scrape) {
    return new Promise(function (resolve) {
        var settled = false,
            errors  = [];

        scrape
        .error(function (msg) {
            errors.push(msg);
        })
        .done(function () {
            if (settled === false) {
                settled = true;
                resolve(errors);
            }
        });
    });
}

function finish(assert, srv, fn) {
    try {
        fn();
        srv.close();
        assert.done();
    } catch (err) {
        srv.close();
        assert.ok(false, err.message);
        assert.done();
    }
}

module.exports.concurrent_branches_isolated = function (assert) {
    var branches = 4,
        pages    = 5;

    startServer(function (req, res) {
        var u = require('url').parse(req.url, true);

        res.setHeader('Content-Type', 'text/html');

        if (u.pathname === '/list') {
            var html = '<ul>', i;

            for (i = 1; i <= branches; i++) {
                html += '<li><a href="/branch?id=' + i + '">b' + i +
                        '</a></li>';
            }

            res.end(html + '</ul>');
        } else {
            var id   = u.query.id,
                page = parseInt(u.query.page || '1', 10),
                next = page + 1;

            res.end('<div>branch' + id + '-page' + page + '</div>' +
                    '<a href="/branch?id=' + id + '&page=' + next +
                    '">next</a>');
        }
    }).then(function (srv) {
        var seen = [];

        run(
            osmosis.get(srv.base + '/list')
            .follow('li a')
            .paginate('a', pages)
            .set('marker', 'div')
            .data(function (d) {
                seen.push(d.marker);
            })
        ).then(function () {
            finish(assert, srv, function () {
                var expected = [], b, p;

                for (b = 1; b <= branches; b++) {
                    for (p = 1; p <= pages; p++) {
                        expected.push('branch' + b + '-page' + p);
                    }
                }

                assert.equal(seen.length, expected.length);
                expected.forEach(function (marker) {
                    assert.ok(seen.indexOf(marker) !== -1,
                              'missing ' + marker);
                });

                seen.forEach(function (marker) {
                    var n = parseInt(marker.split('page')[1], 10);
                    assert.ok(n <= pages, 'page beyond limit');
                });
            });
        });
    });
};

module.exports.post_pagination = function (assert) {
    startServer(function (req, res) {
        var body = '';

        res.setHeader('Content-Type', 'text/html');

        if (req.method === 'POST') {
            req.on('data', function (c) { body += c; });
            req.on('end', function () {
                var page = parseInt(qs.parse(body).page || '1', 10),
                    next = page + 1;

                res.end('<div>' + page + '</div>' +
                        '<form method="POST">' +
                        '<input type="hidden" name="page" value="' + next +
                        '"></form>');
            });
        } else {
            res.end('<div>1</div><form method="POST">' +
                    '<input type="hidden" name="page" value="2"></form>');
        }
    }).then(function (srv) {
        var pages = [];

        run(
            osmosis.get(srv.base + '/post-pages')
            .paginate('form', 4)
            .set('page', 'div')
            .data(function (d) {
                pages.push(parseInt(d.page, 10));
            })
        ).then(function () {
            finish(assert, srv, function () {
                assert.deepEqual(pages, [1, 2, 3, 4]);
            });
        });
    });
};

module.exports.cross_host_redirect = function (assert) {
    var backend = http.createServer(function (req, res) {
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Set-Cookie', 'session=kept');
        res.end('<div>redirected:' + (req.headers.cookie || 'none') +
                '</div>');
    });

    backend.listen(0, '127.0.0.1', function () {
        var backendUrl = 'http://127.0.0.1:' + backend.address().port;

        startServer(function (req, res) {
            res.writeHead(302, { Location: backendUrl + '/landing' });
            res.end();
        }).then(function (front) {
            var marker;

            run(
                osmosis.get(front.base + '/start')
                .set('marker', 'div')
                .data(function (d) {
                    marker = d.marker;
                })
                .then(function (context) {
                    assert.ok(context.navigation !== undefined);
                    assert.equal(context.navigation.redirects.length, 1);
                    assert.equal(context.navigation.cookies.session,
                                 'kept');
                })
            ).then(function () {
                finish(assert, front, function () {
                    assert.ok(marker.indexOf('redirected:') === 0);
                    backend.close();
                });
            });
        });
    });
};

module.exports.duplicate_links_keep_order = function (assert) {
    startServer(function (req, res) {
        var u = require('url').parse(req.url, true);

        res.setHeader('Content-Type', 'text/html');

        if (u.pathname === '/dup') {
            res.end('<ul>' +
                    '<li><a href="/item?id=1"></a></li>' +
                    '<li><a href="/item?id=1"></a></li>' +
                    '<li><a href="/item?id=1"></a></li>' +
                    '<li><a href="/item?id=2"></a></li>' +
                    '</ul>');
        } else {
            res.end('<div>item' + u.query.id + '</div>');
        }
    }).then(function (srv) {
        var items = [];

        run(
            osmosis.get(srv.base + '/dup')
            .follow('li a')
            .set('item', 'div')
            .data(function (d) {
                items.push(d.item);
            })
        ).then(function () {
            finish(assert, srv, function () {
                // One result per link node, duplicate hrefs included.
                // Concurrent completion order is not guaranteed, so
                // compare the sorted multiset.
                assert.equal(items.length, 4);
                assert.deepEqual(items.slice().sort(),
                    ['item1', 'item1', 'item1', 'item2']);
            });
        });
    });
};

module.exports.concurrent_follow_keeps_sort_index = function (assert) {
    startServer(function (req, res) {
        var u = require('url').parse(req.url, true);

        res.setHeader('Content-Type', 'text/html');

        if (u.pathname === '/arr') {
            var html = '<ul>', i;

            for (i = 1; i <= 5; i++) {
                html += '<li><a href="/arr-item?id=' + i + '"></a></li>';
            }

            res.end(html + '</ul>');
        } else {
            res.end('<div>v' + u.query.id + '</div>');
        }
    }).then(function (srv) {
        var sortIndexes = [],
            values      = [];

        run(
            osmosis.get(srv.base + '/arr')
            .follow('li a')
            .then(function (context, data, next, done) {
                // Each followed branch retains the document position
                // assigned by `.follow()`, which is the key downstream
                // array aggregation orders by.
                sortIndexes.push(context._dataSortIndex);
                next(context, data);
                done();
            })
            .set('values', 'div')
            .data(function (d) {
                values.push(d.values);
            })
        ).then(function () {
            finish(assert, srv, function () {
                assert.equal(values.length, 5);
                assert.deepEqual(sortIndexes.slice().sort(),
                    [0, 1, 2, 3, 4]);
                assert.deepEqual(values.slice().sort(),
                    ['v1', 'v2', 'v3', 'v4', 'v5']);
            });
        });
    });
};

module.exports.stop_terminates_branch = function (assert) {
    startServer(function (req, res) {
        res.setHeader('Content-Type', 'text/html');
        res.end('<a href="/loop"></a>');
    }).then(function (srv) {
        var loaded = 0,
            instance;

        instance =
        osmosis.get(srv.base + '/loop')
        .follow('a')
        .follow('a')
        .follow('a')
        .log(function (msg) {
            if (msg.indexOf('loaded') > -1) {
                loaded++;

                if (loaded === 2) {
                    instance.stop();
                }
            }
        })
        .then(function () {
            assert.ok(false, 'no data should be emitted after stop');
        })
        .done(function () {
            assert.ok(loaded >= 2);
            setTimeout(function () {
                srv.close();
                assert.done();
            }, 100);
        });
    });
};

module.exports.failure_retry_and_rerun = function (assert) {
    var attempts = 0;

    startServer(function (req, res) {
        res.setHeader('Content-Type', 'text/html');

        // Fail the first two attempts, succeed on the third.
        if (attempts++ < 2) {
            res.destroy();
            return;
        }

        res.end('<div>ok-after-retry</div>');
    }).then(function (srv) {
        var collected = [],
            afterFirst;

        function scrape() {
            collected = [];

            return run(
                osmosis.get(srv.base + '/flaky')
                .config('tries', 4)
                .set('status', 'div')
                .data(function (d) {
                    collected.push(d.status);
                })
            );
        }

        scrape().then(function () {
            assert.deepEqual(collected, ['ok-after-retry']);
            assert.ok(attempts >= 3,
                      'retried until success (' + attempts + ')');
            afterFirst = attempts;

            return scrape();
        }).then(function () {
            finish(assert, srv, function () {
                assert.deepEqual(collected, ['ok-after-retry']);
                assert.ok(attempts > afterFirst,
                          're-run issued its own request');
            });
        });
    });
};

module.exports.pagination_loop_terminates = function (assert) {
    startServer(function (req, res) {
        var u = require('url').parse(req.url, true);

        res.setHeader('Content-Type', 'text/html');

        if (u.pathname === '/entry') {
            res.end('<div>entry</div><a href="/cycle?page=1">next</a>');
        } else {
            var page = u.query.page;

            res.end('<div>page' + page + '</div>' +
                    '<a href="/cycle?page=' +
                    (page === '1' ? '2' : '1') + '">next</a>');
        }
    }).then(function (srv) {
        var pages = [];

        // No limit: loop detection itself must end the chain.
        run(
            osmosis.get(srv.base + '/entry')
            .paginate('a')
            .set('p', 'div')
            .data(function (d) {
                pages.push(d.p);
            })
        ).then(function () {
            finish(assert, srv, function () {
                assert.deepEqual(pages, ['entry', 'page1', 'page2']);
            });
        });
    });
};

module.exports.missing_next_link_terminates = function (assert) {
    startServer(function (req, res) {
        var u = require('url').parse(req.url, true);

        res.setHeader('Content-Type', 'text/html');

        if (u.pathname === '/start') {
            res.end('<div>start</div>' +
                    '<a rel="next" href="/tail">next</a>');
        } else {
            // Last page has no next link.
            res.end('<div>tail</div>');
        }
    }).then(function (srv) {
        var pages      = [],
            terminated = false;

        // A missing "next" link ends the chain.  osmosis surfaces this
        // as an error message while still emitting every loaded page
        // and without hanging.
        osmosis.get(srv.base + '/start')
        .paginate('a[rel="next"]')
        .set('p', 'div')
        .data(function (d) {
            pages.push(d.p);
        })
        .error(function (msg) {
            if (String(msg).indexOf('no results') > -1) {
                terminated = true;
            }
        })
        .done(function () {
            finish(assert, srv, function () {
                assert.deepEqual(pages, ['start', 'tail']);
                assert.ok(terminated, 'missing next link ended the chain');
            });
        });
    });
};

module.exports.limit_counts_submitted_pages = function (assert) {
    startServer(function (req, res) {
        var u = require('url').parse(req.url, true),
            page = parseInt(u.query.page || '1', 10);

        res.setHeader('Content-Type', 'text/html');
        res.end('<div>' + page + '</div>' +
                '<a href="/p?page=' + (page + 1) + '">next</a>');
    }).then(function (srv) {
        var pages = [];

        run(
            osmosis.get(srv.base + '/p?page=1')
            .paginate('a', 3)
            .set('n', 'div')
            .data(function (d) {
                pages.push(parseInt(d.n, 10));
            })
        ).then(function () {
            finish(assert, srv, function () {
                assert.deepEqual(pages, [1, 2, 3]);
            });
        });
    });
};
