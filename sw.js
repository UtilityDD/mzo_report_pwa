// sw.js - Service Worker for MZO Reports PWA
// v37: withheld Updated-on uses live NSC TODAY (not stale meta id)
// v38: historical NSC filters network-first
// v39: pending load extension filters + network-first
// v40: drop office prefs UI; pending load extension ticker/modal
// v41: login scope on solar, JJM, meter utilization, WRIDD
// v42: WRIDD filter dropdowns show scoped office names
// v84: defective/NSC sheet-mirror retries Failed to fetch; skip duplicate chunks
// v85: home hub Often used favorites group
// v86: app update banner; reload stale NSC dump; drop install-app modal
// v87: Sync Data version-checks reports and downloads only if changed
// v88: homepage Sync must not hang on multi-MB Google sheet GETs
// v89: do not intercept Google Sheet fetches (CORS); keep cached copy if a check fails
// v90: Meter Utilization treats Div and Division as the same office
// v91: drop division HQ names from Meter Utilization CCC list
// v92: disconnection base OSD dates + KPI status does not shrink other KPIs
// v93: do not intercept Apps Script; retry Google echo HTML 404 on NSC publish
// v94: Bharat Net connections dashboard under NSC
// v95: Bharat Net loads via /api/bharatnet/dataset (Google pub CORS redirect)
// v96: Bharat Net opens without DataHub wait; CSV via /api only
// v97: Bharat Net paints from local CSV if the live API is empty
// v98: fix Bharat Net syntax error (CCC NAME key)
// v99: Bharat Net region/division charts with value labels
// v100: Bharat Net CSV from Google in the browser, not through Vercel
// v101: NSC Detailed Analysis drills to consumers; compact consumer modal on mobile
// v102: retired mzo-report-pwa host redirects to mzo-reports.vercel.app
// v103: old host shows install link; new origin uses gold MZO icon
// v104: retired host freezes with install link; login is blocked
// v105: stock dump can load from Supabase Storage; do not intercept supabase.co
// v106: stock upload guidance for authorised users
// v108: NSC upload retries, slimmer Withheld sheet, manual CSV fallback
// v109: stock signed upload path includes /storage/v1; home Uploads sheet list
// v110: admin Sheet links Yes/No for the home-bar button
// v111: versioned DataHub — download dumps only when remote version differs
// v116: desktop presentation zoom (mzo_present.js)
// v117: presentation zoom uses one scrollbar
// v118: disconnection consumer modal keeps a device-local follow-up timeline
// v119: NSC page uses presentation zoom (ignore side panels)
// v120: disconnection follow-up stores the signed-in user's name with the time
// v121: NSC counts each APPL_NO once (duplicate consumers in a division)
// v122: disconnection follow-ups save instantly and refresh comments from the sheet
// v123: admin lives in the Administration group, not the home-bar icon
// v124: disconnection page has a Follow-ups tab
// v125: KPI cards show a share of the total; Recent opens consumer follow-ups
// v145: Pending NSC follow-ups stay with the application number
// v146: only an admin can delete a follow-up
// v147: a saved follow-up appears before the sheet write
// v148: follow-up lists use the same tables as the other views
// v149: Pending NSC opens on the office hierarchy table
// v150: the Pending NSC consumer list is tighter, and Class fits its text
// v151: report frames clear the bottom back arrow
// v152: offline opens the saved page; the offline screen is only for a page never saved
// v153: offline shows a quiet saved-data note, not an error over the page
// v154: sheet links open as a full page with serial numbers and update dates
const CACHE_NAME = 'mzo-reports-cache-v154';

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
  'manifest-legacy.json',
  'mzo_pwa_icons.js',
  'icons/icon-192-v2.png',
  'icons/icon-512-v2.png',
  'tailwind_dist.css',
  'auth.js',
  'home-button.js',
  'mzo_present.js'
];

// Third-party CDN URLs to match for Cache-First strategy
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
  if (!key || !response || response.status !== 200) return Promise.resolve();
  return caches.open(CACHE_NAME).then((cache) => safePut(cache, key, response.clone()));
}

