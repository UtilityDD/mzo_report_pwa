/* Portal core: DOM builder, formatting, freshness, PocketBase filter strings.
 * Every value shown in the portal comes from spreadsheets or databases and is untrusted:
 * it only ever reaches the page as text (textContent / setAttribute), never as markup.
 */
(function (w) {
  'use strict';
  var P = w.Portal = w.Portal || {};

  /* ---------- DOM ---------- */
  var PROPS = { value: 1, checked: 1, disabled: 1, hidden: 1, selected: 1, indeterminate: 1, open: 1 };
  // h('div', { class, text, title, href, on: { click }, dataset: {…}, 'aria-x': … }, ...children)
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        else if (k === 'on') Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { el.dataset[d] = String(v[d]); });
        else if (k === 'href') { var u = safeHref(v); if (u) el.setAttribute('href', u); }
        else if (PROPS[k]) el[k] = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return el;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return el; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }
  // Only in-app hash routes and absolute http(s) links. Anything else (javascript:, data:, …) is dropped.
  function safeHref(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return null;
    if (s.charAt(0) === '#') return s;
    if (s === '/_/' ) return s;
    try {
      var u = new URL(s);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
    } catch (e) { return null; }
  }
  var SVG = 'http://www.w3.org/2000/svg';
  function icon(name, cls) {
    var s = document.createElementNS(SVG, 'svg');
    s.setAttribute('class', 'ui-i' + (cls ? ' ' + cls : ''));
    s.setAttribute('aria-hidden', 'true');
    var u = document.createElementNS(SVG, 'use');
    u.setAttribute('href', '#pt-' + name);
    s.appendChild(u);
    return s;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function $(id) { return document.getElementById(id); }

  /* ---------- formatting ---------- */
  var MIN = 6e4, HOUR = 36e5, DAY = 864e5;
  var nfInt = new Intl.NumberFormat('en-IN');
  var nfDec = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 6 });
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function n(x) { var v = Number(x); return isFinite(v) ? nfInt.format(v) : '—'; }
  // Codes, IDs and phone numbers read better without digit grouping.
  var ID_LIKE = /(^|_)(id|no|num|number|code|pin|phone|mobile|year|zip|account|acc|serial|sl|srl|consumer|meter|seq|key|gid)(_|$)/;
  function num(v, field) {
    if (v == null || v === '') return '';
    var x = Number(v);
    if (!isFinite(x)) return String(v);
    if (field && ID_LIKE.test(field) && Number.isInteger(x)) return String(x);
    return Number.isInteger(x) ? nfInt.format(x) : nfDec.format(x);
  }
  // PocketBase dates: "2024-01-02 03:04:05.678Z" (UTC).
  function pbDate(s) {
    if (!s || typeof s !== 'string') return null;
    var d = new Date(s.replace(' ', 'T'));
    return isNaN(d) ? null : d;
  }
  function isDateOnly(s) { return typeof s === 'string' && / 00:00:00(\.000)?Z$/.test(s); }
  function two(x) { return x < 10 ? '0' + x : '' + x; }
  function fmtDay(d, utc) {
    return utc ? d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear() : d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
  }
  function fmtTime(d) { return two(d.getHours()) + ':' + two(d.getMinutes()); }
  // Date-only values (UTC midnight) show as a day; timestamps show in local time.
  function dateVal(s) {
    var d = pbDate(s);
    if (!d) return s ? String(s) : '';
    return isDateOnly(s) ? fmtDay(d, true) : fmtDay(d) + ', ' + fmtTime(d);
  }
  function dateTime(s) { var d = s instanceof Date ? s : pbDate(s); return d ? fmtDay(d) + ', ' + fmtTime(d) + ':' + two(d.getSeconds()) : '—'; }
  function rel(s) {
    var d = s instanceof Date ? s : pbDate(s);
    if (!d) return 'never';
    var ms = Date.now() - d.getTime(), a = Math.abs(ms), suffix = ms >= 0 ? ' ago' : ' from now';
    if (a < 45e3) return 'just now';
    if (a < HOUR) return Math.round(a / MIN) + ' min' + suffix;
    if (a < DAY) return Math.round(a / HOUR) + ' h' + suffix;
    if (a < 60 * DAY) return Math.round(a / DAY) + ' d' + suffix;
    return fmtDay(d);
  }
  function dur(ms) {
    ms = Number(ms);
    if (!isFinite(ms) || ms <= 0) return '—';
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 60e3) return (ms / 1000).toFixed(ms < 10e3 ? 1 : 0) + ' s';
    var m = Math.floor(ms / 60e3), s = Math.round((ms % 60e3) / 1000);
    return m + ' min' + (s ? ' ' + s + ' s' : '');
  }
  function jsonPreview(v) {
    if (v == null || v === '') return '';
    if (Array.isArray(v)) {
      var inner = v.slice(0, 4).map(function (x) { return typeof x === 'object' && x ? (Array.isArray(x) ? '[…]' : '{…}') : String(x); }).join(', ');
      return '[' + inner + (v.length > 4 ? ', … ' + v.length + ' items' : '') + ']';
    }
    if (typeof v === 'object') {
      var keys = Object.keys(v);
      return '{ ' + keys.slice(0, 3).join(', ') + (keys.length > 3 ? ', …' : '') + ' }';
    }
    return String(v);
  }
  function jsonPretty(v) { try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); } }

  /* ---------- datasets: sources, schedules, freshness ---------- */
  var SOURCES = [
    { k: 'google_sheet', label: 'Google Sheets', one: 'Google Sheet', icon: 'sheet' },
    { k: 'supabase_table', label: 'Supabase tables', one: 'Supabase table', icon: 'table' },
    { k: 'supabase_storage', label: 'Supabase Storage', one: 'Supabase Storage', icon: 'bucket' },
    { k: 'json_file', label: 'Files', one: 'File', icon: 'file' },
    { k: 'apps_script', label: 'Apps Script', one: 'Apps Script', icon: 'script' },
    { k: 'other', label: 'Other', one: 'Other', icon: 'file' }
  ];
  function source(k) { for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i].k === k) return SOURCES[i]; return SOURCES[SOURCES.length - 1]; }
  // Sidebar order for report areas (the app's sidebar groups), then anything else A–Z.
  var AREAS = ['New service connection', 'Revenue', 'DD visit', 'Consumers & meters', 'Vendor advances', 'Substation & network', 'Important', 'Media', 'Admin', 'System'];
  var SCHEDULES = {
    frequent: { label: 'Every 5 minutes', grace: 20 * MIN }, // vm/sync/lib/schedule.js, mzo-sync.timer *:0/5
    hourly: { label: 'Hourly', grace: 3 * HOUR },
    daily: { label: 'Daily', grace: 30 * HOUR }
  };
  function schedule(k) { return SCHEDULES[k] || { label: k ? String(k) : 'Not scheduled', grace: 30 * HOUR }; }
  // fresh (ok) · stale (warn) · error (bad) · skipped / never (grey)
  function freshness(ds) {
    var st = String(ds.last_status || '');
    if (st === 'error') return { k: 'error', cls: 'bad', label: 'Error' };
    if (st === 'skipped') return { k: 'skipped', cls: '', label: 'Not mirrored' };
    var t = pbDate(ds.last_checked_at) || pbDate(ds.last_synced_at);
    if (!t) return { k: 'never', cls: '', label: 'Never synced' };
    if (Date.now() - t.getTime() > schedule(ds.schedule).grace) return { k: 'stale', cls: 'warn', label: 'Stale' };
    return { k: 'fresh', cls: 'ok', label: 'Fresh' };
  }
  function statusBadge(status) {
    var s = String(status || '');
    var cls = s === 'ok' ? 'ok' : s === 'error' || s === 'failed' ? 'bad' : s === 'running' ? 'warn' : '';
    return h('span', { class: 'ui-badge' + (cls ? ' ' + cls : ''), text: s || '—' });
  }
  function dot(cls, title) { return h('span', { class: 'ui-dot' + (cls ? ' ' + cls : ''), title: title || null, 'aria-hidden': 'true' }); }

  /* ---------- columns ---------- */
  var TYPES = { text: 1, number: 1, date: 1, bool: 1, json: 1 };
  var IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
  // sys_datasets.columns → [{ name, source_name, type }], dropping anything malformed.
  function columns(ds) {
    var raw = Array.isArray(ds.columns) ? ds.columns : [];
    var seen = {};
    return raw.filter(function (c) {
      if (!c || typeof c.name !== 'string' || !IDENT.test(c.name) || seen[c.name]) return false;
      seen[c.name] = 1; return true;
    }).map(function (c) {
      var t = String(c.type || 'text').toLowerCase();
      if (t === 'boolean') t = 'bool';
      return { name: c.name, source_name: c.source_name != null && c.source_name !== '' ? String(c.source_name) : c.name, type: TYPES[t] ? t : 'text' };
    });
  }
  var SYSTEM_FIELDS = [
    { name: 'id', type: 'text', about: 'PocketBase record id' },
    { name: '_row_key', type: 'text', about: 'Source primary key, or a content hash when the source has none (unique)' },
    { name: '_row_no', type: 'number', about: 'Position of the row in the source' },
    { name: '_synced_at', type: 'date', about: 'When the sync last wrote this row' },
    { name: '_hash', type: 'text', about: 'Hash of the row, used to skip unchanged rows' },
    { name: '_nulls', type: 'json', about: 'Number and yes/no fields that are empty in the source (PocketBase stores them as 0 / No; shown as empty)' }
  ];

  /* ---------- PocketBase filter strings ----------
   * Quoted text: backslash and the quote are escaped (fexpr unescapes \\ \' \").
   * LIKE patterns (~): \ % _ are escaped first so user text never acts as a wildcard,
   * then the pattern gets its own % and is quoted like any other text. */
  function q(v) { return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
  function likeEsc(v) { return String(v).replace(/[\\%_]/g, '\\$&'); }
  function dayStart(ymd, local) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return null;
    var d = local ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return isNaN(d) ? null : d;
  }
  function pbStamp(d) { return d.toISOString().replace('T', ' '); }
  var OPS = {
    text: [['contains', 'contains'], ['ncontains', 'does not contain'], ['eq', 'is'], ['neq', 'is not'], ['starts', 'starts with'], ['ends', 'ends with'], ['empty', 'is empty'], ['nempty', 'is not empty']],
    number: [['eq', '='], ['neq', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤']],
    date: [['on', 'on'], ['before', 'before'], ['after', 'on or after'], ['between', 'between'], ['empty', 'is empty'], ['nempty', 'is not empty']],
    bool: [['true', 'is yes'], ['false', 'is no']],
    json: [['contains', 'contains'], ['ncontains', 'does not contain']]
  };
  var NO_VALUE = { empty: 1, nempty: 1, 'true': 1, 'false': 1 };
  // f = { field, type, op, value, value2, local } → filter text, or throws Error(message) for a bad value.
  function clause(f) {
    var F = f.field;
    if (!IDENT.test(F)) throw new Error('Unknown column.');
    var v = f.value == null ? '' : String(f.value);
    if (f.type === 'number') {
      var x = Number(String(v).replace(/,/g, '').trim());
      if (v.trim() === '' || !isFinite(x)) throw new Error('Enter a number.');
      return F + ' ' + { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.op] + ' ' + String(x);
    }
    if (f.type === 'bool') return F + ' = ' + (f.op === 'true' ? 'true' : 'false');
    if (f.type === 'date') {
      if (f.op === 'empty') return F + " = ''";
      if (f.op === 'nempty') return F + " != ''";
      var a = dayStart(v, f.local);
      if (!a) throw new Error('Pick a date.');
      var next = function (d) { var e = new Date(d.getTime()); if (f.local) e.setDate(e.getDate() + 1); else e.setUTCDate(e.getUTCDate() + 1); return e; };
      if (f.op === 'before') return F + ' < ' + q(pbStamp(a));
      if (f.op === 'after') return F + ' >= ' + q(pbStamp(a));
      if (f.op === 'between') {
        var b = dayStart(f.value2, f.local);
        if (!b) throw new Error('Pick both dates.');
        if (b < a) { var t = a; a = b; b = t; }
        return '(' + F + ' >= ' + q(pbStamp(a)) + ' && ' + F + ' < ' + q(pbStamp(next(b))) + ')';
      }
      return '(' + F + ' >= ' + q(pbStamp(a)) + ' && ' + F + ' < ' + q(pbStamp(next(a))) + ')';
    }
    // text and json
    if (f.op === 'empty') return F + " = ''";
    if (f.op === 'nempty') return F + " != ''";
    if (v === '') throw new Error('Enter a value.');
    switch (f.op) {
      case 'eq': return F + ' = ' + q(v);
      case 'neq': return F + ' != ' + q(v);
      case 'starts': return F + ' ~ ' + q(likeEsc(v) + '%');
      case 'ends': return F + ' ~ ' + q('%' + likeEsc(v));
      case 'ncontains': return F + ' !~ ' + q('%' + likeEsc(v) + '%');
      default: return F + ' ~ ' + q('%' + likeEsc(v) + '%');
    }
  }
  function opLabel(type, op) {
    var list = OPS[type] || OPS.text;
    for (var i = 0; i < list.length; i++) if (list[i][0] === op) return list[i][1];
    return op;
  }

  /* ---------- misc ---------- */
  function debounce(fn, ms) { var t; return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { fn.apply(s, a); }, ms); }; }
  function toast(msg) { if (w.UI && w.UI.toast) w.UI.toast(String(msg)); }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return Promise.reject(new Error('Clipboard not available'));
  }
  // Session-only UI preferences (column choices). Never data.
  function pref(key, value) {
    var k = 'mzo_portal_' + key;
    try {
      if (arguments.length > 1) { if (value == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(value)); return value; }
      var s = sessionStorage.getItem(k);
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  }

  P.h = h; P.add = add; P.icon = icon; P.clear = clear; P.$ = $; P.safeHref = safeHref;
  P.n = n; P.num = num; P.pbDate = pbDate; P.isDateOnly = isDateOnly; P.dateVal = dateVal; P.dateTime = dateTime;
  P.rel = rel; P.dur = dur; P.jsonPreview = jsonPreview; P.jsonPretty = jsonPretty; P.fmtDay = fmtDay;
  P.SOURCES = SOURCES; P.source = source; P.AREAS = AREAS; P.schedule = schedule; P.freshness = freshness;
  P.statusBadge = statusBadge; P.dot = dot;
  P.columns = columns; P.SYSTEM_FIELDS = SYSTEM_FIELDS; P.IDENT = IDENT;
  P.q = q; P.likeEsc = likeEsc; P.clause = clause; P.OPS = OPS; P.NO_VALUE = NO_VALUE; P.opLabel = opLabel;
  P.debounce = debounce; P.toast = toast; P.copy = copy; P.pref = pref;
  P.MIN = MIN; P.HOUR = HOUR; P.DAY = DAY;
})(window);
