/* DISHA PWA icons: the manifest, and a favicon that follows the light / dark theme. */
(function () {
  try {
    var isDark = false;
    try {
      var pref = localStorage.getItem('mzo_theme_pref') || '';
      var saved = localStorage.getItem('theme') || localStorage.getItem('mzo_theme');
      isDark = pref === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : (pref ? pref === 'dark' : saved === 'dark');
    } catch (e) {}
    var iconHref = isDark ? '/icons/icon-192-dark.png?v=298' : '/icons/icon-192-v2.png?v=298';
    function addLink(rel, href, attrs) {
      var el = document.createElement('link');
      el.rel = rel;
      el.href = href;
      if (attrs) {
        Object.keys(attrs).forEach(function (k) {
          el.setAttribute(k, attrs[k]);
        });
      }
      document.head.appendChild(el);
      return el;
    }
    addLink('manifest', '/manifest.json');
    var favEl = addLink('icon', iconHref, { type: 'image/png' });
    addLink('apple-touch-icon', '/icons/icon-192-v2.png?v=298');
    if (favEl) {
      window.addEventListener('mzo-theme-change', function (ev) {
        var t = (ev && ev.detail && ev.detail.theme) || document.documentElement.getAttribute('data-mzo-theme');
        favEl.href = t === 'dark' ? '/icons/icon-192-dark.png?v=298' : '/icons/icon-192-v2.png?v=298';
      });
    }
  } catch (e) {}
})();
