/* Data editor: the sheet grid and the review-and-save dialog (docs/data-editor.md).
 *
 * Rows come from the server 100 at a time as they scroll into view (datasets reach 290,000 rows); only
 * the visible rows are in the DOM. Changes stay on this page, highlighted, until Review and save: the
 * server then checks them (types, keys, permissions, conflicts) and applies them as one batch.
 */
(function (w) {
  'use strict';
  var Ed = w.Ed;
  var h = Ed.h;
  var ROW_H = 28;
  var HEAD_H = 40;
  var RN_W = 58;
  var BLOCK = 100;
  var MAX_BLOCKS = 80;
  var MAX_PASTE = 5000;

  function colWidth(c) {
    var base = Math.max(c.type === 'number' ? 96 : 110, Math.min(260, String(c.label || c.name).length * 7.2 + 26));
    return Math.round(base);
  }
  function tsvCell(v) {
    var s = String(v == null ? '' : v);
    return /[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function narrow() { return w.matchMedia && w.matchMedia('(max-width: 760px)').matches; }

  function Grid(host, opts) {
    this.host = host;
    this.ds = opts.ds;
    this.rights = opts.rights;
    this.native = opts.ds.mode === 'native';
    this.cols = opts.ds.columns;
    this.widths = this.cols.map(colWidth);
    this.lefts = [];
    var x = RN_W;
    for (var i = 0; i < this.widths.length; i++) { this.lefts.push(x); x += this.widths[i]; }
    this.totalW = x;
    this.onChange = opts.onChange || function () {};
    this.onStatus = opts.onStatus || function () {};
    this.query = { filters: [], q: '', sort: '' };
    this.total = 0;
    this.blocks = new Map();
    this.gen = 0;
    this.edits = new Map();  // id → { hash, base: cells[], cells: Map(col → value) }
    this.dels = new Map();   // id → { hash, base }
    this.adds = [];          // [{ tmp, cells: [] }]
    this.undoStack = [];
    this.tmpSeq = 0;
    this.sel = { ar: 0, ac: 0, fr: 0, fc: 0 };
    this.editing = null;
    this.build();
    this.reload();
  }

  var G = Grid.prototype;

  /* ---------- DOM ---------- */
  G.build = function () {
    var self = this;
    Ed.clear(this.host);
    this.scroll = h('div', { class: 'ed-grid', role: 'grid', 'aria-label': this.ds.label, 'aria-rowcount': '0', 'aria-colcount': String(this.cols.length) });
    this.sizer = h('div', { class: 'ed-sizer', style: 'width:' + this.totalW + 'px' });
    this.head = h('div', { class: 'ed-hrow', role: 'row', style: 'width:' + this.totalW + 'px' });
    this.head.appendChild(h('div', { class: 'ed-c ed-rn', style: 'width:' + RN_W + 'px', role: 'columnheader' }, h('span', { class: 'l', text: '#' })));
    this.cols.forEach(function (c, ci) {
      var cell = h('div', { class: 'ed-c', role: 'columnheader', 'data-c': String(ci), style: 'width:' + self.widths[ci] + 'px', title: (c.label || c.name) + ' · ' + c.name + ' · ' + c.type + (c.dateOrder ? ' (' + c.dateOrder + ')' : '') + '. Click to sort.' },
        h('span', { class: 'l', text: c.label || c.name }), h('span', { class: 'ty', text: c.type + (c.type === 'date' && c.dateOrder === 'mdy' ? ' m/d' : '') }));
      cell.addEventListener('click', function () { self.cycleSort(c.name); });
      self.head.appendChild(cell);
    });
    this.layer = h('div', { style: 'position:relative' });
    this.sizer.appendChild(this.head);
    this.sizer.appendChild(this.layer);
    this.scroll.appendChild(this.sizer);
    this.sink = h('textarea', { class: 'ed-sink', 'aria-hidden': 'true', tabindex: '-1', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false' });
    this.host.appendChild(this.scroll);
    this.host.appendChild(this.sink);
    var raf = 0;
    this.scroll.addEventListener('scroll', function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; self.paint(); }); });
    this.scroll.addEventListener('mousedown', function (e) { self.onDown(e); });
    this.scroll.addEventListener('dblclick', function (e) { var p = self.cellAt(e); if (p) self.startEdit(null); });
    this.scroll.addEventListener('mouseover', function (e) { if (self.dragging) { var p = self.cellAt(e); if (p) { self.sel.fr = p.r; self.sel.fc = p.c; self.paint(); } } });
    document.addEventListener('mouseup', function () { self.dragging = false; });
    this.sink.addEventListener('keydown', function (e) { self.onKey(e); });
    this.sink.addEventListener('paste', function (e) { e.preventDefault(); self.onPaste(e.clipboardData); });
    this.sink.addEventListener('copy', function (e) { self.onCopy(e); });
    this.sink.addEventListener('cut', function (e) { e.preventDefault(); });
    this.scroll.addEventListener('click', function (e) { if (!self.editing) self.focus(); if (e.detail === 1 && narrow() && self.lastTap && self.lastTap.r === self.sel.fr && self.lastTap.c === self.sel.fc && Date.now() - self.lastTap.at < 1500) self.sheetEdit(); var p = self.cellAt(e); if (p) self.lastTap = { r: p.r, c: p.c, at: Date.now() }; });
    w.addEventListener('resize', function () { self.paint(); });
  };

  G.focus = function () { try { this.sink.focus({ preventScroll: true }); } catch (e) { this.sink.focus(); } };
  G.rowCount = function () { return this.total + this.adds.length; };

  G.cellAt = function (e) {
    var el = e.target.closest ? e.target.closest('.ed-c') : null;
    if (!el || !el.hasAttribute('data-r')) return null;
    return { r: Number(el.getAttribute('data-r')), c: Number(el.getAttribute('data-c')) };
  };

  G.onDown = function (e) {
    if (e.button !== 0) return;
    var p = this.cellAt(e);
    if (!p) return;
    if (this.editing) this.finishEdit(true);
    if (e.shiftKey) { this.sel.fr = p.r; this.sel.fc = p.c; }
    else this.sel = { ar: p.r, ac: p.c, fr: p.r, fc: p.c };
    this.dragging = !narrow();
    e.preventDefault();
    this.focus();
    this.paint();
    this.status();
  };

  /* ---------- Data ---------- */
  G.params = function (offset) {
    var p = new URLSearchParams();
    p.set('offset', String(offset));
    p.set('limit', String(BLOCK));
    if (this.query.q) p.set('q', this.query.q);
    if (this.query.sort) p.set('sort', this.query.sort);
    if (this.query.filters.length) p.set('filters', JSON.stringify(this.query.filters));
    return p;
  };
  G.exportUrl = function () {
    var p = this.params(0);
    p.delete('offset'); p.delete('limit');
    return '/api/editor/datasets/' + encodeURIComponent(this.ds.key) + '/export.csv?' + p.toString();
  };

  G.reload = function () {
    var self = this;
    this.gen++;
    this.blocks.clear();
    var gen = this.gen;
    this.loadError = null;
    return this.fetchBlock(0, gen).then(function () {
      if (gen !== self.gen) return;
      self.scroll.scrollTop = 0;
      self.paint();
      self.status();
    }, function (err) { self.loadError = err; self.paint(); self.status(); });
  };

  G.fetchBlock = function (b, gen) {
    var self = this;
    var have = this.blocks.get(b);
    if (have) return have.promise;
    var entry = { rows: null, promise: null };
    entry.promise = Ed.api('GET', '/datasets/' + encodeURIComponent(this.ds.key) + '/rows?' + this.params(b * BLOCK).toString()).then(function (r) {
      if (gen !== self.gen) return;
      entry.rows = r.rows;
      if (r.total != null) self.total = r.total;
      if (self.blocks.size > MAX_BLOCKS) {
        var vis = Math.floor(self.scroll.scrollTop / ROW_H / BLOCK);
        self.blocks.forEach(function (v, k) { if (Math.abs(k - vis) > MAX_BLOCKS / 2 && v.rows) self.blocks.delete(k); });
      }
      self.paint();
    }, function (err) { self.blocks.delete(b); throw err; });
    this.blocks.set(b, entry);
    return entry.promise;
  };

  /** Make sure rows [from, to) are loaded (for paste and copy). */
  G.ensure = function (from, to) {
    var gen = this.gen;
    var list = [];
    for (var b = Math.floor(from / BLOCK); b * BLOCK < Math.min(to, this.total); b++) list.push(this.fetchBlock(b, gen));
    return Promise.all(list);
  };

  G.srvRow = function (i) {
    var e = this.blocks.get(Math.floor(i / BLOCK));
    return e && e.rows ? e.rows[i % BLOCK] || null : null;
  };

  /** The value shown in row i, column c (with this page's changes), or undefined while loading. */
  G.value = function (i, c) {
    if (i >= this.total) { var a = this.adds[i - this.total]; return a ? a.cells[c] : ''; }
    var r = this.srvRow(i);
    if (!r) return undefined;
    var ed = this.edits.get(r.id);
    if (ed && ed.cells.has(c)) return ed.cells.get(c);
    return r.cells[c];
  };
  G.isDirty = function (i, c) {
    if (i >= this.total) return true;
    var r = this.srvRow(i);
    var ed = r && this.edits.get(r.id);
    return !!(ed && ed.cells.has(c));
  };

  /* ---------- Paint ---------- */
  G.paint = function () {
    var self = this;
    var n = this.rowCount();
    this.sizer.style.height = (HEAD_H + n * ROW_H) + 'px';
    this.scroll.setAttribute('aria-rowcount', String(n));
    var top = this.scroll.scrollTop;
    var hgt = this.scroll.clientHeight || 600;
    var first = Math.max(0, Math.floor((top - HEAD_H) / ROW_H) - 8);
    var last = Math.min(n, Math.ceil((top + hgt) / ROW_H) + 8);
    // Columns in view only (wide sheets have up to 156 columns).
    var left = this.scroll.scrollLeft;
    var width = this.scroll.clientWidth || 1200;
    var c0 = 0;
    while (c0 < this.cols.length - 1 && this.lefts[c0] + this.widths[c0] < left + RN_W) c0++;
    var c1 = c0;
    while (c1 < this.cols.length && this.lefts[c1] < left + width) c1++;
    c0 = Math.max(0, c0 - 2); c1 = Math.min(this.cols.length, c1 + 2);
    var s = this.selRect();
    var frag = document.createDocumentFragment();
    var missing = {};
    for (var i = first; i < last; i++) {
      var isNew = i >= this.total;
      var srv = isNew ? null : this.srvRow(i);
      if (!isNew && !srv) missing[Math.floor(i / BLOCK)] = 1;
      var del = srv && this.dels.has(srv.id);
      var row = h('div', { class: 'ed-row' + (isNew ? ' new' : '') + (del ? ' del' : ''), role: 'row', style: 'top:' + (i * ROW_H) + 'px;width:' + this.totalW + 'px' });
      row.appendChild(h('div', { class: 'ed-c ed-rn', style: 'width:' + RN_W + 'px', text: isNew ? 'new' : srv ? String(srv.row_no) : '' }));
      if (c0 > 0) row.appendChild(h('div', { style: 'flex:none;width:' + (this.lefts[c0] - RN_W) + 'px' }));
      for (var c = c0; c < c1; c++) {
        var v = this.value(i, c);
        var cls = 'ed-c' + (this.cols[c].type === 'number' && !this.native ? ' num' : '');
        if (v === undefined) cls += ' loading';
        if (i >= s.r0 && i <= s.r1 && c >= s.c0 && c <= s.c1) cls += ' sel';
        if (i === this.sel.fr && c === this.sel.fc) cls += ' cur';
        if (!isNew && this.isDirty(i, c)) cls += ' dirty';
        row.appendChild(h('div', { class: cls, role: 'gridcell', 'data-r': String(i), 'data-c': String(c), style: 'width:' + this.widths[c] + 'px', text: v === undefined ? '…' : v }));
      }
      frag.appendChild(row);
    }
    Ed.clear(this.layer);
    this.layer.appendChild(frag);
    if (this.loadError) this.layer.appendChild(h('div', { class: 'ed-note bad', style: 'position:absolute;top:8px;left:70px' }, Ed.errorText(this.loadError), ' ', Ed.btn('Retry', { on: function () { self.reload(); } })));
    else if (!n) this.layer.appendChild(h('div', { class: 'ed-muted', style: 'position:absolute;top:14px;left:70px;white-space:nowrap', text: this.query.q || this.query.filters.length ? 'No rows match.' : (this.native && this.rights.add ? 'No rows yet. Paste rows from a sheet (first row the header), or add a row.' : 'No rows.') }));
    Object.keys(missing).forEach(function (b) { self.fetchBlock(Number(b), self.gen).catch(function (err) { self.loadError = err; }); });
    if (this.editing) this.placeEditor();
  };

  G.selRect = function () {
    var s = this.sel;
    return { r0: Math.min(s.ar, s.fr), r1: Math.max(s.ar, s.fr), c0: Math.min(s.ac, s.fc), c1: Math.max(s.ac, s.fc) };
  };

  G.scrollTo = function (r, c) {
    var top = HEAD_H + r * ROW_H;
    var sc = this.scroll;
    if (top - HEAD_H < sc.scrollTop) sc.scrollTop = top - HEAD_H;
    else if (top + ROW_H > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + ROW_H - sc.clientHeight;
    var l = this.lefts[c];
    if (l - RN_W < sc.scrollLeft) sc.scrollLeft = l - RN_W;
    else if (l + this.widths[c] > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = l + this.widths[c] - sc.clientWidth;
  };

  G.status = function () {
    var s = this.selRect();
    var cells = (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1);
    this.onStatus({ total: this.total, rows: this.rowCount(), selCells: this.rowCount() ? cells : 0, selRows: s.r1 - s.r0 + 1, pending: this.pendingCount() });
  };

  /* ---------- Keyboard ---------- */
  G.move = function (dr, dc, extend) {
    var n = this.rowCount();
    if (!n) return;
    var s = this.sel;
    var r = Math.max(0, Math.min(n - 1, s.fr + dr));
    var c = Math.max(0, Math.min(this.cols.length - 1, s.fc + dc));
    if (extend) { s.fr = r; s.fc = c; } else this.sel = { ar: r, ac: c, fr: r, fc: c };
    this.scrollTo(r, c);
    this.paint();
    this.status();
  };

  G.onKey = function (e) {
    if (this.editing) return;
    var mod = e.ctrlKey || e.metaKey;
    var k = e.key;
    var page = Math.max(1, Math.floor(this.scroll.clientHeight / ROW_H) - 1);
    if (k === 'ArrowDown') { e.preventDefault(); this.move(mod ? 1e9 : 1, 0, e.shiftKey); }
    else if (k === 'ArrowUp') { e.preventDefault(); this.move(mod ? -1e9 : -1, 0, e.shiftKey); }
    else if (k === 'ArrowLeft') { e.preventDefault(); this.move(0, mod ? -1e9 : -1, e.shiftKey); }
    else if (k === 'ArrowRight') { e.preventDefault(); this.move(0, mod ? 1e9 : 1, e.shiftKey); }
    else if (k === 'PageDown') { e.preventDefault(); this.move(page, 0, e.shiftKey); }
    else if (k === 'PageUp') { e.preventDefault(); this.move(-page, 0, e.shiftKey); }
    else if (k === 'Home') { e.preventDefault(); this.move(mod ? -1e9 : 0, -1e9, e.shiftKey); }
    else if (k === 'End') { e.preventDefault(); this.move(mod ? 1e9 : 0, 1e9, e.shiftKey); }
    else if (k === 'Tab') { e.preventDefault(); this.move(0, e.shiftKey ? -1 : 1, false); }
    else if (k === 'Enter' || k === 'F2') { e.preventDefault(); if (e.shiftKey && k === 'Enter') this.move(-1, 0); else this.startEdit(null); }
    else if (k === 'Escape') { this.sel = { ar: this.sel.fr, ac: this.sel.fc, fr: this.sel.fr, fc: this.sel.fc }; this.paint(); }
    else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); this.clearRange(); }
    else if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); this.undo(); }
    else if (mod && (k === 's' || k === 'S')) { e.preventDefault(); if (this.onSave) this.onSave(); }
    else if (mod && (k === 'a' || k === 'A')) { e.preventDefault(); this.sel = { ar: 0, ac: 0, fr: Math.max(0, this.rowCount() - 1), fc: this.cols.length - 1 }; this.paint(); this.status(); }
    else if (mod && (k === 'c' || k === 'C')) { this.prepareCopy(); }
    else if (!mod && !e.altKey && k.length === 1) { e.preventDefault(); this.startEdit(k); }
  };

  /* ---------- Editing ---------- */
  G.canEditRow = function (i) {
    if (!this.native) return 'This dataset is a copy of its original; edit it there.';
    if (i >= this.total) return this.rights.add ? '' : 'You may not add rows here.';
    if (!this.rights.edit) return 'You may not edit rows here.';
    var r = this.srvRow(i);
    if (!r) return 'This row is still loading.';
    if (this.dels.has(r.id)) return 'This row is marked for deletion.';
    return '';
  };

  G.startEdit = function (initial) {
    var self = this;
    var r = this.sel.fr;
    var c = this.sel.fc;
    if (!this.rowCount()) { if (this.native && this.rights.add) { this.addRows(1); r = 0; } else return; }
    var why = this.canEditRow(r);
    if (why) { Ed.toast(why); return; }
    if (narrow()) { this.sheetEdit(initial); return; }
    var v = this.value(r, c);
    var ta = h('textarea', { class: 'ed-edit', spellcheck: 'false', 'aria-label': this.cols[c].label });
    ta.value = initial != null ? initial : (v == null ? '' : v);
    this.editing = { r: r, c: c, el: ta, orig: v == null ? '' : v };
    this.sizer.appendChild(ta);
    this.placeEditor();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); self.finishEdit(false); }
      else if (e.key === 'Enter' && !e.altKey && !e.shiftKey) { e.preventDefault(); self.finishEdit(true); self.move(1, 0); }
      else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); self.finishEdit(true); self.move(-1, 0); }
      else if (e.key === 'Tab') { e.preventDefault(); self.finishEdit(true); self.move(0, e.shiftKey ? -1 : 1); }
      else if (e.key === 'Enter' && e.altKey) { e.preventDefault(); var p = ta.selectionStart; ta.value = ta.value.slice(0, p) + '\n' + ta.value.slice(ta.selectionEnd); ta.setSelectionRange(p + 1, p + 1); }
    });
    ta.addEventListener('blur', function () { if (self.editing && self.editing.el === ta) self.finishEdit(true); });
  };

  G.placeEditor = function () {
    var e = this.editing;
    if (!e || !e.el) return;
    e.el.style.left = this.lefts[e.c] + 'px';
    e.el.style.top = (HEAD_H + e.r * ROW_H) + 'px';
    e.el.style.width = Math.max(this.widths[e.c], 160) + 'px';
    e.el.style.height = Math.max(ROW_H, Math.min(140, (String(e.el.value).split('\n').length) * 18 + 10)) + 'px';
  };

  G.finishEdit = function (save) {
    var e = this.editing;
    if (!e) return;
    this.editing = null;
    var val = e.el.value;
    if (e.el.parentNode) e.el.parentNode.removeChild(e.el);
    if (save && val !== e.orig) this.setCells([{ r: e.r, c: e.c, v: val }]);
    this.focus();
    this.paint();
  };

  /** Phones: a bottom sheet to edit one cell. */
  G.sheetEdit = function (initial) {
    var self = this;
    var r = this.sel.fr;
    var c = this.sel.fc;
    var why = this.canEditRow(r);
    if (why) { Ed.toast(why); return; }
    var v = this.value(r, c);
    var ta = h('textarea', { class: 'ui-input', 'aria-label': this.cols[c].label });
    ta.value = initial != null ? initial : (v == null ? '' : v);
    var sheet = h('div', { class: 'ed-sheet', role: 'dialog', 'aria-label': 'Edit cell' },
      h('div', { class: 'ed-small ed-muted', text: 'Row ' + (r >= this.total ? 'new' : (this.srvRow(r) || {}).row_no) + ' · ' + (this.cols[c].label || this.cols[c].name) + ' · ' + this.cols[c].type }), ta,
      h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' },
        Ed.btn('Cancel', { on: function () { close(); } }),
        Ed.btn('Done', { cls: 'sm primary', on: function () { var nv = ta.value; close(); if (nv !== (v == null ? '' : v)) self.setCells([{ r: r, c: c, v: nv }]); } })));
    function close() { if (sheet.parentNode) sheet.parentNode.removeChild(sheet); self.editing = null; self.paint(); }
    this.editing = { sheet: true, r: r, c: c };
    document.body.appendChild(sheet);
    ta.focus();
  };

  /**
   * Apply cell changes [{ r, c, v }] as this page's pending edits (one undo step).
   * Rows past the end become new rows. → number of cells changed
   */
  G.setCells = function (changes, label) {
    var self = this;
    var step = { kind: 'cells', items: [], addedRows: 0 };
    var refused = 0;
    var need = 0;
    changes.forEach(function (ch) { if (ch.r >= self.rowCount()) need = Math.max(need, ch.r - self.rowCount() + 1); });
    if (need) {
      if (!this.native || !this.rights.add) { refused += changes.filter(function (ch) { return ch.r >= self.rowCount(); }).length; changes = changes.filter(function (ch) { return ch.r < self.rowCount(); }); }
      else { this.addRowsRaw(need); step.addedRows = need; }
    }
    changes.forEach(function (ch) {
      if (self.canEditRow(ch.r)) { refused++; return; }
      var v = ch.v == null ? '' : String(ch.v);
      if (ch.r >= self.total) {
        var a = self.adds[ch.r - self.total];
        step.items.push({ ref: 'n', add: a, c: ch.c, before: a.cells[ch.c] });
        a.cells[ch.c] = v;
        return;
      }
      var row = self.srvRow(ch.r);
      var ed = self.edits.get(row.id);
      var before = ed && ed.cells.has(ch.c) ? ed.cells.get(ch.c) : undefined;
      if (!ed) { ed = { hash: row.hash, base: row.cells.slice(), row_no: row.row_no, cells: new Map() }; self.edits.set(row.id, ed); }
      step.items.push({ ref: 'r', id: row.id, c: ch.c, before: before });
      if (v === ed.base[ch.c]) ed.cells.delete(ch.c); else ed.cells.set(ch.c, v);
      if (!ed.cells.size) self.edits.delete(row.id);
    });
    if (step.items.length || step.addedRows) this.undoStack.push(step);
    if (refused) Ed.toast(refused + ' cell(s) not changed: ' + (this.native ? 'you may not change those rows.' : 'this dataset is read-only here.'));
    this.paint();
    this.status();
    this.onChange(label);
    return step.items.length;
  };

  G.addRowsRaw = function (k) {
    for (var i = 0; i < k; i++) this.adds.push({ tmp: ++this.tmpSeq, cells: this.cols.map(function () { return ''; }) });
  };
  G.addRows = function (k) {
    if (!this.native || !this.rights.add) { Ed.toast('You may not add rows here.'); return; }
    this.addRowsRaw(k);
    this.undoStack.push({ kind: 'cells', items: [], addedRows: k });
    var r = this.rowCount() - k;
    this.sel = { ar: r, ac: 0, fr: r, fc: 0 };
    this.paint();
    this.scrollTo(r, 0);
    this.paint();
    this.status();
    this.onChange();
  };

  G.clearRange = function () {
    var s = this.selRect();
    var ch = [];
    for (var r = s.r0; r <= s.r1; r++) for (var c = s.c0; c <= s.c1; c++) { var v = this.value(r, c); if (v) ch.push({ r: r, c: c, v: '' }); }
    if (ch.length) this.setCells(ch);
  };

  /** Mark the selected rows for deletion (new rows are simply dropped). */
  G.deleteSelected = function () {
    var s = this.selRect();
    var step = { kind: 'del', ids: [], dropped: [] };
    var refused = 0;
    for (var r = s.r1; r >= s.r0; r--) {
      if (r >= this.total) { var idx = r - this.total; step.dropped.push({ idx: idx, add: this.adds[idx] }); this.adds.splice(idx, 1); continue; }
      var row = this.srvRow(r);
      if (!row || !this.native || !this.rights.delete) { refused++; continue; }
      if (this.dels.has(row.id)) continue;
      this.dels.set(row.id, { hash: row.hash, base: row.cells.slice(), row_no: row.row_no });
      step.ids.push(row.id);
    }
    if (step.ids.length || step.dropped.length) this.undoStack.push(step);
    if (refused) Ed.toast(refused + ' row(s) not marked: you may not delete rows here.');
    this.paint(); this.status(); this.onChange();
  };

  G.undo = function () {
    var step = this.undoStack.pop();
    if (!step) { Ed.toast('Nothing to undo on this page. Saved changes are undone from History.'); return; }
    var self = this;
    if (step.kind === 'del') {
      step.ids.forEach(function (id) { self.dels.delete(id); });
      step.dropped.slice().reverse().forEach(function (d) { self.adds.splice(d.idx, 0, d.add); });
    } else {
      step.items.slice().reverse().forEach(function (it) {
        if (it.ref === 'n') { it.add.cells[it.c] = it.before; return; }
        var ed = self.edits.get(it.id);
        if (!ed) {
          if (it.before === undefined) return;
          var row = self.findRow(it.id);
          if (!row) return;
          ed = { hash: row.hash, base: row.cells.slice(), row_no: row.row_no, cells: new Map() };
          self.edits.set(it.id, ed);
        }
        if (it.before === undefined) ed.cells.delete(it.c); else ed.cells.set(it.c, it.before);
        if (!ed.cells.size) self.edits.delete(it.id);
      });
      if (step.addedRows) this.adds.splice(this.adds.length - step.addedRows, step.addedRows);
    }
    this.paint(); this.status(); this.onChange();
  };

  G.findRow = function (id) {
    var out = null;
    this.blocks.forEach(function (b) { if (!out && b.rows) b.rows.forEach(function (r) { if (r.id === id) out = r; }); });
    return out;
  };

  /* ---------- Clipboard ---------- */
  G.rangeText = function () {
    var s = this.selRect();
    var lines = [];
    for (var r = s.r0; r <= s.r1; r++) {
      var cells = [];
      for (var c = s.c0; c <= s.c1; c++) { var v = this.value(r, c); cells.push(tsvCell(v === undefined ? '' : v)); }
      lines.push(cells.join('\t'));
    }
    return lines.join('\r\n');
  };
  G.prepareCopy = function () {
    var self = this;
    var s = this.selRect();
    if (s.r1 - s.r0 > 20000) { Ed.toast('Copy at most 20,000 rows at a time; use Export CSV for more.'); return; }
    var loaded = true;
    for (var r = s.r0; r <= Math.min(s.r1, this.total - 1); r++) if (!this.srvRow(r)) { loaded = false; break; }
    if (loaded) { this.sink.value = this.rangeText(); this.sink.select(); return; }
    this.ensure(s.r0, s.r1 + 1).then(function () { return Ed.n && (w.UI && UI.copy ? UI.copy(self.rangeText()) : null); }).then(function () { Ed.toast('Copied ' + (s.r1 - s.r0 + 1) + ' rows.'); }, function (err) { Ed.toast(Ed.errorText(err)); });
  };
  G.onCopy = function (e) {
    var t = this.rangeText();
    if (e.clipboardData) { e.clipboardData.setData('text/plain', t); e.preventDefault(); }
    this.sink.value = '';
  };

  /**
   * Paste rows of cells at the selection. A first row naming the columns (pasted at the first column)
   * is taken as the header: columns are then matched by name. A single value fills the selection.
   * Rows past the end become new rows.
   */
  G.pasteRows = function (rows, source) {
    var self = this;
    if (!rows.length) { Ed.toast('The clipboard has no cells.'); return Promise.resolve(0); }
    if (!this.native) { Ed.toast('This dataset is a copy of its original; paste into the original sheet.'); return Promise.resolve(0); }
    var s = this.selRect();
    var at = this.rowCount() ? s.r0 : 0;
    var c0 = this.rowCount() ? s.c0 : 0;
    var map = null;
    var note = '';
    var hm = EdClip.headerMatch(rows[0], this.cols);
    if ((c0 === 0 || !this.rowCount()) && hm.isHeader) {
      map = hm.map;
      rows = rows.slice(1);
      note = 'First row taken as the header: ' + hm.map.filter(function (x) { return x >= 0; }).length + ' column(s) matched by name' + (hm.unknown.length ? '; not in this dataset: ' + hm.unknown.slice(0, 5).join(', ') + (hm.unknown.length > 5 ? '…' : '') : '') + '.';
      if (!this.total && !this.adds.length) at = 0;
    }
    if (rows.length > MAX_PASTE) { Ed.toast('Paste at most ' + MAX_PASTE.toLocaleString('en-IN') + ' rows at a time.'); return Promise.resolve(0); }
    var fill = !map && rows.length === 1 && rows[0].length === 1 && (s.r1 > s.r0 || s.c1 > s.c0);
    return this.ensure(at, at + rows.length).then(function () {
      var ch = [];
      var dropped = 0;
      if (fill) {
        for (var r = s.r0; r <= s.r1; r++) for (var c = s.c0; c <= s.c1; c++) ch.push({ r: r, c: c, v: rows[0][0] });
      } else {
        rows.forEach(function (cells, k) {
          cells.forEach(function (v, j) {
            var c = map ? map[j] : c0 + j;
            if (c == null || c < 0 || c >= self.cols.length) { if (String(v).trim()) dropped++; return; }
            ch.push({ r: at + k, c: c, v: v });
          });
        });
      }
      // A pasted value equal to what is there already is no change.
      ch = ch.filter(function (x) { return x.r >= self.rowCount() || self.value(x.r, x.c) !== x.v; });
      var n = self.setCells(ch, 'paste');
      var last = fill ? s.r1 : at + rows.length - 1;
      self.sel = fill ? self.sel : { ar: at, ac: map ? 0 : c0, fr: Math.max(at, last), fc: map ? self.cols.length - 1 : Math.min(self.cols.length - 1, c0 + Math.max.apply(null, rows.map(function (r) { return r.length; })) - 1) };
      self.paint(); self.status();
      var msg = n + ' cell(s) pasted' + (source === 'html' ? ' (from the HTML copy)' : '') + '.' + (dropped ? ' ' + dropped + ' value(s) past the last column were left out.' : '') + (note ? ' ' + note : '');
      Ed.toast(msg);
      if (self.onPasted) self.onPasted(n, msg);
      return n;
    }, function (err) { Ed.toast(Ed.errorText(err)); return 0; });
  };
  G.onPaste = function (dt) {
    var got = EdClip.fromClipboard(dt);
    this.pasteRows(got.rows, got.source);
  };

  /* ---------- Sort and filter ---------- */
  G.cycleSort = function (name) {
    var cur = this.query.sort;
    this.query.sort = cur === name ? '-' + name : cur === '-' + name ? '' : name;
    var self = this;
    Array.prototype.forEach.call(this.head.children, function (cell) {
      var ci = cell.getAttribute('data-c');
      if (ci == null) return;
      var nm = self.cols[Number(ci)].name;
      cell.classList.toggle('sorted', self.query.sort === nm || self.query.sort === '-' + nm);
      cell.classList.toggle('desc', self.query.sort === '-' + nm);
    });
    this.requery();
  };
  G.requery = function () {
    if (this.pendingCount()) Ed.toast('Your unsaved changes are kept while the view changes.');
    this.sel = { ar: 0, ac: 0, fr: 0, fc: 0 };
    this.reload();
  };

  /* ---------- Pending changes → operations ---------- */
  G.pendingCount = function () {
    var n = this.dels.size;
    this.edits.forEach(function (ed, id) { if (!this.dels.has(id)) n++; }, this);
    this.adds.forEach(function (a) { if (a.cells.some(function (v) { return String(v).trim() !== ''; })) n++; });
    return n;
  };

  /** → { ops, refs } where refs[i] says which pending change ops[i] came from. */
  G.buildOps = function () {
    var self = this;
    var ops = [];
    var refs = [];
    this.dels.forEach(function (d, id) { ops.push({ op: 'delete', id: id, hash: d.hash }); refs.push({ kind: 'del', id: id, row_no: d.row_no, base: d.base }); });
    this.edits.forEach(function (ed, id) {
      if (self.dels.has(id)) return;
      var cells = {};
      ed.cells.forEach(function (v, c) { cells[self.cols[c].name] = v; });
      ops.push({ op: 'update', id: id, hash: ed.hash, cells: cells });
      refs.push({ kind: 'edit', id: id, row_no: ed.row_no, base: ed.base });
    });
    this.adds.forEach(function (a) {
      if (!a.cells.some(function (v) { return String(v).trim() !== ''; })) return;
      var cells = {};
      a.cells.forEach(function (v, c) { if (v !== '') cells[self.cols[c].name] = v; });
      ops.push({ op: 'create', cells: cells });
      refs.push({ kind: 'add', add: a });
    });
    return { ops: ops, refs: refs };
  };

  /** Conflict resolution: keep mine (take the server's latest hash) or use theirs (drop my change). */
  G.resolve = function (ref, choice, current) {
    if (ref.kind === 'edit') {
      var ed = this.edits.get(ref.id);
      if (!ed) return;
      if (choice === 'theirs' || !current) { this.edits.delete(ref.id); return; }
      ed.hash = current.hash;
      ed.base = current.cells.slice(0);
    } else if (ref.kind === 'del') {
      var d = this.dels.get(ref.id);
      if (!d) return;
      if (choice === 'theirs' || !current) { this.dels.delete(ref.id); return; }
      d.hash = current.hash;
    }
  };

  G.discard = function () {
    this.edits.clear(); this.dels.clear(); this.adds = []; this.undoStack = [];
    this.paint(); this.status(); this.onChange();
  };

  G.afterCommit = function () {
    this.edits.clear(); this.dels.clear(); this.adds = []; this.undoStack = [];
    var top = this.scroll.scrollTop;
    var self = this;
    this.gen++;
    this.blocks.clear();
    this.fetchBlock(Math.floor(Math.max(0, top - HEAD_H) / ROW_H / BLOCK), this.gen).then(function () { self.paint(); self.status(); }, function (err) { self.loadError = err; self.paint(); });
    this.onChange();
  };

  Ed.Grid = Grid;

  /* ---------- Review and save ---------- */
  /**
   * The preview / diff screen, then the commit. opts: { kind, onDone(result) }
   * One idempotency key per review: a retry after a lost connection is never applied twice.
   */
  Ed.review = function (grid, opts) {
    var o = opts || {};
    var key = Ed.idemKey();
    var skipInvalid = false;
    var m = Ed.modal('Review changes · ' + grid.ds.label, { sticky: true });
    var built = grid.buildOps();
    if (!built.ops.length) { m.body.appendChild(h('p', { text: 'There are no changes to save.' })); m.foot.appendChild(Ed.btn('Close', { on: m.close })); return; }
    var commitBtn = Ed.btn('Save to the VM', { cls: 'sm primary' });
    var back = Ed.btn('Back to editing', { on: function () { m.close(); } });
    var status = h('span', { class: 'ed-small ed-muted' });
    m.foot.appendChild(status); m.foot.appendChild(h('span', { class: 'ed-sp' })); m.foot.appendChild(back); m.foot.appendChild(commitBtn);
    var labels = grid.cols.map(function (c) { return c.label || c.name; });

    function load() {
      built = grid.buildOps();
      Ed.clear(m.body).appendChild(h('p', { class: 'ed-muted', text: 'Checking ' + built.ops.length + ' change(s) with the server…' }));
      commitBtn.disabled = true;
      return Ed.api('POST', '/datasets/' + encodeURIComponent(grid.ds.key) + '/preview', { ops: built.ops, skipInvalid: skipInvalid }).then(show, function (err) {
        Ed.clear(m.body).appendChild(h('div', { class: 'ed-note bad' }, Ed.errorText(err), ' ', Ed.btn('Try again', { on: load })));
      });
    }

    function show(p) {
      var b = Ed.clear(m.body);
      var c = p.counts;
      b.appendChild(h('div', { class: 'ed-counts' },
        h('span', { class: 'ed-badge ok', text: c.added + ' added' }), h('span', { class: 'ed-badge warn', text: c.changed + ' changed' }),
        h('span', { class: 'ed-badge bad', text: c.deleted + ' deleted' }), c.unchanged ? h('span', { class: 'ed-badge', text: c.unchanged + ' unchanged' }) : null,
        c.held ? h('span', { class: 'ed-badge bad', text: c.held + ' held back' }) : null));
      var blocked = false;
      if (p.denied && p.denied.length) {
        blocked = true;
        b.appendChild(h('div', { class: 'ed-note bad' }, p.denied.length + ' change(s) are not allowed: ' + p.denied[0].reason));
      }
      if (p.conflicts && p.conflicts.length) { blocked = true; b.appendChild(conflictBox(p.conflicts)); }
      if (p.invalid && p.invalid.length) {
        var rowsBad = {};
        p.invalid.forEach(function (v) { rowsBad[v.i] = 1; });
        var nBad = Object.keys(rowsBad).length;
        if (!skipInvalid) blocked = true;
        var tb = h('tbody');
        p.invalid.slice(0, 300).forEach(function (v) {
          var ref = built.refs[v.i];
          var col = grid.cols.filter(function (cc) { return cc.name === v.field; })[0];
          tb.appendChild(h('tr', null, h('td', { text: ref && ref.row_no ? 'Row ' + ref.row_no : 'New row' }), h('td', { text: col ? (col.label || col.name) + ' (' + col.type + ')' : '—' }),
            h('td', { class: 'bad', text: v.value }), h('td', { text: v.message })));
        });
        var hold = h('input', { type: 'checkbox', checked: skipInvalid, on: { change: function () { skipInvalid = hold.checked; load(); } } });
        b.appendChild(h('div', { class: 'ed-note ' + (skipInvalid ? 'warn' : 'bad') },
          h('b', { text: nBad + ' row(s) have values that do not fit their column. ' }),
          h('label', null, hold, ' Hold these rows back and save the rest')));
        b.appendChild(h('div', { class: 'ed-tw', style: 'max-height:24vh;margin-bottom:12px' }, h('table', { class: 'ed-t' }, h('thead', null, h('tr', null, h('th', { text: 'Row' }), h('th', { text: 'Column' }), h('th', { text: 'Value' }), h('th', { text: 'Problem' }))), tb)));
      }
      // The diff.
      var body = h('tbody');
      p.rows.slice(0, 500).forEach(function (r) {
        var ref = built.refs[r.i] || {};
        var tr = h('tr', { class: r.op === 'create' ? 'add' : r.op === 'delete' ? 'del' : '' });
        tr.appendChild(h('td', { text: r.row_no ? String(r.row_no) : 'new' }));
        tr.appendChild(h('td', { text: r.op === 'create' ? 'Add' : r.op === 'delete' ? 'Delete' : 'Change' }));
        var det = h('td');
        if (r.op === 'update') {
          grid.cols.forEach(function (cc) {
            var i = cc.index;
            var a = r.before ? r.before[gridIndex(grid, cc)] : '';
            var z = r.after ? r.after[gridIndex(grid, cc)] : '';
            if (a !== z) det.appendChild(h('div', null, h('b', { text: (cc.label || cc.name) + ': ' }), h('span', { style: 'color:var(--mzo-bad);text-decoration:line-through', text: a === '' ? '(empty)' : a }), ' → ', h('span', { class: 'new', text: z === '' ? '(empty)' : z })));
            void i;
          });
        } else {
          var cells = r.op === 'create' ? r.after : r.before;
          var shown = 0;
          grid.cols.forEach(function (cc) {
            var v = cells ? cells[gridIndex(grid, cc)] : '';
            if (v !== '' && v != null && shown < 12) { shown++; det.appendChild(h('div', null, h('b', { text: (cc.label || cc.name) + ': ' }), String(v))); }
          });
        }
        tr.appendChild(det);
        body.appendChild(tr);
        void ref;
      });
      if (p.rows.length) {
        b.appendChild(h('div', { class: 'ed-tw' }, h('table', { class: 'ed-t' }, h('thead', null, h('tr', null, h('th', { text: 'Row' }), h('th', { text: 'What' }), h('th', { text: 'Values' }))), body)));
        if (p.rows.length > 500) b.appendChild(h('p', { class: 'ed-small ed-muted', text: 'Showing the first 500 of ' + p.rows.length + ' changes.' }));
      } else if (!blocked) b.appendChild(h('p', { text: 'Nothing would change.' }));
      commitBtn.disabled = blocked || !(c.added + c.changed + c.deleted);
      status.textContent = blocked ? 'Resolve the problems above to save.' : 'All or nothing: either every change is saved or none is.';
    }

    function conflictBox(conflicts) {
      var box = h('div', { class: 'ed-note bad', style: 'display:block' });
      box.appendChild(h('p', { style: 'margin:0 0 8px' }, h('b', { text: conflicts.length + ' row(s) were changed by someone else since you loaded them.' }), ' Choose for each: keep your version (it replaces theirs) or use theirs (your change to that row is dropped).'));
      var tb = h('tbody');
      conflicts.slice(0, 200).forEach(function (cf) {
        var ref = built.refs[cf.i];
        if (!ref) return;
        var mine = ref.kind === 'del' ? '(delete the row)' : summarise(grid, ref);
        var theirs = cf.reason === 'deleted' ? '(row deleted)' : cf.current ? diffText(grid, ref.base, cf.current.cells) : '';
        tb.appendChild(h('tr', null, h('td', { text: ref.row_no ? 'Row ' + ref.row_no : '' }), h('td', { text: mine }), h('td', { text: theirs }),
          h('td', null, cf.reason === 'deleted' ? null : Ed.btn('Keep mine', { on: function () { grid.resolve(ref, 'mine', cf.current); load(); } }), ' ',
            Ed.btn('Use theirs', { on: function () { grid.resolve(ref, 'theirs'); grid.afterRefresh = true; load(); } }))));
      });
      box.appendChild(h('div', { class: 'ed-tw', style: 'max-height:24vh' }, h('table', { class: 'ed-t' }, h('thead', null, h('tr', null, h('th', { text: 'Row' }), h('th', { text: 'Your change' }), h('th', { text: 'Their change' }), h('th', { text: '' }))), tb)));
      box.appendChild(h('div', { style: 'margin-top:8px;display:flex;gap:8px' },
        Ed.btn('Keep all mine', { on: function () { conflicts.forEach(function (cf) { var r = built.refs[cf.i]; if (r) grid.resolve(r, cf.reason === 'deleted' ? 'theirs' : 'mine', cf.current); }); load(); } }),
        Ed.btn('Use all theirs', { on: function () { conflicts.forEach(function (cf) { var r = built.refs[cf.i]; if (r) grid.resolve(r, 'theirs'); }); load(); } })));
      return box;
    }

    commitBtn.addEventListener('click', function () {
      commitBtn.disabled = true;
      back.disabled = true;
      status.textContent = 'Saving…';
      built = grid.buildOps();
      Ed.api('POST', '/datasets/' + encodeURIComponent(grid.ds.key) + '/commit', { idempotencyKey: key, ops: built.ops, skipInvalid: skipInvalid, kind: o.kind || 'edit' }).then(function (r) {
        m.close();
        grid.afterCommit(r);
        if (o.onDone) o.onDone(r);
      }, function (err) {
        back.disabled = false;
        if (err.status === 0 || err.status >= 500 && err.status !== 503) {
          status.textContent = '';
          Ed.clear(m.body).appendChild(h('div', { class: 'ed-note bad' }, 'The connection was lost or the server failed while saving (' + Ed.errorText(err) + '). ',
            'Saving again is safe: if the first attempt went through, it is not applied twice.'));
          commitBtn.disabled = false;
          commitBtn.querySelector('span').textContent = 'Save again';
          return;
        }
        if (err.status === 409 || err.status === 422 || err.status === 403) { load(); Ed.toast(Ed.errorText(err)); return; }
        Ed.clear(m.body).appendChild(h('div', { class: 'ed-note bad', text: Ed.errorText(err) }));
      });
    });
    load();
    void labels;
  };

  function gridIndex(grid, col) { return grid.cols.indexOf(col); }
  function summarise(grid, ref) {
    var ed = grid.edits.get(ref.id);
    if (!ed) return '';
    var parts = [];
    ed.cells.forEach(function (v, c) { parts.push((grid.cols[c].label || grid.cols[c].name) + ' = ' + (v === '' ? '(empty)' : v)); });
    return parts.join('; ');
  }
  function diffText(grid, base, cur) {
    var parts = [];
    grid.cols.forEach(function (c, i) { if (base && cur && base[i] !== cur[i]) parts.push((c.label || c.name) + ' = ' + (cur[i] === '' ? '(empty)' : cur[i])); });
    return parts.join('; ') || '(no visible difference)';
  }
})(window);
