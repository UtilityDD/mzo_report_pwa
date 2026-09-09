/**
 * App version bump (desktop + installed PWA).
 * Reads /version.json. When the version changes, shows the bump message and reloads
 * so users pick up new HTML/JS without clearing cache by hand.
 */
(function (root) {
  'use strict';
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
      '#mzo-app-update-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:flex-end;justify-content:center;background:rgba(15,23,42,.45);padding:16px;font-family:system-ui,-apple-system,sans-serif}' +
      '@media (min-width:720px){#mzo-app-update-overlay{align-items:center}}' +
      '#mzo-app-update-card{width:100%;max-width:420px;background:#0f172a;color:#f8fafc;border-radius:16px;padding:18px 18px 16px;box-shadow:0 18px 50px rgba(0,0,0,.35)}' +
      '#mzo-app-update-card h3{margin:0 0 8px;font-size:17px;font-weight:700}' +
      '#mzo-app-update-card p{margin:0 0 14px;font-size:14px;line-height:1.45;color:#cbd5e1}' +
      '#mzo-app-update-card button{width:100%;border:0;border-radius:10px;padding:12px 14px;font-size:15px;font-weight:600;background:#4f46e5;color:#fff;cursor:pointer}' +
      '</style>' +
      '<div id="mzo-app-update-card">' +
      '<h3>App updated</h3>' +
      '<p></p>' +
      '<button type="button">Reload now</button>' +
      '</div>';
    var msg = (data && data.message) ? String(data.message) : 'A new version is ready. Reload to continue.';
    overlay.querySelector('p').textContent = msg;
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
