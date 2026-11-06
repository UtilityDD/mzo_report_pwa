/* mzo_view.js — precomputed page views (window.MzoView). VM mirror mode only; no dependencies.
 *
 * A heavy page (meter utilization, smart meter, sheet links) can ask the VM for what it would
 * otherwise compute from several whole datasets: GET /api/data/view/<name>[?part=<part>], built
 * once per sync by vm/sync/views.js (docs/uniform-data.md, "Page views").
 *
 *   MzoView.load(name, render, opts) → Promise<boolean>
 *     render(doc, { cached }) paints the view: first the copy this browser kept (IndexedDB, by
 *     ETag), then a newer one if the server has it. Resolves true when the view is current, false
 *     when the server has none (Vercel, local, or the view is being rebuilt after new data): the page
 *     then loads and computes as it always did. opts: { part, noPaint (skip the cached paint) }
 *
 * The cached copy is only painted; the answer that counts is the server's (304 = the cached copy is
 * current). A view holds every office's rows, like MzoRows' cache; pages scope them as before.
 */
(function (g) {
  'use strict';

  var dbP = null, memory = {};
  function db() {
    if (dbP) return dbP;
    dbP = new Promise(function (resolve) {
      try {
        var req = indexedDB.open('MZOViews', 1);
        req.onupgradeneeded = function () { if (!req.result.objectStoreNames.contains('views')) req.result.createObjectStore('views'); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
    return dbP;
  }
  function idb(mode, key, value) {
    return db().then(function (d) {
      if (!d) { if (mode === 'put') memory[key] = value; return mode === 'get' ? memory[key] : undefined; }
      return new Promise(function (resolve) {
        try {
          var tx = d.transaction('views', mode === 'get' ? 'readonly' : 'readwrite'), st = tx.objectStore('views');
          var req = mode === 'get' ? st.get(key) : st.put(value, key);
          req.onsuccess = function () { resolve(mode === 'get' ? req.result : undefined); };
          req.onerror = function () { resolve(undefined); };
        } catch (e) { resolve(undefined); }
      });
    });
  }

  function request(name, part, etag) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, 60000) : null;
    var headers = { Accept: 'application/json' };
    if (etag) headers['If-None-Match'] = etag;
    return fetch('/api/data/view/' + encodeURIComponent(name) + (part ? '?part=' + encodeURIComponent(part) : ''),
      { credentials: 'same-origin', cache: 'no-cache', headers: headers, signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { if (t) clearTimeout(t); return r; }, function (e) { if (t) clearTimeout(t); throw e; });
  }

  var inflight = {};
  function load(name, render, opts) {
    opts = opts || {};
    var key = name + (opts.part ? '.' + opts.part : '');
    return idb('get', key).then(function (cached) {
      var have = cached && cached.json && cached.etag ? cached : null;
      if (have && !opts.noPaint) {
        try { render(JSON.parse(have.json), { cached: true }); } catch (e) { have = null; }
      }
      if (!inflight[key]) {
        inflight[key] = request(name, opts.part, have && have.etag).then(function (res) {
          if (res.status === 304 && have) return { same: true };
          if (res.status !== 200) return null;
          var etag = res.headers.get('ETag') || '';
          return res.text().then(function (json) {
            if (etag) idb('put', key, { etag: etag, json: json, at: Date.now() }); // not awaited: paint first
            return { json: json };
          });
        }).then(function (r) { delete inflight[key]; return r; }, function (e) { delete inflight[key]; throw e; });
      }
      return inflight[key].then(function (r) {
        if (!r) return false;
        if (r.same) {
          if (opts.noPaint) render(JSON.parse(have.json), { cached: true });
          return true;
        }
        render(JSON.parse(r.json), { cached: false });
        return true;
      }, function () {
        // Offline or the server did not answer: the kept copy stands if there is one.
        if (have && opts.noPaint) render(JSON.parse(have.json), { cached: true });
        return !!have;
      });
    }, function () { return false; });
  }

  g.MzoView = { load: load };
})(typeof self !== 'undefined' ? self : this);
