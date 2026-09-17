/* Retired host notice only on mzo-report-pwa.vercel.app.
   Do not auto-redirect (that would also risk the new origin if mis-configured). */
(function () {
  try {
    var host = String(location.hostname || '');
    if (!/(?:^|\.)mzo-report-pwa\.vercel\.app$/i.test(host)) return;
    if (window.__mzoRetiredNotice) return;
    window.__mzoRetiredNotice = true;

    var NEW = 'https://mzo-reports.vercel.app/login.html';
    var path = String(location.pathname || '');
    var onLogin = /\/login\.html$/i.test(path);

    var bar = document.createElement('div');
    bar.id = 'mzo-retired-host-banner';
    bar.setAttribute('role', 'status');
    bar.style.cssText = [
      'position:sticky',
      'top:0',
      'z-index:999990',
      'background:#0f766e',
      'color:#fff',
      'padding:10px 12px',
      'font-family:Inter,system-ui,sans-serif',
      'font-size:13px',
      'line-height:1.35',
      'display:flex',
      'flex-wrap:wrap',
      'align-items:center',
      'justify-content:center',
      'gap:8px',
      'text-align:center'
    ].join(';');
    bar.innerHTML =
      '<span>New MZO Reports app is ready (gold icon).</span>' +
      '<a href="' + NEW + '" style="color:#fff;font-weight:700;text-decoration:underline">Open new app</a>' +
      '<span>then tap <strong>Install app</strong>.</span>';

    function mount() {
      if (!document.body) return;
      if (document.getElementById('mzo-retired-host-banner')) return;
      document.body.insertBefore(bar, document.body.firstChild);
      if (onLogin) {
        var card = document.createElement('div');
        card.style.cssText =
          'margin:12px;padding:14px;border-radius:12px;background:#ecfdf5;color:#115e59;' +
          'font-family:Inter,system-ui,sans-serif;font-size:14px;line-height:1.4;text-align:center;' +
          'border:1px solid #99f6e4';
        card.innerHTML =
          '<div style="font-weight:700;margin-bottom:6px">Download / install the new version</div>' +
          '<div style="margin-bottom:10px">This old address will not get updates. The new app uses a <strong>gold MZO icon</strong> so you can tell it from this navy one and uninstall the old app.</div>' +
          '<a href="' + NEW + '" style="display:inline-block;background:#0f766e;color:#fff;font-weight:700;' +
          'text-decoration:none;padding:10px 16px;border-radius:8px">Open https://mzo-reports.vercel.app</a>';
        bar.insertAdjacentElement('afterend', card);
      }
    }

    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
  } catch (e) {}
})();
