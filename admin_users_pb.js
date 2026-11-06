/* admin_users_pb.js: Admin -> Users additions for the VM user store (MZO_USER_STORE=pocketbase; docs/users.md).
 * Loaded by admin_users.html, which calls the hooks below. It does nothing until GET /api/admin/users answers
 * with store: 'pocketbase', so on Vercel and locally the page is unchanged.
 *
 *   MzoUsersPb.onList(data)      after the user list loads: turns the additions on
 *   MzoUsersPb.rowActions(user)  extra row buttons (Data permissions)
 *   MzoUsersPb.roleBadge(user)   badge for the editor role, or ''
 *   MzoUsersPb.fill(user)        fill the extra form fields (null: a new user)
 *   MzoUsersPb.extras()          the extra fields for the save payload
 */
(function () {
  'use strict';
  var state = { on: false, modules: [], builtIn: [] };
  var $ = function (id) { return document.getElementById(id); };
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function groupedModules() {
    var groups = [];
    var byName = {};
    state.modules.forEach(function (m) {
      if (!byName[m.group]) { byName[m.group] = { name: m.group, items: [] }; groups.push(byName[m.group]); }
      byName[m.group].items.push(m);
    });
    return groups;
  }

  function injectForm() {
    if ($('pbAccountSection')) return;
    // Role: the editor role (data editor) exists only in this store.
    var role = $('roleInput');
    if (role && !role.querySelector('option[value="editor"]')) {
      var opt = document.createElement('option');
      opt.value = 'editor';
      opt.textContent = 'Editor (Data editor)';
      role.appendChild(opt);
    }
    var susp = $('userStatusInput') && $('userStatusInput').querySelector('option[value="suspended"]');
    if (susp) susp.textContent = 'Disabled (cannot sign in)';
    var email = $('emailInput');
    if (email) {
      email.required = true;
      email.placeholder = 'officer@gmail.com (required: Google sign-in)';
    }

    var anchor = document.querySelector('#userForm .modal-body .auth-section');
    if (!anchor) return;
    var sec = document.createElement('div');
    sec.className = 'auth-section';
    sec.id = 'pbAccountSection';
    var groups = groupedModules().map(function (g) {
      return '<div class="pb-mod-group"><div class="pb-mod-head">' + esc(g.name) + '</div>' + g.items.map(function (m) {
        return '<label class="pb-mod-item"><input type="checkbox" class="pb-mod" value="' + esc(m.key) + '" /> <span>' + esc(m.name) + '</span></label>';
      }).join('') + '</div>';
    }).join('');
    sec.innerHTML =
      '<style>' +
      '#pbAccountSection .pb-mods{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;max-height:240px;overflow:auto;padding:8px;border:1px solid var(--mzo-border,rgba(148,163,184,.25));border-radius:8px;margin-top:6px}' +
      '#pbAccountSection .pb-mod-head{font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.03em}' +
      '#pbAccountSection .pb-mod-item{display:flex;align-items:center;gap:6px;font-size:12px;text-transform:none;letter-spacing:0;margin:2px 0;cursor:pointer}' +
      '#pbAccountSection .pb-mod-item input{width:auto;margin:0}' +
      '#pbAccountSection .pb-hist{font-size:12px;max-height:180px;overflow:auto;margin-top:6px}' +
      '#pbAccountSection .pb-hist-row{padding:5px 0;border-bottom:1px solid var(--mzo-border,rgba(148,163,184,.18))}' +
      '#pbAccountSection .pb-hist-row:last-child{border-bottom:0}' +
      '#pbAccountSection .pb-hist-meta{color:var(--text-muted);font-size:11px}' +
      '#pbAccountSection .pb-note{font-size:11.5px;color:var(--text-muted);margin:0 0 8px}' +
      '</style>' +
      '<div class="auth-section-header"><span class="auth-section-title"><i class="fas fa-address-card"></i> Account details, reports and history</span>' +
      '<span class="auth-section-subtitle" id="pbBuiltInNote"></span></div>' +
      '<div class="auth-card-box">' +
      '<p class="pb-note">Sign-in is Google only: the account is matched by its email. Changing the role, office or status signs the user out everywhere.</p>' +
      '<div class="form-row">' +
      '<div class="form-group"><label for="pbDesignation">Designation</label><input type="text" id="pbDesignation" maxlength="120" placeholder="e.g. Assistant Engineer" /></div>' +
      '<div class="form-group"><label for="pbEmployeeId">Employee ID</label><input type="text" id="pbEmployeeId" maxlength="40" /></div>' +
      '</div>' +
      '<div class="form-row" style="margin-top:8px">' +
      '<div class="form-group"><label for="pbPhone">Phone</label><input type="tel" id="pbPhone" maxlength="20" /></div>' +
      '<div class="form-group"><label for="pbDisabledReason">Reason (disabled or rejected)</label><input type="text" id="pbDisabledReason" maxlength="500" /></div>' +
      '</div>' +
      '<div class="form-row" style="margin-top:8px"><div class="form-group" style="width:100%"><label for="pbNotes">Notes</label><input type="text" id="pbNotes" maxlength="2000" /></div></div>' +
      '<div class="form-row" style="margin-top:8px"><div class="form-group" style="width:100%">' +
      '<label for="pbModulesMode">Reports this user can open</label>' +
      '<select id="pbModulesMode"><option value="all">All reports</option><option value="some">Only the reports ticked below</option></select>' +
      '<div class="pb-mods" id="pbModules" style="display:none">' + groups + '</div>' +
      '<small class="auth-count" id="pbModulesCount"></small>' +
      '</div></div>' +
      '<div class="form-row" style="margin-top:8px" id="pbHistoryRow"><div class="form-group" style="width:100%">' +
      '<label>Change history</label><div class="pb-hist" id="pbHistory">No changes yet.</div>' +
      '</div></div>' +
      '</div>';
    anchor.parentNode.insertBefore(sec, anchor.nextSibling);
    $('pbModulesMode').addEventListener('change', syncModulesUi);
    $('pbModules').addEventListener('change', syncModulesUi);
  }

  function syncModulesUi() {
    var some = $('pbModulesMode').value === 'some';
    $('pbModules').style.display = some ? '' : 'none';
    var n = document.querySelectorAll('#pbModules .pb-mod:checked').length;
    $('pbModulesCount').textContent = some ? n + ' of ' + state.modules.length + ' reports' : '';
  }

  function describeChange(c) {
    var show = function (v) {
      if (v == null || v === '') return '(empty)';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    };
    return esc(c.field) + ': ' + esc(show(c.from)) + ' &rarr; ' + esc(show(c.to));
  }

  function loadHistory(username) {
    var box = $('pbHistory');
    if (!box) return;
    if (!username) { box.textContent = 'No changes yet.'; return; }
    box.textContent = 'Loading…';
    fetch('/api/admin/users/audit?username=' + encodeURIComponent(username), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var rows = (d && d.audit) || [];
        if (!rows.length) { box.textContent = 'No changes yet.'; return; }
        box.innerHTML = rows.map(function (a) {
          var when = a.at ? new Date(a.at).toLocaleString() : '';
          var who = a.actor_name || a.actor_email || 'system';
          return '<div class="pb-hist-row"><div><strong>' + esc(a.action) + '</strong>' +
            (a.changes && a.changes.length ? ' · ' + a.changes.map(describeChange).join('; ') : '') +
            (a.reason ? ' · <em>' + esc(a.reason) + '</em>' : '') + '</div>' +
            '<div class="pb-hist-meta">' + esc(when) + ' · ' + esc(who) + '</div></div>';
        }).join('');
      })
      .catch(function () { box.textContent = 'Could not load the history.'; });
  }

  window.MzoUsersPb = {
    onList: function (data) {
      if (!data || data.store !== 'pocketbase') return;
      state.on = true;
      state.modules = Array.isArray(data.modules) ? data.modules : [];
      state.builtIn = Array.isArray(data.builtInAdmins) ? data.builtInAdmins : [];
      injectForm();
    },
    rowActions: function (user) {
      if (!state.on || !user || !user.email) return '';
      var href = '/editor/#/permissions?email=' + encodeURIComponent(user.email);
      return '<a class="btn-row-action" href="' + esc(href) + '" target="_blank" rel="noopener" title="Data permissions" onclick="event.stopPropagation()"><i class="fas fa-table-list"></i></a>';
    },
    roleBadge: function (user) {
      if (!state.on || !user || user.role !== 'editor') return '';
      return '<span class="badge badge-user" title="Editor: may use the data editor"><i class="fas fa-pen-to-square"></i> Editor</span>';
    },
    fill: function (user) {
      if (!state.on) return;
      injectForm();
      var u = user || {};
      // viewer is the select's blank "User (Standard)" option.
      if ($('roleInput')) $('roleInput').value = u.role === 'admin' || u.role === 'editor' ? u.role : '';
      $('pbDesignation').value = u.designation || '';
      $('pbEmployeeId').value = u.employee_id || '';
      $('pbPhone').value = u.phone || '';
      $('pbNotes').value = u.notes || '';
      $('pbDisabledReason').value = u.disabled_reason || '';
      var mods = Array.isArray(u.modules) ? u.modules : null;
      $('pbModulesMode').value = mods ? 'some' : 'all';
      document.querySelectorAll('#pbModules .pb-mod').forEach(function (c) { c.checked = !!mods && mods.indexOf(c.value) !== -1; });
      syncModulesUi();
      var seeded = !!u.email && state.builtIn.indexOf(String(u.email).toLowerCase()) !== -1;
      $('pbBuiltInNote').textContent = seeded ? 'Built-in admin (MZO_ADMIN_EMAILS): always an active admin' : '';
      $('pbHistoryRow').style.display = user ? '' : 'none';
      loadHistory(user ? u.Username : '');
    },
    extras: function () {
      if (!state.on || !$('pbAccountSection')) return {};
      var some = $('pbModulesMode').value === 'some';
      return {
        designation: $('pbDesignation').value.trim(),
        employee_id: $('pbEmployeeId').value.trim(),
        phone: $('pbPhone').value.trim(),
        notes: $('pbNotes').value.trim(),
        disabled_reason: $('pbDisabledReason').value.trim(),
        modules: some ? Array.prototype.map.call(document.querySelectorAll('#pbModules .pb-mod:checked'), function (c) { return c.value; }) : null
      };
    }
  };
})();
