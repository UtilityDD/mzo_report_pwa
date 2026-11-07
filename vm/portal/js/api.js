/* PocketBase REST client for the portal (same origin, /api/...).
 * Sign-in: portal_users_auth first, then _superusers. The token lives in sessionStorage only
 * (gone when the tab closes); records are never stored in the browser. Requests use
 * cache: 'no-store' so data does not land in the HTTP cache either.
 *
 * PocketBase treats an invalid or expired token as a guest (lists come back empty), so the
 * client checks the token's expiry itself before every request and signs out when it lapses.
 */
(function (w) {
  'use strict';
  var P = w.Portal = w.Portal || {};
  var KEY = 'mzo_portal_session';
  var COLLS = { portal: 'portal_users_auth', superuser: '_superusers' };
  var session = null, listeners = [];

  function ApiError(status, message, data) {
    var e = new Error(message || ('Request failed (' + status + ')'));
    e.status = status; e.data = data || null;
    return e;
  }

  function jwtExp(token) {
    try {
      var part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (part.length % 4) part += '=';
      var exp = JSON.parse(atob(part)).exp;
      return typeof exp === 'number' ? exp : 0;
    } catch (e) { return 0; }
  }
  function load() {
    try {
      var s = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      if (s && typeof s.token === 'string' && COLLS[s.kind]) session = { token: s.token, kind: s.kind, email: String(s.email || ''), name: String(s.name || ''), exp: jwtExp(s.token) };
    } catch (e) { session = null; }
    return session;
  }
  function save() { try { if (session) sessionStorage.setItem(KEY, JSON.stringify({ token: session.token, kind: session.kind, email: session.email, name: session.name })); } catch (e) {} }
  function expired() { return !session || !session.exp || Date.now() >= session.exp * 1000 - 5000; }
  function setSession(kind, data) {
    var rec = data.record || {};
    session = { token: data.token, kind: kind, email: String(rec.email || ''), name: String(rec.name || ''), exp: jwtExp(data.token) };
    save();
    return session;
  }
  function signOut(reason) {
    var had = !!session;
    session = null;
    try { sessionStorage.removeItem(KEY); } catch (e) {}
    if (had || reason) listeners.forEach(function (fn) { try { fn(reason || ''); } catch (e) {} });
  }
  function onSignOut(fn) { listeners.push(fn); }

  function parse(res) {
    return res.text().then(function (t) {
      var data = null;
      try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
      return data;
    });
  }
  function post(path, body, auth) {
    var headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = auth;
    return fetch(path, { method: 'POST', headers: headers, body: JSON.stringify(body || {}), cache: 'no-store', credentials: 'omit' })
      .then(function (res) { return parse(res).then(function (data) { return { res: res, data: data }; }); });
  }

  function authWith(kind, email, password) {
    return post('/api/collections/' + COLLS[kind] + '/auth-with-password', { identity: email, password: password }).then(function (r) {
      if (r.res.ok && r.data && r.data.token) return setSession(kind, r.data);
      if (r.data && r.data.mfaId) throw ApiError(401, 'This account needs a second sign-in step. Use the PocketBase dashboard.');
      throw ApiError(r.res.status, r.res.status === 429 ? 'Too many attempts. Wait a few seconds and try again.' : r.data && r.data.message, r.data);
    });
  }
  function signIn(email, password) {
    return authWith('portal', email, password).catch(function (e) {
      if (e.status !== 400) throw e;
      return authWith('superuser', email, password);
    }).catch(function (e) {
      if (e.status === 400) throw ApiError(400, 'Wrong email or password.');
      if (!e.status) throw ApiError(0, 'Cannot reach the server. Check the connection and try again.');
      throw e;
    });
  }
  // Renews the token (also confirms the account still exists).
  function refresh() {
    if (expired()) { signOut('expired'); return Promise.reject(ApiError(401, 'Session expired')); }
    return post('/api/collections/' + COLLS[session.kind] + '/auth-refresh', {}, session.token).then(function (r) {
      if (r.res.ok && r.data && r.data.token) return setSession(session.kind, r.data);
      if (r.res.status === 401 || r.res.status === 403 || r.res.status === 404) { signOut('expired'); throw ApiError(401, 'Session expired'); }
      throw ApiError(r.res.status, r.data && r.data.message);
    });
  }

  function get(path, params, opts) {
    if (expired()) { signOut('expired'); return Promise.reject(ApiError(401, 'Session expired')); }
    var qs = '';
    if (params) {
      var parts = [];
      Object.keys(params).forEach(function (k) { var v = params[k]; if (v != null && v !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)); });
      if (parts.length) qs = '?' + parts.join('&');
    }
    return fetch(path + qs, { headers: { Authorization: session.token }, cache: 'no-store', credentials: 'omit', signal: opts && opts.signal })
      .then(function (res) {
        return parse(res).then(function (data) {
          if (res.ok) return data;
          if (res.status === 401) { signOut('expired'); throw ApiError(401, 'Session expired', data); }
          throw ApiError(res.status, data && data.message, data);
        });
      });
  }
  function coll(name) { return '/api/collections/' + encodeURIComponent(name) + '/records'; }
  // opts: { page, perPage, sort, filter, fields, skipTotal }
  function list(collection, opts, signal) {
    opts = opts || {};
    return get(coll(collection), {
      page: opts.page || 1, perPage: opts.perPage || 50, sort: opts.sort, filter: opts.filter, fields: opts.fields, skipTotal: opts.skipTotal ? 1 : null
    }, { signal: signal });
  }
  function one(collection, id, signal) { return get(coll(collection) + '/' + encodeURIComponent(id), null, { signal: signal }); }
  // Every page of a list (max 1000 per request). onPage(items, soFar) may return false to stop.
  function all(collection, opts, onPage, signal) {
    var page = 1, per = Math.min(1000, (opts && opts.perPage) || 1000), got = 0;
    function next() {
      return list(collection, Object.assign({}, opts, { page: page, perPage: per, skipTotal: true }), signal).then(function (r) {
        var items = (r && r.items) || [];
        got += items.length;
        if (onPage(items, got) === false || items.length < per) return got;
        page++;
        return next();
      });
    }
    return next();
  }

  P.api = {
    load: load, signIn: signIn, signOut: signOut, onSignOut: onSignOut, refresh: refresh, expired: expired,
    session: function () { return session; },
    msLeft: function () { return session && session.exp ? session.exp * 1000 - Date.now() : 0; },
    get: get, list: list, one: one, all: all
  };
})(window);
