/* Portal views: Overview, the dataset page (Data / Schema / Source / Sync history) and the row drawer. */
(function (w) {
  'use strict';
  var P = w.Portal = w.Portal || {};
  var h = P.h, icon = P.icon;

  /* ---------- small builders ---------- */
  function head(title, badge, meta, actions) {
    return h('div', { class: 'ui-head pt-head' },
      h('div', { class: 'pt-head-t' }, h('h1', null, h('span', { text: title }), badge || null), meta ? h('p', { class: 'pt-meta' }, meta) : null),
      actions && actions.length ? h('div', { class: 'ui-actions' }, actions) : null);
  }
  function panel(title, small, body, extra) {
    return h('section', { class: 'ui-panel' },
      h('div', { class: 'ui-panel-h' }, h('h2', null, title, small != null ? h('small', { text: small }) : null), extra || null),
      body);
  }
  function relTime(s) {
    var d = s instanceof Date ? s : P.pbDate(s);
    return h('time', { datetime: d ? d.toISOString() : null, title: d ? P.dateTime(d) : null, text: d ? P.rel(d) : '—' });
  }
  function srcLink(ds, cls, label) {
    var u = P.safeHref(ds.source_url);
    if (!u || u.charAt(0) === '#') return null;
    return h('a', { class: cls || 'pt-link', href: u, target: '_blank', rel: 'noopener noreferrer', title: u }, label || 'Open', icon('ext'));
  }
  // Simple client-sorted table. cols: [{ label, num, get(row) → sort value, cell(row) → node|string, cls }]
  function table(cols, rows, opts) {
    opts = opts || {};
    // opts.state keeps the sort across rebuilds; opts.cards turns rows into cards on phones.
    var st = opts.state || {};
    if (st.i == null) { st.i = opts.sortIndex != null ? opts.sortIndex : -1; st.dir = opts.sortDir || 'asc'; }
    var thead = h('thead'), tbody = h('tbody');
    var wrap = h('div', { class: 'ui-table-wrap' + (opts.wrapCls ? ' ' + opts.wrapCls : '') }, h('table', { class: 'ui-table' + (opts.cls ? ' ' + opts.cls : '') + (opts.cards ? ' pt-cards' : '') }, thead, tbody));
    function draw() {
      P.clear(thead); P.clear(tbody);
      var tr = h('tr');
      cols.forEach(function (c, i) {
        var on = st.i === i;
        var th = h('th', { scope: 'col', class: (c.num ? 'num ' : '') + (c.hideSm ? 'hide-sm' : ''), 'aria-sort': on ? (st.dir === 'asc' ? 'ascending' : 'descending') : null });
        if (c.get && opts.sortable !== false) {
          th.appendChild(h('button', { type: 'button', class: 'pt-th' + (on ? ' on' : ''), on: { click: function () { st.dir = st.i === i && st.dir === 'asc' ? 'desc' : st.i === i ? 'asc' : (c.num ? 'desc' : 'asc'); st.i = i; draw(); } } },
            h('span', { text: c.label }), on ? icon(st.dir === 'asc' ? 'up' : 'down', 'pt-sort-i') : null));
        } else th.textContent = c.label;
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      var list = rows.slice();
      if (st.i >= 0 && cols[st.i].get) {
        var g = cols[st.i].get, d = st.dir === 'asc' ? 1 : -1;
        list.sort(function (a, b) {
          var x = g(a), y = g(b);
          if (typeof x === 'number' || typeof y === 'number') return ((x || 0) - (y || 0)) * d;
          return String(x == null ? '' : x).localeCompare(String(y == null ? '' : y), 'en', { numeric: true }) * d;
        });
      }
      if (!list.length) tbody.appendChild(h('tr', null, h('td', { colspan: cols.length }, h('div', { class: 'ui-empty', text: opts.empty || 'Nothing to show.' }))));
      list.forEach(function (r) {
        var row = h('tr', { class: opts.onRow ? 'click' : null, tabindex: opts.onRow ? '0' : null });
        cols.forEach(function (c) { row.appendChild(h('td', { class: (c.num ? 'num ' : '') + (c.cls || '') + (c.hideSm ? ' hide-sm' : '') + (c.main ? ' pt-card-main' : ''), 'data-label': opts.cards ? c.label : null }, c.cell ? c.cell(r) : String(c.get(r) == null ? '—' : c.get(r)))); });
        if (opts.onRow) {
          row.addEventListener('click', function (e) { if (!e.target.closest('a')) opts.onRow(r); });
          row.addEventListener('keydown', function (e) { if (e.key === 'Enter') opts.onRow(r); });
        }
        tbody.appendChild(row);
      });
    }
    draw();
    return wrap;
  }
  function loading() { return h('div', { class: 'ui-empty' }, h('span', { class: 'ui-skel pt-skel' })); }
  function errorBox(e, retry) {
    return h('div', { class: 'ui-empty' }, h('p', { text: 'Could not load: ' + ((e && e.message) || 'network error') }),
      retry ? h('button', { type: 'button', class: 'ui-btn sm', text: 'Try again', on: { click: retry } }) : null);
  }
  function runStatus(r) { return P.statusBadge(r.status); }
  function runDuration(r) {
    if (Number(r.duration_ms) > 0) return Number(r.duration_ms);
    var a = P.pbDate(r.started_at), b = P.pbDate(r.finished_at);
    return a && b ? b - a : null;
  }
  function runChanges(r) {
    var bits = [];
    if (r.rows_inserted) bits.push('+' + P.n(r.rows_inserted));
    if (r.rows_updated) bits.push('~' + P.n(r.rows_updated));
    if (r.rows_deleted) bits.push('−' + P.n(r.rows_deleted));
    return bits.length ? bits.join('  ') : '—';
  }

  /* ---------- Overview ---------- */
  var ovFilter = '';
  function overview(host, ctx) {
    var list = ctx.datasets();
    var ac = new AbortController();
    var fr = {}, totals = { rows: 0, cells: 0 };
    list.forEach(function (d) {
      var f = P.freshness(d); fr[f.k] = (fr[f.k] || 0) + 1;
      totals.rows += Number(d.row_count) || 0;
      totals.cells += (Number(d.row_count) || 0) * (Number(d.column_count) || 0);
    });
    var lastSync = list.reduce(function (m, d) { var t = P.pbDate(d.last_checked_at) || P.pbDate(d.last_synced_at); return t && (!m || t > m) ? t : m; }, null);

    host.appendChild(head('Overview', null, [P.n(list.length) + ' datasets · ' + P.n(totals.rows) + ' rows · last sync ', lastSync ? relTime(lastSync) : 'never']));

    // Stat strip: Fresh / Stale / Errors filter the dataset table below.
    var stats = h('div', { class: 'ui-stats pt-stats' });
    var tableHost = h('div');
    function stat(k, label, value, sub, filterKey) {
      var b = h(filterKey ? 'button' : 'div', { class: 'ui-stat', type: filterKey ? 'button' : null, 'aria-pressed': filterKey ? String(ovFilter === filterKey) : null },
        h('div', { class: 'k' }, k ? P.dot(k) : null, h('span', { text: label })),
        h('div', { class: 'v', text: value }),
        sub != null ? h('div', { class: 's', text: sub }) : null);
      if (filterKey) b.addEventListener('click', function () { ovFilter = ovFilter === filterKey ? '' : filterKey; P.clear(host); overview(host, ctx); });
      return b;
    }
    stats.appendChild(stat('', 'Datasets', P.n(list.length), P.n(list.filter(function (d) { return d.collection; }).length) + ' mirrored'));
    stats.appendChild(stat('', 'Rows', P.n(totals.rows), P.n(totals.cells) + ' cells'));
    stats.appendChild(stat('ok', 'Fresh', P.n(fr.fresh || 0), null, 'fresh'));
    stats.appendChild(stat('warn', 'Stale', P.n(fr.stale || 0), null, 'stale'));
    stats.appendChild(stat('bad', 'Errors', P.n(fr.error || 0), null, 'error'));
    stats.appendChild(stat('', 'Not mirrored', P.n((fr.skipped || 0) + (fr.never || 0)), null, 'other'));
    host.appendChild(stats);
    var dq = P.quality ? P.quality.overviewCard(ctx) : null;
    if (dq) host.appendChild(dq.el);

    // By source type + Needs attention
    var bySrc = {};
    list.forEach(function (d) {
      var s = P.source(d.source_type).k;
      var b = bySrc[s] || (bySrc[s] = { k: s, n: 0, rows: 0, cols: 0, cells: 0 });
      b.n++; b.rows += Number(d.row_count) || 0; b.cols += Number(d.column_count) || 0; b.cells += (Number(d.row_count) || 0) * (Number(d.column_count) || 0);
    });
    var srcRows = P.SOURCES.map(function (s) { return bySrc[s.k]; }).filter(Boolean);
    var maxRows = Math.max.apply(null, srcRows.map(function (r) { return r.rows; }).concat([1]));
    var srcTable = table([
      { label: 'Source', get: function (r) { return P.source(r.k).label; }, cell: function (r) { return h('span', { class: 'pt-src' }, icon(P.source(r.k).icon), P.source(r.k).label); } },
      { label: 'Datasets', num: true, get: function (r) { return r.n; }, cell: function (r) { return P.n(r.n); } },
      { label: 'Rows', num: true, get: function (r) { return r.rows; }, cell: function (r) { return P.n(r.rows); } },
      { label: 'Cells', num: true, hideSm: true, get: function (r) { return r.cells; }, cell: function (r) { return P.n(r.cells); } },
      { label: 'Share of rows', cls: 'pt-share', hideSm: true, get: function (r) { return r.rows; }, cell: function (r) { return share(r.rows, totals.rows, maxRows); } }
    ], srcRows, { sortable: false });
    var attention = list.filter(function (d) { var k = P.freshness(d).k; return k === 'error' || k === 'stale' || k === 'never'; })
      .sort(function (a, b) { var o = { error: 0, stale: 1, never: 2 }; return o[P.freshness(a).k] - o[P.freshness(b).k]; });
    var attBody = attention.length ? h('ul', { class: 'pt-att' }, attention.map(function (d) {
      var f = P.freshness(d);
      return h('li', null, h('a', { href: '#/d/' + encodeURIComponent(d.key) + '/source', class: 'pt-att-a' },
        h('div', { class: 'pt-att-t' }, P.dot(f.cls), h('b', { text: d.label || d.key }), h('span', { class: 'ui-badge ' + f.cls, text: f.label })),
        h('div', { class: 'pt-att-s' }, 'Last checked ', relTime(d.last_checked_at || d.last_synced_at), ' · synced ', relTime(d.last_synced_at), ' · ', P.schedule(d.schedule).label.toLowerCase()),
        d.last_error ? h('div', { class: 'pt-att-e', text: String(d.last_error).slice(0, 220) }) : null));
    })) : h('div', { class: 'ui-empty', text: 'Every dataset is fresh.' });
    host.appendChild(h('div', { class: 'ui-grid pt-ov-grid' },
      panel('By source', null, srcTable),
      panel('Needs attention', attention.length ? String(attention.length) : null, attBody)));

    // Recent sync runs
    var runsBody = h('div', null, loading());
    host.appendChild(panel('Recent sync runs', null, runsBody));
    function loadRuns() {
      P.clear(runsBody).appendChild(loading());
      P.api.list('sys_sync_runs', { page: 1, perPage: 15, sort: '-started_at', skipTotal: true }, ac.signal).then(function (r) {
        P.clear(runsBody).appendChild(runsTable(r.items || [], ctx, true));
      }).catch(function (e) { if (e.name !== 'AbortError') P.clear(runsBody).appendChild(errorBox(e, loadRuns)); });
    }
    loadRuns();

    // All datasets
    var shown = list.filter(function (d) {
      if (!ovFilter) return true;
      var k = P.freshness(d).k;
      return ovFilter === 'other' ? (k === 'skipped' || k === 'never') : k === ovFilter;
    });
    tableHost.appendChild(datasetsTable(shown));
    host.appendChild(panel('All datasets', ovFilter ? P.n(shown.length) + ' of ' + P.n(list.length) : P.n(list.length), tableHost,
      ovFilter ? h('button', { type: 'button', class: 'ui-btn sm ghost', text: 'Show all', on: { click: function () { ovFilter = ''; P.clear(host); overview(host, ctx); } } }) : null));

    return { dispose: function () { ac.abort(); if (dq) dq.dispose(); } };
  }
  function share(v, total, max) {
    var pct = total ? v / total * 100 : 0;
    var bar = h('b'); bar.style.width = (max ? Math.max(v ? 2 : 0, v / max * 100) : 0) + '%';
    return h('div', { class: 'ui-bar' }, h('i', null, bar), h('span', { text: pct ? (pct < 1 ? '<1' : Math.round(pct)) + '%' : '0%' }));
  }
  function datasetsTable(list) {
    return table([
      { label: 'Dataset', get: function (d) { return d.label || d.key; }, cell: function (d) {
        return h('a', { class: 'pt-ds-a', href: '#/d/' + encodeURIComponent(d.key) }, h('b', { text: d.label || d.key }), h('small', { class: 'pt-mono', text: d.collection || d.key }));
      } },
      { label: 'Area', hideSm: true, get: function (d) { return d.group || ''; }, cell: function (d) { return d.group || '—'; } },
      { label: 'Source', get: function (d) { return P.source(d.source_type).one; }, cell: function (d) { return h('span', { class: 'pt-src' }, icon(P.source(d.source_type).icon), P.source(d.source_type).one); } },
      { label: 'Rows', num: true, get: function (d) { return Number(d.row_count) || 0; }, cell: function (d) { return P.n(d.row_count || 0); } },
      { label: 'Columns', num: true, hideSm: true, get: function (d) { return Number(d.column_count) || 0; }, cell: function (d) { return P.n(d.column_count || 0); } },
      { label: 'Schedule', hideSm: true, get: function (d) { return d.schedule || ''; }, cell: function (d) { return P.schedule(d.schedule).label; } },
      { label: 'Last synced', get: function (d) { var t = P.pbDate(d.last_synced_at); return t ? t.getTime() : 0; }, cell: function (d) { return relTime(d.last_synced_at); } },
      { label: 'Status', get: function (d) { return P.freshness(d).label; }, cell: function (d) { var f = P.freshness(d); return h('span', { class: 'pt-fresh' }, P.dot(f.cls), f.label); } },
      { label: 'Source link', cell: function (d) { return srcLink(d) || h('span', { class: 'pt-nil', text: '—' }); } }
    ], list, { empty: 'No datasets match.', cls: 'pt-dstable' });
  }
  function runsTable(runs, ctx, withDataset) {
    var cols = [];
    if (withDataset) cols.push({ label: 'Dataset', cell: function (r) {
      var d = ctx.byKey(r.dataset);
      return d ? h('a', { class: 'pt-link', href: '#/d/' + encodeURIComponent(d.key) + '/history', text: d.label || d.key }) : h('span', { class: 'pt-mono', text: r.dataset || '—' });
    } });
    cols.push(
      { label: 'Started', cell: function (r) { return h('span', { title: P.dateTime(r.started_at) }, P.dateVal(r.started_at)); } },
      { label: 'Status', cell: runStatus },
      { label: 'Duration', num: true, hideSm: true, cell: function (r) { return P.dur(runDuration(r)); } },
      { label: 'Rows', num: true, cell: function (r) { return r.rows_total != null ? P.n(r.rows_total) : '—'; } },
      { label: 'Changes', num: true, hideSm: true, cell: function (r) { return h('span', { class: 'pt-chg', title: 'inserted / updated / deleted' }, runChanges(r)); } },
      { label: 'Message', cls: 'pt-msg', cell: function (r) { return r.message ? h('span', { title: String(r.message).slice(0, 600), text: String(r.message) }) : h('span', { class: 'pt-nil', text: '—' }); } }
    );
    return table(cols, runs, { sortable: false, empty: 'No sync runs yet.' });
  }

  /* ---------- Dataset page ---------- */
  var TABS = [['data', 'Data'], ['schema', 'Schema'], ['source', 'Source'], ['history', 'Sync history'], ['quality', 'Quality']];
  function dataset(host, ds, tab, ctx) {
    var f = P.freshness(ds), src = P.source(ds.source_type);
    var meta = [
      h('span', { class: 'pt-mono', text: ds.collection || 'no collection' }), ' · ',
      src.one, ' · ', P.n(ds.row_count || 0), ' rows · ', P.n(ds.column_count || 0), ' columns · synced ', relTime(ds.last_synced_at)
    ];
    host.appendChild(head(ds.label || ds.key, h('span', { class: 'ui-badge pt-fresh-b ' + f.cls }, P.dot(f.cls), f.label), meta, [srcLink(ds, 'ui-btn sm', 'Open source')].filter(Boolean)));
    var tabs = h('div', { class: 'ui-drill-tabs pt-tabs', role: 'tablist', 'aria-label': 'Dataset' });
    TABS.forEach(function (t) {
      tabs.appendChild(h('a', { class: 'ui-drill-tab', role: 'tab', href: '#/d/' + encodeURIComponent(ds.key) + (t[0] === 'data' ? '' : '/' + t[0]), 'aria-selected': String(t[0] === tab), id: 'tab-' + t[0] }, t[1]));
    });
    host.appendChild(tabs);
    var body = h('div', { class: 'pt-tabbody', role: 'tabpanel', 'aria-labelledby': 'tab-' + tab });
    host.appendChild(body);
    host.classList.toggle('pt-fill', tab === 'data');
    if (tab === 'schema') return schemaTab(body, ds);
    if (tab === 'source') return sourceTab(body, ds);
    if (tab === 'history') return historyTab(body, ds, ctx);
    if (tab === 'quality') return P.quality.datasetTab(body, ds, ctx);
    if (!ds.collection) {
      body.appendChild(h('section', { class: 'ui-panel' }, h('div', { class: 'ui-empty' },
        h('p', { text: ds.last_status === 'skipped' ? 'This dataset is not mirrored.' : 'No rows mirrored yet.' }),
        ds.notes ? h('p', { class: 'ui-note', text: String(ds.notes) }) : null)));
      return null;
    }
    return P.grid.mount(body, ds, ctx);
  }

  function schemaTab(body, ds) {
    var cols = P.columns(ds);
    var pk = Array.isArray(ds.primary_key) ? ds.primary_key.map(String) : ds.primary_key ? [String(ds.primary_key)] : [];
    var isPk = function (c) { return pk.indexOf(c.source_name) >= 0 || pk.indexOf(c.name) >= 0; };
    var t = table([
      { label: '#', num: true, get: function (c) { return c.i; }, cell: function (c) { return String(c.i); } },
      { label: 'Field', get: function (c) { return c.name; }, cell: function (c) { return h('span', { class: 'pt-mono', text: c.name }); } },
      { label: 'Source column', get: function (c) { return c.source_name; }, cell: function (c) { return c.source_name; } },
      { label: 'Type', get: function (c) { return c.type; }, cell: function (c) { return h('span', { class: 'ui-badge pt-type', text: c.type }); } },
      { label: 'Key', cell: function (c) { return isPk(c) ? h('span', { class: 'ui-badge ok', text: 'primary key' }) : ''; } }
    ], cols.map(function (c, i) { return Object.assign({ i: i + 1 }, c); }), { empty: 'No columns recorded for this dataset yet.' });
    body.appendChild(panel('Columns', P.n(cols.length), t,
      h('span', { class: 'ui-note' }, 'Primary key: ', pk.length ? h('b', { text: pk.join(', ') }) : 'none (rows are keyed by a content hash)')));
    var sys = table([
      { label: 'Field', cell: function (s) { return h('span', { class: 'pt-mono', text: s.name }); } },
      { label: 'Type', cell: function (s) { return h('span', { class: 'ui-badge pt-type', text: s.type }); } },
      { label: 'Meaning', cls: 'wrap', cell: function (s) { return s.about; } }
    ], P.SYSTEM_FIELDS, { sortable: false });
    body.appendChild(panel('System fields', null, sys,
      h('span', { class: 'ui-note' }, 'Collection ', h('b', { class: 'pt-mono', text: ds.collection || '—' }))));
    return null;
  }

  function sourceTab(body, ds) {
    var f = P.freshness(ds), src = P.source(ds.source_type);
    var dl = h('dl', { class: 'ui-dl pt-dl pt-src-dl' });
    function row(label, value) { if (value == null || value === '') return; dl.appendChild(h('dt', { text: label })); dl.appendChild(h('dd', null, value)); }
    row('Source type', h('span', { class: 'pt-src' }, icon(src.icon), src.one, ' ', h('small', { class: 'pt-mono pt-sub', text: String(ds.source_type || '') })));
    var ref = ds.source_ref;
    if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
      row('Reference', h('div', { class: 'pt-kv' }, Object.keys(ref).map(function (k) {
        var v = ref[k];
        return [h('span', { class: 'pt-k', text: k }), h('span', { class: 'pt-mono', text: typeof v === 'object' ? JSON.stringify(v) : String(v) })];
      })));
    } else if (ref != null && ref !== '') row('Reference', h('span', { class: 'pt-mono', text: typeof ref === 'object' ? JSON.stringify(ref) : String(ref) }));
    var link = srcLink(ds, 'pt-link', 'Open source');
    row('Source link', link ? h('span', null, link, h('small', { class: 'pt-sub pt-url', text: String(ds.source_url) })) : ds.source_url ? h('span', { class: 'pt-mono', text: String(ds.source_url) }) : null);
    row('Collection', h('span', { class: 'pt-mono', text: ds.collection || '—' }));
    row('Key', h('span', { class: 'pt-mono', text: ds.key }));
    row('Report area', ds.group || null);
    row('Schedule', P.schedule(ds.schedule).label);
    row('Last result', P.statusBadge(ds.last_status));
    row('Freshness', h('span', { class: 'pt-fresh' }, P.dot(f.cls), f.label));
    row('Last synced', ds.last_synced_at ? h('span', null, P.dateTime(ds.last_synced_at), ' · ', relTime(ds.last_synced_at)) : 'never');
    row('Last checked', ds.last_checked_at ? h('span', null, P.dateTime(ds.last_checked_at), ' · ', relTime(ds.last_checked_at)) : 'never');
    row('Last fetched', ds.last_fetched_at ? h('span', null, P.dateTime(ds.last_fetched_at), ' · ', relTime(ds.last_fetched_at)) : null);
    row('Last duration', ds.last_duration_ms ? P.dur(ds.last_duration_ms) : null);
    row('Last version', ds.last_version ? h('span', { class: 'pt-mono pt-break', text: String(ds.last_version) }) : null);
    row('Rows', P.n(ds.row_count || 0) + ' rows · ' + P.n(ds.column_count || 0) + ' columns');
    row('Last error', ds.last_error ? h('pre', { class: 'pt-json pt-error', text: String(ds.last_error) }) : null);
    row('Notes', ds.notes ? h('span', { class: 'pt-pre', text: String(ds.notes) }) : null);
    if (Array.isArray(ds.pages) && ds.pages.length) row('Used by pages', h('div', { class: 'pt-list' }, ds.pages.map(function (p) { return h('div', { class: 'pt-mono', text: String(p) }); })));
    body.appendChild(panel('Source', null, dl));
    return null;
  }

  function historyTab(body, ds, ctx) {
    var ac = new AbortController(), page = 1, all = [];
    var host = h('div', null, loading()), more = h('div', { class: 'ui-panel-f', hidden: true });
    body.appendChild(panel('Sync history', null, h('div', null, host, more)));
    function load() {
      P.api.list('sys_sync_runs', { page: page, perPage: 50, sort: '-started_at', filter: 'dataset = ' + P.q(ds.key) }, ac.signal).then(function (r) {
        all = all.concat(r.items || []);
        P.clear(host).appendChild(runsTable(all, ctx, false));
        P.clear(more);
        more.hidden = false;
        more.appendChild(h('span', { text: P.n(all.length) + ' of ' + P.n(r.totalItems || 0) + ' runs' }));
        if (page < (r.totalPages || 1)) more.appendChild(h('button', { type: 'button', class: 'ui-btn sm', text: 'Show more', on: { click: function () { page++; load(); } } }));
      }).catch(function (e) { if (e.name !== 'AbortError') P.clear(host).appendChild(errorBox(e, load)); });
    }
    load();
    return { dispose: function () { ac.abort(); } };
  }

  /* ---------- drawer (row details) ---------- */
  var dr = null;
  function drawerEl() {
    if (dr) return dr;
    var title = h('h3', { id: 'pt-drawer-t' }), sub = h('p'), content = h('div', { class: 'pt-drawer-b' });
    var prev = h('button', { type: 'button', class: 'ui-btn icon sm ghost', 'aria-label': 'Previous row', title: 'Previous row (↑)' }, icon('up'));
    var next = h('button', { type: 'button', class: 'ui-btn icon sm ghost', 'aria-label': 'Next row', title: 'Next row (↓)' }, icon('down'));
    var copyB = h('button', { type: 'button', class: 'ui-btn icon sm ghost', 'aria-label': 'Copy row as JSON', title: 'Copy row as JSON' }, icon('copy'));
    var close = h('button', { type: 'button', class: 'ui-btn icon ghost', 'aria-label': 'Close', title: 'Close (Esc)' }, icon('x'));
    var section = h('section', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pt-drawer-t', tabindex: '-1' },
      h('header', null, h('div', null, title, sub), h('div', { class: 'ui-drawer-act' }, prev, next, copyB), close), content);
    var el = h('div', { class: 'ui-drawer pt-drawer', hidden: true }, section);
    document.body.appendChild(el);
    dr = { el: el, section: section, title: title, sub: sub, content: content, prev: prev, next: next, copy: copyB, close: close, cfg: null, rec: null, ac: null };
    el.addEventListener('mousedown', function (e) { if (e.target === el) closeDrawer(); });
    close.addEventListener('click', closeDrawer);
    prev.addEventListener('click', function () { if (dr.cfg && dr.cfg.prev) dr.cfg.prev(); });
    next.addEventListener('click', function () { if (dr.cfg && dr.cfg.next) dr.cfg.next(); });
    copyB.addEventListener('click', function () {
      if (!dr.rec || !dr.cfg.copy) return;
      P.copy(dr.cfg.copy(dr.rec)).then(function () { P.toast('Copied'); }, function () { P.toast('Copy is not available here'); });
    });
    document.addEventListener('keydown', function (e) {
      if (el.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); }
      else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName)) {
        var fn = e.key === 'ArrowUp' ? dr.cfg && dr.cfg.prev : dr.cfg && dr.cfg.next;
        if (fn) { e.preventDefault(); fn(); }
      }
    });
    return dr;
  }
  function openDrawer(cfg) {
    var d = drawerEl();
    if (d.ac) d.ac.abort();
    d.ac = new AbortController();
    d.cfg = cfg; d.rec = null;
    d.title.textContent = cfg.title || '';
    d.sub.textContent = cfg.sub || '';
    d.prev.disabled = !cfg.prev; d.next.disabled = !cfg.next; d.copy.disabled = true;
    P.clear(d.content).appendChild(loading());
    var wasHidden = d.el.hidden;
    d.el.hidden = false;
    if (wasHidden) d.close.focus();
    var my = d.ac;
    cfg.load(my.signal).then(function (rec) {
      if (d.ac !== my) return;
      d.rec = rec;
      d.copy.disabled = false;
      P.clear(d.content);
      P.add(d.content, cfg.body(rec));
    }).catch(function (e) {
      if (e.name === 'AbortError' || d.ac !== my) return;
      P.clear(d.content).appendChild(errorBox(e));
    });
  }
  function closeDrawer() {
    if (!dr || dr.el.hidden) return;
    if (dr.ac) dr.ac.abort();
    dr.el.hidden = true;
    var cb = dr.cfg && dr.cfg.onClose;
    dr.cfg = null; dr.rec = null;
    P.clear(dr.content);
    if (cb) cb();
  }

  P.views = { overview: overview, dataset: dataset,
    _: { head: head, panel: panel, relTime: relTime, srcLink: srcLink, table: table, loading: loading, errorBox: errorBox } };
  P.drawer = { open: openDrawer, close: closeDrawer, isOpen: function () { return !!dr && !dr.el.hidden; } };
})(window);
