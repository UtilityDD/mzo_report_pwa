/**
 * Desktop presentation zoom for report pages.
 * Sizes: 100, 125, 150, 175. Remembered in localStorage mzo_present_zoom.
 * Phones stay at 100%. Maps keep their own zoom (see skipPage).
 */
(function () {
  'use strict';
  if (window.__mzoPresent) return;
  window.__mzoPresent = true;

  var KEY = 'mzo_present_zoom';
  var STEPS = [100, 125, 150, 175];

  function skipPage() {
    var p = String((location && location.pathname) || '');
    if (p === '/login.html' || /\/login\.html$/i.test(p)) return true;
    if (p === '/offline.html' || /\/offline\.html$/i.test(p)) return true;
    if (p.indexOf('/power_map/') !== -1) return true;
    if (p.indexOf('/sld/') !== -1) return true;
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

  function framed() {
    try { return window.self !== window.top; } catch (e) { return true; }
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
    applyZoom(pct);
    var root = document.getElementById('mzo-present-zoom');
    if (!root) return;
    root.setAttribute('data-zoom', String(pct));
    var outBtn = root.querySelector('[data-act="out"]');
    var inBtn = root.querySelector('[data-act="in"]');
    var label = root.querySelector('[data-act="label"]');
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
    root.setAttribute('aria-label', 'Presentation zoom');
    root.innerHTML =
      '<style>' +
      '#mzo-present-zoom{position:fixed;right:16px;bottom:16px;z-index:2147482000;display:none;align-items:center;gap:2px;' +
      'padding:4px;border-radius:999px;background:#131b2e;color:#f8fafc;border:1px solid rgba(255,255,255,.18);' +
      'box-shadow:0 8px 24px rgba(0,0,0,.28);font-family:system-ui,-apple-system,sans-serif;font-size:13px;font-weight:600;' +
      'user-select:none}' +
      '@media (min-width:900px){#mzo-present-zoom{display:flex}}' +
      '#mzo-present-zoom[data-zoom="100"]{opacity:.78}' +
      '#mzo-present-zoom:hover,#mzo-present-zoom:focus-within{opacity:1}' +
      '#mzo-present-zoom button{appearance:none;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;' +
      'min-width:36px;height:36px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 8px}' +
      '#mzo-present-zoom button:disabled{opacity:.35;cursor:default}' +
      '#mzo-present-zoom button:not(:disabled):hover{background:rgba(255,255,255,.08)}' +
      '#mzo-present-zoom button:focus-visible{outline:2px solid #93c5fd;outline-offset:1px}' +
      '#mzo-present-zoom svg{display:block}' +
      '@media print{#mzo-present-zoom{display:none !important}}' +
      '</style>' +
      '<button type="button" data-act="out" aria-label="Smaller">−</button>' +
      '<button type="button" data-act="reset" aria-label="Reset zoom">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
      '<circle cx="10.5" cy="10.5" r="6.25" fill="none" stroke="currentColor" stroke-width="2"></circle>' +
      '<path d="M15.2 15.2 L20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>' +
      '</svg>' +
      '<span data-act="label">100%</span></button>' +
      '<button type="button" data-act="in" aria-label="Larger">+</button>';

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
    if (framed()) {
      applyZoom(readPct());
      window.addEventListener('storage', function (ev) {
        if (ev.key === KEY) sync();
      });
      return;
    }
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
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
