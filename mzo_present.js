/**
 * Desktop presentation toolbar & zoom for report pages.
 * - PPT theme toggle (colourful executive slide-deck mode, shortcut: P)
 * - Slide focus toggle (expands report to full slide width, shortcut: F)
 * - Zoom steps: 100, 125, 150, 175 (remembered in localStorage mzo_present_zoom, shortcuts: + / - / 0)
 * Phones stay at 100%. Maps keep their own zoom (see skipPage).
 */
(function () {
  'use strict';
  if (window.__mzoPresent) return;
  window.__mzoPresent = true;

  var KEY = 'mzo_present_zoom';
  var FOCUS_KEY = 'mzo_present_focus';
  var STEPS = [100, 125, 150, 175];

  function skipPage() {
    var p = String((location && location.pathname) || '');
    if (p === '/login.html' || /\/login\.html$/i.test(p)) return true;
    if (p === '/app.html') return true; // workstation shell: pages inside it zoom themselves
    if (p === '/offline.html' || /\/offline\.html$/i.test(p)) return true;
    if (p.indexOf('/power_map/') !== -1) return true;
    if (/\/accident\/map\.html$/i.test(p)) return true;
    return false;
  }

  if (skipPage()) {
    clearMarks();
    return;
  }

  function desktop() {
    return window.matchMedia('(min-width: 900px)').matches;
  }

  function readPct() {
    try {
      var n = parseInt(localStorage.getItem(KEY), 10);
      return STEPS.indexOf(n) === -1 ? 100 : n;
    } catch (e) {
      return 100;
    }
  }

  function writePct(pct) {
    try {
      if (pct === 100) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, String(pct));
    } catch (e) {}
  }

  function readFocus() {
    try { return localStorage.getItem(FOCUS_KEY) === '1'; } catch (e) { return false; }
  }

  function writeFocus(on) {
    try {
      if (on) localStorage.setItem(FOCUS_KEY, '1');
      else localStorage.removeItem(FOCUS_KEY);
    } catch (e) {}
  }

  function isPptTheme() {
    var attr = document.documentElement.getAttribute('data-mzo-theme');
    if (attr) return attr === 'ppt';
    try { return localStorage.getItem('mzo_theme') === 'ppt' || localStorage.getItem('theme') === 'ppt'; } catch (e) { return false; }
  }

  function togglePptTheme() {
    if (window.MzoTheme && typeof window.MzoTheme.togglePpt === 'function') {
      window.MzoTheme.togglePpt();
    } else {
      var next = isPptTheme() ? 'light' : 'ppt';
      document.documentElement.setAttribute('data-mzo-theme', next);
      try {
        localStorage.setItem('theme', next);
        localStorage.setItem('mzo_theme', next);
        localStorage.setItem('mzo_theme_pref', next);
      } catch (e) {}
    }
    try {
      if (window.top && window.top !== window && window.top.document) {
        var cur = document.documentElement.getAttribute('data-mzo-theme') || 'light';
        window.top.dispatchEvent(new StorageEvent('storage', { key: 'mzo_theme', newValue: cur }));
      }
    } catch (e) {}
    sync();
  }

  function applyFocus(on) {
    if (desktop() && on) {
      document.documentElement.setAttribute('data-mzo-slide-focus', '1');
    } else {
      document.documentElement.removeAttribute('data-mzo-slide-focus');
    }
  }

  function toggleFocus() {
    var next = !readFocus();
    writeFocus(next);
    applyFocus(next);
    sync();
  }

  function clearMarks() {
    var marked = document.querySelectorAll('[data-mzo-zoom]');
    for (var i = 0; i < marked.length; i++) {
      marked[i].style.zoom = '';
      marked[i].removeAttribute('data-mzo-zoom');
    }
    try { document.documentElement.style.zoom = ''; } catch (e) {}
  }

  function findShell() {
    if (!document.body) return null;
    var vh = window.innerHeight || 0;
    var vw = window.innerWidth || 0;
    if (!vh || !vw) return null;
    var nodes = document.body.querySelectorAll('*');
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.id === 'mzo-present-zoom') continue;
      // Side panels and dialogs (NSC filters) are not the page scroller.
      if (el.closest && el.closest('.offcanvas, .modal, .dropdown-menu, [role="dialog"]')) continue;
      var ch = el.clientHeight;
      var cw = el.clientWidth;
      if (ch < vh - 20 || ch > vh + 12) continue;
      if (cw < vw * 0.75) continue;
      var oy = window.getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      var score = el.scrollHeight + cw;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  function shellHasReportFrame(shell) {
    if (!shell || !shell.querySelector) return false;
    var frame = shell.querySelector('iframe');
    if (!frame) return false;
    return frame.getBoundingClientRect().height > (window.innerHeight || 0) * 0.45;
  }

  var appliedKey = '';

  function applyZoom(pct) {
    var on = desktop() && pct > 100 && !!document.body;
    var z = on ? String(pct / 100) : '';
    var shell = z ? findShell() : null;
    var mode = !z ? 'off' : (shell && shellHasReportFrame(shell)) ? 'frame' : shell ? ('shell:' + (shell.id || '')) : 'html';
    var key = z + '|' + mode;
    if (key === appliedKey) return;
    appliedKey = key;
    clearMarks();
    if (!z) return;
    // A full-height report frame zooms its own document. Scaling the shell
    // as well adds a second vertical scrollbar.
    if (mode === 'frame') return;
    if (shell) {
      var kids = shell.children;
      for (var i = 0; i < kids.length; i++) {
        var kid = kids[i];
        if (!kid || kid.id === 'mzo-present-zoom' || kid.tagName === 'SCRIPT') continue;
        kid.style.zoom = z;
        kid.setAttribute('data-mzo-zoom', '1');
      }
      return;
    }
    document.documentElement.style.zoom = z;
  }

  function typingTarget(el) {
    if (!el || !el.closest) return false;
    return !!el.closest('input, textarea, select, [contenteditable="true"]');
  }

  function sync() {
    var pct = readPct();
    var foc = readFocus();
    var ppt = isPptTheme();
    applyZoom(pct);
    applyFocus(foc);
    var root = document.getElementById('mzo-present-zoom');
    if (!root) return;
    root.setAttribute('data-zoom', String(pct));
    root.setAttribute('data-ppt', ppt ? '1' : '0');
    root.setAttribute('data-focus', foc ? '1' : '0');
    var pptBtn = root.querySelector('[data-act="ppt"]');
    var focBtn = root.querySelector('[data-act="focus"]');
    var outBtn = root.querySelector('[data-act="out"]');
    var inBtn = root.querySelector('[data-act="in"]');
    var label = root.querySelector('[data-act="label"]');
    if (pptBtn) pptBtn.setAttribute('aria-pressed', String(ppt));
    if (focBtn) focBtn.setAttribute('aria-pressed', String(foc));
    if (outBtn) outBtn.disabled = pct <= STEPS[0];
    if (inBtn) inBtn.disabled = pct >= STEPS[STEPS.length - 1];
    if (label) label.textContent = pct + '%';
    var resetBtn = root.querySelector('[data-act="reset"]');
    if (resetBtn) resetBtn.setAttribute('aria-label', 'Reset zoom, now ' + pct + ' percent');
  }

  function setPct(pct) {
    if (STEPS.indexOf(pct) === -1) pct = 100;
    writePct(pct);
    sync();
  }

  function step(dir) {
    var pct = readPct();
    var i = STEPS.indexOf(pct);
    if (i < 0) i = 0;
    i = Math.max(0, Math.min(STEPS.length - 1, i + dir));
    setPct(STEPS[i]);
  }

  function mount() {
    if (document.getElementById('mzo-present-zoom')) {
      sync();
      return;
    }
    var root = document.createElement('div');
    root.id = 'mzo-present-zoom';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Presentation controls');
    root.innerHTML =
      '<style>' +
      '#mzo-present-zoom{position:fixed;right:16px;bottom:16px;z-index:2147482000;display:flex;align-items:center;gap:3px;' +
      'padding:4px 5px;border-radius:11px;background:var(--mzo-surface,#ffffff);color:var(--mzo-text,#0f172a);' +
      'border:1px solid var(--mzo-border-strong,#cbd5e1);box-shadow:0 10px 28px -4px rgba(15,23,42,.22),0 2px 6px rgba(15,23,42,.08);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12px;font-weight:600;' +
      'font-variant-numeric:tabular-nums;user-select:none;transition:opacity .15s,box-shadow .15s,transform .15s}' +
      '@media (max-width:899px){' +
      '#mzo-present-zoom{right:12px;bottom:14px;padding:3px;border-radius:99px}' +
      '#mzo-present-zoom [data-act="focus"],#mzo-present-zoom .mzo-pz-sep,#mzo-present-zoom [data-act="out"],#mzo-present-zoom [data-act="reset"],#mzo-present-zoom [data-act="in"]{display:none !important}' +
      '#mzo-present-zoom button[data-act="ppt"]{height:30px;padding:0 10px;border-radius:99px;font-size:11.5px}' +
      '}' +
      '#mzo-present-zoom[data-zoom="100"][data-ppt="0"][data-focus="0"]{opacity:.85}' +
      '#mzo-present-zoom:hover,#mzo-present-zoom:focus-within{opacity:1;transform:translateY(-1px)}' +
      '#mzo-present-zoom button{appearance:none;border:0;background:transparent;color:var(--mzo-text,#0f172a);font:inherit;cursor:pointer;' +
      'min-width:30px;height:28px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:0 9px;transition:background .12s,color .12s,box-shadow .12s,transform .12s}' +
      '#mzo-present-zoom button:disabled{opacity:.35;cursor:default}' +
      '#mzo-present-zoom button:not(:disabled):not([aria-pressed="true"]):hover{background:var(--mzo-hover,#e2e8f0) !important;color:var(--mzo-text,#0f172a) !important}' +
      '#mzo-present-zoom button[data-act="ppt"]:not([aria-pressed="true"]):hover,#mzo-present-zoom button[data-act="focus"]:not([aria-pressed="true"]):hover{background:#dbeafe !important;color:#1d4ed8 !important}' +
      'html[data-mzo-theme="dark"] #mzo-present-zoom button[data-act="ppt"]:not([aria-pressed="true"]):hover,html[data-mzo-theme="dark"] #mzo-present-zoom button[data-act="focus"]:not([aria-pressed="true"]):hover{background:#1e3a8a !important;color:#f8fafc !important}' +
      '#mzo-present-zoom button[aria-pressed="true"],#mzo-present-zoom button[aria-pressed="true"]:hover{background:linear-gradient(135deg,#2563eb 0%,#0d9488 100%) !important;color:#ffffff !important;box-shadow:0 3px 10px rgba(37,99,235,.38) !important}' +
      '#mzo-present-zoom button[aria-pressed="true"]:hover{background:linear-gradient(135deg,#1d4ed8 0%,#0f766e 100%) !important;color:#ffffff !important}' +
      '#mzo-present-zoom button[aria-pressed="true"] span,#mzo-present-zoom button[aria-pressed="true"] svg{color:#ffffff !important}' +
      '#mzo-present-zoom button:focus-visible{outline:2px solid var(--mzo-accent,#0f766e);outline-offset:1px}' +
      '#mzo-present-zoom .mzo-pz-sep{width:1px;height:16px;background:var(--mzo-border-strong,#cbd5e1);margin:0 2px;flex:none}' +
      '#mzo-present-zoom svg{display:block;flex:none}' +
      // PPT theme: selected buttons use the theme's solid primary, not the old blue-teal gradient.
      'html[data-mzo-theme="ppt"] #mzo-present-zoom button[aria-pressed="true"],html[data-mzo-theme="ppt"] #mzo-present-zoom button[aria-pressed="true"]:hover{background:#1d4ed8 !important;box-shadow:none !important}' +
      // In PPT inside the shell, the shell's top bar already shows the pressed PPT button: drop this copy
      // (and the whole bar on narrow frames, where PPT is all it shows).
      'html.mzo-in-shell[data-mzo-theme="ppt"] #mzo-present-zoom [data-act="ppt"]{display:none !important}' +
      '@media (max-width:899px){html.mzo-in-shell[data-mzo-theme="ppt"] #mzo-present-zoom{display:none !important}}' +
      '@media print{#mzo-present-zoom{display:none !important}}' +
      '</style>' +
      '<button type="button" data-act="ppt" aria-pressed="false" title="Presentation theme (PPT slide mode · shortcut P)">' +
      '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
      '<rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"></rect>' +
      '<path d="M8 20h8M12 16v4M7.5 11.5l2.5-2.5 2.5 2 3.5-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>' +
      '</svg>' +
      '<span>PPT</span></button>' +
      '<button type="button" data-act="focus" aria-pressed="false" title="Slide focus (full-width slide · shortcut F)">' +
      '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
      '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>' +
      '</svg>' +
      '<span>Slide</span></button>' +
      '<span class="mzo-pz-sep" aria-hidden="true"></span>' +
      '<button type="button" data-act="out" aria-label="Smaller" title="Zoom out (−)">−</button>' +
      '<button type="button" data-act="reset" aria-label="Reset zoom" title="Reset zoom (0)">' +
      '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
      '<circle cx="10.5" cy="10.5" r="6.25" fill="none" stroke="currentColor" stroke-width="2"></circle>' +
      '<path d="M15.2 15.2 L20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>' +
      '</svg>' +
      '<span data-act="label">100%</span></button>' +
      '<button type="button" data-act="in" aria-label="Larger" title="Zoom in (+)">+</button>';

    root.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (!btn || !root.contains(btn)) return;
      var act = btn.getAttribute('data-act');
      if (act === 'in') step(1);
      else if (act === 'out') step(-1);
      else if (act === 'reset') setPct(100);
      else if (act === 'ppt') togglePptTheme();
      else if (act === 'focus') toggleFocus();
    });

    (document.body || document.documentElement).appendChild(root);
    sync();
  }

  function start() {
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
    window.addEventListener('storage', function (ev) {
      if (!ev.key || ev.key === KEY || ev.key === FOCUS_KEY || ev.key === 'mzo_theme' || ev.key === 'theme') sync();
    });
    window.addEventListener('mzo-theme-change', sync);
  }

  applyZoom(readPct());
  applyFocus(readFocus());
  start();

  document.addEventListener('keydown', function (ev) {
    if (!desktop()) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;
    if (typingTarget(ev.target)) return;
    var key = ev.key;
    if (key === '+' || key === '=' || ev.code === 'NumpadAdd') {
      ev.preventDefault();
      step(1);
    } else if (key === '-' || key === '_' || ev.code === 'NumpadSubtract') {
      ev.preventDefault();
      step(-1);
    } else if (key === '0' || ev.code === 'Numpad0') {
      ev.preventDefault();
      setPct(100);
    } else if (key === 'p' || key === 'P') {
      ev.preventDefault();
      togglePptTheme();
    } else if (key === 'f' || key === 'F') {
      ev.preventDefault();
      toggleFocus();
    }
  });

  window.addEventListener('beforeprint', function () {
    appliedKey = '';
    clearMarks();
  });
  window.addEventListener('afterprint', sync);

  var mq = window.matchMedia('(min-width: 900px)');
  if (mq.addEventListener) mq.addEventListener('change', sync);
  else if (mq.addListener) mq.addListener(sync);

  var shellTimer = 0;
  function scheduleSync() {
    if (shellTimer) return;
    shellTimer = window.setTimeout(function () {
      shellTimer = 0;
      sync();
    }, 60);
  }
  window.addEventListener('load', scheduleSync);
  var pageRoot = document.getElementById('pageContainer') || document.getElementById('mainApp');
  if (pageRoot && window.MutationObserver) {
    var shellObs = new MutationObserver(scheduleSync);
    shellObs.observe(pageRoot, { attributes: true, attributeFilter: ['class'], subtree: true });
  }
})();
