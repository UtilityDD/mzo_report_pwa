/* DISHA Collect client — inbox, create, fill, hierarchy. See docs/collect.md */
(function () {
  'use strict';

  var tab = 'inbox';
  var canCreate = false;
  var officeOpts = [];
  var schemaFields = [];
  var uid = 0;
  var fillState = null; // { id, schema, payload, can_edit }
  var detailState = null; // { id, detail }
  var FIELD_TYPES = [
    { v: 'text', n: 'Text' },
    { v: 'number', n: 'Number' },
    { v: 'date', n: 'Date' },
    { v: 'checkbox', n: 'Checkbox' },
    { v: 'textarea', n: 'Long text' },
    { v: 'select', n: 'Select (comma options)' },
    { v: 'group', n: 'List (repeat)' }
  ];

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function nextId(prefix) { uid += 1; return (prefix || 'f') + uid; }
  function newField(type) {
    return { id: nextId('f'), type: type || 'text', label: '', required: false, options: '', children: [] };
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
    else if (timing && timing.late) h += '<span class="chip late">Late window</span><span class="chip clock">' + esc(fmtLeft(timing.ms_left)) + ' left</span>';
    else if (timing) h += '<span class="chip clock">' + esc(fmtLeft(timing.ms_left)) + ' left</span>';
    return h;
  }
  function cardClass(item) {
    var c = 'col-card';
    if (item.status === 'submitted') return c;
    if (item.timing && item.timing.locked) return c + ' locked';
    if (item.timing && (item.timing.late || (item.timing.ms_left != null && item.timing.ms_left < 86400000))) return c + ' due';
    return c;
  }
  function tierLabel(level) {
    return ({ region: 'RM', division: 'DM', ccc: 'SM', zone: 'CE' })[level] || level || '';
  }

  async function api(path, opts) {
    var res = await fetch(path, Object.assign({
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }, opts || {}));
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }

  function showMain(show) {
    $('mainHead').hidden = !show;
    $('listWrap').hidden = !show;
    if (!show) $('newForm').classList.remove('on');
  }
  function showFill(on) { $('fillPanel').classList.toggle('on', !!on); }
  function showDetail(on) { $('detailPanel').classList.toggle('on', !!on); }

  /* ---------- office pickers ---------- */
  function setChecks(rootSel, pred) {
    document.querySelectorAll(rootSel + ' input[type="checkbox"]').forEach(function (inp) {
      var o = officeOpts[Number(inp.getAttribute('data-i'))];
      inp.checked = !!(o && pred(o));
    });
  }
  function paintOfficeBox(elId) {
    $(elId).innerHTML = officeOpts.map(function (x, i) {
      return '<label><input type="checkbox" data-i="' + i + '" /> ' +
        esc(x.office_label) + '<span class="tier">' + esc(tierLabel(x.level)) + '</span></label>';
    }).join('') || '<div class="meta">No subordinate offices in your scope.</div>';
  }
  function selectedOffices(rootSel) {
    var out = [];
    document.querySelectorAll(rootSel + ' input:checked').forEach(function (inp) {
      var o = officeOpts[Number(inp.getAttribute('data-i'))];
      if (o) out.push(o);
    });
    return out;
  }

  /* ---------- schema builder ---------- */
  function typeOptions(cur) {
    return FIELD_TYPES.map(function (t) {
      return '<option value="' + t.v + '"' + (t.v === cur ? ' selected' : '') + '>' + esc(t.n) + '</option>';
    }).join('');
  }
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
    for (var i = 0; i < path.length; i++) {
      if (path[i] === 'children') cur = cur.children;
      else cur = cur[path[i]];
    }
    return cur;
  }
  function parentList(list, path) {
    var parent = list;
    for (var j = 0; j < path.length - 1; j++) {
      if (path[j] === 'children') parent = parent.children;
      else parent = parent[path[j]];
    }
    return Array.isArray(parent) ? parent : parent.children;
  }
  function paintField(f) {
    var isGroup = f.type === 'group';
    var h = '<div class="col-field" data-id="' + esc(f.id) + '"><div class="col-field-row">';
    h += '<input type="text" data-act="label" placeholder="' + (isGroup ? 'List name (e.g. Block)' : 'Field label') + '" value="' + esc(f.label) + '" />';
    h += '<select data-act="type">' + typeOptions(f.type) + '</select>';
    h += '<label class="req"><input type="checkbox" data-act="req"' + (f.required ? ' checked' : '') + ' /> Req</label>';
    h += '<button type="button" class="col-btn ghost sm" data-act="rm">✕</button></div>';
    if (f.type === 'select') {
      h += '<input type="text" data-act="options" placeholder="Options, comma-separated" value="' + esc(f.options || '') + '" style="margin-top:6px" />';
    }
    if (isGroup) {
      h += '<div class="kids"><div class="kids-h"><span>Each item has</span>';
      h += '<button type="button" class="col-btn ghost sm" data-act="add-child">+ Field</button></div>';
      (f.children || []).forEach(function (c) { h += paintField(c); });
      h += '</div>';
    }
    return h + '</div>';
  }
  function previewLines(fields, indent) {
    indent = indent || 0;
    var pad = Array(indent + 1).join('· ');
    var lines = [];
    fields.forEach(function (f) {
      var lab = f.label || '(untitled)';
      if (f.type === 'group') {
        lines.push(pad + '<strong>' + esc(lab) + '</strong> — list');
        lines = lines.concat(previewLines(f.children || [], indent + 1));
      } else {
        lines.push(pad + esc(lab) + ' <span>(' + esc(f.type) + (f.required ? ', required' : '') + ')</span>');
      }
    });
    return lines;
  }
  function syncPreviewOnly() {
    var prev = $('schemaPreview');
    if (!schemaFields.length) { prev.innerHTML = 'Preview will appear here.'; return; }
    prev.innerHTML = '<strong>Assignees will see</strong><ul>' +
      previewLines(schemaFields).map(function (l) { return '<li>' + l + '</li>'; }).join('') + '</ul>';
  }
  function paintSchema() {
    $('schemaRoot').innerHTML = schemaFields.length
      ? schemaFields.map(paintField).join('')
      : '<div class="col-builder-help" style="margin:0">No fields yet — add the data you need.</div>';
    syncPreviewOnly();
  }
  function exportSchema() {
    function walk(list) {
      return list.map(function (f) {
        var label = String(f.label || '').trim() || 'Untitled';
        var id = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || f.id;
        var out = { id: id, type: f.type, label: label, required: !!f.required };
        if (f.type === 'select') {
          out.options = String(f.options || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        }
        if (f.type === 'group') {
          out.repeat = true;
          out.children = walk(f.children || []);
        }
        return out;
      });
    }
    return { fields: walk(schemaFields) };
  }
  function seedSchema() {
    var block = newField('group'); block.label = 'Block';
    var village = newField('group'); village.label = 'Village';
    var para = newField('group'); para.label = 'Para';
    var scheme = newField('group'); scheme.label = 'Scheme';
    scheme.children = [
      Object.assign(newField('text'), { label: 'Scheme name', required: true }),
      Object.assign(newField('number'), { label: 'Consumers' }),
      Object.assign(newField('number'), { label: 'Poles needed' }),
      Object.assign(newField('number'), { label: 'Scheme value (₹)' }),
      Object.assign(newField('checkbox'), { label: 'Ready for work' })
    ];
    para.children = [Object.assign(newField('text'), { label: 'Para name', required: true }), scheme];
    village.children = [Object.assign(newField('text'), { label: 'Village name', required: true }), para];
    block.children = [Object.assign(newField('text'), { label: 'Block name', required: true }), village];
    schemaFields = [block];
    paintSchema();
  }

  /* ---------- fill form ---------- */
  function emptyItem(fields) {
    var o = {};
    (fields || []).forEach(function (f) {
      if (f.type === 'group') o[f.id] = [];
      else if (f.type === 'checkbox') o[f.id] = false;
      else o[f.id] = '';
    });
    return o;
  }
  function ensurePayload(schema, payload) {
    var root = (payload && payload.fields) ? payload.fields : (payload || {});
    var fields = (schema && schema.fields) || [];
    fields.forEach(function (f) {
      if (f.type === 'group') {
        if (!Array.isArray(root[f.id])) root[f.id] = [];
      } else if (root[f.id] === undefined) {
        root[f.id] = f.type === 'checkbox' ? false : '';
      }
    });
    return { fields: root };
  }
  function renderFields(fields, data, path, canEdit) {
    var h = '';
    (fields || []).forEach(function (f) {
      var key = path.concat([f.id]).join('.');
      if (f.type === 'group') {
        var list = Array.isArray(data[f.id]) ? data[f.id] : [];
        h += '<div class="fill-group" data-path="' + esc(key) + '">';
        h += '<div class="fill-group-h"><strong>' + esc(f.label || f.id) + '</strong>';
        if (canEdit) h += '<button type="button" class="col-btn ghost sm" data-add="' + esc(key) + '">+ Add</button>';
        h += '</div>';
        list.forEach(function (item, i) {
          h += '<div class="fill-item" data-path="' + esc(key + '.' + i) + '">';
          h += '<div class="fill-item-h"><span>#' + (i + 1) + '</span>';
          if (canEdit) h += '<button type="button" class="col-btn ghost sm" data-del="' + esc(key + '.' + i) + '">Remove</button>';
          h += '</div>';
          h += renderFields(f.children || [], item || {}, path.concat([f.id, String(i)]), canEdit);
          h += '</div>';
        });
        if (!list.length) h += '<div class="meta" style="color:var(--mzo-faint);font-size:12.5px;margin-bottom:6px">No items yet.</div>';
        h += '</div>';
        return;
      }
      var val = data[f.id];
      h += '<div class="fill-field">';
      h += '<label>' + esc(f.label || f.id) + (f.required ? ' *' : '') + '</label>';
      if (f.type === 'checkbox') {
        h += '<label class="chk"><input type="checkbox" data-k="' + esc(key) + '"' + (val ? ' checked' : '') + (canEdit ? '' : ' disabled') + ' /> Yes</label>';
      } else if (f.type === 'textarea') {
        h += '<textarea rows="3" data-k="' + esc(key) + '"' + (canEdit ? '' : ' disabled') + '>' + esc(val == null ? '' : val) + '</textarea>';
      } else if (f.type === 'select') {
        h += '<select data-k="' + esc(key) + '"' + (canEdit ? '' : ' disabled') + '><option value="">—</option>';
        (f.options || []).forEach(function (opt) {
          h += '<option value="' + esc(opt) + '"' + (String(val) === String(opt) ? ' selected' : '') + '>' + esc(opt) + '</option>';
        });
        h += '</select>';
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
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }
  function setAt(root, parts, value) {
    var cur = root;
    for (var i = 0; i < parts.length - 1; i++) {
      var p = parts[i];
      if (cur[p] == null) cur[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
  }
  function readFillPayload() {
    var root = JSON.parse(JSON.stringify((fillState.payload && fillState.payload.fields) || {}));
    document.querySelectorAll('#fillForm [data-k]').forEach(function (el) {
      var parts = el.getAttribute('data-k').split('.');
      var v;
      if (el.type === 'checkbox') v = !!el.checked;
      else if (el.type === 'number') v = el.value === '' ? '' : Number(el.value);
      else v = el.value;
      setAt(root, parts, v);
    });
    return { fields: root };
  }
  function findGroupDef(fields, pathParts) {
    // path like block.0.village — find the group field for "block" then "village"
    var list = fields;
    var group = null;
    for (var i = 0; i < pathParts.length; i++) {
      if (/^\d+$/.test(pathParts[i])) continue;
      group = (list || []).find(function (f) { return f.id === pathParts[i]; });
      if (!group) return null;
      list = group.children || [];
    }
    return group;
  }
  async function openFill(assignmentId) {
    showMain(false); showDetail(false); showFill(true);
    $('fillErr').hidden = true; $('fillOk').hidden = true;
    $('fillForm').innerHTML = '<div class="col-empty">Loading…</div>';
    try {
      var d = await api('/api/collect/assignments/' + encodeURIComponent(assignmentId));
      fillState = {
        id: assignmentId,
        schema: d.schema || { fields: [] },
        payload: ensurePayload(d.schema, d.payload),
        can_edit: !!d.can_edit,
        assignment: d.assignment,
        timing: d.timing
      };
      $('fillTitle').textContent = d.assignment.title;
      $('fillMeta').textContent = d.assignment.office_label + ' · ' + d.assignment.status +
        (d.assignment.last_saved_by_name ? (' · Last saved by ' + d.assignment.last_saved_by_name) : '');
      $('fillChips').innerHTML = chipsHtml(d.timing, d.assignment.status) +
        (d.can_edit ? '' : '<span class="chip locked">Read-only</span>');
      $('fillSave').disabled = !d.can_edit;
      $('fillSubmit').disabled = !d.can_edit;
      $('fillForm').innerHTML = renderFields(fillState.schema.fields, fillState.payload.fields, [], d.can_edit);
    } catch (err) {
      $('fillForm').innerHTML = '<div class="col-empty">' + esc(err.message) + '</div>';
    }
  }

  /* ---------- detail / hierarchy ---------- */
  async function openDetail(requestId) {
    showMain(false); showFill(false); showDetail(true);
    $('detailErr').hidden = true;
    $('detailTree').innerHTML = '<div class="col-empty">Loading…</div>';
    try {
      var d = await api('/api/collect/requests/' + encodeURIComponent(requestId));
      detailState = { id: requestId, detail: d };
      var r = d.request;
      $('detailTitle').textContent = r.title;
      $('detailMeta').textContent = (r.created_by_name || r.created_by_email) + ' · ' + r.status +
        ' · ' + (d.assignments || []).length + ' offices';
      $('detailChips').innerHTML = chipsHtml(r.timing, r.status === 'closed' ? 'submitted' : 'pending');
      paintOfficeBox('detailOffices');
      // uncheck offices already assigned
      var have = {};
      (d.assignments || []).forEach(function (a) {
        if (a.status === 'withdrawn') return;
        have[[a.office_level, a.region, a.division, a.ccc_code].join('|')] = 1;
      });
      document.querySelectorAll('#detailOffices input').forEach(function (inp) {
        var o = officeOpts[Number(inp.getAttribute('data-i'))];
        if (!o) return;
        var k = [o.level, o.region, o.division, o.ccc_code].join('|');
        if (have[k]) { inp.checked = false; inp.disabled = true; }
        else inp.disabled = false;
      });
      $('detailTree').innerHTML = (d.assignments || []).map(function (a) {
        return '<div class="tree-row">' +
          '<label style="display:flex;gap:8px;align-items:center;margin:0">' +
          (a.status !== 'submitted' && a.status !== 'withdrawn'
            ? '<input type="checkbox" data-aid="' + esc(a.id) + '" />' : '<span style="width:16px"></span>') +
          '<span><b>' + esc(a.office_label) + '</b><br><span style="font-size:12px;color:var(--mzo-muted)">' +
          esc(a.status) + (a.last_saved_by_name ? ' · ' + esc(a.last_saved_by_name) : '') + '</span></span></label>' +
          '<div class="col-chips">' + chipsHtml(a.timing, a.status) +
          (a.status === 'submitted' ? '<button type="button" class="chip late" data-return="' + esc(a.id) + '">Return</button>' : '') +
          (a.status !== 'withdrawn' ? '<button type="button" class="chip clock" data-open-asg="' + esc(a.id) + '">Open</button>' : '') +
          '</div></div>';
      }).join('') || '<div class="col-empty">No offices</div>';
    } catch (err) {
      $('detailTree').innerHTML = '<div class="col-empty">' + esc(err.message) + '</div>';
    }
  }

  /* ---------- lists ---------- */
  function paintInbox(data) {
    var el = $('list');
    var items = (data && data.items) || [];
    if (!data || data.available === false) {
      el.innerHTML = '<div class="col-empty">DISHA Collect runs on the VM. This host has no PocketBase store.</div>';
      return;
    }
    if (!items.length) {
      el.innerHTML = '<div class="col-empty">No Collect requests for your office right now.</div>';
      return;
    }
    el.innerHTML = items.map(function (it) {
      return '<button type="button" class="' + cardClass(it) + '" data-open-asg="' + esc(it.assignment_id) + '">' +
        '<div><h2>' + esc(it.title) + '</h2>' +
        '<div class="meta">' + esc(it.office_label) + ' · ' + esc(it.status) + '</div>' +
        (it.last_saved_by_name ? '<div class="stamp">Last saved by ' + esc(it.last_saved_by_name) + '</div>' : '') +
        '</div><div class="col-chips">' + chipsHtml(it.timing || {}, it.status) + '</div></button>';
    }).join('');
  }
  function paintMine(data) {
    var el = $('list');
    var items = (data && data.items) || [];
    if (!items.length) {
      el.innerHTML = '<div class="col-empty">You have not opened any Collect requests yet.</div>';
      return;
    }
    el.innerHTML = items.map(function (it) {
      return '<button type="button" class="' + cardClass({ timing: it.timing, status: it.status === 'open' ? 'pending' : 'submitted' }) +
        '" data-open-req="' + esc(it.id) + '">' +
        '<div><h2>' + esc(it.title) + '</h2>' +
        '<div class="meta">' + esc(it.office_count) + ' office' + (it.office_count === 1 ? '' : 's') + ' · ' + esc(it.status) + '</div></div>' +
        '<div class="col-chips">' + chipsHtml(it.timing || {}, it.status === 'closed' ? 'submitted' : 'pending') + '</div></button>';
    }).join('');
  }
  async function loadList() {
    try {
      if (tab === 'inbox') paintInbox(await api('/api/collect/inbox'));
      else paintMine(await api('/api/collect/requests'));
    } catch (err) {
      $('list').innerHTML = '<div class="col-empty">' + esc(err.message) + '</div>';
    }
  }

  /* ---------- boot + events ---------- */
  async function bootCreate() {
    try {
      var st = await api('/api/collect/status');
      canCreate = !!(st && st.can_create && st.available !== false);
      $('newBtn').hidden = !canCreate;
      $('mineTab').hidden = !canCreate;
      if (canCreate) {
        var o = await api('/api/collect/offices');
        officeOpts = (o && o.offices) || [];
        paintOfficeBox('fOffices');
        paintSchema();
      }
    } catch (e) {
      $('newBtn').hidden = true;
    }
  }

  document.querySelector('.col-tabs').addEventListener('click', function (e) {
    var btn = e.target.closest('.col-tab');
    if (!btn) return;
    tab = btn.getAttribute('data-tab');
    document.querySelectorAll('.col-tab').forEach(function (b) {
      b.classList.toggle('on', b === btn);
    });
    loadList();
  });

  ['officeQuick', 'detailQuick'].forEach(function (id) {
    $(id).addEventListener('click', function (e) {
      var btn = e.target.closest('[data-pick]');
      if (!btn) return;
      var pick = btn.getAttribute('data-pick');
      var root = id === 'officeQuick' ? '#fOffices' : '#detailOffices';
      document.querySelectorAll(root + ' input[type="checkbox"]').forEach(function (inp) {
        if (inp.disabled) return;
        var o = officeOpts[Number(inp.getAttribute('data-i'))];
        if (!o) return;
        if (pick === 'all') inp.checked = true;
        else if (pick === 'none') inp.checked = false;
        else inp.checked = o.level === pick;
      });
    });
  });

  $('addRootField').addEventListener('click', function () {
    schemaFields.push(newField('text'));
    paintSchema();
  });
  $('schemaRoot').addEventListener('input', function (e) {
    var row = e.target.closest('.col-field');
    if (!row) return;
    var path = findPath(schemaFields, row.getAttribute('data-id'));
    if (!path) return;
    var f = atPath(schemaFields, path);
    var act = e.target.getAttribute('data-act');
    if (act === 'label') { f.label = e.target.value; syncPreviewOnly(); }
    if (act === 'options') { f.options = e.target.value; syncPreviewOnly(); }
  });
  $('schemaRoot').addEventListener('change', function (e) {
    var row = e.target.closest('.col-field');
    if (!row) return;
    var path = findPath(schemaFields, row.getAttribute('data-id'));
    if (!path) return;
    var f = atPath(schemaFields, path);
    var act = e.target.getAttribute('data-act');
    if (act === 'type') {
      f.type = e.target.value;
      if (f.type === 'group' && !f.children) f.children = [];
      paintSchema();
    }
    if (act === 'req') { f.required = !!e.target.checked; syncPreviewOnly(); }
  });
  $('schemaRoot').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var row = btn.closest('.col-field');
    if (!row) return;
    var path = findPath(schemaFields, row.getAttribute('data-id'));
    if (!path) return;
    var act = btn.getAttribute('data-act');
    if (act === 'rm') {
      parentList(schemaFields, path).splice(path[path.length - 1], 1);
      paintSchema();
    }
    if (act === 'add-child') {
      var f = atPath(schemaFields, path);
      if (!f.children) f.children = [];
      f.children.push(newField('text'));
      paintSchema();
    }
  });

  $('newBtn').addEventListener('click', function () {
    $('newForm').classList.add('on');
    if (!schemaFields.length) seedSchema();
  });
  $('fCancel').addEventListener('click', function () {
    $('newForm').classList.remove('on');
    $('fErr').hidden = true;
  });
  $('newForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('fErr'); err.hidden = true;
    var offices = selectedOffices('#fOffices');
    if (!offices.length) { err.textContent = 'Select at least one office.'; err.hidden = false; return; }
    var schema = exportSchema();
    if (!schema.fields.length) { err.textContent = 'Add at least one field to the report format.'; err.hidden = false; return; }
    var due = $('fDue').value;
    var ext = $('fExt').value;
    var body = {
      title: $('fTitle').value.trim(),
      due_at: due ? new Date(due).toISOString() : '',
      offices: offices,
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
      $('newForm').classList.remove('on');
      $('fTitle').value = '';
      schemaFields = [];
      paintSchema();
      setChecks('#fOffices', function () { return false; });
      tab = 'mine';
      document.querySelectorAll('.col-tab').forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-tab') === 'mine');
      });
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

  $('fillBack').addEventListener('click', function () {
    showFill(false); showMain(true); fillState = null; loadList();
  });
  $('detailBack').addEventListener('click', function () {
    showDetail(false); showMain(true); detailState = null; loadList();
  });

  $('fillForm').addEventListener('click', function (e) {
    if (!fillState || !fillState.can_edit) return;
    var add = e.target.closest('[data-add]');
    var del = e.target.closest('[data-del]');
    if (add) {
      fillState.payload = readFillPayload();
      var parts = add.getAttribute('data-add').split('.');
      var group = findGroupDef(fillState.schema.fields, parts);
      var arr = getAt(fillState.payload.fields, parts);
      if (!Array.isArray(arr)) {
        setAt(fillState.payload.fields, parts, []);
        arr = getAt(fillState.payload.fields, parts);
      }
      arr.push(emptyItem(group && group.children));
      $('fillForm').innerHTML = renderFields(fillState.schema.fields, fillState.payload.fields, [], true);
      return;
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
      var path = '/api/collect/assignments/' + encodeURIComponent(fillState.id) + (submit ? '/submit' : '/draft');
      var r = await api(path, {
        method: submit ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ payload: fillState.payload })
      });
      $('fillOk').textContent = submit
        ? ('Submitted' + (r.late ? ' (late stamp)' : ''))
        : ('Draft saved' + (r.late ? ' (late stamp)' : '') + (r.revision != null ? ' · rev ' + r.revision : ''));
      $('fillOk').hidden = false;
      if (submit) openFill(fillState.id);
    } catch (err) {
      $('fillErr').textContent = err.message; $('fillErr').hidden = false;
    }
  }
  $('fillSave').addEventListener('click', function () { saveOrSubmit(false); });
  $('fillSubmit').addEventListener('click', function () {
    if (!confirm('Submit this office report? You will not be able to edit until the requester returns it.')) return;
    saveOrSubmit(true);
  });

  $('detailTree').addEventListener('click', async function (e) {
    var open = e.target.closest('[data-open-asg]');
    if (open) { openFill(open.getAttribute('data-open-asg')); return; }
    var ret = e.target.closest('[data-return]');
    if (!ret || !detailState) return;
    try {
      await api('/api/collect/assignments/' + encodeURIComponent(ret.getAttribute('data-return')) + '/return', {
        method: 'POST', headers: { Accept: 'application/json' }
      });
      openDetail(detailState.id);
    } catch (err) {
      $('detailErr').textContent = err.message; $('detailErr').hidden = false;
    }
  });

  $('detailAdd').addEventListener('click', async function () {
    if (!detailState) return;
    $('detailErr').hidden = true;
    var offices = selectedOffices('#detailOffices').filter(function (o) {
      var inp = document.querySelector('#detailOffices input[data-i="' + officeOpts.indexOf(o) + '"]');
      return inp && !inp.disabled && inp.checked;
    });
    if (!offices.length) { $('detailErr').textContent = 'Select offices to add.'; $('detailErr').hidden = false; return; }
    try {
      await api('/api/collect/requests/' + encodeURIComponent(detailState.id) + '/offices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ offices: offices })
      });
      openDetail(detailState.id);
    } catch (err) {
      $('detailErr').textContent = err.message; $('detailErr').hidden = false;
    }
  });

  $('detailRemove').addEventListener('click', async function () {
    if (!detailState) return;
    var ids = [];
    document.querySelectorAll('#detailTree input[data-aid]:checked').forEach(function (inp) {
      ids.push(inp.getAttribute('data-aid'));
    });
    if (!ids.length) { $('detailErr').textContent = 'Check pending offices to remove.'; $('detailErr').hidden = false; return; }
    try {
      await api('/api/collect/requests/' + encodeURIComponent(detailState.id) + '/offices/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ assignment_ids: ids })
      });
      openDetail(detailState.id);
    } catch (err) {
      $('detailErr').textContent = err.message; $('detailErr').hidden = false;
    }
  });

  $('detailExtend').addEventListener('click', async function () {
    if (!detailState) return;
    var raw = prompt('Extend until (local). Example: 2026-11-20 18:00');
    if (!raw) return;
    var d = new Date(raw.replace(' ', 'T'));
    if (isNaN(d.getTime())) { alert('Could not parse date'); return; }
    try {
      await api('/api/collect/requests/' + encodeURIComponent(detailState.id) + '/extend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ extended_due_at: d.toISOString() })
      });
      openDetail(detailState.id);
    } catch (err) {
      $('detailErr').textContent = err.message; $('detailErr').hidden = false;
    }
  });

  $('detailExport').addEventListener('click', async function () {
    if (!detailState) return;
    try {
      var data = await api('/api/collect/requests/' + encodeURIComponent(detailState.id) + '/export');
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'collect-' + detailState.id + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      $('detailErr').textContent = err.message; $('detailErr').hidden = false;
    }
  });

  bootCreate().then(loadList);
  setInterval(function () {
    if (!document.hidden && !$('fillPanel').classList.contains('on') && !$('detailPanel').classList.contains('on')) loadList();
  }, 60000);
})();
