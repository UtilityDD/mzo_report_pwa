/* MZO unified theme controller.
 * Single source of truth for dark/light/ppt across the workstation shell and every page.
 * Storage keys kept in sync: theme, mzo_theme, collectionDashboardTheme ('light' | 'dark' | 'ppt').
 * The shell may also store mzo_theme_pref = 'system' | 'light' | 'dark' | 'ppt'; it then writes the
 * resolved value to the keys above.
 */
(function () {
  'use strict';
  var KEYS = ['theme', 'mzo_theme', 'collectionDashboardTheme'];
  var PREV_KEY = 'mzo_theme_prev';
  var root = document.documentElement;

  function norm(v) {
    return (v === 'light' || v === 'ppt') ? v : 'dark';
  }

  function read() {
    var v = null;
    try { v = localStorage.getItem('theme') || localStorage.getItem('mzo_theme') || localStorage.getItem('collectionDashboardTheme'); } catch (e) {}
    return norm(v);
  }

  function paint(theme) {
    theme = norm(theme);
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
  }

  function apply(theme) {
    theme = norm(theme);
    paint(theme);
    chartDefaults();
    try { window.dispatchEvent(new CustomEvent('mzo-theme-change', { detail: { theme: theme } })); } catch (e) {}
    return theme;
  }

  function set(theme) {
    theme = norm(theme);
    try {
      var cur = read();
      if (cur !== 'ppt' && theme === 'ppt') localStorage.setItem(PREV_KEY, cur);
      KEYS.forEach(function (k) { localStorage.setItem(k, theme); });
      localStorage.setItem('mzo_theme_pref', theme);
    } catch (e) {}
    return apply(theme);
  }

  function togglePpt() {
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

  // Running inside the workstation shell (app.html)?
  var inShell = false;
  try { inShell = window.self !== window.top && !!window.top.__MZO_SHELL__; } catch (e) {}
  if (inShell) root.classList.add('mzo-in-shell');

  window.MzoTheme = {
    get: read,
    set: set,
    apply: apply,
    inShell: inShell,
    toggle: function () { return set(read() === 'light' ? 'dark' : 'light'); },
    togglePpt: togglePpt
  };

  // Paint as early as possible (html element exists), then again once body exists.
  paint(read());
  document.addEventListener('DOMContentLoaded', function () { paint(read()); chartDefaults(); });
  window.addEventListener('load', chartDefaults);

  // Follow changes made by the shell or by another page's own toggle.
  window.addEventListener('storage', function (e) {
    if (KEYS.indexOf(e.key) !== -1) apply(norm(e.newValue));
  });
})();
