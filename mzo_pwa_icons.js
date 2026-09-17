/* New origin uses the gold MZO icon. Retired mzo-report-pwa keeps the navy icon. */
(function () {
  try {
    var retired = /(?:^|\.)mzo-report-pwa\.vercel\.app$/i.test(String(location.hostname || ''));
    var manHref = retired ? '/manifest-legacy.json' : '/manifest.json';
    var iconHref = retired ? '/icons/icon-192.png' : '/icons/icon-192-v2.png';
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
    }
    addLink('manifest', manHref);
    addLink('icon', iconHref, { type: 'image/png' });
    addLink('apple-touch-icon', iconHref);
  } catch (e) {}
})();
