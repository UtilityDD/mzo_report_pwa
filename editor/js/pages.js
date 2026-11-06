/* Data editor pages: home (#/), a dataset (#/d/<key>), new dataset (#/new) and permissions
 * (#/permissions?email=<email>, linked from the user admin). docs/data-editor.md.
 */
(function (w) {
  'use strict';
  var Ed = w.Ed;
  var h = Ed.h;

  function modeBadge(mode) {
    return mode === 'native' ? h('span', { class: 'ed-badge native', title: 'Edited here; the VM is its source', text: 'Edited here' })
      : h('span', { class: 'ed-badge', title: 'A copy of the Google Sheet or Supabase table; read-only here', text: 'Copy · read-only' });
  }
  function rightsText(r) {
    if (!r) return '';
    var parts = [];
    if (r.edit) parts.push('edit');
    if (r.add) parts.push('add');
    if (r.delete) parts.push('delete');
    return (parts.length ? parts.join(', ') : 'view') + (r.scopeOnly ? ' · your office' : '');
  }

  /* ---------- Home ---------- */
  Ed.route(/^\/$/, function () {
    var page = Ed.shell('');
    var q = h('input', { class: 'ui-input', type: 'search', placeholder: 'Find a dataset', 'aria-label': 'Find a dataset' });
    var search = h('div', { class: 'ui-search' }, Ed.icon('search'), q);
    var onlyEdit = h('input', { type: 'checkbox' });
    page.appendChild(h('div', { class: 'ed-head' }, h('h1', { text: 'Datasets' }),
      h('div', { class: 'ed-acts' }, search, h('label', { class: 'ed-small' }, onlyEdit, ' Editable only'),
        Ed.me.isAdmin ? h('a', { class: 'ui-btn sm primary', href: '#/new' }, Ed.icon('plus'), h('span', { text: 'New dataset' })) : null)));
    var list = h('div', null, h('p', { class: 'ed-muted', text: 'Loading…' }));
    page.appendChild(list);
    var all = [];
    function draw() {
      Ed.clear(list);
      var t = q.value.trim().toLowerCase();
      var shown = all.filter(function (d) {
        if (onlyEdit.checked && !(d.mode === 'native' && (d.rights.edit || d.rights.add || d.rights.delete))) return false;
        return !t || d.label.toLowerCase().indexOf(t) >= 0 || d.key.indexOf(t) >= 0;
      });
      if (!all.length) { list.appendChild(h('div', { class: 'ed-note' }, 'No dataset has been shared with you yet. Ask an admin for access.')); return; }
      if (!shown.length) { list.appendChild(h('p', { class: 'ed-muted', text: 'No dataset matches.' })); return; }
      var groups = [];
      var by = {};
      shown.forEach(function (d) { if (!by[d.group]) { by[d.group] = []; groups.push(d.group); } by[d.group].push(d); });
      groups.forEach(function (g) {
        var box = h('div', { class: 'ed-list' });
        by[g].forEach(function (d) {
          box.appendChild(h('a', { class: 'ed-item', href: '#/d/' + encodeURIComponent(d.key) },
            h('div', null, h('div', { class: 't', text: d.label }), h('div', { class: 'k', text: d.key })),
            h('div', null, modeBadge(d.mode)),
            h('div', { class: 'n', text: Ed.n(d.rows) + ' rows' }),
            h('div', { class: 'ed-small ed-muted hide-sm hide-md', title: Ed.when(d.lastChange), text: 'Changed ' + Ed.ago(d.lastChange) }),
            h('div', { class: 'ed-small ed-muted hide-sm hide-md', text: d.mode === 'native' ? rightsText(d.rights) : 'view' })));
        });
        list.appendChild(h('div', { class: 'ed-group' }, h('h2', { text: g }), box));
      });
    }
    q.addEventListener('input', draw);
    onlyEdit.addEventListener('change', draw);
    Ed.api('GET', '/datasets').then(function (r) { all = r.datasets; draw(); }, function (err) { Ed.clear(list).appendChild(h('div', { class: 'ed-note bad', text: Ed.errorText(err) })); });
  });

  /* ---------- Dataset ---------- */
  Ed.route(/^\/d\/([a-z0-9_]+)$/, function (m) {
    var key = m[1];
    var page = Ed.shell(key);
    page.className = 'ed-page wide';
    page.appendChild(h('p', { class: 'ed-muted', text: 'Loading…' }));
    Ed.api('GET', '/datasets/' + key).then(function (r) { datasetPage(page, r.dataset, r.rights); }, function (err) {
      Ed.clear(page).appendChild(h('div', { class: 'ed-note bad' }, Ed.errorText(err), ' ', h('a', { href: '#/', text: 'All datasets' })));
    });
  });

  function datasetPage(page, ds, rights) {
    Ed.clear(page);
    var native = ds.mode === 'native';
    var acts = h('div', { class: 'ed-acts' });
    page.appendChild(h('div', { class: 'ed-head' }, h('h1', null, ds.label, ' ', modeBadge(ds.mode)), acts));
    if (!native) {
      page.appendChild(h('div', { class: 'ed-note' }, Ed.icon('lock'),
        h('span', { text: 'This is a copy of ' + (ds.sourceType === 'google_sheet' ? 'a Google Sheet' : ds.sourceType.indexOf('supabase') === 0 ? 'Supabase data' : 'its source') + ', refreshed by the sync. Make changes in the original; changes here would be overwritten by the next sync.' }),
        ds.sourceUrl ? h('a', { class: 'ui-btn sm', href: ds.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, Ed.icon('arrow'), h('span', { text: 'Open original' })) : null));
    } else {
      page.appendChild(h('div', { class: 'ed-note' + (rights.edit || rights.add || rights.delete ? '' : ' warn') },
        h('span', { text: (ds.createdHere ? 'Created in this editor' : 'The VM is the source of this dataset' + (ds.nativeSince ? ' since ' + Ed.when(ds.nativeSince) : '')) + '. Saved changes reach the reports at once. ' }),
        h('span', { class: 'ed-muted', text: 'You may ' + rightsText(rights) + (rights.scope ? ' (' + rights.scope + ')' : '') + '.' })));
    }
    // Toolbar
    var q = h('input', { class: 'ui-input', type: 'search', placeholder: 'Search', 'aria-label': 'Search rows' });
    var chips = h('div', { class: 'ed-chips' });
    var filterBtn = Ed.btn('Filter', { icon: 'filter' });
    var bar = h('div', { class: 'ed-bar' }, h('div', { class: 'ui-search' }, Ed.icon('search'), q), filterBtn, chips, h('span', { class: 'ed-sp', style: 'flex:1' }));
    page.appendChild(bar);
    var gridHost = h('div');
    page.appendChild(gridHost);
    var info = h('span');
    var pendingBox = h('span');
    var foot = h('div', { class: 'ed-foot' }, info, h('span', { class: 'ed-sp' }), pendingBox);
    page.appendChild(foot);

    var grid = new Ed.Grid(gridHost, {
      ds: ds, rights: rights,
      onStatus: function (s) { info.textContent = Ed.n(s.total) + ' rows' + (s.rows > s.total ? ' + ' + (s.rows - s.total) + ' new' : '') + (s.selCells > 1 ? ' · ' + Ed.n(s.selCells) + ' cells selected' : ''); },
      onChange: function (label) { drawPending(); if (label === 'paste') setTimeout(review, 50); }
    });
    grid.onSave = review;
    Ed.setLeaveGuard(function () { return !grid.pendingCount() || w.confirm('You have unsaved changes. Leave without saving?'); });

    function drawPending() {
      var n = grid.pendingCount();
      Ed.clear(pendingBox);
      if (!n) return;
      pendingBox.appendChild(h('span', { class: 'ed-pending' }, h('b', { text: n + ' unsaved change(s)' }),
        Ed.btn('Undo', { icon: 'undo', title: 'Undo the last change on this page (Ctrl+Z)', on: function () { grid.undo(); } }),
        Ed.btn('Discard', { on: function () { Ed.confirm('Discard changes', 'Drop all ' + n + ' unsaved change(s)?', 'Discard').then(function (ok) { if (ok) grid.discard(); }); } }),
        Ed.btn('Review and save', { cls: 'sm primary', on: review })));
    }
    function review() { Ed.review(grid, { kind: 'edit', onDone: saved }); }
    function saved(r) {
      var c = r.counts || {};
      var msg = 'Saved: ' + [c.added ? c.added + ' added' : '', c.changed ? c.changed + ' changed' : '', c.deleted ? c.deleted + ' deleted' : ''].filter(Boolean).join(', ') + '.';
      if (r.snapshot && r.snapshot.error) msg += ' ' + r.snapshot.error;
      Ed.toast(msg);
      if (r.batchId) {
        Ed.clear(pendingBox).appendChild(h('span', { class: 'ed-pending' }, h('span', { text: msg }), Ed.btn('Undo this save', { icon: 'undo', on: function () { undoBatch(ds, r.batchId, grid); } })));
      }
    }

    // Toolbar actions
    if (native && rights.add) acts.appendChild(Ed.btn('Add row', { icon: 'plus', on: function () { grid.addRows(1); grid.startEdit(null); } }));
    if (native && rights.delete) acts.appendChild(Ed.btn('Delete rows', { icon: 'trash', title: 'Mark the selected rows for deletion', on: function () { grid.deleteSelected(); } }));
    if (native && rights.add) acts.appendChild(Ed.btn('Import file', { icon: 'upload', title: 'Add rows from a CSV or TSV file', on: function () { importFile(grid); } }));
    if (native && (rights.add || rights.edit)) acts.appendChild(Ed.btn('Paste', { title: 'Paste with Ctrl+V / Cmd+V in the sheet, or here', on: function () { pasteButton(grid); } }));
    acts.appendChild(h('a', { class: 'ui-btn sm', href: '#', title: 'Download the rows that match the search and filters', on: { click: function (e) { e.preventDefault(); location.href = grid.exportUrl(); } } }, Ed.icon('download'), h('span', { text: 'Export CSV' })));
    acts.appendChild(Ed.btn('History', { icon: 'clock', on: function () { historyDrawer(ds, grid); } }));
    if (rights.admin && !ds.createdHere) {
      acts.appendChild(native ? Ed.btn('Return to the original…', { on: function () { releaseDlg(ds); } })
        : Ed.btn('Edit on the VM instead…', { title: 'Make the VM the source of this dataset (admins)', on: function () { takeoverDlg(ds); } }));
    }

    q.addEventListener('input', debounce(function () { grid.query.q = q.value; grid.requery(); }, 300));
    filterBtn.addEventListener('click', function () { filterPop(grid, filterBtn, drawChips); });
    function drawChips() {
      Ed.clear(chips);
      grid.query.filters.forEach(function (f, i) {
        var col = ds.columns.filter(function (c) { return c.name === f.field; })[0];
        var x = h('button', { type: 'button', 'aria-label': 'Remove filter', text: '×' });
        x.addEventListener('click', function () { grid.query.filters.splice(i, 1); drawChips(); grid.requery(); });
        chips.appendChild(h('span', { class: 'ed-chip' }, (col ? col.label : f.field) + ' ' + opLabel(f.op) + (f.value != null && f.value !== '' ? ' ' + f.value : ''), x));
      });
    }
    grid.focus();
  }

  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  var OPS = {
    text: [['contains', 'contains'], ['ncontains', 'does not contain'], ['eq', 'is'], ['neq', 'is not'], ['starts', 'starts with'], ['empty', 'is empty'], ['nempty', 'is not empty']],
    number: [['eq', '='], ['neq', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['empty', 'is empty'], ['nempty', 'is not empty']],
    date: [['on', 'on'], ['before', 'before'], ['after', 'on or after'], ['empty', 'is empty'], ['nempty', 'is not empty']],
    bool: [['true', 'is yes'], ['false', 'is no'], ['empty', 'is empty']],
    json: [['contains', 'contains']]
  };
  function opLabel(op) {
    var out = op;
    Object.keys(OPS).forEach(function (t) { OPS[t].forEach(function (o) { if (o[0] === op) out = o[1]; }); });
    return out;
  }

  function filterPop(grid, anchor, onDone) {
    var old = document.querySelector('.ed-pop');
    if (old) { old.parentNode.removeChild(old); return; }
    var colSel = h('select', { class: 'ui-input', 'aria-label': 'Column' });
    grid.cols.forEach(function (c) { colSel.appendChild(h('option', { value: c.name, text: (c.label || c.name) + ' (' + c.type + ')' })); });
    var opSel = h('select', { class: 'ui-input', 'aria-label': 'Condition' });
    var val = h('input', { class: 'ui-input', 'aria-label': 'Value' });
    function ops() {
      var col = grid.cols[colSel.selectedIndex];
      Ed.clear(opSel);
      (OPS[col.type] || OPS.text).forEach(function (o) { opSel.appendChild(h('option', { value: o[0], text: o[1] })); });
      val.type = col.type === 'date' ? 'date' : 'text';
      vis();
    }
    function vis() { val.hidden = /^(empty|nempty|true|false)$/.test(opSel.value); }
    colSel.addEventListener('change', ops);
    opSel.addEventListener('change', vis);
    var pop = h('div', { class: 'ed-pop', role: 'dialog', 'aria-label': 'Add filter' }, colSel, opSel, val,
      h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' }, Ed.btn('Cancel', { on: function () { pop.remove(); } }),
        Ed.btn('Add filter', { cls: 'sm primary', on: function () {
          grid.query.filters.push({ field: colSel.value, op: opSel.value, value: val.hidden ? '' : val.value });
          pop.remove(); onDone(); grid.requery();
        } })));
    var r = anchor.getBoundingClientRect();
    pop.style.top = (r.bottom + w.scrollY + 6) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left + w.scrollX, w.innerWidth - 296)) + 'px';
    document.body.appendChild(pop);
    ops();
    colSel.focus();
  }

  function pasteButton(grid) {
    if (navigator.clipboard && navigator.clipboard.read) {
      navigator.clipboard.read().then(function (items) {
        var it = items[0];
        if (!it) return grid.pasteRows([], '');
        var want = it.types.indexOf('text/plain') >= 0 ? 'text/plain' : it.types.indexOf('text/html') >= 0 ? 'text/html' : null;
        if (!want) return grid.pasteRows([], '');
        return it.getType(want).then(function (b) { return b.text(); }).then(function (t) {
          grid.pasteRows(want === 'text/plain' ? EdClip.parseTsv(t) : EdClip.parseHtml(t), want === 'text/plain' ? 'text' : 'html');
        });
      }).catch(function () { Ed.toast('Click a cell and press Ctrl+V (Cmd+V on a Mac) to paste.'); });
    } else Ed.toast('Click a cell and press Ctrl+V (Cmd+V on a Mac) to paste.');
  }

  function importFile(grid) {
    var input = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/tab-separated-values' });
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (!f) return;
      if (f.size > 4 * 1024 * 1024) { Ed.toast('Import files up to 4 MB at a time (split bigger files).'); return; }
      f.text().then(function (t) {
        var first = t.split(/\r?\n/, 1)[0] || '';
        var d = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ',';
        var rows = EdClip.parseDelimited(t, d);
        var hm = rows.length ? EdClip.headerMatch(rows[0], grid.cols) : null;
        if (!hm || !hm.isHeader) { Ed.toast('The file\'s first row must name the columns (as in the sheet).'); return; }
        // New rows at the end, columns matched by name.
        grid.sel = { ar: grid.rowCount(), ac: 0, fr: grid.rowCount(), fc: 0 };
        grid.pasteRows(rows, 'file');
      });
    });
    input.click();
  }

  function undoBatch(ds, batchId, grid) {
    Ed.confirm('Undo a save', 'Undo every change of this save? It works only if none of its rows changed since.', 'Undo').then(function (ok) {
      if (!ok) return;
      Ed.api('POST', '/datasets/' + ds.key + '/batches/' + batchId + '/undo', { idempotencyKey: Ed.idemKey() }).then(function () {
        Ed.toast('Undone.');
        if (grid) grid.afterCommit();
      }, function (err) {
        var c = err.body && err.body.conflicts;
        Ed.toast(Ed.errorText(err) + (c && c.length ? ' Rows: ' + c.slice(0, 8).map(function (x) { return x.row_no; }).join(', ') : ''));
      });
    });
  }

  /* ---------- History ---------- */
  function historyDrawer(ds, grid) {
    var m = Ed.modal('History · ' + ds.label);
    var box = h('div', null, h('p', { class: 'ed-muted', text: 'Loading…' }));
    m.body.appendChild(box);
    m.foot.appendChild(Ed.btn('Close', { on: m.close }));
    function load(page) {
      Ed.api('GET', '/datasets/' + ds.key + '/history?page=' + page).then(function (r) {
        Ed.clear(box);
        if (!r.batches.length) { box.appendChild(h('p', { class: 'ed-muted', text: ds.mode === 'native' ? 'No changes yet.' : 'This dataset is a copy: it changes in its original, not here.' })); return; }
        var tb = h('tbody');
        r.batches.forEach(function (b) {
          var view = Ed.btn('Details', { on: function () { details(b); } });
          tb.appendChild(h('tr', null, h('td', { text: Ed.when(b.at) }), h('td', { text: b.user }), h('td', { text: kindText(b.kind) }), h('td', { text: b.summary }),
            h('td', null, b.status === 'undone' ? h('span', { class: 'ed-badge', text: 'undone' }) : null),
            h('td', null, b.kind !== 'takeover' && b.kind !== 'release' && b.kind !== 'create_dataset' ? view : null, ' ',
              b.canUndo && ds.mode === 'native' ? Ed.btn('Undo', { icon: 'undo', on: function () { m.close(); undoBatch(ds, b.id, grid); } }) : null)));
        });
        box.appendChild(h('div', { class: 'ed-tw', style: 'max-height:60vh' }, h('table', { class: 'ed-t' }, h('thead', null, h('tr', null,
          h('th', { text: 'When (IST)' }), h('th', { text: 'Who' }), h('th', { text: 'What' }), h('th', { text: 'Summary' }), h('th', { text: '' }), h('th', { text: '' }))), tb)));
        if (r.totalPages > 1) box.appendChild(h('div', { style: 'margin-top:8px;display:flex;gap:8px' },
          page > 1 ? Ed.btn('Newer', { on: function () { load(page - 1); } }) : null, page < r.totalPages ? Ed.btn('Older', { on: function () { load(page + 1); } }) : null));
      }, function (err) { Ed.clear(box).appendChild(h('div', { class: 'ed-note bad', text: Ed.errorText(err) })); });
    }
    function details(b) {
      Ed.api('GET', '/datasets/' + ds.key + '/batches/' + b.id).then(function (r) {
        var d = Ed.modal(kindText(r.batch.kind) + ' · ' + Ed.when(r.batch.at));
        d.body.appendChild(h('p', { text: r.batch.user + ' · ' + r.batch.summary }));
        var tb = h('tbody');
        r.changes.forEach(function (c) {
          var det = h('td');
          r.columns.forEach(function (name, i) {
            var a = c.before ? c.before[i] : null;
            var z = c.after ? c.after[i] : null;
            if (c.op === 'update' && a !== z) det.appendChild(h('div', null, h('b', { text: name + ': ' }), h('span', { style: 'color:var(--mzo-bad);text-decoration:line-through', text: a || '(empty)' }), ' → ', h('span', { class: 'new', text: z || '(empty)' })));
            if (c.op !== 'update' && (c.after || c.before) && (z || a)) det.appendChild(h('div', null, h('b', { text: name + ': ' }), String(z || a)));
          });
          tb.appendChild(h('tr', { class: c.op === 'create' ? 'add' : c.op === 'delete' ? 'del' : '' }, h('td', { text: String(c.row_no || '') }), h('td', { text: c.op }), det));
        });
        d.body.appendChild(h('div', { class: 'ed-tw' }, h('table', { class: 'ed-t' }, h('thead', null, h('tr', null, h('th', { text: 'Row' }), h('th', { text: 'Change' }), h('th', { text: 'Values' }))), tb)));
        if (r.more) d.body.appendChild(h('p', { class: 'ed-small ed-muted', text: 'Showing the first 500 rows of this change.' }));
        d.foot.appendChild(Ed.btn('Close', { on: d.close }));
      }, function (err) { Ed.toast(Ed.errorText(err)); });
    }
    load(1);
  }
  function kindText(k) {
    return { edit: 'Edit', paste: 'Paste', import: 'Import', add: 'Rows added', delete: 'Rows deleted', commit: 'Edit', undo: 'Undo', takeover: 'VM took over', release: 'Back to the original', create_dataset: 'Dataset created' }[k] || k;
  }

  /* ---------- Mode switch (admins) ---------- */
  function takeoverDlg(ds) {
    var m = Ed.modal('Edit ' + ds.label + ' on the VM', { small: true });
    m.body.appendChild(h('p', { class: 'ed-muted', text: 'Checking that the reports will read this dataset exactly as before…' }));
    m.foot.appendChild(Ed.btn('Cancel', { on: m.close }));
    Ed.api('GET', '/datasets/' + ds.key + '/native-check').then(function (r) {
      Ed.clear(m.body);
      if (!r.eligible) {
        m.body.appendChild(h('div', { class: 'ed-note bad' }, 'This dataset cannot be edited on the VM:'));
        var ul = h('ul');
        r.reasons.forEach(function (x) { ul.appendChild(h('li', { text: x })); });
        m.body.appendChild(ul);
        return;
      }
      var p = r.info.parity || {};
      [
        'After this, the VM is the source of "' + ds.label + '": the sync stops copying it from the original, and its rows are edited here. Edits made in the original sheet will no longer reach the reports.',
        'First the VM takes one last fresh copy from the original. Checked now: ' + Ed.n(r.info.rows) + ' rows; the reports\' file comes back byte for byte' + (p.blankRowsDropped ? ' (except ' + p.blankRowsDropped + ' empty rows, which the reports skip anyway)' : '') + '.',
        'Tell the people who edit the original sheet to stop. An admin can return the dataset to the original later; VM edits are then replaced by the original.'
      ].forEach(function (t) { m.body.appendChild(h('p', { text: t })); });
      var input = h('input', { class: 'ui-input', placeholder: ds.key });
      m.body.appendChild(h('label', { class: 'f' }, 'Type ', h('b', { text: ds.key }), ' to confirm', input));
      var go = Ed.btn('Make the VM the source', { cls: 'sm primary' });
      m.foot.appendChild(go);
      go.addEventListener('click', function () {
        if (input.value.trim() !== ds.key) { input.focus(); return; }
        go.disabled = true;
        go.querySelector('span').textContent = 'Taking the last copy…';
        Ed.api('POST', '/datasets/' + ds.key + '/mode', { mode: 'native', confirm: ds.key }).then(function () {
          m.close(); Ed.toast('Done: ' + ds.label + ' is now edited on the VM.'); Ed.render();
        }, function (err) { go.disabled = false; go.querySelector('span').textContent = 'Make the VM the source'; m.body.appendChild(h('div', { class: 'ed-note bad', text: Ed.errorText(err) })); });
      });
    }, function (err) { Ed.clear(m.body).appendChild(h('div', { class: 'ed-note bad', text: Ed.errorText(err) })); });
  }

  function releaseDlg(ds) {
    var m = Ed.modal('Return ' + ds.label + ' to the original', { small: true });
    m.body.appendChild(h('div', { class: 'ed-note bad' }, h('b', { text: 'Every change made on the VM will be replaced by the original sheet.' })));
    m.body.appendChild(h('p', { text: 'The sync copies the original again within minutes and overwrites the rows edited here since ' + Ed.when(ds.nativeSince) + '. Copy anything you need into the original first (Export CSV). The edit history is kept.' }));
    var input = h('input', { class: 'ui-input', placeholder: ds.key });
    m.body.appendChild(h('label', { class: 'f' }, 'Type ', h('b', { text: ds.key }), ' to confirm', input));
    var go = Ed.btn('Replace VM edits with the original', { cls: 'sm primary' });
    m.foot.appendChild(Ed.btn('Cancel', { on: m.close }));
    m.foot.appendChild(go);
    go.addEventListener('click', function () {
      if (input.value.trim() !== ds.key) { input.focus(); return; }
      go.disabled = true;
      Ed.api('POST', '/datasets/' + ds.key + '/mode', { mode: 'mirror', confirm: ds.key }).then(function () {
        m.close(); Ed.toast(ds.label + ' follows its original again.'); Ed.render();
      }, function (err) { go.disabled = false; m.body.appendChild(h('div', { class: 'ed-note bad', text: Ed.errorText(err) })); });
    });
  }

  /* ---------- New dataset (admins) ---------- */
  Ed.route(/^\/new$/, function () {
    var page = Ed.shell('New dataset');
    if (!Ed.me.isAdmin) { page.appendChild(h('div', { class: 'ed-note bad', text: 'Only an admin can create datasets.' })); return; }
    page.appendChild(h('div', { class: 'ed-head' }, h('h1', { text: 'New dataset' })));
    var key = h('input', { class: 'ui-input', placeholder: 'e.g. feeder_inspections', maxlength: '40' });
    var label = h('input', { class: 'ui-input', placeholder: 'e.g. Feeder inspections' });
    var group = h('select', { class: 'ui-input' });
    ['New service connection', 'Revenue', 'DD visit', 'Consumers & meters', 'Vendor advances', 'Substation & network', 'Important', 'Administration'].forEach(function (g) { group.appendChild(h('option', { value: g, text: g, selected: g === 'Important' })); });
    var block = h('textarea', { class: 'ui-input', rows: '8', placeholder: 'Paste rows from a sheet here, first row the column names. Or type one column name per line.' });
    var colsBox = h('div');
    var create = Ed.btn('Create dataset', { cls: 'sm primary' });
    var form = h('div', { class: 'ed-list', style: 'padding:16px;max-width:860px' },
      h('label', { class: 'f' }, 'Key (lowercase, digits and _; it can never change)', key),
      h('label', { class: 'f' }, 'Name', label),
      h('label', { class: 'f' }, 'Group in the menu', group),
      h('label', { class: 'f' }, 'Columns', block), colsBox,
      h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px' }, create));
    page.appendChild(form);
    var parsed = { header: [], rows: [] };
    var types = [];
    var pk = '';
    label.addEventListener('input', function () { if (!key.dataset.touched) key.value = label.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'd_$1').slice(0, 40); });
    key.addEventListener('input', function () { key.dataset.touched = '1'; });
    block.addEventListener('input', debounce(read, 250));
    function guess(values) {
      var v = values.filter(function (x) { return String(x).trim() !== ''; });
      if (!v.length) return 'text';
      if (v.every(function (x) { return /^-?(\d{1,3}(,\d{3})+|\d{1,2}(,\d{2})+,\d{3}|\d+)?(\.\d+)?$/.test(x.trim()) && /\d/.test(x) && !/^0\d/.test(x.trim()); })) return 'number';
      if (v.every(function (x) { return /^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}$|^\d{4}-\d{2}-\d{2}$/.test(x.trim()); })) return 'date';
      if (v.every(function (x) { return /^(y|n|yes|no|true|false)$/i.test(x.trim()); })) return 'bool';
      return 'text';
    }
    function read() {
      var text = block.value;
      var rows = text.indexOf('\t') >= 0 ? EdClip.parseTsv(text) : text.split(/\r?\n/).map(function (l) { return [l]; }).filter(function (r) { return r[0].trim(); });
      if (text.indexOf('\t') < 0) parsed = { header: rows.map(function (r) { return r[0].trim(); }), rows: [] };
      else parsed = { header: (rows[0] || []).map(function (x) { return x.trim(); }), rows: rows.slice(1) };
      types = parsed.header.map(function (_, i) { return guess(parsed.rows.map(function (r) { return r[i] || ''; })); });
      drawCols();
    }
    function drawCols() {
      Ed.clear(colsBox);
      if (!parsed.header.length) return;
      var tb = h('tbody');
      parsed.header.forEach(function (name, i) {
        var sel = h('select', { class: 'ui-input', 'aria-label': 'Type of ' + name });
        ['text', 'number', 'date', 'bool'].forEach(function (t) { sel.appendChild(h('option', { value: t, text: t === 'bool' ? 'yes / no' : t === 'date' ? 'date (dd/mm/yyyy)' : t, selected: types[i] === t })); });
        sel.addEventListener('change', function () { types[i] = sel.value; });
        var key1 = h('input', { type: 'radio', name: 'pk', checked: pk === name, 'aria-label': 'Key column' });
        key1.addEventListener('change', function () { pk = name; });
        tb.appendChild(h('tr', null, h('td', { text: name || '(no name)' }), h('td', null, sel), h('td', null, key1)));
      });
      colsBox.appendChild(h('div', { class: 'ed-tw', style: 'max-height:40vh' }, h('table', { class: 'ed-t' }, h('thead', null, h('tr', null, h('th', { text: 'Column' }), h('th', { text: 'Type' }), h('th', { text: 'Unique key (optional)' }))), tb)));
      colsBox.appendChild(h('p', { class: 'ed-small ed-muted', text: parsed.rows.length ? parsed.rows.length + ' row(s) will be added after you review them.' : 'No rows yet: add or paste them after creating the dataset.' }));
    }
    create.addEventListener('click', function () {
      if (!parsed.header.length) { Ed.toast('Give at least one column.'); return; }
      create.disabled = true;
      Ed.api('POST', '/datasets', { key: key.value.trim(), label: label.value.trim(), group: group.value, primaryKey: pk ? [pk] : [],
        columns: parsed.header.map(function (n, i) { return { source_name: n, type: types[i] }; }) }).then(function (r) {
        Ed.toast('Created ' + r.key + '.');
        var rows = [parsed.header].concat(parsed.rows);
        location.hash = '#/d/' + r.key;
        if (parsed.rows.length) {
          var wait = setInterval(function () {
            var g = document.querySelector('.ed-grid');
            if (!g || !Ed._lastGrid) return;
            clearInterval(wait);
            Ed._lastGrid.pasteRows(rows, 'new');
          }, 200);
          setTimeout(function () { clearInterval(wait); }, 10000);
        }
      }, function (err) { create.disabled = false; Ed.toast(Ed.errorText(err)); });
    });
  });

  // The dataset page keeps a handle on its grid (new datasets paste their first rows through it).
  var origGrid = Ed.Grid;
  Ed.Grid = function (host, opts) { var g = new origGrid(host, opts); Ed._lastGrid = g; return g; };
  Ed.Grid.prototype = origGrid.prototype;

  /* ---------- Permissions (admins) ---------- */
  Ed.route(/^\/permissions$/, function (m, params) {
    var page = Ed.shell('Permissions');
    if (!Ed.me.isAdmin) { page.appendChild(h('div', { class: 'ed-note bad', text: 'Only an admin can manage permissions.' })); return; }
    var email = (params.get('email') || '').trim().toLowerCase();
    page.appendChild(h('div', { class: 'ed-head' }, h('h1', { text: 'Who can edit what' })));
    var grid = h('div', { class: 'ed-perm-grid' });
    var left = h('div');
    var right = h('div');
    grid.appendChild(left); grid.appendChild(right);
    page.appendChild(grid);
    var datasets = [];
    var users = [];
    Promise.all([Ed.api('GET', '/datasets'), Ed.api('GET', '/users').catch(function () { return { users: [], source: 'none' }; })]).then(function (rs) {
      datasets = rs[0].datasets;
      users = rs[1].users;
      drawUsers(rs[1].source);
      if (email) showUser(email);
      else right.appendChild(h('p', { class: 'ed-muted', text: 'Pick a user, or type an email address.' }));
    }, function (err) { page.appendChild(h('div', { class: 'ed-note bad', text: Ed.errorText(err) })); });

    function drawUsers(source) {
      Ed.clear(left);
      var input = h('input', { class: 'ui-input', type: 'email', placeholder: 'Email address', value: email, 'aria-label': 'Email address' });
      var go = Ed.btn('Open', { on: function () { var e = input.value.trim().toLowerCase(); if (e) location.hash = '#/permissions?email=' + encodeURIComponent(e); } });
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); });
      left.appendChild(h('div', { style: 'display:flex;gap:8px;margin-bottom:8px' }, input, go));
      var box = h('div', { class: 'ed-users' });
      users.forEach(function (u) {
        box.appendChild(h('button', { type: 'button', 'aria-pressed': u.email === email ? 'true' : 'false', on: { click: function () { location.hash = '#/permissions?email=' + encodeURIComponent(u.email); } } },
          u.name || u.email, h('small', { text: u.email + (u.role ? ' · ' + u.role : '') })));
      });
      if (!users.length) box.appendChild(h('p', { class: 'ed-small ed-muted', style: 'padding:10px', text: 'No users listed yet' + (source === 'app_users' ? '.' : ' (the VM user list is not installed; type an email).') }));
      left.appendChild(box);
    }

    function showUser(em) {
      Ed.clear(right).appendChild(h('p', { class: 'ed-muted', text: 'Loading…' }));
      Ed.api('GET', '/permissions?email=' + encodeURIComponent(em)).then(function (r) {
        var have = {};
        r.permissions.forEach(function (p) { have[p.dataset_key] = p; });
        Ed.clear(right);
        var u = users.filter(function (x) { return x.email === em; })[0];
        right.appendChild(h('h2', { style: 'margin:0 0 4px;font-size:15px', text: em }));
        if (u && u.role === 'admin') right.appendChild(h('div', { class: 'ed-note' }, 'This user is an admin and can already do everything.'));
        right.appendChild(h('p', { class: 'ed-small ed-muted', text: 'Tick what this user may do in each dataset. "Own office only" limits them to rows of the office in their login. Writing is possible only in datasets edited on the VM; for copies, only viewing applies. Sensitive datasets stay admin-only.' }));
        var filter = h('input', { class: 'ui-input', type: 'search', placeholder: 'Find a dataset', 'aria-label': 'Find a dataset' });
        var tb = h('tbody');
        var state = {};
        var rowsAll = [{ key: '*', label: 'Every dataset (default)', mode: '', group: '' }].concat(datasets);
        rowsAll.forEach(function (d) {
          var p = have[d.key] || {};
          var s = state[d.key] = { can_view: !!p.can_view, can_add: !!p.can_add, can_edit: !!p.can_edit, can_delete: !!p.can_delete, scope_only: !!p.scope_only, had: !!have[d.key], notes: p.notes || '' };
          var tr = h('tr', { 'data-k': d.key + ' ' + d.label.toLowerCase() });
          tr.appendChild(h('td', null, h('div', { text: d.label }), h('div', { class: 'ed-small ed-muted', text: d.key === '*' ? 'applies where a dataset has no row of its own' : d.key + (d.mode === 'native' ? ' · edited here' : ' · copy') })));
          ['can_view', 'can_add', 'can_edit', 'can_delete', 'scope_only'].forEach(function (k) {
            var cb = h('input', { type: 'checkbox', checked: s[k], 'aria-label': k.replace('can_', '') + ' ' + d.label });
            cb.addEventListener('change', function () { s[k] = cb.checked; s.dirty = true; });
            tr.appendChild(h('td', { style: 'text-align:center' }, cb));
          });
          tb.appendChild(tr);
        });
        filter.addEventListener('input', function () {
          var t = filter.value.trim().toLowerCase();
          Array.prototype.forEach.call(tb.children, function (tr) { tr.hidden = !!t && tr.getAttribute('data-k').indexOf(t) < 0; });
        });
        var save = Ed.btn('Save', { cls: 'sm primary' });
        var bulk = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:8px 0' }, filter,
          Ed.btn('Tick view on shown', { on: function () { setShown('can_view', true); } }),
          Ed.btn('Tick edit on shown', { on: function () { setShown('can_edit', true); } }),
          Ed.btn('Clear shown', { on: function () { ['can_view', 'can_add', 'can_edit', 'can_delete', 'scope_only'].forEach(function (k) { setShown(k, false); }); } }));
        function setShown(k, v) {
          Array.prototype.forEach.call(tb.children, function (tr) {
            if (tr.hidden) return;
            var key = tr.getAttribute('data-k').split(' ')[0];
            state[key][k] = v; state[key].dirty = true;
            var idx = ['can_view', 'can_add', 'can_edit', 'can_delete', 'scope_only'].indexOf(k);
            tr.children[idx + 1].firstChild.checked = v;
          });
        }
        right.appendChild(bulk);
        right.appendChild(h('div', { class: 'ed-tw', style: 'max-height:58vh' }, h('table', { class: 'ed-t' }, h('thead', null, h('tr', null,
          h('th', { text: 'Dataset' }), h('th', { text: 'View' }), h('th', { text: 'Add' }), h('th', { text: 'Edit' }), h('th', { text: 'Delete' }), h('th', { text: 'Own office only' }))), tb)));
        right.appendChild(h('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:10px' }, save));
        save.addEventListener('click', function () {
          var grants = [];
          var revoke = [];
          Object.keys(state).forEach(function (k) {
            var s = state[k];
            if (!s.dirty) return;
            var any = s.can_view || s.can_add || s.can_edit || s.can_delete;
            if (any) grants.push({ user_email: em, dataset_key: k, can_view: s.can_view, can_add: s.can_add, can_edit: s.can_edit, can_delete: s.can_delete, scope_only: s.scope_only, notes: s.notes });
            else if (s.had) revoke.push({ user_email: em, dataset_key: k });
          });
          if (!grants.length && !revoke.length) { Ed.toast('Nothing changed.'); return; }
          save.disabled = true;
          var p1 = grants.length ? Ed.api('POST', '/permissions', { grants: grants }) : Promise.resolve();
          p1.then(function () { return revoke.length ? Ed.api('POST', '/permissions/revoke', { items: revoke }) : null; }).then(function () {
            Ed.toast('Saved for ' + em + '.');
            if (!users.some(function (x) { return x.email === em; })) users.push({ email: em, name: '', role: '' });
            showUser(em);
          }, function (err) { save.disabled = false; Ed.toast(Ed.errorText(err)); });
        });
      }, function (err) { Ed.clear(right).appendChild(h('div', { class: 'ed-note bad', text: Ed.errorText(err) })); });
    }
  });
})(window);
