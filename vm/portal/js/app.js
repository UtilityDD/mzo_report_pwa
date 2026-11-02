/* Portal shell: sign-in, sidebar (datasets by source type or report area), routes, account menu.
 * Routes: #/ overview · #/d/<key> data · #/d/<key>/schema|source|history · #/quality · #/server
 */
(function (w) {
  'use strict';
  var P = w.Portal;
  var h = P.h, icon = P.icon, $ = P.$;
  var datasets = [], byKey = {}, current = null, mode = 'source', loaded = false, refreshTimer = null;

  var ctx = {
    datasets: function () { return datasets; },
    byKey: function (k) { return byKey[k] || null; }
  };

  /* ---------- sign-in ---------- */
  var REASONS = { expired: 'Your session has ended. Sign in again.', signedout: '' };
  function showLogin(reason) {
    stopTimers();
    if (current && current.dispose) current.dispose();
    current = null; loaded = false; datasets = []; byKey = {};
    P.drawer.close(); P.grid.closePop();
    P.clear($('view')); P.clear($('nav'));
    $('app').hidden = true;
    $('meMenu').hidden = true;
    $('login').hidden = false;
    document.title = 'Sign in · MZO Data';
    var msg = $('loginMsg');
    msg.textContent = REASONS[reason] || '';
    msg.hidden = !msg.textContent;
    msg.classList.toggle('info', reason === 'expired');
    $('loginPass').value = '';
    setTimeout(function () { ($('loginEmail').value ? $('loginPass') : $('loginEmail')).focus(); }, 0);
  }
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = $('loginEmail').value.trim(), pass = $('loginPass').value, msg = $('loginMsg'), btn = $('loginBtn');
    msg.classList.remove('info');
    if (!email || !pass) { msg.textContent = 'Enter your email and password.'; msg.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Signing in…';
    P.api.signIn(email, pass).then(function () {
      $('loginPass').value = '';
      msg.hidden = true;
      startApp();
    }).catch(function (err) {
      msg.textContent = err.message || 'Sign-in failed.';
      msg.hidden = false;
      $('loginPass').select();
    }).then(function () { btn.disabled = false; btn.textContent = 'Sign in'; });
  });
  P.api.onSignOut(function (reason) { showLogin(reason); });

  /* ---------- app ---------- */
  function startApp() {
    var s = P.api.session();
    $('login').hidden = true;
    $('app').hidden = false;
    var who = s.name || s.email;
    $('meAv').textContent = (who || '?').trim().charAt(0).toUpperCase();
    $('meName').textContent = who;
    $('meSub').textContent = s.kind === 'superuser' ? 'Superuser' : 'Portal user';
    $('mhName').textContent = s.email;
    $('mhSub').textContent = s.kind === 'superuser' ? 'PocketBase superuser' : 'Portal account';
    $('pbAdminLink').hidden = s.kind !== 'superuser';
    paintTheme();
    loadDatasets().then(route);
    // Renew the token now: confirms the account still exists (PocketBase treats a dead token as a
    // guest, which would just show empty lists) and extends the session. Sign out when it lapses.
    P.api.refresh().catch(function () {});
    startTimers();
  }
  function startTimers() {
    stopTimers();
    refreshTimer = setInterval(function () {
      if (P.api.expired()) { P.api.signOut('expired'); return; }
      if (document.visibilityState !== 'visible') return;
      // Portal tokens last a day; renew in the last two hours while the page is in use.
      if (P.api.msLeft() < 2 * P.HOUR) P.api.refresh().catch(function () {});
      loadDatasets(true);
    }, 2 * 60e3);
  }
  function stopTimers() { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = null; }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && P.api.session() && P.api.expired()) P.api.signOut('expired');
  });

  function loadDatasets(quiet) {
    if (!quiet) busy(true);
    return P.api.list('sys_datasets', { page: 1, perPage: 500, sort: 'label' }).then(function (r) {
      datasets = (r.items || []).filter(function (d) { return d && typeof d.key === 'string' && d.key; }).map(normalise);
      byKey = {};
      datasets.forEach(function (d) { byKey[d.key] = d; });
      loaded = true;
      renderNav();
    }).catch(function (e) {
      if (e.status === 401) return;
      if (!quiet) {
        loaded = true;
        P.clear($('nav')).appendChild(h('p', { class: 'pt-nav-empty', text: 'Could not load the dataset list.' }));
        P.toast('Could not load datasets: ' + (e.message || 'network error'));
      }
    }).then(function () { busy(false); });
  }
  // JSON fields may arrive as text if a migration typed them as text: parse them once here.
  function normalise(d) {
    ['columns', 'primary_key', 'pages', 'source_ref'].forEach(function (k) {
      if (typeof d[k] === 'string' && /^\s*[\[{"]/.test(d[k])) { try { d[k] = JSON.parse(d[k]); } catch (e) {} }
    });
    return d;
  }
  function busy(on) { $('busy').hidden = !on; }

  /* ---------- sidebar ---------- */
  try { mode = localStorage.getItem('mzo_portal_group') === 'area' ? 'area' : 'source'; } catch (e) {}
  function setMode(m) {
    mode = m;
    try { localStorage.setItem('mzo_portal_group', m); } catch (e) {}
    [].forEach.call($('groupMode').querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.mode === m)); });
    renderNav();
  }
  $('groupMode').addEventListener('click', function (e) { var b = e.target.closest('button[data-mode]'); if (b) setMode(b.dataset.mode); });
  $('dsSearch').addEventListener('input', P.debounce(renderNav, 80));
  $('dsSearch').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var a = $('nav').querySelector('a.pt-ni[data-key]'); if (a) { location.hash = a.getAttribute('href'); $('dsSearch').blur(); } }
    if (e.key === 'Escape') { $('dsSearch').value = ''; renderNav(); }
  });

  function groups(list) {
    var out = {}, order = [];
    list.forEach(function (d) {
      var g = mode === 'area' ? (d.group ? String(d.group) : 'Ungrouped') : P.source(d.source_type).label;
      if (!out[g]) { out[g] = []; order.push(g); }
      out[g].push(d);
    });
    var rank = mode === 'area'
      ? function (g) { var i = P.AREAS.indexOf(g); return i < 0 ? 100 : i; }
      : function (g) { for (var i = 0; i < P.SOURCES.length; i++) if (P.SOURCES[i].label === g) return i; return 100; };
    order.sort(function (a, b) { return rank(a) - rank(b) || a.localeCompare(b); });
    return order.map(function (g) { return { name: g, items: out[g] }; });
  }
  function renderNav() {
    var nav = $('nav');
    P.clear(nav);
    var s = $('dsSearch').value.trim().toLowerCase();
    var here = current && current.key;
    nav.appendChild(h('a', { class: 'pt-ni pt-ni-top', href: '#/', 'aria-current': current && current.name === 'overview' ? 'page' : null }, icon('grid'), h('span', { class: 'lbl', text: 'Overview' })));
    nav.appendChild(h('a', { class: 'pt-ni', href: '#/quality', 'aria-current': current && current.name === 'quality' ? 'page' : null }, icon('check'), h('span', { class: 'lbl', text: 'Data quality' })));
    nav.appendChild(h('a', { class: 'pt-ni', href: '#/server', 'aria-current': current && current.name === 'server' ? 'page' : null }, icon('monitor'), h('span', { class: 'lbl', text: 'Server' })));
    if (!loaded) { nav.appendChild(h('div', { class: 'pt-nav-load' }, h('span', { class: 'ui-skel' }), h('span', { class: 'ui-skel' }), h('span', { class: 'ui-skel' }))); return; }
    var list = datasets.filter(function (d) {
      if (!s) return true;
      return [d.label, d.key, d.collection, d.group, P.source(d.source_type).label].some(function (x) { return x && String(x).toLowerCase().indexOf(s) >= 0; });
    });
    if (!list.length) { nav.appendChild(h('p', { class: 'pt-nav-empty', text: datasets.length ? 'No dataset matches.' : 'No datasets yet.' })); return; }
    groups(list).forEach(function (g) {
      var sec = h('div', { class: 'pt-sec' }, h('span', { text: g.name }), h('small', { text: String(g.items.length) }));
      var box = h('div', { class: 'pt-group', role: 'group', 'aria-label': g.name }, sec);
      g.items.slice().sort(function (a, b) { return String(a.label || a.key).localeCompare(String(b.label || b.key)); }).forEach(function (d) {
        var f = P.freshness(d);
        box.appendChild(h('a', { class: 'pt-ni', href: '#/d/' + encodeURIComponent(d.key), dataset: { key: d.key }, 'aria-current': here === d.key ? 'page' : null, title: (d.label || d.key) + ' · ' + f.label },
          P.dot(f.cls, f.label),
          h('span', { class: 'lbl', text: d.label || d.key }),
          h('small', { text: d.collection ? compact(d.row_count) : '—' })));
      });
      nav.appendChild(box);
    });
  }
  function compact(x) {
    var v = Number(x) || 0;
    if (v >= 1e7) return (v / 1e7).toFixed(1).replace(/\.0$/, '') + 'Cr';
    if (v >= 1e5) return (v / 1e5).toFixed(1).replace(/\.0$/, '') + 'L';
    if (v >= 1e4) return Math.round(v / 1e3) + 'k';
    return P.n(v);
  }

  /* ---------- routes ---------- */
  function parse() {
    var m = /^#\/d\/([^/?#]+)(?:\/(data|schema|source|history|quality))?\/?$/.exec(location.hash || '');
    if (m) { var k; try { k = decodeURIComponent(m[1]); } catch (e) { k = ''; } return { name: 'dataset', key: k, tab: m[2] || 'data' }; }
    var qm = /^#\/quality(?:\/(actions|issues))?\/?$/.exec(location.hash || '');
    if (qm) return { name: 'quality', view: qm[1] || 'datasets' };
    if (/^#\/server\/?$/.test(location.hash || '')) return { name: 'server' };
    return { name: 'overview' };
  }
  function route() {
    if (!P.api.session()) return;
    var r = parse(), view = $('view');
    if (current && current.dispose) current.dispose();
    P.drawer.close(); P.grid.closePop();
    P.clear(view);
    view.className = 'pt-view';
    closeSidebar();
    var page = h('div', { class: 'ui-page pt-page' });
    view.appendChild(page);
    var crumbs = P.clear($('crumbs'));
    if (r.name === 'dataset') {
      var ds = byKey[r.key];
      if (!ds) {
        current = { name: 'missing' };
        crumbs.appendChild(h('a', { href: '#/', class: 'c-g', text: 'Overview' }));
        page.appendChild(h('section', { class: 'ui-panel' }, h('div', { class: 'ui-empty' }, h('p', { text: loaded ? 'There is no dataset with that key.' : 'Loading…' }), loaded ? h('a', { class: 'ui-btn sm', href: '#/', text: 'Back to overview' }) : null)));
        renderNav();
        return;
      }
      document.title = (ds.label || ds.key) + ' · MZO Data';
      crumbs.appendChild(h('span', { class: 'c-g', text: mode === 'area' ? (ds.group || 'Ungrouped') : P.source(ds.source_type).label }));
      crumbs.appendChild(h('span', { class: 'c-s', text: '/' }));
      crumbs.appendChild(h('span', { class: 'c-p', text: ds.label || ds.key }));
      var handle = P.views.dataset(page, ds, r.tab, ctx);
      if (r.tab === 'data') view.classList.add('pt-view-fill');
      current = { name: 'dataset', key: ds.key, tab: r.tab, dispose: handle && handle.dispose };
    } else if (r.name === 'quality') {
      document.title = 'Data quality · MZO Data';
      crumbs.appendChild(h('span', { class: 'c-p', text: 'Data quality' }));
      var qh = P.quality.page(page, ctx, r.view);
      current = { name: 'quality', dispose: qh && qh.dispose };
    } else if (r.name === 'server') {
      document.title = 'Server · MZO Data';
      crumbs.appendChild(h('span', { class: 'c-p', text: 'Server' }));
      var sh = P.server.page(page);
      current = { name: 'server', dispose: sh && sh.dispose };
    } else {
      document.title = 'Overview · MZO Data';
      crumbs.appendChild(h('span', { class: 'c-p', text: 'Overview' }));
      var ov = P.views.overview(page, ctx);
      current = { name: 'overview', dispose: ov && ov.dispose };
    }
    renderNav();
    var a = $('nav').querySelector('[aria-current="page"]');
    if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
  }
  w.addEventListener('hashchange', route);

  /* ---------- bar, menu, theme, phone drawer ---------- */
  function closeSidebar() { document.body.classList.remove('pt-drawer-open'); $('menuBtn').setAttribute('aria-expanded', 'false'); }
  $('menuBtn').addEventListener('click', function () {
    var open = !document.body.classList.contains('pt-drawer-open');
    document.body.classList.toggle('pt-drawer-open', open);
    $('menuBtn').setAttribute('aria-expanded', String(open));
    if (open) { var a = $('nav').querySelector('[aria-current="page"]') || $('nav').querySelector('a'); if (a) a.focus({ preventScroll: true }); }
  });
  $('scrim').addEventListener('click', closeSidebar);
  $('reloadBtn').addEventListener('click', function () {
    var b = $('reloadBtn');
    b.classList.add('spin');
    if (P.quality) P.quality.invalidate();
    loadDatasets().then(route).then(function () { setTimeout(function () { b.classList.remove('spin'); }, 300); });
  });
  function paintTheme() {
    var t = w.MzoTheme ? w.MzoTheme.get() : 'light';
    t = document.documentElement.getAttribute('data-mzo-theme') || t;
    $('themeIco').setAttribute('href', t === 'dark' ? '#pt-sun' : '#pt-moon');
    $('themeBtn').setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    $('themeBtn').title = t === 'dark' ? 'Light theme' : 'Dark theme';
    [].forEach.call(document.querySelectorAll('.pt-theme-seg button'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.theme === t)); });
  }
  function setTheme(t) { if (w.MzoTheme) w.MzoTheme.set(t); paintTheme(); }
  $('themeBtn').addEventListener('click', function () { setTheme(document.documentElement.getAttribute('data-mzo-theme') === 'dark' ? 'light' : 'dark'); });
  document.querySelector('.pt-theme-seg').addEventListener('click', function (e) { var b = e.target.closest('button[data-theme]'); if (b) setTheme(b.dataset.theme); });
  w.addEventListener('mzo-theme-change', paintTheme);

  var menu = $('meMenu'), meBtn = $('meBtn');
  function closeMenu() { menu.hidden = true; meBtn.setAttribute('aria-expanded', 'false'); }
  meBtn.addEventListener('click', function () {
    if (!menu.hidden) { closeMenu(); return; }
    menu.hidden = false;
    var r = meBtn.getBoundingClientRect();
    menu.style.left = Math.max(8, r.left) + 'px';
    menu.style.bottom = Math.max(8, w.innerHeight - r.top + 6) + 'px';
    meBtn.setAttribute('aria-expanded', 'true');
    var first = menu.querySelector('button, a:not([hidden])');
    if (first) first.focus();
  });
  document.addEventListener('mousedown', function (e) { if (!menu.hidden && !menu.contains(e.target) && !meBtn.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !menu.hidden) { closeMenu(); meBtn.focus(); }
    if (e.key === 'Escape' && document.body.classList.contains('pt-drawer-open') && !P.drawer.isOpen()) closeSidebar();
    if (e.key === '/' && !$('app').hidden && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName) && !P.drawer.isOpen()) {
      e.preventDefault();
      if (w.matchMedia('(max-width: 900px)').matches) { document.body.classList.add('pt-drawer-open'); $('menuBtn').setAttribute('aria-expanded', 'true'); }
      $('dsSearch').focus();
    }
  });
  $('logoutBtn').addEventListener('click', function () { closeMenu(); P.api.signOut('signedout'); });

  /* ---------- start ---------- */
  var s = P.api.load();
  if (s && !P.api.expired()) startApp();
  else { if (s) P.api.signOut('expired'); else showLogin(''); }
})(window);
