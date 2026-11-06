/* Shared HTML escaping for values that come from sheets and tables: window.mzoEsc(value).
 * Use it for every value put into innerHTML, template HTML, Leaflet popups/tooltips/divIcons and
 * HTML attributes. Not for inline event handlers: pass values through data-* attributes instead. */
(function (g) {
  'use strict';
  var MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  function mzoEsc(v) { return String(v == null ? '' : v).replace(/[&<>"'`]/g, function (c) { return MAP[c]; }); }
  g.mzoEsc = mzoEsc;
})(typeof window !== 'undefined' ? window : globalThis);
