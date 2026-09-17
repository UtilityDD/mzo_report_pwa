/* Retired host freeze only on mzo-report-pwa.vercel.app.
   Do not auto-redirect. Do not allow login on this origin. */
(function () {
  try {
    var host = String(location.hostname || '');
    if (!/(?:^|\.)mzo-report-pwa\.vercel\.app$/i.test(host)) return;
    if (window.__mzoRetiredNotice) return;
    window.__mzoRetiredNotice = true;

    var NEW = 'https://mzo-reports.vercel.app/login.html';

    function copyUrl(btn) {
      function ok() {
        btn.textContent = 'Copied';
        setTimeout(function () {
          btn.textContent = 'Copy';
        }, 1600);
      }
      function fail() {
        btn.textContent = 'Copy failed';
        setTimeout(function () {
          btn.textContent = 'Copy';
        }, 1600);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(NEW).then(ok).catch(function () {
          fallbackCopy() ? ok() : fail();
        });
        return;
      }
      fallbackCopy() ? ok() : fail();
    }

    function fallbackCopy() {
      try {
        var ta = document.createElement('textarea');
        ta.value = NEW;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, NEW.length);
        var done = document.execCommand('copy');
        document.body.removeChild(ta);
        return done;
      } catch (e) {
        return false;
      }
    }

    function freezeLogin() {
      var form = document.getElementById('loginForm');
      if (form) {
        form.setAttribute('aria-hidden', 'true');
        Array.prototype.forEach.call(form.elements || [], function (el) {
          el.disabled = true;
        });
        form.addEventListener(
          'submit',
          function (e) {
            e.preventDefault();
            e.stopPropagation();
          },
          true
        );
      }
    }

    function mount() {
      if (!document.body) return;
      if (document.getElementById('mzo-retired-host-freeze')) return;

      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
      freezeLogin();

      var overlay = document.createElement('div');
      overlay.id = 'mzo-retired-host-freeze';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'mzo-retired-title');
      overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'background:#0f172a',
        'color:#e2e8f0',
        'font-family:Inter,system-ui,sans-serif',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:20px 16px',
        'overflow:auto',
        'box-sizing:border-box'
      ].join(';');

      overlay.innerHTML =
        '<div style="width:100%;max-width:420px;background:#111827;border:1px solid #334155;border-radius:16px;padding:22px 18px;box-sizing:border-box">' +
        '<div id="mzo-retired-title" style="font-size:20px;font-weight:700;color:#fff;margin-bottom:8px">This app has moved</div>' +
        '<div style="font-size:14px;line-height:1.45;margin-bottom:14px;color:#cbd5e1">This old address no longer signs you in. Install the new MZO Reports app (gold icon), then uninstall this navy one.</div>' +
        '<div style="display:flex;gap:8px;align-items:stretch;margin-bottom:12px">' +
        '<input id="mzo-retired-url" type="text" readonly value="' +
        NEW +
        '" style="flex:1;min-width:0;background:#0b1220;color:#f8fafc;border:1px solid #475569;border-radius:8px;padding:10px 10px;font-size:13px">' +
        '<button type="button" id="mzo-retired-copy" style="flex:0 0 auto;background:#e8b923;color:#0a1628;border:0;border-radius:8px;font-weight:700;padding:10px 14px;cursor:pointer">Copy</button>' +
        '</div>' +
        '<a id="mzo-retired-open" href="' +
        NEW +
        '" target="_blank" rel="noopener noreferrer" style="display:block;text-align:center;background:#0f766e;color:#fff;font-weight:700;text-decoration:none;padding:12px 14px;border-radius:8px;margin-bottom:16px">Open in browser</a>' +
        '<ol style="margin:0;padding-left:18px;font-size:13px;line-height:1.55;color:#cbd5e1">' +
        '<li>Copy the link or tap <strong>Open in browser</strong>.</li>' +
        '<li>Open it in <strong>Chrome or Safari</strong> — not inside this old app.</li>' +
        '<li>Sign in, then tap <strong>Install app</strong>.</li>' +
        '<li>The new icon is <strong>gold MZO</strong>. You can then remove this navy icon.</li>' +
        '</ol>' +
        '</div>';

      document.body.appendChild(overlay);

      var copyBtn = document.getElementById('mzo-retired-copy');
      if (copyBtn) {
        copyBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          copyUrl(copyBtn);
        });
      }
      var urlInput = document.getElementById('mzo-retired-url');
      if (urlInput) {
        urlInput.addEventListener('focus', function () {
          urlInput.select();
        });
      }
    }

    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
  } catch (e) {}
})();
