/* Runs in <head>, after /kit/mzo_theme.js and before /kit/mzo_ui.js.
 * The kit loads the app's /auth.js login gate on pages opened outside the app; this page is
 * public, so tell the kit the gate is handled. With no saved theme, follow the system setting. */
(function () {
  'use strict';
  window.__mzoAuthScript = true;
  var saved = null;
  try { saved = localStorage.getItem('theme') || localStorage.getItem('mzo_theme'); } catch (e) {}
  if (saved === 'light' || saved === 'dark' || !window.MzoTheme || !window.matchMedia) return;
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  function follow() { window.MzoTheme.apply(mq.matches ? 'dark' : 'light'); }
  follow();
  // The kit repaints its saved (or default dark) theme on DOMContentLoaded; follow the system after it.
  document.addEventListener('DOMContentLoaded', follow);
  if (mq.addEventListener) mq.addEventListener('change', follow);
})();
