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
    var dark = false;
    try { dark = (localStorage.getItem('theme') || localStorage.getItem('mzo_theme')) !== 'light'; } catch (e) {}
    var c = dark
      ? { bg: '#09090a', card: '#161617', line: '#27272a', text: '#ececee', muted: '#8e8e96', ink: '#ececee', onInk: '#0f0f10', note: '#1c1c1e' }
      : { bg: '#f1f1f0', card: '#ffffff', line: '#e7e7e5', text: '#18181b', muted: '#71717a', ink: '#18181b', onInk: '#ffffff', note: '#f5f5f4' };
    overlay.innerHTML =
      '<style>' +
      '#mzo-app-update-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:' + c.bg + ';padding:24px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}' +
      '#mzo-app-update-card{width:100%;max-width:400px;background:' + c.card + ';border:1px solid ' + c.line + ';border-radius:12px;padding:24px;color:' + c.text + '}' +
      '#mzo-app-update-card .mzo-update-k{font-size:12px;font-weight:500;color:' + c.muted + ';margin:0 0 6px}' +
      '#mzo-app-update-card h3{margin:0 0 14px;font-size:18px;font-weight:600;letter-spacing:-0.01em}' +
      '#mzo-app-update-card .mzo-update-note{margin:0 0 20px;padding:12px 14px;border-radius:8px;background:' + c.note + ';border:1px solid ' + c.line + ';font-size:13.5px;line-height:1.5;white-space:pre-line}' +
      '#mzo-app-update-card button{width:100%;border:0;border-radius:8px;padding:10px 14px;font:600 13.5px inherit;font-family:inherit;background:' + c.ink + ';color:' + c.onInk + ';cursor:pointer}' +
      '#mzo-app-update-card button:hover{opacity:.9}' +
      '</style>' +
      '<div id="mzo-app-update-card">' +
      '<p class="mzo-update-k">MZO Reports</p>' +
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
        returning = !!localStorage.getItem('mzo_authenticated');
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
