/* MZO unified theme controller.
 * Single source of truth for dark/light across the workstation shell and every page.
 * Storage keys kept in sync: theme, mzo_theme, collectionDashboardTheme.
 * Anything that is not explicitly 'light' resolves to 'dark' (matches app.html).
 */
(function () {
  'use strict';
  var KEYS = ['theme', 'mzo_theme', 'collectionDashboardTheme'];

  function read() {
    var v = null;
    try { v = localStorage.getItem('theme') || localStorage.getItem('mzo_theme') || localStorage.getItem('collectionDashboardTheme'); } catch (e) {}
    return v === 'light' ? 'light' : 'dark';
  }

  function paint(theme) {
    var isLight = theme === 'light';
    var root = document.documentElement;
    root.setAttribute('data-mzo-theme', theme);
    root.setAttribute('data-bs-theme', theme);
    root.classList.toggle('light-theme', isLight);
    root.classList.toggle('dark-theme', !isLight);
    root.classList.toggle('light', isLight);
    root.classList.toggle('dark', !isLight);
    var b = document.body;
    if (b) {
      b.classList.remove('puja-theme');
      b.classList.toggle('light-theme', isLight);
      b.classList.toggle('dark-theme', !isLight);
      b.classList.toggle('light', isLight);
      b.classList.toggle('dark', !isLight);
    }
  }

  function apply(theme) {
    theme = theme === 'light' ? 'light' : 'dark';
    paint(theme);
    try { window.dispatchEvent(new CustomEvent('mzo-theme-change', { detail: { theme: theme } })); } catch (e) {}
    return theme;
  }

  function set(theme) {
    theme = theme === 'light' ? 'light' : 'dark';
    try { KEYS.forEach(function (k) { localStorage.setItem(k, theme); }); } catch (e) {}
    return apply(theme);
  }

  window.MzoTheme = { get: read, set: set, apply: apply, toggle: function () { return set(read() === 'light' ? 'dark' : 'light'); } };

  // Paint as early as possible (html element exists), then again once body exists.
  paint(read());
  document.addEventListener('DOMContentLoaded', function () { paint(read()); });

  // Follow changes made by the shell or by another page's own toggle.
  window.addEventListener('storage', function (e) {
    if (KEYS.indexOf(e.key) !== -1) apply(e.newValue === 'light' ? 'light' : 'dark');
  });
})();
