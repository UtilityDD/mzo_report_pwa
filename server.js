const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

// Body parsers (limits raised for NSC/stock publish payloads)
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Server-side files are never served, locally or from the Vercel function.
const PRIVATE_PATH = /^\/(server\.js|package(-lock)?\.json|vercel\.json|node_modules\/|scripts\/|apps-script\/|lib\/stock_(pipeline|material_category)\.js|data\/(?!costcenter\.json$))|\.(md|mdc|gs|sql|py)$|\/\./i;
app.use((req, res, next) => (PRIVATE_PATH.test(req.path) ? res.status(404).end() : next()));
// Old URLs (vercel.json has the same redirects): the retired phone home page and an extension-less report.
app.get(['/', '/index.html'], (req, res) => res.redirect(302, '/app.html'));
app.get('/performance_index', (req, res) => res.redirect(308, '/performance_index.html'));
// Static files are public, as on Vercel where the CDN serves them before this app; pages gate themselves with auth.js.
app.use(express.static(__dirname));

// Session cookies are signed with JWT_SECRET; the fallback is for local development only.
const JWT_SECRET = process.env.JWT_SECRET || 'mzo-portal-super-secret-key-123456';
if (!process.env.JWT_SECRET && process.env.VERCEL) {
    console.warn('[Auth] JWT_SECRET is not set: sessions are signed with the development fallback. Set JWT_SECRET in the Vercel project.');
}
const POWER_MAP_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vT8hYE6YBbfVQDJhgB3cIWqrrGrjMQAQ22mcmCJTOa995gCH-xBAfsAPpBvNYS1KlYIFMRHM59iGB7K/pub?output=csv';
// Distinct table names (do not use generic "substations" — may clash with other projects/tables)
const POWER_MAP_TABLE = 'mzo_power_substations';
const POWER_MAP_CORRECTIONS_TABLE = 'mzo_power_corrections';
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
        body
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

function verifyPin(pin, stored) {
    const plain = String(pin || '').trim();
    const saved = String(stored || '').trim();
    if (!plain || !saved) return false;
    if (!isPinHash(saved)) return saved === plain;
    const parts = saved.split('$');
    let saltB64 = '';
    let hashB64 = '';
    if (parts.length === 3) {
        saltB64 = parts[1];
        hashB64 = parts[2];
    } else if (parts.length === 4) {
        saltB64 = parts[2];
        hashB64 = parts[3];
    } else {
        return false;
    }
    try {
        const salt = Buffer.from(saltB64, 'base64');
        const expected = Buffer.from(hashB64, 'base64');
        if (!salt.length || !expected.length) return false;
        const actual = crypto.scryptSync(plain, salt, expected.length, { N: 16384, r: 8, p: 1 });
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch (err) {
        return false;
    }
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

        // Source of truth: Supabase mzo_insight.activity_logs
        try {
            await insertActivityLogToSupabase(entry);
        } catch (sbErr) {
            console.error('[Activity Log] Supabase write failed:', sbErr.message);
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
            fs.writeFileSync(LOGS_FILE, JSON.stringify(globalCachedLogs, null, 2), 'utf-8');
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
 * forceRefresh=true (used by /api/login) always re-queries so PIN changes apply immediately.
 */
async function getLoginCredentials(options = {}) {
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

function matchLoginUser(users, username, pin) {
    const userKey = String(username || '').trim().toLowerCase();
    const pinKey = String(pin || '').trim();
    if (!userKey || !pinKey) return null;

    return (users || []).find(u => {
        if (!u || !u.Username) return false;
        const storedPin = String(u.PIN || '').trim();
        if (!storedPin) return false; // users with blank PIN cannot log in
        return String(u.Username).trim().toLowerCase() === userKey && verifyPin(pinKey, storedPin);
    }) || null;
}

/** Profile from a valid, unexpired mzo_session cookie, else null. */
function readSession_(req) {
    const token = parseCookies(req.headers.cookie).mzo_session;
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const expected = Buffer.from(crypto.createHmac('sha256', JWT_SECRET).update(parts[0]).digest('base64'));
    const given = Buffer.from(parts[1]);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    try {
        const session = JSON.parse(Buffer.from(parts[0], 'base64').toString('utf-8'));
        return session && Date.now() < session.expiry ? session.profile : null;
    } catch (_) {
        return null;
    }
}

// Reachable without a session (static files are already served above).
const PUBLIC_PATHS = new Set([
    '/login.html', '/offline.html', '/sw.js', '/manifest.json',
    '/api/login', '/api/auth/google', '/api/auth/pending-status', '/api/auth/config', '/api/news'
]);
const PUBLIC_ASSET = /^\/(icons|assets)\/|\.(css|js|png|json|ico)$/i;

async function requireAuth(req, res, next) {
    const pathName = req.path;
    const profile = readSession_(req);
    if (profile) {
        req.user = profile;
        // Page visits feed Admin → Visitors.
        const isHtml = path.extname(pathName).toLowerCase() === '.html';
        if (isHtml && pathName !== '/login.html' && pathName !== '/admin_users.html') {
            await logActivity({
                username: req.user.Username,
                name: req.user.Name || 'No Name',
                type: 'page_visit',
                details: `Visited page: ${pathName}`
            });
        }
        return next();
    }
    if (PUBLIC_PATHS.has(pathName) || PUBLIC_ASSET.test(pathName)) return next();
    // API callers (CSV/JSON clients like Power Map) get 401, never an HTML redirect.
    if (pathName.startsWith('/api/') || req.xhr || String(req.headers.accept || '').includes('application/json')) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }
    return res.redirect('/login.html');
}

app.use(requireAuth);

// --- Estimate structures (admin.html) ---
const STRUCTURE_FILE = path.join(__dirname, 'data', 'structure.csv'); // literal path: Vercel bundles it with the function
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
        res.json(parseStructuresCsv_(fs.readFileSync(STRUCTURE_FILE, 'utf-8')));
    } catch (error) {
        console.error('Error reading structure file:', error.message);
        res.status(500).json({ message: 'Error reading structure data.', details: error.message });
    }
});

