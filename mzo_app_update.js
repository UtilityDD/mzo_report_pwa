/**
 * App version bump (desktop + installed PWA).
 * Reads /version.json. When the version changes, shows the bump message and reloads
 * so users pick up new HTML/JS without clearing cache by hand.
 */
(function (root) {
  'use strict';
  try {
    if (root.top && root.top !== root) return;
  } catch (e) {
    return;
  }
  if (root.__mzoAppUpdateStarted) return;
  root.__mzoAppUpdateStarted = true;

  var STORAGE_KEY = 'mzo_app_version';
  var RELOAD_KEY = 'mzo_app_reload_once';

  function fetchVersion() {
    return fetch('/version.json?t=' + Date.now(), {
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).catch(function () { return null; });
  }

  function showBanner(data, onReload) {
    if (document.getElementById('mzo-app-update-overlay')) return;
    var overlay = document.createElement('div');
    overlay.id = 'mzo-app-update-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML =
      '<style>' +
      '#mzo-app-update-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:#0f172a;padding:24px;font-family:system-ui,-apple-system,sans-serif}' +
      '#mzo-app-update-card{width:100%;max-width:440px;color:#f8fafc}' +
      '#mzo-app-update-card h3{margin:0 0 16px;font-size:28px;font-weight:700;letter-spacing:-0.03em}' +
      '#mzo-app-update-card .mzo-update-note{margin:0 0 22px;padding:14px 16px;border-radius:12px;background:rgba(99,102,241,.2);border:1px solid rgba(129,140,248,.5);color:#e0e7ff;font-size:16px;line-height:1.5;font-weight:600;white-space:pre-line}' +
      '#mzo-app-update-card button{width:100%;border:0;border-radius:12px;padding:14px 16px;font-size:16px;font-weight:600;background:#4f46e5;color:#fff;cursor:pointer}' +
      '</style>' +
      '<div id="mzo-app-update-card">' +
      '<h3>App updated</h3>' +
      '<div class="mzo-update-note"></div>' +
      '<button type="button">Reload</button>' +
      '</div>';
    var msg = (data && data.message) ? String(data.message) : 'A new version is ready.';
    overlay.querySelector('.mzo-update-note').textContent = msg;
    overlay.querySelector('button').addEventListener('click', onReload);
    document.body.appendChild(overlay);
  }

  function applyUpdate(data) {
    var ver = data && data.version != null ? String(data.version) : '';
    if (!ver) return;
    try { sessionStorage.setItem(RELOAD_KEY, ver); } catch (e) {}
    try { localStorage.setItem(STORAGE_KEY, ver); } catch (e) {}
    location.reload();
  }

  function check() {
    fetchVersion().then(function (data) {
      if (!data || data.version == null) return;
      var next = String(data.version);
      var seen = '';
      try { seen = localStorage.getItem(STORAGE_KEY) || ''; } catch (e) {}
      var returning = false;
      try {
        returning = !!(localStorage.getItem('mzo_authenticated') || localStorage.getItem('mzo_last_sync_date'));
      } catch (e) {}
      if (!seen && !returning) {
        try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
        return;
      }
      if (seen === next) return;
      showBanner(data, function () { applyUpdate(data); });
      if (data.force_update) {
        setTimeout(function () { applyUpdate(data); }, 2500);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }

  if (root.navigator && root.navigator.serviceWorker) {
    root.navigator.serviceWorker.addEventListener('message', function (ev) {
      var data = ev && ev.data;
      if (!data || data.type !== 'MZO_APP_UPDATED') return;
      check();
    });
    var refreshing = false;
    root.navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (refreshing) return;
      var once = '';
      try { once = sessionStorage.getItem(RELOAD_KEY) || ''; } catch (e) {}
      if (once) {
        try { sessionStorage.removeItem(RELOAD_KEY); } catch (e) {}
        return;
      }
      refreshing = true;
      check();
    });
  }
})(typeof window !== 'undefined' ? window : this);
