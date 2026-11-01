// sw.js — service worker for MZO Reports.
// Bump CACHE_NAME (and version.json "cache") on every release: activation clears older caches and
// tells open pages to show the update notice (mzo_app_update.js listens for MZO_APP_UPDATED).
//
// Strategies
//   - Google Sheets, Apps Script and Supabase requests are never intercepted (CORS, large bodies).
//   - Network first for /api/, the shell, report pages and shared scripts whose data keys change often
//     (NETWORK_FIRST); the last good copy is the offline fallback.
//   - Cache first for third-party CDNs (libraries, fonts).
//   - Stale-while-revalidate for every other same-origin asset.
//   - HTML responses get /mzo_present.js (desktop presentation zoom) injected after <head>.
const CACHE_NAME = 'mzo-reports-cache-v262';

// Precached on install (not the data hub: it changes with dataset keys)
const PRECACHE_ASSETS = [
  'app.html',
  'executive_briefing.html',
  'media_news.html',
  'theft_assessment.html',
  'login.html',
  'puja.html',
  'offline.html',
  'loss.html',
  'performance_index.html',
  'wridd.html',
  'weekly.html',
  'manifest.json',
  'manifest-legacy.json',
  'mzo_pwa_icons.js',
  'icons/icon-192-v2.png',
  'icons/icon-512-v2.png',
  'icons/diya-cropped.svg',
  'auth.js',
  'mzo_present.js'
];

// Third-party CDNs served cache-first
const CDN_URLS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net'
];

function isGoogleSheetRequest(url) {
  const host = String(url.hostname || '');
  return (
    host === 'docs.google.com' ||
    host === 'spreadsheets.google.com' ||
    host === 'script.google.com' ||
    /googleusercontent\.com$/i.test(host)
  );
}

function isSupabaseRequest(url) {
  return /\.supabase\.co$/i.test(String(url.hostname || ''));
}

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

function appShellKey(request) {
  try {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return null;
    return new Request(url.origin + url.pathname, { method: 'GET' });
  } catch (_) {
    return null;
  }
}

function readAppCache(request) {
  const key = appShellKey(request);
  if (!key) return Promise.resolve(undefined);
  return caches.open(CACHE_NAME).then((cache) => cache.match(key).then((hit) => hit || cache.match(request)));
}

function writeAppCache(request, response) {
  const key = appShellKey(request);
  if (!key || !response || response.status !== 200 || response.redirected) return Promise.resolve();
  try {
    if (new URL(response.url).pathname !== new URL(request.url).pathname) return Promise.resolve();
  } catch (_) {
    return Promise.resolve();
  }
  return caches.open(CACHE_NAME).then((cache) => safePut(cache, key, response.clone()));
}

const NETWORK_FIRST = new Set([
  '/dd/upcomingDD.html', '/dd/dd_visit.html', '/puja.html', '/nsc.html', '/nsc_simple.html',
  '/nsc_pipeline.html', '/nsc_classic.html', '/lib/nsc_rows.js', '/login.html', '/withheld.html',
  '/historical_nsc.html', '/pending_load_extension.html', '/app.html', '/assistant.html',
  '/lib/assistant_catalog.js', '/sheet_links.html', '/sheet_open.html', '/weekly.html', '/loss.html',
  '/performance_index.html', '/theft_assessment.html', '/media_news.html', '/disconnection.html',
  '/collection.html', '/pending_mc.html', '/remosd5000.html', '/feeder_outage.html',
  '/meter_utilization.html', '/jjm.html', '/wridd.html', '/bharatnet.html', '/icds.html', '/pmsgy.html',
  '/solar.html', '/rem/defaulters.html', '/admin_users.html', '/admin.html',
  '/consumer/defective_meter.html', '/lib/defective_meter_pipeline.js', '/lib/sheet_mirror_client.js',
  '/stock/upload.html', '/stock/index.html', '/stock/script.js', '/stock/allotment.js',
  '/stock/allotment_view.js', '/stock/style.css', '/capex_all.html', '/mzo_data_hub.js', '/mzo_theme.js',
  '/mzo_theme.css', '/mzo_ui.js', '/mzo_presets_hub.js', '/mzo_scope.js',
  '/mzo_origin_redirect.js', '/mzo_pwa_icons.js', '/manifest.json', '/manifest-legacy.json',
  '/icons/icon-192-v2.png', '/icons/icon-512-v2.png', '/mzo_app_update.js', '/mzo_present.js',
  '/version.json', '/sw.js'
]);
const NETWORK_FIRST_PREFIXES = ['/api/', '/nsc/'];

function isNetworkFirstPath(pathname) {
  return NETWORK_FIRST.has(pathname) || NETWORK_FIRST_PREFIXES.some((p) => pathname.startsWith(p));
}

function skipPresentZoom(pathname) {
  const p = String(pathname || '');
  if (p === '/login.html' || p === '/offline.html' || p === '/app.html') return true;
  if (p.startsWith('/power_map/')) return true;
  if (p === '/accident/map.html') return true;
  return false;
}

