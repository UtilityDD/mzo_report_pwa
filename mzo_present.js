/**
 * Desktop presentation toolbar & zoom for report pages.
 * - PPT theme toggle (colourful executive slide-deck mode, shortcut: P)
 * - Zoom steps: 100, 125, 150, 175 (remembered in localStorage mzo_present_zoom, shortcuts: + / - / 0)
 * Phones stay at 100%. Maps keep their own zoom (see skipPage).
 */
(function () {
  'use strict';
  if (window.__mzoPresent) return;
  window.__mzoPresent = true;

  var KEY = 'mzo_present_zoom';
  var STEPS = [100, 125, 150, 175];

  try {
    localStorage.removeItem('mzo_present_focus');
    document.documentElement.removeAttribute('data-mzo-slide-focus');
  } catch (e) {}

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

  // PPT is desktop/projector only (mzo_theme.js): on a phone-sized screen the bar would show just a PPT
  // button that does nothing, so hide it. In the shell the screen is the shell's width, not this frame's.
  function pptAllowed() {
    if (window.MzoTheme && typeof window.MzoTheme.pptAllowed === 'function') return window.MzoTheme.pptAllowed();
    var w = window;
    try { if (window.top !== window && window.top.__MZO_SHELL__) w = window.top; } catch (e) {}
    try { return !w.matchMedia('(max-width: 900px)').matches; } catch (e) { return true; }
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

  function isPptTheme() {
    var attr = document.documentElement.getAttribute('data-mzo-theme');
    if (attr) return attr === 'ppt';
    try { return localStorage.getItem('mzo_theme') === 'ppt' || localStorage.getItem('theme') === 'ppt'; } catch (e) { return false; }
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
    var ppt = isPptTheme();
    applyZoom(pct);
    var root = document.getElementById('mzo-present-zoom');
    if (!root) return;
    root.style.display = pptAllowed() ? '' : 'none';
    root.setAttribute('data-zoom', String(pct));
    root.setAttribute('data-ppt', ppt ? '1' : '0');
    var pptBtn = root.querySelector('[data-act="ppt"]');
    var zoomBtn = root.querySelector('[data-act="zoom"]');
    var label = root.querySelector('[data-act="label"]');
    if (pptBtn) pptBtn.setAttribute('aria-pressed', String(ppt));
    if (label) label.textContent = pct + '%';
    if (zoomBtn) {
      zoomBtn.setAttribute('aria-label', 'Zoom: ' + pct + '% (click to cycle, shortcut: + / - / 0)');
      zoomBtn.setAttribute('aria-pressed', pct > 100 ? 'true' : 'false');
    }
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

  function cycleZoom() {
    var pct = readPct();
    var idx = STEPS.indexOf(pct);
    var nextIdx = (idx + 1) % STEPS.length;
    setPct(STEPS[nextIdx]);
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
      '#mzo-present-zoom{position:fixed;right:14px;bottom:14px;z-index:2147482000;display:flex;align-items:center;gap:2px;' +
      'padding:2px 3px;border-radius:8px;background:var(--mzo-surface,#ffffff);color:var(--mzo-text,#0f172a);' +
      'border:1px solid var(--mzo-border-strong,#cbd5e1);box-shadow:0 4px 14px rgba(15,23,42,.12);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:11px;font-weight:600;' +
      'font-variant-numeric:tabular-nums;user-select:none;opacity:.72;transition:opacity .15s,box-shadow .15s,transform .15s}' +
      '@media (max-width:899px){' +
      '#mzo-present-zoom{right:10px;bottom:12px;padding:2px;border-radius:99px}' +
      '#mzo-present-zoom .mzo-pz-sep,#mzo-present-zoom [data-act="zoom"]{display:none !important}' +
      '#mzo-present-zoom button[data-act="ppt"]{height:25px;padding:0 8px;border-radius:99px;font-size:11px}' +
      '}' +
      '#mzo-present-zoom:hover,#mzo-present-zoom:focus-within{opacity:1;box-shadow:0 6px 18px rgba(15,23,42,.18);transform:translateY(-1px)}' +
      '#mzo-present-zoom button{appearance:none;border:0;background:transparent;color:var(--mzo-text,#0f172a);font:inherit;cursor:pointer;' +
      'height:24px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:0 7px;transition:background .12s,color .12s}' +
      '#mzo-present-zoom button:not(:disabled):not([aria-pressed="true"]):hover{background:var(--mzo-hover,#f1f5f9) !important;color:var(--mzo-text,#0f172a) !important}' +
      '#mzo-present-zoom button[data-act="ppt"]:not([aria-pressed="true"]):hover{background:#dbeafe !important;color:#1d4ed8 !important}' +
      'html[data-mzo-theme="dark"] #mzo-present-zoom button[data-act="ppt"]:not([aria-pressed="true"]):hover{background:#1e3a8a !important;color:#f8fafc !important}' +
      '#mzo-present-zoom button[aria-pressed="true"],#mzo-present-zoom button[aria-pressed="true"]:hover{background:linear-gradient(135deg,#2563eb 0%,#0d9488 100%) !important;color:#ffffff !important;box-shadow:0 2px 6px rgba(37,99,235,.32) !important}' +
      '#mzo-present-zoom button[aria-pressed="true"] span,#mzo-present-zoom button[aria-pressed="true"] svg{color:#ffffff !important}' +
      '#mzo-present-zoom button:focus-visible{outline:2px solid var(--mzo-accent,#0f766e);outline-offset:1px}' +
      '#mzo-present-zoom .mzo-pz-sep{width:1px;height:14px;background:var(--mzo-border-strong,#cbd5e1);margin:0 1px;flex:none}' +
      '#mzo-present-zoom svg{display:block;flex:none}' +
      'html[data-mzo-theme="ppt"] #mzo-present-zoom button[aria-pressed="true"],html[data-mzo-theme="ppt"] #mzo-present-zoom button[aria-pressed="true"]:hover{background:#1d4ed8 !important;box-shadow:none !important}' +
      'html.mzo-in-shell[data-mzo-theme="ppt"] #mzo-present-zoom [data-act="ppt"]{display:none !important}' +
      '@media (max-width:899px){html.mzo-in-shell[data-mzo-theme="ppt"] #mzo-present-zoom{display:none !important}}' +
      '@media print{#mzo-present-zoom{display:none !important}}' +
      '</style>' +
      '<button type="button" data-act="ppt" aria-pressed="false" title="Presentation theme (PPT slide mode · shortcut P)">' +
      '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">' +
      '<rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"></rect>' +
      '<path d="M8 20h8M12 16v4M7.5 11.5l2.5-2.5 2.5 2 3.5-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>' +
      '</svg>' +
      '<span>PPT</span></button>' +
      '<span class="mzo-pz-sep" aria-hidden="true"></span>' +
      '<button type="button" data-act="zoom" aria-label="Zoom level" title="Zoom: click to cycle (100% · 125% · 150% · 175%), shortcut: + / - / 0">' +
      '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">' +
      '<circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="2"></circle>' +
      '<path d="M14.5 14.5 L19.5 19.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>' +
      '<path d="M7 10h6M10 7v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>' +
      '</svg>' +
      '<span data-act="label">100%</span></button>';

    root.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (!btn || !root.contains(btn)) return;
      var act = btn.getAttribute('data-act');
      if (act === 'zoom') cycleZoom();
      else if (act === 'ppt') togglePptTheme();
    });

    (document.body || document.documentElement).appendChild(root);
    sync();
  }

  function start() {
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
    window.addEventListener('storage', function (ev) {
      if (!ev.key || ev.key === KEY || ev.key === 'mzo_theme' || ev.key === 'theme') sync();
    });
    window.addEventListener('mzo-theme-change', sync);
  }

  applyZoom(readPct());
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
  // Outside the shell, crossing the 900px PPT line shows/hides the bar (the shell re-applies the theme
  // to its frames, which fires mzo-theme-change).
  var pptMq = window.matchMedia('(max-width: 900px)');
  if (pptMq.addEventListener) pptMq.addEventListener('change', sync);
  else if (pptMq.addListener) pptMq.addListener(sync);

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
