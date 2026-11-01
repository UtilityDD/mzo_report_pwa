/* mzo_rows.js — uniform rows for report pages (window.MzoRows). No dependencies; uses
 * window.mzoDataHub (raw sources), window.MzoScope (login scope) and, only when rows have to be
 * computed in this browser, /lib/offices.js + /lib/uniform.js (in a Web Worker for big datasets).
 *
 *   MzoRows.load(key, render, opts)   paint from the cache at once, render again when newer rows arrive
 *     render(t, info): t = { key, version, columns, rows (objects, scoped), all (every row), first(field),
 *                      issues, stats, source, ms } or null;
 *                      info = { cached, error }
 *     opts: { scope: true (MzoScope rows only), forceCheck, hub, url, format }
 *   MzoRows.get(key, opts) → Promise<t>   the checked, current rows (no early paint)
 *   MzoRows.refresh(btn, key, onRows)     a refresh button: forced check, spinner always cleared
 *   MzoRows.reload(key)                   forget the cached rows and the raw body, download again
 *   MzoRows.scope(rows)                   login-scope filter on uniform rows (load does it unless scope: false)
 *   MzoRows.levels                        UI.drill levels on the canonical office fields
 *
 * Where the rows come from (docs/uniform-data.md):
 *   1. IndexedDB (MZORows/rows): the last rows this device saw, painted first.
 *   2. Mirror (VM, /api/data/manifest lists the key): GET /api/data/rows/<key>, ETag/304.
 *   3. Otherwise (Vercel, or the mirror cannot serve them): the raw source through DataHub
 *      (schema/<key>.json names its CACHE_* key), turned into rows here with lib/uniform.js.
 * The same lib/uniform.js runs on the VM, so 2 and 3 give the same bytes.
 * This file is also the Web Worker script (new Worker('/mzo_rows.js?worker=1')).
 */
