/**
 * mzo_presets_hub.js — bootstrap for nsc.html when it is opened outside the shell.
 * Hides the page until auth.js has checked the session, starts the app-update check and
 * registers the service worker. (The old office-preference presets were retired.)
 */
(function () {
    'use strict';

    // No local sign-in: keep the page hidden; auth.js unhides it or sends the user to login.
    if (localStorage.getItem('mzo_authenticated') !== 'true') {
        document.documentElement.style.display = 'none';
    }

    // auth.js sits next to this script.
    var tag = document.querySelector('script[src*="mzo_presets_hub.js"]');
    var src = tag ? (tag.getAttribute('src') || '').split('?')[0] : '';
    var auth = document.createElement('script');
    auth.src = src.replace(/mzo_presets_hub\.js$/, '') + 'auth.js';
    document.head.appendChild(auth);

    if (!window.__mzoAppUpdateScript) {
        window.__mzoAppUpdateScript = true;
        var update = document.createElement('script');
        update.src = '/mzo_app_update.js?v=87';
        update.async = true;
        document.head.appendChild(update);
    }

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('./sw.js')
                .then(function (reg) { try { reg.update(); } catch (e) {} })
                .catch(function (err) { console.warn('Service worker registration failed:', err); });
        });
    }
})();
