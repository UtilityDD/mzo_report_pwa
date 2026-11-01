/* Data quality: the results vm/quality writes after each sync (docs/data-quality.md).
 *   sys_quality_scores  one row per dataset: score 0–100, open issue count, checked_at
 *   sys_quality_issues  one row per (dataset, check, column): severity, count, masked sample, hint,
 *                       source_fix, first_seen, last_seen, status open | resolved
 * Read-only. Samples are masked by vm/quality and still rendered as text only.
 * Pieces: the Overview card, the Data quality page (#/quality, /actions, /issues) and the
 * dataset page's Quality tab.
 */
(function (w) {
  'use strict';
  var P = w.Portal = w.Portal || {};
  var h = P.h, icon = P.icon;
  function V() { return P.views._; }
  var EMPTY = 'Results appear after the next sync';

  /* ---------- names ---------- */
  var NAMES = {
    'office.unknown_region': 'Unknown region',
    'office.unknown_division': 'Unknown division',
    'office.unknown_ccc': 'Unknown CCC',
    'office.unknown_code': 'Unknown office code',
    'office.code_name_mismatch': 'Office code and name disagree',
    'office.parent_mismatch': 'Office under the wrong parent',
    'office.legacy_division': 'Old division name',
    'office.outside_zone': 'Office outside Malda zone',
    'office.ambiguous_name': 'Ambiguous office name',
    'office.variant_spelling': 'Office name spelt differently',
    'office.non_ccc_unit': 'Division or region in a CCC column',
    'office.blank': 'Office missing',
    'date.unparseable': 'Date not readable',
    'date.mixed_formats': 'Dates in mixed formats',
    'date.mixed_order': 'Day and month order mixed',
    'date.future': 'Date in the future',
    'date.too_old': 'Placeholder or very old date',
    'date.excel_serial': 'Date stored as a number',
    'number.text_in_numeric': 'Text in a number column',
    'number.negative': 'Negative number',
    'number.placeholder': 'Placeholder number',
    'value.outlier': 'Unusual value',
    'value.geo_out_of_area': 'Location outside the zone',
    'value.geo_zero': 'Location 0, 0',
    'value.sheet_error': 'Formula error (#N/A, #DIV/0!)',
    'value.whitespace': 'Extra spaces in values',
    'key.duplicate': 'Repeated key',
    'key.blank': 'Key missing',
    'key.duplicate_row': 'Copied row',
    'key.not_unique': 'ID-like column repeats',
    'row.blank': 'Empty row inside the data',
    'row.ghost': 'Almost empty row',
    'row.repeated_header': 'Header pasted again',
    'row.total_row': 'Total row inside the data',
    'header.blank': 'Column without a header',
    'header.duplicate': 'Same header twice',
    'header.whitespace': 'Header with extra spaces',
    'header.drift': 'Columns changed',
    'freshness.stale': 'Report out of date',
    'freshness.future': 'Report date in the future',
    'freshness.missing': 'Report date missing',
    'freshness.mixed_as_on': 'Two report dates mixed',
    'freshness.as_on_behind': 'Report date behind the data',
    'cross.overlap': 'In two lists at once',
    'cross.report_date': 'Report dates differ',
    'cross.unknown_material': 'Unknown material',
    'cross.total_mismatch': 'Totals do not add up',
    'cross.snapshot_mismatch': 'Storage copy differs from the sheet',
    'cross.meta_mismatch': 'Summary file disagrees',
    'cross.portal_unknown_office': 'User granted an unknown office',
    // cross-check groups (vm/quality/lib/cross.js), in case one is ever stored as the check id
    'cross.nsc_withheld': 'Pending NSC vs Withheld',
    'cross.stock_materials': 'Stock vs materials list',
    'cross.allotment_materials': 'Allotments vs materials list',
    'cross.defective_totals': 'Defective details vs summary',
    'cross.portal_user_offices': 'Portal users’ offices',
    'cross.pending_mc_google': 'Pending MC: Storage vs sheet',
    'cross.load_ext_google': 'Load extension: Storage vs sheet',
    'cross.disconnection_google': 'Disconnection: Storage vs sheet',
    'cross.defective_summary_google': 'Defective summary: Storage vs sheet',
    'cross.defective_details_google': 'Defective details: Storage vs sheet',
    'cross.stock_google': 'Stock: Storage vs sheet'
  };
  function checkName(id) {
    id = String(id || '');
    if (NAMES[id]) return NAMES[id];
    var s = id.split('.').pop().replace(/_/g, ' ');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Check';
  }
  var FAMILIES = [['office', 'Office'], ['date', 'Date'], ['number', 'Number'], ['key', 'Key'], ['row', 'Row'], ['header', 'Header'], ['freshness', 'Freshness'], ['cross', 'Cross-dataset'], ['value', 'Value']];
  function family(id) { return String(id || '').split('.')[0]; }
  var SEV = { error: { rank: 0, label: 'Error', many: 'Errors', cls: 'bad' }, warn: { rank: 1, label: 'Warning', many: 'Warnings', cls: 'warn' }, info: { rank: 2, label: 'Note', many: 'Notes', cls: 'pt-info' } };
  function rank(s) { return SEV[s] ? SEV[s].rank : 3; }
  function sevBadge(s) { var x = SEV[s]; return h('span', { class: 'ui-badge pt-sev ' + (x ? x.cls : ''), text: x ? x.label : String(s || '—') }); }
  function band(score) { return score >= 95 ? 'ok' : score >= 80 ? 'warn' : 'bad'; }
  function bySeverity(a, b) { return rank(a.severity) - rank(b.severity) || (Number(b.count) || 0) - (Number(a.count) || 0) || String(a.dataset).localeCompare(String(b.dataset)); }

  /* ---------- IST dates (dd/mm/yyyy) ---------- */
  var istDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
  var istTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  function day(s) { var d = s instanceof Date ? s : P.pbDate(s); return d ? istDay.format(d) : '—'; }
  function dayTime(s) { var d = s instanceof Date ? s : P.pbDate(s); return d ? istDay.format(d) + ', ' + istTime.format(d) : '—'; }
  function when(s, withTime) {
    var d = s instanceof Date ? s : P.pbDate(s);
    return h('time', { datetime: d ? d.toISOString() : null, title: d ? P.rel(d) + ' (IST)' : null, text: withTime ? dayTime(d) : day(d) });
  }

  /* ---------- samples (already masked; text only) ---------- */
  function valText(v) {
    if (v == null || v === '') return '—';
    if (Array.isArray(v)) return v.map(valText).join(', ');
    if (typeof v === 'object') return Object.keys(v).map(function (k) { return k + ': ' + valText(v[k]); }).join(', ');
    return String(v);
  }
  function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  var KEY_ORDER = ['row', 'first_row', 'same_as_row', 'value', 'rows', 'what', 'header', 'date', 'as_on'];
  function keysOf(o) {
    var k = Object.keys(o);
    return k.sort(function (a, b) {
      var x = KEY_ORDER.indexOf(a), y = KEY_ORDER.indexOf(b);
      return (x < 0 ? 99 : x) - (y < 0 ? 99 : y) || k.indexOf(a) - k.indexOf(b);
    });
  }
  function samplesOf(i) { return (Array.isArray(i.sample) ? i.sample : []).filter(function (s) { return !(s && typeof s === 'object' && !Array.isArray(s) && Object.keys(s).length === 1 && 'compared_with' in s); }); }
  function comparedWith(i) {
    var s = Array.isArray(i.sample) ? i.sample : [];
    for (var k = 0; k < s.length; k++) if (s[k] && typeof s[k] === 'object' && s[k].compared_with) return String(s[k].compared_with);
    return '';
  }
  function sampleLine(s) {
    if (s == null || typeof s !== 'object' || Array.isArray(s)) return clip(valText(s), 240);
    return clip(keysOf(s).filter(function (k) { return k !== 'compared_with'; }).map(function (k) { return k + ': ' + valText(s[k]); }).join(' · '), 240);
  }
  // Same keys in every sample: one table. Different shapes: a key/value list per sample.
  function sampleView(list) {
    if (!list.length) return h('p', { class: 'ui-note', text: 'No examples stored for this check.' });
    var objs = list.every(function (s) { return s && typeof s === 'object' && !Array.isArray(s); });
    var keys = objs ? keysOf(list[0]) : [];
    var same = objs && list.every(function (s) { var k = keysOf(s); return k.length === keys.length && k.every(function (x, j) { return x === keys[j]; }); });
    if (same && keys.length) {
      return h('div', { class: 'ui-table-wrap pt-sample' }, h('table', { class: 'ui-table' },
        h('thead', null, h('tr', null, keys.map(function (k) { return h('th', { scope: 'col', text: k }); }))),
        h('tbody', null, list.map(function (s) { return h('tr', null, keys.map(function (k) { return h('td', { text: clip(valText(s[k]), 400) }); })); }))));
    }
    return h('ol', { class: 'pt-sample-kv' }, list.map(function (s) {
      if (!objs || !s || typeof s !== 'object' || Array.isArray(s)) return h('li', null, h('span', { class: 'pt-mono', text: clip(valText(s), 400) }));
      return h('li', null, h('dl', null, keysOf(s).map(function (k) { return [h('dt', { text: k }), h('dd', { text: clip(valText(s[k]), 400) })]; })));
    }));
  }

  /* ---------- store (memory only, refreshed every 2 minutes or on Reload) ---------- */
  var store = { data: null, at: 0, pending: null };
  function invalidate() { store.data = null; store.at = 0; }
  function orEmpty(e) { if (e && e.status === 404) return { items: [] }; throw e; }
  function allItems(collection, filter, sort) {
    var out = [];
    return P.api.all(collection, { filter: filter, sort: sort, perPage: 500 }, function (items) { out = out.concat(items); }).then(function () { return out; }, function (e) { if (e && e.status === 404) return []; throw e; });
  }
  function load(ctx, force) {
    if (!force && store.data && Date.now() - store.at < 120e3) return Promise.resolve(store.data);
    if (store.pending) return store.pending;
    var since = new Date(Date.now() - 7 * P.DAY).toISOString().replace('T', ' ');
    store.pending = Promise.all([
      P.api.list('sys_quality_scores', { page: 1, perPage: 500, sort: 'score' }).catch(orEmpty),
      allItems('sys_quality_issues', "status = 'open' || (status = 'resolved' && last_seen >= " + P.q(since) + ')', '-last_seen')
    ]).then(function (r) {
      store.data = build(ctx, (r[0] && r[0].items) || [], r[1] || []);
      store.at = Date.now();
      return store.data;
    }).then(function (d) { store.pending = null; return d; }, function (e) { store.pending = null; throw e; });
    return store.pending;
  }
  function build(ctx, scores, issues) {
    var scoreBy = {}, last = null, sum = 0, bands = { ok: 0, warn: 0, bad: 0 }, sev = { error: 0, warn: 0, info: 0 };
    scores = scores.filter(function (s) { return s && s.dataset; }).map(function (s) {
      var ds = ctx.byKey(s.dataset);
      var x = { dataset: String(s.dataset), score: Math.max(0, Math.min(100, Number(s.score) || 0)), issues_open: Number(s.issues_open) || 0, checked_at: s.checked_at, ds: ds,
        label: ds ? String(ds.label || ds.key) : String(s.dataset), group: ds && ds.group ? String(ds.group) : '', rows: ds ? Number(ds.row_count) || 0 : 0 };
      scoreBy[x.dataset] = x;
      sum += x.score; bands[band(x.score)]++;
      var t = P.pbDate(s.checked_at); if (t && (!last || t > last)) last = t;
      return x;
    });
    issues = issues.filter(function (i) { return i && i.dataset && i.check; }).map(function (i) {
      var ds = ctx.byKey(i.dataset);
      i._ds = ds;
      i._label = ds ? String(ds.label || ds.key) : String(i.dataset);
      i._group = ds && ds.group ? String(ds.group) : '';
      i._family = family(i.check);
      i._name = checkName(i.check);
      var rows = ds ? Number(ds.row_count) || 0 : 0;
      i._pct = rows > 0 ? (Number(i.count) || 0) / rows : null;
      if (i.status === 'open' && sev[i.severity] != null) sev[i.severity]++;
      return i;
    });
    return { scores: scores, scoreBy: scoreBy, issues: issues, open: issues.filter(function (i) { return i.status === 'open'; }),
      avg: scores.length ? Math.round(sum / scores.length) : null, bands: bands, sev: sev, last: last };
  }

  /* ---------- shared bits ---------- */
  function scoreBar(score) {
    var b = band(score), fill = h('b');
    fill.style.width = Math.max(score > 0 ? 2 : 0, score) + '%';
    return h('div', { class: 'ui-bar pt-score pt-band-' + b, title: 'Score ' + score + ' of 100' }, h('i', null, fill), h('span', { text: String(score) }));
  }
  function pct(p) { return p == null ? '—' : p === 0 ? '0%' : p < 0.001 ? '<0.1%' : (p * 100).toFixed(p < 0.1 ? 1 : 0) + '%'; }
  function sheetOf(i, ctx) {
    var ds = i._ds, cw = comparedWith(i);
    if (cw && ds && ds.source_type === 'supabase_storage') {
      var o = ctx.byKey(cw);
      if (o && P.safeHref(o.source_url)) return { url: String(o.source_url), ds: o };
    }
    return { url: ds && ds.source_url ? String(ds.source_url) : '', ds: ds };
  }
  function openSheet(url, cls) {
    var u = P.safeHref(url);
    if (!u || u.charAt(0) === '#') return null;
    return h('a', { class: cls || 'ui-btn sm', href: u, target: '_blank', rel: 'noopener noreferrer', title: u }, 'Open sheet', icon('ext'));
  }
  function emptyPanel(text) { return h('section', { class: 'ui-panel' }, h('div', { class: 'ui-empty', text: text || EMPTY })); }

  /* ---------- issue drawer ---------- */
  function openIssue(list, idx, ctx) {
    var i = list[idx];
    if (!i) return;
    P.drawer.open({
      title: i._name,
      sub: i._label + (i.column ? ' · ' + i.column : ''),
      load: function () { return Promise.resolve(i); },
      body: function () { return issueBody(i, ctx); },
      copy: function () { var c = {}; Object.keys(i).forEach(function (k) { if (k.charAt(0) !== '_') c[k] = i[k]; }); return JSON.stringify(c, null, 2); },
      prev: idx > 0 ? function () { openIssue(list, idx - 1, ctx); } : null,
      next: idx < list.length - 1 ? function () { openIssue(list, idx + 1, ctx); } : null
    });
  }
  function issueBody(i, ctx) {
    var dl = h('dl', { class: 'ui-dl pt-dl' });
    function row(k, v) { if (v == null || v === '') return; dl.appendChild(h('dt', { text: k })); dl.appendChild(h('dd', null, v)); }
    row('Dataset', h('a', { class: 'pt-link', href: '#/d/' + encodeURIComponent(i.dataset) + '/quality', text: i._label }));
    row('Severity', sevBadge(i.severity));
    row('Status', h('span', { class: 'ui-badge' + (i.status === 'open' ? '' : ' ok'), text: i.status === 'open' ? 'Open' : 'Resolved' }));
    row('Check', h('span', null, i._name, ' ', h('small', { class: 'pt-mono pt-sub', text: String(i.check) })));
    row('Column', i.column ? h('span', { class: 'pt-mono', text: String(i.column) }) : null);
    row('Count', P.n(i.count || 0) + (i._pct != null ? ' · ' + pct(i._pct) + ' of ' + P.n(i._ds.row_count) + ' rows' : ''));
    row('Fix', i.source_fix ? 'In the source sheet' : 'No sheet change needed');
    var cw = comparedWith(i), other = cw ? ctx.byKey(cw) : null;
    row('Compared with', cw ? (other ? h('a', { class: 'pt-link', href: '#/d/' + encodeURIComponent(cw), text: String(other.label || cw) }) : h('span', { class: 'pt-mono', text: cw })) : null);
    row('First seen', when(i.first_seen, true));
    row('Last seen', when(i.last_seen, true));
    var sheet = sheetOf(i, ctx);
    var acts = h('div', { class: 'pt-drawer-acts' }, openSheet(sheet.url),
      i._ds && i._ds.collection ? h('a', { class: 'ui-btn sm', href: '#/d/' + encodeURIComponent(i.dataset) }, 'Open data') : null);
    return [acts, dl,
      h('h4', { class: 'pt-drawer-h', text: 'What to do' }),
      h('p', { class: 'pt-hint-full pt-pre', text: i.hint ? String(i.hint) : 'No hint stored.' }),
      h('h4', { class: 'pt-drawer-h', text: 'Examples' }),
      h('div', { class: 'pt-drawer-pad' }, sampleView(samplesOf(i)))];
  }

  /* ---------- Overview card ---------- */
  function overviewCard(ctx) {
    var body = h('div', { class: 'pt-dq-b' }, V().loading());
    var el = h('section', { class: 'ui-panel pt-dq' },
      h('div', { class: 'ui-panel-h' }, h('h2', { text: 'Data quality' }), h('a', { class: 'ui-btn sm', href: '#/quality' }, 'Open data quality', icon('chev'))), body);
    var gone = false;
    load(ctx).then(function (d) {
      if (gone) return;
      P.clear(body);
      if (!d.scores.length) { body.appendChild(h('div', { class: 'ui-empty', text: EMPTY })); return; }
      var total = d.scores.length;
      var bandRow = function (k, label, n) {
        var fill = h('b'); fill.style.width = (total ? n / total * 100 : 0) + '%';
        return h('div', { class: 'pt-dq-band' }, P.dot(k), h('span', { text: label }), h('div', { class: 'ui-bar pt-band-' + k }, h('i', null, fill)), h('b', { text: P.n(n) }));
      };
      body.appendChild(h('div', { class: 'pt-dq-avg' },
        h('div', { class: 'pt-dq-num pt-band-t-' + band(d.avg), text: String(d.avg) }),
        h('div', null, h('div', { class: 'pt-dq-k', text: 'Average score' }), h('div', { class: 'pt-dq-s', text: P.n(total) + ' datasets checked' }))));
      body.appendChild(h('div', { class: 'pt-dq-bands' }, bandRow('ok', '95 and above', d.bands.ok), bandRow('warn', '80 to 94', d.bands.warn), bandRow('bad', 'Below 80', d.bands.bad)));
      body.appendChild(h('div', { class: 'pt-dq-sev' },
        ['error', 'warn', 'info'].map(function (s) {
          return h('a', { class: 'pt-dq-sevi', href: '#/quality/issues', dataset: { sev: s } }, h('b', { text: P.n(d.sev[s]) }), h('span', { text: 'Open ' + SEV[s].many.toLowerCase() }));
        }),
        h('div', { class: 'pt-dq-sevi pt-dq-last' }, h('b', null, when(d.last, true)), h('span', { text: 'Checked, IST' }))));
      body.querySelectorAll('a[data-sev]').forEach(function (a) { a.addEventListener('click', function () { setOnly({ sev: a.dataset.sev, status: 'open' }); }); });
    }).catch(function (e) { if (!gone) P.clear(body).appendChild(V().errorBox(e)); });
    return { el: el, dispose: function () { gone = true; } };
  }

  /* ---------- filters ---------- */
  var F = { q: '', group: '', sev: '', fam: '', sheet: false, status: 'open', low: false };
  var DEFAULT = { q: '', group: '', sev: '', fam: '', sheet: false, status: 'open', low: false };
  function setOnly(o) { Object.keys(DEFAULT).forEach(function (k) { F[k] = DEFAULT[k]; }); Object.keys(o).forEach(function (k) { F[k] = o[k]; }); }
  function activeCount() { var n = 0; Object.keys(DEFAULT).forEach(function (k) { if (F[k] !== DEFAULT[k]) n++; }); return n; }
  function issueFilterOn() { return !!(F.sev || F.fam || F.sheet || F.status !== 'open'); }
  function textHit(i, q) {
    return [i._label, i.dataset, i._name, i.check, i.column, i.hint, i._group].some(function (x) { return x && String(x).toLowerCase().indexOf(q) >= 0; });
  }
  // skip: one facet left out (for its own counts)
  function matches(i, d, skip) {
    if (skip !== 'status' && i.status !== F.status) return false;
    if (skip !== 'sev' && F.sev && i.severity !== F.sev) return false;
    if (skip !== 'fam' && F.fam && i._family !== F.fam) return false;
    if (skip !== 'sheet' && F.sheet && !i.source_fix) return false;
    if (skip !== 'group' && F.group && i._group !== F.group) return false;
    if (skip !== 'low' && F.low) { var s = d.scoreBy[i.dataset]; if (!s || s.score >= 80) return false; }
    if (skip !== 'q' && F.q && !textHit(i, F.q.toLowerCase())) return false;
    return true;
  }

  /* ---------- the page ---------- */
  var tableState = { datasets: {}, issues: {} };
  function page(host, ctx, view) {
    var gone = false;
    host.appendChild(V().head('Data quality', null, h('span', { class: 'pt-qmeta' }, V().loading())));
    var bodyHost = h('div', null, V().loading());
    host.appendChild(bodyHost);
    load(ctx).then(function (d) { if (!gone) render(host, bodyHost, d, ctx, view); })
      .catch(function (e) { if (!gone) P.clear(bodyHost).appendChild(V().errorBox(e, function () { invalidate(); P.clear(host); page(host, ctx, view); })); });
    return { dispose: function () { gone = true; document.body.classList.remove('pt-qside-open'); } };
  }

  function render(host, bodyHost, d, ctx, view) {
    var meta = host.querySelector('.pt-qmeta');
    P.clear(meta);
    P.clear(bodyHost);
    if (!d.scores.length && !d.issues.length) {
      meta.textContent = 'Checks run after every sync';
      bodyHost.appendChild(emptyPanel());
      return;
    }
    meta.appendChild(document.createTextNode(P.n(d.scores.length) + ' datasets checked · last checked '));
    meta.appendChild(when(d.last, true));
    meta.appendChild(document.createTextNode(' IST'));
    var filtersBtn = h('button', { type: 'button', class: 'ui-btn sm pt-qfilters', 'aria-controls': 'pt-qside', 'aria-expanded': 'false' }, icon('filter'), h('span', { text: 'Filters' }));
    var headEl = host.querySelector('.pt-head');
    var acts = headEl.querySelector('.ui-actions') || headEl.appendChild(h('div', { class: 'ui-actions' }));
    acts.appendChild(filtersBtn);

    var tiles = h('div', { class: 'ui-stats pt-qtiles' });
    // Filters: one wrapping row above the lists (the tables need the width); a drawer on phones.
    var bar = h('div', { class: 'ui-filters pt-qbar', id: 'pt-qside', role: 'region', 'aria-label': 'Filters' });
    var scrim = h('div', { class: 'pt-qscrim' });
    var tabs = h('div', { class: 'ui-drill-tabs pt-qtabs', role: 'tablist', 'aria-label': 'View' });
    var main = h('div', { class: 'pt-qmain' });
    bodyHost.appendChild(tiles);
    bodyHost.appendChild(bar);
    bodyHost.appendChild(tabs);
    bodyHost.appendChild(main);
    bodyHost.appendChild(scrim);

    function openSide(open) {
      document.body.classList.toggle('pt-qside-open', open);
      filtersBtn.setAttribute('aria-expanded', String(open));
      if (open) doneBtn.focus({ preventScroll: true });
    }
    filtersBtn.addEventListener('click', function () { openSide(!document.body.classList.contains('pt-qside-open')); });
    scrim.addEventListener('click', function () { openSide(false); });
    bar.addEventListener('keydown', function (e) { if (e.key === 'Escape' && document.body.classList.contains('pt-qside-open')) { e.stopPropagation(); openSide(false); filtersBtn.focus(); } });

    /* the bar is built once; option counts refresh on every change */
    var clearBtn = h('button', { type: 'button', class: 'ui-btn ghost sm', text: 'Clear' });
    var doneBtn = h('button', { type: 'button', class: 'ui-btn sm primary pt-qdone', text: 'Done' });
    var onLbl = h('small');
    var q = h('input', { class: 'ui-input', type: 'search', placeholder: 'Search datasets, checks, columns', 'aria-label': 'Search', autocomplete: 'off', spellcheck: 'false', value: F.q });
    var sel = {};
    function select(key, label) { sel[key] = h('select', { 'aria-label': label }); return h('label', { class: 'pt-qf' }, h('span', { class: 'pt-qf-l', text: label }), h('span', { class: 'ui-select' }, sel[key])); }
    var sheetBox = h('input', { type: 'checkbox', checked: !!F.sheet });
    var sheetLbl = h('span', { text: 'Fix in the sheet only' });
    bar.appendChild(h('div', { class: 'pt-qbar-h' }, h('h2', null, 'Filters', onLbl), doneBtn));
    bar.appendChild(h('div', { class: 'ui-search pt-qsearch' }, icon('search'), q));
    bar.appendChild(select('status', 'Status'));
    bar.appendChild(select('sev', 'Severity'));
    bar.appendChild(select('fam', 'Check family'));
    bar.appendChild(select('group', 'Report area'));
    bar.appendChild(h('label', { class: 'pt-qsheet' }, sheetBox, sheetLbl));
    bar.appendChild(clearBtn);
    q.addEventListener('input', P.debounce(function () { F.q = q.value.trim(); update(); }, 200));
    Object.keys(sel).forEach(function (k) { sel[k].addEventListener('change', function () { F[k] = sel[k].value; update(); }); });
    sheetBox.addEventListener('change', function () { F.sheet = sheetBox.checked; update(); });
    clearBtn.addEventListener('click', function () { setOnly({}); q.value = ''; update(); });
    doneBtn.addEventListener('click', function () { openSide(false); filtersBtn.focus(); });

    function count(skip, test) { var n = 0; d.issues.forEach(function (i) { if (matches(i, d, skip) && test(i)) n++; }); return n; }
    function fill(key, allLabel, opts) {
      var s = sel[key];
      P.clear(s);
      if (allLabel) s.appendChild(h('option', { value: '', text: allLabel }));
      opts.forEach(function (o) { s.appendChild(h('option', { value: o[0], text: o[1] + ' (' + P.n(o[2]) + ')' })); });
      s.value = F[key];
      s.classList.toggle('on', F[key] !== DEFAULT[key]);
    }
    function facets() {
      fill('status', '', [['open', 'Open', count('status', function (i) { return i.status === 'open'; })], ['resolved', 'Resolved, last 7 days', count('status', function (i) { return i.status === 'resolved'; })]]);
      fill('sev', 'All severities', ['error', 'warn', 'info'].map(function (s) { return [s, SEV[s].many, count('sev', function (i) { return i.severity === s; })]; }));
      fill('fam', 'All check families', FAMILIES.map(function (f) { return [f[0], f[1], count('fam', function (i) { return i._family === f[0]; })]; }));
      var groups = {};
      d.scores.forEach(function (s) { if (s.group) groups[s.group] = 1; });
      d.issues.forEach(function (i) { if (i._group) groups[i._group] = 1; });
      fill('group', 'All report areas', Object.keys(groups).sort(function (a, b) { var x = P.AREAS.indexOf(a), y = P.AREAS.indexOf(b); return (x < 0 ? 99 : x) - (y < 0 ? 99 : y) || a.localeCompare(b); })
        .map(function (g) { return [g, g, count('group', function (i) { return i._group === g; })]; }));
      sheetBox.checked = !!F.sheet;
      sheetLbl.textContent = 'Fix in the sheet only (' + P.n(count('sheet', function (i) { return !!i.source_fix; })) + ')';
      if (q.value.trim() !== F.q) q.value = F.q;
      var n = activeCount();
      onLbl.textContent = n ? n + ' on' : '';
      clearBtn.disabled = !n;
      filtersBtn.querySelector('span').textContent = n ? 'Filters · ' + n : 'Filters';
    }

    /* tiles: the severity ones filter the lists below */
    function drawTiles() {
      P.clear(tiles);
      function tile(k, label, value, sub, onClick, pressed, valueNode) {
        var el = h(onClick ? 'button' : 'div', { class: 'ui-stat', type: onClick ? 'button' : null, 'aria-pressed': onClick ? String(!!pressed) : null },
          h('div', { class: 'k' }, k != null ? P.dot(k) : null, h('span', { text: label })),
          h('div', { class: 'v' }, valueNode || value),
          sub ? h('div', { class: 's', text: sub }) : null);
        if (onClick) el.addEventListener('click', onClick);
        return el;
      }
      var sevTile = function (s, k) {
        return tile(k, 'Open ' + SEV[s].many.toLowerCase(), P.n(d.sev[s]), null, function () { var on = F.sev === s && F.status === 'open'; F.sev = on ? '' : s; F.status = 'open'; update(); }, F.sev === s && F.status === 'open');
      };
      tiles.appendChild(tile(null, 'Average score', d.avg == null ? '—' : String(d.avg), P.n(d.scores.length) + ' datasets', null, false,
        h('span', { class: 'pt-band-t-' + band(d.avg || 0), text: d.avg == null ? '—' : String(d.avg) })));
      tiles.appendChild(tile('bad', 'Below 80', P.n(d.bands.bad), P.n(d.bands.warn) + ' at 80–94 · ' + P.n(d.bands.ok) + ' at 95+', function () { F.low = !F.low; update(); }, F.low));
      tiles.appendChild(sevTile('error', 'bad'));
      tiles.appendChild(sevTile('warn', 'warn'));
      tiles.appendChild(sevTile('info', 'pt-dot-info'));
      tiles.appendChild(tile(null, 'Last checked', '', 'IST', null, false, h('span', { class: 'pt-qlast' }, when(d.last, true))));
    }

    function drawTabs(counts) {
      P.clear(tabs);
      [['datasets', 'By dataset', ''], ['actions', 'Owner action list', '/actions'], ['issues', 'All issues', '/issues']].forEach(function (t) {
        tabs.appendChild(h('a', { class: 'ui-drill-tab', role: 'tab', href: '#/quality' + t[2], 'aria-selected': String(view === t[0]) }, t[1], h('small', { text: P.n(counts[t[0]]) })));
      });
    }

    function update() {
      var list = d.issues.filter(function (i) { return matches(i, d); }).sort(bySeverity);
      var actions = d.issues.filter(function (i) { return i.status === 'open' && i.source_fix && matches(i, d, 'status'); }).sort(bySeverity);
      var dsRows = datasetRows(d, list);
      facets();
      drawTiles();
      drawTabs({ datasets: dsRows.length, actions: actions.length, issues: list.length });
      P.clear(main);
      if (view === 'actions') main.appendChild(actionList(actions, ctx));
      else if (view === 'issues') main.appendChild(issuesPanel(list, ctx));
      else main.appendChild(datasetsPanel(dsRows, ctx));
    }
    update();
  }

  /* By dataset */
  function datasetRows(d, list) {
    var by = {};
    list.forEach(function (i) { (by[i.dataset] || (by[i.dataset] = [])).push(i); });
    var q = F.q.toLowerCase();
    return d.scores.filter(function (s) {
      if (F.group && s.group !== F.group) return false;
      if (F.low && s.score >= 80) return false;
      var mine = by[s.dataset] || [];
      // Issue filters (severity, family, sheet-only, status): datasets with a matching issue.
      if (issueFilterOn()) return mine.length > 0;
      // Search: the dataset's own name, or any of its issues.
      if (q) return mine.length > 0 || s.label.toLowerCase().indexOf(q) >= 0 || s.dataset.indexOf(q) >= 0;
      return true;
    }).map(function (s) {
      var mine = (by[s.dataset] || []).slice().sort(bySeverity);
      var c = { error: 0, warn: 0, info: 0 };
      mine.forEach(function (i) { if (c[i.severity] != null) c[i.severity]++; });
      return { s: s, c: c, worst: mine[0] || null };
    });
  }
  function datasetsPanel(rows, ctx) {
    if (!rows.length) return emptyPanel('No dataset matches these filters.');
    var t = V().table([
      { label: 'Dataset', main: true, get: function (r) { return r.s.label; }, cell: function (r) {
        return h('a', { class: 'pt-ds-a', href: '#/d/' + encodeURIComponent(r.s.dataset) + '/quality' }, h('b', { text: r.s.label }), h('small', { class: 'pt-mono', text: r.s.dataset }));
      } },
      { label: 'Group', hideSm: true, cls: 'pt-groupc', get: function (r) { return r.s.group; }, cell: function (r) { return h('span', { title: r.s.group || null, text: r.s.group || '—' }); } },
      { label: 'Score', cls: 'pt-score-c', get: function (r) { return r.s.score; }, cell: function (r) { return scoreBar(r.s.score); } },
      { label: 'Errors · warnings · notes', num: true, cls: 'pt-sevc', get: function (r) { return r.c.error * 1e6 + r.c.warn * 1e3 + r.c.info; }, cell: function (r) {
        return h('span', { class: 'pt-sevcounts', title: r.c.error + ' errors, ' + r.c.warn + ' warnings, ' + r.c.info + ' notes' },
          countCell(r.c.error, 'bad'), h('i', { text: '·' }), countCell(r.c.warn, 'warn'), h('i', { text: '·' }), countCell(r.c.info, ''));
      } },
      { label: 'Rows', num: true, get: function (r) { return r.s.rows; }, cell: function (r) { return P.n(r.s.rows); } },
      { label: 'Worst issue', cls: 'pt-worst', get: function (r) { return r.worst ? rank(r.worst.severity) : 9; }, cell: function (r) {
        if (!r.worst) return h('span', { class: 'pt-nil', text: '—' });
        return h('span', { class: 'pt-worst-i', title: r.worst._name + (r.worst.column ? ' · ' + r.worst.column : '') }, P.dot(SEV[r.worst.severity] ? (r.worst.severity === 'info' ? 'pt-dot-info' : SEV[r.worst.severity].cls) : ''), r.worst._name, r.worst.column ? h('small', { class: 'pt-sub', text: ' · ' + r.worst.column }) : null);
      } },
      { label: 'Checked', get: function (r) { var t = P.pbDate(r.s.checked_at); return t ? t.getTime() : 0; }, cell: function (r) { return when(r.s.checked_at, true); } }
    ], rows, { sortIndex: 2, sortDir: 'asc', state: tableState.datasets, cards: true, cls: 'pt-qtable', onRow: function (r) { location.hash = '#/d/' + encodeURIComponent(r.s.dataset) + '/quality'; } });
    return h('section', { class: 'ui-panel' }, t);
  }
  function countCell(n, cls) { return n ? h('span', { class: 'pt-count ' + cls, text: P.n(n) }) : h('span', { class: 'pt-nil', text: '0' }); }

  /* Owner action list */
  function actionGroups(list, ctx) {
    var groups = {}, order = [];
    list.forEach(function (i) {
      var sh = sheetOf(i, ctx), k = sh.url || 'dataset:' + i.dataset;
      var g = groups[k];
      if (!g) { g = groups[k] = { url: sh.url, labels: [], keys: {}, items: [], worst: 9, total: 0 }; order.push(k); }
      var lab = sh.ds ? String(sh.ds.label || sh.ds.key) : i._label;
      if (g.labels.indexOf(lab) < 0) g.labels.push(lab);
      g.keys[i.dataset] = i._label;
      g.items.push(i);
      g.worst = Math.min(g.worst, rank(i.severity));
      g.total += Number(i.count) || 0;
    });
    return order.map(function (k) { var g = groups[k]; g.items.sort(bySeverity); return g; })
      .sort(function (a, b) { return a.worst - b.worst || b.total - a.total || a.labels[0].localeCompare(b.labels[0]); });
  }
  function groupTitle(g) { return g.labels.join(' · '); }
  function plainText(groups) {
    var out = [];
    groups.forEach(function (g) {
      out.push(groupTitle(g) + (g.url ? '  ' + g.url : ''));
      g.items.forEach(function (i) {
        out.push('  [' + (SEV[i.severity] ? SEV[i.severity].label : i.severity) + '] ' + i._name + (i.column ? ' (' + i.column + ')' : '') + ': ' + P.n(i.count || 0) + (Object.keys(g.keys).length > 1 ? '  [' + i._label + ']' : ''));
        if (i.hint) out.push('    ' + String(i.hint).replace(/\s+/g, ' '));
        samplesOf(i).slice(0, 3).forEach(function (s) { out.push('    e.g. ' + sampleLine(s)); });
      });
      out.push('');
    });
    return out.join('\n').trim() + '\n';
  }
  function csvCell(s) {
    s = s == null ? '' : String(s);
    if (/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function exportCsv(groups) {
    var lines = [['sheet', 'sheet_url', 'dataset', 'dataset_key', 'severity', 'check', 'check_id', 'column', 'count', 'share_of_rows', 'hint', 'examples', 'first_seen', 'last_seen'].join(',')];
    groups.forEach(function (g) {
      g.items.forEach(function (i) {
        lines.push([groupTitle(g), P.safeHref(g.url) ? g.url : '', i._label, i.dataset, SEV[i.severity] ? SEV[i.severity].label : i.severity, i._name, i.check, i.column || '', String(Number(i.count) || 0),
          i._pct == null ? '' : (i._pct * 100).toFixed(2) + '%', i.hint || '', samplesOf(i).slice(0, 3).map(sampleLine).join(' | '), day(i.first_seen), day(i.last_seen)].map(csvCell).join(','));
      });
    });
    var blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'owner-action-list-' + istDay.format(new Date()).split('/').reverse().join('') + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }
  function copyText(text, what) { P.copy(text).then(function () { P.toast(what + ' copied'); }, function () { P.toast('Copy is not available here'); }); }
  function actionList(list, ctx) {
    if (!list.length) return emptyPanel(store.data && store.data.issues.length ? 'Nothing to fix in the sheets for these filters.' : EMPTY);
    var groups = actionGroups(list, ctx);
    var panel = h('section', { class: 'ui-panel pt-actions' },
      h('div', { class: 'ui-panel-h' },
        h('h2', null, 'Fix in the source', h('small', { text: P.n(groups.length) + ' sheets · ' + P.n(list.length) + ' issues' })),
        h('div', { class: 'ui-actions' },
          h('button', { type: 'button', class: 'ui-btn sm', on: { click: function () { copyText(plainText(groups), 'List'); } } }, icon('copy'), 'Copy list as text'),
          h('button', { type: 'button', class: 'ui-btn sm', on: { click: function () { exportCsv(groups); P.toast('Exported ' + P.n(list.length) + ' issues'); } } }, icon('download'), 'Export CSV'))));
    var flat = [];
    groups.forEach(function (g) { g.items.forEach(function (i) { flat.push(i); }); });
    groups.forEach(function (g) {
      var multi = Object.keys(g.keys).length > 1;
      var u = P.safeHref(g.url);
      panel.appendChild(h('section', { class: 'pt-act-g' },
        h('header', { class: 'pt-act-h' },
          h('div', { class: 'pt-act-t' }, h('b', { text: groupTitle(g) }),
            h('small', { class: 'pt-sub' }, P.n(g.items.length) + (g.items.length === 1 ? ' issue' : ' issues'), u && u.charAt(0) !== '#' ? ' · ' + new URL(u).hostname : '')),
          h('div', { class: 'pt-act-b' }, openSheet(g.url),
            h('button', { type: 'button', class: 'ui-btn sm ghost', title: 'Copy this sheet’s list as text', on: { click: function () { copyText(plainText([g]), 'Sheet list'); } } }, icon('copy'), h('span', { class: 'pt-hide-xs', text: 'Copy' })))),
        h('ol', { class: 'pt-act-l' }, g.items.map(function (i) {
          var li = h('li', { class: 'pt-act-i', tabindex: '0', role: 'button', 'aria-label': i._name + ' details' },
            h('div', { class: 'pt-act-1' }, sevBadge(i.severity), h('b', { text: i._name }),
              i.column ? h('span', { class: 'pt-col', text: i.column }) : null,
              h('span', { class: 'pt-act-n', text: '× ' + P.n(i.count || 0) }),
              multi ? h('small', { class: 'pt-sub', text: i._label }) : null),
            i.hint ? h('p', { class: 'pt-act-hint', text: String(i.hint) }) : null,
            samplesOf(i).length ? h('ul', { class: 'pt-act-s' }, samplesOf(i).slice(0, 3).map(function (s) { return h('li', { text: sampleLine(s) }); })) : null);
          var open = function () { openIssue(flat, flat.indexOf(i), ctx); };
          li.addEventListener('click', function (e) { if (!e.target.closest('a')) open(); });
          li.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
          return li;
        }))));
    });
    return panel;
  }

  /* All issues */
  function issueCols(withDataset) {
    var cols = [];
    if (withDataset) cols.push({ label: 'Dataset', main: true, get: function (i) { return i._label; }, cell: function (i) { return h('span', { class: 'pt-ds-a' }, h('b', { text: i._label }), h('small', { class: 'pt-mono', text: i.dataset })); } });
    cols.push(
      { label: 'Severity', get: function (i) { return rank(i.severity); }, cell: function (i) { return sevBadge(i.severity); } },
      { label: 'Check', main: !withDataset, get: function (i) { return i._name; }, cell: function (i) { return h('span', { title: String(i.check), text: i._name }); } },
      { label: 'Column', cls: 'pt-colc', get: function (i) { return i.column || ''; }, cell: function (i) { return i.column ? h('span', { class: 'pt-mono', title: String(i.column), text: String(i.column) }) : h('span', { class: 'pt-nil', text: '—' }); } },
      { label: 'Count', num: true, get: function (i) { return Number(i.count) || 0; }, cell: function (i) { return P.n(i.count || 0); } },
      { label: '% of rows', num: true, get: function (i) { return i._pct == null ? -1 : i._pct; }, cell: function (i) { return pct(i._pct); } },
      { label: 'First seen', get: function (i) { var t = P.pbDate(i.first_seen); return t ? t.getTime() : 0; }, cell: function (i) { return when(i.first_seen); } },
      { label: 'Last seen', get: function (i) { var t = P.pbDate(i.last_seen); return t ? t.getTime() : 0; }, cell: function (i) { return when(i.last_seen); } },
      { label: 'Status', get: function (i) { return i.status; }, cell: function (i) { return h('span', { class: 'ui-badge' + (i.status === 'open' ? '' : ' ok'), text: i.status === 'open' ? 'Open' : 'Resolved' }); } }
    );
    return cols;
  }
  function issuesPanel(list, ctx) {
    if (!list.length) return emptyPanel(store.data && store.data.issues.length ? 'No issue matches these filters.' : EMPTY);
    var state = tableState.issues;
    var t = V().table(issueCols(true), list, { state: state, cards: true, cls: 'pt-qtable', onRow: function (i) {
      var order = sortedLike(list, state);
      openIssue(order, order.indexOf(i), ctx);
    } });
    return h('section', { class: 'ui-panel' }, t);
  }
  // The drawer's previous/next follow the table's current sort.
  function sortedLike(list, state) {
    if (state.i == null || state.i < 0) return list;
    var col = issueCols(true)[state.i];
    if (!col || !col.get) return list;
    var dir = state.dir === 'asc' ? 1 : -1;
    return list.slice().sort(function (a, b) {
      var x = col.get(a), y = col.get(b);
      if (typeof x === 'number' || typeof y === 'number') return ((x || 0) - (y || 0)) * dir;
      return String(x).localeCompare(String(y), 'en', { numeric: true }) * dir;
    });
  }

  /* ---------- dataset page: Quality tab ---------- */
  function datasetTab(body, ds, ctx) {
    var gone = false, ac = new AbortController();
    var head = h('div', null, V().loading());
    var openHost = h('div');
    var resHost = h('div', null, V().loading());
    body.appendChild(h('section', { class: 'ui-panel' }, head));
    body.appendChild(openHost);
    body.appendChild(V().panel('Resolved', 'last 20', resHost));
    load(ctx).then(function (d) {
      if (gone) return;
      var s = d.scoreBy[ds.key];
      var open = d.open.filter(function (i) { return i.dataset === ds.key; }).sort(bySeverity);
      P.clear(head);
      if (!s) { head.appendChild(h('div', { class: 'ui-empty', text: EMPTY })); }
      else {
        var c = { error: 0, warn: 0, info: 0 };
        open.forEach(function (i) { if (c[i.severity] != null) c[i.severity]++; });
        head.appendChild(h('div', { class: 'pt-dsq' },
          h('div', { class: 'pt-dsq-score' }, h('div', { class: 'pt-dq-num pt-band-t-' + band(s.score), text: String(s.score) }), h('div', { class: 'pt-dq-k', text: 'Quality score' })),
          h('div', { class: 'pt-dsq-bar' }, scoreBar(s.score)),
          h('div', { class: 'pt-dsq-meta' },
            h('span', null, P.dot('bad'), P.n(c.error) + ' errors'), h('span', null, P.dot('warn'), P.n(c.warn) + ' warnings'), h('span', null, P.dot('pt-dot-info'), P.n(c.info) + ' notes'),
            h('span', null, 'Checked ', when(s.checked_at, true), ' IST'))));
      }
      openHost.appendChild(V().panel('Open issues', String(open.length),
        open.length ? V().table(issueCols(false), open, { sortable: false, cards: true, cls: 'pt-qtable', onRow: function (i) { openIssue(open, open.indexOf(i), ctx); } })
          : h('div', { class: 'ui-empty', text: s ? 'No open issues.' : EMPTY })));
    }).catch(function (e) { if (!gone) P.clear(head).appendChild(V().errorBox(e)); });
    P.api.list('sys_quality_issues', { page: 1, perPage: 20, sort: '-last_seen', filter: 'dataset = ' + P.q(ds.key) + " && status = 'resolved'", skipTotal: true }, ac.signal)
      .catch(function (e) { if (e && e.status === 404) return { items: [] }; throw e; })
      .then(function (r) {
        if (gone) return;
        var items = (r.items || []).map(function (i) {
          i._ds = ds; i._label = String(ds.label || ds.key); i._group = ds.group || ''; i._family = family(i.check); i._name = checkName(i.check);
          i._pct = Number(ds.row_count) > 0 ? (Number(i.count) || 0) / Number(ds.row_count) : null;
          return i;
        });
        P.clear(resHost).appendChild(items.length
          ? V().table(issueCols(false), items, { sortable: false, cards: true, cls: 'pt-qtable', onRow: function (i) { openIssue(items, items.indexOf(i), ctx); } })
          : h('div', { class: 'ui-empty', text: 'Nothing resolved yet.' }));
      }).catch(function (e) { if (!gone && e.name !== 'AbortError') P.clear(resHost).appendChild(V().errorBox(e)); });
    return { dispose: function () { gone = true; ac.abort(); } };
  }

  P.quality = { load: load, invalidate: invalidate, overviewCard: overviewCard, page: page, datasetTab: datasetTab, checkName: checkName, NAMES: NAMES };
})(window);
