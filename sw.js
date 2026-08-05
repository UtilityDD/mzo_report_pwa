// sw.js - Service Worker for MZO Reports PWA
// Bump CACHE_NAME whenever shell/data-fetch logic changes so clients drop stale assets.
const CACHE_NAME = 'mzo-reports-cache-v27';

// Assets to precache during installation (app shell only — never datasets)
const PRECACHE_ASSETS = [
  './',
  'index.html',
  'login.html',
  'offline.html',
  'manifest.json',
  'tailwind_dist.css',
  'auth.js',
  'home-button.js'
];

// Third-party CDN URLs — Cache-First
const CDN_URLS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net'
];

// Always hit network for these (IndexedDB holds datasets; SW must not freeze old hubs/pages)
const NETWORK_FIRST_PATHS = [
  '/mzo_data_hub.js',
  '/mzo_presets_hub.js',
  '/mzo_docket_briefing.js',
  '/sw.js',
  '/nsc.html',
  '/stock/',
  '/api/'
];

function isHttpUrl(url) {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function shouldNeverCache(url) {
  if (!isHttpUrl(url)) return true;
  if (url.pathname.startsWith('/api/')) return true;
  // Live data / published sheets — never pin in SW cache
  if (url.hostname.includes('docs.google.com')) return true;
  if (url.hostname.includes('spreadsheets.google.com')) return true;
  if (/\.csv($|\?)/i.test(url.pathname + url.search)) return true;
  return false;
}

function isNetworkFirst(url) {
  if (shouldNeverCache(url)) return true;
  return NETWORK_FIRST_PATHS.some(
    (p) => url.pathname === p || url.pathname.startsWith(p)
  );
}

function isCDN(urlString) {
  return CDN_URLS.some((cdn) => urlString.startsWith(cdn));
}

async function safeCachePut(request, response) {
  try {
    const url = new URL(request.url);
    if (shouldNeverCache(url)) return;
    if (!response || response.status !== 200) return;
    // Only cache basic/cors same-origin-ish responses
    if (response.type === 'opaque') return;
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response);
  } catch (err) {
    // Ignore unsupported schemes (chrome-extension:, etc.)
    console.warn('[Service Worker] cache.put skipped:', request.url, err && err.message);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Pre-caching application shell');
        return cache.addAll(PRECACHE_ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames.map((cache) => {
            if (cache !== CACHE_NAME) {
              console.log('[Service Worker] Clearing old cache:', cache);
              return caches.delete(cache);
            }
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }

  // Never intercept extension or non-http requests
  if (!isHttpUrl(url)) return;

  // API + live datasets: network only (no SW cache)
  if (shouldNeverCache(url) || isNetworkFirst(url)) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => networkResponse)
        .catch(() => {
          if (request.mode === 'navigate') {
            return caches.match('offline.html');
          }
          if (url.pathname.startsWith('/api/')) {
            return new Response(
              JSON.stringify({
                error: 'Network unavailable. Offline cache cannot retrieve live API data.'
              }),
              { headers: { 'Content-Type': 'application/json' }, status: 503 }
            );
          }
          return caches.match(request).then((cached) => {
            if (cached) return cached;
            throw new Error('Network unavailable');
          });
        })
    );
    return;
  }

  // Cache-First for CDNs
  if (isCDN(request.url)) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) return cachedResponse;
        return fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            safeCachePut(request, networkResponse.clone());
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // Stale-While-Revalidate for remaining static assets
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            safeCachePut(request, networkResponse.clone());
          }
          return networkResponse;
        })
        .catch((err) => {
          console.log('[Service Worker] Fetch failed; using cache/fallback', err);
          if (request.mode === 'navigate') {
            return caches.match('offline.html');
          }
          throw err;
        });

      return cachedResponse || fetchPromise;
    })
  );
});
