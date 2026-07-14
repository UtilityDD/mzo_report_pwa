// auth.js - Client-Side Session Integrations & Logout Management
(function() {
    'use strict';

    // Verify authentication state (essential for offline routing and online validity check)
    if (navigator.onLine) {
        // Online: verify the session cookie with the server first
        fetch('/api/session-check', { 
            headers: { 'Accept': 'application/json' },
            credentials: 'same-origin'
        })
            .then(res => {
                if (res.ok) {
                    // Session is valid! Ensure flags are set
                    localStorage.setItem('mzo_authenticated', 'true');
                    res.json().then(data => {
                        if (data.profile) {
                            localStorage.setItem('mzo_user_profile', JSON.stringify(data.profile));
                        }
                    });
                } else {
                    // Session is invalid on the server! Clear storage and redirect
                    localStorage.removeItem('mzo_authenticated');
                    localStorage.removeItem('mzo_user_profile');
                    window.location.href = '/login.html';
                }
            })
            .catch(() => {
                // Network error, fallback to offline check
                if (localStorage.getItem('mzo_authenticated') !== 'true') {
                    window.location.href = '/login.html';
                }
            });
    } else {
        // Offline: rely strictly on localStorage flags
        if (localStorage.getItem('mzo_authenticated') !== 'true') {
            window.location.href = '/login.html';
        }
    }

    // Custom clean confirmation modal
    function showLogoutModal() {
        return new Promise((resolve) => {
            if (document.getElementById('mzo-logout-modal')) {
                document.getElementById('mzo-logout-modal').remove();
            }

            const overlay = document.createElement('div');
            overlay.id = 'mzo-logout-modal';
            overlay.style.position = 'fixed';
            overlay.style.top = '0';
            overlay.style.left = '0';
            overlay.style.width = '100vw';
            overlay.style.height = '100vh';
            overlay.style.background = 'rgba(15, 23, 42, 0.6)';
            overlay.style.backdropFilter = 'blur(8px)';
            overlay.style.webkitBackdropFilter = 'blur(8px)';
            overlay.style.display = 'flex';
            overlay.style.alignItems = 'center';
            overlay.style.justifyContent = 'center';
            overlay.style.zIndex = '999999';
            overlay.style.opacity = '0';
            overlay.style.transition = 'opacity 0.25s ease';

            const card = document.createElement('div');
            card.style.width = '90%';
            card.style.maxWidth = '320px';
            card.style.background = 'rgba(30, 41, 59, 0.9)';
            card.style.border = '1px solid rgba(255, 255, 255, 0.08)';
            card.style.borderRadius = '16px';
            card.style.padding = '24px';
            card.style.boxShadow = '0 20px 40px rgba(0, 0, 0, 0.4)';
            card.style.display = 'flex';
            card.style.flexDirection = 'column';
            card.style.gap = '16px';
            card.style.transform = 'scale(0.95) translateY(10px)';
            card.style.transition = 'all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)';
            card.style.fontFamily = "'Inter', -apple-system, sans-serif";

            const title = document.createElement('h3');
            title.textContent = 'Sign Out';
            title.style.color = '#f8fafc';
            title.style.fontSize = '18px';
            title.style.fontWeight = '600';
            title.style.margin = '0';

            const message = document.createElement('p');
            message.textContent = 'Are you sure you want to sign out of the MZO Portal?';
            message.style.color = '#94a3b8';
            message.style.fontSize = '13px';
            message.style.lineHeight = '1.5';
            message.style.margin = '0';

            const btnContainer = document.createElement('div');
            btnContainer.style.display = 'flex';
            btnContainer.style.gap = '12px';
            btnContainer.style.marginTop = '8px';

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Cancel';
            cancelBtn.style.flex = '1';
            cancelBtn.style.background = 'rgba(255, 255, 255, 0.05)';
            cancelBtn.style.color = '#e2e8f0';
            cancelBtn.style.border = '1px solid rgba(255, 255, 255, 0.08)';
            cancelBtn.style.borderRadius = '8px';
            cancelBtn.style.padding = '10px';
            cancelBtn.style.fontSize = '13px';
            cancelBtn.style.fontWeight = '500';
            cancelBtn.style.cursor = 'pointer';
            cancelBtn.style.outline = 'none';
            cancelBtn.style.transition = 'background 0.2s';
            
            cancelBtn.addEventListener('mouseenter', () => cancelBtn.style.background = 'rgba(255, 255, 255, 0.1)');
            cancelBtn.addEventListener('mouseleave', () => cancelBtn.style.background = 'rgba(255, 255, 255, 0.05)');

            const confirmBtn = document.createElement('button');
            confirmBtn.textContent = 'Sign Out';
            confirmBtn.style.flex = '1';
            confirmBtn.style.background = '#ef4444';
            confirmBtn.style.color = '#ffffff';
            confirmBtn.style.border = 'none';
            confirmBtn.style.borderRadius = '8px';
            confirmBtn.style.padding = '10px';
            confirmBtn.style.fontSize = '13px';
            confirmBtn.style.fontWeight = '600';
            confirmBtn.style.cursor = 'pointer';
            confirmBtn.style.outline = 'none';
            confirmBtn.style.transition = 'background 0.2s';

            confirmBtn.addEventListener('mouseenter', () => confirmBtn.style.background = '#dc2626');
            confirmBtn.addEventListener('mouseleave', () => confirmBtn.style.background = '#ef4444');

            btnContainer.appendChild(cancelBtn);
            btnContainer.appendChild(confirmBtn);
            card.appendChild(title);
            card.appendChild(message);
            card.appendChild(btnContainer);
            overlay.appendChild(card);
            document.body.appendChild(overlay);

            setTimeout(() => {
                overlay.style.opacity = '1';
                card.style.transform = 'scale(1) translateY(0)';
            }, 10);

            cancelBtn.addEventListener('click', () => {
                overlay.style.opacity = '0';
                card.style.transform = 'scale(0.95) translateY(10px)';
                setTimeout(() => {
                    overlay.remove();
                    resolve(false);
                }, 250);
            });

            confirmBtn.addEventListener('click', () => {
                overlay.style.opacity = '0';
                card.style.transform = 'scale(0.95) translateY(10px)';
                setTimeout(() => {
                    overlay.remove();
                    resolve(true);
                }, 250);
            });
            
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    cancelBtn.click();
                }
            });
        });
    }

    // Global Logout function
    async function mzoLogout() {
        const confirmed = await showLogoutModal();
        if (!confirmed) return;
        
        try {
            const res = await fetch('/api/logout', { 
                method: 'POST',
                credentials: 'same-origin'
            });
            if (res.ok) {
                console.log("[Auth] Successfully logged out via API");
            }
        } catch (err) {
            console.warn("[Auth] API logout connection failed (likely offline):", err);
        } finally {
            // Always clear client-side data
            localStorage.removeItem('mzo_authenticated');
            localStorage.removeItem('mzo_user_profile');
            window.location.href = '/login.html';
        }
    }
    window.mzoLogout = mzoLogout;

    function injectLogoutButton() {
        if (localStorage.getItem('mzo_authenticated') !== 'true') return;

        // Only inject logout button on the main index.html page (top level, not in iframe)
        const path = window.location.pathname.toLowerCase();
        const isIndexPage = path.endsWith('/index.html') || path.endsWith('/') || path === '';
        const isTopLevel = (window.self === window.top);
        if (!isIndexPage || !isTopLevel) return;

        // Prevent duplicate injection
        if (document.querySelector('.logout-btn') || document.querySelector('.logout-float-btn')) return;

        // Try to find a header container to append the logout button
        let headerContainer = document.querySelector('.header-actions') ||
                             document.querySelector('.header-row') || 
                             document.querySelector('.header') || 
                             document.querySelector('.filters-container') ||
                             document.querySelector('.filters');

        if (headerContainer) {
            const logoutBtn = document.createElement('button');
            logoutBtn.className = 'theme-toggle logout-btn';
            logoutBtn.title = 'Sign Out';
            logoutBtn.innerHTML = '<i class="fas fa-sign-out-alt"></i>';
            
            // Circular styling to match theme-toggle and sync-btn
            logoutBtn.style.width = '40px';
            logoutBtn.style.height = '40px';
            logoutBtn.style.borderRadius = '50%';
            logoutBtn.style.background = 'rgba(239, 68, 68, 0.1)';
            logoutBtn.style.color = '#ef4444';
            logoutBtn.style.border = '1px solid rgba(239, 68, 68, 0.2)';
            logoutBtn.style.cursor = 'pointer';
            logoutBtn.style.fontSize = '16px';
            logoutBtn.style.display = 'inline-flex';
            logoutBtn.style.alignItems = 'center';
            logoutBtn.style.justifyContent = 'center';
            logoutBtn.style.marginLeft = '4px';
            logoutBtn.style.transition = 'all 0.2s ease';
            logoutBtn.style.outline = 'none';

            logoutBtn.addEventListener('mouseenter', () => {
                logoutBtn.style.background = 'rgba(239, 68, 68, 0.2)';
                logoutBtn.style.transform = 'translateY(-2px) scale(1.05)';
            });

            logoutBtn.addEventListener('mouseleave', () => {
                logoutBtn.style.background = 'rgba(239, 68, 68, 0.1)';
                logoutBtn.style.transform = 'none';
            });

            logoutBtn.addEventListener('click', mzoLogout);

            headerContainer.appendChild(logoutBtn);
            console.log("[Auth] Dynamic Sign Out button injected successfully");
        } else {
            // Fallback: create floating logout button at the bottom-left of the screen
            const floatBtn = document.createElement('div');
            floatBtn.className = 'logout-float-btn';
            floatBtn.style.position = 'fixed';
            floatBtn.style.bottom = '80px';
            floatBtn.style.left = '20px';
            floatBtn.style.zIndex = '9999';
            floatBtn.innerHTML = `
                <button onclick="window.mzoLogout()" style="background:#ef4444; color:#fff; border:none; border-radius:50%; width:44px; height:44px; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 12px rgba(239,68,68,0.4); cursor:pointer; font-size:16px;">
                    <i class="fas fa-sign-out-alt"></i>
                </button>
            `;
            document.body.appendChild(floatBtn);
            console.log("[Auth] Floating Sign Out button injected successfully");
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectLogoutButton);
    } else {
        injectLogoutButton();
    }

    // Optimize layout spacing when loaded inside an iframe (removes double margins)
    if (window.self !== window.top) {
        const adjustIframeLayout = () => {
            document.body.style.paddingTop = '0px';
            document.body.style.marginTop = '0px';
            
            // Adjust common container wrappers if present
            const container = document.querySelector('.dashboard-container') || 
                              document.querySelector('.app-container') ||
                              document.querySelector('.container-fluid');
            if (container) {
                container.style.marginTop = '0px';
                container.style.paddingTop = '0px';
            }
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', adjustIframeLayout);
        } else {
            adjustIframeLayout();
        }

        // Intercept local HTML link clicks inside the iframe to navigate properly in the parent PWA
        document.addEventListener('click', (e) => {
            const anchor = e.target.closest('a');
            if (anchor && anchor.getAttribute('href')) {
                const href = anchor.getAttribute('href');
                
                // Match local relative HTML page links (e.g. "loss.html", "nsc.html")
                // ignoring external links, target="_blank", mailto/tel protocols, and hashes.
                if (href && 
                    href.includes('.html') && 
                    !href.startsWith('http') && 
                    !href.startsWith('//') && 
                    !href.startsWith('#') &&
                    anchor.getAttribute('target') !== '_blank') {
                    
                    e.preventDefault();
                    
                    // Route to parent window's PWA navigation controller
                    if (window.parent && typeof window.parent.openPage === 'function') {
                        // Infer page title from link text
                        const title = anchor.querySelector('.kpi-title')?.textContent.trim() || 
                                      anchor.querySelector('.app-label')?.textContent.trim() || 
                                      anchor.textContent.trim() || 
                                      "Dashboard";
                        // Find dataset key if present
                        const dataset = anchor.getAttribute('data-dataset') || null;
                        
                        window.parent.openPage(href, title, dataset);
                    } else {
                        // Standalone fallback
                        window.location.href = href;
                    }
                }
            }
        });
    }
})();