// Writes data/structure.csv (works locally; the Vercel filesystem is read-only).
app.post('/api/structures/update', requireAdmin, (req, res) => {
    const structures = req.body;
    if (!Array.isArray(structures)) {
        return res.status(400).send('Invalid data format. Expected an array of structures.');
    }
    try {
        const csv = [STRUCTURE_COLUMNS.join(',')]
            .concat(structures.map((s) => STRUCTURE_COLUMNS.map((k) => (k === 'id' ? s.id : `"${String(s[k] == null ? '' : s[k]).replace(/"/g, '""')}"`)).join(',')))
            .join('\n');
        fs.writeFileSync(STRUCTURE_FILE, csv, 'utf-8');
        res.status(200).json({ message: 'Structures updated successfully!' });
    } catch (error) {
        console.error('Error writing structure file:', error.message);
        res.status(500).json({ message: 'An error occurred while saving data.', details: error.message });
    }
});

// Helper to issue signed stateless session cookie
function issueSessionCookie(res, clientProfile) {
    const payload = {
        profile: clientProfile,
        expiry: Date.now() + 24 * 60 * 60 * 1000
    };
    const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64');
    const signature = crypto.createHmac('sha256', JWT_SECRET).update(payloadStr).digest('base64');
    const token = `${payloadStr}.${signature}`;
    res.setHeader('Set-Cookie', `mzo_session=${token}; Path=/; HttpOnly; Max-Age=${24 * 60 * 60}; SameSite=Lax`);
    return token;
}

const ROOT_ADMIN_EMAILS = ['smartlinemanapp@gmail.com'];
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

function googleClientId_() {
    return String(process.env.GOOGLE_CLIENT_ID || fileConfig.googleClientId || '').trim();
}

/** Local test sign-in (email only) is for a developer machine, never a deployment. */
function isLocalRequest_(req) {
    return !process.env.VERCEL && (req.hostname === 'localhost' || req.hostname === '127.0.0.1');
}

/**
 * Google checks the token's signature and expiry; we check it was issued to this app's
 * client ID for a verified email. kind: 'id_token' (Sign-In button) or 'access_token' (popup).
 * Returns the claims, or null when the token does not qualify. Throws if Google is unreachable.
 */