function isAppHtmlRequest(request, url) {
  if (url.origin !== self.location.origin) return false;
  const path = url.pathname || '';
  if (path.startsWith('/api/')) return false;
  if (/\.(js|mjs|css|json|png|jpe?g|gif|webp|svg|ico|csv|map|woff2?|ttf|txt|xml)$/i.test(path)) return false;
  if (request.mode === 'navigate') return true;
  if (path === '/' || /\.html$/i.test(path)) return true;
  const accept = request.headers.get('accept') || '';
  return accept.indexOf('text/html') !== -1;
}

const PRESENT_SNIPPET = '<script src="/mzo_present.js" defer></' + 'script>';

function injectPresentScript(response) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  let decided = false;
  const stream = new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      if (!decided) {
        const match = pending.match(/<head[^>]*>/i);
        if (!match) {
          if (pending.length > 16384) decided = true;
          else return;
        } else {
          const headEnd = pending.indexOf(match[0]) + match[0].length;
          if (pending.length < headEnd + 1200) return;
          const windowText = pending.slice(headEnd, headEnd + 1200);
          if (windowText.indexOf('mzo_present.js') === -1) {
            pending = pending.slice(0, headEnd) + PRESENT_SNIPPET + pending.slice(headEnd);
          }
          decided = true;
        }
      }
      if (pending) {
        controller.enqueue(encoder.encode(pending));
        pending = '';
      }
    },
    flush(controller) {
      pending += decoder.decode();
      if (!decided) {
        const match = pending.match(/<head[^>]*>/i);
        if (match && pending.indexOf('mzo_present.js') === -1) {
          const headEnd = pending.indexOf(match[0]) + match[0].length;
          pending = pending.slice(0, headEnd) + PRESENT_SNIPPET + pending.slice(headEnd);
        }
      }
      if (pending) controller.enqueue(encoder.encode(pending));
    }
  });
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(response.body.pipeThrough(stream), {
    status: response.status,
    statusText: response.statusText,
    headers: headers
  });
}

function withPresentZoom(response, request, url) {
  try {
    if (!response || response.status !== 200 || !response.body) return response;
    if (!isAppHtmlRequest(request, url)) return response;
    let finalPath = '';
    try { finalPath = new URL(response.url).pathname; } catch (e) {}
    if (skipPresentZoom(url.pathname) || skipPresentZoom(finalPath)) return response;
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (type && type.indexOf('text/html') === -1) return response;
    return injectPresentScript(response);
  } catch (e) {
    return response;
  }
}

// Install: precache the shell. Each asset is cached on its own, so one missing file
// cannot block the whole install (cache.addAll fails on any 404).
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(PRECACHE_ASSETS.map((asset) => cache.add(asset).catch((err) => {
        console.warn('[Service Worker] precache skipped:', asset, err && err.message);
      }))))
      .then(() => self.skipWaiting())
  );
});

// Activate Event: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => (cache !== CACHE_NAME ? caches.delete(cache) : null))
      );
    }).then(() => self.clients.claim()).then(() => {
      return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'MZO_APP_UPDATED', cache: CACHE_NAME });
        });
      });
    })
  );
});

function offlinePage() {
  return caches.match('offline.html').then((page) => page || Response.error());
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Only GET over http(s); chrome-extension: and friends would make Cache.put throw.
  if (request.method !== 'GET' || !canCacheRequest(request)) return;

  const url = new URL(request.url);
  const isCDN = CDN_URLS.some((cdn) => request.url.startsWith(cdn));

  // Leave Google Sheets, Apps Script, Supabase and other origins to the browser. Intercepting them
  // (even to pass through) can fail CORS and make the home Sync report failures.
  if (isGoogleSheetRequest(url) || isSupabaseRequest(url) || (url.origin !== self.location.origin && !isCDN)) return;

  const isApi = url.pathname.startsWith('/api/');

  // Network first (always on localhost, so local edits show at once)
  if (self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1' || isNetworkFirstPath(url.pathname)) {
    event.respondWith(
      fetch(request).then((res) => {
        if (!isApi) writeAppCache(request, res.clone());
        return withPresentZoom(res, request, url);
      }).catch(() => {
        if (isApi) {
          return new Response(
            JSON.stringify({ error: 'Network unavailable. Offline cache cannot retrieve live API data.' }),
            { headers: { 'Content-Type': 'application/json' }, status: 503 }
          );
        }
        return readAppCache(request).then((cached) => {
          if (cached) return withPresentZoom(cached, request, url);
          return request.mode === 'navigate' ? offlinePage() : Response.error();
        });
      })
    );
    return;
  }

  // Cache first for CDN libraries and fonts
  if (isCDN) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((res) => {
        if (res && res.status === 200) caches.open(CACHE_NAME).then((cache) => safePut(cache, request, res.clone()));
        return res;
      }))
    );
    return;
  }

  // Stale-while-revalidate, with the offline page for navigations that were never saved
  event.respondWith(
    readAppCache(request).then((cached) => {
      const refresh = fetch(request).then((res) => {
        if (res && res.status === 200) writeAppCache(request, res.clone());
        return withPresentZoom(res, request, url);
      });
      if (cached) {
        refresh.catch(() => {}); // background refresh; the cached copy already answered
        return withPresentZoom(cached, request, url);
      }
      return refresh.catch((err) => {
        if (request.mode === 'navigate') return offlinePage();
        throw err;
      });
    })
  );
});
