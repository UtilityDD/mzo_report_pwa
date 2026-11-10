/**
 * Desktop zoom control for report pages.
 * Compact horizontal zoom: − / % / + (75–175, localStorage mzo_present_zoom; shortcuts + / - / 0).
 * PPT stays in the top theme control (shortcut P still works via MzoTheme when present).
 * Phones stay at 100%. Maps keep their own zoom (see skipPage).
 */
(function () {
  'use strict';
  if (window.__mzoPresent) return;
  window.__mzoPresent = true;

  var KEY = 'mzo_present_zoom';
  var MIN_ZOOM = 75;
  var MAX_ZOOM = 175;

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
      return (isNaN(n) || n < MIN_ZOOM || n > MAX_ZOOM) ? 100 : n;
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
    var on = desktop() && pct !== 100 && !!document.body;
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
    applyZoom(pct);
    var root = document.getElementById('mzo-present-zoom');
    if (!root) return;
    root.style.display = pptAllowed() ? '' : 'none';
    root.setAttribute('data-zoom', String(pct));
    var inBtn = root.querySelector('[data-act="in"]');
    var outBtn = root.querySelector('[data-act="out"]');
    var resetBtn = root.querySelector('[data-act="reset"]');
    if (resetBtn) {
      resetBtn.textContent = pct + '%';
      resetBtn.setAttribute('title', 'Reset zoom to 100% (currently ' + pct + '%, shortcut: 0)');
      resetBtn.setAttribute('aria-pressed', pct !== 100 ? 'true' : 'false');
    }
    if (inBtn) inBtn.disabled = pct >= MAX_ZOOM;
    if (outBtn) outBtn.disabled = pct <= MIN_ZOOM;
  }

  function setPct(pct) {
    pct = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(pct / 5) * 5));
    writePct(pct);
    sync();
  }

  function step(dir) {
    var pct = readPct();
    setPct(pct + dir * 10);
  }

  function mount() {
    var existing = document.getElementById('mzo-present-zoom');
    // Drop any cached dock that still carries a PPT control (old SW copies).
    if (existing) {
      if (existing.querySelector('[data-act="ppt"]')) existing.remove();
      else { sync(); return; }
    }
    var root = document.createElement('div');
    root.id = 'mzo-present-zoom';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Zoom');
    root.innerHTML =
      '<style>' +
      '#mzo-present-zoom{position:fixed;right:16px;bottom:16px;z-index:2147482000;display:flex;flex-direction:row;align-items:center;gap:2px;' +
      'padding:4px;border-radius:999px;background:var(--mzo-surface,#ffffff);color:var(--mzo-text,#0f172a);' +
      'border:1px solid var(--mzo-border,#e2e8f0);box-shadow:0 2px 10px rgba(15,23,42,.10);' +
      'font-family:var(--mzo-font,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif);user-select:none;' +
      'opacity:.92;transition:opacity .12s,box-shadow .12s}' +
      '#mzo-present-zoom:hover,#mzo-present-zoom:focus-within{opacity:1;box-shadow:0 4px 14px rgba(15,23,42,.14)}' +
      '#mzo-present-zoom button{appearance:none;border:0;background:transparent;color:var(--mzo-text,#0f172a);font:inherit;cursor:pointer;' +
      'border-radius:999px;display:inline-flex;align-items:center;justify-content:center;padding:0;transition:background .12s,color .12s;height:30px}' +
      '#mzo-present-zoom button[data-act="in"],#mzo-present-zoom button[data-act="out"]{width:30px}' +
      '#mzo-present-zoom button[data-act="reset"]{min-width:44px;padding:0 8px;font-size:12px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--mzo-muted,#64748b)}' +
      '#mzo-present-zoom button[data-act="reset"][aria-pressed="true"]{color:var(--mzo-text,#0f172a);background:var(--mzo-hover,#f1f5f9)}' +
      '#mzo-present-zoom button:not(:disabled):hover{background:var(--mzo-hover,#f1f5f9)}' +
      '#mzo-present-zoom button:disabled{opacity:.35;cursor:not-allowed}' +
      '#mzo-present-zoom button:focus-visible{outline:2px solid var(--mzo-accent,#0f766e);outline-offset:1px}' +
      '@media (max-width:899px){#mzo-present-zoom{display:none !important}}' +
      '@media print{#mzo-present-zoom{display:none !important}}' +
      '</style>' +
      '<button type="button" data-act="out" aria-label="Zoom out" title="Zoom out (−)">−</button>' +
      '<button type="button" data-act="reset" title="Reset zoom to 100% (shortcut 0)">100%</button>' +
      '<button type="button" data-act="in" aria-label="Zoom in" title="Zoom in (+)">+</button>';

    root.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (!btn || !root.contains(btn)) return;
      var act = btn.getAttribute('data-act');
      if (act === 'in') step(1);
      else if (act === 'out') step(-1);
      else if (act === 'reset') setPct(100);
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
      if (window.MzoTheme && typeof window.MzoTheme.togglePpt === 'function') {
        ev.preventDefault();
        window.MzoTheme.togglePpt();
      }
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
