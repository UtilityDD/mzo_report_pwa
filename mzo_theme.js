/* MZO unified theme controller.
 * Single source of truth for dark/light/ppt across the workstation shell and every page.
 * Storage keys kept in sync: theme, mzo_theme, collectionDashboardTheme ('light' | 'dark' | 'ppt').
 * The shell may also store mzo_theme_pref = 'system' | 'light' | 'dark' | 'ppt'; it then writes the
 * resolved value to the keys above.
 * PPT is desktop/projector only: on a ≤900px screen a stored ppt pref paints as light (pref is kept).
 * Inside the shell the test uses the shell's width, not the frame's (a 1024px desktop has a ~770px frame).
 */
(function () {
  'use strict';
  var KEYS = ['theme', 'mzo_theme', 'collectionDashboardTheme'];
  var PREV_KEY = 'mzo_theme_prev';
  var root = document.documentElement;

  // Running inside the workstation shell (app.html)?
  var inShell = false;
  try { inShell = window.self !== window.top && !!window.top.__MZO_SHELL__; } catch (e) {}
  if (inShell) root.classList.add('mzo-in-shell');

  var phoneMq = null;
  try { phoneMq = (inShell ? window.top : window).matchMedia('(max-width: 900px)'); } catch (e) {}

  function isPhone() {
    try { return !!(phoneMq && phoneMq.matches); } catch (e) { return false; }
  }

  // Nothing saved yet means 'system' (as in the shell and on login), not dark.
  function norm(v) {
    if (v === 'system' || v == null || v === '') {
      try {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
        return 'light';
      } catch (e) {
        return 'light';
      }
    }
    return (v === 'light' || v === 'ppt') ? v : 'dark';
  }

  /** Theme actually painted: ppt → light on phones. */
  function paintTheme(theme) {
    theme = norm(theme);
    return (theme === 'ppt' && isPhone()) ? 'light' : theme;
  }

  function read() {
    var v = null;
    try { v = localStorage.getItem('mzo_theme_pref') || localStorage.getItem('theme') || localStorage.getItem('mzo_theme') || localStorage.getItem('collectionDashboardTheme'); } catch (e) {}
    return norm(v);
  }

  function paint(theme) {
    theme = paintTheme(theme);
    var isLightSurface = theme === 'light' || theme === 'ppt';
    var isPpt = theme === 'ppt';
    root.setAttribute('data-mzo-theme', theme);
    root.setAttribute('data-bs-theme', isLightSurface ? 'light' : 'dark');
    root.classList.toggle('light-theme', isLightSurface);
    root.classList.toggle('dark-theme', !isLightSurface);
    root.classList.toggle('light', isLightSurface);
    root.classList.toggle('dark', !isLightSurface);
    root.classList.toggle('ppt-theme', isPpt);
    var b = document.body;
    if (b) {
      b.classList.toggle('light-theme', isLightSurface);
      b.classList.toggle('dark-theme', !isLightSurface);
      b.classList.toggle('light', isLightSurface);
      b.classList.toggle('dark', !isLightSurface);
      b.classList.toggle('ppt-theme', isPpt);
      if (inShell) b.classList.add('in-workstation');
    }
    try {
      var meta = document.querySelector('meta[name="theme-color"]');
      var tc = theme === 'dark' ? '#09090a' : (theme === 'ppt' ? '#e8edf6' : '#f1f1f0');
      if (!meta && !inShell && document.head) {
        meta = document.createElement('meta');
        meta.name = 'theme-color';
        document.head.appendChild(meta);
      }
      if (meta) meta.setAttribute('content', tc);
      if (!inShell && document.head && !document.querySelector('script[src*="mzo_theme.js"][src*="/kit/"]')) {
        var fav = document.querySelector('link[rel="icon"]');
        var wantHref = theme === 'dark' ? '/icons/icon-192-dark-v5.png?v=308' : '/icons/icon-192-v5.png?v=308';
        if (!fav) {
          fav = document.createElement('link');
          fav.rel = 'icon';
          fav.type = 'image/png';
          fav.href = wantHref;
          document.head.appendChild(fav);
        } else if (fav.getAttribute('href') && fav.getAttribute('href').indexOf('/icons/icon-192') !== -1) {
          fav.setAttribute('href', wantHref);
        }
      }
    } catch (e) {}
  }

  function apply(theme) {
    var stored = norm(theme);
    var painted = paintTheme(stored);
    paint(stored);
    chartDefaults();
    try { window.dispatchEvent(new CustomEvent('mzo-theme-change', { detail: { theme: painted } })); } catch (e) {}
    return painted;
  }

  function set(theme) {
    theme = norm(theme);
    if (theme === 'ppt' && isPhone()) theme = 'light';
    try {
      var cur = read();
      if (cur !== 'ppt' && theme === 'ppt') localStorage.setItem(PREV_KEY, cur);
      KEYS.forEach(function (k) { localStorage.setItem(k, theme); });
      localStorage.setItem('mzo_theme_pref', theme);
    } catch (e) {}
    return apply(theme);
  }

  function togglePpt() {
    if (isPhone()) return apply(read());
    var cur = read();
    if (cur === 'ppt') {
      var prev = 'light';
      try { prev = localStorage.getItem(PREV_KEY) || 'light'; } catch (e) {}
      return set(prev === 'dark' ? 'dark' : 'light');
    }
    return set('ppt');
  }

  // Charts: same typeface as the page. Colours only replace Chart.js's own defaults.
  function chartDefaults() {
    var C = window.Chart;
    if (!C || !C.defaults) return;
    try {
      var cs = getComputedStyle(root);
      var font = cs.getPropertyValue('--mzo-font').trim();
      var muted = cs.getPropertyValue('--mzo-muted').trim();
      var line = cs.getPropertyValue('--mzo-border').trim();
      if (C.defaults.font) {
        if (font) C.defaults.font.family = font;
        if (muted && (C.defaults.color === '#666' || C.defaults.__mzo)) C.defaults.color = muted;
        if (line && (C.defaults.borderColor === 'rgba(0,0,0,0.1)' || C.defaults.__mzo)) C.defaults.borderColor = line;
        C.defaults.__mzo = true;
      } else if (C.defaults.global && font) {
        C.defaults.global.defaultFontFamily = font;
      }
    } catch (e) {}
  }

  window.MzoTheme = {
    get: read,
    set: set,
    apply: apply,
    inShell: inShell,
    pptAllowed: function () { return !isPhone(); },
    toggle: function () {
      var cur = root.getAttribute('data-mzo-theme') || read();
      return set(cur === 'light' ? 'dark' : 'light');
    },
    togglePpt: togglePpt
  };

  // Paint as early as possible (html element exists), then again once body exists.
  paint(read());
  document.addEventListener('DOMContentLoaded', function () { paint(read()); chartDefaults(); });
  window.addEventListener('load', chartDefaults);

  // Phone ↔ desktop: re-paint so a stored ppt pref becomes light on phones and PPT again on desktop.
  // In the shell, app.html re-applies the theme to its frames itself (and a listener on the shell's
  // media query would outlive this frame).
  if (phoneMq && !inShell) {
    var onPhoneChange = function () { apply(read()); };
    if (phoneMq.addEventListener) phoneMq.addEventListener('change', onPhoneChange);
    else if (phoneMq.addListener) phoneMq.addListener(onPhoneChange);
  }

  // Follow changes made by the shell or by another page's own toggle.
  window.addEventListener('storage', function (e) {
    if (KEYS.indexOf(e.key) !== -1) apply(norm(e.newValue));
  });
})();