async function googleTokenInfo_(kind, token) {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?${kind}=${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const info = await res.json().catch(() => null);
    if (!info || !info.email) return null;
    const audience = kind === 'id_token' ? info.aud : (info.aud || info.azp);
    if (audience !== googleClientId_()) return null;
    if (kind === 'id_token' && !GOOGLE_ISSUERS.has(info.iss)) return null;
    if (!(Number(info.exp) * 1000 > Date.now())) return null;
    if (String(info.email_verified) !== 'true') return null;
    return info;
}

// API endpoint for User Login (Username + PIN)
app.post('/api/login', async (req, res) => {
    const { username, pin } = req.body;

    if (!username || !pin || !String(pin).trim()) {
        return res.status(400).json({ status: 'error', message: 'Username and PIN are required.' });
    }

    try {
        const users = await getLoginCredentials({ forceRefresh: true });
        const matchedUser = matchLoginUser(users, username, pin);

        if (matchedUser) {
            const status = String(matchedUser.user_status || 'active').toLowerCase();
            if (status === 'pending') {
                return res.status(403).json({
                    status: 'pending',
                    message: 'Your account is pending administrator approval. Please check back later.'
                });
            }
            if (status === 'rejected') {
                return res.status(403).json({
                    status: 'rejected',
                    message: 'Your account access request has been declined by an administrator.'
                });
            }
            if (status === 'suspended') {
                return res.status(403).json({
                    status: 'suspended',
                    message: 'Your account has been deactivated. Contact an administrator.'
                });
            }

            if (!isPinHash(matchedUser.PIN)) {
                try {
                    const hashed = hashPin(pin);
                    await querySupabase(
                        `${PORTAL_USERS_TABLE}?username=eq.${encodeURIComponent(matchedUser.Username)}`,
                        {
                            schema: PORTAL_USERS_SCHEMA,
                            method: 'PATCH',
                            body: { pin: hashed, updated_at: new Date().toISOString() },
                            prefer: 'return=minimal'
                        }
                    );
                    matchedUser.PIN = hashed;
                } catch (hashErr) {
                    console.warn('[Auth] PIN hash upgrade failed:', hashErr.message);
                }
            }
            const clientProfile = portalUserForClient(matchedUser);
            issueSessionCookie(res, clientProfile);
            
            console.log(`[Auth] User logged in: ${matchedUser.Username} (${matchedUser.Name || 'No Name'})`);
            
            await logActivity({
                username: matchedUser.Username,
                name: matchedUser.Name || 'No Name',
                type: 'login',
                details: `Logged in with PIN from IP: ${req.ip || req.headers['x-forwarded-for'] || 'unknown'}`
            });
            
            return res.status(200).json({
                status: 'success',
                profile: clientProfile
            });
        } else {
            return res.status(401).json({ status: 'error', message: 'Invalid Username or PIN.' });
        }
    } catch (err) {
        console.error("[Auth] Login error:", err.message);
        return res.status(500).json({ status: 'error', message: 'Internal Server Error during validation.' });
    }
});

// Public auth configuration (Google Client ID & test capabilities)
app.get('/api/auth/config', (req, res) => {
    res.json({
        googleClientId: googleClientId_(),
        allowLocalTest: isLocalRequest_(req)
    });
});

// API endpoint for Google Sign-In & Registration
app.post('/api/auth/google', async (req, res) => {
    try {
        const { credential, accessToken, email: testEmail, name: testName, picture: testPicture } = req.body || {};
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
        } else if (testEmail && isLocalRequest_(req)) {
            email = String(testEmail).trim().toLowerCase();
            name = String(testName || email.split('@')[0]).trim();
            picture = testPicture || '';
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
        while (users.some(u => String(u.Username).toLowerCase() === candidateUsername.toLowerCase())) {
            candidateUsername = `${baseUsername}${counter++}`;
        }

        if (isRootAdmin) {
            const rootAdminUser = {
                Username: candidateUsername,
                Name: name || 'Admin',
                email: email,
                auth_provider: 'google',
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
                approved_by: 'system_root'
            };

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
        const users = await getLoginCredentials({ forceRefresh: true });
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
    try {
        const users = await getLoginCredentials({ forceRefresh: true });
        const key = String(req.user.Username).trim().toLowerCase();
        const fresh = users.find((u) => u.Username && String(u.Username).trim().toLowerCase() === key);
        if (fresh) {
            return res.status(200).json({ status: 'success', profile: portalUserForClient(fresh) });
        }
    } catch (err) {
        console.warn('[Auth] session-check profile refresh failed:', err.message);
    }
    return res.status(200).json({ status: 'success', profile: req.user });
});

// API endpoint for User Logout
app.post('/api/logout', (req, res) => {
    // Invalidate session cookie
    res.setHeader('Set-Cookie', 'mzo_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
    return res.status(200).json({ status: 'success', message: 'Logged out successfully.' });
});

// --- Admin User Management & Logging Endpoints ---

function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
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
        let path = `${UNBILLED_MONTHS_TABLE}?select=*&order=sort_order.asc,id.asc`;
        if (!includeAll) path += '&active=eq.true';
        const rows = await querySupabase(path, { schema: PORTAL_USERS_SCHEMA });
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
        
        if (!Username || !PIN) {
            return res.status(400).json({ status: 'error', message: 'Username and PIN are required.' });
        }
        
        const users = await getLoginCredentials({ forceRefresh: true });
        const exists = users.some(u => u.Username && u.Username.toLowerCase() === Username.trim().toLowerCase());
        if (exists) {
            return res.status(400).json({ status: 'error', message: 'Username already exists.' });
        }
        
        const newUser = {
            Username: Username.trim(),
            PIN: PIN.trim(),
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
        // Prefer Supabase when the table exists and has rows
        let substations = null;
        let supabaseError = null;
        try {
            substations = await querySupabase(POWER_MAP_TABLE + '?select=*&limit=5000');
        } catch (sbErr) {
            supabaseError = sbErr;
            console.warn('[Power Map Data] Supabase unavailable:', sbErr.message);
        }

        if (Array.isArray(substations) && substations.length > 0) {
            const columns = [
                "Region", "Division", "Substation", "MVA", "LATITUDE", "LONGITUDE",
                "Connected to", "Colour", "RL", "LineStyle", "Para-1", "Para-2", "Para-3",
                "Comment", "Symbol", "SymbolSize", "LegendText", "LegendSymbol",
                "LegendColour", "Remarks", "ConductorSize", "PeakLoad"
            ];

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
    return (userDiv && String(division || '').trim().toLowerCase() === userDiv) ||
        (userReg && String(region || '').trim().toLowerCase() === userReg);
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
                proposed_value: JSON.stringify(rowData)
            });
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
            return res.json({ status: 'success', isSuggestion: true, message: 'Feeder connection submitted for Admin approval.' });
        }

        if (!record) return res.status(404).json({ status: 'error', message: `Source Substation '${sourceSubstation}' not found.` });
        await patchSubstation_(sourceSubstation, appendConnection_(record, targetSubstation, { rl, conductorSize, peakLoad }));
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
        const { id } = req.body;
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
            let finalValue = proposal.proposed_value;
            if (proposal.connection_target) {
                const record = await fetchSubstation_(proposal.substation);
                if (!record) throw new Error(`Target Substation '${proposal.substation}' not found.`);
                finalValue = setConnectionValue_(record, proposal.column_name, proposal.connection_target, proposal.proposed_value);
                if (finalValue === null) throw new Error(`Connection target '${proposal.connection_target}' not found.`);
            }
            await patchSubstation_(proposal.substation, { [proposal.column_name]: finalValue });
        } else if (proposal.type === 'add_substation') {
            await querySupabase(POWER_MAP_TABLE, { method: 'POST', body: JSON.parse(proposal.proposed_value) });
        } else if (proposal.type === 'add_connection') {
            const record = await fetchSubstation_(proposal.substation);
            if (!record) throw new Error(`Source Substation '${proposal.substation}' not found.`);
            await patchSubstation_(proposal.substation, appendConnection_(record, proposal.connection_target, JSON.parse(proposal.proposed_value)));
        }

        // The suggestion is done
        await querySupabase(`${POWER_MAP_CORRECTIONS_TABLE}?id=eq.${id}`, {
            method: 'DELETE'
        });
        
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
        const { id } = req.body;
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

// DTR load page: check a PIN against users with DTR rights on the server (PINs never leave it).
const dtrPinAttempts = new Map(); // username -> [timestamps] (best effort per instance)
app.post('/api/dtr/verify-pin', async (req, res) => {
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    const who = String(req.user.Username || '').toLowerCase();
    const now = Date.now();
    const recent = (dtrPinAttempts.get(who) || []).filter((t) => now - t < 10 * 60 * 1000);
    if (recent.length >= 20) {
        return res.status(429).json({ status: 'error', message: 'Too many attempts. Try again in a few minutes.' });
    }
    recent.push(now);
    dtrPinAttempts.set(who, recent);
    const pin = String((req.body && req.body.pin) || '').trim();
    if (!pin) return res.status(400).json({ status: 'error', message: 'Please enter a PIN.' });
    try {
        const users = await getLoginCredentials();
        const match = users.find((u) => String(u['dtr-autho'] || '').trim() && verifyPin(pin, u.PIN));
        if (!match) {
            return res.status(401).json({ status: 'error', message: 'Invalid PIN or missing DTR authorization.' });
        }
        return res.json({ status: 'success', dtrAutho: String(match['dtr-autho']).trim(), name: match.Name || match.Username });
    } catch (err) {
        console.error('[DTR PIN] Error:', err.message);
        return res.status(500).json({ status: 'error', message: 'Could not validate PIN.' });
    }
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
    const name = String((user.Name || user.name) || '')
        .trim()
        .toLowerCase();
    if (allowed.includes(username)) return true;
    return allowed.some((u) => name === u || name.startsWith(u + ' ') || name.includes(' ' + u + ' '));
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

function parseAllotmentSeqFromNo_(allotmentNo) {
    const m = String(allotmentNo || '').match(/MZO\/ALT\/(\d{4})\/(\d+)/i);
    if (!m) return null;
    return { year: parseInt(m[1], 10), seq: parseInt(m[2], 10) };
}

async function syncAllotmentSeqFromRows_(rows) {
    const maxByYear = {};
    (rows || []).forEach((r) => {
        const parsed = parseAllotmentSeqFromNo_(r.allotment_no || r.AllotmentNo);
        if (!parsed) return;
        maxByYear[parsed.year] = Math.max(maxByYear[parsed.year] || 0, parsed.seq);
    });
    for (const [yearStr, maxSeq] of Object.entries(maxByYear)) {
        const year = Number(yearStr);
        const next = maxSeq + 1;
        const existing = await querySupabase(`stock_allot_seq?year=eq.${year}&select=*`, {
            schema: PORTAL_USERS_SCHEMA
        });
        if (Array.isArray(existing) && existing[0]) {
            const cur = Number(existing[0].next_seq) || 1;
            if (next > cur) {
                await querySupabase(`stock_allot_seq?year=eq.${year}`, {
                    schema: PORTAL_USERS_SCHEMA,
                    method: 'PATCH',
                    body: { next_seq: next },
                    prefer: 'return=minimal'
                });
            }
        } else {
            await querySupabase('stock_allot_seq', {
                schema: PORTAL_USERS_SCHEMA,
                method: 'POST',
                body: { year, next_seq: next },
                prefer: 'return=minimal'
            });
        }
    }
    return maxByYear;
}

/**
 * One-time / idempotent import of Sheet/Apps Script allotments into Supabase.
 * Skips allotment numbers that already exist in stock_allotments.
 */
async function migrateAllotmentsFromLegacy_() {
    const legacy = await fetchLegacyAllotments_();
    const legacyRows = legacy.rows || [];
    if (!legacyRows.length) {
        return {
            status: 'success',
            imported: 0,
            skippedExisting: 0,
            legacyTotal: 0,
            legacySource: legacy.source,
            message: 'No legacy allotment rows found to migrate.'
        };
    }

    const existing = await fetchAllotmentsFromSupabase_();
    const existingNos = new Set(
        (existing || []).map((r) => String(r.AllotmentNo || '').trim()).filter(Boolean)
    );

    const toInsert = [];
    let skippedExisting = 0;
    for (const r of legacyRows) {
        const no = String(r.AllotmentNo || '').trim();
        if (!no) continue;
        if (existingNos.has(no)) {
            skippedExisting += 1;
            continue;
        }
        const createdBy = String(r.CreatedBy || 'sheet-migration').trim() || 'sheet-migration';
        let createdAt = String(r.CreatedAt || '').trim();
        if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
            createdAt = new Date().toISOString();
        } else {
            createdAt = new Date(createdAt).toISOString();
        }
        toInsert.push(allotClientToDb_(r, no, createdBy, createdAt));
    }

    const BATCH = 200;
    for (let i = 0; i < toInsert.length; i += BATCH) {
        await querySupabase('stock_allotments', {
            schema: PORTAL_USERS_SCHEMA,
            method: 'POST',
            body: toInsert.slice(i, i + BATCH),
            prefer: 'return=minimal'
        });
    }

    // Keep sequence ahead of both existing + newly imported numbers
    const seqMap = await syncAllotmentSeqFromRows_([...(existing || []), ...toInsert]);
    invalidateAllotListCache_();

    return {
        status: 'success',
        imported: toInsert.length,
        skippedExisting,
        legacyTotal: legacyRows.length,
        legacySource: legacy.source,
        seqByYear: seqMap,
        message:
            toInsert.length > 0
                ? `Imported ${toInsert.length} line(s) from ${legacy.source}. Skipped ${skippedExisting} already in Supabase.`
                : `Nothing new to import. ${skippedExisting} legacy line(s) already exist in Supabase.`
    };
}

async function loadAllotmentRowsCached_(force = false) {
    const now = Date.now();
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

// Reads only; create / cancel / migrate go through POST with their own permission checks.
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

        if (action === 'migrateFromSheet') {
            if (!(await requireStockAllotmentAccess_(req, res))) return;
            try {
                const result = await migrateAllotmentsFromLegacy_();
                return res.json(result);
            } catch (e) {
                console.error('[stock/allotment] migrate failed:', e.message);
                return res.status(500).json({
                    status: 'error',
                    error: e.message || 'Migration failed'
                });
            }
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
        fs.writeFileSync(NSC_META_FILE, JSON.stringify(meta, null, 2), 'utf8');
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

function overlayLiveNscToday_(meta, liveToday) {
    const today = String(liveToday || '').trim();
    if (!today) return meta;
    const next = Object.assign({}, meta || {});
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
    // Both helpers swallow their own errors.
    const [sheetMeta, liveToday] = await Promise.all([fetchNscSheetMeta_(), peekNscTodayFromSheet_()]);
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
        version: snapshotVersion_(meta) || null,
        withheldVersion: snapshotWithheldVersion_(meta) || null,
        sheetScriptUrl: canUpload ? NSC_SHEET_SCRIPT_URL : '',
        withheldSheetScriptUrl: canUpload ? NSC_WITHHELD_SHEET_SCRIPT_URL : '',
        csvUrl: NSC_SHEET_FALLBACK_URL,
        withheldCsvUrl: NSC_WITHHELD_SHEET_FALLBACK_URL,
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
            message: `Published ${baseMeta.publishedRows || 0} Working/Accepted and ${
                baseMeta.withheldRows || 0
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
        fs.writeFileSync(STOCK_CSV_FILE, csv, 'utf8');
        fs.writeFileSync(STOCK_META_FILE, JSON.stringify(meta, null, 2), 'utf8');
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

async function fetchActiveStockMeta_() {
    const rows = await querySupabase(
        `stock_upload_meta?is_active=eq.true&select=*&order=id.desc&limit=1`,
        { schema: PORTAL_USERS_SCHEMA }
    );
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function publishStockToSupabase_(publishedRows, metaInput) {
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
    const version = snapshotVersion_(meta) || null;
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
        sheetScriptUrl: canUpload && sheetMirror ? STOCK_SHEET_SCRIPT_URL : '',
        uploadUrl,
        csvUrl: sheetMirror ? STOCK_SHEET_FALLBACK_URL : stockPublicCsvUrl_(version),
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
const { syncDisconnectionToSupabase } = require('./scripts/sync/sync_disconnection_to_supabase');
const { syncPendingMcToSupabase } = require('./scripts/sync/sync_pending_mc_to_supabase');
const { syncLoadExtToSupabase } = require('./scripts/sync/sync_load_ext_to_supabase');

/** A sync job's meta.json from the public reports bucket (cached 60 s); the local data/ copy as a fallback. */
function syncedMeta_(folder, localFile) {
    let cached = null;
    let at = 0;
    return {
        async read() {
            const now = Date.now();
            if (cached && now - at < 60000) return cached;
            const root = String(NEW_INSIGHT_URL || INSIGHT_URL || '').replace(/\/$/, '');
            if (root) {
                try {
                    const r = await fetch(`${root}/storage/v1/object/public/reports/${folder}/meta.json`, {
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
                return JSON.parse(fs.readFileSync(path.join(DATA_DIR, localFile), 'utf8'));
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

/** POST route that runs one sync job (one at a time per instance) and logs it. */
function syncRoute_(routePath, { label, can, forbidden, run, meta, done, bareError }) {
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
            const result = await run();
            meta.set(result);
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

/** Common fields of the disconnection / pending MC / load extension meta responses. */
function syncedMetaFields_(meta, fallbackCsvUrl) {
    return {
        version: meta ? meta.version : null,
        reportDate: meta ? meta.reportDate : null,
        stats: meta ? meta.stats : null,
        csvUrl: (meta && meta.csvUrl) || fallbackCsvUrl,
        source: meta ? meta.source : 'google_sheet'
    };
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
    res.setHeader('Cache-Control', 'private, max-age=15, must-revalidate');
    return res.json({
        status: 'success',
        canUpload,
        canSync: canUpload,
        isAdmin: isPortalAdmin_(user),
        sheetScriptUrl: canUpload && DEFECTIVE_SHEET_SCRIPT_URL ? DEFECTIVE_SHEET_SCRIPT_URL : '',
        spreadsheetId: DEFECTIVE_SPREADSHEET_ID,
        summaryCsvUrl: (meta && meta.summaryCsvUrl) || defectiveExportCsvUrl_(DEFECTIVE_SUMMARY_GID),
        detailsCsvUrl: (meta && meta.detailsCsvUrl) || defectiveExportCsvUrl_(DEFECTIVE_DETAILS_GID),
        version: (meta && meta.version) || null,
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
    done: (m) => ({
        log: `Synced Defective Meter: ${m.stats.totalDefective} meters (${m.stats.summaryRows} summary, ${m.stats.detailsRows} details)`,
        message: `Defective Meter sync complete! Total: ${m.stats.totalDefective} meters.`
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
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    const user = await resolveFreshUser_(req);
    const meta = await DISCONNECTION_META.read();
    res.setHeader('Cache-Control', 'private, max-age=15, must-revalidate');
    return res.json({
        status: 'success',
        canSync: canSyncDisconnection_(user),
        isAdmin: isPortalAdmin_(user),
        sheetScriptUrl: DISCONNECTION_FOLLOWUP_SCRIPT_URL,
        ...syncedMetaFields_(meta, DISCONNECTION_SHEET_FALLBACK_URL)
    });
});

syncRoute_('/api/disconnection/sync', {
    label: 'Disconnection Sync',
    can: canSyncDisconnection_,
    forbidden: 'Not authorized to sync disconnection data. Ask an admin to grant permission.',
    run: syncDisconnectionToSupabase,
    meta: DISCONNECTION_META,
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
        ...syncedMetaFields_(meta, PENDING_MC_SHEET_FALLBACK_URL)
    });
});

syncRoute_('/api/pending-mc/sync', {
    label: 'Pending MC Sync',
    can: canSyncPendingMc_,
    forbidden: 'Not authorized to sync Pending Master Card data. Ask an admin to grant permission.',
    run: syncPendingMcToSupabase,
    meta: PENDING_MC_META,
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
        ...syncedMetaFields_(meta, LOAD_EXT_SHEET_FALLBACK_URL)
    });
});

syncRoute_('/api/load-extension/sync', {
    label: 'Load Extension Sync',
    can: canSyncLoadExt_,
    forbidden: 'Not authorized to sync Load Extension data. Ask an admin to grant permission.',
    run: syncLoadExtToSupabase,
    meta: LOAD_EXT_META,
    done: (m) => ({
        log: `Synced Load Extension: ${m.stats.totalPending} applications`,
        message: `Successfully synced ${m.stats.totalPending} Load Extension applications to Cloud Cache.`
    })
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
        powerMap: async () => {
            const latest = await querySupabase(POWER_MAP_TABLE + '?select=updated_at&order=updated_at.desc&limit=1');
            const row = Array.isArray(latest) && latest[0] ? latest[0] : latest;
            const pmVer = String((row && row.updated_at) || '').trim();
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
    const names = Object.keys(tasks);
    const results = await Promise.allSettled(names.map((n) => tasks[n]()));
    results.forEach((r, i) => {
        if (r.status === 'rejected') console.warn(`[Hub versions] ${names[i]}:`, r.reason && r.reason.message);
    });
    const extra = results[names.indexOf('metadata')];
    if (extra.status === 'fulfilled' && extra.value) Object.assign(versions, extra.value);

    res.setHeader('Cache-Control', 'private, max-age=15, must-revalidate');
    return res.json({ status: 'success', versions, csvUrls });
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

app.get('/api/news', async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    try {
        const now = Date.now();
        const force = req.query.force === '1' || req.query.force === 'true';
        if (!force && cachedNewsItems_.length > 0 && (now - lastNewsFetchTime_) < NEWS_CACHE_TTL_MS) {
            return res.json({ status: 'ok', items: cachedNewsItems_, cached: true });
        }

        const items = await fetchAllNewsFeeds_();
        if (items.length > 0) {
            cachedNewsItems_ = items;
            lastNewsFetchTime_ = now;
        }

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

// Numbers come from the sync jobs' meta; an item whose numbers are unavailable is left out (never guessed).
function buildExecutiveBriefing_(meta) {
    const pendingMc = (meta && meta.pendingMc && meta.pendingMc.stats) || {};
    const loadExt = (meta && meta.loadExt && meta.loadExt.stats) || {};
    const discon = (meta && meta.discon && meta.discon.stats) || {};
    const defective = (meta && meta.defective && meta.defective.stats) || {};
    const nsc = (meta && meta.nsc && meta.nsc.stats) || {};

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
        divisionCccs: pendingMc.divisionCccs || {},
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
        divisionCccs: discon.divisionCccs || {},
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
        divisionCccs: defective.divisionCccs || {},
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
            divisionCccs: nsc.divisionCccs || {},
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
        divisionCccs: loadExt.divisionCccs || {},
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
        divisionCccs: pendingMc.divisionCccs || {},
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
        divisionCccs: defective.divisionCccs || {},
        deepLink: 'consumer/defective_meter.html?kpi=ph3',
        pageTitle: 'Defective Meter Dashboard',
        datasetKey: 'CACHE_DEFECTIVE'
    });

    // Withheld NSC applications (WATCH) — counts from the last NSC upload
    const withheldRows = Number(nsc.withheldRows || (nsc.statusCounts && nsc.statusCounts.Witheld) || 0);
    if (withheldRows) {
        const regions = nsc.regionCounts || {};
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
        divisionCccs: discon.divisionCccs || {},
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

    return {
        asOn,
        generatedAt: new Date().toISOString(),
        summaryCounts,
        items
    };
}

app.get('/api/executive/briefing', async (req, res) => {
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    try {
        const [pendingMcMeta, loadExtMeta, disconMeta, defectiveMeta, nscMeta] = await Promise.all([
            PENDING_MC_META.read().catch(() => null),
            LOAD_EXT_META.read().catch(() => null),
            DISCONNECTION_META.read().catch(() => null),
            DEFECTIVE_META.read().catch(() => null),
            // data/nsc_meta.json (with delayed30) when the briefing tool ran locally; else the Sheet's upload meta
            Promise.resolve(readLocalNscMeta_() || fetchNscSheetMeta_()).catch(() => null)
        ]);

        const briefing = buildExecutiveBriefing_({
            pendingMc: pendingMcMeta,
            loadExt: loadExtMeta,
            discon: disconMeta,
            defective: defectiveMeta,
            nsc: nscMeta
        });

        res.setHeader('Cache-Control', 'private, max-age=30, must-revalidate');
        return res.json({ status: 'success', briefing });
    } catch (err) {
        console.error('[Executive Briefing Error]:', err);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

// --- Assistant (Claude Haiku) ---------------------------------------------
// The browser runs the tools against its own (already office-scoped) data and
// posts tool results back; this route only holds the API key and calls Claude.
// Only the conversation comes from the client — model, system prompt and tools
// are fixed here. Set ANTHROPIC_API_KEY (or anthropicApiKey in data/supabase_config.json).
const AnthropicSDK = require('@anthropic-ai/sdk');
const Anthropic = AnthropicSDK.default || AnthropicSDK;
const ASSISTANT_CATALOG = require('./lib/assistant_catalog.js');
const ASSISTANT_MODEL = 'claude-haiku-5-5';
let anthropicClient = null;

function assistantClient() {
    const key = String(process.env.ANTHROPIC_API_KEY || fileConfig.anthropicApiKey || '').trim();
    if (!key) return null;
    if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 60 * 1000 });
    return anthropicClient;
}

function assistantSystemPrompt() {
    const C = ASSISTANT_CATALOG;
    const offices = Object.keys(C.OFFICES).map((r) =>
        `- ${r} region: ` + Object.keys(C.OFFICES[r]).map((d) => `${d} division (CCCs: ${C.OFFICES[r][d].join(', ')})`).join('; ')
    ).join('\n');
    const reports = C.REPORTS.map((r) => {
        const bits = [`- ${r.key} — "${r.title}": ${r.about}`];
        if (r.params && r.params.length) bits.push(`  link filters: ${r.params.join(', ')}`);
        if (r.views) bits.push(`  views: ${Object.keys(r.views).join(', ')}`);
        if (r.data) bits.push('  numbers available through query_report');
        return bits.join('\n');
    }).join('\n');
    const glossary = Object.keys(C.GLOSSARY).map((k) => `${k} = ${C.GLOSSARY[k]}`).join('; ');
    return [
        'You are the assistant inside MZO Reports, the reporting app of WBSEDCL Malda Zone (an electricity distribution utility in West Bengal, India).',
        'The people asking are distribution officers and office staff. Many are not technical. They want a straight answer and a link to the right report.',
        '',
        'What you can do:',
        '1. Answer questions about the numbers. Use query_report for nsc, load_extension, solar and loss, and get_briefing for "what needs attention" questions. Every number you state must come from a tool result in this conversation. Never estimate or invent a number.',
        '2. Open a report already filtered. When the user asks to see, open, show or list something, call open_report with the report, the office filters and a view when one fits. If they say "that" or "those" right after you named an office, filter the link to that office. The app shows the link as a button the user clicks (nothing opens by itself), so call it "the button" (no above/below) and do not paste URLs.',
        '3. Explain what a report shows, where to find something, or what a term means.',
        'For reports without query_report numbers, say you cannot read those numbers yet and offer the link.',
        '',
        'Office hierarchy (canonical names; use exactly these in tool inputs):',
        offices,
        'Officers often say "Uttar Dinajpur" for the Raiganj region and "Dakshin Dinajpur" for the Balurghat region. If an office name is ambiguous (Raiganj, Malda and Balurghat are each a region, a division and a CCC), choose the level that fits the question, and say which one you used.',
        '',
        'Reports:',
        reports,
        '',
        `Terms: ${glossary}.`,
        '',
        'How to answer:',
        '- Lead with the answer in one or two short sentences, then at most a few short bullet points if they help. Plain words, no jargon the user did not use, no emojis, no tables.',
        '- Write numbers the Indian way (1,23,456; ₹4.5 L; ₹2.1 Cr). Say which office and date the numbers are for.',
        '- If a tool result says the user only sees part of the zone, answer for that part and mention it once.',
        '- If the question is unclear, ask one short question instead of guessing.',
        '- If something is outside these reports, say so briefly.'
    ].join('\n');
}

function assistantTools() {
    const C = ASSISTANT_CATALOG;
    const office = (desc) => ({ type: 'string', description: desc });
    const allViews = [];
    C.REPORTS.forEach((r) => Object.keys(r.views || {}).forEach((v) => { if (allViews.indexOf(v) === -1) allViews.push(v); }));
    const dataReports = C.REPORTS.filter((r) => r.data).map((r) => r.key);
    // Inputs are validated in the browser before a tool runs (unknown reports/views are rejected there).
    return [
        {
            name: 'open_report',
            description: 'Give the user a button that opens a report with filters applied. Use when the user wants to see, open, show or list something. Only use filters and views the report supports (see the report list); leave a field out when it does not apply.',
            input_schema: {
                type: 'object',
                properties: {
                    report: { type: 'string', enum: C.REPORTS.map((r) => r.key) },
                    region: office('Region name'),
                    division: office('Division name'),
                    ccc: office('CCC name'),
                    view: { type: 'string', enum: allViews, description: 'A preset view of that report' },
                    search: { type: 'string', description: 'Application / consumer number or name to search for' },
                    label: { type: 'string', description: 'Short button text, e.g. "Raiganj · pending over 30 days"' }
                },
                required: ['report', 'label'],
                additionalProperties: false
            }
        },
        {
            name: 'query_report',
            description: 'Count and summarise a report from the data already loaded in the user\'s browser (limited to the user\'s office scope). Returns totals and, with group_by, one row per office. nsc views: over_30_days, pole_cases, rescued_from_withheld, industrial, commercial_three_phase. load_extension views: over_1_year, industrial, three_phase, above_10kw. solar views: connected, pending, meter_issue, pm_surya_ghar. loss has no views; month is YYYY-MM (leave out for the latest).',
            input_schema: {
                type: 'object',
                properties: {
                    report: { type: 'string', enum: dataReports },
                    region: office('Region name'),
                    division: office('Division name'),
                    ccc: office('CCC name'),
                    view: { type: 'string', enum: allViews, description: 'Only count rows in this view' },
                    group_by: { type: 'string', enum: ['none', 'region', 'division', 'ccc'] },
                    month: { type: 'string', description: 'loss only: YYYY-MM' }
                },
                required: ['report', 'group_by'],
                additionalProperties: false
            }
        },
        {
            name: 'get_briefing',
            description: 'Get today\'s zone briefing: items needing attention (critical, high priority, watch) with their numbers and the most affected divisions.',
            input_schema: { type: 'object', properties: {}, additionalProperties: false }
        }
    ];
}

const ASSISTANT_SYSTEM = assistantSystemPrompt();
const ASSISTANT_TOOLS = assistantTools();
const ASSISTANT_BLOCK_TYPES = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking']);
const assistantHits = new Map(); // username -> [timestamps] (best effort per instance)

function assistantMessagesValid(messages) {
    if (!Array.isArray(messages) || !messages.length || messages.length > 60) return false;
    if (JSON.stringify(messages).length > 200000) return false;
    if (messages[0].role !== 'user' || messages[messages.length - 1].role !== 'user') return false;
    return messages.every((m) => {
        if (!m || (m.role !== 'user' && m.role !== 'assistant')) return false;
        if (typeof m.content === 'string') return m.content.length > 0 && m.content.length <= 4000;
        return Array.isArray(m.content) && m.content.length > 0 && m.content.every((b) => b && ASSISTANT_BLOCK_TYPES.has(b.type));
    });
}

app.post('/api/assistant', async (req, res) => {
    const user = req.user || {};
    const client = assistantClient();
    if (!client) {
        return res.status(503).json({ status: 'error', code: 'not_configured', message: 'The assistant is not set up yet. Ask the administrator to add the Anthropic API key.' });
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
    if (!assistantMessagesValid(messages)) {
        return res.status(400).json({ status: 'error', code: 'bad_request', message: 'That conversation could not be sent.' });
    }
    // Volatile, per-user details go after the cached block.
    const scope = String((context && context.scope) || '').slice(0, 160);
    const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
    const userNote = `Today is ${today}. The signed-in user is ${String(user.Name || user.Username || 'an officer').slice(0, 80)} (${user.role === 'admin' ? 'administrator' : 'officer'}). Office scope: ${scope || 'whole zone'}.`;

    try {
        const response = await client.messages.create({
            model: ASSISTANT_MODEL,
            max_tokens: 16000,
            output_config: { effort: 'low' },
            system: [
                { type: 'text', text: ASSISTANT_SYSTEM, cache_control: { type: 'ephemeral' } },
                { type: 'text', text: userNote }
            ],
            tools: ASSISTANT_TOOLS,
            messages
        });
        return res.json({
            status: 'success',
            stop_reason: response.stop_reason,
            content: response.content,
            usage: {
                input: response.usage && response.usage.input_tokens,
                output: response.usage && response.usage.output_tokens,
                cache_read: response.usage && response.usage.cache_read_input_tokens
            }
        });
    } catch (err) {
        if (err instanceof Anthropic.RateLimitError) {
            return res.status(429).json({ status: 'error', code: 'busy', message: 'The assistant is busy. Try again in a moment.' });
        }
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
            console.error('[Assistant] API key rejected:', err.message);
            return res.status(503).json({ status: 'error', code: 'not_configured', message: 'The assistant key is not valid. Ask the administrator to check it.' });
        }
        if (err instanceof Anthropic.BadRequestError) {
            console.error('[Assistant] Bad request:', err.message);
            return res.status(400).json({ status: 'error', code: 'bad_request', message: 'That question could not be processed. Start a new conversation and try again.' });
        }
        if (err instanceof Anthropic.APIError) {
            console.error('[Assistant] API error', err.status, err.message);
            return res.status(502).json({ status: 'error', code: 'upstream', message: 'The assistant could not answer right now. Try again.' });
        }
        console.error('[Assistant] Error:', err && err.message);
        return res.status(500).json({ status: 'error', code: 'error', message: 'The assistant could not answer right now. Try again.' });
    }
});

if ((process.env.NODE_ENV !== 'production' || !process.env.VERCEL) && require.main === module) {
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
}

module.exports = app;
