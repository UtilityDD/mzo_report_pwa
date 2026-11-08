/* DISHA PWA icons + iOS splash: favicon follows light/dark; launch images use the D mark on black. */
(function () {
  try {
    var isDark = false;
    try {
      var pref = localStorage.getItem('mzo_theme_pref') || '';
      var saved = localStorage.getItem('theme') || localStorage.getItem('mzo_theme');
      isDark = pref === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : (pref ? pref === 'dark' : saved === 'dark');
    } catch (e) {}
    var iconHref = isDark ? '/icons/icon-192-dark-v4.png?v=307' : '/icons/icon-192-v4.png?v=307';
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
    addLink('apple-touch-icon', '/icons/icon-192-v4.png?v=307');
    // iOS standalone splash (black + D mark). Chrome Android builds splash from the manifest icon + background_color.
    addLink('apple-touch-startup-image', '/icons/splash-1170x2532.png?v=307', {
      media: '(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)'
    });
    addLink('apple-touch-startup-image', '/icons/splash-1284x2778.png?v=307', {
      media: '(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3)'
    });
    addLink('apple-touch-startup-image', '/icons/splash-1080x1920.png?v=307', {
      media: '(device-width: 360px) and (device-height: 640px) and (-webkit-device-pixel-ratio: 3)'
    });
    addLink('apple-touch-startup-image', '/icons/splash-1080x1920.png?v=307');
    if (favEl) {
      window.addEventListener('mzo-theme-change', function (ev) {
        var t = (ev && ev.detail && ev.detail.theme) || document.documentElement.getAttribute('data-mzo-theme');
        favEl.href = t === 'dark' ? '/icons/icon-192-dark-v4.png?v=307' : '/icons/icon-192-v4.png?v=307';
      });
    }
  } catch (e) {}
})();
