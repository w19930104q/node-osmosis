/*jslint node: true */
'use strict';

/**
 * Follow a url.
 *
 * Each link gets its own isolated {@link Navigation} branch context,
 * inheriting cookies and headers from the current page.  Repeated links
 * (identical hrefs) are each followed once per link node, and every
 * resulting document keeps the sort index of its originating node so
 * downstream data stays in document order even under concurrency.
 *
 * @function follow
 * @memberof Command
 * @param {Selector} selector - A selector string for link nodes
 * @instance
 */

var Navigation = require('../Navigation.js');

module.exports.follow = function (context, data, next, done) {
    var selector = this.args[0],
        self     = this,
        nodes    = context.find(selector),
        document = context.doc(),
        parent   = Navigation.fromDocument(document),
        i = 0, queue = 0, length, node, url,
        requestDone = function (err, document) {
            if (err === null) {
                next(document, data, document._dataSortIndex);
            }

            if (--queue === 0) {
                done();
            }
        };

    if (nodes === undefined || nodes.length === 0) {
        done('no results for "' + selector +
             '" in ' + document.location.href);
        return;
    }

    if (parent !== undefined && parent.isStopped()) {
        // The chain that owns these links has been stopped.
        return done();
    }

    for (length = nodes.length, i = 0; i < length; i++) {
        node = nodes[i];

        if (node.value !== undefined) {
            url = node.value();
        } else if (url = node.attr('href')) {
            // Don't use Attribute.text() or Attribute.value()
            // in order to keep URL encoding
            url = url.toString();
            url = url.substring(url.indexOf('"') + 1, url.lastIndexOf('"'));
        } else {
            url = node.text();
        }

        if (url !== null && url.length > 0) {
            queue++;

            self.log("url: " + url);
            // Every link starts an independent navigation chain: its
            // own page count, parameters, response and stop state,
            // while cookies and headers are inherited from this page.
            self.request('get',
                        node,
                        url,
                        null,
                        requestDone,
                        i,
                        { branch: true });
        }
    }

    if (queue === 0) {
        done();
    }
};