function isNetworkFirstPath(pathname) {
  return (
    pathname === '/nsc.html' ||
    pathname === '/login.html' ||
    pathname.startsWith('/nsc/') ||
    pathname === '/withheld.html' ||
    pathname === '/historical_nsc.html' ||
    pathname === '/pending_load_extension.html' ||
    pathname === '/index.html' ||
    pathname === '/sheet_links.html' ||
    pathname === '/weekly.html' ||
    pathname === '/loss.html' ||
    pathname === '/disconnection.html' ||
    pathname === '/collection.html' ||
    pathname === '/pending_mc.html' ||
    pathname === '/remosd5000.html' ||
    pathname === '/meter_utilization.html' ||
    pathname === '/jjm.html' ||
    pathname === '/wridd.html' ||
    pathname === '/bharatnet.html' ||
    pathname === '/solar.html' ||
    pathname === '/rem/defaulters.html' ||
    pathname === '/admin_users.html' ||
    pathname === '/consumer/defective_meter.html' ||
    pathname === '/lib/defective_meter_pipeline.js' ||
    pathname === '/lib/sheet_mirror_client.js' ||
    pathname === '/stock/upload.html' ||
    pathname === '/stock/script.js' ||
    pathname === '/stock.html' ||
    pathname === '/capex_all.html' ||
    pathname === '/mzo_data_hub.js' ||
    pathname === '/mzo_presets_hub.js' ||
    pathname === '/mzo_docket_briefing.js' ||
    pathname === '/mzo_scope.js' ||
    pathname === '/mzo_origin_redirect.js' ||
    pathname === '/mzo_pwa_icons.js' ||
    pathname === '/manifest.json' ||
    pathname === '/manifest-legacy.json' ||
    pathname === '/icons/icon-192-v2.png' ||
    pathname === '/icons/icon-512-v2.png' ||
    pathname === '/mzo_app_update.js' ||
    pathname === '/mzo_present.js' ||
    pathname === '/version.json' ||
    pathname === '/sw.js' ||
    pathname.startsWith('/api/')
  );
}

function skipPresentZoom(pathname) {
  const p = String(pathname || '');
  if (p === '/login.html' || p === '/offline.html') return true;
  if (p.startsWith('/power_map/') || p.startsWith('/sld/')) return true;
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
    }).then(() => self.clients.claim()).then(() => {
      return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'MZO_APP_UPDATED', cache: CACHE_NAME });
        });
      });
    })
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

  // Leave Google Sheet CSVs to the browser. Intercepting them (even to
  // pass through) can fail CORS and make homepage Sync report failures.
  if (isGoogleSheetRequest(url) || isSupabaseRequest(url)) {
    return;
  }

  // Always network for API + NSC page/hub scripts (filters/data keys change often)
  if (isNetworkFirstPath(url.pathname)) {
    event.respondWith(
      fetch(request).then((res) => {
        if (!url.pathname.startsWith('/api/')) writeAppCache(request, res.clone());
        return withPresentZoom(res, request, url);
      }).catch(() => {
        if (url.pathname.startsWith('/api/')) {
          return new Response(
            JSON.stringify({ error: 'Network unavailable. Offline cache cannot retrieve live API data.' }),
            { headers: { 'Content-Type': 'application/json' }, status: 503 }
          );
        }
        return readAppCache(request).then((cached) => {
          if (cached) return withPresentZoom(cached, request, url);
          if (request.mode === 'navigate') return caches.match('offline.html');
          return Response.error();
        });
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
      readAppCache(request).then((cachedResponse) => {
        const fetchPromise = fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) writeAppCache(request, networkResponse.clone());
          return withPresentZoom(networkResponse, request, url);
        }).catch((err) => {
          console.log('[Service Worker] Fetch failed; returning cached version or fallback page', err);
          if (request.mode === 'navigate') return caches.match('offline.html');
          throw err;
        });

        return cachedResponse
          ? withPresentZoom(cachedResponse, request, url)
          : fetchPromise;
      })
    );
  }
});