(function (g) {
  'use strict';

  var UNIFORM_SRC = '/lib/uniform.js?v=1';
  var OFFICES_SRC = '/lib/offices.js?v=2';
  var COSTCENTER_URL = '/data/costcenter.json';
  // Cached rows computed here are valid only for this code: bump with the ?v= values above.
  var CODE = UNIFORM_SRC + '|' + OFFICES_SRC;

  /* ---------------- worker side ---------------- */
  if (typeof window === 'undefined' && typeof importScripts === 'function') {
    importScripts(OFFICES_SRC, UNIFORM_SRC);
    var ccDone = false;
    g.onmessage = function (e) {
      var m = e.data || {};
      try {
        if (!ccDone) { g.MzoUniform.useOffices(g.MzoOffices || null, m.costCentres || []); ccDone = true; }
        var t0 = Date.now();
        var res = g.MzoUniform.build(m.input, m.opts);
        var json = g.MzoUniform.stringify(res);
        g.postMessage({ id: m.id, json: json, ms: Date.now() - t0 });
      } catch (err) {
        g.postMessage({ id: m.id, error: String((err && err.message) || err) });
      }
    };
    return;
  }

  /* ---------------- small helpers ---------------- */
  function now() { return (g.performance && performance.now) ? performance.now() : Date.now(); }
  function hash32(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  function ss(k, v) {
    try { if (v === undefined) return JSON.parse(sessionStorage.getItem(k) || 'null'); sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
    return null;
  }
  function fetchT(url, init, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, ms || 90000) : null;
    return fetch(url, Object.assign({ credentials: 'same-origin' }, init || {}, ctrl ? { signal: ctrl.signal } : {}))
      .then(function (r) { if (t) clearTimeout(t); return r; }, function (e) { if (t) clearTimeout(t); throw e; });
  }

  /* ---------------- IndexedDB: { key, meta, json } ---------------- */
  var dbP = null;
  function db() {
    if (dbP) return dbP;
    dbP = new Promise(function (resolve) {
      try {
        var req = indexedDB.open('MZORows', 1);
        req.onupgradeneeded = function () { if (!req.result.objectStoreNames.contains('rows')) req.result.createObjectStore('rows'); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
    return dbP;
  }
  var memory = {};
  function idb(mode, key, value) {
    return db().then(function (d) {
      if (!d) { if (mode === 'put') memory[key] = value; else if (mode === 'delete') delete memory[key]; return mode === 'get' ? memory[key] : undefined; }
      return new Promise(function (resolve) {
        try {
          var tx = d.transaction('rows', mode === 'get' ? 'readonly' : 'readwrite'), st = tx.objectStore('rows');
          var req = mode === 'get' ? st.get(key) : mode === 'put' ? st.put(value, key) : st.delete(key);
          req.onsuccess = function () { resolve(mode === 'get' ? req.result : undefined); };
          req.onerror = function () { resolve(undefined); };
        } catch (e) { resolve(undefined); }
      });
    });
  }

  /* ---------------- schema, manifest, scripts ---------------- */
  var schemaP = {};
  function schema(key) {
    if (!schemaP[key]) {
      schemaP[key] = fetchT('/schema/' + encodeURIComponent(key) + '.json', { cache: 'no-cache' }, 15000)
        .then(function (r) { return r.ok ? r.text() : ''; })
        .then(function (text) { return text ? { doc: JSON.parse(text), hash: hash32(text) } : { doc: null, hash: '' }; })
        .catch(function () { return { doc: null, hash: '', failed: true }; });
    }
    return schemaP[key];
  }

  // The mirror's manifest (VM only). Shared with DataHub when it offers one; 20 s in sessionStorage.
  var manifestP = null;
  function manifest() {
    if (manifestP) return manifestP;
    var hub = g.mzoDataHub;
    if (hub && typeof hub.manifest === 'function') {
      manifestP = Promise.resolve(hub.manifest()).catch(function () { return null; });
      return manifestP;
    }
    var c = ss('mzo_rows_manifest');
    if (c && Date.now() - c.at < (c.m ? 20000 : 600000)) { manifestP = Promise.resolve(c.m); return manifestP; }
    manifestP = fetchT('/api/data/manifest', { cache: 'no-cache' }, 8000)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (m) { m = m && m.datasets ? m : null; ss('mzo_rows_manifest', { at: Date.now(), m: m }); return m; });
    return manifestP;
  }

  var scriptP = {};
  function script(src) {
    if (!scriptP[src]) {
      scriptP[src] = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = src; s.async = false;
        s.onload = function () { resolve(); };
        s.onerror = function () { delete scriptP[src]; reject(new Error('could not load ' + src)); };
        (document.head || document.documentElement).appendChild(s);
      });
    }
    return scriptP[src];
  }
  var ccP = null;
  function costCentres() {
    if (!ccP) ccP = fetchT(COSTCENTER_URL, {}, 15000).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
    return ccP;
  }
  var inlineReady = null;
  function inlineUniform() {
    if (!inlineReady) {
      inlineReady = Promise.all([script(OFFICES_SRC).catch(function () {}), costCentres()]).then(function (r) {
        return script(UNIFORM_SRC).then(function () { g.MzoUniform.useOffices(g.MzoOffices || null, r[1]); return g.MzoUniform; });
      });
    }
    return inlineReady;
  }

  /* ---------------- computing rows here ---------------- */
  var worker = null, workerBroken = false, jobs = {}, jobId = 0, idleT = null;
  // Start the worker (and its script downloads) and the cost-centre list while the raw body is
  // still downloading; an unused worker stops after 30 s.
  function warm() {
    costCentres();
    if (worker || workerBroken || typeof Worker === 'undefined') return;
    try {
      worker = new Worker('/mzo_rows.js?v=2&worker=1');
    } catch (e) { workerBroken = true; return; }
    worker.onmessage = function (e) {
      var j = jobs[e.data.id]; if (!j) return;
      delete jobs[e.data.id];
      if (e.data.error) j.reject(new Error(e.data.error)); else j.resolve(e.data);
      idle();
    };
    worker.onerror = function (e) { workerBroken = true; Object.keys(jobs).forEach(function (id) { jobs[id].reject(new Error('worker failed')); delete jobs[id]; }); if (worker) worker.terminate(); worker = null; if (e && e.preventDefault) e.preventDefault(); };
    idle();
  }
  function idle() {
    clearTimeout(idleT);
    idleT = setTimeout(function () { if (worker && !Object.keys(jobs).length) { worker.terminate(); worker = null; } }, 30000);
  }
  function viaWorker(input, opts) {
    return costCentres().then(function (cc) {
      return new Promise(function (resolve, reject) {
        warm();
        if (!worker) { reject(new Error('no worker')); return; }
        clearTimeout(idleT);
        var id = ++jobId;
        jobs[id] = { resolve: resolve, reject: reject };
        worker.postMessage({ id: id, input: input, opts: opts, costCentres: cc });
      });
    });
  }
  function compute(input, opts) {
    var big = typeof input === 'string' ? input.length > 200000 : (input && input.length > 2000);
    var inline = function () {
      return inlineUniform().then(function (U) { var t0 = Date.now(); var json = U.stringify(U.build(input, opts)); return { json: json, ms: Date.now() - t0, where: 'main' }; });
    };
    if (big && !workerBroken && typeof Worker !== 'undefined') {
      return viaWorker(input, opts).then(function (r) { r.where = 'worker'; return r; }, function () { workerBroken = true; return inline(); });
    }
    return inline();
  }

  /* ---------------- rows document → page rows ---------------- */
  // A row's office as MzoScope reads it: the canonical fields first; a row with no canonical
  // office is matched on its own cells, as before.
  function scopeRows(rows) {
    var S = g.MzoScope;
    if (!S || !S.matchRow || S.isUnscoped()) return rows;
    return rows.filter(function (r) {
      if (!r._region && !r._division && !r._ccc && !r._ccc_code) return S.matchRow(r);
      return S.matchRow({ _region: r._region, _divn: r._division, _supp: r._ccc, CCC_CODE: r._ccc_code });
    });
  }
  function toT(key, json, source, opts, ms) {
    var t0 = now(), doc = JSON.parse(json), t1 = now();
    var t = fromDoc(key, doc, source, opts);
    t.ms = Object.assign({ parse: Math.round(t1 - t0), objects: Math.round(now() - t1), bytes: json.length }, ms || {});
    var missing = t.issues.filter(function (x) { return x.check === 'header.missing'; });
    if (missing.length && g.console) console.warn('[MzoRows] ' + key + ': missing columns ' + missing.map(function (x) { return x.column; }).join(', ') + ' (header changed in the source?)');
    MzoRows.last[key] = t.ms;
    return t;
  }
  // A parsed rows document → what render() gets. t.rows is scoped (unless scope: false);
  // t.all keeps every row, for values that live in one row of the sheet (report dates, "cell N2").
  function fromDoc(key, doc, source, opts) {
    var names = doc.columns.map(function (c) { return c.name; }), src = doc.rows, all = new Array(src.length);
    for (var i = 0; i < src.length; i++) { var a = src[i], o = {}; for (var k = 0; k < names.length; k++) o[names[k]] = a[k]; all[i] = o; }
    var rows = !opts || opts.scope !== false ? scopeRows(all) : all;
    return {
      key: key, version: doc.version, logic: doc.logic, schema: doc.schema, columns: doc.columns, rows: rows, all: all,
      issues: doc.issues || [], stats: doc.stats || {}, source: source,
      // First non-empty value of a field in source order, over every row (scope does not hide it).
      first: function (field) { for (var j = 0; j < all.length; j++) { var v = all[j][field]; if (v !== '' && v != null) return v; } return null; }
    };
  }

  /* ---------------- checking for newer rows ---------------- */
  // → { json, meta } when newer rows than `cached` exist, { same: true } when cached is current.
  function check(key, cached, opts) {
    opts = opts || {};
    var seen = ss('mzo_rows_manifest'), early = null;
    if (!opts.local && seen && seen.m && seen.m.datasets && seen.m.datasets[key]) early = rowsRequest(key, cached); // VM, seen earlier this session
    return Promise.all([schema(key), manifest()]).then(function (r) {
      var sc = r[0], m = r[1];
      if (m && m.datasets && m.datasets[key] && !opts.local) {
        return fromMirror(key, cached, sc, early).catch(function () { return fromSource(key, cached, sc, opts, true); });
      }
      return fromSource(key, cached, sc, opts, false);
    });
  }

  function rowsRequest(key, cached) {
    var headers = {}, t0 = now();
    if (cached && cached.meta && cached.meta.from === 'mirror' && cached.meta.etag) headers['If-None-Match'] = cached.meta.etag;
    return fetchT('/api/data/rows/' + encodeURIComponent(key), { cache: 'no-cache', headers: headers }, 120000)
      .then(function (res) { return { res: res, t0: t0 }; });
  }

  function fromMirror(key, cached, sc, early) {
    // The cached ETag only counts while the schema text is the one those rows were made for.
    var mine = cached && cached.meta && cached.meta.schemaFile === sc.hash ? cached : null;
    var req = early && (mine || !(cached && cached.meta && cached.meta.etag)) ? early : rowsRequest(key, mine);
    return req.then(function (x) {
      var res = x.res;
      if (res.status === 304 && mine) return { same: true };
      if (!res.ok) throw new Error('rows ' + res.status);
      var etag = res.headers.get('ETag') || '';
      return res.text().then(function (json) {
        return { json: json, meta: { from: 'mirror', etag: etag, schemaFile: sc.hash, at: Date.now() }, ms: { fetch: Math.round(now() - x.t0) }, source: 'mirror' };
      });
    });
  }

  function sourceOf(sc, opts) {
    var s = (sc.doc && sc.doc.source) || {};
    return { hub: opts.hub || s.hub || '', url: opts.url || s.url || '', format: opts.format || s.format || (sc.doc && sc.doc.format) || 'csv' };
  }

  function fromSource(key, cached, sc, opts, mirror) {
    var src = sourceOf(sc, opts), hub = g.mzoDataHub, t0 = now();
    if (!cached || !cached.meta || cached.meta.from !== 'local' || cached.meta.code !== CODE || cached.meta.schemaFile !== sc.hash) warm();
    var get;
    if (mirror) {
      // The VM has the raw snapshot even when it cannot serve rows.
      get = fetchT('/api/data/file/' + encodeURIComponent(key), { cache: 'no-cache' }, 180000).then(function (res) {
        if (!res.ok) throw new Error('file ' + res.status);
        return res.text().then(function (text) { return { text: text, ver: 'f:' + (res.headers.get('ETag') || hash32(text)) }; });
      });
    } else {
      if (!src.hub && src.url) src.hub = registerUrl(key, src);
      if (!src.hub || !hub) return Promise.reject(new Error('no source for ' + key + ' (add source.hub to schema/' + key + '.json)'));
      get = Promise.resolve(hub.waitForDataset(src.hub, opts.forceCheck ? { forceCheck: true } : undefined)).catch(function () {})
        .then(function () { return hub._peek(src.hub); })
        .then(function (body) {
          if (body == null || body === '') throw new Error('no data for ' + src.hub);
          var ver = '';
          try { ver = localStorage.getItem('mzo_hub_ver_' + src.hub) || ''; } catch (e) {}
          return { text: body, ver: ver || (hub._fingerprint ? hub._fingerprint(body) : hash32(String(body).slice(0, 65536)) + ':' + String(body).length) };
        });
    }
    return get.then(function (raw) {
      var t1 = now();
      if (cached && cached.meta && cached.meta.from === 'local' && cached.meta.raw === raw.ver && cached.meta.schemaFile === sc.hash && cached.meta.code === CODE) return { same: true };
      var input = typeof raw.text === 'string' ? raw.text : raw.text; // DataHub json datasets arrive parsed
      var format = typeof input === 'string' ? src.format : 'json';
      return compute(input, { key: key, version: raw.ver, format: format, schema: sc.doc }).then(function (out) {
        return { json: out.json, meta: { from: 'local', raw: raw.ver, schemaFile: sc.hash, code: CODE, at: Date.now() }, ms: { fetch: Math.round(t1 - t0), build: out.ms, where: out.where }, source: 'local' };
      });
    });
  }

  function registerUrl(key, src) {
    var hubKey = 'ROWS_' + key.toUpperCase();
    var list = g.MZO_DATASETS, hub = g.mzoDataHub;
    var def = { key: hubKey, label: key, url: src.url, type: src.format === 'json' ? 'json' : 'csv', lazySync: !!src.lazySync };
    if (hub && typeof hub.register === 'function') hub.register(def);
    else if (Array.isArray(list) && !list.some(function (d) { return d.key === hubKey; })) list.push(def);
    return hubKey;
  }

  /* ---------------- public API ---------------- */
  var inflight = {};
  function latest(key, cached, opts) {
    var k = key + (opts && opts.forceCheck ? '!' : '');
    if (!inflight[k]) {
      inflight[k] = check(key, cached, opts).then(function (r) {
        if (r && r.json) idb('put', key, { key: key, meta: r.meta, json: r.json }); // not awaited: paint first
        return r;
      }).then(function (r) { delete inflight[k]; return r; }, function (e) { delete inflight[k]; throw e; });
    }
    return inflight[k];
  }

  function load(key, render, opts) {
    opts = opts || {};
    var t0 = now(), first = null;
    // The cached rows are painted at once unless the page's schema changed since (a new field
    // would be missing from them); offline (schema unreachable) they are painted anyway.
    return Promise.all([idb('get', key), schema(key)]).then(function (r) {
      var cached = r[0], sc = r[1];
      var tIdb = Math.round(now() - t0);
      if (cached && cached.json && cached.meta && cached.meta.schemaFile !== sc.hash && !sc.failed) cached = { meta: cached.meta };
      if (cached && cached.json) {
        try { first = toT(key, cached.json, 'cache', opts, { idb: tIdb, total: Math.round(now() - t0) }); render(first, { cached: true }); }
        catch (e) { if (g.console) console.warn('[MzoRows] ' + key + ': cached rows unreadable', e); cached = null; first = null; }
      }
      return latest(key, cached, opts).then(function (r) {
        if (r && r.json) { var t = toT(key, r.json, r.source, opts, Object.assign({ idb: tIdb }, r.ms)); t.ms.total = Math.round(now() - t0); render(t, { cached: false }); }
        else if (!first) render(null, { error: true });
      }, function (err) {
        if (g.console) console.warn('[MzoRows] ' + key + ':', (err && err.message) || err);
        if (!first) render(null, { error: true });
      });
    });
  }

  function get(key, opts) {
    return idb('get', key).then(function (cached) {
      return latest(key, cached, opts).then(function (r) {
        if (r && r.json) return toT(key, r.json, r.source, opts);
        if (cached && cached.json) return toT(key, cached.json, 'cache', opts);
        throw new Error('no rows for ' + key);
      });
    });
  }

  function refresh(btn, key, onRows, opts) {
    if (typeof btn === 'string') btn = document.getElementById(btn);
    if (!btn) return;
    btn.addEventListener('click', function () {
      btn.classList.add('spin');
      get(key, Object.assign({}, opts || {}, { forceCheck: true })).then(onRows, function () {})
        .then(function () { btn.classList.remove('spin'); });
    });
  }

  function reload(key, opts) {
    return idb('delete', key).then(function () { return schema(key); }).then(function (sc) {
      var hubKey = sourceOf(sc, opts || {}).hub, hub = g.mzoDataHub;
      return hubKey && hub && hub.refresh ? Promise.resolve(hub.refresh(hubKey)).catch(function () {}) : null;
    }).then(function () { return get(key, opts); });
  }

  var MzoRows = {
    load: load, get: get, refresh: refresh, reload: reload, scope: scopeRows,
    levels: [{ k: 'region', label: 'Region', field: '_region' }, { k: 'division', label: 'Division', field: '_division' }, { k: 'ccc', label: 'CCC', field: '_ccc' }],
    last: {},
    fromDoc: fromDoc, _code: CODE, _compute: compute, _manifest: manifest
  };
  g.MzoRows = MzoRows;
})(typeof self !== 'undefined' ? self : this);
