/* Runs in <head>, after /kit/mzo_theme.js and before /kit/mzo_ui.js.
 * - The kit loads the app's /auth.js login gate when a page is opened outside the app shell.
 *   The portal has its own sign-in (PocketBase), so tell the kit the gate is already handled.
 * - With no saved theme, follow the system setting instead of the kit's dark default
 *   (applied, not saved, so a later choice in the menu still wins).
 */
(function () {
  'use strict';
  window.__mzoAuthScript = true;
  var saved = null;
  try { saved = localStorage.getItem('theme') || localStorage.getItem('mzo_theme'); } catch (e) {}
  if (saved !== 'light' && saved !== 'dark' && window.MzoTheme && window.matchMedia) {
    window.MzoTheme.apply(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
})();
