// sw.js - Service Worker for MZO Reports PWA
// v37: withheld Updated-on uses live NSC TODAY (not stale meta id)
// v38: historical NSC filters network-first
// v39: pending load extension filters + network-first
// v40: drop office prefs UI; pending load extension ticker/modal
// v41: login scope on solar, JJM, meter utilization, WRIDD
// v42: WRIDD filter dropdowns show scoped office names
const CACHE_NAME = 'mzo-reports-cache-v50';

// Assets to precache during installation (avoid pinning data-hub — it changes with dataset keys)
const PRECACHE_ASSETS = [
  './',
  'index.html',
  'login.html',
  'offline.html',
  'loss.html',
  'wridd.html',
  'weekly.html',
  'manifest.json',
  'tailwind_dist.css',
  'auth.js',
  'home-button.js'
];

// Third-party CDN URLs to match for Cache-First strategy
const CDN_URLS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net'
];

function canCacheRequest(request) {
  try {
    const url = new URL(request.url);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function safePut(cache, request, response) {
  if (!canCacheRequest(request)) return Promise.resolve();
  return cache.put(request, response).catch((err) => {
    console.warn('[Service Worker] cache.put skipped:', request.url, err && err.message);
  });
}

function isNetworkFirstPath(pathname) {
  return (
    pathname === '/nsc.html' ||
    pathname.startsWith('/nsc/') ||
    pathname === '/withheld.html' ||
    pathname === '/historical_nsc.html' ||
    pathname === '/pending_load_extension.html' ||
    pathname === '/index.html' ||
    pathname === '/weekly.html' ||
    pathname === '/loss.html' ||
    pathname === '/disconnection.html' ||
    pathname === '/collection.html' ||
    pathname === '/pending_mc.html' ||
    pathname === '/remosd5000.html' ||
    pathname === '/meter_utilization.html' ||
    pathname === '/jjm.html' ||
    pathname === '/wridd.html' ||
    pathname === '/solar.html' ||
    pathname === '/rem/defaulters.html' ||
    pathname === '/admin_users.html' ||
    pathname === '/consumer/defective_meter.html' ||
    pathname === '/mzo_data_hub.js' ||
    pathname === '/mzo_presets_hub.js' ||
    pathname === '/mzo_docket_briefing.js' ||
    pathname === '/mzo_scope.js' ||
    pathname === '/sw.js' ||
    pathname.startsWith('/api/')
  );
}

// Install Event: cache static shell assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Pre-caching application shell v33');
        return cache.addAll(PRECACHE_ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate Event: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[Service Worker] Clearing old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event: intercept network requests
self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Ignore non-GET requests immediately
  if (request.method !== 'GET') {
    return;
  }

  // Ignore chrome-extension: and other non-http schemes (avoids Cache.put TypeError)
  if (!canCacheRequest(request)) {
    return;
  }

  const url = new URL(request.url);

  // Always network for API + NSC page/hub scripts (filters/data keys change often)
  if (isNetworkFirstPath(url.pathname)) {
    event.respondWith(
      fetch(request).catch(() => {
        if (request.mode === 'navigate') {
          return caches.match('offline.html');
        }
        if (url.pathname.startsWith('/api/')) {
          return new Response(
            JSON.stringify({ error: 'Network unavailable. Offline cache cannot retrieve live API data.' }),
            { headers: { 'Content-Type': 'application/json' }, status: 503 }
          );
        }
        return caches.match(request).then((cached) => cached || Response.error());
      })
    );
    return;
  }

  // Caching Strategy: Stale-While-Revalidate for local assets and HTML navigation
  // Cache-First for static external CDN resources (Libraries & Web Fonts)
  const isCDN = CDN_URLS.some(cdn => request.url.startsWith(cdn));

  if (isCDN) {
    // Cache-First Strategy
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200) {
            return networkResponse;
          }
          return caches.open(CACHE_NAME).then((cache) => {
            safePut(cache, request, networkResponse.clone());
            return networkResponse;
          });
        });
      })
    );
  } else {
    // Stale-While-Revalidate Strategy with Offline HTML fallback for navigation
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        const fetchPromise = fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              safePut(cache, request, responseToCache);
            });
          }
          return networkResponse;
        }).catch((err) => {
          console.log('[Service Worker] Fetch failed; returning cached version or fallback page', err);
          // If offline and request is a page navigation, return the offline fallback page
          if (request.mode === 'navigate') {
            return caches.match('offline.html');
          }
          throw err;
        });

        return cachedResponse || fetchPromise;
      })
    );
  }
});
