// sw.js - Service Worker for MZO Reports PWA
const CACHE_NAME = 'mzo-reports-cache-v30';

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

// Install Event: cache static shell assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Pre-caching application shell');
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

  // Bypass service worker for local API endpoints (e.g. structure updates) to ensure freshness
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => {
        // Fallback for API calls if offline
        return new Response(
          JSON.stringify({ error: 'Network unavailable. Offline cache cannot retrieve live API data.' }),
          { headers: { 'Content-Type': 'application/json' }, status: 503 }
        );
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
