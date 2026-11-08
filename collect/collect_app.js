/* DISHA Collect client — side nav + right work. See docs/collect.md */
(function () {
  'use strict';

  var tab = 'inbox';
  var mode = 'list'; // list | create | fill | detail
  var canCreate = false;
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
  var TYPES = [
    { v: 'text', n: 'Text' },
    { v: 'number', n: 'Number' },
    { v: 'checkbox', n: 'Yes/No' },
    { v: 'date', n: 'Date' },
    { v: 'textarea', n: 'Long text' },
    { v: 'group', n: 'Table' }
  ];
  var TYPE_LABEL = { text: 'Text', number: 'Number', checkbox: 'Yes/No', date: 'Date', textarea: 'Long', group: 'Table' };

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
  function chipsHtml(timing, status) {
    var h = '';
    if (status === 'submitted') h += '<span class="chip ok">Submitted</span>';
    else if (status === 'returned') h += '<span class="chip late">Returned</span>';
    else if (status === 'withdrawn') h += '<span class="chip">Withdrawn</span>';
    else if (timing && timing.locked) h += '<span class="chip locked">Locked</span>';
    else if (timing && timing.late) h += '<span class="chip late">Late</span><span class="chip clock">' + esc(fmtLeft(timing.ms_left)) + '</span>';
    else if (timing) h += '<span class="chip clock">' + esc(fmtLeft(timing.ms_left)) + '</span>';
    return h;
  }
  function cardClass(item) {
    var c = 'col-card';
    if (item.status === 'submitted') return c;
    if (item.timing && item.timing.locked) return c + ' locked';
    if (item.timing && (item.timing.late || (item.timing.ms_left != null && item.timing.ms_left < 86400000))) return c + ' due';
    return c;
  }
  async function api(path, opts) {
    var res = await fetch(path, Object.assign({ credentials: 'same-origin', headers: { Accept: 'application/json' } }, opts || {}));
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
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
    $('fmtTools').hidden = !(next === 'create' && wizStep === 3);
    $('mainNav').hidden = next === 'fill' || next === 'detail';
    paintMainNav();
  }
  function setWizard(step) {
    wizStep = step;
    document.querySelectorAll('.wiz-step').forEach(function (el) {
      el.classList.toggle('on', Number(el.getAttribute('data-step')) === step);
    });
    document.querySelectorAll('.wiz-pane').forEach(function (el) {
      el.classList.toggle('on', Number(el.getAttribute('data-pane')) === step);
    });
    document.querySelectorAll('#wizNav [data-wiz]').forEach(function (b) {
      b.classList.toggle('on', Number(b.getAttribute('data-wiz')) === step);
    });
    $('wizBack').hidden = step === 1;
    $('wizNext').hidden = step === 3;
    $('fSave').hidden = step !== 3;
    $('fmtTools').hidden = !(mode === 'create' && step === 3);
    if (step === 3) {
      if (!selectedFieldId && schemaFields[0]) selectedFieldId = schemaFields[0].id;
      paintSchema();
      paintFmtTools();
    }
  }

  function paintOfficeChips() {
    var keys = Object.keys(selectedOffices);
    $('officeChips').innerHTML = keys.length
      ? keys.map(function (k) {
        var o = selectedOffices[k];
        return '<span class="sel-chip">' + esc(o.office_label) +
          '<button type="button" data-rm-office="' + esc(k) + '" aria-label="Remove">×</button></span>';
      }).join('')
      : '<span style="font-size:12.5px;color:var(--mzo-faint)">No offices selected yet</span>';
  }
  function paintUserChips() {
    var keys = Object.keys(selectedUsers);
    $('userChips').innerHTML = keys.length
      ? keys.map(function (k) {
        var u = selectedUsers[k];
        return '<span class="sel-chip">' + esc(u.name || u.email) +
          '<button type="button" data-rm-user="' + esc(k) + '" aria-label="Remove">×</button></span>';
      }).join('')
      : '<span style="font-size:12.5px;color:var(--mzo-faint)">Anyone at the selected offices can fill</span>';
  }
  function paintOfficeList() {
    var q = String($('officeSearch').value || '').toLowerCase().trim();
    var rows = officeOpts.filter(function (o) {
      if (!q) return true;
      return (o.office_label + ' ' + o.level).toLowerCase().indexOf(q) !== -1;
    }).slice(0, 80);
    $('officeList').innerHTML = rows.map(function (o) {
      var k = officeKey(o);
      var on = !!selectedOffices[k];
      return '<button type="button" class="' + (on ? 'on' : '') + '" data-toggle-office="' + esc(k) + '">' +
        '<span class="mark" aria-hidden="true"></span><span class="who"><b>' + esc(o.office_label) +
        '</b><span>' + esc(o.level === 'ccc' ? 'Station / CCC' : (o.level === 'division' ? 'Division (DM)' : 'Region (RM)')) +
        '</span></span></button>';
    }).join('') || '<div class="col-empty" style="border:0">No match</div>';
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
      return '<button type="button" class="' + (on ? 'on' : '') + '" data-toggle-user="' + esc(u.email) + '">' +
        '<span class="mark" aria-hidden="true"></span><span class="who"><b>' + esc(u.name || u.email) +
        '</b><span>' + esc(u.office_label || u.email) + '</span></span></button>';
    }).join('') || '<div class="col-empty" style="border:0">No people in scope (or pick offices first)</div>';
  }
  function selectTier(level) {
    officeOpts.forEach(function (o) {
      if (o.level === level) selectedOffices[officeKey(o)] = o;
    });
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
  function countFields(list) {
    var n = 0;
    (list || []).forEach(function (f) {
      n += 1;
      if (f.children && f.children.length) n += countFields(f.children);
    });
    return n;
  }
  function nextColumnLabel() {
    return 'Column' + (countFields(schemaFields) + 1);
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
    $('fmtSelNote').textContent = (f.label || 'Untitled') + ' — pick type or add below.';
    $('fmtToolsBody').hidden = false;
    $('sideTypes').innerHTML = TYPES.map(function (t) {
      return '<button type="button" class="' + (f.type === t.v ? 'on' : '') + '" data-set-type="' + t.v + '">' + esc(t.n) + '</button>';
    }).join('');
    $('sideRemove').disabled = countFields(schemaFields) <= 1;
  }
  function paintRow(f) {
    var on = selectedFieldId === f.id;
    var h = '<div class="fmt-row' + (on ? ' on' : '') + '" data-id="' + esc(f.id) + '">';
    h += '<input type="text" data-act="label" value="' + esc(f.label) + '" placeholder="Column name" />';
    h += '<button type="button" class="fmt-type" data-act="pick" title="Data type">' + esc(TYPE_LABEL[f.type] || 'Text') + '</button>';
    h += '<button type="button" class="fmt-plus" data-act="pick" title="Add / edit in side panel">+</button>';
    if (countFields(schemaFields) > 1) {
      h += '<button type="button" class="fmt-rm" data-act="rm" title="Remove">×</button>';
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
  function exportSchema() {
    function walk(list) {
      return list.map(function (f) {
        var label = String(f.label || '').trim() || 'Untitled';
        var id = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || f.id;
        var hasKids = f.children && f.children.length;
        var type = hasKids ? 'group' : f.type;
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
        if (canEdit) h += '<button type="button" class="col-btn ghost sm" data-add="' + esc(key) + '">+ Add</button>';
        h += '</div>';
        list.forEach(function (item, i) {
          h += '<div class="fill-item"><div class="fill-item-h"><span>#' + (i + 1) + '</span>';
          if (canEdit) h += '<button type="button" class="col-btn ghost sm" data-del="' + esc(key + '.' + i) + '">Remove</button>';
          h += '</div>' + renderFields(f.children || [], item || {}, path.concat([f.id, String(i)]), canEdit) + '</div>';
        });
        if (!list.length) h += '<div style="font-size:12.5px;color:var(--mzo-faint);margin-bottom:6px">No items yet.</div>';
        h += '</div>';
        return;
      }
      var val = data[f.id];
      h += '<div class="fill-field"><label>' + esc(f.label || f.id) + (f.required ? ' *' : '') + '</label>';
      if (f.type === 'checkbox') {
        h += '<label class="chk"><input type="checkbox" data-k="' + esc(key) + '"' + (val ? ' checked' : '') + (canEdit ? '' : ' disabled') + ' /> Yes</label>';
      } else if (f.type === 'textarea') {
        h += '<textarea rows="3" data-k="' + esc(key) + '"' + (canEdit ? '' : ' disabled') + '>' + esc(val == null ? '' : val) + '</textarea>';
      } else {
        var t = f.type === 'number' ? 'number' : (f.type === 'date' ? 'date' : 'text');
        h += '<input type="' + t + '" data-k="' + esc(key) + '" value="' + esc(val == null ? '' : val) + '"' + (canEdit ? '' : ' disabled') + ' />';
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
  async function openFill(assignmentId) {
    showMode('fill');
    setWorkHead('Fill report', '');
    $('fillErr').hidden = true; $('fillOk').hidden = true;
    $('fillForm').innerHTML = '<div class="col-empty">Loading…</div>';
    try {
      var d = await api('/api/collect/assignments/' + encodeURIComponent(assignmentId));
      fillState = { id: assignmentId, schema: d.schema || { fields: [] }, payload: ensurePayload(d.schema, d.payload), can_edit: !!d.can_edit, assignment: d.assignment, timing: d.timing };
      $('fillTitle').textContent = d.assignment.title;
      $('fillMeta').textContent = d.assignment.office_label + ' · ' + d.assignment.status +
        (d.assignment.last_saved_by_name ? (' · Last saved by ' + d.assignment.last_saved_by_name) : '');
      $('fillChips').innerHTML = chipsHtml(d.timing, d.assignment.status) + (d.can_edit ? '' : '<span class="chip locked">Read-only</span>');
      $('fillSave').disabled = !d.can_edit;
      $('fillSubmit').disabled = !d.can_edit;
      $('fillForm').innerHTML = renderFields(fillState.schema.fields, fillState.payload.fields, [], d.can_edit);
    } catch (err) {
      $('fillForm').innerHTML = '<div class="col-empty">' + esc(err.message) + '</div>';
    }
  }

  async function openDetail(requestId) {
    showMode('detail');
    setWorkHead('Request', '');
    $('detailErr').hidden = true;
    $('detailExtendErr').hidden = true;
    $('detailExtendOk').hidden = true;
    $('detailTree').innerHTML = '<div class="col-empty">Loading…</div>';
    try {
      var d = await api('/api/collect/requests/' + encodeURIComponent(requestId));
      detailState = { id: requestId, detail: d };
      var r = d.request;
      $('detailTitle').textContent = r.title;
      $('detailMeta').textContent = (r.created_by_name || r.created_by_email) + ' · ' + r.status + ' · ' + (d.assignments || []).length + ' offices';
      $('detailChips').innerHTML = chipsHtml(r.timing, r.status === 'closed' ? 'submitted' : 'pending');
      var have = {};
      (d.assignments || []).forEach(function (a) {
        if (a.status !== 'withdrawn') have[[a.office_level, a.region, a.division, a.ccc_code].join('|')] = 1;
      });
      $('detailOffices').innerHTML = officeOpts.map(function (o, i) {
        var k = officeKey(o);
        var taken = !!have[k];
        return '<label style="display:flex;gap:8px;padding:6px 8px;font-size:13px">' +
          '<input type="checkbox" data-i="' + i + '"' + (taken ? ' disabled' : '') + ' /> ' + esc(o.office_label) + '</label>';
      }).join('');
      $('detailTree').innerHTML = (d.assignments || []).map(function (a) {
        return '<div class="tree-row"><label style="display:flex;gap:8px;align-items:center;margin:0">' +
          (a.status !== 'submitted' && a.status !== 'withdrawn' ? '<input type="checkbox" data-aid="' + esc(a.id) + '" />' : '<span style="width:16px"></span>') +
          '<span><b>' + esc(a.office_label) + '</b><br><span style="font-size:12px;color:var(--mzo-muted)">' + esc(a.status) +
          (a.last_saved_by_name ? ' · ' + esc(a.last_saved_by_name) : '') + '</span></span></label>' +
          '<div class="col-chips">' + chipsHtml(a.timing, a.status) +
          (a.status === 'submitted' ? '<button type="button" class="chip late" data-return="' + esc(a.id) + '">Return</button>' : '') +
          (a.status !== 'withdrawn' ? '<button type="button" class="chip clock" data-open-asg="' + esc(a.id) + '">Open</button>' : '') +
          '</div></div>';
      }).join('') || '<div class="col-empty">No offices</div>';
      if (r.extended_due_at) {
        try {
          var ed = new Date(r.extended_due_at);
          if (!isNaN(ed.getTime())) {
            var pad = function (n) { return (n < 10 ? '0' : '') + n; };
            $('detailExtendAt').value = ed.getFullYear() + '-' + pad(ed.getMonth() + 1) + '-' + pad(ed.getDate()) +
              'T' + pad(ed.getHours()) + ':' + pad(ed.getMinutes());
          }
        } catch (e) { /* ignore */ }
      }
    } catch (err) {
      $('detailTree').innerHTML = '<div class="col-empty">' + esc(err.message) + '</div>';
    }
  }

  function paintInbox(data) {
    var el = $('list');
    var items = (data && data.items) || [];
    if (!data || data.available === false) {
      el.innerHTML = '<div class="col-empty">DISHA Collect runs on the VM.</div>';
      return;
    }
    if (!items.length) { el.innerHTML = '<div class="col-empty">Nothing due for your office.</div>'; return; }
    el.innerHTML = items.map(function (it) {
      return '<button type="button" class="' + cardClass(it) + '" data-open-asg="' + esc(it.assignment_id) + '">' +
        '<div><h2>' + esc(it.title) + '</h2><div class="meta">' + esc(it.office_label) + ' · ' + esc(it.status) + '</div></div>' +
        '<div class="col-chips">' + chipsHtml(it.timing || {}, it.status) + '</div></button>';
    }).join('');
  }
  function paintMine(data) {
    var el = $('list');
    var items = (data && data.items) || [];
    if (!items.length) { el.innerHTML = '<div class="col-empty">You have not opened any requests yet.</div>'; return; }
    el.innerHTML = items.map(function (it) {
      return '<button type="button" class="' + cardClass({ timing: it.timing, status: it.status === 'open' ? 'pending' : 'submitted' }) +
        '" data-open-req="' + esc(it.id) + '"><div><h2>' + esc(it.title) + '</h2><div class="meta">' +
        esc(it.office_count) + ' offices · ' + esc(it.status) + '</div></div><div class="col-chips">' +
        chipsHtml(it.timing || {}, it.status === 'closed' ? 'submitted' : 'pending') + '</div></button>';
    }).join('');
  }
  async function loadList() {
    try {
      if (tab === 'inbox') {
        setWorkHead('Inbox', 'Reports for your office. Shared draft — last writer is stamped.');
        paintInbox(await api('/api/collect/inbox'));
      } else {
        setWorkHead('My requests', 'Requests you created and their office status.');
        paintMine(await api('/api/collect/requests'));
      }
    } catch (err) {
      $('list').innerHTML = '<div class="col-empty">' + esc(err.message) + '</div>';
    }
  }
  function openCreate() {
    selectedOffices = {}; selectedUsers = {};
    schemaFields = [newField('text', 'Column1')];
    selectedFieldId = schemaFields[0].id;
    $('fTitle').value = '';
    $('fDue').value = '';
    $('fExt').value = '';
    $('fDueOk').hidden = true;
    $('fExtOk').hidden = true;
    $('fErr').hidden = true;
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

  async function bootCreate() {
    try {
      var st = await api('/api/collect/status');
      canCreate = !!(st && st.can_create && st.available !== false);
      $('newNav').hidden = !canCreate;
      $('mineNav').hidden = !canCreate;
      if (canCreate) {
        var o = await api('/api/collect/offices');
        officeOpts = (o && o.offices) || [];
        try {
          var u = await api('/api/collect/users');
          userOpts = (u && u.users) || [];
        } catch (e) { userOpts = []; }
        paintOfficeList();
        paintUserList();
        paintOfficeChips();
        paintUserChips();
      }
    } catch (e) {
      $('newNav').hidden = true;
      $('mineNav').hidden = true;
    }
  }

  /* ===== events ===== */
  $('mainNav').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-nav]');
    if (!btn) return;
    var n = btn.getAttribute('data-nav');
    if (n === 'new') { openCreate(); return; }
    tab = n === 'mine' ? 'mine' : 'inbox';
    showMode('list');
    loadList();
  });
  $('wizNav').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-wiz]');
    if (!btn || mode !== 'create') return;
    var step = Number(btn.getAttribute('data-wiz'));
    $('fErr').hidden = true;
    if (step > wizStep) {
      if (wizStep === 1 && (!$('fTitle').value.trim() || !$('fDue').value)) {
        $('fErr').textContent = 'Enter a title and save the submit-by date.'; $('fErr').hidden = false; return;
      }
      if (step >= 2 && wizStep < 2 && !Object.keys(selectedOffices).length && step === 3) {
        // going to format requires offices if jumping past who — require who first
      }
      if (step === 3 && !Object.keys(selectedOffices).length) {
        $('fErr').textContent = 'Pick at least one office first.'; $('fErr').hidden = false;
        setWizard(2); return;
      }
      if (step === 2 && (!$('fTitle').value.trim() || !$('fDue').value)) {
        $('fErr').textContent = 'Enter a title and save the submit-by date.'; $('fErr').hidden = false;
        setWizard(1); return;
      }
    }
    setWizard(step);
  });

  $('fDueSave').addEventListener('click', function () {
    if (!$('fDue').value) {
      $('fErr').textContent = 'Pick a submit-by date first.'; $('fErr').hidden = false; return;
    }
    $('fErr').hidden = true;
    $('fDueOk').hidden = false;
  });
  $('fExtSave').addEventListener('click', function () {
    if (!$('fExt').value) {
      $('fExtOk').hidden = true; return;
    }
    $('fExtOk').hidden = false;
  });

  $('fCancel').addEventListener('click', function () {
    $('fErr').hidden = true;
    tab = 'inbox';
    showMode('list');
    loadList();
  });
  $('wizNext').addEventListener('click', function () {
    $('fErr').hidden = true;
    if (wizStep === 1) {
      if (!$('fTitle').value.trim() || !$('fDue').value) {
        $('fErr').textContent = 'Enter a title and save the submit-by date.'; $('fErr').hidden = false; return;
      }
      $('fDueOk').hidden = false;
      setWizard(2); return;
    }
    if (wizStep === 2) {
      if (!Object.keys(selectedOffices).length) {
        $('fErr').textContent = 'Pick at least one office (All RM / DM / SM, or search).'; $('fErr').hidden = false; return;
      }
      setWizard(3);
    }
  });
  $('wizBack').addEventListener('click', function () { setWizard(Math.max(1, wizStep - 1)); });

  $('officeTiles').addEventListener('click', function (e) {
    var t = e.target.closest('[data-pick]');
    if (!t) return;
    selectTier(t.getAttribute('data-pick'));
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
    paintOfficeChips(); paintOfficeList(); paintUserList();
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
  });
  $('schemaRoot').addEventListener('click', function (e) {
    var row = e.target.closest('.fmt-row');
    if (!row) return;
    var id = row.getAttribute('data-id');
    var actBtn = e.target.closest('[data-act]');
    var act = actBtn ? actBtn.getAttribute('data-act') : 'pick';

    if (act === 'rm') {
      e.preventDefault();
      if (countFields(schemaFields) <= 1) return;
      var path = findPath(schemaFields, id);
      if (!path) return;
      parentList(schemaFields, path).splice(path[path.length - 1], 1);
      if (selectedFieldId === id) selectedFieldId = schemaFields[0] ? schemaFields[0].id : null;
      paintSchema();
      return;
    }

    // type / + / row click → select and show tools in the side panel
    selectColumn(id);
  });

  $('sideTypes').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-set-type]');
    if (!btn) return;
    var f = selectedField();
    if (!f) return;
    var nextType = btn.getAttribute('data-set-type');
    if (f.children && f.children.length && nextType !== 'group') nextType = 'group';
    f.type = nextType;
    if (f.type === 'group' && !f.children) f.children = [];
    paintSchema();
  });
  $('sideAddUnder').addEventListener('click', function () {
    var f = selectedField();
    if (!f) return;
    if (!f.children) f.children = [];
    f.type = 'group';
    var child = newField('text', nextColumnLabel());
    f.children.push(child);
    selectedFieldId = child.id;
    paintSchema();
    focusLabel(child.id);
  });
  $('sideAddNew').addEventListener('click', function () {
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
  $('sideRemove').addEventListener('click', function () {
    if (countFields(schemaFields) <= 1) return;
    var path = findPath(schemaFields, selectedFieldId);
    if (!path) return;
    parentList(schemaFields, path).splice(path[path.length - 1], 1);
    selectedFieldId = schemaFields[0] ? schemaFields[0].id : null;
    paintSchema();
  });

  $('newForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('fErr'); err.hidden = true;
    var offices = Object.keys(selectedOffices).map(function (k) { return selectedOffices[k]; });
    var users = Object.keys(selectedUsers).map(function (k) { return selectedUsers[k]; });
    var schema = exportSchema();
    if (!offices.length) { err.textContent = 'Pick at least one office.'; err.hidden = false; setWizard(2); return; }
    if (!schema.fields.length) { err.textContent = 'Add at least one column.'; err.hidden = false; return; }
    if (!$('fDue').value) { err.textContent = 'Save a submit-by date on Basics.'; err.hidden = false; setWizard(1); return; }
    var due = $('fDue').value;
    var ext = $('fExt').value;
    var body = {
      title: $('fTitle').value.trim(),
      due_at: due ? new Date(due).toISOString() : '',
      offices: offices,
      users: users,
      schema: schema
    };
    if (ext) body.extended_due_at = new Date(ext).toISOString();
    $('fSave').disabled = true;
    try {
      await api('/api/collect/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body)
      });
      tab = 'mine';
      showMode('list');
      await loadList();
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
    } finally {
      $('fSave').disabled = false;
    }
  });

  $('list').addEventListener('click', function (e) {
    var asg = e.target.closest('[data-open-asg]');
    if (asg) { openFill(asg.getAttribute('data-open-asg')); return; }
    var req = e.target.closest('[data-open-req]');
    if (req) openDetail(req.getAttribute('data-open-req'));
  });
  $('fillBack').addEventListener('click', backToList);
  $('detailBack').addEventListener('click', backToList);

  $('fillForm').addEventListener('click', function (e) {
    if (!fillState || !fillState.can_edit) return;
    var add = e.target.closest('[data-add]');
    var del = e.target.closest('[data-del]');
    if (add) {
      fillState.payload = readFillPayload();
      var parts = add.getAttribute('data-add').split('.');
      var group = findGroupDef(fillState.schema.fields, parts);
      var arr = getAt(fillState.payload.fields, parts);
      if (!Array.isArray(arr)) { setAt(fillState.payload.fields, parts, []); arr = getAt(fillState.payload.fields, parts); }
      arr.push(emptyItem(group && group.children));
      $('fillForm').innerHTML = renderFields(fillState.schema.fields, fillState.payload.fields, [], true);
    }
    if (del) {
      fillState.payload = readFillPayload();
      var p = del.getAttribute('data-del').split('.');
      var idx = Number(p.pop());
      var arr2 = getAt(fillState.payload.fields, p);
      if (Array.isArray(arr2)) arr2.splice(idx, 1);
      $('fillForm').innerHTML = renderFields(fillState.schema.fields, fillState.payload.fields, [], true);
    }
  });
  async function saveOrSubmit(submit) {
    if (!fillState) return;
    $('fillErr').hidden = true; $('fillOk').hidden = true;
    fillState.payload = readFillPayload();
    try {
      var r = await api('/api/collect/assignments/' + encodeURIComponent(fillState.id) + (submit ? '/submit' : '/draft'), {
        method: submit ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ payload: fillState.payload })
      });
      $('fillOk').textContent = submit ? ('Submitted' + (r.late ? ' (late)' : '')) : ('Saved' + (r.late ? ' (late)' : ''));
      $('fillOk').hidden = false;
      if (submit) openFill(fillState.id);
    } catch (err) {
      $('fillErr').textContent = err.message; $('fillErr').hidden = false;
    }
  }
  $('fillSave').addEventListener('click', function () { saveOrSubmit(false); });
  $('fillSubmit').addEventListener('click', function () {
    if (!confirm('Submit this office report?')) return;
    saveOrSubmit(true);
  });

  $('detailTree').addEventListener('click', async function (e) {
    var open = e.target.closest('[data-open-asg]');
    if (open) { openFill(open.getAttribute('data-open-asg')); return; }
    var ret = e.target.closest('[data-return]');
    if (!ret || !detailState) return;
    try {
      await api('/api/collect/assignments/' + encodeURIComponent(ret.getAttribute('data-return')) + '/return', { method: 'POST' });
      openDetail(detailState.id);
    } catch (err) { $('detailErr').textContent = err.message; $('detailErr').hidden = false; }
  });
  $('detailQuick').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-pick]');
    if (!btn) return;
    var pick = btn.getAttribute('data-pick');
    document.querySelectorAll('#detailOffices input').forEach(function (inp) {
      if (inp.disabled) return;
      var o = officeOpts[Number(inp.getAttribute('data-i'))];
      if (pick === 'all') inp.checked = true;
      else if (pick === 'none') inp.checked = false;
      else inp.checked = o && o.level === pick;
    });
  });
  $('detailAdd').addEventListener('click', async function () {
    if (!detailState) return;
    var offices = [];
    document.querySelectorAll('#detailOffices input:checked').forEach(function (inp) {
      if (!inp.disabled) offices.push(officeOpts[Number(inp.getAttribute('data-i'))]);
    });
    if (!offices.length) { $('detailErr').textContent = 'Select offices to add.'; $('detailErr').hidden = false; return; }
    try {
      await api('/api/collect/requests/' + encodeURIComponent(detailState.id) + '/offices', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offices: offices })
      });
      openDetail(detailState.id);
    } catch (err) { $('detailErr').textContent = err.message; $('detailErr').hidden = false; }
  });
  $('detailRemove').addEventListener('click', async function () {
    if (!detailState) return;
    var ids = [];
    document.querySelectorAll('#detailTree input[data-aid]:checked').forEach(function (inp) { ids.push(inp.getAttribute('data-aid')); });
    if (!ids.length) { $('detailErr').textContent = 'Check offices to remove.'; $('detailErr').hidden = false; return; }
    try {
      await api('/api/collect/requests/' + encodeURIComponent(detailState.id) + '/offices/remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignment_ids: ids })
      });
      openDetail(detailState.id);
    } catch (err) { $('detailErr').textContent = err.message; $('detailErr').hidden = false; }
  });
  $('detailExtendSave').addEventListener('click', async function () {
    if (!detailState) return;
    $('detailExtendErr').hidden = true;
    $('detailExtendOk').hidden = true;
    var raw = $('detailExtendAt').value;
    if (!raw) {
      $('detailExtendErr').textContent = 'Pick a date first.'; $('detailExtendErr').hidden = false; return;
    }
    var d = new Date(raw);
    if (isNaN(d.getTime())) {
      $('detailExtendErr').textContent = 'Invalid date.'; $('detailExtendErr').hidden = false; return;
    }
    try {
      await api('/api/collect/requests/' + encodeURIComponent(detailState.id) + '/extend', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ extended_due_at: d.toISOString() })
      });
      $('detailExtendOk').hidden = false;
      openDetail(detailState.id);
    } catch (err) { $('detailExtendErr').textContent = err.message; $('detailExtendErr').hidden = false; }
  });
  $('detailExport').addEventListener('click', async function () {
    if (!detailState) return;
    try {
      var data = await api('/api/collect/requests/' + encodeURIComponent(detailState.id) + '/export');
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'collect-' + detailState.id + '.json'; a.click(); URL.revokeObjectURL(a.href);
    } catch (err) { $('detailErr').textContent = err.message; $('detailErr').hidden = false; }
  });

  showMode('list');
  bootCreate().then(loadList);
  setInterval(function () {
    if (!document.hidden && mode === 'list') loadList();
  }, 60000);
})();
