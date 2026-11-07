const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const OFFICES = require('./lib/offices.js');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

/**
 * Outbound fetch helper that respects HTTP_PROXY / HTTPS_PROXY (e.g. on corporate/office networks).
 * When running in environments without a proxy (production on Vercel, cloud VM), or for bypassed hosts
 * (localhost, NO_PROXY), delegates directly to globalThis.fetch().
 */
// Outbound requests without their own signal give up after this long (options.timeout overrides it), so
// a stalled Supabase or Apps Script cannot hold a request for undici's 5-minute default.
const OUTBOUND_TIMEOUT_MS = Number(process.env.MZO_OUTBOUND_TIMEOUT_MS) > 0 ? Number(process.env.MZO_OUTBOUND_TIMEOUT_MS) : 30 * 1000;

/** fetch() with a timeout: the caller's signal if it passed one, else options.timeout (default 30 s). */
function fetchWithTimeout_(urlStr, options) {
    const { timeout, ...init } = options || {};
    if (!init.signal) init.signal = AbortSignal.timeout(timeout || OUTBOUND_TIMEOUT_MS);
    return globalThis.fetch(urlStr, init);
}

function proxyFetch_(urlStr, options = {}, redirectCount = 0) {
    if (redirectCount > 5) return Promise.reject(new Error('Too many redirects'));

    let target;
    try {
        target = new URL(urlStr);
    } catch (_) {
        return fetchWithTimeout_(urlStr, options);
    }

    const proxyUrlStr = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    const noProxyList = (process.env.NO_PROXY || process.env.no_proxy || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

    const isBypassed = target.hostname === 'localhost' ||
        target.hostname === '127.0.0.1' ||
        noProxyList.some((np) => target.hostname.toLowerCase() === np || target.hostname.toLowerCase().endsWith('.' + np));

    if (!proxyUrlStr || isBypassed) {
        return fetchWithTimeout_(urlStr, options);
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        let sReq = null;
        let connectReq = null;

        const cleanup = () => {
            settled = true;
            if (timer) clearTimeout(timer);
            if (options.signal) options.signal.removeEventListener('abort', onAbort);
        };

        const done = (fn, arg) => {
            if (!settled) {
                cleanup();
                fn(arg);
            }
        };

        const onAbort = () => {
            if (connectReq) try { connectReq.destroy(); } catch (_) { }
            if (sReq) try { sReq.destroy(); } catch (_) { }
            done(reject, options.signal?.reason || new Error('The operation was aborted.'));
        };

        if (options.signal?.aborted) return onAbort();
        if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });

        const timeoutMs = options.timeout || OUTBOUND_TIMEOUT_MS;
        timer = setTimeout(() => {
            if (connectReq) try { connectReq.destroy(); } catch (_) { }
            if (sReq) try { sReq.destroy(); } catch (_) { }
            done(reject, new Error(`Request to ${target.hostname} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        let pUrl;
        try {
            pUrl = new URL(proxyUrlStr);
        } catch (_) {
            return fetchWithTimeout_(urlStr, options).then(resolve, reject);
        }

        const handleResponse = (sRes) => {
            const status = sRes.statusCode || 200;
            if ([301, 302, 303, 307, 308].includes(status) && options.redirect !== 'manual' && sRes.headers.location) {
                cleanup();
                const nextUrl = new URL(sRes.headers.location, target).toString();
                const nextOptions = { ...options };
                if (status === 303 || ((status === 301 || status === 302) && options.method !== 'HEAD')) {
                    nextOptions.method = 'GET';
                    delete nextOptions.body;
                }
                return proxyFetch_(nextUrl, nextOptions, redirectCount + 1).then(resolve, reject);
            }

            const chunks = [];
            sRes.on('data', (c) => chunks.push(c));
            sRes.on('end', () => {
                const bodyBuf = Buffer.concat(chunks);
                const bodyText = bodyBuf.toString('utf8');
                done(resolve, {
                    ok: status >= 200 && status < 300,
                    status,
                    statusText: sRes.statusMessage || '',
                    headers: {
                        get(name) {
                            return sRes.headers[String(name).toLowerCase()] || null;
                        }
                    },
                    text: async () => bodyText,
                    json: async () => JSON.parse(bodyText)
                });
            });
        };

        const bodyData = options.body
            ? (typeof options.body === 'string' ? Buffer.from(options.body, 'utf8') : options.body)
            : null;

        if (target.protocol === 'http:') {
            const reqHeaders = { Host: target.hostname, ...(options.headers || {}) };
            if (bodyData && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) {
                reqHeaders['Content-Length'] = bodyData.length;
            }
            sReq = http.request({
                host: pUrl.hostname,
                port: pUrl.port || 80,
                path: urlStr,
                method: options.method || 'GET',
                headers: reqHeaders
            }, handleResponse);

            sReq.on('error', (err) => done(reject, err));
            if (bodyData) sReq.write(bodyData);
            sReq.end();
            return;
        }

        connectReq = http.request({
            host: pUrl.hostname,
            port: pUrl.port || 80,
            method: 'CONNECT',
            path: `${target.hostname}:${target.port || 443}`
        });

        connectReq.on('connect', (cRes, socket) => {
            if (cRes.statusCode !== 200) {
                socket.destroy();
                return done(reject, new Error(`Proxy CONNECT error: ${cRes.statusCode}`));
            }

            const reqHeaders = { Host: target.hostname, ...(options.headers || {}) };
            if (bodyData && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) {
                reqHeaders['Content-Length'] = bodyData.length;
            }

            sReq = https.request({
                host: target.hostname,
                port: target.port || 443,
                path: target.pathname + target.search,
                method: options.method || 'GET',
                headers: reqHeaders,
                socket,
                agent: false
            }, handleResponse);

            sReq.on('error', (err) => done(reject, err));
            if (bodyData) sReq.write(bodyData);
            sReq.end();
        });

        connectReq.on('error', (err) => {
            try {
                const args = ['-s', '-i', '-X', options.method || 'GET'];
                if (options.headers) {
                    for (const [k, v] of Object.entries(options.headers)) {
                        args.push('-H', `${k}: ${v}`);
                    }
                }
                if (bodyData) {
                    args.push('--data-binary', String(options.body));
                }
                args.push(urlStr);
                const cr = spawnSync('curl.exe', args, { timeout: timeoutMs });
                if (cr.status === 0 && cr.stdout && cr.stdout.length > 0) {
                    const raw = cr.stdout.toString('utf8');
                    const headerEnd = raw.indexOf('\r\n\r\n');
                    const bodyText = headerEnd >= 0 ? raw.slice(headerEnd + 4) : raw;
                    const statusMatch = raw.match(/HTTP\/[0-9.]+\s+(\d+)/);
                    const status = statusMatch ? parseInt(statusMatch[1], 10) : 200;
                    return done(resolve, {
                        ok: status >= 200 && status < 300,
                        status,
                        statusText: '',
                        headers: { get: () => null },
                        text: async () => bodyText,
                        json: async () => JSON.parse(bodyText)
                    });
                }
            } catch (_) { }
            done(reject, err);
        });

        connectReq.end();
    });
}

const fetch = proxyFetch_;

const app = express();
// Express 4 ignores the promise an async handler returns: a rejection would go unhandled (and end the
// process) and the request would hang. Every handler registered on `app` passes its rejection to next(),
// which the JSON error handler at the end answers. Sub-apps, routers' own handlers and error handlers
// (four arguments) are left as they are.
function forwardRejections_(fn) {
    if (typeof fn !== 'function' || fn.length >= 4 || fn.handle || fn.stack) return fn;
    return function asyncSafe(req, res, next) {
        const out = fn.call(this, req, res, next);
        if (out && typeof out.then === 'function') out.then(null, (err) => next(err || new Error('Request failed')));
        return out;
    };
}
['use', 'get', 'post', 'put', 'patch', 'delete', 'all'].forEach((method) => {
    const original = app[method].bind(app);
    app[method] = (...args) => {
        if (method === 'get' && args.length === 1) return original(...args); // app.get(setting)
        return original(...args.map((a) => (Array.isArray(a) ? a.map(forwardRejections_) : forwardRejections_(a))));
    };
});
const PORT = process.env.PORT || 3000;
// Files the app writes and reads at run time (uploaded datasets, their meta, local caches).
// MZO_FILES_DIR on the VM (/opt/mzo/data/files, set in mzo-reports.service) is outside the release
// folder, so a deploy never replaces it; locally it defaults to the git-ignored data/ folder.
// Repo lookups that ship with the code (data/costcenter.json, data/structure.csv) are not here.
const DATA_DIR = path.resolve(process.env.MZO_FILES_DIR || path.join(__dirname, 'data'));

/** Write a file in DATA_DIR atomically (temp file in the same folder, then rename), readable by the app user only. */
function writeDataFile_(name, data) {
    const file = path.join(DATA_DIR, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(tmp, data, { mode: 0o600 });
        fs.renameSync(tmp, file);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
        throw err;
    }
    return file;
}

// Body parsers (limits raised for NSC/stock publish payloads)
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Cross-Origin-Opener-Policy so popups (Google Sign-In) communicate cleanly with opener
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    next();
});

// Server-side files are never served, locally or from the Vercel function.
const PRIVATE_PATH = /^\/(server\.js|package(-lock)?\.json|vercel\.json|node_modules\/|scripts\/|apps-script\/|vm\/|\.github\/|lib\/(stock_(pipeline|material_category)|mirror|local_admins|users_store|google_auth|report_modules|sources_info|sources_live|data_quality|static_cache|org_hierarchy|csv|safety_parser|xlsx_lite)\.js|lib\/briefing_cccs\.json$|data\/(?!costcenter\.json$))|\.(md|mdc|gs|sql|py)$|\/\./i;
const SERVER_LIB_PATH = /^\/lib\/(editor|assistant|quality)(\/|$)/i; // server code: the data editor (docs/data-editor.md), Ask's providers (docs/assistant.md), the audit findings (docs/data-quality.md)
/** True for a path that must not be served: checked on the decoded, normalised path, as the static server sees it. */
function isPrivatePath_(rawPath) {
    let p;
    try { p = decodeURIComponent(String(rawPath || '')); } catch (_) { return true; }
    if (/[\0\\]/.test(p)) return true;
    p = path.posix.normalize(p);
    return PRIVATE_PATH.test(p) || SERVER_LIB_PATH.test(p);
}
app.use((req, res, next) => (isPrivatePath_(req.path) ? res.status(404).end() : next()));
// API writes come from this app's own pages: the Origin (or, without one, the Referer) must be this host.
// The CRM upload scripts send a key or token header instead (SYNC_UPLOAD_ROUTES, below).
function sameOriginRequest_(req) {
    const host = String(req.headers.host || '').toLowerCase();
    const from = req.headers.origin || req.headers.referer;
    if (!host || !from || from === 'null') return false;
    try { return new URL(from).host.toLowerCase() === host; } catch (_) { return false; }
}
// The Safety Inspection bookmarklet runs on the safety app's own site and posts the report here with a
// short-lived upload token (never the session): only from these origins, only to this route, and without
// cookies (no Access-Control-Allow-Credentials). SAFETY_UPLOAD_ORIGINS (comma-separated) replaces the list.
const SAFETY_UPLOAD_PATH = '/api/safety/upload';
const SAFETY_UPLOAD_ORIGINS = new Set(
    String(process.env.SAFETY_UPLOAD_ORIGINS || 'https://safetyinsp.wbsedcl.in,http://safetyinsp.wbsedcl.in')
        .split(',').map((o) => o.trim().replace(/\/+$/, '').toLowerCase()).filter((o) => /^https?:\/\/[^/]+$/.test(o))
);
const isSafetyUploadPath_ = (p) => String(p || '').toLowerCase().replace(/\/+$/, '') === SAFETY_UPLOAD_PATH;
const safetyUploadOrigin_ = (req) => {
    const o = String(req.headers.origin || '').toLowerCase();
    return o && SAFETY_UPLOAD_ORIGINS.has(o) ? o : '';
};
app.use((req, res, next) => {
    if (!isSafetyUploadPath_(req.path)) return next();
    const origin = safetyUploadOrigin_(req);
    res.setHeader('Vary', 'Origin');
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization');
        res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end(); // the preflight carries no credentials
    return next();
});
app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (!/^\/api(\/|$)/i.test(req.path)) return next();
    if (sameOriginRequest_(req)) return next();
    const tokenHeader = req.headers['x-sync-key'] || /^Bearer\s/i.test(String(req.headers.authorization || ''));
    if (req.method === 'POST' && SYNC_UPLOAD_ROUTES[req.path] && tokenHeader) return next();
    // The bookmarklet: an upload token (not a session) from an allowed origin; the route checks the token.
    if (req.method === 'POST' && isSafetyUploadPath_(req.path) && safetyUploadOrigin_(req) && scopedTokenFromHeader_(req)) return next();
    return res.status(403).json({ status: 'error', message: 'This request must come from the app.' });
});
// Old URLs (vercel.json has the same redirects): the retired phone home page, the NSC drafts and an extension-less report.
app.get(['/', '/index.html'], (req, res) => res.redirect(302, '/app.html'));
// The three NSC drafts became the single Pending NSC page.
app.get(['/nsc_simple.html', '/nsc_pipeline.html', '/nsc_classic.html'], (req, res) => {
    const i = req.originalUrl.indexOf('?');
    res.redirect(302, '/nsc.html' + (i === -1 ? '' : req.originalUrl.slice(i)));
});
app.get('/performance_index', (req, res) => res.redirect(308, '/performance_index.html'));
// VM user store: a report page outside the signed-in user's modules is refused (docs/users.md).
app.use((req, res, next) => reportPageGate_(req, res, next));
// Static files are public, as on Vercel where the CDN serves them before this app; pages gate themselves with auth.js.
// Text files go out compressed (cached per file version); ?v= assets are immutable (lib/static_cache.js).
const staticCache = require('./lib/static_cache').create({ root: __dirname });
app.use(staticCache.middleware);
app.use(express.static(__dirname, { cacheControl: false, setHeaders: staticCache.setHeaders }));

// Session cookies are signed with JWT_SECRET; the fallback is for local development only.
const JWT_SECRET = process.env.JWT_SECRET || 'mzo-portal-super-secret-key-123456';
if (!process.env.JWT_SECRET && process.env.VERCEL) {
    console.warn('[Auth] JWT_SECRET is not set: sessions are signed with the development fallback. Set JWT_SECRET in the Vercel project.');
}
// VM-only admin accounts from MZO_LOCAL_ADMINS (set only in the VM's /etc/mzo/app.env). Unset: inactive.
const localAdmins = require('./lib/local_admins').create({ secret: JWT_SECRET });
// VM user store (MZO_USER_STORE=pocketbase, the VM only): accounts, sign-in and activity in PocketBase
// instead of Supabase portal_users / activity_logs (docs/users.md). Unset (Vercel, local): inactive.
const userStore = require('./lib/users_store').create({ secret: JWT_SECRET, localAdmins, appRoot: __dirname });
if (userStore.on) app.use(userStore.context);
const POWER_MAP_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vT8hYE6YBbfVQDJhgB3cIWqrrGrjMQAQ22mcmCJTOa995gCH-xBAfsAPpBvNYS1KlYIFMRHM59iGB7K/pub?output=csv';
// Distinct table names (do not use generic "substations" — may clash with other projects/tables)
const POWER_MAP_TABLE = 'mzo_power_substations';
const POWER_MAP_CORRECTIONS_TABLE = 'mzo_power_corrections';
// CSV built from the table (mirror mode loads CACHE_POWER_MAP from here).
const POWER_MAP_DATA_URL = '/api/power-map/data';

/** The updated_at that `?select=updated_at&order=updated_at.desc&limit=1` returns for these rows ('' if none; Postgres sorts nulls first). */
function powerMapLatestUpdatedAt_(rows) {
    if (!Array.isArray(rows) || !rows.length || rows.some((r) => !r || r.updated_at == null)) return '';
    const later = (a, b) => {
        const d = Date.parse(b) - Date.parse(a);
        return d > 0 || (d === 0 && b > a) ? b : a;
    };
    return rows.map((r) => String(r.updated_at)).reduce(later).trim();
}
// Portal login + activity logs live in mzo_insight (not Google Sheet)
const PORTAL_USERS_SCHEMA = 'mzo_insight';
const PORTAL_USERS_TABLE = 'portal_users';
const ACTIVITY_LOGS_TABLE = 'activity_logs';
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const LOGS_FILE = path.join(DATA_DIR, 'activity_log.json');

function bodyEtag_(body) {
    const hex = crypto.createHash('sha1').update(String(body == null ? '' : body), 'utf8').digest('hex').slice(0, 16);
    return `"${hex}"`;
}

function nscReportDateLabel_(meta) {
    if (!meta) return '';
    return String(meta.reportDate || (meta.stats && meta.stats.today) || '').trim();
}

function snapshotVersion_(meta) {
    if (!meta) return '';
    const today = nscReportDateLabel_(meta);
    const rows = meta.publishedRows != null ? String(meta.publishedRows) : '';
    const at = String(meta.uploadedAt || '').trim();
    if (meta.supabaseUploadId != null && String(meta.supabaseUploadId).trim() !== '') {
        return `${meta.supabaseUploadId}|${today}|${rows}|${at}`;
    }
    return `${today}|${at}|${rows}`;
}

function snapshotWithheldVersion_(meta) {
    if (!meta) return '';
    const base = snapshotVersion_(meta);
    const withheldRows = meta.withheldRows != null ? meta.withheldRows : (meta.stats && meta.stats.withheldRows);
    return `${base}|w${withheldRows ?? ''}|t${nscReportDateLabel_(meta)}`;
}

function ifNoneMatchHits_(req, etag) {
    const inm = req.headers && req.headers['if-none-match'];
    if (!inm || !etag) return false;
    const want = String(etag).trim();
    return String(inm).split(',').some((part) => {
        const p = part.trim().replace(/^W\//i, '').trim();
        return p === '*' || p === want;
    });
}

/** Auth-gated dumps: browser revalidate + 304. Do not public-CDN-cache (would skip login). */
function sendDatasetCsv_(req, res, csv, options) {
    const opts = options || {};
    const body = csv == null ? '' : String(csv);
    const etag = opts.etag || bodyEtag_(body);
    if (opts.headers) {
        Object.keys(opts.headers).forEach((k) => {
            if (opts.headers[k] != null && opts.headers[k] !== '') {
                res.setHeader(k, String(opts.headers[k]));
            }
        });
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    if (ifNoneMatchHits_(req, etag)) {
        return res.status(304).end();
    }
    return res.status(200).send(body);
}

function parseCookies(cookieHeader) {
    const list = {};
    String(cookieHeader || '').split(';').forEach((cookie) => {
        const at = cookie.indexOf('=');
        if (at < 0) return;
        const raw = cookie.slice(at + 1).trim();
        try {
            list[cookie.slice(0, at).trim()] = decodeURIComponent(raw);
        } catch (_) {
            list[cookie.slice(0, at).trim()] = raw; // malformed %-escape from another app on the host
        }
    });
    return list;
}

async function fetchSheet(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

/** One CSV line → fields (quoted fields, "" escapes). Fields are not trimmed. */
function parseCsvLine_(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') {
                    cur += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                cur += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            out.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    out.push(cur);
    return out;
}


let globalCachedUsers = null;
let globalCachedLogs = null;
let usersCacheLoadedAt = 0;
const USERS_CACHE_TTL_MS = 2 * 60 * 1000; // short TTL for admin/list reads

// Supabase: Power Map stays on the old project. Insight (login/stock/logs)
// switches only when INSIGHT_SUPABASE_URL is set or local insightLive=true.
let SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
let SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

// Same project anon key already shipped in client pages.
const SUPABASE_FALLBACK_URL = 'https://unsmtschmcvftfqwabaq.supabase.co';
const SUPABASE_FALLBACK_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVuc210c2NobWN2ZnRmcXdhYmFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTM1NzA1MTYsImV4cCI6MjA2OTE0NjUxNn0.X3_q0FyEjam4ct03sjiqINz0_Hfu0AlWgRcymA3us9o';

let fileConfig = {};
const supabaseConfigPath = path.join(DATA_DIR, 'supabase_config.json');
if (fs.existsSync(supabaseConfigPath)) {
    try {
        fileConfig = JSON.parse(fs.readFileSync(supabaseConfigPath, 'utf8')) || {};
        if (fileConfig.supabaseUrl) SUPABASE_URL = fileConfig.supabaseUrl;
        if (fileConfig.supabaseKey) SUPABASE_KEY = fileConfig.supabaseKey;
        console.log('[Supabase] Loaded credentials from data/supabase_config.json');
    } catch (e) {
        console.error('[Supabase] Failed to parse data/supabase_config.json:', e.message);
    }
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
    SUPABASE_URL = SUPABASE_URL || SUPABASE_FALLBACK_URL;
    SUPABASE_KEY = SUPABASE_KEY || SUPABASE_FALLBACK_ANON_KEY;
    console.log('[Supabase] Using built-in anon fallback credentials for Power Map API');
} else {
    console.log('[Supabase] Credentials ready for host:', (() => {
        try { return new URL(SUPABASE_URL).host; } catch (_) { return 'invalid-url'; }
    })());
}

let POWERMAP_URL = process.env.POWERMAP_SUPABASE_URL || fileConfig.powermapUrl || SUPABASE_URL || SUPABASE_FALLBACK_URL;
let POWERMAP_KEY = process.env.POWERMAP_SUPABASE_KEY || fileConfig.powermapKey || SUPABASE_KEY || SUPABASE_FALLBACK_ANON_KEY;

const NEW_INSIGHT_URL = String(
    process.env.INSIGHT_SUPABASE_URL || fileConfig.insightUrl || ''
).trim();
const NEW_INSIGHT_KEY = String(
    process.env.INSIGHT_SUPABASE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    fileConfig.insightKey ||
    fileConfig.insightServiceKey ||
    ''
).trim();

const insightLiveFlag = String(
    process.env.INSIGHT_LIVE || (fileConfig.insightLive ? '1' : '')
).trim().toLowerCase();
const insightLive = insightLiveFlag === '1' || insightLiveFlag === 'true' || insightLiveFlag === 'yes';

let INSIGHT_URL = insightLive && NEW_INSIGHT_URL ? NEW_INSIGHT_URL : SUPABASE_URL;
let INSIGHT_KEY = insightLive && NEW_INSIGHT_KEY ? NEW_INSIGHT_KEY : SUPABASE_KEY;

const stockStorageFlag = String(
    process.env.STOCK_USE_STORAGE || (fileConfig.stockUseStorage ? '1' : '')
).trim().toLowerCase();
const STOCK_USE_STORAGE =
    stockStorageFlag === '1' || stockStorageFlag === 'true' || stockStorageFlag === 'yes';
const STOCK_STORAGE_BUCKET = process.env.STOCK_STORAGE_BUCKET || fileConfig.stockBucket || 'stock';
const STOCK_STORAGE_OBJECT = process.env.STOCK_STORAGE_OBJECT || fileConfig.stockObject || 'snapshot.csv';

function stockStorageOrigin_() {
    return !!(STOCK_USE_STORAGE && NEW_INSIGHT_URL && NEW_INSIGHT_KEY);
}

function stockProjectCfg_() {
    if (stockStorageOrigin_()) return { url: NEW_INSIGHT_URL, key: NEW_INSIGHT_KEY };
    return { url: INSIGHT_URL, key: INSIGHT_KEY };
}

console.log(
    '[Supabase] Insight host:',
    (() => { try { return new URL(INSIGHT_URL).host; } catch (_) { return 'invalid-url'; } })(),
    insightLive ? '(new project live for login)' : '(login still old project)'
);
console.log('[Supabase] Stock dump origin:', stockStorageOrigin_() ? 'supabase storage' : 'google sheet');

function isPowerMapPath_(apiPath) {
    const p = String(apiPath || '');
    return p.startsWith(POWER_MAP_TABLE) || p.startsWith(POWER_MAP_CORRECTIONS_TABLE);
}

function isStockDumpPath_(apiPath) {
    const p = String(apiPath || '');
    return p.startsWith('stock_upload_meta') || p.startsWith('stock_snapshot');
}

function supabaseCfgForPath_(apiPath) {
    if (isPowerMapPath_(apiPath)) return { url: POWERMAP_URL, key: POWERMAP_KEY };
    if (stockStorageOrigin_() && isStockDumpPath_(apiPath)) return stockProjectCfg_();
    return { url: INSIGHT_URL, key: INSIGHT_KEY };
}

function stockPublicCsvUrl_(version) {
    const cfg = stockProjectCfg_();
    const base = `${String(cfg.url || '').replace(/\/$/, '')}/storage/v1/object/public/${STOCK_STORAGE_BUCKET}/${STOCK_STORAGE_OBJECT}`;
    const v = String(version || '').trim();
    return v ? `${base}?v=${encodeURIComponent(v)}` : base;
}

async function createStockSignedUpload_() {
    const cfg = stockProjectCfg_();
    const root = String(cfg.url || '').replace(/\/$/, '');
    const objectPath = `${STOCK_STORAGE_BUCKET}/${STOCK_STORAGE_OBJECT}`;
    const res = await fetch(`${root}/storage/v1/object/upload/sign/${objectPath}`, {
        method: 'POST',
        headers: {
            apikey: cfg.key,
            Authorization: `Bearer ${cfg.key}`,
            'Content-Type': 'application/json',
            'x-upsert': 'true'
        },
        body: JSON.stringify({ expiresIn: 600, upsert: true })
    });
    const text = await res.text();
    let parsed = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch (_) { parsed = {}; }
    if (!res.ok) {
        throw new Error(`Stock signed upload HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const token = parsed.token || '';
    let signedUrl = parsed.signedUrl || parsed.url || '';
    if (signedUrl && !/^https?:\/\//i.test(signedUrl)) {
        if (!signedUrl.startsWith('/')) signedUrl = '/' + signedUrl;
        // Supabase returns /object/upload/sign/... — the host alone 404s.
        signedUrl = signedUrl.startsWith('/storage/')
            ? root + signedUrl
            : root + '/storage/v1' + signedUrl;
    }
    if (!signedUrl && token) {
        signedUrl = `${root}/storage/v1/object/upload/sign/${objectPath}?token=${encodeURIComponent(token)}`;
    }
    if (!signedUrl) throw new Error('Supabase did not return a stock upload URL.');
    return { signedUrl, token, path: parsed.path || objectPath };
}

async function putStockCsvToStorage_(csv) {
    const body = String(csv || '');
    if (!body.trim()) throw new Error('Empty stock CSV.');
    const cfg = { url: NEW_INSIGHT_URL, key: NEW_INSIGHT_KEY };
    if (!cfg.url || !cfg.key) throw new Error('Insight Supabase is not configured for stock Storage.');
    const root = String(cfg.url).replace(/\/$/, '');
    const res = await fetch(`${root}/storage/v1/object/${STOCK_STORAGE_BUCKET}/${STOCK_STORAGE_OBJECT}`, {
        method: 'POST',
        headers: {
            apikey: cfg.key,
            Authorization: `Bearer ${cfg.key}`,
            'Content-Type': 'text/csv',
            'x-upsert': 'true'
        },
        body,
        timeout: 120 * 1000 // a multi-MB upload
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Stock Storage write HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return true;
}

// Zero-dependency Supabase REST Query Helper
async function querySupabase(apiPath, options = {}) {
    const cfg = supabaseCfgForPath_(apiPath);
    if (!cfg.url || !cfg.key) {
        throw new Error('Supabase credentials not configured. Set SUPABASE_URL and SUPABASE_KEY env vars.');
    }
    const schema = options.schema || 'public';
    const url = `${cfg.url}/rest/v1/${apiPath}`;
    const headers = {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
        'Accept-Profile': schema,
        ...options.headers
    };
    const method = (options.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
        headers.Prefer = options.prefer || 'return=representation';
        headers['Content-Profile'] = schema;
    }

    const response = await fetch(url, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Supabase REST API returned HTTP ${response.status}: ${errText}`);
    }

    const text = await response.text();
    if (!text || text.trim().length === 0) return null;
    try {
        return JSON.parse(text);
    } catch (e) {
        return text;
    }
}

const PIN_HASH_PREFIX = 'scrypt$';

function isPinHash(value) {
    return String(value || '').startsWith(PIN_HASH_PREFIX);
}

function hashPin(pin) {
    const plain = String(pin || '').trim();
    if (!plain) return '';
    if (isPinHash(plain)) return plain;
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(plain, salt, 32, { N: 16384, r: 8, p: 1 });
    return `${PIN_HASH_PREFIX}${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Profile sent to browsers. PIN never leaves the server. */
function portalUserForClient(user) {
    if (!user) return null;
    const { PIN, ...clientProfile } = user;
    return clientProfile;
}

/** Map DB row → legacy client profile shape (Username, PIN, dtr-autho, …) */
function portalUserToClient(row) {
    if (!row) return null;
    return {
        Username: row.username || '',
        PIN: row.pin != null ? String(row.pin) : '',
        Name: row.name || '',
        role: row.role || '',
        LastLogin: row.last_login || '',
        'dtr-autho': row.dtr_autho || '',
        'ss-autho': row.ss_autho || '',
        'dd-autho': row.dd_autho || '',
        'nsc-autho': row.nsc_autho || '',
        'nsc-upload-autho': row.nsc_upload_autho || '',
        'stock-upload-autho': row.stock_upload_autho || '',
        'stock-allot-autho': row.stock_allot_autho || '',
        'stock-cancel-autho': row.stock_cancel_autho || '',
        'defective-upload-autho': row.defective_upload_autho || '',
        'disconnection-sync-autho': row.disconnection_sync_autho || '',
        'pending-mc-sync-autho': row.pending_mc_sync_autho || '',
        'load-ext-sync-autho': row.load_ext_sync_autho || '',
        'si-autho': row.si_autho || '',
        'si-divisions': row.si_divisions || '',
        'sheets-autho': row.sheets_autho || '',
        zone_code: row.zone_code || '',
        region_code: row.region_code || '',
        division_code: row.division_code || '',
        ccc_code: row.ccc_code || '',
        email: row.email || '',
        auth_provider: row.auth_provider || 'pin',
        user_status: row.user_status || 'active',
        office_level: row.office_level || 'CCC',
        upload_permissions: Array.isArray(row.upload_permissions) ? row.upload_permissions : [],
        can_comment: !!row.can_comment,
        requested_at: row.requested_at || '',
        approved_by: row.approved_by || '',
        approved_at: row.approved_at || ''
    };
}

/** Map legacy / admin payload → DB columns */
function clientUserToPortal(user) {
    const username = String(user.Username || user.username || '').trim();
    return {
        username,
        pin: hashPin(String(user.PIN != null ? user.PIN : (user.pin || '')).trim()),
        name: String(user.Name != null ? user.Name : (user.name || '')).trim(),
        role: String(user.role || '').trim(),
        last_login: String(user.LastLogin != null ? user.LastLogin : (user.last_login || '')).trim(),
        dtr_autho: String(user['dtr-autho'] != null ? user['dtr-autho'] : (user.dtr_autho || '')).trim(),
        ss_autho: String(user['ss-autho'] != null ? user['ss-autho'] : (user.ss_autho || '')).trim(),
        dd_autho: String(user['dd-autho'] != null ? user['dd-autho'] : (user.dd_autho || '')).trim(),
        nsc_autho: String(user['nsc-autho'] != null ? user['nsc-autho'] : (user.nsc_autho || '')).trim(),
        nsc_upload_autho: String(
            user['nsc-upload-autho'] != null ? user['nsc-upload-autho'] : (user.nsc_upload_autho || '')
        ).trim(),
        stock_upload_autho: String(
            user['stock-upload-autho'] != null ? user['stock-upload-autho'] : (user.stock_upload_autho || '')
        ).trim(),
        stock_allot_autho: String(
            user['stock-allot-autho'] != null ? user['stock-allot-autho'] : (user.stock_allot_autho || '')
        ).trim(),
        stock_cancel_autho: String(
            user['stock-cancel-autho'] != null ? user['stock-cancel-autho'] : (user.stock_cancel_autho || '')
        ).trim(),
        defective_upload_autho: String(
            user['defective-upload-autho'] != null ? user['defective-upload-autho'] : (user.defective_upload_autho || '')
        ).trim(),
        disconnection_sync_autho: String(
            user['disconnection-sync-autho'] != null ? user['disconnection-sync-autho'] : (user.disconnection_sync_autho || '')
        ).trim(),
        pending_mc_sync_autho: String(
            user['pending-mc-sync-autho'] != null ? user['pending-mc-sync-autho'] : (user.pending_mc_sync_autho || '')
        ).trim(),
        load_ext_sync_autho: String(
            user['load-ext-sync-autho'] != null ? user['load-ext-sync-autho'] : (user.load_ext_sync_autho || '')
        ).trim(),
        si_autho: String(user['si-autho'] != null ? user['si-autho'] : (user.si_autho || '')).trim(),
        si_divisions: String(user['si-divisions'] != null ? user['si-divisions'] : (user.si_divisions || '')).trim(),
        sheets_autho: String(user['sheets-autho'] != null ? user['sheets-autho'] : (user.sheets_autho || '')).trim(),
        zone_code: String(user.zone_code || '').trim(),
        region_code: String(user.region_code || '').trim(),
        division_code: String(user.division_code || '').trim(),
        ccc_code: String(user.ccc_code || '').trim(),
        email: String(user.email || user.Email || '').trim().toLowerCase(),
        auth_provider: String(user.auth_provider || user['auth-provider'] || 'pin').trim(),
        user_status: String(user.user_status || user.status || 'active').trim().toLowerCase(),
        office_level: String(user.office_level || user.officeLevel || 'CCC').trim().toUpperCase(),
        upload_permissions: Array.isArray(user.upload_permissions)
            ? user.upload_permissions
            : (user.upload_permissions ? String(user.upload_permissions).split(',').map(s => s.trim()).filter(Boolean) : []),
        can_comment: !!(user.can_comment || user['can-comment']),
        requested_at: user.requested_at || new Date().toISOString(),
        approved_by: String(user.approved_by || '').trim(),
        approved_at: user.approved_at || null,
        updated_at: new Date().toISOString()
    };
}

async function fetchPortalUsersFromSupabase() {
    const rows = await querySupabase(`${PORTAL_USERS_TABLE}?select=*&order=username.asc`, {
        schema: PORTAL_USERS_SCHEMA
    });
    if (!Array.isArray(rows)) return [];
    return rows.map(portalUserToClient);
}

async function insertActivityLogToSupabase(entry) {
    await querySupabase(ACTIVITY_LOGS_TABLE, {
        schema: PORTAL_USERS_SCHEMA,
        method: 'POST',
        body: {
            timestamp: entry.timestamp,
            username: entry.username || '',
            name: entry.name || '',
            type: entry.type || '',
            details: entry.details || ''
        },
        prefer: 'return=minimal'
    });
}

async function fetchActivityLogsFromSupabase(limit = 2000, sinceIso) {
    const safeLimit = Math.min(Math.max(Number(limit) || 2000, 1), 5000);
    let query = `${ACTIVITY_LOGS_TABLE}?select=timestamp,username,name,type,details&order=timestamp.desc&limit=${safeLimit}`;
    if (sinceIso) {
        query = `${ACTIVITY_LOGS_TABLE}?select=timestamp,username&timestamp=gte.${encodeURIComponent(sinceIso)}&order=timestamp.desc&limit=${safeLimit}`;
    }
    const rows = await querySupabase(query, { schema: PORTAL_USERS_SCHEMA });
    if (!Array.isArray(rows)) return [];
    return rows.map((l) => ({
        timestamp: l.timestamp,
        username: l.username || '',
        name: l.name || '',
        type: l.type || '',
        details: l.details || ''
    }));
}

async function logActivity(activity) {
    if (userStore.on) return userStore.logActivity(activity);
    try {
        // Some fields come from the request (page path, names, labels): keep them bounded.
        const clip = (v, max) => String(v == null ? '' : v).slice(0, max);
        const entry = {
            timestamp: new Date().toISOString(),
            username: clip(activity.username, 100),
            name: clip(activity.name, 200),
            type: clip(activity.type, 50),
            details: clip(activity.details, 1000)
        };

        // Source of truth: Supabase mzo_insight.activity_logs. A VM-only admin exists nowhere in
        // Supabase, so its activity stays on this host (the journal and the local cache below).
        if (localAdmins.isLocalUsername(entry.username)) {
            if (entry.type !== 'page_visit') console.log(`[Activity] ${entry.username} ${entry.type}: ${entry.details}`);
        } else {
            try {
                await insertActivityLogToSupabase(entry);
            } catch (sbErr) {
                console.error('[Activity Log] Supabase write failed:', sbErr.message);
            }
        }

        if (globalCachedLogs === null) {
            globalCachedLogs = [];
        }
        globalCachedLogs.unshift(entry);
        if (globalCachedLogs.length > 5000) {
            globalCachedLogs = globalCachedLogs.slice(0, 5000);
        }

        // Best-effort local cache (ignored on read-only serverless FS)
        try {
            const dataDir = path.dirname(LOGS_FILE);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            writeDataFile_(path.basename(LOGS_FILE), JSON.stringify(globalCachedLogs, null, 2));
        } catch (writeErr) {
            // Fail silently on read-only serverless filesystems
        }
    } catch (err) {
        console.error('[Activity Log] Error saving log:', err.message);
    }
}

async function initializeLocalUsers() {
    try {
        console.log(`[Auth] Loading portal users from ${PORTAL_USERS_SCHEMA}.${PORTAL_USERS_TABLE}…`);
        const users = await fetchPortalUsersFromSupabase();

        globalCachedUsers = users;
        usersCacheLoadedAt = Date.now();

        console.log(`[Auth] Loaded ${users.length} portal users.`);
        return users;
    } catch (err) {
        console.error("[Auth] Failed to load portal users from Supabase:", err.message);
        return [];
    }
}

function readUsersFromLocalFile() {
    if (!fs.existsSync(USERS_FILE)) return null;
    try {
        const data = fs.readFileSync(USERS_FILE, 'utf-8');
        const users = JSON.parse(data);
        if (!Array.isArray(users)) return null;
        return users;
    } catch (err) {
        console.error("[Auth] Error reading local users file:", err.message);
        return null;
    }
}

/**
 * Login credentials source of truth is mzo_insight.portal_users (Supabase).
 * forceRefresh=true (sign-in, admin edits) always re-queries so changes apply immediately.
 */
async function getLoginCredentials(options = {}) {
    if (userStore.on) {
        await userStore.ready();
        return userStore.legacyUsers();
    }
    const forceRefresh = !!(options && options.forceRefresh);
    const now = Date.now();
    const cacheFresh = Array.isArray(globalCachedUsers)
        && globalCachedUsers.length > 0
        && (now - usersCacheLoadedAt) < USERS_CACHE_TTL_MS;

    if (!forceRefresh && cacheFresh) {
        return globalCachedUsers;
    }

    const fromSupabase = await initializeLocalUsers();
    if (fromSupabase && fromSupabase.length > 0) {
        return fromSupabase;
    }

    // Fallback only if Supabase is unreachable
    const fromFile = readUsersFromLocalFile();
    if (fromFile && fromFile.length > 0) {
        console.warn('[Auth] Using local users.json fallback — Supabase portal_users unavailable.');
        globalCachedUsers = fromFile;
        usersCacheLoadedAt = Date.now();
        return fromFile;
    }

    if (globalCachedUsers && globalCachedUsers.length > 0) {
        return globalCachedUsers;
    }

    return [];
}

// CRM (DB2) upload scripts: a key from the environment in the x-sync-key header, accepted only on these
// routes and only with that route's upload permission. Unset or shorter than 32 characters: off.
const SYNC_UPLOAD_ROUTES = {
    '/api/unbilled/upload': { env: 'UNBILLED_SYNC_SECRET', perm: 'unbilled-sync-autho' },
    '/api/disconnection/upload': { env: 'DISCONNECTION_SYNC_SECRET', perm: 'disconnection-sync-autho' },
    '/api/disconnection/payments-upload': { env: 'DISCONNECTION_SYNC_SECRET', perm: 'disconnection-sync-autho' }
};

function syncKeyMatches_(given, envName) {
    const secret = String(process.env[envName] || '').trim();
    if (secret.length < 32 || typeof given !== 'string' || !given) return false;
    const digest = (v) => crypto.createHash('sha256').update(v, 'utf8').digest();
    return crypto.timingSafeEqual(digest(given.trim()), digest(secret));
}

// The same keys also read back the datasets those scripts upload (GET only, these routes only): the
// payment sync reads the current disconnection list, and a non-VM server (Vercel, a workstation)
// fetches the VM's copy server-side for its signed-in user (fromVm_ below).
const SYNC_READ_ROUTES = {
    '/api/disconnection/dataset': { env: 'DISCONNECTION_SYNC_SECRET', perm: 'disconnection-sync-autho' },
    '/api/disconnection/payments': { env: 'DISCONNECTION_SYNC_SECRET', perm: 'disconnection-sync-autho' },
    '/api/disconnection/meta': { env: 'DISCONNECTION_SYNC_SECRET', perm: 'disconnection-sync-autho' },
    '/api/unbilled/outsort': { env: 'UNBILLED_SYNC_SECRET', perm: 'unbilled-sync-autho' },
    '/api/unbilled/chronic': { env: 'UNBILLED_SYNC_SECRET', perm: 'unbilled-sync-autho' },
    '/api/unbilled/summary': { env: 'UNBILLED_SYNC_SECRET', perm: 'unbilled-sync-autho' },
    '/api/unbilled/meta': { env: 'UNBILLED_SYNC_SECRET', perm: 'unbilled-sync-autho' }
};

/** The upload identity for a valid x-sync-key on a sync upload (or read-back) route, else null. */
function syncAgentFor_(req) {
    let route = null;
    if (req.method === 'POST') route = SYNC_UPLOAD_ROUTES[req.path];
    else if (req.method === 'GET' || req.method === 'HEAD') route = SYNC_READ_ROUTES[req.path];
    if (!route || !syncKeyMatches_(req.headers['x-sync-key'], route.env)) return null;
    return { Username: 'db2_sync_agent', username: 'db2_sync_agent', Name: 'DB2 CRM sync', role: 'sync', [route.perm]: 'Y' };
}

/** Profile from a valid, unexpired mzo_session cookie or Bearer token, else null. */
function readSession_(req) {
    let token = parseCookies(req.headers.cookie).mzo_session;
    if (!token && req.headers && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        token = req.headers.authorization.slice(7).trim();
    }
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const expected = Buffer.from(crypto.createHmac('sha256', JWT_SECRET).update(parts[0]).digest('base64'));
    const given = Buffer.from(parts[1]);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    return profileFromSessionPayload_(parts[0], req);
}

/** The profile of a verified session payload (base64 JSON), or null once it expired or was revoked. */
function profileFromSessionPayload_(payload, req) {
    try {
        const session = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
        if (!(session && Date.now() < session.expiry)) return null;
        // A VM-only admin's session lasts only while its MZO_LOCAL_ADMINS entry (and hash) is unchanged.
        if (session.local !== undefined) {
            if (!localAdmins.sessionValid(session)) return null;
            req.localAdmin = true;
        }
        // VM user store: the account's current profile, or null once it is disabled or its access changed.
        if (userStore.on) return userStore.profileForSession(session, session.local !== undefined);
        return session.profile;
    } catch (_) {
        return null;
    }
}

// Single-purpose upload tokens (the Safety Inspection bookmarklet): "sut1.<body>.<sig>", an HMAC (a key
// derived from JWT_SECRET, separate from the session signature) over { scope, exp, the session payload }.
// Never a session: readSession_ refuses it (three parts), and it is accepted only by the route of its
// scope, so a leaked token can upload one report for a few minutes, nothing else. It ends with the
// session, and with the account (the session payload is checked the same way as a cookie's).
const SCOPED_TOKEN_KEY = crypto.createHmac('sha256', JWT_SECRET).update('mzo:scoped-upload-token:v1').digest();
const SAFETY_UPLOAD_SCOPE = 'safety-upload';
const SAFETY_UPLOAD_TOKEN_MS = Math.min(720, Math.max(1, Number(process.env.SAFETY_UPLOAD_TOKEN_MINUTES) || 15)) * 60 * 1000;
const SAFETY_TOKEN_EXPIRED_MSG = 'This sync button has expired or is not valid. Open DISHA > Safety inspection > Sync Data and drag a fresh button to the bookmarks bar.';

function scopedTokenFromHeader_(req) {
    const m = /^Bearer\s+(sut1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\s*$/.exec(String((req.headers && req.headers.authorization) || ''));
    return m ? m[1] : '';
}

/** A token for scope, tied to the request's session cookie (never to a Bearer or scoped token); '' without one. */
function mintScopedToken_(req, scope, ttlMs) {
    const parts = String(parseCookies(req.headers.cookie).mzo_session || '').split('.');
    if (parts.length !== 2 || !readSession_({ headers: { cookie: req.headers.cookie } })) return { token: '', exp: 0 };
    let sessionExpiry = 0;
    try { sessionExpiry = Number(JSON.parse(Buffer.from(parts[0], 'base64').toString('utf-8')).expiry) || 0; } catch (_) { /* checked above */ }
    const exp = Math.min(Date.now() + ttlMs, sessionExpiry);
    const body = Buffer.from(JSON.stringify({ s: scope, exp, sp: parts[0] })).toString('base64url');
    const sig = crypto.createHmac('sha256', SCOPED_TOKEN_KEY).update('sut1.' + body).digest('base64url');
    return { token: `sut1.${body}.${sig}`, exp };
}

/** The profile behind a valid, unexpired token of this scope, else null. */
function verifyScopedToken_(token, scope, req) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'sut1') return null;
    const want = Buffer.from(crypto.createHmac('sha256', SCOPED_TOKEN_KEY).update('sut1.' + parts[1]).digest('base64url'));
    const got = Buffer.from(parts[2]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    try {
        const t = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
        if (!t || t.s !== scope || !(Date.now() < Number(t.exp)) || typeof t.sp !== 'string') return null;
        return profileFromSessionPayload_(t.sp, req);
    } catch (_) {
        return null;
    }
}

/** The uploader for a POST to the Safety upload route with a valid upload token, else null. */
function safetyUploadAgentFor_(req) {
    if (req.method !== 'POST' || !isSafetyUploadPath_(req.path)) return null;
    const token = scopedTokenFromHeader_(req);
    return token ? verifyScopedToken_(token, SAFETY_UPLOAD_SCOPE, req) : null;
}

// Reachable without a session (static files are already served above).
const PUBLIC_PATHS = new Set([
    '/login.html', '/offline.html', '/sw.js', '/manifest.json',
    '/api/auth/google', '/api/auth/local', '/api/auth/pending-status', '/api/auth/config', '/api/news'
]);
const PUBLIC_ASSET = /^\/(icons|assets)\/|\.(css|js|png|json|ico)$/i;

// Static files (pages included) are served before this, so it guards the API and paths with no file.
// Page visits are logged from /api/session-check by the VM user store.
async function requireAuth(req, res, next) {
    const pathName = req.path.toLowerCase(); // Express routes match case-insensitively
    const isApi = pathName === '/api' || pathName.startsWith('/api/');
    if (userStore.on) await userStore.ready();
    const syncAgent = syncAgentFor_(req);
    if (syncAgent) req.syncAgent = true;
    const uploadAgent = syncAgent ? null : safetyUploadAgentFor_(req);
    if (uploadAgent) req.scopedUpload = SAFETY_UPLOAD_SCOPE;
    const profile = syncAgent || uploadAgent || readSession_(req);
    if (profile) {
        req.user = profile;
        return next();
    }
    // An /api path is never a public asset, whatever it ends with (/api/data/file/x.json).
    if (PUBLIC_PATHS.has(pathName) || (!isApi && PUBLIC_ASSET.test(pathName))) return next();
    // The bookmarklet with an expired or invalid upload token: say how to get a fresh one.
    if (req.method === 'POST' && isSafetyUploadPath_(req.path) && scopedTokenFromHeader_(req)) {
        return res.status(401).json({ status: 'error', message: SAFETY_TOKEN_EXPIRED_MSG });
    }
    // API callers (CSV/JSON clients like Power Map) get 401, never an HTML redirect.
    if (isApi || req.xhr || String(req.headers.accept || '').includes('application/json')) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }
    return res.redirect('/login.html');
}

app.use(requireAuth);

async function reportPageGate_(req, res, next) {
    if (!userStore.on) return next();
    // The decoded, normalised path, as express.static resolves it (/%6Esc.html serves nsc.html).
    let pagePath;
    try { pagePath = path.posix.normalize(decodeURIComponent(req.path)); } catch (_) { return next(); }
    if (!/\.html$/i.test(pagePath)) return next();
    await userStore.ready();
    const profile = readSession_(req);
    if (profile && !userStore.pageAllowed(profile, pagePath)) {
        return res.status(403).type('text/plain').send('This report is not enabled for your account. Ask an administrator.');
    }
    return next();
}

// VM mirror mode (MZO_DATA_MODE=mirror + MZO_SNAPSHOT_DIR): /api/data/* serve the sync's snapshots, report
// reads below use them, and writes refresh them. Off on Vercel and by default (docs/architecture.md, "Mirror mode").
const mirror = require('./lib/mirror').create({ appRoot: __dirname });
// Datasets whose writes also change the Briefing's inputs (report meta, NSC upload meta).
const BRIEFING_MIRROR_KEYS = new Set(['nsc_pending', 'withheld', 'pending_mc', 'load_extension', 'disconnection', 'defective_summary', 'defective_details']);
function refreshMirror(keys, reason) {
    const started = mirror.refreshMirror(keys, reason);
    if (mirror.on() && [].concat(keys || []).some((k) => BRIEFING_MIRROR_KEYS.has(k))) refreshBriefing_({ changed: true });
    return started;
}
mirror.mount(app);
// Admin → Sources: where each dataset comes from, its schedule and freshness (lib/sources_info.js; docs/data-mirror.md).
const sourcesInfo = require('./lib/sources_info').create({ appRoot: __dirname, mirror });
app.get('/api/admin/sources-info', sourcesInfo.handler);
// Admin → Data quality: findings of the sync's checks (quality.json next to the snapshots; lib/data_quality.js, docs/data-quality.md).
const dataQuality = require('./lib/data_quality').create({ mirror, sources: sourcesInfo });
app.get('/api/admin/data-quality', dataQuality.handler);
// The 6 Nov 2026 audit's findings (lib/quality/audit_findings.json) with the live state of their automatic checks.
app.get('/api/admin/data-quality/audit', dataQuality.auditHandler);
// Admin → Organisation: WBSEDCL's office hierarchy, with the zone this app covers marked live (lib/org_hierarchy.js; docs/org-hierarchy.md).
app.get('/api/admin/org', require('./lib/org_hierarchy').create({ file: path.join(__dirname, 'data', 'org', 'wbsedcl_hierarchy.json') }).handler); // literal path: Vercel bundles it with the function
// Data editor (/editor/, /api/editor/*; docs/data-editor.md): native datasets on the VM's PocketBase. Off without PocketBase credentials.
require('./lib/editor').mount(app, { refreshMirror, isSensitive: (key) => require('./lib/mirror').isSensitive(key), onChanged: (keys) => { if (mirror.on() && keys.some((k) => BRIEFING_MIRROR_KEYS.has(k))) refreshBriefing_({ changed: true }); } });
// Uniform rows next to the snapshots (docs/uniform-data.md); mirror mode only.
if (String(process.env.MZO_DATA_MODE || '').toLowerCase() === 'mirror') {
    try {
        app.get('/api/data/rows/:key', require('./vm/sync/lib/rows').handler({ dir: mirror.dir, app: __dirname, on: mirror.on, manifest: mirror.manifest }));
    } catch (err) { console.warn('[Mirror] uniform rows unavailable:', err.message); }
}
// Performance rating precomputed after each sync (vm/sync/rating.js; docs/rating/metrics-layer.md): 204 outside mirror mode, before the first build and on Vercel (no vm/), so the page computes it itself.
let ratingRoute = (req, res) => (req.user ? res.status(204).end() : res.status(401).json({ status: 'error', message: 'Unauthorized' }));
try { if (mirror.on() || String(process.env.MZO_DATA_MODE || '').toLowerCase() === 'mirror') ratingRoute = require('./vm/sync/lib/rating').handler({ dir: mirror.dir, app: __dirname, on: mirror.on }); } catch (err) { console.warn('[Mirror] rating unavailable:', err.message); }
app.get('/api/data/rating', ratingRoute);
// Page views precomputed after each sync (vm/sync/views.js; docs/uniform-data.md, "Page views"): 204 outside
// mirror mode, on Vercel (no vm/) and while a view is not fresh, so the page computes it itself.
let viewRoute = (req, res) => (req.user ? res.status(204).end() : res.status(401).json({ status: 'error', message: 'Unauthorized' }));
try { if (mirror.on() || String(process.env.MZO_DATA_MODE || '').toLowerCase() === 'mirror') viewRoute = require('./vm/sync/lib/views').handler({ dir: mirror.dir, app: __dirname, on: mirror.on, manifest: mirror.manifest }); } catch (err) { console.warn('[Mirror] page views unavailable:', err.message); }
app.get('/api/data/view/:name', viewRoute);

// --- Estimate structures (admin.html) ---
const STRUCTURE_FILE = path.join(__dirname, 'data', 'structure.csv'); // literal path: Vercel bundles it with the function
// Admin edits go to the data folder (MZO_FILES_DIR on the VM, outside the release, so a deploy keeps them);
// reads prefer that copy and fall back to the one in the repo. Locally both are data/structure.csv.
const STRUCTURE_EDIT_FILE = path.join(DATA_DIR, 'structure.csv');
function structureReadFile_() { try { if (fs.statSync(STRUCTURE_EDIT_FILE).size > 0) return STRUCTURE_EDIT_FILE; } catch (_) { /* no edited copy */ } return STRUCTURE_FILE; }
const STRUCTURE_COLUMNS = ['id', 'name', 'description', 'voltage', 'materials', 'labour'];

function parseStructuresCsv_(text) {
    const lines = String(text || '').trim().split(/\r?\n/);
    const headers = parseCsvLine_(lines[0] || '').map((h) => h.trim());
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const values = parseCsvLine_(lines[i]).map((v) => v.trim());
        if (values.length !== headers.length) continue;
        const row = {};
        STRUCTURE_COLUMNS.forEach((k) => { row[k] = values[headers.indexOf(k)]; });
        rows.push(row);
    }
    return rows;
}

app.get('/api/structures', (req, res) => {
    try {
        res.json(parseStructuresCsv_(fs.readFileSync(structureReadFile_(), 'utf-8')));
    } catch (error) {
        console.error('Error reading structure file:', error.message);
        res.status(500).json({ message: 'Error reading structure data.', details: error.message });
    }
});

// Writes the data folder's structure.csv (MZO_FILES_DIR on the VM; the Vercel filesystem is read-only).
app.post('/api/structures/update', requireAdmin, (req, res) => {
    const structures = req.body;
    if (!Array.isArray(structures)) {
        return res.status(400).send('Invalid data format. Expected an array of structures.');
    }
    try {
        const csv = [STRUCTURE_COLUMNS.join(',')]
            .concat(structures.map((s) => STRUCTURE_COLUMNS.map((k) => (k === 'id' ? s.id : `"${String(s[k] == null ? '' : s[k]).replace(/"/g, '""')}"`)).join(',')))
            .join('\n');
        // Temp file + rename: a reader never sees half a file.
        fs.mkdirSync(path.dirname(STRUCTURE_EDIT_FILE), { recursive: true });
        const tmp = `${STRUCTURE_EDIT_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        try {
            fs.writeFileSync(tmp, csv, 'utf-8');
            fs.renameSync(tmp, STRUCTURE_EDIT_FILE);
        } catch (e) {
            try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
            throw e;
        }
        refreshMirror(['structure'], 'structures update');
        res.status(200).json({ message: 'Structures updated successfully!' });
    } catch (error) {
        console.error('Error writing structure file:', error.message);
        res.status(500).json({ message: 'An error occurred while saving data.', details: error.message });
    }
});

// Helper to issue signed stateless session cookie
function issueSessionCookie(res, clientProfile, extra) {
    const payload = {
        profile: clientProfile,
        expiry: Date.now() + 24 * 60 * 60 * 1000,
        ...(extra || {})
    };
    const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64');
    const signature = crypto.createHmac('sha256', JWT_SECRET).update(payloadStr).digest('base64');
    const token = `${payloadStr}.${signature}`;
    res.setHeader('Set-Cookie', `mzo_session=${token}; Path=/; HttpOnly; Max-Age=${24 * 60 * 60}; SameSite=Strict`);
    return token;
}

// Pending registrations: /api/auth/pending-status answers only the browser that signed in (an HMAC ticket
// in the mzo_pending cookie, the same format as the VM user store's), so it cannot be used to probe emails.
const PENDING_COOKIE_ = 'mzo_pending';
function pendingTicket_(email) {
    const e = Buffer.from(String(email)).toString('base64url');
    return `${e}.${crypto.createHmac('sha256', JWT_SECRET).update('pending:' + e).digest('base64url')}`;
}
function setPendingCookie_(res, email) {
    res.setHeader('Set-Cookie', `${PENDING_COOKIE_}=${encodeURIComponent(pendingTicket_(email))}; Path=/api/auth; HttpOnly; Max-Age=${30 * 24 * 3600}; SameSite=Lax`);
}
/** The email of a valid mzo_pending ticket, else ''. Never throws. */
function pendingEmailFrom_(req) {
    try {
        const raw = parseCookies(req.headers.cookie)[PENDING_COOKIE_];
        if (!raw) return '';
        const [e, sig] = String(raw).split('.');
        if (!e || !sig) return '';
        const want = Buffer.from(crypto.createHmac('sha256', JWT_SECRET).update('pending:' + e).digest('base64url'));
        const got = Buffer.from(sig);
        if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return '';
        return Buffer.from(e, 'base64url').toString('utf8');
    } catch (_) {
        return '';
    }
}

const ROOT_ADMIN_EMAILS = ['smartlinemanapp@gmail.com', 'dipnkr.das@gmail.com'];
const googleAuth = require('./lib/google_auth');

function googleClientId_() {
    return String(process.env.GOOGLE_CLIENT_ID || fileConfig.googleClientId || '').trim();
}

// The VM user store's sign-in, session check and user admin routes take precedence over the Supabase ones below.
if (userStore.on) userStore.mount(app, { issueSessionCookie, requireAdmin, clientId: googleClientId_, fetch, rootAdmins: ROOT_ADMIN_EMAILS });

/**
 * A Google token issued to this app's client ID for a verified email (lib/google_auth.js): an ID token
 * (Sign-In button) is checked against Google's signing keys, an access token (popup) by Google's tokeninfo.
 * Returns the claims, or null when the token does not qualify. Throws if Google is unreachable.
 */
function googleTokenInfo_(kind, token) {
    return googleAuth.tokenInfo(kind, token, { clientId: googleClientId_(), fetch });
}

/** Full admin profile: the Google root admin's, also used for VM-only admins (MZO_LOCAL_ADMINS). */
function rootAdminProfile_({ Username, Name, email, auth_provider, approved_by }) {
    return {
        Username,
        Name,
        email,
        auth_provider,
        user_status: 'active',
        role: 'admin',
        office_level: 'CE',
        sheets_autho: 'edit',
        can_comment: true,
        disconnection_sync_autho: 'Y',
        pending_mc_sync_autho: 'Y',
        load_ext_sync_autho: 'Y',
        defective_upload_autho: 'Y',
        nsc_upload_autho: 'Y',
        stock_upload_autho: 'Y',
        stock_allot_autho: 'Y',
        stock_cancel_autho: 'Y',
        upload_permissions: ['disconnection', 'pending_mc', 'load_ext', 'defective', 'nsc', 'stock', 'stock_allot', 'stock_cancel'],
        requested_at: new Date().toISOString(),
        approved_at: new Date().toISOString(),
        approved_by
    };
}

// Public auth configuration (Google Client ID; localSignIn only where MZO_LOCAL_ADMINS is set, i.e. the VM)
app.get('/api/auth/config', (req, res) => {
    res.json({
        googleClientId: googleClientId_(),
        ...(localAdmins.enabled ? { localSignIn: true } : {}),
        ...(assistant.configured ? { assistantProvider: assistant.provider, assistantModel: assistant.modelName } : {})
    });
});

/**
 * Sign-in of a VM-only admin (MZO_LOCAL_ADMINS): checked against its hash only, never Supabase.
 * Everyone else signs in with Google; without MZO_LOCAL_ADMINS (Vercel, local default) this is 404.
 */
app.post('/api/auth/local', async (req, res) => {
    if (!localAdmins.enabled) return res.status(404).json({ status: 'error', message: 'Not found.' });
    const { username, password } = req.body || {};
    if (!username || !password || !String(password).trim()) {
        return res.status(400).json({ status: 'error', message: 'Username and password are required.' });
    }
    const WRONG = { status: 'error', message: 'Invalid username or password.' };
    const admin = localAdmins.find(username);
    // An unknown username costs the same time and counts against the client IP, like a wrong password.
    const ok = admin
        ? await localAdmins.attempt(admin, String(password).trim(), req)
        : await localAdmins.reject(req);
    if (!ok) return res.status(401).json(WRONG);
    const clientProfile = portalUserForClient(rootAdminProfile_({
        Username: admin.username, Name: admin.name, email: '', auth_provider: 'local', approved_by: 'vm_local_admin'
    }));
    issueSessionCookie(res, clientProfile, { local: localAdmins.sessionKey(admin) });
    console.log(`[Auth] VM-only admin signed in: ${admin.username} (${admin.name})`);
    await logActivity({
        username: admin.username,
        name: admin.name,
        type: 'login',
        details: `Signed in as a VM-only admin from IP: ${req.ip || req.headers['x-forwarded-for'] || 'unknown'}`
    });
    return res.status(200).json({ status: 'success', profile: clientProfile });
});

// API endpoint for Google Sign-In & Registration
app.post('/api/auth/google', async (req, res) => {
    try {
        const { credential, accessToken } = req.body || {};
        let email = '';
        let name = '';
        let picture = '';

        if (credential || accessToken) {
            if (!googleClientId_()) {
                return res.status(503).json({ status: 'error', message: 'Google sign-in is not configured on the server.' });
            }
            let info;
            try {
                info = await googleTokenInfo_(credential ? 'id_token' : 'access_token', credential || accessToken);
            } catch (netErr) {
                console.error('[Google Auth] tokeninfo unreachable:', netErr.message);
                return res.status(503).json({ status: 'error', message: 'Could not connect to Google for authentication verification.' });
            }
            if (!info) {
                return res.status(401).json({ status: 'error', message: 'Google sign-in could not be verified. Please try again.' });
            }
            email = String(info.email).trim().toLowerCase();
            name = String(info.name || info.given_name || '').trim();
            picture = info.picture || '';
            if (accessToken && !name) {
                // Access-token info has no profile; the name and photo come from userinfo.
                try {
                    const gRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                        headers: { Authorization: `Bearer ${accessToken}` },
                        signal: AbortSignal.timeout(8000)
                    });
                    if (gRes.ok) {
                        const g = await gRes.json();
                        name = String(g.name || g.given_name || '').trim();
                        picture = g.picture || picture;
                    }
                } catch (_) { /* profile is optional */ }
            }
            name = name || email.split('@')[0];
        } else {
            return res.status(400).json({ status: 'error', message: 'Google authentication credential is required.' });
        }

        const isRootAdmin = ROOT_ADMIN_EMAILS.includes(email);

        // Accounts link to Google by their saved email (set by an admin, or at the first Google sign-in).
        const users = await getLoginCredentials({ forceRefresh: true });
        const existing = users.find((u) => String(u.email || '').trim().toLowerCase() === email);

        if (existing) {
            if (isRootAdmin) {
                existing.role = 'admin';
                existing.user_status = 'active';
                existing.office_level = 'CE';
            } else {
                const status = String(existing.user_status || 'active').toLowerCase();
                if (status === 'pending') {
                    setPendingCookie_(res, email);
                    return res.status(200).json({
                        status: 'pending',
                        email,
                        name: existing.Name || name,
                        requested_at: existing.requested_at,
                        message: 'Your registration is awaiting administrator approval.'
                    });
                }
                if (status === 'rejected') {
                    return res.status(403).json({
                        status: 'rejected',
                        message: 'Your access request was not approved by an administrator.'
                    });
                }
                if (status === 'suspended') {
                    return res.status(403).json({
                        status: 'suspended',
                        message: 'Your account has been deactivated.'
                    });
                }
            }

            // User is approved and active
            try {
                await patchPortalUserWithFallback(existing.Username, {
                    email,
                    auth_provider: 'google',
                    role: isRootAdmin ? 'admin' : (existing.role || 'viewer'),
                    user_status: 'active',
                    last_login: new Date().toISOString()
                });
            } catch (e) {
                console.warn('[Google Auth] updating user email failed:', e.message);
            }

            const clientProfile = portalUserForClient(existing);
            if (isRootAdmin) clientProfile.role = 'admin';
            issueSessionCookie(res, clientProfile);

            await logActivity({
                username: existing.Username,
                name: existing.Name || name,
                type: 'login',
                details: `Signed in via Google (${email}) ${isRootAdmin ? '[ROOT ADMIN]' : ''}`
            });

            return res.status(200).json({
                status: 'success',
                profile: clientProfile
            });
        }

        // New user: register or auto-provision root admin
        let baseUsername = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '');
        if (!baseUsername) baseUsername = 'user';
        let candidateUsername = baseUsername;
        let counter = 1;
        while (users.some(u => String(u.Username).toLowerCase() === candidateUsername.toLowerCase()) || localAdmins.isLocalUsername(candidateUsername)) {
            candidateUsername = `${baseUsername}${counter++}`;
        }

        if (isRootAdmin) {
            const rootAdminUser = rootAdminProfile_({
                Username: candidateUsername,
                Name: name || 'Admin',
                email: email,
                auth_provider: 'google',
                approved_by: 'system_root'
            });

            try {
                const dbRow = clientUserToPortal(rootAdminUser);
                await insertPortalUserWithFallback(dbRow);
                await initializeLocalUsers();
            } catch (dbErr) {
                console.error('[Google Auth] Failed to insert root admin:', dbErr.message);
            }

            const clientProfile = portalUserForClient(rootAdminUser);
            issueSessionCookie(res, clientProfile);

            await logActivity({
                username: candidateUsername,
                name: name || 'Admin',
                type: 'user_management',
                details: `Auto-provisioned Root Administrator via Google: ${email}`
            });

            return res.status(200).json({
                status: 'success',
                profile: clientProfile
            });
        }

        const newPendingUser = {
            Username: candidateUsername,
            Name: name,
            email: email,
            auth_provider: 'google',
            user_status: 'pending',
            role: 'viewer',
            requested_at: new Date().toISOString()
        };

        try {
            const dbRow = clientUserToPortal(newPendingUser);
            await insertPortalUserWithFallback(dbRow);
            await initializeLocalUsers();
        } catch (dbErr) {
            console.error('[Google Auth] Failed to insert pending user:', dbErr.message);
        }

        await logActivity({
            username: candidateUsername,
            name: name,
            type: 'user_management',
            details: `New Google user requested registration: ${email}`
        });

        setPendingCookie_(res, email);
        return res.status(200).json({
            status: 'pending',
            email,
            name,
            requested_at: newPendingUser.requested_at,
            message: 'Registration received! Your account is pending administrator role approval.'
        });
    } catch (err) {
        console.error('[Google Auth] Error:', err.message);
        return res.status(500).json({ status: 'error', message: 'Failed to authenticate with Google.' });
    }
});

// Check pending approval status
app.get('/api/auth/pending-status', async (req, res) => {
    try {
        const email = String(req.query.email || '').trim().toLowerCase();
        if (!email) {
            return res.status(400).json({ status: 'error', message: 'Email required.' });
        }
        // Only the browser that registered may ask (signed ticket), so emails cannot be probed.
        if (pendingEmailFrom_(req) !== email) return res.status(200).json({ status: 'not_found' });
        const users = await getLoginCredentials();
        const user = users.find((u) => String(u.email || '').trim().toLowerCase() === email);
        if (!user) {
            return res.status(200).json({ status: 'not_found' });
        }
        return res.status(200).json({
            status: 'success',
            user_status: user.user_status || 'active',
            role: user.role || 'viewer',
            office_level: user.office_level || 'CCC',
            approved_at: user.approved_at || null
        });
    } catch (err) {
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

// API endpoint to verify session status (refresh profile from portal_users when possible)
app.get('/api/session-check', async (req, res) => {
    if (!req.user || !req.user.Username) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }
    // A VM-only admin is not in Supabase: its profile is the one it signed in with.
    if (req.localAdmin) return res.status(200).json({ status: 'success', profile: req.user });
    try {
        const users = await getLoginCredentials({ forceRefresh: true });
        const key = String(req.user.Username).trim().toLowerCase();
        const fresh = users.find((u) => u.Username && String(u.Username).trim().toLowerCase() === key);
        if (fresh) {
            // The root admins always see an admin profile (a copy: the cached row is left as it is).
            const shown = ROOT_ADMIN_EMAILS.includes(String(fresh.email || '').trim().toLowerCase())
                ? { ...fresh, role: 'admin', user_status: 'active', office_level: 'CE' }
                : fresh;
            return res.status(200).json({ status: 'success', profile: portalUserForClient(shown) });
        }
    } catch (err) {
        console.warn('[Auth] session-check profile refresh failed:', err.message);
    }
    return res.status(200).json({ status: 'success', profile: req.user });
});

// API endpoint for User Logout
app.post('/api/logout', (req, res) => {
    // Invalidate session cookie
    res.setHeader('Set-Cookie', 'mzo_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Strict');
    return res.status(200).json({ status: 'success', message: 'Logged out successfully.' });
});

// --- Admin User Management & Logging Endpoints ---

/**
 * Supabase path only: false when the user's current portal row says they are no longer an active admin
 * (demoted or suspended after the 24 h cookie was issued). The VM user store and VM-only admins already
 * re-check every request. Fails open, as before, when the row cannot be read (Supabase down, no row).
 */
async function stillAdmin_(req) {
    if (userStore.on || req.localAdmin || req.syncAgent) return true;
    try {
        const users = await getLoginCredentials(); // cached up to USERS_CACHE_TTL_MS
        const key = String(req.user.Username || '').trim().toLowerCase();
        const row = key && users.find((u) => u.Username && String(u.Username).trim().toLowerCase() === key);
        if (!row) return true;
        if (ROOT_ADMIN_EMAILS.includes(String(row.email || '').trim().toLowerCase())) return true;
        const status = String(row.user_status || 'active').toLowerCase();
        return String(row.role || '').toLowerCase() === 'admin' && status === 'active';
    } catch (_) {
        return true;
    }
}

async function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin' || !(await stillAdmin_(req))) {
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(403).json({ status: 'error', message: 'Forbidden: Admin access required.' });
        } else {
            return res.redirect('/app.html');
        }
    }
    next();
}

function canManageImportantSheets(user) {
    if (!user) return false;
    if (String(user.role || '').toLowerCase() === 'admin') return true;
    const flag = String(user['sheets-autho'] != null ? user['sheets-autho'] : (user.sheets_autho || ''))
        .trim()
        .toLowerCase();
    return flag === 'edit' || flag === 'y' || flag === 'all';
}

function requireSheetsEditor(req, res, next) {
    if (!canManageImportantSheets(req.user)) {
        return res.status(403).json({
            status: 'error',
            message: 'Forbidden: Important Sheets manage access required.'
        });
    }
    next();
}

const UNBILLED_MONTHS_TABLE = 'important_unbilled_months';

function mapUnbilledMonthRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        label: row.label || '',
        sheetId: row.sheet_id || '',
        gid: row.gid != null && String(row.gid).trim() !== '' ? String(row.gid) : '0',
        sortOrder: Number(row.sort_order) || 0,
        active: row.active !== false
    };
}

function normalizeUnbilledPayload(body, { requireSort = false } = {}) {
    const label = String(body.label || '').trim();
    const sheetId = String(body.sheetId || body.sheet_id || '').trim();
    let gid = String(body.gid != null ? body.gid : '0').trim();
    if (!gid) gid = '0';
    const hasSort = body.sortOrder != null || body.sort_order != null;
    const sortOrder = Number(body.sortOrder != null ? body.sortOrder : body.sort_order);
    const active = body.active === false || body.active === 'false' ? false : true;
    const out = {
        label,
        sheet_id: sheetId,
        gid,
        active,
        updated_at: new Date().toISOString()
    };
    if (hasSort && Number.isFinite(sortOrder)) {
        out.sort_order = sortOrder;
    } else if (requireSort) {
        out.sort_order = 0;
    }
    return out;
}

// List unbilled months (any logged-in portal user)
app.get('/api/important-sheets/unbilled', async (req, res) => {
    try {
        const includeAll = String(req.query.all || '') === '1' && canManageImportantSheets(req.user);
        // Mirror: the snapshot is this query without the active filter, in the same order.
        let rows = await mirror.readJson('important_unbilled_months');
        if (Array.isArray(rows)) {
            if (!includeAll) rows = rows.filter((r) => r && r.active === true);
            res.setHeader('X-Mzo-Data', 'mirror');
        } else {
            let path = `${UNBILLED_MONTHS_TABLE}?select=*&order=sort_order.asc,id.asc`;
            if (!includeAll) path += '&active=eq.true';
            rows = await querySupabase(path, { schema: PORTAL_USERS_SCHEMA });
        }
        const months = (Array.isArray(rows) ? rows : []).map(mapUnbilledMonthRow);
        res.json({ status: 'success', months });
    } catch (err) {
        console.error('[important-sheets] list failed:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Create unbilled month (admin only)
app.post('/api/important-sheets/unbilled', requireSheetsEditor, async (req, res) => {
    try {
        const payload = normalizeUnbilledPayload(req.body || {}, { requireSort: true });
        if (!payload.label || !payload.sheet_id || payload.sheet_id === '#') {
            return res.status(400).json({ status: 'error', message: 'Label and Sheet ID are required.' });
        }
        if (!payload.sort_order) {
            const existing = await querySupabase(
                `${UNBILLED_MONTHS_TABLE}?select=sort_order&order=sort_order.desc&limit=1`,
                { schema: PORTAL_USERS_SCHEMA }
            );
            const maxSort = Array.isArray(existing) && existing[0] ? Number(existing[0].sort_order) || 0 : 0;
            payload.sort_order = maxSort + 1;
        }
        const inserted = await querySupabase(UNBILLED_MONTHS_TABLE, {
            schema: PORTAL_USERS_SCHEMA,
            method: 'POST',
            body: payload
        });
        const row = Array.isArray(inserted) ? inserted[0] : inserted;
        refreshMirror(['important_unbilled_months'], 'unbilled month added');
        await logActivity({
            username: req.user.Username,
            name: req.user.Name,
            type: 'user_management',
            details: `Added unbilled month: ${payload.label}`
        });
        res.json({ status: 'success', month: mapUnbilledMonthRow(row) });
    } catch (err) {
        console.error('[important-sheets] create failed:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Update unbilled month (admin only)
app.patch('/api/important-sheets/unbilled/:id', requireSheetsEditor, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ status: 'error', message: 'Invalid month id.' });
        }
        const payload = normalizeUnbilledPayload({ ...(req.body || {}), active: req.body?.active });
        if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'active')) {
            payload.active = !(req.body.active === false || req.body.active === 'false');
        }
        if (!payload.label || !payload.sheet_id || payload.sheet_id === '#') {
            return res.status(400).json({ status: 'error', message: 'Label and Sheet ID are required.' });
        }
        if (payload.sort_order == null) {
            // keep existing sort_order if client omitted it
            delete payload.sort_order;
        }
        const updated = await querySupabase(
            `${UNBILLED_MONTHS_TABLE}?id=eq.${id}`,
            {
                schema: PORTAL_USERS_SCHEMA,
                method: 'PATCH',
                body: payload
            }
        );
        const row = Array.isArray(updated) ? updated[0] : updated;
        refreshMirror(['important_unbilled_months'], 'unbilled month updated');
        await logActivity({
            username: req.user.Username,
            name: req.user.Name,
            type: 'user_management',
            details: `Updated unbilled month #${id}: ${payload.label}`
        });
        res.json({ status: 'success', month: mapUnbilledMonthRow(row) });
    } catch (err) {
        console.error('[important-sheets] update failed:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Delete unbilled month (admin only)
app.delete('/api/important-sheets/unbilled/:id', requireSheetsEditor, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ status: 'error', message: 'Invalid month id.' });
        }
        await querySupabase(`${UNBILLED_MONTHS_TABLE}?id=eq.${id}`, {
            schema: PORTAL_USERS_SCHEMA,
            method: 'DELETE',
            prefer: 'return=minimal'
        });
        refreshMirror(['important_unbilled_months'], 'unbilled month deleted');
        await logActivity({
            username: req.user.Username,
            name: req.user.Name,
            type: 'user_management',
            details: `Deleted unbilled month #${id}`
        });
        res.json({ status: 'success' });
    } catch (err) {
        console.error('[important-sheets] delete failed:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// 1. GET all users
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const users = await getLoginCredentials();
        res.json({ status: 'success', users: (users || []).map(portalUserForClient) });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// 2. CREATE a user
app.post('/api/admin/users/create', requireAdmin, async (req, res) => {
    try {
        const { Username, PIN, Name, role, ...otherFields } = req.body;

        if (!Username) {
            return res.status(400).json({ status: 'error', message: 'Username is required.' });
        }

        const users = await getLoginCredentials({ forceRefresh: true });
        const exists = users.some(u => u.Username && u.Username.toLowerCase() === Username.trim().toLowerCase());
        if (exists) {
            return res.status(400).json({ status: 'error', message: 'Username already exists.' });
        }

        const newUser = {
            Username: Username.trim(),
            PIN: PIN ? String(PIN).trim() : '',
            LastLogin: '',
            Name: Name ? Name.trim() : '',
            role: role ? role.trim() : '',
            'dtr-autho': '',
            'ss-autho': '',
            'dd-autho': '',
            'nsc-autho': '',
            'nsc-upload-autho': '',
            'stock-upload-autho': '',
            'stock-allot-autho': '',
            'stock-cancel-autho': '',
            'defective-upload-autho': '',
            'disconnection-sync-autho': '',
            'pending-mc-sync-autho': '',
            'load-ext-sync-autho': '',
            'si-autho': '',
            'si-divisions': '',
            'sheets-autho': '',
            zone_code: '',
            region_code: '',
            division_code: '',
            ccc_code: '',
            ...otherFields
        };

        const dbRow = clientUserToPortal(newUser);
        const inserted = await insertPortalUserWithFallback(dbRow);
        const saved = Array.isArray(inserted) && inserted[0]
            ? portalUserToClient(inserted[0])
            : newUser;

        await initializeLocalUsers();
        refreshMirror(['portal_users'], 'admin user change');

        await logActivity({
            username: req.user.Username,
            name: req.user.Name,
            type: 'user_management',
            details: `Created user account: ${Username}`
        });

        res.json({ status: 'success', message: 'User created successfully.', user: portalUserForClient(saved) });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

async function patchPortalUserWithFallback(username, dbRow) {
    let payload = { ...dbRow };
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            return await querySupabase(
                `${PORTAL_USERS_TABLE}?username=eq.${encodeURIComponent(username)}`,
                {
                    schema: PORTAL_USERS_SCHEMA,
                    method: 'PATCH',
                    body: payload
                }
            );
        } catch (err) {
            const m = err.message && err.message.match(/Could not find the '([^']+)' column/i);
            if (m && m[1] && payload[m[1]] !== undefined) {
                console.warn(`[Portal Users] DB table missing column '${m[1]}' - omitting from patch and retrying...`);
                delete payload[m[1]];
                continue;
            }
            throw err;
        }
    }
}

async function insertPortalUserWithFallback(dbRow) {
    let payload = { ...dbRow };
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            return await querySupabase(PORTAL_USERS_TABLE, {
                schema: PORTAL_USERS_SCHEMA,
                method: 'POST',
                body: payload
            });
        } catch (err) {
            const m = err.message && err.message.match(/Could not find the '([^']+)' column/i);
            if (m && m[1] && payload[m[1]] !== undefined) {
                console.warn(`[Portal Users] DB table missing column '${m[1]}' - omitting from insert and retrying...`);
                delete payload[m[1]];
                continue;
            }
            throw err;
        }
    }
}

// 3. UPDATE a user
app.post('/api/admin/users/update', requireAdmin, async (req, res) => {
    try {
        const updatedUser = req.body;
        const { Username } = updatedUser;

        if (!Username) {
            return res.status(400).json({ status: 'error', message: 'Username is required.' });
        }

        const users = await getLoginCredentials({ forceRefresh: true });
        const idx = users.findIndex(u => u.Username && u.Username.toLowerCase() === Username.trim().toLowerCase());
        if (idx === -1) {
            return res.status(404).json({ status: 'error', message: 'User not found.' });
        }

        const incomingPin = String(updatedUser.PIN != null ? updatedUser.PIN : '').trim();
        const merged = {
            ...users[idx],
            ...updatedUser,
            Username: users[idx].Username, // Username cannot be changed
            PIN: incomingPin ? incomingPin : users[idx].PIN
        };

        const dbRow = clientUserToPortal(merged);
        delete dbRow.username; // do not patch username
        await patchPortalUserWithFallback(users[idx].Username, dbRow);

        await initializeLocalUsers();
        refreshMirror(['portal_users'], 'admin user change');

        await logActivity({
            username: req.user.Username,
            name: req.user.Name,
            type: 'user_management',
            details: `Updated user account: ${Username}`
        });

        res.json({ status: 'success', message: 'User updated successfully.', user: portalUserForClient(merged) });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// 4. DELETE a user
app.post('/api/admin/users/delete', requireAdmin, async (req, res) => {
    try {
        const { Username } = req.body;

        if (!Username) {
            return res.status(400).json({ status: 'error', message: 'Username is required.' });
        }

        const users = await getLoginCredentials({ forceRefresh: true });
        const target = users.find(u => u.Username && u.Username.toLowerCase() === Username.trim().toLowerCase());

        if (!target) {
            return res.status(404).json({ status: 'error', message: 'User not found.' });
        }

        await querySupabase(
            `${PORTAL_USERS_TABLE}?username=eq.${encodeURIComponent(target.Username)}`,
            {
                schema: PORTAL_USERS_SCHEMA,
                method: 'DELETE',
                prefer: 'return=minimal'
            }
        );

        await initializeLocalUsers();
        refreshMirror(['portal_users'], 'admin user change');

        await logActivity({
            username: req.user.Username,
            name: req.user.Name,
            type: 'user_management',
            details: `Deleted user account: ${Username}`
        });

        res.json({ status: 'success', message: 'User deleted successfully.' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// 4b. APPROVE pending user
app.post('/api/admin/users/approve', requireAdmin, async (req, res) => {
    try {
        const {
            username,
            role,
            office_level,
            zone_code,
            region_code,
            division_code,
            ccc_code,
            upload_permissions,
            can_comment,
            sheets_autho
        } = req.body || {};

        if (!username) {
            return res.status(400).json({ status: 'error', message: 'Username is required.' });
        }

        const users = await getLoginCredentials({ forceRefresh: true });
        const user = users.find(u => String(u.Username).toLowerCase() === username.trim().toLowerCase());
        if (!user) {
            return res.status(404).json({ status: 'error', message: 'User not found.' });
        }

        const updates = {
            user_status: 'active',
            approved_by: req.user.Username,
            approved_at: new Date().toISOString(),
            role: role || user.role || 'viewer',
            office_level: office_level || user.office_level || 'CCC',
            zone_code: zone_code !== undefined ? String(zone_code).trim() : (user.zone_code || ''),
            region_code: region_code !== undefined ? String(region_code).trim() : (user.region_code || ''),
            division_code: division_code !== undefined ? String(division_code).trim() : (user.division_code || ''),
            ccc_code: ccc_code !== undefined ? String(ccc_code).trim() : (user.ccc_code || ''),
            can_comment: can_comment !== undefined ? !!can_comment : !!user.can_comment,
            sheets_autho: sheets_autho !== undefined ? String(sheets_autho).trim() : (user['sheets-autho'] || ''),
            upload_permissions: Array.isArray(upload_permissions) ? upload_permissions : user.upload_permissions || []
        };

        if (Array.isArray(upload_permissions)) {
            updates.disconnection_sync_autho = upload_permissions.includes('disconnection') ? 'Y' : '';
            updates.pending_mc_sync_autho = upload_permissions.includes('pending_mc') ? 'Y' : '';
            updates.load_ext_sync_autho = upload_permissions.includes('load_ext') ? 'Y' : '';
            updates.defective_upload_autho = upload_permissions.includes('defective') ? 'Y' : '';
            updates.nsc_upload_autho = upload_permissions.includes('nsc') ? 'Y' : '';
            updates.stock_upload_autho = upload_permissions.includes('stock') ? 'Y' : '';
            updates.stock_allot_autho = upload_permissions.includes('stock_allot') ? 'Y' : '';
            updates.stock_cancel_autho = upload_permissions.includes('stock_cancel') ? 'Y' : '';
        }

        await patchPortalUserWithFallback(user.Username, updates);
        await initializeLocalUsers();
        refreshMirror(['portal_users'], 'admin user change');

        await logActivity({
            username: req.user.Username,
            name: req.user.Name,
            type: 'user_management',
            details: `Approved user: ${user.Username} (Role: ${updates.role}, Office: ${updates.office_level})`
        });

        return res.json({ status: 'success', message: `User ${user.Username} approved and activated successfully.` });
    } catch (err) {
        console.error('[Admin Approve] Error:', err);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

// 4c. REJECT pending user registration
app.post('/api/admin/users/reject', requireAdmin, async (req, res) => {
    try {
        const { username, reason } = req.body || {};
        if (!username) {
            return res.status(400).json({ status: 'error', message: 'Username is required.' });
        }
        await patchPortalUserWithFallback(username.trim(), {
            user_status: 'rejected',
            approved_by: req.user.Username,
            approved_at: new Date().toISOString()
        });
        await initializeLocalUsers();
        refreshMirror(['portal_users'], 'admin user change');

        await logActivity({
            username: req.user.Username,
            name: req.user.Name,
            type: 'user_management',
            details: `Rejected registration for: ${username}${reason ? ` (Reason: ${reason})` : ''}`
        });

        return res.json({ status: 'success', message: `User ${username} registration rejected.` });
    } catch (err) {
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

// 5. GET logs (Supabase mzo_insight.activity_logs)
app.get('/api/admin/logs', requireAdmin, async (req, res) => {
    try {
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 0, 0), 30);
        const sinceIso = days
            ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
            : '';
        try {
            const logs = await fetchActivityLogsFromSupabase(days ? 5000 : 2000, sinceIso);
            if (!days) globalCachedLogs = logs;
            return res.json({ status: 'success', logs });
        } catch (sbErr) {
            console.warn('[Activity Log] Supabase read failed, trying local cache:', sbErr.message);
        }

        if (globalCachedLogs === null) {
            if (fs.existsSync(LOGS_FILE)) {
                try {
                    globalCachedLogs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf-8'));
                } catch (e) {
                    globalCachedLogs = [];
                }
            } else {
                globalCachedLogs = [];
            }
        }
        res.json({ status: 'success', logs: globalCachedLogs || [] });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// 6. Refresh users cache from Supabase (legacy path name kept for admin UI)
app.post('/api/admin/sync', requireAdmin, async (req, res) => {
    try {
        const users = await initializeLocalUsers();
        res.json({
            status: 'success',
            message: `Synced ${users.length} users from ${PORTAL_USERS_SCHEMA}.${PORTAL_USERS_TABLE}. Login uses Supabase as source of truth.`,
            count: users.length
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// 6.45. Expose endpoint to return substations CSV from Supabase (Google Sheet fallback)
app.get('/api/power-map/data', async (req, res) => {
    const sendCsv = (csvBody) => sendDatasetCsv_(req, res, csvBody);

    try {
        // Prefer Supabase when the table exists and has rows (mirror mode: its snapshot, the body of this same query)
        let substations = await mirror.readJson('power_map_substations');
        let supabaseError = null;
        if (Array.isArray(substations)) {
            res.setHeader('X-Mzo-Data', 'mirror');
        } else {
            try {
                substations = await querySupabase(POWER_MAP_TABLE + '?select=*&limit=5000');
            } catch (sbErr) {
                supabaseError = sbErr;
                console.warn('[Power Map Data] Supabase unavailable:', sbErr.message);
            }
        }

        if (Array.isArray(substations) && substations.length > 0) {
            const columns = POWER_MAP_COLUMNS;

            const validSubstations = substations.filter(row =>
                row.Substation &&
                String(row.Substation).trim().length > 0 &&
                row.LATITUDE &&
                row.LONGITUDE
            );

            const csvRows = [columns.join(',')];
            validSubstations.forEach(row => {
                const values = columns.map(col => {
                    const val = row[col];
                    let cleanVal = val !== undefined && val !== null ? String(val) : '';
                    if (cleanVal.includes(',') || cleanVal.includes('"') || cleanVal.includes('\n')) {
                        cleanVal = `"${cleanVal.replace(/"/g, '""')}"`;
                    }
                    return cleanVal;
                });
                csvRows.push(values.join(','));
            });

            return sendCsv(csvRows.join('\n'));
        }

        // Fallback: published Google Sheet (used when Supabase table is missing/empty)
        console.warn('[Power Map Data] Falling back to Google Sheet CSV'
            + (supabaseError ? ` (reason: ${supabaseError.message})` : ' (empty Supabase result)'));
        const csvText = await fetchSheet(POWER_MAP_SHEET_CSV_URL);
        if (!csvText || !String(csvText).trim()) {
            return sendCsv('Region,Division,Substation,MVA,LATITUDE,LONGITUDE\n');
        }
        return sendCsv(csvText);
    } catch (err) {
        console.error("[Power Map Data] Error fetching network data:", err.message);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.status(500).json({
            status: 'error',
            message: 'Error fetching substations: ' + err.message
        });
    }
});

app.get('/api/power-map/meta', async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }
    // Mirror mode: the manifest version of the table snapshot, and the CSV /api/power-map/data builds from it
    // (live, csvUrl is the published Google Sheet, which lags the table that edits go to).
    const pm = await mirror.entry('power_map_substations');
    const pmRows = pm ? await mirror.readJson('power_map_substations') : null;
    if (pm && Array.isArray(pmRows)) {
        res.setHeader('Cache-Control', 'private, max-age=15, must-revalidate');
        res.setHeader('X-Mzo-Data', 'mirror');
        // liveVersions: the version the live read gives (updated_at, else rows:<n>), for pages that show it as a date.
        const liveVersion = powerMapLatestUpdatedAt_(pmRows) || (pmRows.length ? 'rows:' + pmRows.length : '');
        return res.json({
            status: 'success', version: pm.version, rows: pmRows.length, csvUrl: POWER_MAP_DATA_URL,
            liveVersions: { version: liveVersion || null }
        });
    }
    let version = '';
    let rows = 0;
    try {
        const latest = await querySupabase(
            POWER_MAP_TABLE + '?select=updated_at&order=updated_at.desc&limit=1'
        );
        const row = Array.isArray(latest) && latest[0] ? latest[0] : latest;
        version = String((row && row.updated_at) || '').trim();
        const counted = await querySupabase(POWER_MAP_TABLE + '?select=Substation');
        rows = Array.isArray(counted) ? counted.length : 0;
        if (!version && rows) version = 'rows:' + rows;
    } catch (e) {
        console.warn('[Power Map meta]', e.message);
    }
    res.setHeader('Cache-Control', 'private, max-age=15, must-revalidate');
    return res.json({
        status: 'success',
        version: version || null,
        rows,
        csvUrl: POWER_MAP_SHEET_CSV_URL
    });
});

// --- Power map edits ---
// The substations table's columns (also the CSV /api/power-map/data builds). Edits may name only these.
const POWER_MAP_COLUMNS = [
    'Region', 'Division', 'Substation', 'MVA', 'LATITUDE', 'LONGITUDE',
    'Connected to', 'Colour', 'RL', 'LineStyle', 'Para-1', 'Para-2', 'Para-3',
    'Comment', 'Symbol', 'SymbolSize', 'LegendText', 'LegendSymbol',
    'LegendColour', 'Remarks', 'ConductorSize', 'PeakLoad'
];
// Substation is the row key: renaming goes through an admin in Supabase, not a cell edit.
const POWER_MAP_EDITABLE = new Set(POWER_MAP_COLUMNS.filter((c) => c !== 'Substation'));

/** A correction id from the request: a positive integer, else null (never interpolated unchecked). */
function correctionId_(raw) {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The known columns of a substation row (a suggested new substation keeps nothing else). */
function powerMapRowOnly_(row) {
    const out = {};
    if (row && typeof row === 'object') POWER_MAP_COLUMNS.forEach((c) => { if (row[c] !== undefined) out[c] = row[c]; });
    return out;
}
// "Connected to", RL, ConductorSize and PeakLoad hold one " : "-separated entry per connection.
async function fetchSubstation_(name) {
    const rows = await querySupabase(`${POWER_MAP_TABLE}?Substation=eq.${encodeURIComponent(name)}&select=*`);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function patchSubstation_(name, body) {
    return querySupabase(`${POWER_MAP_TABLE}?Substation=eq.${encodeURIComponent(name)}`, { method: 'PATCH', body });
}

/** New value of `column` with the entry for connection `target` replaced; null when there is no such connection. */
function setConnectionValue_(record, column, target, value) {
    const conns = String(record['Connected to'] || '').split(':').map((x) => x.trim().toLowerCase());
    const idx = conns.indexOf(String(target).trim().toLowerCase());
    if (idx === -1) return null;
    const vals = String(record[column] || '').split(':').map((x) => x.trim());
    while (vals.length < conns.length) vals.push('');
    vals[idx] = value;
    return vals.join(' : ');
}

/** Patch body that appends one connection (target + its RL / conductor / peak load). */
function appendConnection_(record, target, details) {
    const add = (col, v) => {
        const cur = String(record[col] || '').trim();
        return cur ? `${cur} : ${v || ''}` : (v || '');
    };
    return {
        'Connected to': add('Connected to', target),
        RL: add('RL', details.rl),
        ConductorSize: add('ConductorSize', details.conductorSize),
        PeakLoad: add('PeakLoad', details.peakLoad)
    };
}

/** Non-admins may propose edits only inside their own division or region. */
function inJurisdiction_(user, division, region) {
    const userDiv = String(user.division_code || '').trim().toLowerCase();
    const userReg = String(user.region_code || '').trim().toLowerCase();
    // Regions by canonical name (lib/offices.js): "Raiganj" and "Uttar Dinajpur" are the same region.
    const regOf = (v) => (OFFICES.canonRegion(v) || String(v || '').trim()).toLowerCase();
    return (userDiv && String(division || '').trim().toLowerCase() === userDiv) ||
        (userReg && regOf(region) === regOf(user.region_code));
}

function suggestCorrection_(user, suggestion) {
    return querySupabase(POWER_MAP_CORRECTIONS_TABLE, {
        method: 'POST',
        body: { ...suggestion, suggested_by: user.Username, suggested_by_name: user.Name || user.Username, status: 'pending' }
    });
}

// Power Map edit: admins write; others file a suggestion for an admin to approve.
app.post('/api/admin/edit-sheet-row', async (req, res) => {
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    try {
        const { rowKeyColumn, rowKeyValue, columnName, newValue, connectionTarget } = req.body;
        if (!rowKeyColumn || !rowKeyValue || !columnName) {
            return res.status(400).json({ status: 'error', message: 'Missing required parameters.' });
        }
        if (!POWER_MAP_EDITABLE.has(String(columnName))) {
            return res.status(400).json({ status: 'error', message: 'That column cannot be edited.' });
        }

        if (req.user.role !== 'admin') {
            const record = await fetchSubstation_(rowKeyValue);
            if (!record) return res.status(404).json({ status: 'error', message: 'Substation not found.' });
            if (!inJurisdiction_(req.user, record.Division, record.Region)) {
                return res.status(403).json({ status: 'error', message: 'Forbidden: You do not have edit permission for this jurisdiction.' });
            }
            await suggestCorrection_(req.user, {
                type: 'edit_substation',
                substation: rowKeyValue,
                column_name: columnName,
                connection_target: connectionTarget || null,
                proposed_value: newValue
            });
            refreshMirror(['power_map_corrections'], 'power map suggestion');
            return res.json({ status: 'success', isSuggestion: true, message: 'Edit submitted as suggested correction. Pending Admin approval.' });
        }

        let finalValue = newValue;
        if (connectionTarget) {
            const record = await fetchSubstation_(rowKeyValue);
            if (!record) return res.status(404).json({ status: 'error', message: `Substation '${rowKeyValue}' not found.` });
            finalValue = setConnectionValue_(record, columnName, connectionTarget, newValue);
            if (finalValue === null) {
                return res.status(400).json({ status: 'error', message: `Connection target '${connectionTarget}' not found.` });
            }
        }
        await patchSubstation_(rowKeyValue, { [columnName]: finalValue });
        refreshMirror(['power_map_substations'], 'power map edit');
        return res.json({ status: 'success', message: 'Database row updated successfully.' });
    } catch (err) {
        console.error('[Admin Edit] Error updating Supabase row:', err.message);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

// 6.6. Append sheet row (Power Map Admin Add Substation - Supabase version)
app.post('/api/admin/append-sheet-row', async (req, res) => {
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    try {
        const { rowData } = req.body;

        if (!rowData) {
            return res.status(400).json({ status: 'error', message: 'Missing rowData.' });
        }

        if (req.user.role !== 'admin') {
            if (!inJurisdiction_(req.user, rowData.Division, rowData.Region)) {
                return res.status(403).json({ status: 'error', message: 'Forbidden: You cannot create a substation outside your jurisdiction.' });
            }
            await suggestCorrection_(req.user, {
                type: 'add_substation',
                substation: rowData.Substation,
                proposed_value: JSON.stringify(powerMapRowOnly_(rowData))
            });
            refreshMirror(['power_map_corrections'], 'power map suggestion');
            return res.json({ status: 'success', isSuggestion: true, message: 'Substation creation submitted for Admin approval.' });
        }

        // All 22 columns of the substations table
        const payload = {
            "Substation": rowData.Substation || '',
            "Region": rowData.Region || '',
            "Division": rowData.Division || '',
            "MVA": rowData.MVA || '',
            "LATITUDE": rowData.LATITUDE || '',
            "LONGITUDE": rowData.LONGITUDE || '',
            "Connected to": rowData["Connected to"] || '',
            "Colour": rowData.Colour || '',
            "RL": rowData.RL || '',
            "LineStyle": rowData.LineStyle || 'solid',
            "Para-1": rowData["Para-1"] || '',
            "Para-2": rowData["Para-2"] || '',
            "Para-3": rowData["Para-3"] || '',
            "Comment": rowData.Comment || 'black',
            "Symbol": rowData.Symbol || '⚡',
            "SymbolSize": rowData.SymbolSize ? parseInt(rowData.SymbolSize, 10) : 18,
            "LegendText": rowData.LegendText || '',
            "LegendSymbol": rowData.LegendSymbol || '',
            "LegendColour": rowData.LegendColour || '',
            "Remarks": rowData.Remarks || '',
            "ConductorSize": rowData.ConductorSize || '',
            "PeakLoad": rowData.PeakLoad || ''
        };

        await querySupabase(POWER_MAP_TABLE, {
            method: 'POST',
            body: payload
        });
        refreshMirror(['power_map_substations'], 'power map substation added');

        return res.json({ status: 'success', message: 'Substation appended successfully.' });
    } catch (err) {
        console.error("[Admin Add Substation] Error appending to Supabase:", err.message);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

// 6.7. Add connection (Power Map Admin Add Connection - Supabase version)
app.post('/api/admin/add-connection', async (req, res) => {
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    try {
        const { sourceSubstation, targetSubstation, rl, conductorSize, peakLoad } = req.body;
        if (!sourceSubstation || !targetSubstation) {
            return res.status(400).json({ status: 'error', message: 'Missing sourceSubstation or targetSubstation.' });
        }
        const record = await fetchSubstation_(sourceSubstation);

        if (req.user.role !== 'admin') {
            if (!record) return res.status(404).json({ status: 'error', message: 'Source Substation not found.' });
            if (!inJurisdiction_(req.user, record.Division, record.Region)) {
                return res.status(403).json({ status: 'error', message: 'Forbidden: You do not have connection edit permissions for this jurisdiction.' });
            }
            await suggestCorrection_(req.user, {
                type: 'add_connection',
                substation: sourceSubstation,
                connection_target: targetSubstation,
                proposed_value: JSON.stringify({ rl, conductorSize, peakLoad })
            });
            refreshMirror(['power_map_corrections'], 'power map suggestion');
            return res.json({ status: 'success', isSuggestion: true, message: 'Feeder connection submitted for Admin approval.' });
        }

        if (!record) return res.status(404).json({ status: 'error', message: `Source Substation '${sourceSubstation}' not found.` });
        await patchSubstation_(sourceSubstation, appendConnection_(record, targetSubstation, { rl, conductorSize, peakLoad }));
        refreshMirror(['power_map_substations'], 'power map connection added');
        return res.json({ status: 'success', message: 'Connection added successfully.' });
    } catch (err) {
        console.error('[Admin Add Connection] Error adding connection to Supabase:', err.message);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

// 6.47. Expose public list of pending corrections
app.get('/api/power-map/pending-corrections', async (req, res) => {
    try {
        const corrections = await querySupabase(POWER_MAP_CORRECTIONS_TABLE + "?status=eq.pending&select=*");
        return res.json({ status: 'success', data: corrections || [] });
    } catch (err) {
        console.error("[Pending Corrections] Error fetching:", err.message);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

// 6.48. Expose list of pending corrections for Admin
app.get('/api/admin/pending-corrections', requireAdmin, async (req, res) => {
    try {
        const corrections = await querySupabase(POWER_MAP_CORRECTIONS_TABLE + "?status=eq.pending&select=*");
        return res.json({ status: 'success', data: corrections || [] });
    } catch (err) {
        console.error("[Admin Pending Corrections] Error fetching:", err.message);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

// 6.49. Approve a suggested correction
app.post('/api/admin/approve-correction', requireAdmin, async (req, res) => {
    try {
        const id = correctionId_(req.body && req.body.id);
        if (!id) {
            return res.status(400).json({ status: 'error', message: 'Missing suggestion ID.' });
        }

        // Fetch the correction details
        const corrections = await querySupabase(`${POWER_MAP_CORRECTIONS_TABLE}?id=eq.${id}&select=*`);
        if (!corrections || corrections.length === 0) {
            return res.status(404).json({ status: 'error', message: 'Suggested correction not found.' });
        }
        const proposal = corrections[0];

        if (proposal.type === 'edit_substation') {
            // Suggestions filed before the column check could name any column.
            if (!POWER_MAP_EDITABLE.has(String(proposal.column_name))) throw new Error(`Column '${proposal.column_name}' cannot be edited.`);
            let finalValue = proposal.proposed_value;
            if (proposal.connection_target) {
                const record = await fetchSubstation_(proposal.substation);
                if (!record) throw new Error(`Target Substation '${proposal.substation}' not found.`);
                finalValue = setConnectionValue_(record, proposal.column_name, proposal.connection_target, proposal.proposed_value);
                if (finalValue === null) throw new Error(`Connection target '${proposal.connection_target}' not found.`);
            }
            await patchSubstation_(proposal.substation, { [proposal.column_name]: finalValue });
        } else if (proposal.type === 'add_substation') {
            await querySupabase(POWER_MAP_TABLE, { method: 'POST', body: powerMapRowOnly_(JSON.parse(proposal.proposed_value)) });
        } else if (proposal.type === 'add_connection') {
            const record = await fetchSubstation_(proposal.substation);
            if (!record) throw new Error(`Source Substation '${proposal.substation}' not found.`);
            await patchSubstation_(proposal.substation, appendConnection_(record, proposal.connection_target, JSON.parse(proposal.proposed_value)));
        }

        // The suggestion is done
        await querySupabase(`${POWER_MAP_CORRECTIONS_TABLE}?id=eq.${id}`, {
            method: 'DELETE'
        });
        refreshMirror(['power_map_substations', 'power_map_corrections'], 'power map correction approved');

        // Log activity
        await logActivity({
            username: req.user.Username,
            name: req.user.Name || 'Super Admin',
            type: 'approve_correction',
            details: `Approved proposed change by ${proposal.suggested_by_name} for ${proposal.substation}`
        });

        return res.json({ status: 'success', message: 'Proposed correction approved successfully.' });
    } catch (err) {
        console.error("[Admin Approve] Error processing approval:", err.message);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

// 6.50. Reject a suggested correction
app.post('/api/admin/reject-correction', requireAdmin, async (req, res) => {
    try {
        const id = correctionId_(req.body && req.body.id);
        if (!id) {
            return res.status(400).json({ status: 'error', message: 'Missing suggestion ID.' });
        }

        // Fetch suggestion to log it before deletion
        const corrections = await querySupabase(`${POWER_MAP_CORRECTIONS_TABLE}?id=eq.${id}&select=*`);
        if (!corrections || corrections.length === 0) {
            return res.status(404).json({ status: 'error', message: 'Suggested correction not found.' });
        }
        const proposal = corrections[0];

        // Delete the suggestion
        await querySupabase(`${POWER_MAP_CORRECTIONS_TABLE}?id=eq.${id}`, {
            method: 'DELETE'
        });
        refreshMirror(['power_map_corrections'], 'power map correction rejected');

        // Log activity
        await logActivity({
            username: req.user.Username,
            name: req.user.Name || 'Super Admin',
            type: 'reject_correction',
            details: `Rejected proposed change by ${proposal.suggested_by_name} for ${proposal.substation}`
        });

        return res.json({ status: 'success', message: 'Proposed correction rejected successfully.' });
    } catch (err) {
        console.error("[Admin Reject] Error processing rejection:", err.message);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

// 6.51. Admin DB2 / Pipeline sync schedules (Admin > Data Sync). These are saved preferences only: nothing
// on the server runs them (the CRM extractions need the office network and a DB2 client, which the VM does
// not have), so "enabled" is off by default and only records what the admin chose.
const SYNC_SCHEDULES_FILE = 'sync_schedules.json';
const SYNC_SCHEDULE_KEYS = new Set(['defective', 'unbilled', 'disconnection', 'disconnection_payments']);
const SYNC_SCHEDULE_DAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
const SYNC_SCHEDULE_FREQ = new Set(['daily', 'weekly', 'interval']);

function readSyncSchedules_() {
    try {
        const v = JSON.parse(fs.readFileSync(path.join(DATA_DIR, SYNC_SCHEDULES_FILE), 'utf8'));
        const out = {};
        if (v && typeof v === 'object') for (const k of Object.keys(v)) if (SYNC_SCHEDULE_KEYS.has(k)) out[k] = v[k];
        return out;
    } catch (_) {
        return {};
    }
}

/** A clean schedule from the request body, or null when a field is missing or out of range. */
function cleanSyncSchedule_(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const interval = Number(s.interval);
    if (typeof s.enabled !== 'boolean' || !SYNC_SCHEDULE_FREQ.has(s.frequency)) return null;
    if (typeof s.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) return null;
    if (!SYNC_SCHEDULE_DAYS.has(s.day)) return null;
    if (!Number.isInteger(interval) || interval < 1 || interval > 168) return null;
    return { enabled: s.enabled, frequency: s.frequency, time: s.time, day: s.day, interval };
}

app.get('/api/admin/sync-schedules', requireAdmin, async (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, private');
    return res.json({ status: 'success', schedules: readSyncSchedules_() });
});

app.post('/api/admin/sync-schedules', requireAdmin, async (req, res) => {
    const { key, schedule } = req.body || {};
    const clean = cleanSyncSchedule_(schedule);
    if (typeof key !== 'string' || !SYNC_SCHEDULE_KEYS.has(key) || !clean) {
        return res.status(400).json({ status: 'error', message: 'Invalid schedule payload' });
    }
    const current = readSyncSchedules_();
    current[key] = {
        ...clean,
        updatedAt: new Date().toISOString(),
        updatedBy: String((req.user && (req.user.Username || req.user.username)) || 'Admin').slice(0, 80)
    };
    try {
        writeDataFile_(SYNC_SCHEDULES_FILE, JSON.stringify(current, null, 2));
    } catch (e) {
        console.warn('[Sync Schedules] Could not write schedule file:', e.message);
        return res.status(500).json({ status: 'error', message: 'The schedule could not be saved.' });
    }
    return res.json({ status: 'success', schedules: current, message: 'Schedule updated successfully' });
});

// Material Allotment → Google Apps Script (Allotments ledger tab)
function stockAllotmentScriptUrl_() {
    return (
        process.env.STOCK_ALLOTMENT_SCRIPT_URL ||
        'https://script.google.com/macros/s/AKfycbxHxa_srh1nfhDTEf1eiXeRj-u2wr7qWiki1m5QIJ7FtWsaVRBVI7kDk37jeSE7ETOz/exec'
    );
}

function isPortalAdmin_(user) {
    if (!user) return false;
    return String(user.role || user.Role || '').trim().toLowerCase() === 'admin';
}

function flagAuthoYes_(raw) {
    const flag = String(raw || '').trim().toLowerCase();
    return ['y', 'yes', '1', 'true', 'upload', 'allot'].includes(flag);
}

/**
 * Upload / sync permission: admins, the user's own flag (e.g. 'nsc-upload-autho'), the legacy
 * 'dm1' account, and optionally a word in their sheets-autho value.
 */
function hasPermission_(user, flag, sheetsWords) {
    if (!user) return false;
    if (isPortalAdmin_(user)) return true;
    if (flagAuthoYes_(user[flag] != null ? user[flag] : user[flag.replace(/-/g, '_')])) return true;
    if (String(user.Username || user.username || '').trim().toLowerCase() === 'dm1') return true;
    const sheets = String(user['sheets-autho'] || user.sheets_autho || '').trim().toLowerCase();
    return (sheetsWords || []).some((w) => sheets.includes(w));
}

/**
 * The signed-in user's current portal row, so permission changes apply without a new login
 * (cached up to USERS_CACHE_TTL_MS unless force). Falls back to the session profile.
 */
async function resolveFreshUser_(req, force = false) {
    const session = req.user || null;
    if (!session || !session.Username) return session;
    // A VM-only admin is not in Supabase: never demoted, never replaced by a row of the same name.
    if (req.localAdmin || req.syncAgent) return session;
    try {
        const users = await getLoginCredentials({ forceRefresh: force });
        const key = String(session.Username).trim().toLowerCase();
        const fresh = users.find((u) => u.Username && String(u.Username).trim().toLowerCase() === key);
        if (fresh) {
            // An admin session (e.g. the root Google admin) stays admin even if the row lags behind.
            return !isPortalAdmin_(fresh) && isPortalAdmin_(session) ? { ...fresh, role: session.role || 'admin' } : fresh;
        }
    } catch (e) {
        console.warn('[Auth] profile refresh failed:', e.message);
    }
    return session;
}

function canAccessStockAllotment_(user) {
    if (!user) return false;
    if (flagAuthoYes_(user['stock-allot-autho'] != null ? user['stock-allot-autho'] : user.stock_allot_autho)) {
        return true;
    }
    // Legacy allowlist (until admin grants stock-allot-autho)
    const allowed = ['zm', 'aritra', 'dm1'];
    const username = String((user.Username || user.username) || '')
        .trim()
        .toLowerCase();
    // By exact username only: display names come from the Google profile, which the user chooses.
    return allowed.includes(username);
}

/** Soft-cancel allotments — separate from create (stock_cancel_autho; admin also allowed). */
function canCancelStockAllotment_(user) {
    if (!user) return false;
    if (isPortalAdmin_(user)) return true;
    return flagAuthoYes_(
        user['stock-cancel-autho'] != null ? user['stock-cancel-autho'] : user.stock_cancel_autho
    );
}

function requireStockAllotmentLogin_(req, res) {
    if (!req.user) {
        res.status(401).json({ status: 'error', error: 'Please log in to view stock allotments.' });
        return false;
    }
    return true;
}

async function requireStockAllotmentAccess_(req, res) {
    if (!requireStockAllotmentLogin_(req, res)) return false;
    const user = await resolveFreshUser_(req, true);
    if (!canAccessStockAllotment_(user)) {
        res.status(403).json({
            status: 'error',
            error: 'Creating allotments is restricted. Ask an admin to enable Stock Allot Create in User Management.'
        });
        return false;
    }
    req.user = { ...req.user, ...user };
    return true;
}

async function requireStockAllotmentCancelAccess_(req, res) {
    if (!requireStockAllotmentLogin_(req, res)) return false;
    const user = await resolveFreshUser_(req, true);
    if (!canCancelStockAllotment_(user)) {
        res.status(403).json({
            status: 'error',
            error: 'Cancelling allotments is restricted. Ask an admin to enable Stock Allot Cancel in User Management.'
        });
        return false;
    }
    req.user = { ...req.user, ...user };
    return true;
}

/** In-memory list cache — avoids Apps Script cold-start on every View open */
let allotListCache_ = { at: 0, rows: null, source: '' };
const ALLOT_LIST_TTL_MS = 60 * 1000;

function invalidateAllotListCache_() {
    allotListCache_ = { at: 0, rows: null, source: '' };
}

function parseAllotmentCsv_(text) {
    const raw = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!raw || raw.startsWith('<')) return null;
    const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 1) return [];
    const headers = parseCsvLine_(lines[0]).map((h) => String(h || '').trim());
    if (!headers.includes('AllotmentNo')) return null;
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine_(lines[i]);
        const obj = {};
        headers.forEach((h, idx) => {
            obj[h] = cols[idx] != null ? cols[idx] : '';
        });
        if (!obj.AllotmentNo) continue;
        ['AllottedQty', 'PresentStockDiv', 'SourceStockAtAllot', 'ZoneStockAtAllot'].forEach((k) => {
            if (obj[k] === '' || obj[k] == null) return;
            const n = Number(String(obj[k]).replace(/,/g, ''));
            if (!Number.isNaN(n)) obj[k] = n;
        });
        rows.push(obj);
    }
    rows.sort((a, b) => {
        const da = String(a.Date || '');
        const db = String(b.Date || '');
        if (da !== db) return db.localeCompare(da);
        return String(b.AllotmentNo || '').localeCompare(String(a.AllotmentNo || ''));
    });
    return rows;
}

function filterAllotmentRowsLocal_(rows, payload) {
    const q = String(payload.q || payload.query || '').toLowerCase().trim();
    const allotmentNo = String(payload.allotmentNo || payload.AllotmentNo || '').toLowerCase().trim();
    const material = String(payload.material || payload.MaterialCode || '').toLowerCase().trim();
    const division = String(payload.division || payload.Division || '').toLowerCase().trim();
    const fromStore = String(payload.fromStore || payload.FromStore || '').toLowerCase().trim();
    const dateFrom = String(payload.dateFrom || payload.from || '').trim();
    const dateTo = String(payload.dateTo || payload.to || '').trim();

    return (rows || []).filter((r) => {
        const no = String(r.AllotmentNo || '').toLowerCase();
        const code = String(r.MaterialCode || '').toLowerCase();
        const desc = String(r.MaterialDescription || '').toLowerCase();
        const div = String(r.Division || '').toLowerCase();
        const from = String(r.FromStore || '').toLowerCase();
        const date = String(r.Date || '').slice(0, 10);
        const remarks = String(r.Remarks || '').toLowerCase();
        const createdBy = String(r.CreatedBy || '').toLowerCase();

        if (allotmentNo && !no.includes(allotmentNo)) return false;
        if (material && !code.includes(material) && !desc.includes(material)) return false;
        if (division && !div.includes(division)) return false;
        if (fromStore && !from.includes(fromStore)) return false;
        if (dateFrom && date && date < dateFrom) return false;
        if (dateTo && date && date > dateTo) return false;
        if (q) {
            const blob = [no, code, desc, div, from, remarks, createdBy, date].join(' ');
            if (!blob.includes(q)) return false;
        }
        return true;
    });
}

async function fetchAllotmentCsvText_() {
    const directUrl = process.env.STOCK_ALLOTMENTS_CSV_URL || '';
    if (directUrl) {
        const res = await fetch(directUrl, { redirect: 'follow' });
        if (!res.ok) throw new Error(`CSV HTTP ${res.status}`);
        return await res.text();
    }
    const scriptUrl = stockAllotmentScriptUrl_();
    const sep = scriptUrl.includes('?') ? '&' : '?';
    const res = await fetch(`${scriptUrl}${sep}format=csv`, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Apps Script CSV HTTP ${res.status}`);
    return await res.text();
}

function allotDbToClient_(row) {
    const createdAt = row.created_at || '';
    let date = String(row.date || '').trim();
    if (!date && createdAt) {
        date = allotmentCalendarDate_(createdAt);
    } else {
        date = normalizeAllotmentDate_(date, createdAt);
    }
    const statusRaw = String(row.status || 'active').trim().toLowerCase();
    const status = statusRaw === 'cancelled' ? 'cancelled' : 'active';
    return {
        AllotmentNo: row.allotment_no || '',
        Date: date,
        MovementType: row.movement_type || '',
        FromStore: row.from_store || '',
        FromPlantCode: row.from_plant_code || '',
        Division: row.division || '',
        PlantCode: row.plant_code || '',
        MaterialCode: row.material_code || '',
        MaterialDescription: row.material_description || '',
        Unit: row.unit || '',
        PresentStockDiv: row.present_stock_div,
        SourceStockAtAllot: row.source_stock_at_allot,
        ZoneStockAtAllot: row.zone_stock_at_allot,
        AllottedQty: row.allotted_qty,
        Remarks: row.remarks || '',
        CreatedBy: row.created_by || '',
        CreatedAt: createdAt,
        Status: status,
        CancelledAt: row.cancelled_at || '',
        CancelledBy: row.cancelled_by || '',
        CancelReason: row.cancel_reason || ''
    };
}

/** Calendar YYYY-MM-DD in Asia/Kolkata (allotment office timezone). */
function allotmentCalendarDate_(isoOrDate) {
    const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
    if (isNaN(d.getTime())) return '';
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(d);
    } catch (_) {
        return d.toISOString().slice(0, 10);
    }
}

/** Accept YYYY-MM-DD or DD/MM/YYYY; fall back to createdAt / today (IST). */
function normalizeAllotmentDate_(raw, fallbackIso) {
    const s = String(raw || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (dmy) {
        return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    }
    if (fallbackIso) {
        const fromCreated = allotmentCalendarDate_(fallbackIso);
        if (fromCreated) return fromCreated;
    }
    return allotmentCalendarDate_(new Date()) || '';
}

function allotClientToDb_(row, allotmentNo, createdBy, createdAtIso) {
    const num = (v) => {
        if (v === '' || v == null) return null;
        const n = Number(String(v).replace(/,/g, ''));
        return Number.isNaN(n) ? null : n;
    };
    const createdAt = createdAtIso || new Date().toISOString();
    return {
        allotment_no: allotmentNo,
        date: normalizeAllotmentDate_(row.Date || row.date, createdAt),
        movement_type: String(row.MovementType || row.movementType || ''),
        from_store: String(row.FromStore || row.fromStore || ''),
        from_plant_code: String(row.FromPlantCode || row.fromPlantCode || ''),
        division: String(row.Division || row.division || ''),
        plant_code: String(row.PlantCode || row.plantCode || ''),
        material_code: String(row.MaterialCode || row.materialCode || ''),
        material_description: String(row.MaterialDescription || row.materialDescription || ''),
        unit: String(row.Unit || row.unit || ''),
        present_stock_div: num(row.PresentStockDiv != null ? row.PresentStockDiv : row.presentStockDiv),
        source_stock_at_allot: num(row.SourceStockAtAllot != null ? row.SourceStockAtAllot : row.sourceStockAtAllot),
        zone_stock_at_allot: num(row.ZoneStockAtAllot != null ? row.ZoneStockAtAllot : row.zoneStockAtAllot),
        allotted_qty: num(row.AllottedQty != null ? row.AllottedQty : row.allottedQty),
        remarks: String(row.Remarks || row.remarks || ''),
        created_by: createdBy || '',
        created_at: createdAt,
        status: 'active',
        cancelled_at: null,
        cancelled_by: '',
        cancel_reason: ''
    };
}

/** Find ledger lines for one allotment_no (handles slash in MZO/ALT/…). */
async function findAllotmentDbRows_(allotmentNo) {
    const target = String(allotmentNo || '').trim();
    if (!target) return [];

    const selectCols = 'id,allotment_no,status,cancelled_by,cancelled_at';
    const attempts = [
        // Working form for this project: eq.MZO%2FALT%2F2026%2F0011
        `stock_allotments?allotment_no=eq.${encodeURIComponent(target)}&select=${selectCols}&limit=500`,
        // Alternate quoted form (kept as fallback only)
        `stock_allotments?allotment_no=eq.${encodeURIComponent('"' + target.replace(/"/g, '') + '"')}&select=${selectCols}&limit=500`,
        // Suffix match as last filter attempt
        `stock_allotments?allotment_no=like.${encodeURIComponent('*' + target.split('/').pop())}&select=${selectCols}&limit=500`
    ];

    for (const path of attempts) {
        try {
            const rows = await querySupabase(path, { schema: PORTAL_USERS_SCHEMA });
            if (!Array.isArray(rows) || !rows.length) continue;
            const exact = rows.filter((r) => String(r.allotment_no || '').trim() === target);
            if (exact.length) return exact;
            // like-suffix may over-match; ignore non-exact
        } catch (e) {
            if (/status|cancelled_at|cancelled_by|cancel_reason|42703|PGRST204/i.test(e.message || '')) {
                throw new Error(
                    'Cancel columns missing. Run scripts/sql/upgrade_existing_tables.sql in the Supabase SQL Editor.'
                );
            }
            console.warn('[stock cancel] lookup attempt failed:', e.message);
        }
    }

    // Fallback: scan newest rows and match in memory
    const pageSize = 1000;
    let offset = 0;
    const matched = [];
    for (let page = 0; page < 40; page++) {
        let batch;
        try {
            batch = await querySupabase(
                `stock_allotments?select=${selectCols}&order=id.desc&limit=${pageSize}&offset=${offset}`,
                { schema: PORTAL_USERS_SCHEMA }
            );
        } catch (e) {
            if (/status|cancelled_at|cancelled_by|42703|PGRST204/i.test(e.message || '')) {
                throw new Error(
                    'Cancel columns missing. Run scripts/sql/upgrade_existing_tables.sql in the Supabase SQL Editor.'
                );
            }
            throw e;
        }
        if (!Array.isArray(batch) || !batch.length) break;
        for (const r of batch) {
            if (String(r.allotment_no || '').trim() === target) matched.push(r);
        }
        if (matched.length) break;
        if (batch.length < pageSize) break;
        offset += pageSize;
    }
    if (!matched.length) {
        console.warn('[stock cancel] no rows for', target);
    }
    return matched;
}

async function cancelAllotmentInSupabase_(allotmentNo, cancelledBy, reason) {
    const no = String(allotmentNo || '').trim();
    if (!no) throw new Error('allotmentNo is required');

    const existing = await findAllotmentDbRows_(no);
    if (!Array.isArray(existing) || !existing.length) {
        throw new Error(`Allotment not found: ${no}`);
    }

    const already = existing.every(
        (r) => String(r.status || '').trim().toLowerCase() === 'cancelled'
    );
    if (already) {
        const sample = existing[0] || {};
        return {
            status: 'success',
            allotmentNo: no,
            alreadyCancelled: true,
            cancelledBy: sample.cancelled_by || cancelledBy || '',
            cancelledAt: sample.cancelled_at || '',
            linesUpdated: existing.length
        };
    }

    const ids = existing.map((r) => r.id).filter((id) => id != null);
    if (!ids.length) {
        throw new Error(`Allotment ${no} has no updatable line ids.`);
    }

    const cancelledAt = new Date().toISOString();
    const body = {
        status: 'cancelled',
        cancelled_at: cancelledAt,
        cancelled_by: String(cancelledBy || '').trim(),
        cancel_reason: String(reason || '').trim()
    };

    let patched;
    try {
        patched = await querySupabase(`stock_allotments?id=in.(${ids.join(',')})`, {
            schema: PORTAL_USERS_SCHEMA,
            method: 'PATCH',
            body,
            prefer: 'return=representation'
        });
    } catch (e) {
        if (/status|cancelled_at|cancelled_by|cancel_reason|PGRST|42703/i.test(e.message || '')) {
            throw new Error(
                'Cancel columns missing. Run scripts/sql/upgrade_existing_tables.sql in the Supabase SQL Editor.'
            );
        }
        throw e;
    }

    const count = Array.isArray(patched) ? patched.length : ids.length;
    if (!count) {
        throw new Error(`Cancel did not update any lines for ${no}.`);
    }
    return {
        status: 'success',
        allotmentNo: no,
        alreadyCancelled: false,
        linesUpdated: count,
        cancelledBy: String(cancelledBy || '').trim(),
        cancelledAt
    };
}

async function nextAllotmentNoSupabase_() {
    const year = new Date().getFullYear();
    let rows = await querySupabase(`stock_allot_seq?year=eq.${year}&select=*`, {
        schema: PORTAL_USERS_SCHEMA
    });
    let seq = 1;
    if (Array.isArray(rows) && rows[0]) {
        seq = Number(rows[0].next_seq) || 1;
        await querySupabase(`stock_allot_seq?year=eq.${year}`, {
            schema: PORTAL_USERS_SCHEMA,
            method: 'PATCH',
            body: { next_seq: seq + 1 },
            prefer: 'return=minimal'
        });
    } else {
        await querySupabase('stock_allot_seq', {
            schema: PORTAL_USERS_SCHEMA,
            method: 'POST',
            body: { year, next_seq: 2 },
            prefer: 'return=minimal'
        });
    }
    const padded = String(seq).padStart(4, '0');
    return `MZO/ALT/${year}/${padded}`;
}

async function fetchAllotmentsFromSupabase_() {
    const pageSize = 1000;
    let from = 0;
    const all = [];
    while (true) {
        const batch = await querySupabase(
            `stock_allotments?select=*&order=date.desc,allotment_no.desc&limit=${pageSize}&offset=${from}`,
            { schema: PORTAL_USERS_SCHEMA }
        );
        if (!Array.isArray(batch) || !batch.length) break;
        all.push(...batch.map(allotDbToClient_));
        if (batch.length < pageSize) break;
        from += pageSize;
        if (from > 200000) break;
    }
    return all;
}

async function createAllotmentInSupabase_(payload, opts) {
    const createdBy = String(payload.createdBy || '').trim();
    const allotmentNo = await nextAllotmentNoSupabase_();
    const createdAt = new Date().toISOString();
    const omitCancel = !!(opts && opts.omitCancelFields);
    const rows = (payload.rows || []).map((r) => {
        const row = allotClientToDb_(r, allotmentNo, createdBy, createdAt);
        if (omitCancel) {
            delete row.status;
            delete row.cancelled_at;
            delete row.cancelled_by;
            delete row.cancel_reason;
        }
        return row;
    });
    const BATCH = 200;
    for (let i = 0; i < rows.length; i += BATCH) {
        await querySupabase('stock_allotments', {
            schema: PORTAL_USERS_SCHEMA,
            method: 'POST',
            body: rows.slice(i, i + BATCH),
            prefer: 'return=minimal'
        });
    }
    return {
        status: 'success',
        allotmentNo,
        inserted: rows.length,
        source: 'supabase'
    };
}

/** Rows from the legacy Sheet / Apps Script ledger (before Supabase), with where they came from. */
async function fetchLegacyAllotments_({ allowEmpty = false } = {}) {
    try {
        const rows = parseAllotmentCsv_(await fetchAllotmentCsvText_());
        if (rows && (allowEmpty || rows.length)) {
            return { rows, source: process.env.STOCK_ALLOTMENTS_CSV_URL ? 'csv' : 'apps-script-csv' };
        }
    } catch (err) {
        console.warn('[stock/allotment] Legacy CSV fetch failed, trying JSON:', err.message);
    }
    const upstream = await fetch(stockAllotmentScriptUrl_(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'listAllotments' }),
        redirect: 'follow'
    });
    const text = await upstream.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        throw new Error('Apps Script returned non-JSON while listing allotments.');
    }
    if (!upstream.ok || data.error || data.status === 'error') {
        throw new Error(data.error || data.message || 'Failed to list allotments');
    }
    return { rows: Array.isArray(data.rows) ? data.rows : [], source: 'apps-script-json' };
}

let allotMirrorRows_ = { src: null, rows: null };

async function loadAllotmentRowsCached_(force = false) {
    const now = Date.now();
    // Mirror mode: the snapshot is the body of fetchAllotmentsFromSupabase_'s query (pages joined, same order).
    // The view's refresh button (force) still reads live: allotments are also made on other hosts.
    const mirrored = force ? null : await mirror.readJson('stock_allotments');
    if (Array.isArray(mirrored)) {
        if (allotMirrorRows_.src !== mirrored) allotMirrorRows_ = { src: mirrored, rows: mirrored.map(allotDbToClient_) };
        return { rows: allotMirrorRows_.rows, source: 'supabase', mirror: true };
    }
    if (!force && allotListCache_.rows && now - allotListCache_.at < ALLOT_LIST_TTL_MS) {
        return { rows: allotListCache_.rows, source: allotListCache_.source || 'cache' };
    }

    // Supabase is the source of truth once reachable (even if empty); the legacy ledger is a fallback.
    try {
        const rows = await fetchAllotmentsFromSupabase_();
        allotListCache_ = { at: now, rows, source: 'supabase' };
        return { rows, source: 'supabase' };
    } catch (err) {
        console.warn('[stock/allotment] Supabase list failed, trying legacy sheet:', err.message);
    }
    const legacy = await fetchLegacyAllotments_({ allowEmpty: true });
    allotListCache_ = { at: now, rows: legacy.rows, source: legacy.source };
    return legacy;
}

const truthy_ = (v) => v === true || v === 1 || v === '1' || v === 'true';

/** listAllotments / getAllotment from the cached ledger (GET query or POST body). */
async function sendAllotmentRead_(action, params, res) {
    const loaded = await loadAllotmentRowsCached_(truthy_(params.force) || truthy_(params.refresh));
    if (loaded.mirror) res.setHeader('X-Mzo-Data', 'mirror');
    if (action === 'getAllotment') {
        const no = String(params.allotmentNo || params.AllotmentNo || '').trim();
        if (!no) return res.status(400).json({ status: 'error', error: 'allotmentNo is required' });
        const rows = loaded.rows.filter((r) => String(r.AllotmentNo || '') === no);
        if (!rows.length) return res.status(404).json({ status: 'error', error: `Allotment not found: ${no}` });
        return res.json({ status: 'success', allotmentNo: no, rows, count: rows.length, source: loaded.source });
    }
    const rows = filterAllotmentRowsLocal_(loaded.rows, params);
    return res.json({ status: 'success', rows, count: rows.length, source: loaded.source });
}

async function proxyStockAllotment_(payload, res) {
    const scriptUrl = stockAllotmentScriptUrl_();
    if (!scriptUrl) {
        return res.status(503).json({
            status: 'error',
            error: 'STOCK_ALLOTMENT_SCRIPT_URL is not configured on the server.'
        });
    }

    const action = payload.action || '';
    const controller = new AbortController();
    const timeoutMs = action === 'createAllotment' ? 55000 : 35000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let upstream;
    let text;
    try {
        upstream = await fetch(scriptUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            redirect: 'follow',
            signal: controller.signal
        });
        text = await upstream.text();
    } catch (err) {
        clearTimeout(timer);
        if (action === 'createAllotment') {
            invalidateAllotListCache_();
            return res.status(504).json({
                status: 'error',
                maybeSucceeded: true,
                error:
                    'Upload timed out or network failed after submit. Open View Allotments before retrying — the row may already be saved.'
            });
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }

    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        const looksGone =
            upstream.status === 404 ||
            /page not found/i.test(text) ||
            /<!DOCTYPE html>/i.test(text);
        console.error('[stock/allotment] Non-JSON Apps Script response:', text.slice(0, 400));
        if (action === 'createAllotment') {
            invalidateAllotListCache_();
            return res.status(502).json({
                status: 'error',
                maybeSucceeded: true,
                error: looksGone
                    ? 'Apps Script URL looks undeployed, but the write may still have completed. Check View Allotments before retrying.'
                    : 'Apps Script returned an unexpected response after upload. Check View Allotments before retrying — it may already be saved.'
            });
        }
        return res.status(502).json({
            status: 'error',
            error: looksGone
                ? 'Allotment Apps Script URL is invalid or undeployed (Google returned Page not found). Paste latest allotment_code.gs, Deploy → Manage deployments → New version, then put the new /exec URL in STOCK_ALLOTMENT_SCRIPT_URL or server.js.'
                : 'Apps Script returned an unexpected response. Check deployment access.'
        });
    }

    if (!upstream.ok || data.error || data.status === 'error') {
        return res.status(upstream.ok ? 400 : 502).json({
            status: 'error',
            error: data.error || data.message || 'Allotment request failed'
        });
    }

    if (action === 'createAllotment') {
        invalidateAllotListCache_();
    }

    return res.json(data);
}

// Reads only; create and cancel go through POST with their own permission checks.
app.get('/api/stock/allotment', async (req, res) => {
    try {
        if (!requireStockAllotmentLogin_(req, res)) return;
        const action = req.query.action || 'listAllotments';
        if (action !== 'listAllotments' && action !== 'getAllotment') {
            return res.status(405).json({ status: 'error', error: 'Use POST for this action.' });
        }
        return await sendAllotmentRead_(action, req.query, res);
    } catch (err) {
        console.error('[stock/allotment] GET Error:', err.message);
        return res.status(500).json({ status: 'error', error: err.message });
    }
});

app.post('/api/stock/allotment', async (req, res) => {
    try {
        const payload = req.body || {};
        const action = payload.action || 'createAllotment';
        // Create / cancel use separate auth flags; list/get for any logged-in user
        if (action === 'createAllotment') {
            if (!(await requireStockAllotmentAccess_(req, res))) return;
        } else if (action === 'cancelAllotment') {
            if (!(await requireStockAllotmentCancelAccess_(req, res))) return;
        } else if (!requireStockAllotmentLogin_(req, res)) {
            return;
        }

        if (action === 'createAllotment') {
            if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
                return res.status(400).json({ status: 'error', error: 'No allotment rows provided' });
            }
            if (!payload.createdBy && req.user) {
                payload.createdBy = req.user.Name || req.user.Username || req.user.username || '';
            }
            try {
                const created = await createAllotmentInSupabase_(payload);
                invalidateAllotListCache_();
                refreshMirror(['stock_allotments', 'stock_allot_seq'], 'allotment created');
                return res.json(created);
            } catch (e) {
                const missing =
                    /does not exist|42P01|PGRST205|Could not find the table/i.test(e.message || '');
                if (missing) {
                    console.warn('[stock/allotment] Supabase tables missing, trying Apps Script:', e.message);
                    return await proxyStockAllotment_(payload, res);
                }
                // If status columns missing, retry insert without cancel fields
                if (/status|cancelled_at|cancelled_by|cancel_reason|42703/i.test(e.message || '')) {
                    console.warn('[stock/allotment] Cancel columns missing on create; inserting without them');
                    try {
                        const created = await createAllotmentInSupabase_(payload, { omitCancelFields: true });
                        invalidateAllotListCache_();
                        refreshMirror(['stock_allotments', 'stock_allot_seq'], 'allotment created');
                        return res.json(created);
                    } catch (e2) {
                        console.error('[stock/allotment] Supabase create retry failed:', e2.message);
                    }
                }
                console.error('[stock/allotment] Supabase create failed:', e.message);
                return res.status(500).json({
                    status: 'error',
                    error:
                        'Could not save allotment. ' +
                        (e.message || 'Unknown error') +
                        ' Ask an admin to verify stock allotment tables are set up.'
                });
            }
        }

        if (action === 'cancelAllotment') {
            const no = String(payload.allotmentNo || payload.AllotmentNo || '').trim();
            if (!no) {
                return res.status(400).json({ status: 'error', error: 'allotmentNo is required' });
            }
            const cancelledBy =
                payload.cancelledBy ||
                (req.user && (req.user.Name || req.user.Username || req.user.username)) ||
                '';
            const reason = String(payload.reason || payload.cancelReason || '').trim();
            try {
                const result = await cancelAllotmentInSupabase_(no, cancelledBy, reason);
                invalidateAllotListCache_();
                refreshMirror(['stock_allotments'], 'allotment cancelled');
                return res.json(result);
            } catch (e) {
                console.error('[stock/allotment] cancel failed:', e.message);
                const code = /not found/i.test(e.message || '') ? 404 : 500;
                return res.status(code).json({
                    status: 'error',
                    error: e.message || 'Cancel failed'
                });
            }
        }

        if (action === 'listAllotments' || action === 'getAllotment') {
            return await sendAllotmentRead_(action, payload, res);
        }

        return res.status(400).json({ status: 'error', error: 'Invalid action' });
    } catch (err) {
        console.error('[stock/allotment] Error:', err.message);
        return res.status(500).json({ status: 'error', error: err.message });
    }
});

// --- NSC raw upload → Google Sheets (processed in browser) ---
const NSC_META_FILE = path.join(DATA_DIR, 'nsc_meta.json');
const NSC_WORKING_SPREADSHEET_ID = '1QnmPKSAtwmW-m1-gn4qmZBWanx9_Vwbk63XhwyQBiKU';
const NSC_WITHHELD_SPREADSHEET_ID = '12nS8GAQ1weIMWoEIeydcdKTKd-XwHNu9W07DKudGuOg';
const NSC_SHEET_FALLBACK_URL =
    `https://docs.google.com/spreadsheets/d/${NSC_WORKING_SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=nsc_working`;
const NSC_WITHHELD_SHEET_FALLBACK_URL =
    `https://docs.google.com/spreadsheets/d/${NSC_WITHHELD_SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=Sheet1`;
/** Web app /exec URLs from apps-script/sheet_mirror_publish.gs (one deploy per Google file). Env overrides if set. */
const NSC_SHEET_SCRIPT_URL = String(
    process.env.NSC_SHEET_SCRIPT_URL ||
    'https://script.google.com/macros/s/AKfycbwJj6lpOWN0a62jX51926FUQyzViLOiKA38f9yqSBSYbLMnpBPvOMZQh3gYu0b07L7MJw/exec'
).trim();
const NSC_WITHHELD_SHEET_SCRIPT_URL = String(
    process.env.NSC_WITHHELD_SHEET_SCRIPT_URL ||
    'https://script.google.com/macros/s/AKfycbzTC3_lCHOBtbZGqeE1n6sE6K_MdheQc-RVlUHGhMrN568r5lXeoasIvwEktA-245unWg/exec'
).trim();
const nscPendingMetaById_ = Object.create(null);

function canUploadNsc_(user) {
    return hasPermission_(user, 'nsc-upload-autho');
}

function ensureDataDir_() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readLocalNscMeta_() {
    try {
        if (!fs.existsSync(NSC_META_FILE)) return null;
        return JSON.parse(fs.readFileSync(NSC_META_FILE, 'utf8'));
    } catch (e) {
        return null;
    }
}

/** Local copy of the NSC meta (localhost only; the Vercel filesystem is read-only). */
function writeLocalNscMeta_(meta) {
    try {
        ensureDataDir_();
        writeDataFile_(path.basename(NSC_META_FILE), JSON.stringify(meta, null, 2));
    } catch (e) {
        console.warn('[NSC] Local meta not saved:', e.message);
    }
}

// The Apps Script meta call takes 1-2 s and several endpoints need it on a page load:
// cache it for a minute and share one in-flight request.
let nscSheetMetaCache_ = { at: 0, value: null, pending: null };

/** Meta of the last NSC upload, from the nsc_working Apps Script (null if unavailable). */
async function fetchNscSheetMeta_({ fresh = false } = {}) {
    const c = nscSheetMetaCache_;
    if (!fresh && c.value && Date.now() - c.at < 60 * 1000) return c.value;
    if (!fresh && c.pending) return c.pending;
    const request = (async () => {
        try {
            const text = await fetchSheet(NSC_SHEET_SCRIPT_URL + (NSC_SHEET_SCRIPT_URL.includes('?') ? '&' : '?') + 'meta=1');
            const data = JSON.parse(text);
            const meta = data && data.meta && typeof data.meta === 'object' ? data.meta : null;
            if (meta) nscSheetMetaCache_ = { at: Date.now(), value: meta, pending: null };
            return meta || c.value;
        } catch (e) {
            return c.value; // last good copy, if any
        } finally {
            if (nscSheetMetaCache_.pending === request) nscSheetMetaCache_.pending = null;
        }
    })();
    if (!fresh) c.pending = request;
    return request;
}

const NSC_TODAY_PEEK_URL_ =
    `https://docs.google.com/spreadsheets/d/${NSC_WORKING_SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=nsc_working&range=A1:AZ2`;
let nscTodayPeekCache_ = { at: 0, value: '' };

function parseTodayFromPeekCsv_(text) {
    const raw = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!raw || raw.charAt(0) === '{' || raw.charAt(0) === '<') return '';
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return '';
    const cells = (line) => parseCsvLine_(line).map((c) => c.trim().replace(/^"|"$/g, '').trim());
    const headers = cells(lines[0]);
    const values = cells(lines[1]);
    const idx = headers.findIndex((h) => String(h).replace(/^\uFEFF/, '').trim().toUpperCase() === 'TODAY');
    if (idx < 0) return '';
    return String(values[idx] || '').trim();
}

async function peekNscTodayFromSheet_() {
    const now = Date.now();
    if (nscTodayPeekCache_.value && now - nscTodayPeekCache_.at < 60 * 1000) {
        return nscTodayPeekCache_.value;
    }
    try {
        const text = await fetchSheet(NSC_TODAY_PEEK_URL_);
        const today = parseTodayFromPeekCsv_(text);
        if (today) {
            nscTodayPeekCache_ = { at: now, value: today };
            return today;
        }
    } catch (e) {
        console.warn('[NSC meta] TODAY peek failed:', e.message);
    }
    return nscTodayPeekCache_.value || '';
}

/** TODAY of the NSC dump: in mirror mode from the snapshot's first row (no Google request), else the live peek. */
async function nscToday_(nscEntry) {
    const head = nscEntry ? await mirror.readHead(nscEntry.key, 64 * 1024) : null;
    const today = head ? parseTodayFromPeekCsv_(head) : '';
    return today || peekNscTodayFromSheet_();
}

function overlayLiveNscToday_(meta, liveToday) {
    const today = String(liveToday || '').trim();
    if (!today) return meta;
    const next = Object.assign({}, meta || {});
    const prevDate = nscReportDateLabel_(meta);
    if (prevDate && prevDate !== today) {
        // The sheet has moved to a newer report date than this meta snapshot.
        // Clear publishedRows so DataHub's truncation guard does not reject the fresh sheet
        // if the new report happens to have fewer pending applications.
        delete next.publishedRows;
        if (next.stats) {
            next.stats = Object.assign({}, next.stats);
            delete next.stats.publishedRows;
            delete next.stats.totalPending;
        }
    }
    next.reportDate = today;
    next.stats = Object.assign({}, next.stats || {}, { today });
    return next;
}

async function saveNscSheetMeta_(meta) {
    if (!meta) return;
    nscSheetMetaCache_ = { at: Date.now(), value: meta, pending: null };
    try {
        const body = 'data=' + encodeURIComponent(JSON.stringify({ action: 'savemeta', meta }));
        await fetch(NSC_SHEET_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });
    } catch (e) {
        console.warn('[NSC] Sheet meta save failed:', e.message);
    }
}

function overlayKeptWithheld_(baseMeta, prevMeta) {
    const prevWh = Number(
        (prevMeta && prevMeta.withheldRows) ||
        (prevMeta && prevMeta.stats && prevMeta.stats.withheldRows) ||
        0
    ) || 0;
    baseMeta.withheldKept = true;
    baseMeta.withheldRows = prevWh;
    baseMeta.stats = Object.assign({}, baseMeta.stats || {}, { withheldRows: prevWh });
    return baseMeta;
}

function buildNscMeta_(uploadUser, body, uploadId) {
    const clientStats =
        body && typeof body.stats === 'object' && body.stats ? body.stats : {};
    const publishedRows = Number(body.publishedRows || clientStats.publishedRows) || 0;
    const withheldRows = Number(body.withheldRows || clientStats.withheldRows) || 0;
    const reportLabel = String(
        clientStats.today || body.reportDateUsed || body.reportDate || ''
    ).trim();
    const stats = {
        rawRows: Number(clientStats.rawRows) || publishedRows + withheldRows,
        publishedRows,
        withheldRows,
        statusCounts: clientStats.statusCounts || {},
        regionCounts: clientStats.regionCounts || {},
        today: reportLabel
    };
    return {
        uploadedAt: new Date().toISOString(),
        uploadedBy:
            (uploadUser && (uploadUser.Username || uploadUser.username)) ||
            (body && body.uploadedBy) ||
            'user',
        originalName: String((body && body.originalName) || 'nsc_client.csv').trim() || 'nsc_client.csv',
        sheetName: String((body && body.sheetName) || '').trim(),
        publishedRows,
        withheldRows,
        reportDate: reportLabel,
        stats,
        supabaseUploadId: uploadId,
        source: 'google_sheet'
    };
}

async function requireNscUploader_(req, res) {
    if (!req.user) {
        res.status(401).json({ status: 'error', message: 'Unauthorized' });
        return null;
    }
    const uploadUser = await resolveFreshUser_(req, true);
    if (!canUploadNsc_(uploadUser)) {
        res.status(403).json({
            status: 'error',
            message:
                'NSC raw upload is not authorised for this user. Ask an admin to enable NSC Upload in User Management.'
        });
        return null;
    }
    return uploadUser;
}

app.get('/api/nsc/meta', async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }

    const user = await resolveFreshUser_(req);
    let meta = readLocalNscMeta_();
    let source = meta ? 'local' : 'google_sheet';
    // Mirror mode: versions and CSV URLs from the manifest (the upload meta itself has no snapshot).
    const [nscMirror, whMirror] = await Promise.all([
        mirror.entryForDataHubKey('CACHE_NSC_v5'),
        mirror.entryForDataHubKey('CACHE_WITHHELD_v4')
    ]);
    if (nscMirror || whMirror) res.setHeader('X-Mzo-Data', 'mirror');
    // Both helpers swallow their own errors.
    const [sheetMeta, liveToday] = await Promise.all([fetchNscSheetMeta_(), nscToday_(nscMirror)]);
    if (sheetMeta && (sheetMeta.reportDate || sheetMeta.uploadedAt || sheetMeta.publishedRows)) {
        meta = sheetMeta;
        source = 'google_sheet';
    }
    if (liveToday) {
        meta = overlayLiveNscToday_(meta, liveToday);
        source = 'google_sheet';
    }

    res.setHeader('Cache-Control', 'private, max-age=15, must-revalidate');
    const canUpload = canUploadNsc_(user);
    return res.json({
        status: 'success',
        canUpload,
        isAdmin: isPortalAdmin_(user),
        meta,
        version: nscMirror ? nscMirror.version : (snapshotVersion_(meta) || null),
        withheldVersion: whMirror ? whMirror.version : (snapshotWithheldVersion_(meta) || null),
        // Mirror mode only: the versions the live response carries (they hold the report date).
        ...(nscMirror || whMirror ? {
            liveVersions: { version: snapshotVersion_(meta) || null, withheldVersion: snapshotWithheldVersion_(meta) || null }
        } : {}),
        sheetScriptUrl: canUpload ? NSC_SHEET_SCRIPT_URL : '',
        withheldSheetScriptUrl: canUpload ? NSC_WITHHELD_SHEET_SCRIPT_URL : '',
        csvUrl: nscMirror ? mirror.hubUrl(nscMirror) : NSC_SHEET_FALLBACK_URL,
        withheldCsvUrl: whMirror ? mirror.hubUrl(whMirror) : NSC_WITHHELD_SHEET_FALLBACK_URL,
        nscSheetEditUrl: canUpload ? `https://docs.google.com/spreadsheets/d/${NSC_WORKING_SPREADSHEET_ID}/edit` : '',
        withheldSheetEditUrl: canUpload ? `https://docs.google.com/spreadsheets/d/${NSC_WITHHELD_SPREADSHEET_ID}/edit` : '',
        nscSheetTab: 'nsc_working',
        withheldSheetTab: 'Sheet1',
        source,
        setupHint: null
    });
});

// The browser writes NSC / Withheld rows to Google Sheets (nsc/upload.html); the dumps are read from there.
app.get('/api/nsc/dataset', (req, res) => {
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    return res.redirect(302, NSC_SHEET_FALLBACK_URL);
});

app.get('/api/withheld/dataset', (req, res) => {
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    return res.redirect(302, NSC_WITHHELD_SHEET_FALLBACK_URL);
});

/** Browser publish (nsc/upload.html): begin, write rows to the Sheets, then complete with the meta. */
app.post('/api/nsc/publish/begin', async (req, res) => {
    try {
        const uploadUser = await requireNscUploader_(req, res);
        if (!uploadUser) return;

        const body = req.body || {};
        const reportDateRaw = String(body.reportDate || '').trim();
        if (!reportDateRaw) {
            return res.status(400).json({
                status: 'error',
                message: 'Report date is required. This becomes “Updated on” on the dashboards.'
            });
        }

        const publishedRows = Number(body.publishedRows) || 0;
        const withheldRows = Number(body.withheldRows) || 0;
        if (!publishedRows && !withheldRows) {
            return res.status(400).json({
                status: 'error',
                message: 'Nothing to publish (0 Working/Accepted and 0 Withheld rows).'
            });
        }

        const uploadId = Date.now();
        const statsBody = Object.assign({}, body, { reportDate: reportDateRaw });
        if (typeof statsBody.stats === 'string') {
            try {
                statsBody.stats = JSON.parse(statsBody.stats);
            } catch (_) {
                statsBody.stats = {};
            }
        }
        // A begin without a complete (closed tab, failed upload) leaves its meta behind: drop old ones.
        for (const id of Object.keys(nscPendingMetaById_)) {
            if (uploadId - Number(id) > 6 * 3600 * 1000) delete nscPendingMetaById_[id];
        }
        nscPendingMetaById_[uploadId] = buildNscMeta_(uploadUser, statsBody, uploadId);
        const reportLabel = nscPendingMetaById_[uploadId].reportDate;

        return res.json({
            status: 'success',
            uploadId,
            publishedRows,
            withheldRows,
            reportDate: reportLabel
        });
    } catch (e) {
        console.error('[NSC publish/begin] Error:', e.message);
        return res.status(500).json({ status: 'error', message: e.message });
    }
});

app.post('/api/nsc/publish/complete', async (req, res) => {
    try {
        const uploadUser = await requireNscUploader_(req, res);
        if (!uploadUser) return;

        const body = req.body || {};
        const uploadId = Number(body.uploadId);
        if (!uploadId || Number.isNaN(uploadId)) {
            return res.status(400).json({ status: 'error', message: 'Missing uploadId.' });
        }

        const baseMeta =
            nscPendingMetaById_[uploadId] || buildNscMeta_(uploadUser, body, uploadId);
        delete nscPendingMetaById_[uploadId];
        baseMeta.uploadedAt = new Date().toISOString();
        baseMeta.source = 'google_sheet';

        const incomingWh = Number(
            body.withheldRows != null ? body.withheldRows : baseMeta.withheldRows
        ) || 0;
        const keepPreviousWithheld = incomingWh <= 0 || body.keepPreviousWithheld === true;
        if (keepPreviousWithheld) {
            const prevMeta = (await fetchNscSheetMeta_({ fresh: true })) || readLocalNscMeta_();
            overlayKeptWithheld_(baseMeta, prevMeta);
        }

        writeLocalNscMeta_(baseMeta);
        await saveNscSheetMeta_(baseMeta);
        refreshMirror(['nsc_pending', 'withheld'], 'NSC publish');

        const keptNote = baseMeta.withheldKept
            ? ` File had 0 Withheld — kept previous Withheld (${baseMeta.withheldRows || 0} rows).`
            : '';
        console.log(
            `[NSC publish/complete] ${baseMeta.uploadedBy} upload ${uploadId}: ` +
            `pending=${baseMeta.publishedRows} withheld=${baseMeta.withheldRows}` +
            (baseMeta.withheldKept ? ' (kept previous withheld)' : '')
        );

        return res.json({
            status: 'success',
            message: `Published ${baseMeta.publishedRows || 0} Working/Accepted and ${baseMeta.withheldRows || 0
                } Withheld rows.${keptNote} Refresh NSC and Withheld dashboards.`,
            meta: baseMeta,
            version: snapshotVersion_(baseMeta) || String(uploadId),
            withheldVersion: snapshotWithheldVersion_(baseMeta) || String(uploadId),
            withheldKept: !!baseMeta.withheldKept
        });
    } catch (e) {
        console.error('[NSC publish/complete] Error:', e.message);
        return res.status(500).json({ status: 'error', message: e.message });
    }
});

// --- Stock dump: the browser cleans the SAP Excel (stock/upload.html) and publishes here ---
const multer = require('multer');
const {
    publishedFromCsv: stockPublishedFromCsv,
    toCsv: stockToCsv,
    dashboardRowToDb: stockRowToDb
} = require('./lib/stock_pipeline');

const csvUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 60 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/\.csv$/i.test(String(file.originalname || ''))) return cb(null, true);
        cb(new Error('Only CSV files are allowed.'));
    }
});

const STOCK_CSV_FILE = path.join(DATA_DIR, 'stock.csv');
const STOCK_META_FILE = path.join(DATA_DIR, 'stock_meta.json');
const STOCK_SPREADSHEET_ID = '1wDvPuAxNfdO9QzUaIUubg2JnkFM5ZleFNXQdi8s5uh0';
const STOCK_SHEET_FALLBACK_URL =
    `https://docs.google.com/spreadsheets/d/${STOCK_SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=Sheet1`;
/** Web app /exec from apps-script/sheet_mirror_publish.gs (ROLE=stock) on the Stock workbook. */
const STOCK_SHEET_SCRIPT_URL = String(
    process.env.STOCK_SHEET_SCRIPT_URL ||
    'https://script.google.com/macros/s/AKfycbzM3EziyopjZW57OjhPW6cM3Wa2141hteRkKDxYDaoZXZSbLMgqH2fhEFLD_1bwLVJ5/exec'
).trim();
const STOCK_INSERT_BATCH = 400;

function canUploadStock_(user) {
    return hasPermission_(user, 'stock-upload-autho');
}

function readLocalStockMeta_() {
    try {
        if (!fs.existsSync(STOCK_META_FILE)) return null;
        return JSON.parse(fs.readFileSync(STOCK_META_FILE, 'utf8'));
    } catch (e) {
        return null;
    }
}

/** Local CSV backup for localhost only — Vercel /var/task is read-only (EROFS). */
function writeLocalStockBackup_(csv, meta) {
    try {
        ensureDataDir_();
        writeDataFile_(path.basename(STOCK_CSV_FILE), csv);
        writeDataFile_(path.basename(STOCK_META_FILE), JSON.stringify(meta, null, 2));
        return true;
    } catch (e) {
        if (e && (e.code === 'EROFS' || e.code === 'EACCES' || /read-only/i.test(e.message))) {
            console.warn('[Stock] Skipping local backup (read-only FS):', e.message);
            return false;
        }
        console.warn('[Stock] Local backup failed:', e.message);
        return false;
    }
}

/** dd/mm/yyyy of the stock dump's Date column (written m/d/yyyy), from the mirror snapshot's first row. */
async function stockCsvReportDate_(stockEntry) {
    const head = stockEntry ? await mirror.readHead(stockEntry.key, 16 * 1024) : null;
    const lines = String(head || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    if (lines.length < 2) return '';
    const idx = parseCsvLine_(lines[0]).map((h) => h.trim()).indexOf('Date');
    const m = idx < 0 ? null : String(parseCsvLine_(lines[1])[idx] || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? `${m[2].padStart(2, '0')}/${m[1].padStart(2, '0')}/${m[3]}` : '';
}

function stockMetaFromDb_(row) {
    if (!row) return null;
    return {
        uploadedAt: row.uploaded_at,
        uploadedBy: row.uploaded_by,
        originalName: row.original_name,
        sheetName: row.sheet_name,
        publishedRows: row.published_rows,
        reportDate: row.report_date || '',
        stats: row.stats || { today: row.report_date },
        supabaseUploadId: row.id,
        source: 'supabase'
    };
}

// The active upload meta is read by /api/stock/meta and /api/hub/versions on every page load: keep it a
// minute and share one in-flight request (cleared by a publish from this instance).
let stockMetaCache_ = { at: 0, row: undefined, pending: null };

function invalidateStockMetaCache_() {
    stockMetaCache_ = { at: 0, row: undefined, pending: null };
}

async function fetchActiveStockMeta_() {
    const c = stockMetaCache_;
    if (c.row !== undefined && Date.now() - c.at < 60 * 1000) return c.row;
    if (c.pending) return c.pending;
    const pending = querySupabase(
        `stock_upload_meta?is_active=eq.true&select=*&order=id.desc&limit=1`,
        { schema: PORTAL_USERS_SCHEMA }
    ).then((rows) => {
        const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
        if (stockMetaCache_.pending === pending) stockMetaCache_ = { at: Date.now(), row, pending: null };
        return row;
    }).finally(() => {
        if (stockMetaCache_.pending === pending) stockMetaCache_.pending = null;
    });
    c.pending = pending;
    return pending;
}

async function publishStockToSupabase_(publishedRows, metaInput) {
    invalidateStockMetaCache_();
    try {
        await querySupabase(`stock_upload_meta?is_active=eq.true`, {
            schema: PORTAL_USERS_SCHEMA,
            method: 'PATCH',
            body: { is_active: false },
            prefer: 'return=minimal'
        });
    } catch (e) {
        console.warn('[Stock Supabase] deactivate previous:', e.message);
    }

    const insertedMeta = await querySupabase('stock_upload_meta', {
        schema: PORTAL_USERS_SCHEMA,
        method: 'POST',
        body: {
            uploaded_by: metaInput.uploadedBy || '',
            original_name: metaInput.originalName || '',
            sheet_name: metaInput.sheetName || '',
            published_rows: publishedRows.length,
            report_date: metaInput.reportDate || (metaInput.stats && metaInput.stats.today) || '',
            stats: metaInput.stats || {},
            is_active: true
        },
        prefer: 'return=representation'
    });
    const metaRow = Array.isArray(insertedMeta) ? insertedMeta[0] : insertedMeta;
    if (!metaRow || metaRow.id == null) throw new Error('Supabase did not return stock_upload_meta id.');
    const uploadId = metaRow.id;

    try {
        await querySupabase(`stock_snapshot?id=gte.0`, {
            schema: PORTAL_USERS_SCHEMA,
            method: 'DELETE',
            prefer: 'return=minimal'
        });
    } catch (e) {
        console.warn('[Stock Supabase] clear snapshot:', e.message);
    }

    for (let i = 0; i < publishedRows.length; i += STOCK_INSERT_BATCH) {
        const chunk = publishedRows.slice(i, i + STOCK_INSERT_BATCH).map((r) => stockRowToDb(r, uploadId));
        await querySupabase('stock_snapshot', {
            schema: PORTAL_USERS_SCHEMA,
            method: 'POST',
            body: chunk,
            prefer: 'return=minimal'
        });
    }
    try {
        await putStockCsvToStorage_(stockToCsv(publishedRows));
    } catch (e) {
        if (stockStorageOrigin_()) throw e;
        console.warn('[Stock Supabase] storage snapshot.csv:', e.message);
    }
    return stockMetaFromDb_(metaRow);
}

async function insertStockMetaOnly_(metaInput, publishedCount) {
    invalidateStockMetaCache_();
    try {
        await querySupabase(`stock_upload_meta?is_active=eq.true`, {
            schema: PORTAL_USERS_SCHEMA,
            method: 'PATCH',
            body: { is_active: false },
            prefer: 'return=minimal'
        });
    } catch (e) {
        console.warn('[Stock Supabase] deactivate previous:', e.message);
    }
    const insertedMeta = await querySupabase('stock_upload_meta', {
        schema: PORTAL_USERS_SCHEMA,
        method: 'POST',
        body: {
            uploaded_by: metaInput.uploadedBy || '',
            original_name: metaInput.originalName || '',
            sheet_name: metaInput.sheetName || '',
            published_rows: Number(publishedCount) || 0,
            report_date: metaInput.reportDate || (metaInput.stats && metaInput.stats.today) || '',
            stats: metaInput.stats || {},
            is_active: true
        },
        prefer: 'return=representation'
    });
    const metaRow = Array.isArray(insertedMeta) ? insertedMeta[0] : insertedMeta;
    if (!metaRow || metaRow.id == null) throw new Error('Supabase did not return stock_upload_meta id.');
    return stockMetaFromDb_(metaRow);
}

app.get('/api/stock/meta', async (req, res) => {
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    const user = await resolveFreshUser_(req);
    const canUpload = canUploadStock_(user);
    let source = 'google_sheet_fallback';
    let meta = readLocalStockMeta_();
    const hasLocal = fs.existsSync(STOCK_CSV_FILE);
    try {
        const sb = await fetchActiveStockMeta_();
        if (sb) {
            meta = stockMetaFromDb_(sb);
            source = stockStorageOrigin_() ? 'supabase_storage' : 'supabase';
        } else if (hasLocal) source = 'local';
    } catch (e) {
        if (hasLocal) source = 'local';
    }
    if (stockStorageOrigin_()) source = 'supabase_storage';
    // Mirror mode: the dump is the Storage snapshot; its version and URL come from the manifest and the
    // as-on date from its Date column (this host may only see an older upload meta).
    const liveVersion = snapshotVersion_(meta) || null; // before the mirror's as-on overlay
    const stockMirror = await mirror.entryForDataHubKey('CACHE_STOCK');
    if (stockMirror) {
        res.setHeader('X-Mzo-Data', 'mirror');
        const asOn = await stockCsvReportDate_(stockMirror);
        if (asOn) meta = Object.assign({}, meta || {}, { reportDate: asOn, stats: Object.assign({}, (meta && meta.stats) || {}, { today: asOn }) });
        if (stockMirror.sourceType === 'supabase_storage') source = 'supabase_storage';
    }
    const version = stockMirror ? stockMirror.version : (snapshotVersion_(meta) || null);
    let uploadUrl = '';
    if (stockStorageOrigin_() && canUpload) {
        try {
            const signed = await createStockSignedUpload_();
            uploadUrl = signed.signedUrl;
        } catch (e) {
            console.warn('[Stock meta] signed upload URL:', e.message);
        }
    }
    res.setHeader('Cache-Control', 'private, max-age=15, must-revalidate');
    const sheetMirror = !stockStorageOrigin_();
    return res.json({
        status: 'success',
        canUpload,
        isAdmin: isPortalAdmin_(user),
        meta,
        version,
        ...(stockMirror ? { liveVersions: { version: liveVersion } } : {}),
        sheetScriptUrl: canUpload && sheetMirror ? STOCK_SHEET_SCRIPT_URL : '',
        uploadUrl,
        csvUrl: stockMirror ? mirror.hubUrl(stockMirror) : (sheetMirror ? STOCK_SHEET_FALLBACK_URL : stockPublicCsvUrl_(version)),
        source,
        setupHint:
            source === 'google_sheet_fallback'
                ? 'Run scripts/sql/create_insight_project_gmasnqeb.sql then set INSIGHT_LIVE + STOCK_USE_STORAGE after copy.'
                : null
    });
});

app.get('/api/stock/dataset', (req, res) => {
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    return res.redirect(302, stockStorageOrigin_() ? stockPublicCsvUrl_() : STOCK_SHEET_FALLBACK_URL);
});

/**
 * Browser-cleaned stock publish (Vercel-safe).
 * Authorized users process Excel in the browser; only cleaned CSV is posted.
 */
app.post('/api/stock/publish', (req, res) => {
    csvUpload.single('csv')(req, res, async (err) => {
        if (err) return res.status(400).json({ status: 'error', message: err.message });
        try {
            if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
            const uploadUser = await resolveFreshUser_(req, true);
            if (!canUploadStock_(uploadUser)) {
                return res.status(403).json({
                    status: 'error',
                    message: 'Stock upload is not authorised. Ask an admin to enable Stock Raw Upload in User Management.'
                });
            }

            const body = req.body || {};
            const sheetMirror = String(body.sheetMirror || '') === '1';
            const storagePublished = String(body.storagePublished || '') === '1';
            let csv = '';
            if (req.file && req.file.buffer) {
                csv = req.file.buffer.toString('utf8').trim();
            } else {
                csv = String(body.csv || '').trim();
            }
            const reportDateRaw = String(body.reportDate || '').trim();
            const originalName = String(body.originalName || 'stock_client.csv').trim() || 'stock_client.csv';
            const sheetName = String(body.sheetName || 'Sheet1').trim() || 'Sheet1';
            let clientStats = {};
            try {
                clientStats = body.stats ? JSON.parse(String(body.stats)) : {};
            } catch (_) {
                clientStats = {};
            }
            if (!clientStats || typeof clientStats !== 'object') clientStats = {};

            if (!reportDateRaw) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Report date is required (shown as stock as-of date).'
                });
            }

            if (sheetMirror || storagePublished) {
                const publishedCount = Number(body.publishedRows || clientStats.publishedRows) || 0;
                const reportLabel = String(clientStats.today || body.reportDateUsed || reportDateRaw).trim();
                const stats = {
                    rawRows: Number(clientStats.rawRows) || publishedCount,
                    publishedRows: publishedCount,
                    skippedRows: Number(clientStats.skippedRows) || 0,
                    rowsWithCategory: Number(clientStats.rowsWithCategory) || 0,
                    today: reportLabel
                };
                const origin = storagePublished ? 'supabase_storage' : 'google_sheet';
                const baseMeta = {
                    uploadedAt: new Date().toISOString(),
                    uploadedBy: uploadUser.Username || uploadUser.username || req.user.Username || 'user',
                    originalName,
                    sheetName,
                    stats,
                    publishedRows: publishedCount,
                    reportDate: reportLabel,
                    publishMode: origin,
                    source: origin
                };
                try {
                    const supabaseMeta = await insertStockMetaOnly_(baseMeta, publishedCount);
                    baseMeta.supabaseUploadId = supabaseMeta && supabaseMeta.supabaseUploadId;
                } catch (e) {
                    console.warn('[Stock publish] meta only:', e.message);
                    baseMeta.supabaseError = e.message;
                }
                invalidateStockMetaCache_();
                refreshMirror(['stock_snapshot', 'stock_upload_meta'], 'stock publish');
                return res.json({
                    status: 'success',
                    message: storagePublished
                        ? `Published ${publishedCount} stock rows to Supabase Storage.`
                        : `Published ${publishedCount} stock rows to Google Sheet.`,
                    meta: baseMeta,
                    version: snapshotVersion_(baseMeta) || null,
                    supabase: baseMeta.supabaseUploadId ? 'ok' : 'skipped',
                    source: origin
                });
            }

            if (!csv) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Missing cleaned CSV. Process the Excel in the browser first.'
                });
            }

            const published = stockPublishedFromCsv(csv);
            if (!published.length) {
                return res.status(400).json({ status: 'error', message: 'Cleaned CSV has no data rows.' });
            }

            const csvOut = stockToCsv(published);
            const reportLabel = String(clientStats.today || body.reportDateUsed || reportDateRaw).trim();
            const stats = {
                rawRows: Number(clientStats.rawRows) || published.length,
                publishedRows: published.length,
                skippedRows: Number(clientStats.skippedRows) || 0,
                rowsWithCategory: Number(clientStats.rowsWithCategory) || 0,
                today: reportLabel
            };
            const baseMeta = {
                uploadedAt: new Date().toISOString(),
                uploadedBy: uploadUser.Username || uploadUser.username || req.user.Username || 'user',
                originalName,
                sheetName,
                stats,
                publishedRows: published.length,
                reportDate: reportLabel,
                publishMode: 'browser'
            };

            writeLocalStockBackup_(csvOut, baseMeta);

            let supabaseMeta = null;
            let supabaseError = null;
            try {
                supabaseMeta = await publishStockToSupabase_(published, baseMeta);
                baseMeta.supabaseUploadId = supabaseMeta && supabaseMeta.supabaseUploadId;
                baseMeta.source = 'supabase';
                writeLocalStockBackup_(csvOut, baseMeta);
                invalidateStockMetaCache_();
                refreshMirror(['stock_snapshot', 'stock_upload_meta', 'stock_snapshot_db'], 'stock publish');
            } catch (e) {
                supabaseError = e.message;
                console.error('[Stock publish] publish failed:', e.message);
                baseMeta.source = 'local';
                baseMeta.supabaseError = supabaseError;
                writeLocalStockBackup_(csvOut, baseMeta);
            }

            console.log(
                `[Stock publish] ${baseMeta.uploadedBy} published ${baseMeta.publishedRows} rows` +
                ` from ${originalName} (ok=${!!supabaseMeta})`
            );

            return res.json({
                status: 'success',
                message: supabaseMeta
                    ? `Published ${baseMeta.publishedRows} stock rows.`
                    : `Saved ${baseMeta.publishedRows} rows locally, but live publish failed (${supabaseError}).`,
                meta: baseMeta,
                supabase: supabaseMeta ? 'ok' : 'failed',
                supabaseError
            });
        } catch (e) {
            console.error('[Stock publish] Error:', e.message);
            return res.status(500).json({ status: 'error', message: e.message });
        }
    });
});

// --- Synced report snapshots: defective meters, disconnection, pending master card, load extension ---
// scripts/sync/* copy each Google Sheet to the Supabase 'reports' bucket with a meta.json (version + KPIs).
const { syncDefectiveToSupabase } = require('./scripts/sync/sync_defective_to_supabase');
const { syncDefectiveFromCrm, isDbvisAvailable } = require('./scripts/sync/sync_defective_from_crm');
const { syncUnbilledFromCrm } = require('./scripts/sync/sync_unbilled_from_crm');
const { syncDisconnectionToSupabase } = require('./scripts/sync/sync_disconnection_to_supabase');
const { syncDisconnectionFromCrm } = require('./scripts/sync/sync_disconnection_from_crm');
const { syncDisconnectionPayments } = require('./scripts/sync/sync_disconnection_payments');
const { syncPendingMcToSupabase } = require('./scripts/sync/sync_pending_mc_to_supabase');
const { syncLoadExtToSupabase } = require('./scripts/sync/sync_load_ext_to_supabase');

// Public 'reports' bucket the sync jobs publish to (new project). Read-only public GETs, no key; writes are unchanged.
// REPORTS_PUBLIC_BASE overrides it; without INSIGHT_SUPABASE_URL (localhost, the VM) it is the new project's bucket,
// never the old project's, which has no reports bucket.
const REPORTS_PUBLIC_BASE = String(
    process.env.REPORTS_PUBLIC_BASE ||
    `${String(NEW_INSIGHT_URL || 'https://gmasnqebdogtavoudbke.supabase.co').replace(/\/$/, '')}/storage/v1/object/public/reports`
).replace(/\/$/, '');

/** A sync job's meta.json from the public reports bucket (cached 60 s); the local data/ copy as a fallback (the only source when folder is null). */
function syncedMeta_(folder, localFile) {
    let cached = null;
    let at = 0;
    return {
        async read() {
            const now = Date.now();
            if (cached && now - at < 60000) return cached;
            const localPath = path.join(DATA_DIR, localFile);
            if (!process.env.VERCEL && fs.existsSync(localPath)) {
                try {
                    cached = JSON.parse(fs.readFileSync(localPath, 'utf8'));
                    at = now;
                    return cached;
                } catch (_) { }
            }
            if (REPORTS_PUBLIC_BASE && folder) {
                try {
                    const r = await fetch(`${REPORTS_PUBLIC_BASE}/${folder}/meta.json`, {
                        signal: AbortSignal.timeout(5000)
                    });
                    if (r.ok) {
                        cached = await r.json();
                        at = now;
                        return cached;
                    }
                } catch (_) { /* fall back below */ }
            }
            try {
                cached = JSON.parse(fs.readFileSync(localPath, 'utf8'));
                at = now;
                return cached;
            } catch (_) {
                return cached;
            }
        },
        set(meta) {
            cached = meta;
            at = Date.now();
        }
    };
}

const DEFECTIVE_META = syncedMeta_('defective', 'defective_meta.json');
const DISCONNECTION_META = syncedMeta_('disconnection', 'disconnection_meta.json');
const PENDING_MC_META = syncedMeta_('pending_mc', 'pending_mc_meta.json');
const LOAD_EXT_META = syncedMeta_('load_extension', 'load_ext_meta.json');
const UNBILLED_META = syncedMeta_('unbilled', 'unbilled_meta.json');
// Written only by the Safety upload (no sync job publishes it to the bucket), so it is read locally only.
const SAFETY_META = syncedMeta_(null, 'safety_inspection_meta.json');

/** POST route that runs one sync job (one at a time per instance) and logs it. */
function syncRoute_(routePath, { label, can, forbidden, run, meta, done, bareError, mirrorKeys }) {
    let running = false;
    app.post(routePath, async (req, res) => {
        if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
        const user = await resolveFreshUser_(req, true);
        if (!can(user)) return res.status(403).json({ status: 'error', message: forbidden });
        if (running) {
            return res.status(429).json({ status: 'error', message: 'A sync is already in progress. Please wait a moment.' });
        }
        running = true;
        try {
            console.log(`[${label}] Triggered by user: ${user.Username || user.username || 'unknown'}`);
            const result = await run(req);
            meta.set(result);
            refreshMirror(mirrorKeys, label);
            const summary = done(result);
            await logActivity({
                username: user.Username || user.username,
                name: user.Name || user.name,
                type: 'report_sync',
                details: summary.log
            });
            return res.json({ status: 'success', message: summary.message, meta: result });
        } catch (err) {
            console.error(`[${label}] Failed:`, err.message);
            // disconnection.html adds its own "Sync failed:" prefix
            return res.status(500).json({ status: 'error', message: bareError ? err.message : `Sync failed: ${err.message}` });
        } finally {
            running = false;
        }
    });
}

/**
 * Common fields of the disconnection / pending MC / load extension meta responses. In mirror mode
 * (an entry for the DataHub key) the version and CSV URL come from the manifest; the meta.json
 * (report date, KPIs) is still read live.
 */
async function syncedMetaFields_(meta, fallbackCsvUrl, dataHubKey, res) {
    const fields = {
        version: meta ? meta.version : null,
        reportDate: meta ? meta.reportDate : null,
        stats: meta ? meta.stats : null,
        csvUrl: (meta && meta.csvUrl) || fallbackCsvUrl,
        source: meta ? meta.source : 'google_sheet'
    };
    const m = dataHubKey ? await mirror.entryForDataHubKey(dataHubKey) : null;
    if (m) {
        fields.liveVersions = { version: fields.version };
        fields.version = m.version;
        fields.csvUrl = mirror.hubUrl(m);
        if (res) res.setHeader('X-Mzo-Data', 'mirror');
    }
    return fields;
}

// Defective meters
const DEFECTIVE_SPREADSHEET_ID = '1dMLSX2bZBqZMPooh7_CrniCjqgy4MijaFW62GKJJldA';
const DEFECTIVE_SUMMARY_GID = 0;
const DEFECTIVE_DETAILS_GID = 1638574999;
function defectiveExportCsvUrl_(gid) {
    return `https://docs.google.com/spreadsheets/d/${DEFECTIVE_SPREADSHEET_ID}/export?format=csv&gid=${gid}`;
}
const DEFECTIVE_SHEET_SCRIPT_URL = String(
    process.env.DEFECTIVE_SHEET_SCRIPT_URL ||
    'https://script.google.com/macros/s/AKfycbzULRzoJRMlt_x3nlEo6RLFVzELgwAD5Z7f8JuvqwxBgC6cpc0BF7dynKwBg0hNIkBn/exec'
).trim();

function canUploadDefective_(user) {
    return hasPermission_(user, 'defective-upload-autho');
}

app.get('/api/defective/meta', async (req, res) => {
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    const user = await resolveFreshUser_(req);
    const canUpload = canUploadDefective_(user);
    const meta = await DEFECTIVE_META.read();
    // Mirror mode: CSV URLs from the manifest, and one version that changes when either file does.
    const [sumMirror, detMirror] = await Promise.all([
        mirror.entryForDataHubKey('CACHE_DEFECTIVE'),
        mirror.entryForDataHubKey('CACHE_DEFECTIVE_DETAILS')
    ]);
    const mirrored = sumMirror && detMirror;
    if (mirrored) res.setHeader('X-Mzo-Data', 'mirror');
    res.setHeader('Cache-Control', 'private, max-age=15, must-revalidate');
    return res.json({
        status: 'success',
        canUpload,
        canSync: canUpload,
        canCrmSync: canUpload && isDbvisAvailable(),
        isAdmin: isPortalAdmin_(user),
        sheetScriptUrl: canUpload && DEFECTIVE_SHEET_SCRIPT_URL ? DEFECTIVE_SHEET_SCRIPT_URL : '',
        spreadsheetId: DEFECTIVE_SPREADSHEET_ID,
        summaryCsvUrl: mirrored ? mirror.hubUrl(sumMirror) : ((meta && meta.summaryCsvUrl) || defectiveExportCsvUrl_(DEFECTIVE_SUMMARY_GID)),
        detailsCsvUrl: mirrored ? mirror.hubUrl(detMirror) : ((meta && meta.detailsCsvUrl) || defectiveExportCsvUrl_(DEFECTIVE_DETAILS_GID)),
        version: mirrored ? `${String(sumMirror.version || '').slice(0, 20)}${String(detMirror.version || '').slice(0, 20)}` : ((meta && meta.version) || null),
        ...(mirrored ? { liveVersions: { version: (meta && meta.version) || null } } : {}),
        reportDate: (meta && meta.reportDate) || null,
        stats: (meta && meta.stats) || null,
        uploadMeta: (meta && meta.stats) || meta || null,
        source: (meta && meta.source) || 'google_sheet',
        setupHint: null
    });
});

syncRoute_('/api/defective/sync', {
    label: 'Defective Sync',
    can: canUploadDefective_,
    forbidden: 'Not authorized to sync defective meter data. Ask an admin to grant permission.',
    run: syncDefectiveToSupabase,
    meta: DEFECTIVE_META,
    mirrorKeys: ['defective_summary', 'defective_details'],
    done: (m) => ({
        log: `Synced Defective Meter: ${m.stats.totalDefective} meters (${m.stats.summaryRows} summary, ${m.stats.detailsRows} details)`,
        message: `Defective Meter sync complete! Total: ${m.stats.totalDefective} meters.`
    })
});

syncRoute_('/api/defective/crm-sync', {
    label: 'CRM Defective Sync',
    can: canUploadDefective_,
    forbidden: 'Not authorized to sync defective meter data from CRM. Ask an admin to grant permission.',
    run: async () => {
        if (!isDbvisAvailable()) {
            throw new Error('DbVisualizer CLI is not available on this server. Direct CRM extraction must be run from an internal office workstation / VM connected to DB2.');
        }
        return await syncDefectiveFromCrm({ fresh: true });
    },
    meta: DEFECTIVE_META,
    mirrorKeys: ['defective_summary', 'defective_details'],
    done: (m) => ({
        log: `CRM Synced Defective Meter: ${m.stats.totalDefective} meters (${m.stats.summaryRows} summary, ${m.stats.detailsRows} details)`,
        message: `CRM Defective Meter sync complete! Total: ${m.stats.totalDefective} meters.`
    })
});

// --- Unbilled Consumers & Billing Exceptions ---
function canManageUnbilled_(user) {
    return isPortalAdmin_(user) || hasPermission_(user, 'unbilled-sync-autho') || hasPermission_(user, 'defective-upload-autho');
}

const VM_BASE_URL = 'https://130.210.43.11.sslip.io';
const isVmHost_ = (req) => Boolean(req.headers.host && req.headers.host.includes('130.210.43.11'));

/**
 * Off the VM (Vercel, a workstation) with no local copy: fetch the VM's copy of a sync dataset
 * server-side with that route's sync key (SYNC_READ_ROUTES) and send it to this signed-in user.
 * Resolves false (nothing sent) on the VM or when the key is not set here.
 */
async function fromVm_(req, res, route, contentType) {
    const spec = SYNC_READ_ROUTES[route];
    const key = spec ? String(process.env[spec.env] || '').trim() : '';
    if (!key || isVmHost_(req) || mirror.on()) return false;
    try {
        const r = await fetch(`${VM_BASE_URL}${route}`, { headers: { 'x-sync-key': key, Accept: contentType }, timeout: 30000 });
        if (!r.ok) {
            res.status(r.status === 404 ? 404 : 502).json({ status: 'error', message: `The server copy answered ${r.status}` });
            return true;
        }
        res.setHeader('Content-Type', r.headers.get('content-type') || contentType);
        res.send(await r.text());
    } catch (err) {
        res.status(502).json({ status: 'error', message: 'The server copy is not reachable' });
    }
    return true;
}

/** JSON of the VM's copy (a meta route), fetched server-side with the sync key; null when unavailable. */
async function vmJson_(route) {
    const spec = SYNC_READ_ROUTES[route];
    const key = spec ? String(process.env[spec.env] || '').trim() : '';
    if (!key || mirror.on()) return null;
    try {
        const r = await fetch(`${VM_BASE_URL}${route}`, { headers: { 'x-sync-key': key, Accept: 'application/json' }, timeout: 8000 });
        return r.ok ? await r.json() : null;
    } catch (_) {
        return null;
    }
}

function parseCsvCountsAndDate_(filePath) {
    if (!fs.existsSync(filePath)) return { count: 0, baselineDate: '' };
    try {
        const text = fs.readFileSync(filePath, 'utf8');
        const lines = text.trim().split('\n');
        if (lines.length <= 1) return { count: 0, baselineDate: '' };
        const sep = lines[0].includes('\t') ? '\t' : ',';
        const header = lines[0].split(sep).map(s => s.replace(/"/g, '').trim());
        const dateIdx = header.indexOf('BASE_LINE_DATE');
        let baselineDate = '';
        for (let i = 1; i < lines.length; i++) {
            const row = lines[i].split(sep).map(s => s.replace(/"/g, '').trim());
            if (dateIdx !== -1 && row[dateIdx] && /^\d{8}$/.test(row[dateIdx])) {
                baselineDate = row[dateIdx];
                break;
            }
        }
        return { count: lines.length - 1, baselineDate };
    } catch (_) {
        return { count: 0, baselineDate: '' };
    }
}

function parseSummaryTotal_(filePath) {
    if (!fs.existsSync(filePath)) return { totalConsumers: 0, baselineDate: '', groupCount: 0 };
    try {
        const text = fs.readFileSync(filePath, 'utf8');
        const lines = text.trim().split('\n');
        if (lines.length <= 1) return { totalConsumers: 0, baselineDate: '', groupCount: 0 };
        const sep = lines[0].includes('\t') ? '\t' : ',';
        const header = lines[0].split(sep).map(s => s.replace(/"/g, '').trim());
        const dateIdx = header.indexOf('BASE_LINE_DATE');
        const countIdx = header.indexOf('UNBILLED_COUNT');
        let totalConsumers = 0;
        let baselineDate = '';
        for (let i = 1; i < lines.length; i++) {
            const row = lines[i].split(sep).map(s => s.replace(/"/g, '').trim());
            if (!baselineDate && dateIdx !== -1 && row[dateIdx] && /^\d{8}$/.test(row[dateIdx])) {
                baselineDate = row[dateIdx];
            }
            if (countIdx !== -1) {
                const val = parseInt(row[countIdx], 10);
                if (!isNaN(val)) totalConsumers += val;
            }
        }
        return { totalConsumers, baselineDate, groupCount: lines.length - 1 };
    } catch (_) {
        return { totalConsumers: 0, baselineDate: '', groupCount: 0 };
    }
}

const unbilledUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 30 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/\.(csv|tsv|txt)$/i.test(String(file.originalname || ''))) return cb(null, true);
        cb(new Error('Only CSV, TSV, or TXT files are allowed.'));
    }
});

app.post('/api/unbilled/upload', (req, res, next) => {
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized. Sign in to upload unbilled data.' });
    unbilledUpload.fields([
        { name: 'outsort', maxCount: 1 },
        { name: 'chronic', maxCount: 1 },
        { name: 'summary', maxCount: 1 },
        { name: 'file', maxCount: 1 }
    ])(req, res, async (err) => {
        if (err) return res.status(400).json({ status: 'error', message: err.message });
        try {
            if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized. Sign in to upload unbilled data.' });
            const user = await resolveFreshUser_(req, true);
            if (!canManageUnbilled_(user)) {
                return res.status(403).json({
                    status: 'error',
                    message: 'You are not authorized to upload unbilled data. Ask an admin to grant permission.'
                });
            }

            const files = req.files || {};
            const saved = [];

            const isVercel = Boolean(process.env.VERCEL || (req.headers.host && req.headers.host.includes('vercel.app')));
            if (isVercel) {
                try {
                    const fd = new FormData();
                    if (files.outsort && files.outsort[0]) {
                        fd.append('outsort', new Blob([files.outsort[0].buffer]), files.outsort[0].originalname || 'unbilled_outsort.csv');
                    }
                    if (files.chronic && files.chronic[0]) {
                        fd.append('chronic', new Blob([files.chronic[0].buffer]), files.chronic[0].originalname || 'unbilled_chronic.csv');
                    }
                    if (files.summary && files.summary[0]) {
                        fd.append('summary', new Blob([files.summary[0].buffer]), files.summary[0].originalname || 'unbilled_summary.csv');
                    }
                    if (files.file && files.file[0]) {
                        fd.append('file', new Blob([files.file[0].buffer]), files.file[0].originalname || 'file.csv');
                    }

                    const token = parseCookies(req.headers.cookie).mzo_session || '';
                    const vmResp = await fetch(`${VM_BASE_URL}/api/unbilled/upload`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`
                        },
                        body: fd,
                        timeout: 120 * 1000 // up to 30 MB per file
                    });
                    const vmData = await vmResp.json();
                    return res.status(vmResp.status).json(vmData);
                } catch (vmErr) {
                    console.error('Failed to forward unbilled upload to VM:', vmErr);
                    return res.status(502).json({ status: 'error', message: 'Failed to post unbilled data to VM: ' + vmErr.message });
                }
            }

            const localOutsort = path.join(DATA_DIR, 'unbilled_outsort.csv');
            const localChronic = path.join(DATA_DIR, 'unbilled_chronic.csv');
            const localSummary = path.join(DATA_DIR, 'unbilled_summary.csv');

            if (files.outsort && files.outsort[0]) {
                writeDataFile_('unbilled_outsort.csv', files.outsort[0].buffer);
                saved.push('outsort');
            }
            if (files.chronic && files.chronic[0]) {
                writeDataFile_('unbilled_chronic.csv', files.chronic[0].buffer);
                saved.push('chronic');
            }
            if (files.summary && files.summary[0]) {
                writeDataFile_('unbilled_summary.csv', files.summary[0].buffer);
                saved.push('summary');
            }

            if (files.file && files.file[0]) {
                const buf = files.file[0].buffer;
                const text = buf.toString('utf8', 0, 1024);
                if (text.includes('UNBILLED_COUNT')) {
                    writeDataFile_('unbilled_summary.csv', buf);
                    saved.push('summary');
                } else if (text.includes('INV_PENDING_FLAG') && files.file[0].originalname.toLowerCase().includes('chronic')) {
                    writeDataFile_('unbilled_chronic.csv', buf);
                    saved.push('chronic');
                } else {
                    writeDataFile_('unbilled_outsort.csv', buf);
                    saved.push('outsort');
                }
            }

            if (!saved.length) {
                return res.status(400).json({ status: 'error', message: 'No CSV files received. Please select at least one CSV file to upload.' });
            }

            const outsortInfo = parseCsvCountsAndDate_(localOutsort);
            const chronicInfo = parseCsvCountsAndDate_(localChronic);
            const summaryInfo = parseSummaryTotal_(localSummary);

            const rawDate = outsortInfo.baselineDate || chronicInfo.baselineDate || summaryInfo.baselineDate;
            let fmtDate = '';
            if (/^\d{8}$/.test(rawDate)) {
                fmtDate = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
            }

            const metaPayload = {
                asOn: fmtDate || rawDate || new Date().toISOString().split('T')[0],
                baselineDate: rawDate,
                outsortCount: outsortInfo.count,
                chronicCount: chronicInfo.count,
                currentMonCount: summaryInfo.totalConsumers,
                summaryGroups: summaryInfo.groupCount,
                source: 'Uploaded to VM by ' + (user.email || user.username || user.Username || 'Authorized User'),
                uploadedAt: new Date().toISOString()
            };

            writeDataFile_('unbilled_meta.json', JSON.stringify(metaPayload, null, 2));
            UNBILLED_META.set(metaPayload);

            logActivity({
                username: user.email || user.username || user.Username,
                name: user.name || user.Name || user.email,
                type: 'upload',
                details: `Uploaded unbilled datasets to VM (${saved.join(', ')}): date ${metaPayload.asOn}, ${metaPayload.currentMonCount} unbilled`
            }).catch(() => { });

            return res.json({
                status: 'success',
                message: `Successfully uploaded ${saved.length} file(s) directly to VM!`,
                saved,
                meta: metaPayload
            });
        } catch (err) {
            console.error('[Unbilled Upload Error]', err);
            return res.status(500).json({ status: 'error', message: err.message || 'Internal error processing upload' });
        }
    });
});

const UNAUTHORIZED_ = (res) => res.status(401).json({ status: 'error', message: 'Unauthorized' });

/**
 * Send a file from the server's data folder (or the snapshot folder) with an ETag and Last-Modified,
 * answering 304 to a matching revalidation. Resolves true once handled, false when the file is not
 * there (so the route can try its next source). A read error never escapes as an unhandled stream error.
 */
function sendDataFile_(req, res, file, contentType) {
    return new Promise((resolve) => {
        res.setHeader('Content-Type', contentType);
        res.sendFile(file, { cacheControl: false, dotfiles: 'allow' }, (err) => {
            if (!err) return resolve(true);
            if (!res.headersSent && (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.status === 404)) {
                res.removeHeader('Content-Type');
                return resolve(false);
            }
            if (!res.headersSent) res.status(500).json({ status: 'error', message: 'The file could not be read' });
            else if (err.code !== 'ECONNABORTED') res.destroy();
            resolve(true);
        });
    });
}

app.get('/api/unbilled/meta', async (req, res) => {
    if (!req.user) return UNAUTHORIZED_(res);
    res.setHeader('Cache-Control', 'private, max-age=15, must-revalidate');
    const user = await resolveFreshUser_(req);
    const canSync = user ? canManageUnbilled_(user) : false;
    let meta = await UNBILLED_META.read();
    if ((!meta || !meta.asOn) && !isVmHost_(req)) {
        const vmMeta = await vmJson_('/api/unbilled/meta');
        if (vmMeta && vmMeta.status === 'success') meta = vmMeta;
    }
    return res.json({
        status: 'success',
        canSync,
        canCrmSync: canSync,
        isAdmin: user ? isPortalAdmin_(user) : false,
        asOn: (meta && meta.asOn) || null,
        baselineDate: (meta && meta.baselineDate) || null,
        outsortCount: (meta && meta.outsortCount) || 0,
        chronicCount: (meta && meta.chronicCount) || 0,
        currentMonCount: (meta && meta.currentMonCount) || 0,
        summaryGroups: (meta && meta.summaryGroups) || 0,
        source: (meta && meta.source) || 'CRM DB2 (ISUDATA)',
        uploadedAt: (meta && meta.uploadedAt) || null,
        vmUrl: VM_BASE_URL
    });
});

app.get('/api/unbilled/outsort', async (req, res) => {
    if (!req.user) return UNAUTHORIZED_(res);
    res.setHeader('Cache-Control', 'private, max-age=60');
    if (await sendDataFile_(req, res, path.join(DATA_DIR, 'unbilled_outsort.csv'), 'text/csv; charset=utf-8')) return;
    if (await fromVm_(req, res, '/api/unbilled/outsort', 'text/csv; charset=utf-8')) return;
    return res.status(404).send('Not found');
});

app.get('/api/unbilled/chronic', async (req, res) => {
    if (!req.user) return UNAUTHORIZED_(res);
    res.setHeader('Cache-Control', 'private, max-age=60');
    if (await sendDataFile_(req, res, path.join(DATA_DIR, 'unbilled_chronic.csv'), 'text/csv; charset=utf-8')) return;
    if (await fromVm_(req, res, '/api/unbilled/chronic', 'text/csv; charset=utf-8')) return;
    return res.status(404).send('Not found');
});

app.get('/api/unbilled/summary', async (req, res) => {
    if (!req.user) return UNAUTHORIZED_(res);
    res.setHeader('Cache-Control', 'private, max-age=60');
    if (await sendDataFile_(req, res, path.join(DATA_DIR, 'unbilled_summary.csv'), 'text/csv; charset=utf-8')) return;
    if (await fromVm_(req, res, '/api/unbilled/summary', 'text/csv; charset=utf-8')) return;
    return res.status(404).send('Not found');
});

syncRoute_('/api/unbilled/crm-sync', {
    label: 'CRM Unbilled Sync',
    can: canManageUnbilled_,
    forbidden: 'Not authorized to sync unbilled data from CRM. Ask an admin to grant permission.',
    run: async (req) => {
        if (!isDbvisAvailable()) {
            throw new Error('DbVisualizer CLI is not available on this server. Direct CRM extraction must be run from an internal office workstation / VM connected to DB2.');
        }
        const userToken = req ? (parseCookies(req.headers.cookie).mzo_session || (req.headers.authorization && req.headers.authorization.slice(7).trim())) : null;
        return await syncUnbilledFromCrm({ fresh: true, userToken });
    },
    meta: UNBILLED_META,
    mirrorKeys: ['unbilled_outsort', 'unbilled_chronic', 'unbilled_summary'],
    done: (m) => ({
        log: `CRM Synced Unbilled: ${m.outsortCount} outsorts, ${m.chronicCount} chronic, ${m.currentMonCount} current month; uploaded to VM`,
        message: `Unbilled & Billing Exceptions sync complete! Outsorts: ${m.outsortCount}, Chronic (>=3m): ${m.chronicCount}. Uploaded directly to VM!`
    })
});

// Disconnection tracker
const DISCONNECTION_SHEET_FALLBACK_URL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vSkl9m38XuD5aewajE7Fc0hucP9DWz1UwEqJZeu5wELWZivSEEXWrhl7RiHFSezGeGiGdDB53s1bWit/pub?gid=0&single=true&output=csv';
const DISCONNECTION_FOLLOWUP_SCRIPT_URL = String(
    process.env.DISCONNECTION_FOLLOWUP_SCRIPT_URL ||
    'https://script.google.com/macros/s/AKfycbxaczauxohDew8CYAfus161TrdzJ0AG6lRvxmxjJyxqIyQwEUVtrNuXc9M3uHzon7CB/exec'
).trim();

const canSyncDisconnection_ = (user) => hasPermission_(user, 'disconnection-sync-autho', ['discon', 'sync']);

app.get('/api/disconnection/meta', async (req, res) => {
    if (!req.user) return UNAUTHORIZED_(res);
    res.setHeader('Cache-Control', 'private, max-age=15, must-revalidate');

    const user = await resolveFreshUser_(req);
    const canSync = canSyncDisconnection_(user);
    const isAdmin = isPortalAdmin_(user);

    let meta = await DISCONNECTION_META.read();
    if ((!meta || !meta.version) && !isVmHost_(req)) {
        const vmMeta = await vmJson_('/api/disconnection/meta');
        if (vmMeta && vmMeta.status === 'success') meta = vmMeta;
    }

    const synced = await syncedMetaFields_(meta, DISCONNECTION_SHEET_FALLBACK_URL, 'CACHE_DISCONNECTION', res);
    const isVm = isVmHost_(req);

    return res.json({
        status: 'success',
        canSync,
        canCrmSync: canSync && isDbvisAvailable(),
        isAdmin,
        sheetScriptUrl: DISCONNECTION_FOLLOWUP_SCRIPT_URL,
        vmUrl: VM_BASE_URL,
        ...synced,
        csvUrl: isVm ? '/api/disconnection/dataset' : (synced.csvUrl || '/api/disconnection/dataset'),
        datasetUrl: '/api/disconnection/dataset'
    });
});

app.get('/api/disconnection/dataset', async (req, res) => {
    if (!req.user) return UNAUTHORIZED_(res);
    res.setHeader('Cache-Control', 'private, max-age=60');

    // 1. The uploaded list in the server's data folder (MZO_FILES_DIR on the VM)
    if (await sendDataFile_(req, res, path.join(DATA_DIR, 'disconnection.csv'), 'text/csv; charset=utf-8')) return;

    // 2. Mirror snapshot directory
    if (mirror.on() && mirror.dir && await sendDataFile_(req, res, path.join(mirror.dir, 'disconnection.csv'), 'text/csv; charset=utf-8')) return;

    // 3. Off the VM: the VM's copy, fetched server-side
    if (await fromVm_(req, res, '/api/disconnection/dataset', 'text/csv; charset=utf-8')) return;

    // 4. Fallback to Supabase snapshot or Google Sheet CSV
    const meta = await DISCONNECTION_META.read().catch(() => null);
    const targetUrl = (meta && /^https:\/\//i.test(String(meta.csvUrl || '')) && meta.csvUrl) || DISCONNECTION_SHEET_FALLBACK_URL;
    return res.redirect(302, targetUrl);
});

const disconnectionUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/\.(csv|tsv|txt)$/i.test(String(file.originalname || ''))) return cb(null, true);
        cb(new Error('Only CSV, TSV, or TXT files are allowed.'));
    }
});

app.post('/api/disconnection/upload', async (req, res) => {
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized to upload disconnection dataset to VM' });
    const user = await resolveFreshUser_(req);
    if (!canSyncDisconnection_(user)) {
        return res.status(403).json({ status: 'error', message: 'Not authorized to upload the disconnection dataset. Ask an admin to grant permission.' });
    }

    disconnectionUpload.single('file')(req, res, async (err) => {
        if (err) return res.status(400).json({ status: 'error', message: err.message });
        if (!req.file) return res.status(400).json({ status: 'error', message: 'No file uploaded' });

        try {
            writeDataFile_('disconnection.csv', req.file.buffer);

            refreshMirror(['disconnection'], 'direct disconnection VM upload');
            logActivity({
                username: user.email || user.username || user.Username,
                name: user.name || user.Name || user.email,
                type: 'upload',
                details: `Uploaded disconnection dataset to VM (${(req.file.size / 1024).toFixed(1)} KB)`
            }).catch(() => { });

            return res.json({
                status: 'success',
                message: `Successfully uploaded disconnection dataset directly to VM (${(req.file.size / 1024).toFixed(1)} KB)!`
            });
        } catch (uploadErr) {
            return res.status(500).json({ status: 'error', message: uploadErr.message });
        }
    });
});

app.get('/api/disconnection/payments', async (req, res) => {
    if (!req.user) return UNAUTHORIZED_(res);
    res.setHeader('Cache-Control', 'private, max-age=30');

    if (await sendDataFile_(req, res, path.join(DATA_DIR, 'disconnection_payments.json'), 'application/json; charset=utf-8')) return;
    if (await fromVm_(req, res, '/api/disconnection/payments', 'application/json; charset=utf-8')) return;

    res.json({ generatedAt: '', totalMatched: 0, totalCollected: 0, consumers: {} });
});

const paymentsUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/\.json$/i.test(String(file.originalname || ''))) return cb(null, true);
        cb(new Error('Only JSON files are allowed.'));
    }
});

// Payment history from the DB2 payment sync (scripts/sync/sync_disconnection_payments.js): field "file"
// is disconnection_payments.json and the optional field "meta" is disconnection_meta.json. The caller is
// a signed-in user with the disconnection sync permission, or the script with x-sync-key (requireAuth,
// SYNC_UPLOAD_ROUTES).
app.post('/api/disconnection/payments-upload', async (req, res) => {
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    const user = await resolveFreshUser_(req);
    if (!canSyncDisconnection_(user)) {
        return res.status(403).json({ status: 'error', message: 'Not authorized to upload payment history. Ask an admin to grant permission.' });
    }

    paymentsUpload.fields([{ name: 'file', maxCount: 1 }, { name: 'meta', maxCount: 1 }])(req, res, async (err) => {
        if (err) return res.status(400).json({ status: 'error', message: err.message });
        const file = req.files && req.files.file && req.files.file[0];
        const metaFile = req.files && req.files.meta && req.files.meta[0];
        if (!file) return res.status(400).json({ status: 'error', message: 'No file uploaded' });

        try {
            let payments, meta = null;
            try {
                payments = JSON.parse(file.buffer.toString('utf8'));
                if (metaFile) meta = JSON.parse(metaFile.buffer.toString('utf8'));
            } catch (_) {
                return res.status(400).json({ status: 'error', message: 'The upload is not valid JSON' });
            }
            if (!payments || typeof payments !== 'object' || !payments.consumers || typeof payments.consumers !== 'object') {
                return res.status(400).json({ status: 'error', message: 'Payment history has no consumers object' });
            }
            if (meta !== null && (typeof meta !== 'object' || Array.isArray(meta))) {
                return res.status(400).json({ status: 'error', message: 'Meta must be a JSON object' });
            }
            writeDataFile_('disconnection_payments.json', file.buffer);
            if (meta) {
                writeDataFile_('disconnection_meta.json', JSON.stringify(meta, null, 2));
                DISCONNECTION_META.set(meta);
            }
            logActivity({
                username: user.email || user.username || user.Username,
                name: user.name || user.Name || user.email,
                type: 'upload',
                details: `Uploaded disconnection payment history to VM (${(file.size / 1024).toFixed(1)} KB${meta ? ', with meta' : ''})`
            }).catch(() => { });
            return res.json({ status: 'success', message: 'Uploaded payment history directly to VM!', meta: Boolean(meta) });
        } catch (uploadErr) {
            return res.status(500).json({ status: 'error', message: uploadErr.message });
        }
    });
});

syncRoute_('/api/disconnection/payment-sync', {
    label: 'Disconnection Payment Sync',
    can: canSyncDisconnection_,
    forbidden: 'Not authorized to sync payment collections. Ask an admin to grant permission.',
    run: async (req) => {
        if (!isDbvisAvailable()) {
            throw new Error('DbVisualizer CLI is not available on this server. Payment extraction must be run from an internal office workstation / VM connected to DB2.');
        }
        const userToken = req ? (parseCookies(req.headers.cookie).mzo_session || (req.headers.authorization && req.headers.authorization.slice(7).trim())) : null;
        return await syncDisconnectionPayments({ fresh: true, userToken });
    },
    meta: DISCONNECTION_META,
    mirrorKeys: ['disconnection'],
    bareError: true,
    done: (m) => ({
        log: `Payment Synced Disconnection Tracker: ${m.matchedCount || 0} consumers matched (₹${Math.round(m.totalCollected || 0).toLocaleString('en-IN')})`,
        message: m.message || 'Payment sync complete!'
    })
});

syncRoute_('/api/disconnection/crm-sync', {
    label: 'CRM Disconnection Sync',
    can: canSyncDisconnection_,
    forbidden: 'Not authorized to sync disconnection data from CRM. Ask an admin to grant permission.',
    run: async (req) => {
        if (!isDbvisAvailable()) {
            throw new Error('DbVisualizer CLI is not available on this server. Direct CRM extraction must be run from an internal office workstation / VM connected to DB2.');
        }
        const userToken = req ? (parseCookies(req.headers.cookie).mzo_session || (req.headers.authorization && req.headers.authorization.slice(7).trim())) : null;
        return await syncDisconnectionFromCrm({ fresh: true, userToken });
    },
    meta: DISCONNECTION_META,
    mirrorKeys: ['disconnection'],
    bareError: true,
    done: (m) => ({
        log: `CRM Synced Disconnection Tracker: ${m.stats ? m.stats.totalConsumers : 'complete'} rows`,
        message: m.message || `CRM Disconnection sync complete! Successfully updated from IBM DB2.`
    })
});

syncRoute_('/api/disconnection/sync', {
    label: 'Disconnection Sync',
    can: canSyncDisconnection_,
    forbidden: 'Not authorized to sync disconnection data. Ask an admin to grant permission.',
    run: syncDisconnectionToSupabase,
    meta: DISCONNECTION_META,
    mirrorKeys: ['disconnection'],
    bareError: true,
    done: (m) => ({
        log: `Synced Disconnection Tracker: ${m.stats.totalConsumers} rows`,
        message: `Successfully synced ${m.stats.totalConsumers} consumers from Google Sheets to Cloud Cache.`
    })
});

// Pending master card
const PENDING_MC_SHEET_FALLBACK_URL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vQmOUW4jxUtEGWhPHaoNBsvpBcGzhHJZRUx_9mxFBp91sfg4yD8WIqIK_xv0vlFs2yP-Ljz09JW1U2c/pub?gid=0&single=true&output=csv';

const canSyncPendingMc_ = (user) => hasPermission_(user, 'pending-mc-sync-autho', ['mc', 'pending', 'sync']);

app.get('/api/pending-mc/meta', async (req, res) => {
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    const user = await resolveFreshUser_(req);
    const meta = await PENDING_MC_META.read();
    res.setHeader('Cache-Control', 'private, max-age=15, must-revalidate');
    return res.json({
        status: 'success',
        canSync: canSyncPendingMc_(user),
        isAdmin: isPortalAdmin_(user),
        ...(await syncedMetaFields_(meta, PENDING_MC_SHEET_FALLBACK_URL, 'CACHE_PENDING_MC', res))
    });
});

syncRoute_('/api/pending-mc/sync', {
    label: 'Pending MC Sync',
    can: canSyncPendingMc_,
    forbidden: 'Not authorized to sync Pending Master Card data. Ask an admin to grant permission.',
    run: syncPendingMcToSupabase,
    meta: PENDING_MC_META,
    mirrorKeys: ['pending_mc'],
    done: (m) => ({
        log: `Synced Pending Master Card: ${m.stats.totalPending} records`,
        message: `Successfully synced ${m.stats.totalPending} Pending MC records to Cloud Cache.`
    })
});

// Pending load extension
const LOAD_EXT_SHEET_FALLBACK_URL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vQP_B-Zl5XhnYkmJiDXKB7B8ksrRRezuLrRqTzEPz4lEw_yDcpGOTnmm0oI8dW9apwuHg9yGqaAqjDS/pub?gid=0&single=true&output=csv';

const canSyncLoadExt_ = (user) => hasPermission_(user, 'load-ext-sync-autho', ['load', 'ext', 'sync']);

app.get('/api/load-extension/meta', async (req, res) => {
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    const user = await resolveFreshUser_(req);
    const meta = await LOAD_EXT_META.read();
    res.setHeader('Cache-Control', 'private, max-age=15, must-revalidate');
    return res.json({
        status: 'success',
        canSync: canSyncLoadExt_(user),
        isAdmin: isPortalAdmin_(user),
        ...(await syncedMetaFields_(meta, LOAD_EXT_SHEET_FALLBACK_URL, 'CACHE_LOAD_EXT', res))
    });
});

syncRoute_('/api/load-extension/sync', {
    label: 'Load Extension Sync',
    can: canSyncLoadExt_,
    forbidden: 'Not authorized to sync Load Extension data. Ask an admin to grant permission.',
    run: syncLoadExtToSupabase,
    meta: LOAD_EXT_META,
    mirrorKeys: ['load_extension'],
    done: (m) => ({
        log: `Synced Load Extension: ${m.stats.totalPending} applications`,
        message: `Successfully synced ${m.stats.totalPending} Load Extension applications to Cloud Cache.`
    })
});

// Safety Inspection report (direct VM upload / bookmarklet sync)
// An authorised user uploads the safety app's export (.xlsx or .csv) from the page, or from the safety
// app's site with the bookmarklet and a short-lived upload token (SAFETY_UPLOAD_ORIGINS, above). The file
// is read in a worker thread with memory and time limits (lib/safety_parser.js) and stored in the data
// folder as canonical CSV; until the first upload the page reads the Google sheet.
const SAFETY_SHEET_FALLBACK_URL =
    'https://docs.google.com/spreadsheets/d/1A2fjKboWKnw10iaOs1wcXDrdg9jhhDGfzF9OagPjA5s/gviz/tq?tqx=out:csv';
const { parseSafetyReportIsolated } = require('./lib/safety_parser');
const SAFETY_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

const safetyUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: SAFETY_UPLOAD_MAX_BYTES, files: 1, fields: 5, parts: 6 }
});

const canSyncSafety_ = (user) => isPortalAdmin_(user) || hasPermission_(user, 'safety-sync-autho', ['safety', 'sync']);

app.get('/api/safety/meta', async (req, res) => {
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    const user = await resolveFreshUser_(req);
    const meta = await SAFETY_META.read();
    res.setHeader('Cache-Control', 'private, no-store');
    const canSync = canSyncSafety_(user);
    // The bookmarklet's upload token: only for a user who may upload, and only from a cookie session.
    const upload = canSync ? mintScopedToken_(req, SAFETY_UPLOAD_SCOPE, SAFETY_UPLOAD_TOKEN_MS) : { token: '', exp: 0 };
    return res.json({
        status: 'success',
        canSync,
        isAdmin: isPortalAdmin_(user),
        ...(upload.token ? { uploadToken: upload.token, uploadTokenExpires: new Date(upload.exp).toISOString() } : {}),
        totalRows: meta && meta.totalRows != null ? meta.totalRows : null,
        mzoRows: meta && meta.mzoRows != null ? meta.mzoRows : null,
        lastSync: (meta && meta.lastSync) || null,
        updatedBy: (meta && meta.updatedBy) || null,
        ...(await syncedMetaFields_(meta, SAFETY_SHEET_FALLBACK_URL, 'CACHE_SAFETY_v2', res))
    });
});

app.get('/api/safety/dataset', async (req, res) => {
    if (!req.user) return UNAUTHORIZED_(res);
    res.setHeader('Cache-Control', 'private, max-age=60');
    if (await sendDataFile_(req, res, path.join(DATA_DIR, 'safety_inspection.csv'), 'text/csv; charset=utf-8')) return;
    res.removeHeader('Cache-Control');
    return res.redirect(302, SAFETY_SHEET_FALLBACK_URL);
});

let safetyUploadRunning = false;
app.post('/api/safety/upload', (req, res) => {
    // From the safety app's site only with an upload token; a session is never accepted as a Bearer token here.
    if (!req.scopedUpload && /^Bearer\s/i.test(String(req.headers.authorization || ''))) {
        return res.status(401).json({ status: 'error', message: SAFETY_TOKEN_EXPIRED_MSG });
    }
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized. Please sign in to DISHA.' });
    if (safetyUploadRunning) return res.status(429).json({ status: 'error', message: 'Another Safety upload is being processed. Please try again in a minute.' });
    safetyUploadRunning = true;
    let released = false;
    const release = () => { if (!released) { released = true; safetyUploadRunning = false; } };
    res.on('close', release);
    safetyUpload.single('file')(req, res, async (err) => {
        try {
            if (err) {
                const tooBig = err.code === 'LIMIT_FILE_SIZE';
                return res.status(tooBig ? 413 : 400).json({ status: 'error', message: tooBig ? `The file is larger than ${SAFETY_UPLOAD_MAX_BYTES / 1024 / 1024} MB.` : 'The upload could not be read.' });
            }
            const user = await resolveFreshUser_(req, true);
            if (!canSyncSafety_(user)) {
                return res.status(403).json({ status: 'error', message: 'Not authorized to sync Safety data. Admin permission required.' });
            }
            if (!req.file || !req.file.buffer || !req.file.buffer.length) {
                return res.status(400).json({ status: 'error', message: 'No file received.' });
            }
            let parsed;
            try {
                parsed = await parseSafetyReportIsolated(req.file.buffer, req.file.originalname, { timeoutMs: 60000, maxMemoryMb: 384 });
            } catch (parseErr) {
                return res.status(400).json({ status: 'error', message: parseErr.message });
            }
            req.file.buffer = null;

            writeDataFile_('safety_inspection.csv', Buffer.from(parsed.csv, 'utf8'));
            const now = new Date();
            const meta = {
                version: String(now.getTime()),
                lastSync: now.toISOString(),
                reportDate: now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }),
                totalRows: parsed.totalRows,
                mzoRows: parsed.mzoRows,
                updatedBy: user.Username || user.username || 'Admin',
                csvUrl: '/api/safety/dataset',
                source: 'upload'
            };
            writeDataFile_('safety_inspection_meta.json', Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
            SAFETY_META.set(meta);
            refreshMirror(['safety_inspection'], 'safety inspection upload');

            await logActivity({
                username: user.Username || user.username,
                name: user.Name || user.name || 'Admin',
                type: 'report_sync',
                details: `Synced Safety Inspection data${req.scopedUpload ? ' (bookmarklet)' : ''}: ${parsed.totalRows} total rows (${parsed.mzoRows} Malda Zone rows)`
            }).catch(() => {});

            return res.json({
                status: 'success',
                message: `Successfully synced Safety Inspection. ${parsed.totalRows.toLocaleString('en-IN')} total rows (${parsed.mzoRows.toLocaleString('en-IN')} Malda Zone).`,
                meta
            });
        } catch (uploadErr) {
            console.error('[Safety Upload] Error:', uploadErr.message);
            if (!res.headersSent) return res.status(500).json({ status: 'error', message: 'The Safety report could not be saved.' });
        } finally {
            release();
        }
    });
});

const NSC_FOLLOWUP_SCRIPT_URL = String(
    process.env.NSC_FOLLOWUP_SCRIPT_URL ||
    'https://script.google.com/macros/s/AKfycbwJj6lpOWN0a62jX51926FUQyzViLOiKA38f9yqSBSYbLMnpBPvOMZQh3gYu0b07L7MJw/exec'
).trim();

app.get('/api/nsc/followup-meta', (req, res) => {
    if (!req.user) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.json({
        status: 'success',
        sheetScriptUrl: NSC_FOLLOWUP_SCRIPT_URL
    });
});

app.get('/api/hub/versions', async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }
    const versions = {};
    const csvUrls = {};
    const synced = (meta, key, csvUrl) => {
        if (meta && meta.version) versions[key] = meta.version;
        csvUrls[key] = (meta && meta.version && meta.csvUrl) || csvUrl;
    };
    // Each source is independent: fetch in parallel, and one failing does not hide the others.
    const tasks = {
        nsc: async () => {
            const sheetMeta = await fetchNscSheetMeta_();
            const nscMeta = sheetMeta && (sheetMeta.reportDate || sheetMeta.uploadedAt || sheetMeta.publishedRows)
                ? sheetMeta
                : readLocalNscMeta_();
            const nscVer = snapshotVersion_(nscMeta);
            const whVer = snapshotWithheldVersion_(nscMeta);
            if (nscVer) versions.CACHE_NSC_v5 = nscVer;
            if (whVer) versions.CACHE_WITHHELD_v4 = whVer;
            csvUrls.CACHE_NSC_v5 = NSC_SHEET_FALLBACK_URL;
            csvUrls.CACHE_WITHHELD_v4 = NSC_WITHHELD_SHEET_FALLBACK_URL;
        },
        stock: async () => {
            const sb = await fetchActiveStockMeta_();
            const stockVer = snapshotVersion_(sb ? stockMetaFromDb_(sb) : readLocalStockMeta_());
            if (stockVer) versions.CACHE_STOCK = stockVer;
            csvUrls.CACHE_STOCK = stockStorageOrigin_() ? stockPublicCsvUrl_(stockVer) : STOCK_SHEET_FALLBACK_URL;
        },
        disconnection: async () => {
            const meta = await DISCONNECTION_META.read();
            if (meta && meta.version) synced(meta, 'CACHE_DISCONNECTION', DISCONNECTION_SHEET_FALLBACK_URL);
        },
        defective: async () => {
            const meta = await DEFECTIVE_META.read();
            const has = !!(meta && meta.version);
            if (has) {
                versions.CACHE_DEFECTIVE = meta.version;
                versions.CACHE_DEFECTIVE_DETAILS = meta.version;
            }
            csvUrls.CACHE_DEFECTIVE = (has && meta.summaryCsvUrl) || defectiveExportCsvUrl_(DEFECTIVE_SUMMARY_GID);
            csvUrls.CACHE_DEFECTIVE_DETAILS = (has && meta.detailsCsvUrl) || defectiveExportCsvUrl_(DEFECTIVE_DETAILS_GID);
        },
        pendingMc: async () => synced(await PENDING_MC_META.read(), 'CACHE_PENDING_MC', PENDING_MC_SHEET_FALLBACK_URL),
        loadExt: async () => synced(await LOAD_EXT_META.read(), 'CACHE_LOAD_EXT', LOAD_EXT_SHEET_FALLBACK_URL),
        safety: async () => synced(await SAFETY_META.read(), 'CACHE_SAFETY_v2', SAFETY_SHEET_FALLBACK_URL),
        powerMap: async () => {
            // Mirror mode: the same value from the table snapshot, without a Supabase request.
            const pmRows = mirror.on() ? await mirror.readJson('power_map_substations') : null;
            let pmVer = '';
            if (Array.isArray(pmRows)) {
                pmVer = powerMapLatestUpdatedAt_(pmRows);
            } else {
                const latest = await querySupabase(POWER_MAP_TABLE + '?select=updated_at&order=updated_at.desc&limit=1');
                const row = Array.isArray(latest) && latest[0] ? latest[0] : latest;
                pmVer = String((row && row.updated_at) || '').trim();
            }
            if (pmVer) versions.CACHE_POWER_MAP = pmVer;
            csvUrls.CACHE_POWER_MAP = POWER_MAP_SHEET_CSV_URL;
        },
        // Versions of the remaining datasets, kept by apps-script/mzo_metadata_sync.gs (applied last).
        metadata: async () => {
            const url = process.env.METADATA_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbwhkAICXC-UH8i9BaWp7zl4NjrxnaFm5RaXZUvZDzOI9AV7XWndMvpuL9lsMtIovwogZg/exec';
            const metaRes = await fetch(url, { signal: AbortSignal.timeout(3500) });
            if (!metaRes.ok) return null;
            const parsed = JSON.parse(await metaRes.text());
            return parsed && parsed.versions;
        }
    };
    // Mirror mode: every DataHub key in the manifest gets its version and URL from there. The live reads
    // still run (cached, Power Map from its snapshot): what they give is returned as liveVersions, because
    // pages show those versions as dates.
    const fromMirror = await mirror.dataHubEntries();
    const names = Object.keys(tasks);
    const results = await Promise.allSettled(names.map((n) => tasks[n]()));
    results.forEach((r, i) => {
        if (r.status === 'rejected') console.warn(`[Hub versions] ${names[i]}:`, r.reason && r.reason.message);
    });
    const extra = results[names.indexOf('metadata')];
    if (extra.status === 'fulfilled' && extra.value) Object.assign(versions, extra.value);
    const liveVersions = {};
    fromMirror.forEach((x) => {
        if (versions[x.dataHubKey]) liveVersions[x.dataHubKey] = versions[x.dataHubKey];
        versions[x.dataHubKey] = x.version;
        csvUrls[x.dataHubKey] = x.dataHubKey === 'CACHE_POWER_MAP' ? POWER_MAP_DATA_URL : x.url;
    });
    if (fromMirror.length) res.setHeader('X-Mzo-Data', 'mirror');

    res.setHeader('Cache-Control', 'private, max-age=15, must-revalidate');
    return res.json(fromMirror.length ? { status: 'success', versions, csvUrls, liveVersions } : { status: 'success', versions, csvUrls });
});

// ──────────────────────────────────────
//   Power News Hub Feed API (/api/news)
// ──────────────────────────────────────
const NEWS_FEEDS_CONFIG = {
    english: {
        query: '(electricity OR "power sector" OR WBSEDCL OR "power outage") AND ("West Bengal" OR Malda OR "Uttar Dinajpur" OR "Dakshin Dinajpur" OR Raiganj OR Balurghat) -Roy -BJP -TMC -Bangladesh -BD -Dhaka -Rangpur',
        lang: 'en-IN',
        ceid: 'IN:en'
    },
    bangla: {
        query: '(বিদ্যুৎ OR "বিদ্যুৎ পর্ষদ" OR WBSEDCL OR লোডশেডিং) AND ("পশ্চিমবঙ্গ" OR "উত্তরবঙ্গ" OR "মালদা" OR "উত্তর দিনাজপুর" OR "দক্ষিণ দিনাজপুর" OR "রায়গঞ্জ" OR "বালুরঘাট") -রায় -বিজেপি -তৃণমূল -বাংলাদেশ -ঢাকা -রংপুর',
        lang: 'bn-IN',
        ceid: 'IN:bn'
    },
    districts: {
        query: '(electricity OR power OR WBSEDCL OR বিদ্যুৎ OR লোডশেডিং) AND (site:anandabazar.com OR site:uttarbangasambad.in OR "Anandabazar Patrika" OR "Uttarbanga Sambad" OR "Uttar Banga Sambad" OR Malda OR "Uttar Dinajpur" OR "Dakshin Dinajpur" OR Raiganj OR Balurghat) -Roy -BJP -TMC -রায় -বিজেপি -তৃণমূল -Bangladesh -BD -Dhaka -Rangpur -বাংলাদেশ -ঢাকা -রংপুর',
        lang: 'en-IN',
        ceid: 'IN:en'
    },
    national: {
        query: '(electricity OR "power sector" OR "national grid" OR "power reforms" OR "green energy transition") AND (India OR "Ministry of Power" OR "NTPC" OR "Power Grid Corporation" OR "PGCIL" OR "CEA") -Roy -BJP -TMC -Bangladesh -BD -Dhaka -Rangpur',
        lang: 'en-IN',
        ceid: 'IN:en'
    }
};

let cachedNewsItems_ = [];
let lastNewsFetchTime_ = 0;
const NEWS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function fetchRssXml_(url, maxRedirects = 3) {
    return new Promise((resolve) => {
        if (maxRedirects <= 0) return resolve('');
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/rss+xml, application/xml, text/xml, */*'
            },
            timeout: 10000
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let loc = res.headers.location;
                if (loc.startsWith('/')) loc = 'https://news.google.com' + loc;
                return resolve(fetchRssXml_(loc, maxRedirects - 1));
            }
            if (res.statusCode !== 200) {
                return resolve('');
            }
            let xml = '';
            res.on('data', chunk => xml += chunk);
            res.on('end', () => resolve(xml));
        });
        req.on('error', () => resolve(''));
        req.on('timeout', () => { req.destroy(); resolve(''); });
    });
}

function isAccidentNews_(title, desc) {
    const text = ((title || '') + ' ' + (desc || '')).toLowerCase();
    const keywords = [
        'electrocution', 'electrocuted', 'electrical accident', 'short circuit',
        'electric shock', 'transformer blast', 'electric fire', 'power line death',
        'high voltage death', 'live wire death',
        'বিদ্যুৎস্পৃষ্ট', 'শর্ট সার্কিট', 'বিদ্যুৎ দুর্ঘটনা', 'বিদ্যুৎস্পর্শ', 'বিদ্যুৎস্পৃষ্টে মৃত্যু'
    ];
    return keywords.some(k => text.includes(k));
}

function parseGoogleRssXml_(xml, category = 'national') {
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
        const itemBlock = match[1];
        const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(itemBlock);
        const linkMatch = /<link>([\s\S]*?)<\/link>/i.exec(itemBlock);
        const pubDateMatch = /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(itemBlock);
        const descMatch = /<description>([\s\S]*?)<\/description>/i.exec(itemBlock);
        const sourceMatch = /<source[^>]*>([\s\S]*?)<\/source>/i.exec(itemBlock);

        let rawTitle = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
        let sourceName = sourceMatch ? sourceMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';

        // Google News titles always end with " - Source Name"
        if (rawTitle.includes(' - ')) {
            const lastIdx = rawTitle.lastIndexOf(' - ');
            if (!sourceName) {
                sourceName = rawTitle.substring(lastIdx + 3).trim();
            }
            rawTitle = rawTitle.substring(0, lastIdx).trim();
        }

        // Clean description: Google News RSS descriptions are purely duplicate anchor tags pointing to the article.
        // Strip all HTML and entities. If the text only duplicates the title/source, keep it empty.
        let rawDesc = descMatch ? descMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
        let cleanDesc = rawDesc
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#039;/g, "'")
            .replace(/&amp;/g, '&')
            .replace(/&nbsp;/g, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const lowerDesc = cleanDesc.toLowerCase();
        const lowerTitle = rawTitle.toLowerCase();
        const lowerSource = sourceName.toLowerCase();

        if (lowerDesc === lowerTitle ||
            lowerDesc === (lowerTitle + ' ' + lowerSource) ||
            lowerDesc === (lowerTitle + ' - ' + lowerSource) ||
            lowerDesc.startsWith(lowerTitle)) {
            cleanDesc = '';
        }

        const isAccident = isAccidentNews_(rawTitle, cleanDesc);

        items.push({
            title: rawTitle,
            link: linkMatch ? linkMatch[1].trim() : '',
            pubDate: pubDateMatch ? pubDateMatch[1].trim() : '',
            description: cleanDesc,
            source: sourceName || 'News',
            category: category,
            isAccident: isAccident
        });
    }
    return items;
}

async function fetchAllNewsFeeds_() {
    const feedEntries = Object.entries(NEWS_FEEDS_CONFIG);
    const results = await Promise.all(feedEntries.map(([categoryKey, feed]) => {
        const url = `https://news.google.com/rss/search?q=${encodeURIComponent(feed.query)}&hl=${feed.lang}&gl=IN&ceid=${feed.ceid}`;
        return fetchRssXml_(url).then(xml => parseGoogleRssXml_(xml, categoryKey));
    }));

    const merged = [].concat(...results);
    const seen = new Set();
    const unique = [];

    merged.forEach(item => {
        const key = (item.link || item.title || '').trim();
        if (key && !seen.has(key)) {
            seen.add(key);
            unique.push(item);
        }
    });

    unique.sort((a, b) => {
        const dateA = new Date(a.pubDate || 0);
        const dateB = new Date(b.pubDate || 0);
        return dateB - dateA;
    });

    return unique;
}

let newsFetching_ = null; // one fetch of the feeds at a time, shared by every caller
let lastNewsForceAt_ = 0;

/** Refetch the feeds (joining a fetch already running); keeps the last good list when they come back empty. */
function refreshNews_() {
    if (!newsFetching_) {
        newsFetching_ = fetchAllNewsFeeds_().then((items) => {
            if (items.length > 0) {
                cachedNewsItems_ = items;
                lastNewsFetchTime_ = Date.now();
            }
            return cachedNewsItems_;
        }).finally(() => { newsFetching_ = null; });
    }
    return newsFetching_;
}

app.get('/api/news', async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    try {
        const now = Date.now();
        // The route is public: ?force=1 refetches only for a signed-in user, and at most once a minute.
        const force = (req.query.force === '1' || req.query.force === 'true') && !!req.user && now - lastNewsForceAt_ > 60 * 1000;
        if (force) lastNewsForceAt_ = now;
        if (!force && cachedNewsItems_.length > 0 && (now - lastNewsFetchTime_) < NEWS_CACHE_TTL_MS) {
            return res.json({ status: 'ok', items: cachedNewsItems_, cached: true });
        }

        await refreshNews_();
        return res.json({ status: 'ok', items: cachedNewsItems_ });
    } catch (err) {
        console.error('[News API] Error:', err);
        if (cachedNewsItems_.length > 0) {
            return res.json({ status: 'ok', items: cachedNewsItems_, fallback: true });
        }
        return res.status(500).json({ status: 'error', message: 'Failed to fetch news' });
    }
});

function formatCr_(num) {
    if (!num || isNaN(num)) return '0.00 Cr';
    const cr = Number(num) / 10000000;
    return cr.toFixed(2) + ' Cr';
}

function formatLakh_(num) {
    if (!num || isNaN(num)) return '0.00 L';
    const lk = Number(num) / 100000;
    return lk.toFixed(2) + ' L';
}

function cleanDivisionCccs_(divCccs) {
    if (!divCccs || typeof divCccs !== 'object') return {};
    const out = {};
    for (const [div, list] of Object.entries(divCccs)) {
        if (!Array.isArray(list)) continue;
        const map = new Map();
        for (const item of list) {
            let name = String(item.name || '').trim();
            const lower = name.toLowerCase();
            if (lower === 'pa') name = 'Pandua';
            else if (lower === 'gazol') name = 'Gazole';
            else if (lower === 'h.c. pur' || lower === 'hc pur') name = 'Harishchandrapur';
            else if (lower === 'baisnabnagar') name = 'Baishnabnagar';
            else if (lower === 'kumargunj') name = 'Kumarganj';
            else if (lower === 'kushmundi' || lower === 'kushmandi') name = 'Kusmandi';
            else if (lower === 'karandeghi') name = 'Karandighi';
            else if (lower === 'bamangola') name = 'Bamongola';
            else if (lower === 'goalpokhar') name = 'Goalpokher';

            if (!map.has(name)) {
                map.set(name, { ...item, name });
            } else {
                const prev = map.get(name);
                prev.count = (Number(prev.count) || 0) + (Number(item.count) || 0);
                if (item.amountCr != null || prev.amountCr != null) {
                    prev.amountCr = (Number(prev.amountCr) || 0) + (Number(item.amountCr) || 0);
                }
                if (item.osd != null || prev.osd != null) {
                    prev.osd = (Number(prev.osd) || 0) + (Number(item.osd) || 0);
                }
            }
        }
        out[div] = Array.from(map.values()).sort((a, b) => (b.count || 0) - (a.count || 0));
    }
    return out;
}

// lib/briefing_cccs.json (scripts/tools/compute_briefing_cccs.js), parsed again only when the file changes.
const BRIEFING_CCCS_FILE = path.join(__dirname, 'lib', 'briefing_cccs.json');
let briefingCccsCache_ = { mtimeMs: -1, value: [] };
function briefingCccs_() {
    try {
        const st = fs.statSync(BRIEFING_CCCS_FILE);
        if (st.mtimeMs !== briefingCccsCache_.mtimeMs) {
            briefingCccsCache_ = { mtimeMs: st.mtimeMs, value: JSON.parse(fs.readFileSync(BRIEFING_CCCS_FILE, 'utf8')) };
        }
        return briefingCccsCache_.value;
    } catch (_) {
        return [];
    }
}

// Numbers come from the sync jobs' meta; an item whose numbers are unavailable is left out (never guessed).
function buildExecutiveBriefing_(meta) {
    const pendingMc = (meta && meta.pendingMc && meta.pendingMc.stats) || {};
    const loadExt = (meta && meta.loadExt && meta.loadExt.stats) || {};
    const discon = (meta && meta.discon && meta.discon.stats) || {};
    const defective = (meta && meta.defective && meta.defective.stats) || {};
    const nsc = (meta && meta.nsc && meta.nsc.stats) || {};

    const cleanPendingMcCccs = cleanDivisionCccs_(pendingMc.divisionCccs);
    const cleanLoadExtCccs = cleanDivisionCccs_(loadExt.divisionCccs);
    const cleanDisconCccs = cleanDivisionCccs_(discon.divisionCccs);
    const cleanDefectiveCccs = cleanDivisionCccs_(defective.divisionCccs);
    const cleanNscCccs = cleanDivisionCccs_(nsc.divisionCccs);

    const asOn = pendingMc.reportDate || pendingMc.asOnDate || loadExt.reportDate || discon.reportDate || 'Latest';

    const items = [];

    // 1. Pending MC Delayed > 90 Days (CRITICAL)
    const delayedMc = Number(pendingMc.delayed90 || 0);
    const totalMc = Number(pendingMc.totalPending || 0);
    const mcDivs = pendingMc.divisions || {};
    items.push({
        id: 'mc-delayed-90',
        priority: 'critical',
        priorityLabel: '🔴 CRITICAL',
        domain: 'Master Card',
        domainKey: 'pending_mc',
        title: 'Pending Master Card > 90 Days',
        headline: `${delayedMc.toLocaleString()} Master Cards delayed beyond 90 days (Total pending: ${totalMc.toLocaleString()})`,
        description: 'Critical delay in issuing master cards post-connection. Immediate field-level follow-up required in affected CCCs.',
        metric: `${delayedMc.toLocaleString()}`,
        hotspots: [
            { division: 'Raiganj', count: mcDivs.Raiganj || 0 },
            { division: 'Islampur', count: mcDivs.Islampur || 0 },
            { division: 'Malda', count: mcDivs.Malda || 0 },
            { division: 'Chanchal', count: mcDivs.Chanchal || 0 }
        ],
        divisions: mcDivs,
        divisionCccs: cleanPendingMcCccs,
        deepLink: 'pending_mc.html?kpiFilter=Delayed',
        pageTitle: 'Pending Master Card',
        datasetKey: 'CACHE_PENDING_MC'
    });

    // 2. Disconnection OSD No-Action (CRITICAL)
    const noActionCount = Number((discon.noAction && discon.noAction.count) || discon.noActionCount || 0);
    const noActionAmount = Number((discon.noAction && discon.noAction.amount) || 0);
    const disconDivs = discon.divisions || {};
    items.push({
        id: 'discon-no-action',
        priority: 'critical',
        priorityLabel: '🔴 CRITICAL',
        domain: 'Disconnection & OSD',
        domainKey: 'disconnection',
        title: 'OSD Defaulters Without Disconnection Action',
        headline: `${noActionCount.toLocaleString()} consumers with ₹${formatCr_(noActionAmount)} OSD pending without disconnection or legal action`,
        description: 'High revenue default cases remaining unaddressed. Prioritize enforcement drives and statutory disconnection notices.',
        metric: `₹${formatCr_(noActionAmount)}`,
        hotspots: [
            { division: 'Islampur', count: (disconDivs.Islampur && disconDivs.Islampur.noAction) || 0, amount: formatCr_((disconDivs.Islampur && disconDivs.Islampur.osd) || 0) },
            { division: 'Raiganj', count: (disconDivs.Raiganj && disconDivs.Raiganj.noAction) || 0, amount: formatCr_((disconDivs.Raiganj && disconDivs.Raiganj.osd) || 0) },
            { division: 'Malda', count: (disconDivs.Malda && disconDivs.Malda.noAction) || 0, amount: formatCr_((disconDivs.Malda && disconDivs.Malda.osd) || 0) },
            { division: 'Buniadpur', count: (disconDivs.Buniadpur && disconDivs.Buniadpur.noAction) || 0, amount: formatCr_((disconDivs.Buniadpur && disconDivs.Buniadpur.osd) || 0) }
        ],
        divisions: disconDivs,
        divisionCccs: cleanDisconCccs,
        deepLink: 'disconnection.html?status=noAction',
        pageTitle: 'Disconnection Tracker',
        datasetKey: 'CACHE_DISCONNECTION'
    });

    // 3. Defective Meters > 10 Months (CRITICAL)
    const defOver10 = Number(defective.over10 || 0);
    const defTotal = Number(defective.totalDefective || 0);
    const defDivs = defective.divisions || {};
    items.push({
        id: 'defective-over-10m',
        priority: 'critical',
        priorityLabel: '🔴 CRITICAL',
        domain: 'Defective Meter',
        domainKey: 'defective',
        title: 'Defective Meters Aging > 10 Months',
        headline: `${defOver10.toLocaleString()} meters defective for more than 10 months (Total defective: ${defTotal.toLocaleString()})`,
        description: 'Prolonged average billing leads to severe revenue leakages. Accelerate meter replacement drive in top divisions.',
        metric: `${defOver10.toLocaleString()}`,
        hotspots: [
            { division: 'Malda', count: (defDivs['MALDA DIVISION'] && defDivs['MALDA DIVISION'].over10) || 0 },
            { division: 'Chanchal', count: (defDivs['CHANCHAL DIVISION'] && defDivs['CHANCHAL DIVISION'].over10) || 0 },
            { division: 'Islampur', count: (defDivs['ISLAMPUR DIVISION'] && defDivs['ISLAMPUR DIVISION'].over10) || 0 },
            { division: 'Gazole', count: (defDivs['GAZOLE DIVISION'] && defDivs['GAZOLE DIVISION'].over10) || 0 }
        ],
        divisions: defDivs,
        divisionCccs: cleanDefectiveCccs,
        deepLink: 'consumer/defective_meter.html?kpi=over10',
        pageTitle: 'Defective Meter Dashboard',
        datasetKey: 'CACHE_DEFECTIVE'
    });

    // Pending NSC delayed > 30 days (CRITICAL) — needs delayed30, which scripts/tools/compute_briefing_cccs.js adds
    if (nsc.delayed30 != null) {
        const nscDelayed30 = Number(nsc.delayed30) || 0;
        const nscTotalPending = Number(nsc.totalPending) || 0;
        const nscDivs = nsc.divisions || {};
        items.push({
            id: 'nsc-delayed-30',
            priority: 'critical',
            priorityLabel: '🔴 CRITICAL',
            domain: 'Pending NSC',
            domainKey: 'nsc',
            title: 'Pending NSC Delayed > 30 Days',
            headline: `${nscDelayed30.toLocaleString()} New Service Connections delayed beyond 30 days (Total pending: ${nscTotalPending.toLocaleString()})`,
            description: 'New service connections exceeding statutory 30-day timeline. Field execution and contractor follow-up required.',
            metric: `${nscDelayed30.toLocaleString()}`,
            hotspots: ['Raiganj', 'Islampur', 'Gazole', 'Buniadpur'].map((d) => ({ division: d, count: nscDivs[d] || 0 })),
            divisions: nscDivs,
            divisionCccs: cleanNscCccs,
            deepLink: 'nsc.html',
            pageTitle: 'Pending NSC',
            datasetKey: 'CACHE_NSC_v5'
        });
    }

    // 4. Pending Load Extension > 1 Year (HIGH)
    const loadAgeing1y = Number(loadExt.ageing1y || 0);
    const loadTotal = Number(loadExt.totalPending || 0);
    const loadDivs = loadExt.divisions || {};
    items.push({
        id: 'load-ext-ageing-1y',
        priority: 'high',
        priorityLabel: '🟠 HIGH ALERT',
        domain: 'Load Extension',
        domainKey: 'load_ext',
        title: 'Pending Load Extensions Aging > 1 Year',
        headline: `${loadAgeing1y.toLocaleString()} load extension applications pending for over 1 year (Total pending: ${loadTotal.toLocaleString()})`,
        description: 'Quotation-paid or verified applications awaiting execution. Immediate clearance needed to unlock enhanced fixed charges.',
        metric: `${loadAgeing1y.toLocaleString()}`,
        hotspots: [
            { division: 'Raiganj', count: loadDivs.Raiganj || 0 },
            { division: 'Chanchal', count: loadDivs.Chanchal || 0 },
            { division: 'Malda', count: loadDivs.Malda || 0 },
            { division: 'Balurghat', count: loadDivs.Balurghat || 0 }
        ],
        divisions: loadDivs,
        divisionCccs: cleanLoadExtCccs,
        deepLink: 'pending_load_extension.html?kpi=kpiAgeing1y',
        pageTitle: 'Pending Load Extension',
        datasetKey: 'CACHE_LOAD_EXT'
    });

    // 5. Industrial Master Cards Pending (HIGH)
    const indMc = Number(pendingMc.industrial || 0);
    items.push({
        id: 'mc-industrial-pending',
        priority: 'high',
        priorityLabel: '🟠 HIGH ALERT',
        domain: 'Master Card',
        domainKey: 'pending_mc',
        title: 'Industrial Master Cards Pending',
        headline: `${indMc} industrial connection master cards awaiting issuance`,
        description: 'Industrial meters installed but master cards pending, delaying regular billing cycle and commercial revenue realization.',
        metric: `${indMc}`,
        hotspots: [],
        divisions: mcDivs,
        divisionCccs: cleanPendingMcCccs,
        deepLink: 'pending_mc.html?kpiFilter=Industrial',
        pageTitle: 'Pending Master Card',
        datasetKey: 'CACHE_PENDING_MC'
    });

    // 6. 3-Phase & Industrial Defective Meters (HIGH)
    const ph3Def = Number(defective.ph3 || 0);
    const indDef = Number(defective.industrial || 0);
    items.push({
        id: 'defective-3phase-ind',
        priority: 'high',
        priorityLabel: '🟠 HIGH ALERT',
        domain: 'Defective Meter',
        domainKey: 'defective',
        title: 'Defective 3-Phase & Industrial Meters',
        headline: `${ph3Def.toLocaleString()} three-phase and ${indDef} industrial meters defective`,
        description: 'High-value consumer meters requiring immediate replacement to prevent unmetered energy loss and dispute risks.',
        metric: `${ph3Def.toLocaleString()}`,
        hotspots: [
            { division: 'Raiganj', count: (defDivs['RAIGANJ DIVISION'] && defDivs['RAIGANJ DIVISION'].ph3) || 0 },
            { division: 'Chanchal', count: (defDivs['CHANCHAL DIVISION'] && defDivs['CHANCHAL DIVISION'].ph3) || 0 },
            { division: 'Gazole', count: (defDivs['GAZOLE DIVISION'] && defDivs['GAZOLE DIVISION'].ph3) || 0 }
        ],
        divisions: defDivs,
        divisionCccs: cleanDefectiveCccs,
        deepLink: 'consumer/defective_meter.html?kpi=ph3',
        pageTitle: 'Defective Meter Dashboard',
        datasetKey: 'CACHE_DEFECTIVE'
    });

    // Withheld NSC applications (WATCH) — counts from the last NSC upload
    const withheldRows = Number(nsc.withheldRows || (nsc.statusCounts && nsc.statusCounts.Witheld) || 0);
    if (withheldRows) {
        // The upload counts regions as written in the sheet; spellings of one region (old names
        // included) are summed under its canonical name.
        const regions = {};
        for (const [name, n] of Object.entries(nsc.regionCounts || {})) {
            const r = OFFICES.canonRegion(name) || name;
            regions[r] = (regions[r] || 0) + (Number(n) || 0);
        }
        items.push({
            id: 'nsc-withheld',
            priority: 'watch',
            priorityLabel: '🟡 WATCH',
            domain: 'Withheld NSC',
            domainKey: 'withheld',
            title: 'Withheld NSC Applications',
            headline: `${withheldRows.toLocaleString()} new service connection applications in withheld status`,
            description: 'Applications held due to wayleave, ROW, or documentation issues. Expedite field verification and resolution.',
            metric: `${withheldRows.toLocaleString()}`,
            hotspots: [
                { division: 'Malda Region', count: regions.Malda || 0 },
                { division: 'Uttar Dinajpur', count: regions['Uttar Dinajpur'] || 0 },
                { division: 'Dakshin Dinajpur', count: regions['Dakshin Dinajpur'] || 0 }
            ],
            deepLink: 'withheld.html',
            pageTitle: 'Withheld NSC',
            datasetKey: 'CACHE_WITHHELD_v4'
        });
    }

    // 8. Partial Disconnection Recovery Follow-up (WATCH)
    const partCount = Number((discon.partiallyPaid && discon.partiallyPaid.count) || 0);
    const partAmount = Number((discon.partiallyPaid && discon.partiallyPaid.amount) || 0);
    items.push({
        id: 'discon-partially-paid',
        priority: 'watch',
        priorityLabel: '🟡 WATCH',
        domain: 'Disconnection & OSD',
        domainKey: 'disconnection',
        title: 'Partially Paid Defaulter Follow-up',
        headline: `${partCount.toLocaleString()} consumers paid ₹${formatLakh_(partAmount)} partially; balance recovery pending`,
        description: 'Consumers paid initial installments. Active monitoring required to ensure full balance realization on schedule.',
        metric: `₹${formatLakh_(partAmount)}`,
        hotspots: [],
        divisions: disconDivs,
        divisionCccs: cleanDisconCccs,
        deepLink: 'disconnection.html?status=partiallyPaid',
        pageTitle: 'Disconnection Tracker',
        datasetKey: 'CACHE_DISCONNECTION'
    });

    const summaryCounts = {
        critical: items.filter(i => i.priority === 'critical').length,
        high: items.filter(i => i.priority === 'high').length,
        watch: items.filter(i => i.priority === 'watch').length,
        total: items.length
    };

    const cccs = briefingCccs_();

    return {
        asOn,
        generatedAt: new Date().toISOString(),
        summaryCounts,
        items,
        cccs,
        metaStats: {
            pendingMc,
            loadExt,
            discon,
            defective,
            nsc
        }
    };
}

/** The Briefing from its live inputs (the report meta.json files and the NSC upload meta). */
async function computeExecutiveBriefing_() {
    const [pendingMcMeta, loadExtMeta, disconMeta, defectiveMeta, nscMeta] = await Promise.all([
        PENDING_MC_META.read().catch(() => null),
        LOAD_EXT_META.read().catch(() => null),
        DISCONNECTION_META.read().catch(() => null),
        DEFECTIVE_META.read().catch(() => null),
        // data/nsc_meta.json (with delayed30) when the briefing tool ran locally; else the Sheet's upload meta
        Promise.resolve(readLocalNscMeta_() || fetchNscSheetMeta_()).catch(() => null)
    ]);
    return buildExecutiveBriefing_({
        pendingMc: pendingMcMeta,
        loadExt: loadExtMeta,
        discon: disconMeta,
        defective: defectiveMeta,
        nsc: nscMeta
    });
}

// Mirror mode (the VM): the Briefing is the home page and its inputs take 1-2 s to read live, so the last
// one is kept and answered at once while under 10 min old, refreshed in the background once over 2 min
// (one refresh at a time), and right after a write that changes its inputs.
const BRIEFING_STALE_MS = 2 * 60 * 1000;
const BRIEFING_MAX_AGE_MS = 10 * 60 * 1000;
const briefingCache_ = { value: null, at: 0, pending: null, again: false };

/** Start (or join) a refresh; `changed`: inputs changed during a running one, so run once more after it. */
function refreshBriefing_({ changed = false } = {}) {
    const c = briefingCache_;
    if (c.pending) {
        if (changed) c.again = true;
        return c.pending;
    }
    c.pending = computeExecutiveBriefing_()
        .then((briefing) => {
            c.value = briefing;
            c.at = Date.now();
            return briefing;
        })
        .finally(() => {
            c.pending = null;
            if (c.again) {
                c.again = false;
                refreshBriefing_().catch((e) => console.warn('[Briefing] refresh failed:', e.message));
            }
        });
    if (changed) c.pending.catch((e) => console.warn('[Briefing] refresh failed:', e.message));
    return c.pending;
}

async function cachedExecutiveBriefing_() {
    const c = briefingCache_;
    const age = Date.now() - c.at;
    if (c.value && age < BRIEFING_MAX_AGE_MS) {
        if (age >= BRIEFING_STALE_MS) refreshBriefing_().catch((e) => console.warn('[Briefing] background refresh failed:', e.message));
        return c.value;
    }
    try {
        return await refreshBriefing_();
    } catch (err) {
        if (c.value) return c.value; // older than 10 min, but better than an error
        throw err;
    }
}

app.get('/api/executive/briefing', async (req, res) => {
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    try {
        const briefing = mirror.on() ? await cachedExecutiveBriefing_() : await computeExecutiveBriefing_();

        res.setHeader('Cache-Control', 'private, max-age=30, must-revalidate');
        return res.json({ status: 'success', briefing });
    } catch (err) {
        console.error('[Executive Briefing Error]:', err);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

// --- Assistant (Ask) --------------------------------------------------------
// The browser runs the tools against its own (already office-scoped) data and
// posts tool results back; this route only holds the API key and calls the model.
// Only the conversation comes from the client — model, system prompt and tools
// are fixed on the server. Provider, model and keys come from env settings
// (GOEDEL_API_KEY / ANTHROPIC_API_KEY, ASSISTANT_PROVIDER, ...): see lib/assistant/index.js.
const ASSISTANT_CATALOG = require('./lib/assistant_catalog.js');
const assistantLib = require('./lib/assistant/index.js');
// Ask usage (Admin -> Ask usage): one row per model call in PocketBase app_assistant_usage on the VM, an
// in-memory ring buffer elsewhere; metadata only (lib/assistant/usage.js, docs/assistant.md).
const assistantUsage = require('./lib/assistant/usage.js').create({ env: process.env });
const assistant = assistantLib.createAssistant({ env: process.env, fileConfig, catalog: ASSISTANT_CATALOG, fetch, onUsage: assistantUsage.record });
const assistantHits = new Map(); // username -> [timestamps] (best effort per instance)
app.get('/api/admin/assistant-usage', assistantUsage.handler(() => ({
    configured: assistant.configured, provider: assistant.provider, model: assistant.model, modelName: assistant.modelName, limits: assistant.limits
})));

app.post('/api/assistant', async (req, res) => {
    const user = req.user || {};
    if (!assistant.configured) {
        return res.status(503).json({ status: 'error', code: 'not_configured', message: 'The assistant is not set up yet. Ask the administrator to add the assistant API key.' });
    }
    const who = String(user.Username || 'anon').toLowerCase();
    const now = Date.now();
    const recent = (assistantHits.get(who) || []).filter((t) => now - t < 10 * 60 * 1000);
    if (recent.length >= 60) {
        return res.status(429).json({ status: 'error', code: 'rate_limited', message: 'Too many questions in a short time. Try again in a few minutes.' });
    }
    recent.push(now);
    assistantHits.set(who, recent);

    const { messages, context } = req.body || {};
    if (!assistantLib.messagesValid(messages)) {
        return res.status(400).json({ status: 'error', code: 'bad_request', message: 'That conversation could not be sent.' });
    }
    // Volatile, per-user details go after the shared (cached) prompt.
    const scope = String((context && context.scope) || '').slice(0, 160);
    const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
    const userNote = `Today is ${today}. The signed-in user is ${String(user.Name || user.Username || 'an officer').slice(0, 80)} (${user.role === 'admin' ? 'administrator' : 'officer'}). Office scope: ${scope || 'whole zone'}.`;

    // Stop waiting (queue or upstream) when the browser goes away.
    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
    try {
        const meta = { user_email: user.email || '', user_name: user.Name || user.Username || '', turn: assistantUsage.turnOf(messages) };
        const response = await assistant.complete({ userNote, messages, signal: ctrl.signal, meta });
        return res.json({
            status: 'success',
            stop_reason: response.stop_reason,
            content: response.content,
            usage: {
                input: response.usage && response.usage.input,
                output: response.usage && response.usage.output,
                cache_read: response.usage && response.usage.cache_read
            }
        });
    } catch (err) {
        if (res.headersSent || ctrl.signal.aborted) return undefined;
        const r = assistantLib.replyFor(err);
        return res.status(r.status).json({ status: 'error', code: r.code, message: r.message });
    }
});

// Last: errors passed to next() (body parser, multer, rejected async handlers) get a JSON answer, never
// Express's HTML page (which shows a stack trace outside production).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const status = err && Number.isInteger(err.status || err.statusCode) && (err.status || err.statusCode) >= 400 && (err.status || err.statusCode) < 600
        ? (err.status || err.statusCode) : 500;
    if (status >= 500) console.error(`[Server] ${req.method} ${req.path}:`, err && err.stack ? err.stack : err);
    if (res.headersSent) { try { res.end(); } catch (_) { /* closed */ } return; }
    const message = status === 413 ? 'The request is too large.'
        : status === 400 ? 'The request could not be read.'
            : status < 500 && err && err.expose && err.message ? err.message : 'Something went wrong on the server.';
    return res.status(status).json({ status: 'error', message });
});

if ((process.env.NODE_ENV !== 'production' || !process.env.VERCEL) && require.main === module) {
    // A stray rejection is logged, never fatal: one bad request must not take the app down for everyone.
    process.on('unhandledRejection', (reason) => {
        console.error('[Server] unhandled rejection:', reason && reason.stack ? reason.stack : reason);
    });
    const server = app.listen(PORT, () => {
        console.log(`MZO Reports on http://localhost:${PORT} (workstation: /app.html)`);
    });
    server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is already in use. The app is likely already running at http://localhost:${PORT}`);
            console.error('Stop the other Node process, or just open that URL — do not start a second npm run dev.');
            process.exit(1);
        }
        throw err;
    });
    // systemd stops the app with SIGTERM on every deploy: write the queued activity and Ask usage rows
    // first (at most 3 s), then exit as before.
    const stop = (signal) => {
        console.log(`[Server] ${signal}: finishing queued writes`);
        server.close();
        const flushes = [userStore.on && userStore.flush, assistantUsage.flush]
            .filter((f) => typeof f === 'function')
            .map((f) => Promise.resolve().then(f).catch(() => {}));
        const limit = new Promise((resolve) => setTimeout(resolve, 3000).unref());
        Promise.race([Promise.all(flushes), limit]).then(() => process.exit(0));
    };
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGINT', () => stop('SIGINT'));
}

module.exports = app;
