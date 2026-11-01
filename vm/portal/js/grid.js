/* Data tab: a server-paginated grid over one ds_<key> collection.
 * Sort by header, a filter builder (PocketBase filter syntax, escaped in core.js), search over
 * text columns, column show/hide, typed cells, a row drawer and CSV export of the current filter.
 * Grid state (page, sort, filters) lives in memory for the session; nothing is stored but the
 * hidden-column list (sessionStorage).
 */
(function (w) {
  'use strict';
  var P = w.Portal = w.Portal || {};
  var h = P.h, icon = P.icon;
  var STATE = {};
  var PAGE_SIZES = [50, 100, 200, 500];
  var MAX_FILTER = 3400; // PocketBase rejects filters longer than 3500 characters

  /* ---------- popovers (fixed, so panels never clip them) ---------- */
  var openPop = null;
  function closePop() { if (openPop) { var p = openPop; openPop = null; p.el.remove(); if (p.btn) p.btn.setAttribute('aria-expanded', 'false'); if (p.onClose) p.onClose(); } }
  function popover(btn, content, opts) {
    closePop();
    var el = h('div', { class: 'pt-pop' + (opts && opts.cls ? ' ' + opts.cls : ''), role: 'dialog', 'aria-label': (opts && opts.label) || null }, content);
    document.body.appendChild(el);
    var r = btn.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    var pw = el.offsetWidth, ph = el.offsetHeight;
    var left = Math.min(Math.max(8, r.right - pw), vw - pw - 8);
    var top = r.bottom + 6;
    if (top + ph > vh - 8 && r.top - ph - 6 > 8) top = r.top - ph - 6;
    el.style.left = Math.max(8, left) + 'px';
    el.style.top = Math.max(8, top) + 'px';
    btn.setAttribute('aria-expanded', 'true');
    openPop = { el: el, btn: btn, onClose: opts && opts.onClose };
    var first = el.querySelector('input, select, button');
    if (first) first.focus();
    return el;
  }
  document.addEventListener('mousedown', function (e) {
    if (openPop && !openPop.el.contains(e.target) && !(openPop.btn && openPop.btn.contains(e.target))) closePop();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && openPop) { var b = openPop.btn; closePop(); if (b) b.focus(); e.stopPropagation(); }
  }, true);
  w.addEventListener('resize', closePop);

  /* ---------- cells ---------- */
  // A column's value in a record. PocketBase stores an empty number as 0 and an empty yes/no as
  // false; the sync lists those fields in the record's _nulls, and they show as empty here.
  function val(r, c) {
    var n = r && r._nulls;
    return n && n.length && n.indexOf(c.name) >= 0 ? null : r[c.name];
  }
  function emptyCell(td) { td.classList.add('pt-nil'); td.textContent = '—'; return td; }
  function cell(c, v) {
    var td = document.createElement('td');
    if (c.type === 'number') {
      td.className = 'num';
      if (v == null || v === '') return emptyCell(td);
      td.textContent = P.num(v, c.name);
      return td;
    }
    if (c.type === 'date') {
      td.className = 't-date';
      if (!v) return emptyCell(td);
      if (!P.isDateOnly(v)) c.hasTime = true;
      td.textContent = P.dateVal(v);
      td.title = String(v);
      return td;
    }
    if (c.type === 'bool') {
      td.className = 't-bool' + (v ? ' on' : '');
      td.textContent = v === true ? 'Yes' : v === false ? 'No' : (v == null || v === '' ? '—' : String(v));
      return td;
    }
    if (c.type === 'json') {
      td.className = 't-json';
      if (v == null || v === '') return emptyCell(td);
      td.textContent = P.jsonPreview(v);
      var full = P.jsonPretty(v);
      td.title = full.length > 600 ? full.slice(0, 600) + '…' : full;
      return td;
    }
    if (v == null || v === '') return emptyCell(td);
    var s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    td.textContent = s;
    if (s.length > 30) td.title = s.length > 600 ? s.slice(0, 600) + '…' : s;
    return td;
  }
  function fullValue(c, v) {
    if (v == null || v === '') return h('span', { class: 'pt-nil', text: '—' });
    if (c.type === 'json' || (typeof v === 'object')) return h('pre', { class: 'pt-json', text: P.jsonPretty(v) });
    if (c.type === 'number') return h('span', { title: String(v), text: P.num(v, c.name) });
    if (c.type === 'date') return h('span', { title: String(v) }, P.dateVal(v), P.isDateOnly(v) ? null : h('small', { class: 'pt-sub', text: ' ' + String(v) }));
    if (c.type === 'bool') return v === true ? 'Yes' : v === false ? 'No' : String(v);
    return h('span', { class: 'pt-pre', text: String(v) });
  }

  /* ---------- CSV ---------- */
  function csvVal(c, v) {
    if (v == null) return '';
    if (c.type === 'json') return v === '' ? '' : JSON.stringify(v);
    if (c.type === 'bool') return v === true ? 'true' : v === false ? 'false' : String(v);
    if (c.type === 'date') {
      if (!v) return '';
      if (P.isDateOnly(v)) return String(v).slice(0, 10);
      var d = P.pbDate(v);
      return d ? d.toISOString().replace('.000Z', 'Z') : String(v);
    }
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  // Text that a spreadsheet would run as a formula gets a leading apostrophe.
  function csvCell(s, isText) {
    s = s == null ? '' : String(s);
    if (isText && /^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function stamp() { var d = new Date(), t = function (x) { return (x < 10 ? '0' : '') + x; }; return d.getFullYear() + t(d.getMonth() + 1) + t(d.getDate()) + '-' + t(d.getHours()) + t(d.getMinutes()); }

  /* ---------- the grid ---------- */
  function mount(host, ds, ctx) {
    var key = ds.key, coll = ds.collection;
    var cols = P.columns(ds);
    var st = STATE[key] || (STATE[key] = { page: 1, perPage: 100, sort: null, filters: [], q: '' });
    var hidden = {};
    (P.pref('cols_' + key) || []).forEach(function (n) { hidden[n] = 1; });
    var items = [], total = 0, totalPages = 1, seq = 0, ac = null, exporting = null, disposed = false, sel = -1, searchNote = '', lastError = null;

    var byName = {};
    function index() { byName = {}; cols.forEach(function (c) { byName[c.name] = c; }); }
    index();
    function visible() { return cols.filter(function (c) { return !hidden[c.name]; }); }
    function sysCol(name) { for (var i = 0; i < P.SYSTEM_FIELDS.length; i++) if (P.SYSTEM_FIELDS[i].name === name) return { name: name, source_name: name, type: P.SYSTEM_FIELDS[i].type, system: true }; return null; }
    function colOf(name) { return byName[name] || sysCol(name); }

    /* toolbar */
    var qInput = h('input', { class: 'ui-input', type: 'search', placeholder: 'Search text columns', 'aria-label': 'Search text columns', autocomplete: 'off', spellcheck: 'false', value: st.q });
    var filterBtn = h('button', { type: 'button', class: 'ui-btn sm', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, icon('filter'), h('span', { text: 'Filter' }));
    var colsBtn = h('button', { type: 'button', class: 'ui-btn sm', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, icon('columns'), h('span', { class: 'pt-cols-l', text: 'Columns' }));
    var exportBtn = h('button', { type: 'button', class: 'ui-btn sm', title: 'Download the rows that match the current filters (shown columns) as CSV' }, icon('download'), h('span', { class: 'pt-exp-l', text: 'Export CSV' }));
    var summary = h('span', { class: 'pt-summary', 'aria-live': 'polite' });
    var chips = h('div', { class: 'pt-chips', hidden: true });
    var note = h('div', { class: 'pt-note', hidden: true });
    var thead = h('thead'), tbody = h('tbody');
    var table = h('table', { class: 'ui-table pt-table' }, thead, tbody);
    var wrap = h('div', { class: 'ui-table-wrap pt-grid', tabindex: '-1' }, table);
    var pager = h('div', { class: 'ui-panel-f pt-pager' });
    var panel = h('section', { class: 'ui-panel pt-data', 'aria-label': 'Rows' },
      h('div', { class: 'ui-panel-h pt-toolbar' },
        h('div', { class: 'ui-search pt-q' }, icon('search'), qInput),
        h('div', { class: 'pt-tools' }, filterBtn, colsBtn, exportBtn),
        summary),
      chips, note, h('div', { class: 'pt-progress', 'aria-hidden': 'true' }), wrap, pager);
    host.appendChild(panel);

    qInput.addEventListener('input', P.debounce(function () { st.q = qInput.value; st.page = 1; fetchPage(); }, 300));
    filterBtn.addEventListener('click', function () { if (openPop && openPop.btn === filterBtn) closePop(); else filterPop(null); });
    colsBtn.addEventListener('click', function () { if (openPop && openPop.btn === colsBtn) closePop(); else colsPop(); });
    exportBtn.addEventListener('click', exportCsv);

    /* filters → PocketBase filter text */
    function build() {
      var parts = [];
      st.filters.forEach(function (f) { try { parts.push('(' + P.clause(f) + ')'); } catch (e) {} });
      searchNote = '';
      var sq = st.q.trim();
      if (sq) {
        var textCols = cols.filter(function (c) { return c.type === 'text'; });
        var x = Number(sq.replace(/,/g, ''));
        var numCols = /^-?[\d,]+(\.\d+)?$/.test(sq) && isFinite(x) ? cols.filter(function (c) { return c.type === 'number'; }) : [];
        var base = parts.join(' && ').length, ors = [], usedText = 0;
        var pieces = textCols.map(function (c) { return { text: true, s: c.name + ' ~ ' + P.q('%' + P.likeEsc(sq) + '%') }; })
          .concat(numCols.map(function (c) { return { s: c.name + ' = ' + String(x) }; }));
        for (var i = 0; i < pieces.length; i++) {
          if (base + ors.join(' || ').length + pieces[i].s.length + 12 > MAX_FILTER) break;
          ors.push(pieces[i].s);
          if (pieces[i].text) usedText++;
        }
        if (!textCols.length && !numCols.length) searchNote = 'This dataset has no text columns to search.';
        else if (!ors.length) searchNote = 'The search text is too long.';
        else if (usedText < textCols.length) searchNote = 'Search covers the first ' + usedText + ' of ' + textCols.length + ' text columns.';
        parts.push(ors.length ? '(' + ors.join(' || ') + ')' : "id = ''");
      }
      return parts.join(' && ');
    }
    function sortParam() {
      if (!st.sort) return '_row_no';
      return (st.sort.dir === 'desc' ? '-' : '') + st.sort.field + (st.sort.field !== '_row_no' ? ',_row_no' : '');
    }
    // Only the shown columns travel; with no column list yet, fetch whole records to learn them.
    function fieldsParam(list) { return cols.length ? ['id', '_row_no', '_nulls'].concat(list.map(function (c) { return c.name; })).join(',') : null; }
    function isFiltered() { return st.filters.length > 0 || !!st.q.trim(); }

    /* fetch */
    function fetchPage() {
      if (disposed) return;
      if (ac) ac.abort();
      ac = new AbortController();
      var my = ++seq;
      panel.classList.add('busy');
      lastError = null;
      P.api.list(coll, { page: st.page, perPage: st.perPage, sort: sortParam(), filter: build(), fields: fieldsParam(visible()) }, ac.signal).then(function (r) {
        if (my !== seq || disposed) return;
        items = r.items || [];
        total = r.totalItems || 0;
        totalPages = Math.max(1, r.totalPages || 1);
        if (st.page > totalPages && total > 0) { st.page = totalPages; fetchPage(); return; }
        if (!cols.length && items.length) { inferCols(items[0]); }
        sel = -1;
        render();
      }).catch(function (e) {
        if (my !== seq || disposed || (e && e.name === 'AbortError')) return;
        items = []; total = 0; totalPages = 1; lastError = e;
        render();
      }).then(function () { if (my === seq) panel.classList.remove('busy'); });
    }
    // A dataset whose registry row has no column list yet: use the record's own keys.
    function inferCols(rec) {
      var skip = { id: 1, collectionId: 1, collectionName: 1, created: 1, updated: 1, expand: 1, _row_key: 1, _row_no: 1, _synced_at: 1, _hash: 1, _nulls: 1 };
      cols = Object.keys(rec).filter(function (k) { return !skip[k] && k.indexOf('_stage_') !== 0 && P.IDENT.test(k); }).map(function (k) {
        var v = rec[k];
        return { name: k, source_name: k, type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : v && typeof v === 'object' ? 'json' : 'text' };
      });
      index();
    }

    /* render */
    function render() {
      renderChips();
      note.hidden = !searchNote;
      note.textContent = searchNote;
      renderHead();
      renderBody();
      renderPager();
      var vis = visible().length;
      colsBtn.querySelector('.pt-cols-l').textContent = vis < cols.length ? 'Columns ' + vis + '/' + cols.length : 'Columns';
      filterBtn.querySelector('span').textContent = st.filters.length ? 'Filter · ' + st.filters.length : 'Filter';
      filterBtn.classList.toggle('on', st.filters.length > 0);
      summary.textContent = lastError ? '' : isFiltered() ? P.n(total) + ' of ' + P.n(ds.row_count || 0) + ' rows' : P.n(total) + ' rows';
    }
    function renderHead() {
      P.clear(thead);
      var tr = h('tr');
      var rn = h('th', { class: 'rn num', scope: 'col' });
      rn.appendChild(sortButton({ name: '_row_no', source_name: '#', type: 'number' }));
      tr.appendChild(rn);
      visible().forEach(function (c) {
        var on = st.sort && st.sort.field === c.name;
        var th = h('th', { scope: 'col', class: c.type === 'number' ? 'num' : null, 'aria-sort': on ? (st.sort.dir === 'asc' ? 'ascending' : 'descending') : null });
        th.appendChild(sortButton(c));
        tr.appendChild(th);
      });
      thead.appendChild(tr);
    }
    function sortButton(c) {
      var on = st.sort ? st.sort.field === c.name : c.name === '_row_no';
      var dir = st.sort ? st.sort.dir : 'asc';
      var b = h('button', { type: 'button', class: 'pt-th' + (on ? ' on' : ''), title: c.name === '_row_no' ? 'Row number in the source' : c.name + ' · ' + c.type, on: { click: function () { sortBy(c.name); } } },
        h('span', { text: c.source_name }),
        on ? icon(dir === 'asc' ? 'up' : 'down', 'pt-sort-i') : null);
      return b;
    }
    function sortBy(field) {
      if (!st.sort || st.sort.field !== field) st.sort = { field: field, dir: 'asc' };
      else if (st.sort.dir === 'asc') st.sort = { field: field, dir: 'desc' };
      else st.sort = null;
      if (st.sort && st.sort.field === '_row_no' && st.sort.dir === 'asc') st.sort = null;
      st.page = 1;
      fetchPage();
    }
    function renderBody() {
      P.clear(tbody);
      var vis = visible(), span = vis.length + 1;
      if (lastError) {
        var msg = lastError.status === 404 ? 'This dataset has no collection in PocketBase yet. It appears after its first successful sync.'
          : lastError.status === 403 ? 'This account cannot read this dataset.'
          : lastError.status === 400 ? 'PocketBase could not run this query: ' + (lastError.message || 'bad request') + '.'
          : 'Could not load rows: ' + (lastError.message || 'network error') + '.';
        tbody.appendChild(h('tr', null, h('td', { colspan: span }, h('div', { class: 'ui-empty' }, h('p', { text: msg }),
          lastError.status === 404 ? null : h('button', { type: 'button', class: 'ui-btn sm', text: 'Try again', on: { click: fetchPage } })))));
        return;
      }
      if (!items.length) {
        tbody.appendChild(h('tr', null, h('td', { colspan: span }, h('div', { class: 'ui-empty' },
          h('p', { text: isFiltered() ? 'No rows match these filters.' : 'This dataset has no rows.' }),
          isFiltered() ? h('button', { type: 'button', class: 'ui-btn sm', text: 'Clear filters', on: { click: clearAll } }) : null))));
        return;
      }
      var frag = document.createDocumentFragment();
      items.forEach(function (r, i) {
        var tr = h('tr', { class: 'click' + (i === sel ? ' sel' : ''), tabindex: '0', dataset: { i: i } });
        var rn = h('td', { class: 'rn num', text: r._row_no != null && r._row_no !== '' ? P.n(r._row_no) : '' });
        tr.appendChild(rn);
        vis.forEach(function (c) { tr.appendChild(cell(c, val(r, c))); });
        frag.appendChild(tr);
      });
      tbody.appendChild(frag);
    }
    tbody.addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-i]');
      if (tr) openRow(+tr.dataset.i);
    });
    tbody.addEventListener('keydown', function (e) {
      var tr = e.target.closest('tr[data-i]');
      if (!tr) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRow(+tr.dataset.i); }
      else if (e.key === 'ArrowDown' && tr.nextElementSibling) { e.preventDefault(); tr.nextElementSibling.focus(); }
      else if (e.key === 'ArrowUp' && tr.previousElementSibling) { e.preventDefault(); tr.previousElementSibling.focus(); }
    });

    function renderPager() {
      P.clear(pager);
      var from = total ? (st.page - 1) * st.perPage + 1 : 0, to = Math.min(total, st.page * st.perPage);
      var size = h('select', { 'aria-label': 'Rows per page' });
      PAGE_SIZES.forEach(function (s) { size.appendChild(h('option', { value: String(s), text: s + ' / page', selected: s === st.perPage })); });
      size.addEventListener('change', function () { st.perPage = +size.value; st.page = 1; fetchPage(); });
      var pageIn = h('input', { class: 'ui-input pt-page-in', type: 'number', min: '1', max: String(totalPages), value: String(st.page), 'aria-label': 'Page' });
      pageIn.addEventListener('change', function () { var p = Math.round(+pageIn.value); go(isFinite(p) ? p : st.page); });
      var nav = function (ic, label, page, dis) { return h('button', { type: 'button', class: 'ui-btn icon sm ghost', 'aria-label': label, title: label, disabled: dis, on: { click: function () { go(page); } } }, icon(ic)); };
      pager.appendChild(h('span', { class: 'pt-range', text: total ? P.n(from) + '–' + P.n(to) + ' of ' + P.n(total) : lastError ? '' : '0 rows' }));
      pager.appendChild(h('div', { class: 'pt-pages' },
        h('span', { class: 'ui-select pt-size' }, size),
        nav('first', 'First page', 1, st.page <= 1),
        nav('chev-l', 'Previous page', st.page - 1, st.page <= 1),
        h('label', { class: 'pt-page-l' }, h('span', { class: 'pt-hide-xs', text: 'Page' }), pageIn, h('span', { text: 'of ' + P.n(totalPages) })),
        nav('chev', 'Next page', st.page + 1, st.page >= totalPages),
        nav('last', 'Last page', totalPages, st.page >= totalPages)));
    }
    function go(p) {
      p = Math.max(1, Math.min(totalPages, p));
      if (p === st.page) { renderPager(); return; }
      st.page = p; fetchPage();
      wrap.scrollTop = 0;
    }

    /* filter chips + builder */
    function renderChips() {
      P.clear(chips);
      chips.hidden = !st.filters.length;
      st.filters.forEach(function (f, i) {
        var c = colOf(f.field) || { source_name: f.field };
        var val = P.NO_VALUE[f.op] ? '' : f.type === 'date' ? (f.op === 'between' ? f.value + ' – ' + f.value2 : f.value) : f.value;
        chips.appendChild(h('span', { class: 'pt-chip' },
          h('button', { type: 'button', class: 'pt-chip-b', title: 'Edit filter', on: { click: function (e) { filterPop(i, e.currentTarget); } } },
            h('b', { text: c.source_name }), ' ', h('span', { text: P.opLabel(f.type, f.op) }), val !== '' ? ' ' : null, val !== '' ? h('i', { text: val }) : null),
          h('button', { type: 'button', class: 'pt-chip-x', 'aria-label': 'Remove filter', title: 'Remove', on: { click: function () { st.filters.splice(i, 1); st.page = 1; fetchPage(); } } }, icon('x'))));
      });
      if (st.filters.length > 1) chips.appendChild(h('button', { type: 'button', class: 'ui-btn ghost sm', text: 'Clear all', on: { click: clearAll } }));
    }
    function clearAll() { st.filters = []; st.q = ''; qInput.value = ''; st.page = 1; fetchPage(); }

    function filterPop(editIndex, anchor) {
      var f = editIndex != null ? Object.assign({}, st.filters[editIndex]) : null;
      var colSel = h('select', { 'aria-label': 'Column' });
      var g1 = h('optgroup', { label: 'Columns' }), g2 = h('optgroup', { label: 'System' });
      cols.forEach(function (c) { g1.appendChild(h('option', { value: c.name, text: c.source_name + (c.source_name !== c.name ? '  (' + c.name + ')' : '') })); });
      ['_row_no', '_row_key', '_synced_at', 'id'].forEach(function (n) { g2.appendChild(h('option', { value: n, text: n })); });
      colSel.appendChild(g1); colSel.appendChild(g2);
      if (f) colSel.value = f.field;
      var opSel = h('select', { 'aria-label': 'Condition' });
      var valBox = h('div', { class: 'pt-fval' });
      var err = h('p', { class: 'pt-err', role: 'alert', hidden: true });
      var v1, v2;
      function typeOf() { var c = colOf(colSel.value); return c ? c.type : 'text'; }
      function fillOps(keepOp) {
        var t = typeOf();
        P.clear(opSel);
        (P.OPS[t] || P.OPS.text).forEach(function (o) { opSel.appendChild(h('option', { value: o[0], text: o[1] })); });
        if (keepOp && [].some.call(opSel.options, function (o) { return o.value === keepOp; })) opSel.value = keepOp;
        fillValue();
      }
      function fillValue() {
        var t = typeOf(), op = opSel.value;
        var keep1 = v1 ? v1.value : f ? f.value : '', keep2 = v2 ? v2.value : f ? f.value2 : '';
        P.clear(valBox); v1 = v2 = null;
        if (P.NO_VALUE[op]) { valBox.hidden = true; return; }
        valBox.hidden = false;
        var type = t === 'date' ? 'date' : t === 'number' ? 'text' : 'text';
        v1 = h('input', { class: 'ui-input', type: type, inputmode: t === 'number' ? 'decimal' : null, 'aria-label': 'Value', placeholder: t === 'number' ? 'Number' : t === 'date' ? null : 'Value', value: keep1 || '' });
        valBox.appendChild(v1);
        if (t === 'date' && op === 'between') {
          v2 = h('input', { class: 'ui-input', type: 'date', 'aria-label': 'End date', value: keep2 || '' });
          valBox.appendChild(h('span', { class: 'pt-and', text: 'and' }));
          valBox.appendChild(v2);
        }
        v1.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
        if (v2) v2.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
      }
      colSel.addEventListener('change', function () { v1 = v2 = null; f = null; fillOps(); });
      opSel.addEventListener('change', fillValue);
      fillOps(f && f.op);
      function apply() {
        var c = colOf(colSel.value);
        if (!c) return;
        var nf = { field: c.name, type: c.type, op: opSel.value, value: v1 ? v1.value.trim() : '', value2: v2 ? v2.value.trim() : '', local: !!c.hasTime };
        try { P.clause(nf); } catch (e) { err.textContent = e.message; err.hidden = false; return; }
        if (editIndex != null) st.filters[editIndex] = nf; else st.filters.push(nf);
        if (build().length > MAX_FILTER) { if (editIndex == null) st.filters.pop(); err.textContent = 'Too many filters for one query. Remove one first.'; err.hidden = false; return; }
        closePop();
        st.page = 1;
        fetchPage();
      }
      var content = h('div', { class: 'pt-fb' },
        h('h4', { text: editIndex != null ? 'Edit filter' : 'Add filter' }),
        h('span', { class: 'ui-select' }, colSel),
        h('span', { class: 'ui-select' }, opSel),
        valBox, err,
        h('div', { class: 'pt-pop-f' },
          h('button', { type: 'button', class: 'ui-btn sm ghost', text: 'Cancel', on: { click: closePop } }),
          h('button', { type: 'button', class: 'ui-btn sm primary', text: editIndex != null ? 'Apply' : 'Add filter', on: { click: apply } })));
      popover(anchor || filterBtn, content, { label: 'Filter rows' });
    }

    /* columns */
    function colsPop() {
      var list = h('div', { class: 'pt-cols' });
      var search = cols.length > 10 ? h('input', { class: 'ui-input', type: 'search', placeholder: 'Find a column', 'aria-label': 'Find a column' }) : null;
      function draw() {
        P.clear(list);
        var s = search ? search.value.trim().toLowerCase() : '';
        cols.forEach(function (c) {
          if (s && c.source_name.toLowerCase().indexOf(s) < 0 && c.name.indexOf(s) < 0) return;
          var cb = h('input', { type: 'checkbox', checked: !hidden[c.name] });
          cb.addEventListener('change', function () {
            if (cb.checked) delete hidden[c.name]; else hidden[c.name] = 1;
            if (!visible().length) { delete hidden[c.name]; cb.checked = true; P.toast('Keep at least one column.'); return; }
            saveHidden(); fetchPage();
          });
          list.appendChild(h('label', { class: 'pt-check' }, cb, h('span', { text: c.source_name }), h('small', { text: c.type })));
        });
        if (!list.firstChild) list.appendChild(h('p', { class: 'ui-note pt-pad', text: 'No column matches.' }));
      }
      if (search) search.addEventListener('input', draw);
      draw();
      var setAll = function (show) { cols.forEach(function (c, i) { if (show || i === 0) delete hidden[c.name]; else hidden[c.name] = 1; }); saveHidden(); draw(); fetchPage(); };
      popover(colsBtn, h('div', { class: 'pt-colpop' }, h('h4', { text: 'Columns' }), search, list,
        h('div', { class: 'pt-pop-f' },
          h('button', { type: 'button', class: 'ui-btn sm ghost', text: 'Show all', on: { click: function () { setAll(true); } } }),
          h('button', { type: 'button', class: 'ui-btn sm ghost', text: 'Hide all', on: { click: function () { setAll(false); } } }))), { label: 'Choose columns', cls: 'wide' });
    }
    function saveHidden() { var l = Object.keys(hidden); P.pref('cols_' + key, l.length ? l : null); }

    /* row drawer */
    function openRow(i) {
      if (!items[i]) return;
      sel = i;
      [].forEach.call(tbody.querySelectorAll('tr.sel'), function (tr) { tr.classList.remove('sel'); });
      var tr = tbody.querySelector('tr[data-i="' + i + '"]');
      if (tr) tr.classList.add('sel');
      P.drawer.open({
        title: 'Row ' + (items[i]._row_no != null ? P.n(items[i]._row_no) : i + 1),
        sub: coll,
        load: function (signal) { return P.api.one(coll, items[i].id, signal); },
        body: function (rec) { return rowBody(rec); },
        copy: function (rec) { return JSON.stringify(rec, null, 2); },
        prev: i > 0 ? function () { openRow(i - 1); } : (st.page > 1 ? function () { P.drawer.close(); go(st.page - 1); } : null),
        next: i < items.length - 1 ? function () { openRow(i + 1); } : (st.page < totalPages ? function () { P.drawer.close(); go(st.page + 1); } : null),
        onClose: function () { var t = tbody.querySelector('tr[data-i="' + i + '"]'); if (t) t.focus({ preventScroll: true }); }
      });
    }
    function rowBody(rec) {
      var dl = h('dl', { class: 'ui-dl pt-dl' });
      var known = {};
      cols.forEach(function (c) {
        known[c.name] = 1;
        dl.appendChild(h('dt', null, h('span', { text: c.source_name }), c.source_name !== c.name ? h('small', { class: 'pt-fname', text: c.name }) : null));
        dl.appendChild(h('dd', null, fullValue(c, val(rec, c))));
      });
      var sysNames = { id: 1, _row_key: 1, _row_no: 1, _synced_at: 1, _hash: 1, _nulls: 1, collectionId: 1, collectionName: 1, created: 1, updated: 1, expand: 1 };
      Object.keys(rec).forEach(function (k) {
        if (known[k] || sysNames[k] || k.indexOf('_stage_') === 0) return; // _stage_: a type change in progress
        dl.appendChild(h('dt', null, h('span', { text: k })));
        dl.appendChild(h('dd', null, fullValue({ name: k, type: typeof rec[k] === 'object' ? 'json' : 'text' }, rec[k])));
      });
      var sys = h('dl', { class: 'ui-dl pt-dl pt-sys' });
      ['id', '_row_key', '_row_no', '_synced_at', '_hash', '_nulls', 'created', 'updated', 'collectionName'].forEach(function (k) {
        if (!(k in rec)) return;
        var v = k === '_nulls' ? (rec[k] && rec[k].length ? rec[k].join(', ') : '') : rec[k];
        sys.appendChild(h('dt', { text: k }));
        sys.appendChild(h('dd', { class: 'pt-mono' }, v === '' || v == null ? '—' : k === '_synced_at' || k === 'created' || k === 'updated' ? P.dateTime(v) + '  ·  ' + v : String(v)));
      });
      return [dl, h('h4', { class: 'pt-drawer-h', text: 'System fields' }), sys];
    }

    /* export */
    // Custom sort: plain pages. Source order: walk by (_row_no, id) instead of page offsets, so the
    // last pages of a large table cost PocketBase as little as the first.
    function exportPages(vis, onPage, signal) {
      var filter = build(), fields = fieldsParam(vis);
      if (st.sort) return P.api.all(coll, { sort: sortParam(), filter: filter, fields: fields }, onPage, signal);
      var got = 0, last = null;
      function next() {
        var f = filter;
        if (last) {
          var k = '(_row_no > ' + last.n + ' || (_row_no = ' + last.n + ' && id > ' + P.q(last.id) + '))';
          f = f ? '(' + f + ') && ' + k : k;
        }
        return P.api.list(coll, { page: 1, perPage: 1000, sort: '_row_no,id', filter: f, fields: fields, skipTotal: true }, signal).then(function (r) {
          var items = (r && r.items) || [];
          got += items.length;
          if (!items.length) return got;
          var tail = items[items.length - 1];
          last = { n: Number(tail._row_no) || 0, id: String(tail.id) };
          if (onPage(items, got) === false || items.length < 1000) return got;
          return next();
        });
      }
      return next();
    }
    function exportCsv() {
      if (exporting) { exporting.abort(); return; }
      if (!total) { P.toast('Nothing to export.'); return; }
      var exp = new AbortController(); exporting = exp;
      var vis = visible(), label = exportBtn.querySelector('.pt-exp-l');
      var lines = [vis.map(function (c) { return csvCell(c.source_name, true); }).join(',')];
      exportBtn.classList.add('on');
      label.textContent = 'Exporting…';
      exportBtn.title = 'Click to cancel';
      var want = total;
      exportPages(vis, function (rows, got) {
        rows.forEach(function (r) { lines.push(vis.map(function (c) { return csvCell(csvVal(c, val(r, c)), c.type === 'text' || c.type === 'json'); }).join(',')); });
        label.textContent = 'Cancel · ' + Math.min(100, Math.round(got / Math.max(1, want) * 100)) + '%';
        return !exp.signal.aborted;
      }, exp.signal).then(function (got) {
        if (exp.signal.aborted) throw { name: 'AbortError' };
        var blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = key + '-' + stamp() + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
        P.toast('Exported ' + P.n(got) + ' rows');
      }).catch(function (e) {
        P.toast(e && e.name === 'AbortError' ? 'Export cancelled' : 'Export failed: ' + ((e && e.message) || 'error'));
      }).then(function () {
        exporting = null; lines = null;
        exportBtn.classList.remove('on');
        label.textContent = 'Export CSV';
        exportBtn.title = 'Download the rows that match the current filters (shown columns) as CSV';
      });
    }

    fetchPage();
    return {
      reload: fetchPage,
      dispose: function () { disposed = true; if (ac) ac.abort(); if (exporting) exporting.abort(); closePop(); }
    };
  }

  P.grid = { mount: mount, closePop: closePop };
})(window);
