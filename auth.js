// auth.js — login gate for standalone pages (the app.html shell checks the session itself).
// Checks the session cookie, keeps the cached profile fresh, offers window.mzoLogout(), adds a
// sign-out button to the phone hub header, and inside an iframe hands page links to the shell.
(function () {
    'use strict';

    function loadScript(flag, src, async) {
        if (window[flag]) return;
        window[flag] = true;
        var s = document.createElement('script');
        s.src = src;
        if (async) s.async = true;
        document.head.appendChild(s);
    }
    loadScript('__mzoAppUpdateScript', '/mzo_app_update.js?v=87', true);
    if (!window.__mzoRetiredNotice) loadScript('__mzoRetiredNoticeScript', '/mzo_origin_redirect.js', false);

    function clearSession() {
        localStorage.removeItem('mzo_authenticated');
        localStorage.removeItem('mzo_user_profile');
    }
    function toLogin() { window.location.href = '/login.html'; }
    function offlineGate() { if (localStorage.getItem('mzo_authenticated') !== 'true') toLogin(); }

    // Online: the server decides. Offline (or the check fails): the cached flag decides.
    if (navigator.onLine) {
        fetch('/api/session-check', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
            .then(function (res) {
                if (!res.ok) { clearSession(); toLogin(); return; }
                localStorage.setItem('mzo_authenticated', 'true');
                // mzo_presets_hub.js hides the page while the local flag is missing.
                if (document.documentElement.style.display === 'none') document.documentElement.style.display = '';
                return res.json().then(function (data) {
                    if (data && data.profile) localStorage.setItem('mzo_user_profile', JSON.stringify(data.profile));
                }, function () {});
            })
            .catch(offlineGate);
    } else {
        offlineGate();
    }

    // Sign-out confirmation, drawn with the theme tokens (falls back to light colours).
    function confirmLogout() {
        return new Promise(function (resolve) {
            var old = document.getElementById('mzo-logout-modal');
            if (old) old.remove();
            var overlay = document.createElement('div');
            overlay.id = 'mzo-logout-modal';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;' +
                'background:rgba(9,9,10,.45);opacity:0;transition:opacity .2s ease';
            overlay.innerHTML =
                '<div role="dialog" aria-modal="true" aria-labelledby="mzo-logout-t" style="width:90%;max-width:320px;padding:20px;border-radius:12px;' +
                'background:var(--mzo-surface,#fff);color:var(--mzo-text,#18181b);border:1px solid var(--mzo-border,#e7e7e5);' +
                'box-shadow:0 16px 40px rgba(0,0,0,.18);font:14px/1.45 var(--mzo-font,system-ui,-apple-system,sans-serif)">' +
                '<h3 id="mzo-logout-t" style="margin:0 0 6px;font-size:16px;font-weight:600">Sign out</h3>' +
                '<p style="margin:0 0 16px;font-size:13px;color:var(--mzo-muted,#71717a)">Sign out of MZO Reports on this device?</p>' +
                '<div style="display:flex;gap:8px;justify-content:flex-end">' +
                '<button type="button" data-v="0" style="height:34px;padding:0 14px;border-radius:8px;border:1px solid var(--mzo-border-strong,#d4d4d2);' +
                'background:var(--mzo-surface,#fff);color:inherit;font:inherit;cursor:pointer">Cancel</button>' +
                '<button type="button" data-v="1" style="height:34px;padding:0 14px;border-radius:8px;border:0;background:var(--mzo-bad,#b42318);' +
                'color:#fff;font:inherit;font-weight:500;cursor:pointer">Sign out</button></div></div>';
            document.body.appendChild(overlay);
            requestAnimationFrame(function () { overlay.style.opacity = '1'; });
            function close(ok) {
                overlay.style.opacity = '0';
                setTimeout(function () { overlay.remove(); resolve(ok); }, 200);
            }
            overlay.addEventListener('click', function (e) {
                var b = e.target.closest('button[data-v]');
                if (b) close(b.getAttribute('data-v') === '1');
                else if (e.target === overlay) close(false);
            });
        });
    }

    function mzoLogout() {
        return confirmLogout().then(function (ok) {
            if (!ok) return;
            return fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
                .catch(function () {}) // offline: still sign out locally
                .then(function () { clearSession(); toLogin(); });
        });
    }
    window.mzoLogout = mzoLogout;

    // Phone hub only (top-level index.html): a round sign-out button in the header.
    function injectLogoutButton() {
        if (localStorage.getItem('mzo_authenticated') !== 'true') return;
        var path = window.location.pathname.toLowerCase();
        if (!(path.endsWith('/index.html') || path.endsWith('/') || path === '') || window.self !== window.top) return;
        if (document.querySelector('.logout-btn, .logout-float-btn')) return;

        // First match by priority, not document order: the action row sits inside `.header`.
        var header = null;
        ['.header-actions', '.header-row', '.header', '.filters-container', '.filters'].some(function (sel) { return (header = document.querySelector(sel)); });
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.title = 'Sign out';
        btn.innerHTML = '<i class="fas fa-sign-out-alt"></i>';
        btn.addEventListener('click', mzoLogout);
        if (header) {
            btn.className = 'theme-toggle logout-btn';
            btn.style.cssText = 'width:40px;height:40px;border-radius:50%;background:rgba(239,68,68,.1);color:#ef4444;' +
                'border:1px solid rgba(239,68,68,.2);cursor:pointer;font-size:16px;display:inline-flex;align-items:center;' +
                'justify-content:center;margin-left:4px;transition:background .2s ease;outline:none';
            header.appendChild(btn);
        } else {
            btn.className = 'logout-float-btn';
            btn.style.cssText = 'position:fixed;bottom:80px;left:20px;z-index:9999;width:44px;height:44px;border-radius:50%;border:0;' +
                'background:#ef4444;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;' +
                'box-shadow:0 4px 12px rgba(239,68,68,.4)';
            document.body.appendChild(btn);
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectLogoutButton);
    else injectLogoutButton();

    if (window.self === window.top) return;

    // Inside an iframe: drop the outer top spacing (the frame already has its own).
    function tightenFrame() {
        document.body.style.paddingTop = '0px';
        document.body.style.marginTop = '0px';
        var container = document.querySelector('.dashboard-container, .app-container, .container-fluid');
        if (container) { container.style.marginTop = '0px'; container.style.paddingTop = '0px'; }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tightenFrame);
    else tightenFrame();

    // Same-origin .html links open through the shell (parent.openPage) instead of inside this frame.
    document.addEventListener('click', function (e) {
        var a = e.target.closest('a[href]');
        if (!a || a.getAttribute('target') === '_blank') return;
        var href = a.getAttribute('href');
        if (!href || href.charAt(0) === '#' || href.indexOf('.html') === -1) return;
        var url;
        try { url = new URL(href, window.location.href); } catch (err) { return; }
        if (url.origin !== window.location.origin) return;
        e.preventDefault();
        // Resolve against this page, so "upload.html" on /stock/ opens /stock/upload.html.
        var target = url.pathname.replace(/^\//, '') + url.search + url.hash;
        if (window.parent && typeof window.parent.openPage === 'function') {
            var label = a.querySelector('.kpi-title, .app-label');
            window.parent.openPage(target, ((label || a).textContent || '').trim() || 'Dashboard');
        } else {
            window.location.href = url.href;
        }
    });
})();
