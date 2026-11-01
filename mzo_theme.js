/* MZO unified theme controller.
 * Single source of truth for dark/light across the workstation shell and every page.
 * Storage keys kept in sync: theme, mzo_theme, collectionDashboardTheme ('light' | 'dark').
 * The shell may also store mzo_theme_pref = 'system'; it then writes the resolved value
 * to the keys above, so pages only ever read 'light' or 'dark'.
 * Anything that is not explicitly 'light' resolves to 'dark'.
 */
(function () {
  'use strict';
  var KEYS = ['theme', 'mzo_theme', 'collectionDashboardTheme'];
  var root = document.documentElement;

  function read() {
    var v = null;
    try { v = localStorage.getItem('theme') || localStorage.getItem('mzo_theme') || localStorage.getItem('collectionDashboardTheme'); } catch (e) {}
    return v === 'light' ? 'light' : 'dark';
  }

  function paint(theme) {
    var isLight = theme === 'light';
    root.setAttribute('data-mzo-theme', theme);
    root.setAttribute('data-bs-theme', theme);
    root.classList.toggle('light-theme', isLight);
    root.classList.toggle('dark-theme', !isLight);
    root.classList.toggle('light', isLight);
    root.classList.toggle('dark', !isLight);
    var b = document.body;
    if (b) {
      b.classList.toggle('light-theme', isLight);
      b.classList.toggle('dark-theme', !isLight);
      b.classList.toggle('light', isLight);
      b.classList.toggle('dark', !isLight);
      if (inShell) b.classList.add('in-workstation');
    }
  }

  function apply(theme) {
    theme = theme === 'light' ? 'light' : 'dark';
    paint(theme);
    chartDefaults();
    try { window.dispatchEvent(new CustomEvent('mzo-theme-change', { detail: { theme: theme } })); } catch (e) {}
    return theme;
  }

  function set(theme) {
    theme = theme === 'light' ? 'light' : 'dark';
    try { KEYS.forEach(function (k) { localStorage.setItem(k, theme); }); } catch (e) {}
    return apply(theme);
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
    toggle: function () { return set(read() === 'light' ? 'dark' : 'light'); }
  };

  // Paint as early as possible (html element exists), then again once body exists.
  paint(read());
  document.addEventListener('DOMContentLoaded', function () { paint(read()); chartDefaults(); });
  window.addEventListener('load', chartDefaults);

  // Follow changes made by the shell or by another page's own toggle.
  window.addEventListener('storage', function (e) {
    if (KEYS.indexOf(e.key) !== -1) apply(e.newValue === 'light' ? 'light' : 'dark');
  });
})();
