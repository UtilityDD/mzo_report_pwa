/* Data editor: shared client code (docs/data-editor.md). DOM helpers, the API client, dialogs and
 * the hash router. Every value from the server reaches the page through textContent or an attribute,
 * never as markup.
 */
(function (w) {
  'use strict';
  var Ed = w.Ed = {};

  /* ---------- DOM ---------- */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v == null || v === false) return;
      if (k === 'text') el.textContent = String(v);
      else if (k === 'class') el.className = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      else if (k === 'style') el.style.cssText = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { add(el, k); }); return; }
    el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  // Icons: the kit's sprite plus a few of our own (static markup, no data).
  var MORE = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.5 14a6.5 6.5 0 0 1 3 6"/>'
  };
  function sprite() {
    if (document.getElementById('ed-sprite')) return;
    var s = '<svg id="ed-sprite" width="0" height="0" style="position:absolute" aria-hidden="true">';
    Object.keys(MORE).forEach(function (k) { s += '<symbol id="ui-' + k + '" viewBox="0 0 24 24">' + MORE[k] + '</symbol>'; });
    document.body.insertAdjacentHTML('afterbegin', s + '</svg>');
  }
  function icon(name) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'ui-i');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#ui-' + name);
    svg.appendChild(use);
    return svg;
  }
  function btn(label, opts) {
    var o = opts || {};
    var b = h('button', { type: 'button', class: 'ui-btn ' + (o.cls || 'sm'), title: o.title || null, disabled: o.disabled, on: o.on ? { click: o.on } : null });
    if (o.icon) b.appendChild(icon(o.icon));
    if (label) b.appendChild(h('span', { text: label }));
    return b;
  }

  /* ---------- Formatting ---------- */
  var nf = new Intl.NumberFormat('en-IN');
  function n(x) { var v = Number(x); return isFinite(v) ? nf.format(v) : '—'; }
  function when(s) {
    var t = Date.parse(String(s || '').replace(' ', 'T'));
    if (!isFinite(t)) return '—';
    var d = new Date(t + 330 * 60000);
    var p = function (x) { return String(x).padStart(2, '0'); };
    return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }
  function ago(s) {
    var t = Date.parse(String(s || '').replace(' ', 'T'));
    if (!isFinite(t)) return '—';
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 48 * 60) return Math.round(m / 60) + ' h ago';
    return Math.round(m / 1440) + ' days ago';
  }

  /* ---------- API ---------- */
  function ApiError(status, body) {
    this.status = status;
    this.body = body || {};
    this.message = (body && body.message) || (status ? 'The server answered ' + status + '.' : 'No connection to the server.');
  }
  function api(method, path, body, opts) {
    var o = opts || {};
    var init = { method: method, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
    if (method !== 'GET') {
      init.headers['Content-Type'] = 'application/json';
      init.headers['X-MZO-Editor'] = '1';
      init.body = JSON.stringify(body || {});
    }
    if (o.signal) init.signal = o.signal;
    return fetch('/api/editor' + path, init).then(function (res) {
      return res.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = { message: 'Unexpected answer from the server.' }; }
        if (res.status === 401) { location.href = '/login.html'; throw new ApiError(401, data); }
        if (!res.ok) throw new ApiError(res.status, data);
        return data;
      });
    }, function (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new ApiError(0, { message: 'No connection to the server. Nothing was lost on this page; try again.' });
    });
  }
  function idemKey() {
    var a = new Uint8Array(16);
    (w.crypto || w.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }

  /* ---------- Dialogs ---------- */
  function modal(title, opts) {
    var o = opts || {};
    var body = h('div', { class: 'b' });
    var foot = h('footer');
    var closeBtn = h('button', { type: 'button', class: 'ui-btn ghost icon sm', 'aria-label': 'Close' });
    closeBtn.appendChild(icon('x'));
    var dlg = h('div', { class: 'ed-dlg' + (o.small ? ' sm' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', null, h('h3', { text: title }), closeBtn), body, foot);
    var wrap = h('div', { class: 'ed-modal' }, dlg);
    var prevFocus = document.activeElement;
    function close() {
      if (!wrap.parentNode) return;
      wrap.parentNode.removeChild(wrap);
      document.removeEventListener('keydown', onKey, true);
      if (o.onClose) o.onClose();
      if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (e) {}
    }
    function onKey(e) { if (e.key === 'Escape' && !o.noEsc) { e.stopPropagation(); close(); } }
    closeBtn.addEventListener('click', close);
    wrap.addEventListener('mousedown', function (e) { if (e.target === wrap && !o.sticky) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    return { el: dlg, body: body, foot: foot, close: close };
  }
  function confirmDlg(title, lines, okLabel, opts) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var done = false;
      var m = modal(title, { small: true, onClose: function () { if (!done) resolve(false); } });
      (Array.isArray(lines) ? lines : [lines]).forEach(function (l) { m.body.appendChild(h('p', { text: l })); });
      var input = null;
      if (o.typeToConfirm) {
        input = h('input', { class: 'ui-input', placeholder: o.typeToConfirm, 'aria-label': 'Type ' + o.typeToConfirm + ' to confirm' });
        m.body.appendChild(h('label', { class: 'f' }, 'Type ', h('b', { text: o.typeToConfirm }), ' to confirm', input));
      }
      var ok = btn(okLabel || 'OK', { cls: 'sm ' + (o.danger ? 'primary' : 'primary') });
      var cancel = btn('Cancel', { on: function () { m.close(); } });
      ok.addEventListener('click', function () {
        if (input && input.value.trim() !== o.typeToConfirm) { input.focus(); return; }
        done = true; m.close(); resolve(input ? input.value.trim() : true);
      });
      m.foot.appendChild(cancel); m.foot.appendChild(ok);
      (input || ok).focus();
    });
  }
  function toast(msg) { if (w.UI && UI.toast) UI.toast(msg); }
  function errorText(err) { return (err && err.message) || String(err); }

  /* ---------- Router ---------- */
  var routes = [];
  function route(re, fn) { routes.push({ re: re, fn: fn }); }
  function parseHash() {
    var raw = (location.hash || '#/').slice(1);
    var i = raw.indexOf('?');
    var path = i < 0 ? raw : raw.slice(0, i);
    var params = new URLSearchParams(i < 0 ? '' : raw.slice(i + 1));
    return { path: path || '/', params: params };
  }
  var leaveGuard = null;
  function setLeaveGuard(fn) { leaveGuard = fn; }
  var lastHash = location.hash;
  function render() {
    if (leaveGuard && location.hash !== lastHash && !leaveGuard()) { history.replaceState(null, '', lastHash || '#/'); return; }
    leaveGuard = null;
    lastHash = location.hash;
    var r = parseHash();
    for (var i = 0; i < routes.length; i++) {
      var m = routes[i].re.exec(r.path);
      if (m) { routes[i].fn(m, r.params); return; }
    }
    location.hash = '#/';
  }
  w.addEventListener('beforeunload', function (e) { if (leaveGuard && !leaveGuard(true)) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- Shell ---------- */
  var root = null;
  function shell(crumb) {
    root = root || document.getElementById('ed-app');
    clear(root);
    var themeBtn = btn('', { cls: 'ghost icon sm', icon: 'moon', title: 'Light or dark', on: function () { if (w.MzoTheme && MzoTheme.toggle) MzoTheme.toggle(); } });
    var top = h('div', { class: 'ed-top' },
      h('a', { class: 'ed-brand', href: '#/', text: 'Data editor' }),
      crumb ? h('span', { class: 'ed-crumb', text: '/ ' + crumb }) : null,
      h('span', { class: 'ed-sp' }),
      Ed.me && Ed.me.isAdmin ? h('a', { class: 'ui-btn ghost sm', href: '#/permissions', title: 'Who can edit what' }, icon('users'), h('span', { class: 'hide-sm', text: 'Permissions' })) : null,
      w.self === w.top ? h('a', { class: 'ui-btn ghost sm', href: '/app.html', title: 'Back to the reports' }, h('span', { text: 'Reports' })) : null, // inside the admin window: no way out of the frame
      themeBtn,
      Ed.me ? h('span', { class: 'ed-who', title: Ed.me.email || Ed.me.id, text: (Ed.me.name || Ed.me.id) + (Ed.me.isAdmin ? ' · admin' : '') }) : null);
    var page = h('div', { class: 'ed-page' });
    root.appendChild(top);
    root.appendChild(page);
    return page;
  }

  function start() {
    sprite();
    api('GET', '/me').then(function (r) {
      Ed.me = r.user;
      Ed.limits = r.limits || {};
      w.addEventListener('hashchange', render);
      render();
    }, function (err) {
      var page = shell('');
      page.appendChild(h('div', { class: 'ed-note bad' }, errorText(err)));
    });
  }

  Ed.h = h; Ed.add = add; Ed.clear = clear; Ed.icon = icon; Ed.btn = btn;
  Ed.n = n; Ed.when = when; Ed.ago = ago;
  Ed.api = api; Ed.ApiError = ApiError; Ed.idemKey = idemKey; Ed.errorText = errorText;
  Ed.modal = modal; Ed.confirm = confirmDlg; Ed.toast = toast;
  Ed.route = route; Ed.render = render; Ed.parseHash = parseHash; Ed.setLeaveGuard = setLeaveGuard; Ed.shell = shell;
  Ed.start = start;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 0); });
  else setTimeout(start, 0);
})(window);
