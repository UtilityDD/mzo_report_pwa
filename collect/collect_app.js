/* DISHA Collect client — side nav + right work. See docs/collect.md */
(function () {
  'use strict';

  var tab = 'inbox';
  var mode = 'list'; // list | create | fill | detail
  var canCreate = false;
  var collectOff = false;
  var officeOpts = [];
  var userOpts = [];
  var selectedOffices = {};
  var selectedUsers = {};
  var schemaFields = [];
  var selectedFieldId = null;
  var uid = 0;
  var wizStep = 1;
  var fillState = null;
  var detailState = null;
  var fillFrom = null;   // request id when a fill was opened from the requester's office list
  var fillDirty = false;
  var saving = false;
  var mineAfterConflict = null; // the user's own entries kept after a 409
  var TYPES = [
    { v: 'text', n: 'Text' },
    { v: 'number', n: 'Number' },
    { v: 'checkbox', n: 'Yes/No' },
    { v: 'date', n: 'Date' },
    { v: 'textarea', n: 'Long text' },
    { v: 'group', n: 'Table' }
  ];
  var TYPE_LABEL = { text: 'Text', number: 'Number', checkbox: 'Yes/No', date: 'Date', textarea: 'Long', group: 'Table' };
  var STATUS_LABEL = {
    pending: 'Not started', in_progress: 'Draft saved', submitted: 'Submitted',
    returned: 'Returned for correction', withdrawn: 'Withdrawn', open: 'Open', closed: 'Closed'
  };
  var LEVEL_LABEL = { region: 'Region (RM)', division: 'Division (DM)', ccc: 'Station / CCC (SM)', zone: 'Zone' };
  // Same limits as lib/collect.js LIMITS (the server refuses anything over them).
  var LIMITS = { fields: 150, depth: 4, offices: 200, rows: 500, text: 2000, textarea: 10000, payloadBytes: 800 * 1024, horizonMs: 366 * 86400000 };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function nextId() { uid += 1; return 'f' + uid; }
  function newField(type, label) {
    return { id: nextId(), type: type || 'text', label: label || '', required: false, options: '', children: [] };
  }
  function officeKey(o) {
    return [o.level, o.region || '', o.division || '', o.ccc_code || ''].join('|');
  }
  function fmtLeft(ms) {
    if (ms == null) return '';
    if (ms <= 0) return '0m';
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }
  function statusLabel(s) { return STATUS_LABEL[s] || String(s || ''); }
  function fmtWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }
  /** "Due 12 Nov, 5:00 pm" plus the late window when there is one. */
  function dueText(timing) {
    if (!timing || !timing.due_at) return '';
    var t = 'Due ' + fmtWhen(timing.due_at);
    if (timing.extended_due_at && timing.open_until && timing.open_until !== timing.due_at) {
      t += ' · late entries until ' + fmtWhen(timing.extended_due_at);
    }
    return t;
  }
  function chipsHtml(timing, status) {
    var h = '';
    if (status === 'submitted') h += '<span class="chip ok">Submitted</span>';
    else if (status === 'returned') h += '<span class="chip late">Returned for correction</span>';
    else if (status === 'withdrawn') h += '<span class="chip">Withdrawn</span>';
    if (status === 'submitted' || status === 'withdrawn') return h;
    if (timing && timing.locked) h += '<span class="chip locked">Deadline passed</span>';
    else if (timing && timing.late) h += '<span class="chip late">Late · ' + esc(fmtLeft(timing.ms_left)) + ' left</span>';
    else if (timing && timing.ms_left != null) h += '<span class="chip clock">' + esc(fmtLeft(timing.ms_left)) + ' left</span>';
    return h;
  }
  function cardClass(item) {
    var c = 'col-card';
    if (item.status === 'submitted') return c;
    if (item.timing && item.timing.locked) return c + ' locked';
    if (item.timing && (item.timing.late || (item.timing.ms_left != null && item.timing.ms_left < 86400000))) return c + ' due';
    return c;
  }
  // Server messages that are worded for developers, in plain words for field officers.
  var PLAIN = [
    [/^due_at is required/i, 'Pick a deadline.'],
    [/^due_at must be in the future/i, 'The deadline must be in the future.'],
    [/^due_at must be within a year/i, 'The deadline must be within a year from now.'],
    [/^extended_due_at must be after/i, 'The new time must be after the original deadline.'],
    [/^extended_due_at must be in the future/i, 'The new time must be in the future.'],
    [/^extended_due_at must be within a year/i, 'The new time must be within a year from now.'],
    [/^extended_due_at is (required|invalid)/i, 'Pick a valid date and time.'],
    [/^Report format needs at least one field/i, 'Add at least one column.'],
    [/^Report format nests too deep/i, 'Tables can go at most ' + LIMITS.depth + ' levels deep.'],
    [/^Report format has too many columns/i, 'A report can have at most ' + LIMITS.fields + ' columns.'],
    [/^Pick at most (\d+) offices/i, function (m) { return 'Pick at most ' + m[1] + ' offices at a time.'; }],
    [/^assignment_ids required/i, 'Tick the offices to withdraw.'],
    [/^Office out of your scope: (.*)$/i, function (m) { return m[1] + ' is not under your office.'; }],
    [/^Already submitted/i, 'This report has already been submitted. The requester can return it if changes are needed.'],
    [/^Deadline passed/i, 'The deadline has passed. Ask the requester to extend it.'],
    [/^Request is (not open|closed)/i, 'This request is closed.'],
    [/^Assignment withdrawn/i, 'This report was withdrawn from your office.'],
    [/^Cannot remove a submitted office/i, 'A submitted office cannot be withdrawn. Return it first.'],
    [/^Only users at this office can edit/i, 'Only staff at this office can fill in this report.']
  ];
  function plainError(err) {
    if (!err) return 'Something went wrong. Try again.';
    if (err.network) return 'Could not reach the server. Check your connection and try again.';
    if (err.status === 503) return 'Collect is not available on this server.';
    if (err.status === 401) return 'Your session has ended. Sign in again.';
    if (err.status === 413) return 'This report is too large to save. Shorten long text or use fewer table rows (at most ' + LIMITS.rows + ' rows per table).';
    if (err.status >= 500) return 'The server had a problem. Try again in a minute.';
    if (err.status === 409) return 'Someone at your office saved this form a moment ago.';
    var msg = String(err.message || '');
    for (var i = 0; i < PLAIN.length; i++) {
      var m = PLAIN[i][0].exec(msg);
      if (m) return typeof PLAIN[i][1] === 'function' ? PLAIN[i][1](m) : PLAIN[i][1];
    }
    return msg || 'Something went wrong. Try again.';
  }
  function toast(msg) { if (window.UI && UI.toast) UI.toast(msg); }
  async function api(path, opts) {
    var res;
    try {
      res = await fetch(path, Object.assign({ credentials: 'same-origin', headers: { Accept: 'application/json' } }, opts || {}));
    } catch (e) {
      var ne = new Error('Network error'); ne.network = true; throw ne;
    }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      var err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }
  function emptyHtml(title, text, retry) {
    return '<div class="col-empty">' + (title ? '<b>' + esc(title) + '</b>' : '') + esc(text || '') +
      (retry ? '<br><button type="button" class="col-btn sm" data-retry="1">Try again</button>' : '') + '</div>';
  }
  function loadingHtml() { return '<div class="col-empty" role="status">Loading…</div>'; }
  function showMsg(id, text) {
    var el = $(id);
    el.textContent = text || '';
    el.hidden = !text;
  }
  /** datetime-local value (local time) for a Date. */
  function localInput(d) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function leaveFill() {
    if (mode === 'fill' && fillDirty && !confirm('You have changes that are not saved. Leave without saving?')) return false;
    fillDirty = false;
    return true;
  }

  function setWorkHead(title, sub) {
    $('workTitle').textContent = title;
    $('workSub').textContent = sub || '';
  }
  function paintMainNav() {
    document.querySelectorAll('#mainNav [data-nav]').forEach(function (b) {
      var n = b.getAttribute('data-nav');
      var on = mode === 'list' && ((n === 'inbox' && tab === 'inbox') || (n === 'mine' && tab === 'mine'));
      if (n === 'new') on = mode === 'create';
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }
  function showMode(next) {
    mode = next;
    $('listWrap').hidden = next !== 'list';
    $('newForm').classList.toggle('on', next === 'create');
    $('fillPanel').classList.toggle('on', next === 'fill');
    $('detailPanel').classList.toggle('on', next === 'detail');
    $('mainHead').hidden = next === 'fill' || next === 'detail';
    $('wizNav').hidden = next !== 'create';
    paintFmtVisibility();
    $('mainNav').hidden = next === 'fill' || next === 'detail';
    paintMainNav();
  }
  function paintFmtVisibility() {
    var on = mode === 'create' && wizStep === 3;
    $('fmtTools').hidden = !on;
    document.body.classList.toggle('fmt-open', on);
  }
  function setWizard(step, noFocus) {
    wizStep = step;
    document.querySelectorAll('.wiz-step').forEach(function (el) {
      el.classList.toggle('on', Number(el.getAttribute('data-step')) === step);
    });
    document.querySelectorAll('.wiz-pane').forEach(function (el) {
      el.classList.toggle('on', Number(el.getAttribute('data-pane')) === step);
    });
    document.querySelectorAll('#wizNav [data-wiz]').forEach(function (b) {
      var on = Number(b.getAttribute('data-wiz')) === step;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
    $('wizBack').hidden = step === 1;
    $('wizNext').hidden = step === 3;
    $('fSave').hidden = step !== 3;
    paintFmtVisibility();
    if (step === 3) {
      if (!selectedFieldId && schemaFields[0]) selectedFieldId = schemaFields[0].id;
      paintSchema();
    }
    if (!noFocus && step !== 3) {
      var first = document.querySelector('.wiz-pane.on input');
      if (first) setTimeout(function () { first.focus(); }, 0);
    }
  }

  /* ===== who: offices and people ===== */
  var CHIP_MAX = 12;
  function tierOffices(level) {
    return officeOpts.filter(function (o) { return level === 'all' || o.level === level; });
  }
  function tierFull(level) {
    var list = tierOffices(level);
    return list.length > 0 && list.every(function (o) { return !!selectedOffices[officeKey(o)]; });
  }
  function paintOfficeChips() {
    var keys = Object.keys(selectedOffices);
    var by = { region: 0, division: 0, ccc: 0, zone: 0 };
    keys.forEach(function (k) { var l = selectedOffices[k].level; if (by[l] != null) by[l] += 1; });
    var parts = [];
    if (by.zone) parts.push('the zone');
    if (by.region) parts.push(by.region + (by.region === 1 ? ' region' : ' regions'));
    if (by.division) parts.push(by.division + (by.division === 1 ? ' division' : ' divisions'));
    if (by.ccc) parts.push(by.ccc + (by.ccc === 1 ? ' CCC' : ' CCCs'));
    $('officeSum').innerHTML = keys.length
      ? '<b>' + keys.length + (keys.length === 1 ? ' office' : ' offices') + '</b> selected · ' + esc(parts.join(', ')) +
        (keys.length > LIMITS.offices ? ' — at most ' + LIMITS.offices + ' per request' : '')
      : 'No offices selected yet. Tap a group above or tick offices below.';
    $('officeChips').innerHTML = keys.slice(0, CHIP_MAX).map(function (k) {
      var o = selectedOffices[k];
      return '<span class="sel-chip">' + esc(o.office_label) +
        '<button type="button" data-rm-office="' + esc(k) + '" aria-label="Remove ' + esc(o.office_label) + '">×</button></span>';
    }).join('') + (keys.length > CHIP_MAX ? '<span class="sel-more">+ ' + (keys.length - CHIP_MAX) + ' more</span>' : '');
    document.querySelectorAll('#officeTiles [data-pick]').forEach(function (b) {
      var lv = b.getAttribute('data-pick');
      if (lv === 'none') { b.disabled = !keys.length; return; }
      b.hidden = !tierOffices(lv).length;
      var full = tierFull(lv);
      b.classList.toggle('on', full);
      b.setAttribute('aria-pressed', full ? 'true' : 'false');
    });
  }
  function paintUserChips() {
    var keys = Object.keys(selectedUsers);
    $('userChips').innerHTML = keys.length
      ? keys.map(function (k) {
        var u = selectedUsers[k];
        return '<span class="sel-chip">' + esc(u.name || u.email) +
          '<button type="button" data-rm-user="' + esc(k) + '" aria-label="Remove ' + esc(u.name || u.email) + '">×</button></span>';
      }).join('')
      : '<span style="font-size:12.5px;color:var(--mzo-faint)">Anyone at the selected offices can fill</span>';
  }
  function paintOfficeList() {
    var q = String($('officeSearch').value || '').toLowerCase().trim();
    var all = officeOpts.filter(function (o) {
      if (!q) return true;
      return (o.office_label + ' ' + (LEVEL_LABEL[o.level] || o.level)).toLowerCase().indexOf(q) !== -1;
    });
    var rows = all.slice(0, 80);
    $('officeList').innerHTML = rows.map(function (o) {
      var k = officeKey(o);
      var on = !!selectedOffices[k];
      var sub = LEVEL_LABEL[o.level] || o.level;
      if (o.level === 'ccc' && o.division) sub += ' · ' + o.division + ' Division';
      return '<button type="button" class="' + (on ? 'on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') + '" data-toggle-office="' + esc(k) + '">' +
        '<span class="mark" aria-hidden="true"></span><span class="who"><b>' + esc(o.office_label) +
        '</b><span>' + esc(sub) + '</span></span></button>';
    }).join('') + (all.length > rows.length ? '<div class="pick-note">Showing ' + rows.length + ' of ' + all.length + '. Type to search for more.</div>' : '') ||
      '<div class="pick-note">' + (officeOpts.length ? 'No office matches “' + esc(q) + '”.' : 'No offices under your login.') + '</div>';
  }
  function paintUserList() {
    var q = String($('userSearch').value || '').toLowerCase().trim();
    var officeKeys = Object.keys(selectedOffices);
    var rows = userOpts.filter(function (u) {
      if (officeKeys.length) {
        var hit = officeKeys.some(function (k) {
          var o = selectedOffices[k];
          if (officeKey(u) === k) return true;
          if (o.level === 'region' && u.region === o.region) return true;
          if (o.level === 'division' && u.division === o.division) return true;
          return false;
        });
        if (!hit) return false;
      }
      if (!q) return true;
      return (u.name + ' ' + u.email + ' ' + (u.office_label || '')).toLowerCase().indexOf(q) !== -1;
    }).slice(0, 80);
    $('userList').innerHTML = rows.map(function (u) {
      var on = !!selectedUsers[u.email];
      return '<button type="button" class="' + (on ? 'on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') + '" data-toggle-user="' + esc(u.email) + '">' +
        '<span class="mark" aria-hidden="true"></span><span class="who"><b>' + esc(u.name || u.email) +
        '</b><span>' + esc(u.office_label || u.email) + '</span></span></button>';
    }).join('') || '<div class="pick-note">' + (userOpts.length ? 'No one at the chosen offices matches.' : 'No people list on this server (or pick offices first).') + '</div>';
  }
  /** Tap a group: select every office of that level, or unselect them when all are already selected. */
  function selectTier(level) {
    if (level === 'none') { selectedOffices = {}; selectedUsers = {}; paintUserChips(); }
    else {
      var full = tierFull(level);
      tierOffices(level).forEach(function (o) {
        if (full) delete selectedOffices[officeKey(o)];
        else selectedOffices[officeKey(o)] = o;
      });
    }
    paintOfficeChips();
    paintOfficeList();
    paintUserList();
  }

  /* ===== format: columns on right, tools on left ===== */
  function findPath(list, id, path) {
    path = path || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return path.concat([i]);
      if (list[i].children && list[i].children.length) {
        var p = findPath(list[i].children, id, path.concat([i, 'children']));
        if (p) return p;
      }
    }
    return null;
  }
  function atPath(list, path) {
    var cur = list;
    for (var i = 0; i < path.length; i++) cur = path[i] === 'children' ? cur.children : cur[path[i]];
    return cur;
  }
  function parentList(list, path) {
    var parent = list;
    for (var j = 0; j < path.length - 1; j++) parent = path[j] === 'children' ? parent.children : parent[path[j]];
    return Array.isArray(parent) ? parent : parent.children;
  }
  function depthOf(path) { return path ? (path.length + 1) / 2 : 0; }
  function countFields(list) {
    var n = 0;
    (list || []).forEach(function (f) {
      n += 1;
      if (f.children && f.children.length) n += countFields(f.children);
    });
    return n;
  }
  function nextColumnLabel() {
    var used = {};
    (function walk(list) {
      (list || []).forEach(function (f) { used[String(f.label || '').trim().toLowerCase()] = 1; walk(f.children); });
    })(schemaFields);
    var n = countFields(schemaFields) + 1;
    while (used[('Column' + n).toLowerCase()]) n += 1;
    return 'Column' + n;
  }
  function selectedField() {
    if (!selectedFieldId) return null;
    var path = findPath(schemaFields, selectedFieldId);
    return path ? atPath(schemaFields, path) : null;
  }
  function paintFmtTools() {
    var f = selectedField();
    if (!f) {
      $('fmtSelNote').textContent = 'Select a column on the right.';
      $('fmtToolsBody').hidden = true;
      return;
    }
    var path = findPath(schemaFields, f.id);
    var full = countFields(schemaFields) >= LIMITS.fields;
    var deep = depthOf(path) >= LIMITS.depth;
    $('fmtSelNote').textContent = '“' + (String(f.label || '').trim() || 'Untitled') + '”' +
      (full ? ' · column limit reached (' + LIMITS.fields + ')' : '');
    $('fmtToolsBody').hidden = false;
    $('sideTypes').innerHTML = TYPES.map(function (t) {
      var dis = t.v === 'group' && deep && f.type !== 'group';
      return '<button type="button" class="' + (f.type === t.v ? 'on' : '') + '" aria-pressed="' + (f.type === t.v ? 'true' : 'false') +
        '" data-set-type="' + t.v + '"' + (dis ? ' disabled title="Tables can go at most ' + LIMITS.depth + ' levels deep"' : '') + '>' + esc(t.n) + '</button>';
    }).join('');
    $('sideAddUnder').disabled = full || deep;
    $('sideAddUnder').title = deep ? 'Tables can go at most ' + LIMITS.depth + ' levels deep' : (full ? 'At most ' + LIMITS.fields + ' columns' : '');
    $('sideAddNew').disabled = full;
    $('sideRemove').disabled = countFields(schemaFields) <= 1;
  }
  function paintRow(f) {
    var on = selectedFieldId === f.id;
    var name = String(f.label || '').trim() || 'column';
    var h = '<div class="fmt-row' + (on ? ' on' : '') + '" data-id="' + esc(f.id) + '">';
    h += '<input type="text" data-act="label" value="' + esc(f.label) + '" placeholder="Column name" maxlength="120" aria-label="Column name" />';
    h += '<button type="button" class="fmt-type" data-act="pick" aria-label="Data type of ' + esc(name) + ': ' + esc(TYPE_LABEL[f.type] || 'Text') + '">' + esc(TYPE_LABEL[f.type] || 'Text') + '</button>';
    h += '<button type="button" class="fmt-plus" data-act="pick" aria-label="Add or change in column tools">+</button>';
    if (countFields(schemaFields) > 1) {
      h += '<button type="button" class="fmt-rm" data-act="rm" aria-label="Remove ' + esc(name) + '">×</button>';
    }
    h += '</div>';
    if (f.children && f.children.length) {
      h += '<div class="fmt-kids">';
      f.children.forEach(function (c) { h += paintRow(c); });
      h += '</div>';
    }
    return h;
  }
  function paintSchema() {
    if (!schemaFields.length) schemaFields = [newField('text', 'Column1')];
    if (!selectedFieldId || !findPath(schemaFields, selectedFieldId)) {
      selectedFieldId = schemaFields[0].id;
    }
    $('schemaRoot').innerHTML = '<div class="fmt-tree">' + schemaFields.map(paintRow).join('') + '</div>';
    paintFmtTools();
  }
  /** First problem with the column names, or '' (blank names, or the same name twice at one level). */
  function schemaProblem() {
    var problem = '';
    if (countFields(schemaFields) > LIMITS.fields) return 'A report can have at most ' + LIMITS.fields + ' columns.';
    (function walk(list) {
      var seen = {};
      (list || []).forEach(function (f) {
        if (problem) return;
        var label = String(f.label || '').trim();
        if (!label) { problem = 'Give every column a name.'; return; }
        var k = label.toLowerCase();
        if (seen[k]) { problem = 'Two columns are called “' + label + '”. Give each a different name.'; return; }
        seen[k] = 1;
        walk(f.children);
      });
    })(schemaFields);
    return problem;
  }
  function exportSchema() {
    function walk(list) {
      var used = {};
      return list.map(function (f) {
        var label = String(f.label || '').trim() || 'Untitled';
        var base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || f.id;
        var id = base;
        for (var n = 2; used[id]; n++) id = base + '_' + n;
        used[id] = 1;
        var hasKids = f.children && f.children.length;
        var type = hasKids ? 'group' : (f.type === 'group' ? 'text' : f.type);
        var out = { id: id, type: type, label: label, required: !!f.required };
        if (type === 'group') { out.repeat = true; out.children = walk(f.children || []); }
        return out;
      });
    }
    return { fields: walk(schemaFields) };
  }
  function focusLabel(id) {
    setTimeout(function () {
      var row = document.querySelector('.fmt-row[data-id="' + id + '"] input[data-act="label"]');
      if (row) { row.focus(); row.select(); }
    }, 0);
  }
  function selectColumn(id) {
    selectedFieldId = id;
    paintSchema();
  }
  function removeColumn(id) {
    if (countFields(schemaFields) <= 1) return;
    var path = findPath(schemaFields, id);
    if (!path) return;
    var f = atPath(schemaFields, path);
    var kids = countFields(f.children);
    if (kids && !confirm('Remove “' + (String(f.label || '').trim() || 'this column') + '” and its ' + kids + (kids === 1 ? ' sub-column?' : ' sub-columns?'))) return;
    var list = parentList(schemaFields, path);
    var idx = path[path.length - 1];
    var near = list[idx - 1] || list[idx + 1] || null;
    list.splice(idx, 1);
    // A table whose last sub-column was removed becomes a plain text column again.
    var parentPath = path.slice(0, -2);
    if (parentPath.length && !list.length) { var parent = atPath(schemaFields, parentPath); parent.type = 'text'; near = parent; }
    selectedFieldId = near ? near.id : (schemaFields[0] ? schemaFields[0].id : null);
    paintSchema();
  }

  /* ===== fill ===== */
  function emptyItem(fields) {
    var o = {};
    (fields || []).forEach(function (f) {
      o[f.id] = f.type === 'group' ? [] : (f.type === 'checkbox' ? false : '');
    });
    return o;
  }
  function ensurePayload(schema, payload) {
    var root = (payload && payload.fields) ? payload.fields : (payload || {});
    ((schema && schema.fields) || []).forEach(function (f) {
      if (f.type === 'group') { if (!Array.isArray(root[f.id])) root[f.id] = []; }
      else if (root[f.id] === undefined) root[f.id] = f.type === 'checkbox' ? false : '';
    });
    return { fields: root };
  }
  function renderFields(fields, data, path, canEdit) {
    var h = '';
    (fields || []).forEach(function (f) {
      var key = path.concat([f.id]).join('.');
      if (f.type === 'group') {
        var list = Array.isArray(data[f.id]) ? data[f.id] : [];
        h += '<div class="fill-group"><div class="fill-group-h"><strong>' + esc(f.label || f.id) + '</strong>';
        if (canEdit) h += '<button type="button" class="col-btn ghost sm" data-add="' + esc(key) + '"' + (list.length >= LIMITS.rows ? ' disabled title="At most ' + LIMITS.rows + ' rows"' : '') + '>+ Add row</button>';
        h += '</div>';
        list.forEach(function (item, i) {
          h += '<div class="fill-item"><div class="fill-item-h"><span>Row ' + (i + 1) + '</span>';
          if (canEdit) h += '<button type="button" class="col-btn ghost sm" data-del="' + esc(key + '.' + i) + '" aria-label="Remove row ' + (i + 1) + ' of ' + esc(f.label || f.id) + '">Remove</button>';
          h += '</div>' + renderFields(f.children || [], item || {}, path.concat([f.id, String(i)]), canEdit) + '</div>';
        });
        if (!list.length) h += '<div class="fill-none">No rows yet.' + (canEdit ? ' Tap + Add row.' : '') + '</div>';
        h += '</div>';
        return;
      }
      var val = data[f.id];
      var fid = 'fk-' + key.replace(/[^A-Za-z0-9_-]/g, '-');
      var lab = esc(f.label || f.id) + (f.required ? ' *' : '');
      h += '<div class="fill-field">';
      if (f.type === 'checkbox') {
        h += '<span class="col-lab" id="' + esc(fid) + '-l">' + lab + '</span>';
        h += '<label class="chk"><input type="checkbox" id="' + esc(fid) + '" aria-labelledby="' + esc(fid) + '-l" data-k="' + esc(key) + '"' + (val ? ' checked' : '') + (canEdit ? '' : ' disabled') + ' /> Yes</label>';
      } else if (f.type === 'textarea') {
        h += '<label for="' + esc(fid) + '">' + lab + '</label>';
        h += '<textarea rows="3" maxlength="' + LIMITS.textarea + '" id="' + esc(fid) + '" data-k="' + esc(key) + '"' + (canEdit ? '' : ' disabled') + '>' + esc(val == null ? '' : val) + '</textarea>';
      } else {
        var t = f.type === 'number' ? 'number' : (f.type === 'date' ? 'date' : 'text');
        h += '<label for="' + esc(fid) + '">' + lab + '</label>';
        h += '<input type="' + t + '" id="' + esc(fid) + '" data-k="' + esc(key) + '"' +
          (t === 'number' ? ' inputmode="decimal" step="any"' : (t === 'text' ? ' maxlength="' + LIMITS.text + '"' : '')) +
          ' value="' + esc(val == null ? '' : val) + '"' + (canEdit ? '' : ' disabled') + ' />';
      }
      h += '</div>';
    });
    return h;
  }
  function getAt(root, parts) {
    var cur = root;
    for (var i = 0; i < parts.length; i++) { if (cur == null) return; cur = cur[parts[i]]; }
    return cur;
  }
  function setAt(root, parts, value) {
    var cur = root;
    for (var i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null) cur[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }
  function readFillPayload() {
    var root = JSON.parse(JSON.stringify((fillState.payload && fillState.payload.fields) || {}));
    document.querySelectorAll('#fillForm [data-k]').forEach(function (el) {
      var parts = el.getAttribute('data-k').split('.');
      var v = el.type === 'checkbox' ? !!el.checked : (el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value);
      setAt(root, parts, v);
    });
    return { fields: root };
  }
  function findGroupDef(fields, pathParts) {
    var list = fields, group = null;
    for (var i = 0; i < pathParts.length; i++) {
      if (/^\d+$/.test(pathParts[i])) continue;
      group = (list || []).find(function (f) { return f.id === pathParts[i]; });
      if (!group) return null;
      list = group.children || [];
    }
    return group;
  }
  function paintFillForm() {
    $('fillForm').innerHTML = (fillState.schema.fields || []).length
      ? renderFields(fillState.schema.fields, fillState.payload.fields, [], fillState.can_edit)
      : emptyHtml('', 'This report has no columns.');
  }
  /** The notice above the form: submitted, withdrawn, locked, view-only, returned or late. */
  function fillNote(d) {
    var a = d.assignment || {}, t = d.timing || {};
    if (a.status === 'submitted') return ['ok', 'Submitted' + (a.submitted_at ? ' on ' + fmtWhen(a.submitted_at) : '') + '. If something needs changing, the requester can return it to your office.'];
    if (a.status === 'withdrawn') return ['', 'The requester has withdrawn this report from your office.'];
    if (t.locked) return ['bad', 'The deadline has passed, so this report is locked. Ask the requester to extend the deadline if you still need to send it.'];
    if (!d.can_edit && d.is_manager) return ['', 'You are viewing this office’s entries. Only staff at ' + (a.office_label || 'the office') + ' can fill them in.'];
    if (!d.can_edit) return ['', 'You can view this report but not change it.'];
    if (a.status === 'returned') return ['warn', 'Returned for correction. Make the changes and submit again.'];
    if (t.late) return ['warn', 'The deadline has passed. You can still send this until ' + fmtWhen(t.extended_due_at) + ', but it will be marked Late.'];
    return null;
  }
  function paintFillMeta() {
    var a = fillState.assignment || {};
    var meta = [a.office_label, statusLabel(a.status), dueText(fillState.timing)];
    if (a.last_saved_by_name) meta.push('Last saved by ' + a.last_saved_by_name + (a.last_saved_at ? ', ' + fmtWhen(a.last_saved_at) : ''));
    $('fillMeta').textContent = meta.filter(Boolean).join(' · ');
  }
  async function openFill(assignmentId, okMsg, keepMine) {
    showMode('fill');
    setWorkHead('Fill report', '');
    showMsg('fillErr', ''); showMsg('fillOk', '');
    $('fillConflict').hidden = true;
    if (!keepMine) mineAfterConflict = null;
    $('fillNote').hidden = true;
    $('fillActions').hidden = true;
    $('fillTitle').textContent = '';
    $('fillMeta').textContent = '';
    $('fillChips').innerHTML = '';
    $('fillForm').innerHTML = loadingHtml();
    fillDirty = false;
    window.scrollTo(0, 0);
    try {
      var d = await api('/api/collect/assignments/' + encodeURIComponent(assignmentId));
      fillState = {
        id: assignmentId, schema: d.schema || { fields: [] }, payload: ensurePayload(d.schema, d.payload),
        can_edit: !!d.can_edit, assignment: d.assignment, timing: d.timing,
        revision: d.revision != null ? Number(d.revision) : null
      };
      $('fillTitle').textContent = d.assignment.title;
      paintFillMeta();
      $('fillChips').innerHTML = chipsHtml(d.timing, d.assignment.status) +
        (d.submission && d.submission.stamp_late ? '<span class="chip late">Late</span>' : '') +
        (d.can_edit ? '' : '<span class="chip">View only</span>');
      var note = fillNote(d);
      $('fillNote').className = 'col-note' + (note && note[0] ? ' ' + note[0] : '');
      $('fillNote').textContent = note ? note[1] : '';
      $('fillNote').hidden = !note;
      $('fillActions').hidden = !d.can_edit;
      $('fillSave').disabled = !d.can_edit;
      $('fillSubmit').disabled = !d.can_edit;
      paintFillForm();
      if (okMsg) showMsg('fillOk', okMsg);
      if (keepMine && mineAfterConflict && d.can_edit) {
        $('fillConflictTxt').textContent = 'Their latest version is shown. To use your own entries instead, put them back and save.';
        $('fillReload').hidden = true; $('fillCopy').hidden = false; $('fillRestore').hidden = false;
        $('fillConflict').hidden = false;
      }
    } catch (err) {
      $('fillForm').innerHTML = err.status === 403
        ? emptyHtml('Not for your office', 'This report was sent to a different office.')
        : emptyHtml('Could not open this report', plainError(err), true);
      $('fillForm').setAttribute('data-retry-id', assignmentId);
    }
  }

  /* ===== requester view ===== */
  async function openDetail(requestId) {
    var same = detailState && detailState.id === requestId && mode === 'detail';
    showMode('detail');
    setWorkHead('Request', '');
    showMsg('detailErr', '');
    showMsg('detailExtendErr', '');
    if (!same) {
      $('detailExtendOk').hidden = true;
      $('detailTitle').textContent = '';
      $('detailMeta').textContent = '';
      $('detailChips').innerHTML = '';
      $('detailTree').innerHTML = loadingHtml();
      $('detailOffices').innerHTML = '';
      window.scrollTo(0, 0);
    }
    try {
      var d = await api('/api/collect/requests/' + encodeURIComponent(requestId));
      detailState = { id: requestId, detail: d };
      var r = d.request;
      var live = (d.assignments || []).filter(function (a) { return a.status !== 'withdrawn'; });
      var open = r.status === 'open';
      $('detailTitle').textContent = r.title;
      $('detailMeta').textContent = ['Sent by ' + (r.created_by_name || r.created_by_email), dueText(r.timing),
        live.length + (live.length === 1 ? ' office' : ' offices')].filter(Boolean).join(' · ');
      var nSub = live.filter(function (a) { return a.status === 'submitted'; }).length;
      var nLate = live.filter(function (a) { return a.stamp_late; }).length;
      var nRet = live.filter(function (a) { return a.status === 'returned'; }).length;
      $('detailChips').innerHTML = '<span class="chip' + (nSub === live.length && live.length ? ' ok' : '') + '">' + nSub + ' of ' + live.length + ' submitted</span>' +
        '<span class="chip' + (nRet ? ' late' : '') + '">' + nRet + ' returned</span>' +
        '<span class="chip' + (nLate ? ' late' : '') + '">' + nLate + ' late</span>' +
        (open ? chipsHtml(r.timing, 'pending') : '<span class="chip">Closed</span>');
      $('detailExtBox').hidden = !open;
      $('detailAddBox').hidden = !open;
      var t = r.timing || {};
      var nowIn = localInput(new Date());
      $('detailExtendAt').min = t.due_at && new Date(t.due_at).getTime() > Date.now() ? localInput(new Date(t.due_at)) : nowIn;
      $('detailExtendAt').max = localInput(new Date(Date.now() + LIMITS.horizonMs - 86400000));
      if (!same) {
        var base = t.open_until ? new Date(t.open_until).getTime() : Date.now();
        $('detailExtendAt').value = t.extended_due_at ? localInput(new Date(t.extended_due_at)) : localInput(new Date(Math.max(base, Date.now()) + 86400000));
      }
      var have = {};
      live.forEach(function (a) { have[[a.office_level, a.region || '', a.division || '', a.ccc_code || ''].join('|')] = 1; });
      $('detailOffices').innerHTML = officeOpts.map(function (o, i) {
        var taken = !!have[officeKey(o)];
        return '<label' + (taken ? ' class="taken"' : '') + '>' +
          '<input type="checkbox" data-i="' + i + '"' + (taken ? ' disabled checked' : '') + ' /> ' + esc(o.office_label) +
          (taken ? ' <small>(already added)</small>' : '') + '</label>';
      }).join('') || '<div class="pick-note">No offices under your login.</div>';
      var canWithdraw = false;
      $('detailTree').innerHTML = (d.assignments || []).map(function (a) {
        var pick = open && a.status !== 'submitted' && a.status !== 'withdrawn';
        if (pick) canWithdraw = true;
        var sub = statusLabel(a.status);
        if (a.last_saved_by_name) sub += ' · ' + a.last_saved_by_name + (a.last_saved_at ? ', ' + fmtWhen(a.last_saved_at) : '');
        var locked = a.timing && a.timing.locked;
        return '<div class="tree-row"><label class="who">' +
          (pick ? '<input type="checkbox" data-aid="' + esc(a.id) + '" aria-label="Tick ' + esc(a.office_label) + ' to withdraw" />' : '<span class="sp18"></span>') +
          '<span><b>' + esc(a.office_label) + '</b><small>' + esc(sub) + '</small></span></label>' +
          '<div class="col-chips">' + chipsHtml(a.timing, a.status) +
          (a.stamp_late ? '<span class="chip late">Late</span>' : '') +
          (a.status === 'submitted' && open ? '<button type="button" class="chip late" data-return="' + esc(a.id) + '"' +
            (locked ? ' disabled title="Extend the deadline first, so the office has time to correct it"' : '') + '>Return</button>' : '') +
          (a.status !== 'withdrawn' ? '<button type="button" class="chip clock" data-open-asg="' + esc(a.id) + '">Open</button>' : '') +
          '</div></div>';
      }).join('') || '<div class="col-empty" style="border:0">No offices on this request.</div>';
      $('detailRemoveRow').hidden = !canWithdraw;
    } catch (err) {
      $('detailTree').innerHTML = emptyHtml('Could not open this request', plainError(err), true);
    }
  }

  /* ===== lists ===== */
  function offHtml() { return emptyHtml('Collect is not available', 'It runs on the DISHA server. Try again later.', true); }
  function paintInbox(data) {
    var el = $('list');
    var items = (data && data.items) || [];
    if (!data || data.available === false) { el.innerHTML = offHtml(); return; }
    if (!items.length) {
      el.innerHTML = emptyHtml('Nothing to fill in', 'When an office above yours asks for a report, it shows up here.');
      return;
    }
    el.innerHTML = items.map(function (it) {
      var meta = [it.office_label, statusLabel(it.status), dueText(it.timing)];
      return '<button type="button" class="' + cardClass(it) + '" data-open-asg="' + esc(it.assignment_id) + '">' +
        '<div><h2>' + esc(it.title) + '</h2><div class="meta">' + esc(meta.filter(Boolean).join(' · ')) + '</div></div>' +
        '<div class="col-chips">' + chipsHtml(it.timing || {}, it.status) + '</div></button>';
    }).join('');
  }
  function paintMine(data) {
    var el = $('list');
    var items = (data && data.items) || [];
    if (!items.length) {
      el.innerHTML = emptyHtml('No requests yet', 'Tap New request to ask offices under you for a report.');
      return;
    }
    el.innerHTML = items.map(function (it) {
      var meta = [it.office_count + (Number(it.office_count) === 1 ? ' office' : ' offices'), statusLabel(it.status), dueText(it.timing)];
      return '<button type="button" class="' + cardClass({ timing: it.timing, status: it.status === 'open' ? 'pending' : 'submitted' }) +
        '" data-open-req="' + esc(it.id) + '"><div><h2>' + esc(it.title) + '</h2><div class="meta">' +
        esc(meta.filter(Boolean).join(' · ')) + '</div></div><div class="col-chips">' +
        (it.status === 'closed' ? '<span class="chip">Closed</span>' : chipsHtml(it.timing || {}, 'pending')) + '</div></button>';
    }).join('');
  }
  var listSeq = 0;
  async function loadList(quiet) {
    var seq = ++listSeq;
    var which = tab;
    if (which === 'inbox') setWorkHead('Inbox', 'Reports for your office. Shared draft — last writer is stamped.');
    else setWorkHead('My requests', 'Requests you created and their office status.');
    if (collectOff) { $('list').innerHTML = offHtml(); return; }
    if (!quiet) $('list').innerHTML = loadingHtml();
    try {
      var data = await api(which === 'inbox' ? '/api/collect/inbox' : '/api/collect/requests');
      if (seq !== listSeq) return;
      if (which === 'inbox') paintInbox(data); else paintMine(data);
    } catch (err) {
      if (seq !== listSeq) return;
      $('list').innerHTML = err.status === 503 ? offHtml() : emptyHtml('Could not load the list', plainError(err), true);
    }
  }
  function openCreate() {
    selectedOffices = {}; selectedUsers = {};
    schemaFields = [newField('text', 'Column1')];
    selectedFieldId = schemaFields[0].id;
    $('fTitle').value = '';
    $('fDue').value = '';
    $('fExt').value = '';
    $('officeSearch').value = '';
    $('userSearch').value = '';
    var min = localInput(new Date());
    var max = localInput(new Date(Date.now() + LIMITS.horizonMs - 86400000));
    $('fDue').min = min; $('fDue').max = max;
    $('fExt').min = min; $('fExt').max = max;
    $('fDueOk').hidden = true;
    $('fExtOk').hidden = true;
    wizError(null);
    paintOfficeChips(); paintUserChips(); paintOfficeList(); paintUserList();
    showMode('create');
    setWorkHead('New request', 'Basics, who fills it, then the report columns.');
    setWizard(1);
  }
  function backToList() {
    fillState = null;
    detailState = null;
    showMode('list');
    loadList();
  }

  /** Status first: where Collect is off it answers 200 {available:false} and nothing else is asked. */
  async function boot() {
    var st = null;
    $('list').innerHTML = loadingHtml();
    try { st = await api('/api/collect/status'); }
    catch (e) {
      $('list').innerHTML = e.status === 503 ? offHtml() : emptyHtml('Could not load Collect', plainError(e), true);
      return;
    }
    collectOff = !!(st && st.available === false);
    canCreate = !!(st && st.can_create && !collectOff);
    $('newNav').hidden = !canCreate;
    $('mineNav').hidden = !canCreate;
    loadList();
    if (canCreate) {
      try {
        var o = await api('/api/collect/offices');
        officeOpts = (o && o.offices) || [];
      } catch (e) { officeOpts = []; }
      try {
        var u = await api('/api/collect/users');
        userOpts = (u && u.users) || [];
      } catch (e) { userOpts = []; }
      paintOfficeList(); paintUserList(); paintOfficeChips(); paintUserChips();
    }
  }

  /* ===== wizard checks ===== */
  /** Step 1 check: null when fine, else [input id, message]. */
  function basicsProblem() {
    if (!$('fTitle').value.trim()) return ['fTitle', 'Give the report a name.'];
    var due = $('fDue').value ? new Date($('fDue').value) : null;
    if (!due || isNaN(due.getTime())) return ['fDue', 'Pick a deadline (date and time).'];
    if (due.getTime() <= Date.now()) return ['fDue', 'The deadline must be in the future.'];
    if (due.getTime() > Date.now() + LIMITS.horizonMs) return ['fDue', 'The deadline must be within a year from now.'];
    var ext = $('fExt').value ? new Date($('fExt').value) : null;
    if (ext && isNaN(ext.getTime())) return ['fExt', 'Pick a valid late-entry time, or leave it empty.'];
    if (ext && ext.getTime() <= due.getTime()) return ['fExt', 'The late-entry time must be after the deadline.'];
    if (ext && ext.getTime() > Date.now() + LIMITS.horizonMs) return ['fExt', 'The late-entry time must be within a year from now.'];
    return null;
  }
  function officesProblem() {
    var n = Object.keys(selectedOffices).length;
    if (!n) return 'Choose at least one office: tap a group, or tick offices in the list.';
    if (n > LIMITS.offices) return 'Pick at most ' + LIMITS.offices + ' offices per request (' + n + ' selected).';
    return '';
  }
  function wizError(p) {
    showMsg('fErr', p ? p[1] : '');
    ['fTitle', 'fDue', 'fExt'].forEach(function (id) { $(id).removeAttribute('aria-invalid'); });
    if (p && p[0]) { $(p[0]).setAttribute('aria-invalid', 'true'); $(p[0]).focus(); }
  }
  /** Can the wizard move from the current step to `step`? Moves back to the failing step otherwise. */
  function canGo(step) {
    if (step <= wizStep && step <= 1) return true;
    var bp = basicsProblem();
    if (step >= 2 && bp) { setWizard(1, true); wizError(bp); return false; }
    var op = officesProblem();
    if (step >= 3 && op) { setWizard(2, true); wizError([null, op]); return false; }
    return true;
  }

  /* ===== events ===== */
  $('mainNav').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-nav]');
    if (!btn) return;
    var n = btn.getAttribute('data-nav');
    if (mode === 'create' && n !== 'new' && ($('fTitle').value.trim() || Object.keys(selectedOffices).length) && !confirm('Discard this request?')) return;
    if (n === 'new') { openCreate(); return; }
    tab = n === 'mine' ? 'mine' : 'inbox';
    showMode('list');
    loadList();
  });
  $('wizNav').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-wiz]');
    if (!btn || mode !== 'create') return;
    var step = Number(btn.getAttribute('data-wiz'));
    wizError(null);
    if (step > wizStep && !canGo(step)) return;
    setWizard(step);
  });

  $('fDueSave').addEventListener('click', function () {
    var p = basicsProblem();
    $('fDueOk').hidden = true;
    if (p && p[0] !== 'fTitle' && p[0] !== 'fExt') { wizError(p); return; }
    if (!$('fDue').value) { wizError(['fDue', 'Pick a deadline (date and time).']); return; }
    wizError(null);
    $('fDueOk').textContent = 'Deadline: ' + fmtWhen(new Date($('fDue').value).toISOString());
    $('fDueOk').hidden = false;
  });
  $('fExtSave').addEventListener('click', function () {
    $('fExtOk').hidden = true;
    if (!$('fExt').value) { wizError(null); return; }
    var p = basicsProblem();
    if (p && p[0] !== 'fTitle') { wizError(p); return; }
    wizError(null);
    $('fExtOk').textContent = 'Late entries until ' + fmtWhen(new Date($('fExt').value).toISOString());
    $('fExtOk').hidden = false;
  });
  ['fDue', 'fExt'].forEach(function (id) {
    $(id).addEventListener('input', function () { $(id + 'Ok').hidden = true; $(id).removeAttribute('aria-invalid'); });
  });

  $('fCancel').addEventListener('click', function () {
    var started = $('fTitle').value.trim() || Object.keys(selectedOffices).length;
    if (started && !confirm('Discard this request?')) return;
    wizError(null);
    tab = 'inbox';
    showMode('list');
    loadList();
  });
  $('wizNext').addEventListener('click', function () {
    wizError(null);
    if (canGo(wizStep + 1)) setWizard(wizStep + 1);
  });
  $('wizBack').addEventListener('click', function () { wizError(null); setWizard(Math.max(1, wizStep - 1)); });
  $('newForm').addEventListener('keydown', function (e) {
    // Enter in a text box moves to the next step (or stays put in a column name) instead of sending early.
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    if (e.target.getAttribute('data-act') === 'label') { e.preventDefault(); return; }
    if (wizStep < 3) { e.preventDefault(); $('wizNext').click(); }
  });

  $('officeTiles').addEventListener('click', function (e) {
    var t = e.target.closest('[data-pick]');
    if (!t) return;
    selectTier(t.getAttribute('data-pick'));
    showMsg('fErr', '');
  });
  $('officeSearch').addEventListener('input', paintOfficeList);
  $('userSearch').addEventListener('input', paintUserList);
  $('officeList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-toggle-office]');
    if (!btn) return;
    var k = btn.getAttribute('data-toggle-office');
    var o = officeOpts.find(function (x) { return officeKey(x) === k; });
    if (!o) return;
    if (selectedOffices[k]) delete selectedOffices[k]; else selectedOffices[k] = o;
    var top = $('officeList').scrollTop;
    paintOfficeChips(); paintOfficeList(); paintUserList();
    $('officeList').scrollTop = top;
    showMsg('fErr', '');
  });
  $('userList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-toggle-user]');
    if (!btn) return;
    var email = btn.getAttribute('data-toggle-user');
    var u = userOpts.find(function (x) { return x.email === email; });
    if (!u) return;
    if (selectedUsers[email]) delete selectedUsers[email];
    else {
      selectedUsers[email] = u;
      var k = officeKey(u);
      if (u.level && u.level !== 'zone') {
        var o = officeOpts.find(function (x) { return officeKey(x) === k; });
        if (o) selectedOffices[k] = o;
      }
    }
    paintUserChips(); paintUserList(); paintOfficeChips(); paintOfficeList();
  });
  $('officeChips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-rm-office]');
    if (!b) return;
    delete selectedOffices[b.getAttribute('data-rm-office')];
    paintOfficeChips(); paintOfficeList(); paintUserList();
  });
  $('userChips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-rm-user]');
    if (!b) return;
    delete selectedUsers[b.getAttribute('data-rm-user')];
    paintUserChips(); paintUserList();
  });

  $('schemaRoot').addEventListener('input', function (e) {
    if (e.target.getAttribute('data-act') !== 'label') return;
    var row = e.target.closest('.fmt-row');
    if (!row) return;
    var path = findPath(schemaFields, row.getAttribute('data-id'));
    if (!path) return;
    atPath(schemaFields, path).label = e.target.value;
    if (selectedFieldId === row.getAttribute('data-id')) paintFmtTools();
    if (!$('fErr').hidden) showMsg('fErr', '');
  });
  $('schemaRoot').addEventListener('focusin', function (e) {
    // Focusing a column name selects that column without repainting the row being typed in.
    if (e.target.getAttribute('data-act') !== 'label') return;
    var row = e.target.closest('.fmt-row');
    if (!row || row.getAttribute('data-id') === selectedFieldId) return;
    selectedFieldId = row.getAttribute('data-id');
    document.querySelectorAll('#schemaRoot .fmt-row').forEach(function (r) { r.classList.toggle('on', r === row); });
    paintFmtTools();
  });
  $('schemaRoot').addEventListener('click', function (e) {
    var row = e.target.closest('.fmt-row');
    if (!row) return;
    var id = row.getAttribute('data-id');
    var actBtn = e.target.closest('[data-act]');
    var act = actBtn ? actBtn.getAttribute('data-act') : 'pick';
    if (act === 'label') return; // handled by focusin
    if (act === 'rm') { e.preventDefault(); removeColumn(id); return; }
    // type / + / row click → select and show tools in the side panel
    selectColumn(id);
    var first = document.querySelector('#sideTypes button.on') || document.querySelector('#sideTypes button');
    if (actBtn && first && window.matchMedia && !window.matchMedia('(max-width: 860px)').matches) first.focus();
  });

  $('sideTypes').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-set-type]');
    if (!btn || btn.disabled) return;
    var f = selectedField();
    if (!f) return;
    var nextType = btn.getAttribute('data-set-type');
    if (f.children && f.children.length && nextType !== 'group') {
      if (!confirm('Remove the sub-columns of “' + (String(f.label || '').trim() || 'this column') + '” and make it a single column?')) return;
      f.children = [];
    }
    if (nextType === 'group' && !(f.children && f.children.length)) {
      if (countFields(schemaFields) >= LIMITS.fields) { showMsg('fErr', 'A report can have at most ' + LIMITS.fields + ' columns.'); return; }
      // A table needs at least one column to fill in per row.
      f.children = [newField('text', nextColumnLabel())];
    }
    f.type = nextType;
    paintSchema();
  });
  $('sideAddUnder').addEventListener('click', function () {
    var f = selectedField();
    if (!f || this.disabled) return;
    if (!f.children) f.children = [];
    f.type = 'group';
    var child = newField('text', nextColumnLabel());
    f.children.push(child);
    selectedFieldId = child.id;
    paintSchema();
    focusLabel(child.id);
  });
  $('sideAddNew').addEventListener('click', function () {
    if (this.disabled) return;
    var f = selectedField();
    var sib = newField('text', nextColumnLabel());
    if (!f) {
      schemaFields.push(sib);
    } else {
      var path = findPath(schemaFields, f.id);
      var list = parentList(schemaFields, path);
      list.splice(path[path.length - 1] + 1, 0, sib);
    }
    selectedFieldId = sib.id;
    paintSchema();
    focusLabel(sib.id);
  });
  $('sideRemove').addEventListener('click', function () { if (selectedFieldId) removeColumn(selectedFieldId); });

  $('newForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (wizStep !== 3) { $('wizNext').click(); return; }
    wizError(null);
    if (!canGo(3)) return;
    var sp = schemaProblem();
    if (sp) { wizError([null, sp]); return; }
    var offices = Object.keys(selectedOffices).map(function (k) { return selectedOffices[k]; });
    var users = Object.keys(selectedUsers).map(function (k) { return selectedUsers[k]; });
    var schema = exportSchema();
    if (!schema.fields.length) { wizError([null, 'Add at least one column.']); return; }
    var body = {
      title: $('fTitle').value.trim(),
      due_at: new Date($('fDue').value).toISOString(),
      offices: offices,
      users: users,
      schema: schema
    };
    if ($('fExt').value) body.extended_due_at = new Date($('fExt').value).toISOString();
    var btn = $('fSave');
    btn.disabled = true; $('wizBack').disabled = true;
    btn.textContent = 'Creating…';
    try {
      var made = await api('/api/collect/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body)
      });
      var n = (made && made.assignments && made.assignments.length) || offices.length;
      tab = 'mine';
      showMode('list');
      await loadList();
      toast('Request sent to ' + n + (n === 1 ? ' office' : ' offices'));
    } catch (ex) {
      wizError([null, plainError(ex)]);
    } finally {
      btn.disabled = false; $('wizBack').disabled = false;
      btn.textContent = 'Create request';
    }
  });

  $('list').addEventListener('click', function (e) {
    if (e.target.closest('[data-retry]')) { boot(); return; }
    var asg = e.target.closest('[data-open-asg]');
    if (asg) { fillFrom = null; openFill(asg.getAttribute('data-open-asg')); return; }
    var req = e.target.closest('[data-open-req]');
    if (req) openDetail(req.getAttribute('data-open-req'));
  });
  $('fillBack').addEventListener('click', function () {
    if (!leaveFill()) return;
    fillState = null;
    if (fillFrom) { var rid = fillFrom; fillFrom = null; openDetail(rid); return; }
    backToList();
  });
  $('detailBack').addEventListener('click', backToList);
  $('fillForm').addEventListener('input', function () { if (fillState && fillState.can_edit) fillDirty = true; });
  window.addEventListener('beforeunload', function (e) {
    if (fillDirty && mode === 'fill') { e.preventDefault(); e.returnValue = ''; }
  });

  $('fillForm').addEventListener('click', function (e) {
    if (e.target.closest('[data-retry]')) { var rid = $('fillForm').getAttribute('data-retry-id'); if (rid) openFill(rid); return; }
    if (!fillState || !fillState.can_edit) return;
    var add = e.target.closest('[data-add]');
    var del = e.target.closest('[data-del]');
    if (add) {
      fillState.payload = readFillPayload();
      var parts = add.getAttribute('data-add').split('.');
      var group = findGroupDef(fillState.schema.fields, parts);
      var arr = getAt(fillState.payload.fields, parts);
      if (!Array.isArray(arr)) { setAt(fillState.payload.fields, parts, []); arr = getAt(fillState.payload.fields, parts); }
      if (arr.length >= LIMITS.rows) { showMsg('fillErr', 'A table can have at most ' + LIMITS.rows + ' rows.'); return; }
      arr.push(emptyItem(group && group.children));
      fillDirty = true;
      paintFillForm();
      var prefix = parts.join('.') + '.' + (arr.length - 1) + '.';
      var firstNew = Array.prototype.find.call(document.querySelectorAll('#fillForm [data-k]'), function (el) { return el.getAttribute('data-k').indexOf(prefix) === 0; });
      if (firstNew) firstNew.focus();
    }
    if (del) {
      fillState.payload = readFillPayload();
      var p = del.getAttribute('data-del').split('.');
      var idx = Number(p.pop());
      var arr2 = getAt(fillState.payload.fields, p);
      var row = Array.isArray(arr2) ? arr2[idx] : null;
      var hasData = row && Object.keys(row).some(function (k) { var v = row[k]; return Array.isArray(v) ? v.length : (v !== '' && v !== false && v != null); });
      if (hasData && !confirm('Remove row ' + (idx + 1) + '?')) return;
      if (Array.isArray(arr2)) arr2.splice(idx, 1);
      fillDirty = true;
      paintFillForm();
    }
  });

  /* Someone else at the office saved since this form loaded (409). Their copy is never overwritten
     silently; the user's own entries are kept so they can copy them or put them back after loading theirs. */
  function showConflict() {
    mineAfterConflict = readFillPayload();
    $('fillConflictTxt').textContent = 'Someone at your office saved this form after you opened it. Your entries are kept on this page: load their version, then copy your entries or put them back.';
    $('fillReload').hidden = false; $('fillCopy').hidden = false; $('fillRestore').hidden = true;
    $('fillConflict').hidden = false;
    $('fillReload').focus();
  }
  function entriesText(fields, data, prefix) {
    var out = [];
    (fields || []).forEach(function (f) {
      var label = (prefix ? prefix + ' > ' : '') + (f.label || f.id);
      var v = data ? data[f.id] : undefined;
      if (f.type === 'group') {
        (Array.isArray(v) ? v : []).forEach(function (row, i) { out = out.concat(entriesText(f.children, row, label + ' row ' + (i + 1))); });
      } else if (v !== '' && v != null && v !== false) {
        out.push(label + ': ' + (v === true ? 'Yes' : v));
      }
    });
    return out;
  }
  $('fillReload').addEventListener('click', function () {
    if (!fillState) return;
    fillDirty = false;
    openFill(fillState.id, '', true);
  });
  $('fillCopy').addEventListener('click', function () {
    if (!fillState || !mineAfterConflict) return;
    var text = entriesText(fillState.schema.fields, mineAfterConflict.fields, '').join('\n') || '(no entries)';
    var done = function () { toast('Your entries are copied'); };
    var fail = function () { showMsg('fillErr', 'Could not copy. Put your entries back and copy them from the form instead.'); };
    if (window.UI && UI.copy) UI.copy(text).then(done, fail);
    else if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, fail);
    else fail();
  });
  $('fillRestore').addEventListener('click', function () {
    if (!fillState || !mineAfterConflict) return;
    fillState.payload = ensurePayload(fillState.schema, JSON.parse(JSON.stringify(mineAfterConflict)));
    paintFillForm();
    fillDirty = true;
    $('fillConflict').hidden = true;
    showMsg('fillOk', 'Your entries are back in the form. Save to replace their version.');
  });

  async function saveOrSubmit(submit) {
    if (!fillState || saving) return;
    saving = true;
    showMsg('fillErr', ''); showMsg('fillOk', '');
    $('fillSave').disabled = true; $('fillSubmit').disabled = true; $('fillBack').disabled = true;
    var btn = submit ? $('fillSubmit') : $('fillSave');
    var label = btn.textContent;
    btn.textContent = submit ? 'Submitting…' : 'Saving…';
    try {
      fillState.payload = readFillPayload();
      var bytes = new Blob([JSON.stringify(fillState.payload)]).size;
      if (bytes > LIMITS.payloadBytes) {
        showMsg('fillErr', 'This report is too large to save (' + Math.round(bytes / 1024) + ' KB; the limit is ' + Math.round(LIMITS.payloadBytes / 1024) + ' KB). Shorten long text or split the table.');
        return;
      }
      var body = { payload: fillState.payload };
      if (fillState.revision != null) body.base_revision = fillState.revision;
      var r = await api('/api/collect/assignments/' + encodeURIComponent(fillState.id) + (submit ? '/submit' : '/draft'), {
        method: submit ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body)
      });
      fillDirty = false;
      if (r && r.revision != null) fillState.revision = Number(r.revision);
      $('fillConflict').hidden = true;
      var when = new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
      if (submit) {
        saving = false;
        await openFill(fillState.id, 'Submitted' + (r && r.late ? ' (marked Late)' : '') + ' at ' + when + '.');
      } else {
        var a = fillState.assignment || {};
        if (a.status === 'pending' || a.status === 'returned') a.status = 'in_progress';
        if (r && r.stamp) { a.last_saved_by_name = r.stamp.stamp_name || a.last_saved_by_name; a.last_saved_at = r.stamp.stamp_at || a.last_saved_at; }
        else a.last_saved_at = new Date().toISOString();
        paintFillMeta();
        showMsg('fillOk', 'Draft saved at ' + when + (r && r.late ? ' (marked Late)' : '') + '. Anyone at your office can carry on from here.');
      }
    } catch (err) {
      if (err.status === 409) showConflict();
      else showMsg('fillErr', plainError(err));
    } finally {
      saving = false;
      btn.textContent = label;
      $('fillBack').disabled = false;
      if (fillState && fillState.can_edit) { $('fillSave').disabled = false; $('fillSubmit').disabled = false; }
    }
  }
  $('fillSave').addEventListener('click', function () { saveOrSubmit(false); });
  $('fillSubmit').addEventListener('click', function () {
    if (!confirm('Send this report to the requester? After submitting you cannot change it unless they return it.')) return;
    saveOrSubmit(true);
  });

  $('detailTree').addEventListener('click', async function (e) {
    if (e.target.closest('[data-retry]')) { if (detailState) openDetail(detailState.id); return; }
    var open = e.target.closest('[data-open-asg]');
    if (open) { fillFrom = detailState && detailState.id; openFill(open.getAttribute('data-open-asg')); return; }
    var ret = e.target.closest('[data-return]');
    if (!ret || !detailState || ret.disabled) return;
    var office = (ret.closest('.tree-row').querySelector('b') || {}).textContent || 'this office';
    if (!confirm('Return the report to ' + office + ' for correction? They will be able to edit it and submit again.')) return;
    ret.disabled = true;
    try {
      await api('/api/collect/assignments/' + encodeURIComponent(ret.getAttribute('data-return')) + '/return', { method: 'POST' });
      await openDetail(detailState.id);
      toast('Returned to ' + office);
    } catch (err) { ret.disabled = false; showMsg('detailErr', plainError(err)); }
  });
  $('detailQuick').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-pick]');
    if (!btn) return;
    var pick = btn.getAttribute('data-pick');
    var boxes = Array.prototype.filter.call(document.querySelectorAll('#detailOffices input'), function (inp) { return !inp.disabled; });
    var match = function (inp) { var o = officeOpts[Number(inp.getAttribute('data-i'))]; return pick === 'all' || (o && o.level === pick); };
    // Tapping a group again when all of it is ticked unticks it.
    var full = pick !== 'none' && boxes.filter(match).length && boxes.filter(match).every(function (inp) { return inp.checked; });
    boxes.forEach(function (inp) {
      if (pick === 'none') inp.checked = false;
      else if (match(inp)) inp.checked = !full;
    });
  });
  $('detailAdd').addEventListener('click', async function () {
    if (!detailState) return;
    var offices = [];
    document.querySelectorAll('#detailOffices input:checked').forEach(function (inp) {
      if (!inp.disabled) offices.push(officeOpts[Number(inp.getAttribute('data-i'))]);
    });
    if (!offices.length) { showMsg('detailErr', 'Tick the offices to add.'); return; }
    if (offices.length > LIMITS.offices) { showMsg('detailErr', 'Add at most ' + LIMITS.offices + ' offices at a time.'); return; }
    var btn = this; btn.disabled = true;
    try {
      var r = await api('/api/collect/requests/' + encodeURIComponent(detailState.id) + '/offices', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offices: offices })
      });
      await openDetail(detailState.id);
      var n = (r && r.added) || 0;
      toast(n ? ('Added ' + n + (n === 1 ? ' office' : ' offices')) : 'Those offices were already on the request');
    } catch (err) { showMsg('detailErr', plainError(err)); }
    finally { btn.disabled = false; }
  });
  $('detailRemove').addEventListener('click', async function () {
    if (!detailState) return;
    var ids = [];
    document.querySelectorAll('#detailTree input[data-aid]:checked').forEach(function (inp) { ids.push(inp.getAttribute('data-aid')); });
    if (!ids.length) { showMsg('detailErr', 'Tick the offices to withdraw (the boxes beside the office names).'); return; }
    if (!confirm('Withdraw the request from ' + ids.length + (ids.length === 1 ? ' office?' : ' offices?') + ' Their drafts will no longer be collected.')) return;
    var btn = this; btn.disabled = true;
    try {
      await api('/api/collect/requests/' + encodeURIComponent(detailState.id) + '/offices/remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignment_ids: ids })
      });
      await openDetail(detailState.id);
      toast('Withdrawn from ' + ids.length + (ids.length === 1 ? ' office' : ' offices'));
    } catch (err) { showMsg('detailErr', plainError(err)); }
    finally { btn.disabled = false; }
  });
  $('detailExtendSave').addEventListener('click', async function () {
    if (!detailState) return;
    showMsg('detailExtendErr', '');
    $('detailExtendOk').hidden = true;
    var raw = $('detailExtendAt').value;
    var d = raw ? new Date(raw) : null;
    var t = detailState.detail.request.timing || {};
    if (!d || isNaN(d.getTime())) { showMsg('detailExtendErr', 'Pick a date and time.'); return; }
    if (d.getTime() <= Date.now()) { showMsg('detailExtendErr', 'Pick a time in the future.'); return; }
    if (d.getTime() > Date.now() + LIMITS.horizonMs) { showMsg('detailExtendErr', 'Pick a time within a year from now.'); return; }
    if (t.due_at && d.getTime() <= new Date(t.due_at).getTime()) { showMsg('detailExtendErr', 'The new time must be after the original deadline (' + fmtWhen(t.due_at) + ').'); return; }
    var btn = this; btn.disabled = true;
    try {
      await api('/api/collect/requests/' + encodeURIComponent(detailState.id) + '/extend', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ extended_due_at: d.toISOString() })
      });
      await openDetail(detailState.id);
      $('detailExtendOk').textContent = 'Offices can send entries until ' + fmtWhen(d.toISOString()) + '.';
      $('detailExtendOk').hidden = false;
    } catch (err) { showMsg('detailExtendErr', plainError(err)); }
    finally { btn.disabled = false; }
  });

  function fileName(ext) {
    var t = String((detailState && detailState.detail && detailState.detail.request.title) || 'collect')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'collect';
    return 'collect-' + t + '.' + ext;
  }
  function download(name, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  async function fetchExport(btn) {
    btn.disabled = true;
    try { return await api('/api/collect/requests/' + encodeURIComponent(detailState.id) + '/export'); }
    finally { btn.disabled = false; }
  }
  $('detailExport').addEventListener('click', async function () {
    if (!detailState) return;
    showMsg('detailErr', '');
    try {
      var data = await fetchExport(this);
      download(fileName('json'), new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    } catch (err) { showMsg('detailErr', plainError(err)); }
  });
  // One row per office; one column per answer path (table rows become "Table #1 › Column").
  // Cells a spreadsheet would run as a formula (= + - @, tab, CR) get a leading ' (docs/collect.md).
  function csvCell(v) {
    v = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  $('detailCsv').addEventListener('click', async function () {
    if (!detailState) return;
    showMsg('detailErr', '');
    try {
      var data = await fetchExport(this);
      var paths = [], seen = {};
      (data.offices || []).forEach(function (o) {
        (o.rows || []).forEach(function (r) {
          if (r.value === '(empty list)' || seen[r.path]) return;
          seen[r.path] = 1; paths.push(r.path);
        });
      });
      var head = ['Office', 'Status', 'Last saved by', 'Submitted at', 'Late'].concat(paths);
      var lines = [head.map(csvCell).join(',')];
      (data.offices || []).forEach(function (o) {
        var vals = {};
        (o.rows || []).forEach(function (x) { if (x.value !== '(empty list)') vals[x.path] = x.value; });
        var cells = [o.office, statusLabel(o.status), o.last_saved_by, o.submitted_at ? fmtWhen(o.submitted_at) : '', o.late ? 'Yes' : '']
          .concat(paths.map(function (p) { return vals[p]; }));
        lines.push(cells.map(csvCell).join(','));
      });
      download(fileName('csv'), new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    } catch (err) { showMsg('detailErr', plainError(err)); }
  });

  showMode('list');
  boot();
  setInterval(function () {
    if (!collectOff && !document.hidden && mode === 'list') loadList(true);
  }, 60000);
})();
