const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const https = require('https');

// Middleware to parse JSON bodies (raised for NSC/stock publish payloads on Vercel)
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// --- Authentication Session Storage & Helpers ---
const JWT_SECRET = process.env.JWT_SECRET || 'mzo-portal-super-secret-key-123456';
const POWER_MAP_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vT8hYE6YBbfVQDJhgB3cIWqrrGrjMQAQ22mcmCJTOa995gCH-xBAfsAPpBvNYS1KlYIFMRHM59iGB7K/pub?output=csv';
// Distinct table names (do not use generic "substations" — may clash with other projects/tables)
const POWER_MAP_TABLE = 'mzo_power_substations';
const POWER_MAP_CORRECTIONS_TABLE = 'mzo_power_corrections';
// Portal login + activity logs live in mzo_insight (not Google Sheet)
const PORTAL_USERS_SCHEMA = 'mzo_insight';
const PORTAL_USERS_TABLE = 'portal_users';
const ACTIVITY_LOGS_TABLE = 'activity_logs';
const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const LOGS_FILE = path.join(__dirname, 'data', 'activity_log.json');

function parseCookies(cookieHeader) {
    const list = {};
    if (!cookieHeader) return list;
    cookieHeader.split(';').forEach(cookie => {
        const parts = cookie.split('=');
        list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
    return list;
}

function fetchSheet(url) {
    if (typeof fetch === 'function') {
        return fetch(url).then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.text();
        });
    }
    
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Failed to fetch sheet: HTTP ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', err => reject(err));
    });
}

let globalCachedUsers = null;
let globalCachedLogs = null;
let usersCacheLoadedAt = 0;
const USERS_CACHE_TTL_MS = 2 * 60 * 1000; // short TTL for admin/list reads

// Supabase Configuration (env → local file → public anon fallback used elsewhere in this repo)
let SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
let SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

// Same project anon key already shipped in client pages (e.g. dd/upcomingDD2.html).
// Needed because /data is gitignored and often missing on Vercel unless env vars are set.
const SUPABASE_FALLBACK_URL = 'https://unsmtschmcvftfqwabaq.supabase.co';
const SUPABASE_FALLBACK_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVuc210c2NobWN2ZnRmcXdhYmFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTM1NzA1MTYsImV4cCI6MjA2OTE0NjUxNn0.X3_q0FyEjam4ct03sjiqINz0_Hfu0AlWgRcymA3us9o';

const supabaseConfigPath = path.join(__dirname, 'data', 'supabase_config.json');
if (fs.existsSync(supabaseConfigPath)) {
    try {
        const config = JSON.parse(fs.readFileSync(supabaseConfigPath, 'utf8'));
        if (config.supabaseUrl) SUPABASE_URL = config.supabaseUrl;
        if (config.supabaseKey) SUPABASE_KEY = config.supabaseKey;
        console.log("[Supabase] Loaded credentials from data/supabase_config.json");
    } catch (e) {
        console.error("[Supabase] Failed to parse data/supabase_config.json:", e.message);
    }
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
    SUPABASE_URL = SUPABASE_URL || SUPABASE_FALLBACK_URL;
    SUPABASE_KEY = SUPABASE_KEY || SUPABASE_FALLBACK_ANON_KEY;
    console.log("[Supabase] Using built-in anon fallback credentials for Power Map API");
} else {
    console.log("[Supabase] Credentials ready for host:", (() => {
        try { return new URL(SUPABASE_URL).host; } catch (_) { return 'invalid-url'; }
    })());
}

// Zero-dependency Supabase REST Query Helper
async function querySupabase(apiPath, options = {}) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        throw new Error("Supabase credentials not configured. Set SUPABASE_URL and SUPABASE_KEY env vars.");
    }
    const schema = options.schema || 'public';
    const url = `${SUPABASE_URL}/rest/v1/${apiPath}`;
    const headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Accept-Profile': schema,
        ...options.headers
    };
    // Prefer only for mutating requests (POST/PATCH/DELETE)
    const method = (options.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
        headers['Prefer'] = options.prefer || 'return=representation';
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
        'si-autho': row.si_autho || '',
        'si-divisions': row.si_divisions || '',
        'sheets-autho': row.sheets_autho || '',
        zone_code: row.zone_code || '',
        region_code: row.region_code || '',
        division_code: row.division_code || '',
        ccc_code: row.ccc_code || ''
    };
}

/** Map legacy / admin payload → DB columns */
function clientUserToPortal(user) {
    const username = String(user.Username || user.username || '').trim();
    return {
        username,
        pin: String(user.PIN != null ? user.PIN : (user.pin || '')).trim(),
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
        si_autho: String(user['si-autho'] != null ? user['si-autho'] : (user.si_autho || '')).trim(),
        si_divisions: String(user['si-divisions'] != null ? user['si-divisions'] : (user.si_divisions || '')).trim(),
        sheets_autho: String(user['sheets-autho'] != null ? user['sheets-autho'] : (user.sheets_autho || '')).trim(),
        zone_code: String(user.zone_code || '').trim(),
        region_code: String(user.region_code || '').trim(),
        division_code: String(user.division_code || '').trim(),
        ccc_code: String(user.ccc_code || '').trim(),
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

async function fetchActivityLogsFromSupabase(limit = 2000) {
    const safeLimit = Math.min(Math.max(Number(limit) || 2000, 1), 5000);
    const rows = await querySupabase(
        `${ACTIVITY_LOGS_TABLE}?select=timestamp,username,name,type,details&order=timestamp.desc&limit=${safeLimit}`,
        { schema: PORTAL_USERS_SCHEMA }
    );
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
        const entry = {
            timestamp: new Date().toISOString(),
            username: activity.username,
            name: activity.name,
            type: activity.type,
            details: activity.details
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

        try {
            const dataDir = path.join(__dirname, 'data');
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
            console.log(`[Auth] Cached ${users.length} portal users locally.`);
        } catch (writeErr) {
            console.warn("[Auth] Failed to write local users file (read-only filesystem fallback):", writeErr.message);
        }
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
        return String(u.Username).trim().toLowerCase() === userKey && storedPin === pinKey;
    }) || null;
}

// Authentication middleware
async function requireAuth(req, res, next) {
    const pathName = req.path;
    
    // Whitelist static assets, login page, and login API
    if (
        pathName === '/login.html' || 
        pathName === '/api/login' || 
        pathName === '/sw.js' ||
        pathName === '/manifest.json' ||
        pathName === '/offline.html' ||
        pathName.startsWith('/icons/') || 
        pathName.startsWith('/assets/') || 
        pathName.endsWith('.css') || 
        pathName.endsWith('.js') || 
        pathName.endsWith('.png') || 
        pathName.endsWith('.json') ||
        pathName.endsWith('.ico')
    ) {
        return next();
    }
    
    // Read and verify session cookies
    const cookieHeader = req.headers.cookie || '';
    const cookies = parseCookies(cookieHeader);
    const token = cookies.mzo_session;
    
    if (token) {
        try {
            const parts = token.split('.');
            if (parts.length === 2) {
                const [payloadStr, signature] = parts;
                const expectedSignature = require('crypto').createHmac('sha256', JWT_SECRET).update(payloadStr).digest('base64');
                if (signature === expectedSignature) {
                    const session = JSON.parse(Buffer.from(payloadStr, 'base64').toString('utf-8'));
                    if (Date.now() < session.expiry) {
                        req.user = session.profile;
                        
                        // Log page visits (intercept requests for HTML pages, excluding APIs and assets)
                        const ext = path.extname(pathName).toLowerCase();
                        const isHtml = ext === '.html' || pathName === '/' || pathName === '';
                        const isAssetOrApi = pathName.startsWith('/api/') || pathName.startsWith('/icons/') || pathName.startsWith('/assets/') || ext === '.css' || ext === '.js' || ext === '.png' || ext === '.json' || ext === '.ico';
                        
                        if (isHtml && !isAssetOrApi && pathName !== '/login.html' && pathName !== '/admin_users.html') {
                            await logActivity({
                                username: req.user.Username,
                                name: req.user.Name || 'No Name',
                                type: 'page_visit',
                                details: `Visited page: ${pathName === '/' ? '/index.html' : pathName}`
                            });
                        }
                        
                        return next();
                    }
                }
            }
        } catch (err) {
            console.error("[Auth] Session cookie verification failed:", err.message);
        }
    }
    
    // Redirect / return 401 if unauthenticated
    // API routes must never get an HTML login redirect (breaks CSV/JSON clients like Power Map)
    if (pathName.startsWith('/api/')) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }
    return res.redirect('/login.html');
}

// Enable authentication check before serving static files
app.use(requireAuth);
app.use(express.static(__dirname));

// --- File Paths ---
const STRUCTURE_FILE = path.join(__dirname, 'data', 'structure.csv');

// --- CSV Parser Utility ---
function parseCSV(text) {
    const lines = text.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        // Handle quoted values with commas inside
        const values = parseCSVLine(lines[i]);
        if (values.length === headers.length) {
            const row = {};
            for (let j = 0; j < headers.length; j++) {
                row[headers[j]] = values[j];
            }
            rows.push(row);
        }
    }
    return rows;
}

function parseCSVLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            values.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    values.push(current.trim());
    return values;
}

// --- CSV Generator Utility ---
function generateCSV(structures) {
    const headers = ['id', 'name', 'description', 'voltage', 'materials', 'labour'];
    const lines = [headers.join(',')];
    
    structures.forEach(s => {
        const row = [
            s.id,
            `"${s.name}"`,
            `"${s.description}"`,
            `"${s.voltage}"`,
            `"${s.materials}"`,
            `"${s.labour}"`
        ];
        lines.push(row.join(','));
    });
    
    return lines.join('\n');
}

// API endpoint to GET the current structure data (as JSON)
app.get('/api/structures', (req, res) => {
    try {
        const csvText = fs.readFileSync(STRUCTURE_FILE, 'utf-8');
        const structures = parseCSV(csvText);
        
        // Convert to the format expected by the app
        const formattedStructures = structures.map(s => ({
            id: s.id,
            name: s.name,
            description: s.description,
            voltage: s.voltage,
            materials: s.materials,
            labour: s.labour
        }));
        
        res.json(formattedStructures);
    } catch (error) {
        console.error("Error reading structure file:", error.message);
        res.status(500).json({ message: 'Error reading structure data.', details: error.message });
    }
});

// API endpoint to POST (update) the structure data
app.post('/api/structures/update', (req, res) => {
    const updatedStructures = req.body;

    if (!Array.isArray(updatedStructures)) {
        return res.status(400).send('Invalid data format. Expected an array of structures.');
    }

    try {
        const csvContent = generateCSV(updatedStructures);
        fs.writeFileSync(STRUCTURE_FILE, csvContent, 'utf-8');
        res.status(200).json({ message: 'Structures updated successfully!' });
    } catch (error) {
        console.error("Error writing structure file:", error.message);
        res.status(500).json({ message: 'An error occurred while saving data.', details: error.message });
    }
});

// API endpoint for User Login
app.post('/api/login', async (req, res) => {
    const { username, pin } = req.body;

    if (!username || !pin || !String(pin).trim()) {
        return res.status(400).json({ status: 'error', message: 'Username and PIN are required.' });
    }

    try {
        // Always re-query Supabase so PIN changes apply immediately
        // (do not trust stale data/users.json or in-memory cache for auth)
        const users = await getLoginCredentials({ forceRefresh: true });
        const matchedUser = matchLoginUser(users, username, pin);

        if (matchedUser) {
            // Exclude the PIN from user profile sent to the client
            const { PIN, ...clientProfile } = matchedUser;
            
            // Generate a stateless signed session token
            const payload = {
                profile: clientProfile,
                expiry: Date.now() + 24 * 60 * 60 * 1000
            };
            const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64');
            const signature = require('crypto').createHmac('sha256', JWT_SECRET).update(payloadStr).digest('base64');
            const token = `${payloadStr}.${signature}`;
            
            // Set session cookie
            res.setHeader('Set-Cookie', `mzo_session=${token}; Path=/; HttpOnly; Max-Age=${24 * 60 * 60}; SameSite=Lax`);
            console.log(`[Auth] User logged in: ${matchedUser.Username} (${matchedUser.Name || 'No Name'})`);
            
            // Log login event
            await logActivity({
                username: matchedUser.Username,
                name: matchedUser.Name || 'No Name',
                type: 'login',
                details: `Logged in from IP: ${req.ip || req.headers['x-forwarded-for'] || 'unknown'}`
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
            const { PIN, ...clientProfile } = fresh;
            return res.status(200).json({ status: 'success', profile: clientProfile });
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
            return res.redirect('/index.html');
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
        res.json({ status: 'success', users });
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
        const inserted = await querySupabase(PORTAL_USERS_TABLE, {
            schema: PORTAL_USERS_SCHEMA,
            method: 'POST',
            body: dbRow
        });
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
        
        res.json({ status: 'success', message: 'User created successfully.', user: saved });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

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
        
        const merged = {
            ...users[idx],
            ...updatedUser,
            Username: users[idx].Username // Username cannot be changed
        };

        const dbRow = clientUserToPortal(merged);
        delete dbRow.username; // do not patch username
        await querySupabase(
            `${PORTAL_USERS_TABLE}?username=eq.${encodeURIComponent(users[idx].Username)}`,
            {
                schema: PORTAL_USERS_SCHEMA,
                method: 'PATCH',
                body: dbRow
            }
        );
        
        await initializeLocalUsers();
        
        await logActivity({
            username: req.user.Username,
            name: req.user.Name,
            type: 'user_management',
            details: `Updated user account: ${Username}`
        });
        
        res.json({ status: 'success', message: 'User updated successfully.', user: merged });
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

// 5. GET logs (Supabase mzo_insight.activity_logs)
app.get('/api/admin/logs', requireAdmin, async (req, res) => {
    try {
        try {
            const logs = await fetchActivityLogsFromSupabase(2000);
            globalCachedLogs = logs;
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
    const sendCsv = (csvBody) => {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).send(csvBody);
    };

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

// 6.5. Edit sheet row (Power Map Admin Edit - Supabase Table version)
app.post('/api/admin/edit-sheet-row', async (req, res) => {
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    try {
        const { rowKeyColumn, rowKeyValue, columnName, newValue, connectionTarget } = req.body;
        
        if (!rowKeyColumn || !rowKeyValue || !columnName) {
            return res.status(400).json({ status: 'error', message: 'Missing required parameters.' });
        }

        // Check permission if not super admin
        if (req.user.role !== 'admin') {
            const records = await querySupabase(`${POWER_MAP_TABLE}?Substation=eq.${encodeURIComponent(rowKeyValue)}&select=*`);
            if (!records || records.length === 0) {
                return res.status(404).json({ status: 'error', message: 'Substation not found.' });
            }
            const record = records[0];
            
            const userDiv = (req.user.division_code || '').trim().toLowerCase();
            const userReg = (req.user.region_code || '').trim().toLowerCase();
            const recordDiv = (record.Division || '').trim().toLowerCase();
            const recordReg = (record.Region || '').trim().toLowerCase();
            
            const hasAccess = (userDiv && recordDiv === userDiv) || (userReg && recordReg === userReg);
            if (!hasAccess) {
                return res.status(403).json({ status: 'error', message: 'Forbidden: You do not have edit permission for this jurisdiction.' });
            }
            
            // Route to suggestions
            const suggestion = {
                type: 'edit_substation',
                substation: rowKeyValue,
                column_name: columnName,
                connection_target: connectionTarget || null,
                proposed_value: newValue,
                suggested_by: req.user.Username,
                suggested_by_name: req.user.Name || req.user.Username,
                status: 'pending'
            };
            
            await querySupabase(POWER_MAP_CORRECTIONS_TABLE, {
                method: 'POST',
                body: suggestion
            });
            
            return res.json({ status: 'success', isSuggestion: true, message: 'Edit submitted as suggested correction. Pending Admin approval.' });
        }

        let finalValue = newValue;

        // Handle colon-separated connection modifications
        if (connectionTarget) {
            // Fetch the existing record to retrieve its connections arrays
            const records = await querySupabase(`${POWER_MAP_TABLE}?Substation=eq.${encodeURIComponent(rowKeyValue)}&select=*`);
            if (!records || records.length === 0) {
                return res.status(404).json({ status: 'error', message: `Substation '${rowKeyValue}' not found.` });
            }
            const record = records[0];
            
            const connStr = record["Connected to"] || '';
            const conns = connStr.split(':').map(s => s.trim().toLowerCase());
            
            const targetIdx = conns.indexOf(connectionTarget.trim().toLowerCase());
            if (targetIdx === -1) {
                return res.status(400).json({ status: 'error', message: `Connection target '${connectionTarget}' not found.` });
            }

            const currentValStr = record[columnName] || '';
            const vals = currentValStr.split(':').map(s => s.trim());
            while (vals.length < conns.length) {
                vals.push("");
            }
            vals[targetIdx] = newValue;
            finalValue = vals.join(" : ");
        }

        // Patch the column value in Supabase
        const patchBody = {};
        patchBody[columnName] = finalValue;
        
        await querySupabase(`${POWER_MAP_TABLE}?Substation=eq.${encodeURIComponent(rowKeyValue)}`, {
            method: 'PATCH',
            body: patchBody
        });

        return res.json({ status: 'success', message: 'Database row updated successfully.' });
    } catch (err) {
        console.error("[Admin Edit] Error updating Supabase row:", err.message);
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

        // Check permission if not super admin
        if (req.user.role !== 'admin') {
            const userDiv = (req.user.division_code || '').trim().toLowerCase();
            const userReg = (req.user.region_code || '').trim().toLowerCase();
            const targetDiv = (rowData.Division || '').trim().toLowerCase();
            const targetReg = (rowData.Region || '').trim().toLowerCase();
            
            const hasAccess = (userDiv && targetDiv === userDiv) || (userReg && targetReg === userReg);
            if (!hasAccess) {
                return res.status(403).json({ status: 'error', message: 'Forbidden: You cannot create a substation outside your jurisdiction.' });
            }
            
            const suggestion = {
                type: 'add_substation',
                substation: rowData.Substation,
                proposed_value: JSON.stringify(rowData),
                suggested_by: req.user.Username,
                suggested_by_name: req.user.Name || req.user.Username,
                status: 'pending'
            };
            
            await querySupabase(POWER_MAP_CORRECTIONS_TABLE, {
                method: 'POST',
                body: suggestion
            });
            
            return res.json({ status: 'success', isSuggestion: true, message: 'Substation creation submitted for Admin approval.' });
        }
        
        // Build payload matching exact columns in Supabase (all 22 columns)
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

        console.log(`[Admin Add Substation] Appending row to Supabase:`, payload);
        
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

        // Check permission if not super admin
        if (req.user.role !== 'admin') {
            const records = await querySupabase(`${POWER_MAP_TABLE}?Substation=eq.${encodeURIComponent(sourceSubstation)}&select=*`);
            if (!records || records.length === 0) {
                return res.status(404).json({ status: 'error', message: 'Source Substation not found.' });
            }
            const record = records[0];
            
            const userDiv = (req.user.division_code || '').trim().toLowerCase();
            const userReg = (req.user.region_code || '').trim().toLowerCase();
            const recordDiv = (record.Division || '').trim().toLowerCase();
            const recordReg = (record.Region || '').trim().toLowerCase();
            
            const hasAccess = (userDiv && recordDiv === userDiv) || (userReg && recordReg === userReg);
            if (!hasAccess) {
                return res.status(403).json({ status: 'error', message: 'Forbidden: You do not have connection edit permissions for this jurisdiction.' });
            }
            
            const connDetails = { rl, conductorSize, peakLoad };
            const suggestion = {
                type: 'add_connection',
                substation: sourceSubstation,
                connection_target: targetSubstation,
                proposed_value: JSON.stringify(connDetails),
                suggested_by: req.user.Username,
                suggested_by_name: req.user.Name || req.user.Username,
                status: 'pending'
            };
            
            await querySupabase(POWER_MAP_CORRECTIONS_TABLE, {
                method: 'POST',
                body: suggestion
            });
            
            return res.json({ status: 'success', isSuggestion: true, message: 'Feeder connection submitted for Admin approval.' });
        }
        
        // Fetch the source record to retrieve its connections arrays
        const records = await querySupabase(`${POWER_MAP_TABLE}?Substation=eq.${encodeURIComponent(sourceSubstation)}&select=*`);
        if (!records || records.length === 0) {
            return res.status(404).json({ status: 'error', message: `Source Substation '${sourceSubstation}' not found.` });
        }
        const record = records[0];

        const currentConns = (record["Connected to"] || '').toString().trim();
        const nextConns = currentConns ? currentConns + " : " + targetSubstation : targetSubstation;

        const currentRl = (record["RL"] || '').toString().trim();
        const nextRl = currentRl ? currentRl + " : " + (rl || "") : (rl || "");

        const currentCond = (record["ConductorSize"] || '').toString().trim();
        const nextCond = currentCond ? currentCond + " : " + (conductorSize || "") : (conductorSize || "");

        const currentLoad = (record["PeakLoad"] || '').toString().trim();
        const nextLoad = currentLoad ? currentLoad + " : " + (peakLoad || "") : (peakLoad || "");

        // Patch connection details back to Supabase
        const patchBody = {
            "Connected to": nextConns,
            "RL": nextRl,
            "ConductorSize": nextCond,
            "PeakLoad": nextLoad
        };

        console.log(`[Admin Add Connection] Updating feeder connection in Supabase:`, patchBody);
        
        await querySupabase(`${POWER_MAP_TABLE}?Substation=eq.${encodeURIComponent(sourceSubstation)}`, {
            method: 'PATCH',
            body: patchBody
        });

        return res.json({ status: 'success', message: 'Connection added successfully.' });
    } catch (err) {
        console.error("[Admin Add Connection] Error adding connection to Supabase:", err.message);
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
        
        console.log(`[Admin Approve] Processing proposal ID: ${id}, type: ${proposal.type}`);
        
        if (proposal.type === 'edit_substation') {
            // Apply edit to substations
            let finalValue = proposal.proposed_value;
            
            if (proposal.connection_target) {
                // Connection cell list edit (colon-separated)
                const records = await querySupabase(`${POWER_MAP_TABLE}?Substation=eq.${encodeURIComponent(proposal.substation)}&select=*`);
                if (!records || records.length === 0) throw new Error(`Target Substation '${proposal.substation}' not found.`);
                const record = records[0];
                
                const connStr = record["Connected to"] || '';
                const conns = connStr.split(':').map(s => s.trim().toLowerCase());
                const targetIdx = conns.indexOf(proposal.connection_target.trim().toLowerCase());
                if (targetIdx === -1) throw new Error(`Connection target '${proposal.connection_target}' not found.`);
                
                const currentValStr = record[proposal.column_name] || '';
                const vals = currentValStr.split(':').map(s => s.trim());
                while (vals.length < conns.length) {
                    vals.push("");
                }
                vals[targetIdx] = proposal.proposed_value;
                finalValue = vals.join(" : ");
            }
            
            const patchBody = {};
            patchBody[proposal.column_name] = finalValue;
            
            await querySupabase(`${POWER_MAP_TABLE}?Substation=eq.${encodeURIComponent(proposal.substation)}`, {
                method: 'PATCH',
                body: patchBody
            });
            
        } else if (proposal.type === 'add_substation') {
            // Parse rowData from proposed_value
            const rowData = JSON.parse(proposal.proposed_value);
            
            await querySupabase(POWER_MAP_TABLE, {
                method: 'POST',
                body: rowData
            });
            
        } else if (proposal.type === 'add_connection') {
            // Parse connection fields
            const connDetails = JSON.parse(proposal.proposed_value);
            
            const records = await querySupabase(`${POWER_MAP_TABLE}?Substation=eq.${encodeURIComponent(proposal.substation)}&select=*`);
            if (!records || records.length === 0) throw new Error(`Source Substation '${proposal.substation}' not found.`);
            const record = records[0];
            
            const currentConns = (record["Connected to"] || '').toString().trim();
            const nextConns = currentConns ? currentConns + " : " + proposal.connection_target : proposal.connection_target;

            const currentRl = (record["RL"] || '').toString().trim();
            const nextRl = currentRl ? currentRl + " : " + (connDetails.rl || "") : (connDetails.rl || "");

            const currentCond = (record["ConductorSize"] || '').toString().trim();
            const nextCond = currentCond ? currentCond + " : " + (connDetails.conductorSize || "") : (connDetails.conductorSize || "");

            const currentLoad = (record["PeakLoad"] || '').toString().trim();
            const nextLoad = currentLoad ? currentLoad + " : " + (connDetails.peakLoad || "") : (connDetails.peakLoad || "");

            const patchBody = {
                "Connected to": nextConns,
                "RL": nextRl,
                "ConductorSize": nextCond,
                "PeakLoad": nextLoad
            };
            
            await querySupabase(`${POWER_MAP_TABLE}?Substation=eq.${encodeURIComponent(proposal.substation)}`, {
                method: 'PATCH',
                body: patchBody
            });
        }
        
        // Delete the suggestion or mark as approved
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

// 6.8. Delete substation (Power Map Admin Delete Substation - Supabase version)
app.post('/api/admin/delete-substation', requireAdmin, async (req, res) => {
    try {
        const { substation } = req.body;
        
        if (!substation) {
            return res.status(400).json({ status: 'error', message: 'Missing substation name.' });
        }
        
        console.log(`[Admin Delete Substation] Deleting substation: ${substation}`);
        
        // 1. Delete the substation record
        await querySupabase(`${POWER_MAP_TABLE}?Substation=eq.${encodeURIComponent(substation)}`, {
            method: 'DELETE'
        });
        
        // 2. Clean up references in other substations' connections
        const allRecords = await querySupabase(POWER_MAP_TABLE + '?select=*');
        for (const record of allRecords) {
            const connStr = record["Connected to"] || '';
            if (connStr) {
                const conns = connStr.split(':').map(s => s.trim());
                const lowerConns = conns.map(s => s.toLowerCase());
                const targetIdx = lowerConns.indexOf(substation.toLowerCase().trim());
                
                if (targetIdx !== -1) {
                    conns.splice(targetIdx, 1);
                    
                    const rls = (record["RL"] || '').split(':').map(s => s.trim());
                    rls.splice(targetIdx, 1);
                    
                    const conds = (record["ConductorSize"] || '').split(':').map(s => s.trim());
                    conds.splice(targetIdx, 1);
                    
                    const loads = (record["PeakLoad"] || '').split(':').map(s => s.trim());
                    loads.splice(targetIdx, 1);
                    
                    const patchBody = {
                        "Connected to": conns.join(" : "),
                        "RL": rls.join(" : "),
                        "ConductorSize": conds.join(" : "),
                        "PeakLoad": loads.join(" : ")
                    };
                    
                    await querySupabase(`${POWER_MAP_TABLE}?Substation=eq.${encodeURIComponent(record.Substation)}`, {
                        method: 'PATCH',
                        body: patchBody
                    });
                }
            }
        }
        
        return res.json({ status: 'success', message: 'Substation and all associated line connections deleted successfully.' });
    } catch (err) {
        console.error("[Admin Delete Substation] Error deleting substation:", err.message);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

// 6.9. Delete feeder connection (Power Map Admin Delete Connection - Supabase version)
app.post('/api/admin/delete-connection', requireAdmin, async (req, res) => {
    try {
        const { source, target } = req.body;
        
        if (!source || !target) {
            return res.status(400).json({ status: 'error', message: 'Missing source or target substation.' });
        }
        
        console.log(`[Admin Delete Connection] Deleting connection from ${source} to ${target}`);
        
        const records = await querySupabase(`${POWER_MAP_TABLE}?Substation=eq.${encodeURIComponent(source)}&select=*`);
        if (!records || records.length === 0) {
            return res.status(404).json({ status: 'error', message: `Source substation '${source}' not found.` });
        }
        const record = records[0];
        
        const connStr = record["Connected to"] || '';
        const conns = connStr.split(':').map(s => s.trim());
        const lowerConns = conns.map(s => s.toLowerCase());
        const targetIdx = lowerConns.indexOf(target.toLowerCase().trim());
        
        if (targetIdx === -1) {
            return res.status(400).json({ status: 'error', message: `Feeder connection to '${target}' not found.` });
        }
        
        conns.splice(targetIdx, 1);
        
        const rls = (record["RL"] || '').split(':').map(s => s.trim());
        rls.splice(targetIdx, 1);
        
        const conds = (record["ConductorSize"] || '').split(':').map(s => s.trim());
        conds.splice(targetIdx, 1);
        
        const loads = (record["PeakLoad"] || '').split(':').map(s => s.trim());
        loads.splice(targetIdx, 1);
        
        const patchBody = {
            "Connected to": conns.join(" : "),
            "RL": rls.join(" : "),
            "ConductorSize": conds.join(" : "),
            "PeakLoad": loads.join(" : ")
        };
        
        await querySupabase(`${POWER_MAP_TABLE}?Substation=eq.${encodeURIComponent(source)}`, {
            method: 'PATCH',
            body: patchBody
        });
        
        return res.json({ status: 'success', message: 'Feeder line connection deleted successfully.' });
    } catch (err) {
        console.error("[Admin Delete Connection] Error deleting connection:", err.message);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

// 7. GET local users list formatted as CSV (mirroring Google Sheets format for backwards compatibility)
app.get('/api/users-csv', async (req, res) => {
    try {
        const users = await getLoginCredentials();
        if (users.length === 0) {
            return res.send('');
        }
        
        const headers = Object.keys(users[0]);
        const csvLines = [headers.join(',')];
        
        users.forEach(u => {
            const row = headers.map(header => {
                const val = String(u[header] || '');
                if (val.includes(',') || val.includes('"') || val.includes('\n')) {
                    return `"${val.replace(/"/g, '""')}"`;
                }
                return val;
            });
            csvLines.push(row.join(','));
        });
        
        res.setHeader('Content-Type', 'text/csv');
        res.send(csvLines.join('\n'));
    } catch (err) {
        console.error("[Users CSV] Error generating CSV:", err.message);
        res.status(500).send('Error generating user CSV.');
    }
});

// Material Allotment → Google Apps Script (Allotments ledger tab)
function stockAllotmentScriptUrl_() {
    return (
        process.env.STOCK_ALLOTMENT_SCRIPT_URL ||
        'https://script.google.com/macros/s/AKfycbxHxa_srh1nfhDTEf1eiXeRj-u2wr7qWiki1m5QIJ7FtWsaVRBVI7kDk37jeSE7ETOz/exec'
    );
}

function flagAuthoYes_(raw) {
    const flag = String(raw || '').trim().toLowerCase();
    return ['y', 'yes', '1', 'true', 'upload', 'allot'].includes(flag);
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

async function resolveStockUser_(req) {
    if (!req.user || !req.user.Username) return req.user || null;
    try {
        const users = await getLoginCredentials({ forceRefresh: true });
        const key = String(req.user.Username).trim().toLowerCase();
        const fresh = users.find((u) => u.Username && String(u.Username).trim().toLowerCase() === key);
        if (fresh) return fresh;
    } catch (e) {
        console.warn('[stock auth] profile refresh failed:', e.message);
    }
    return req.user;
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
    const user = await resolveStockUser_(req);
    if (!canAccessStockAllotment_(user)) {
        res.status(403).json({
            status: 'error',
            error: 'Creating allotments is restricted. Ask an admin to enable Stock Allot in User Management.'
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
    return {
        AllotmentNo: row.allotment_no || '',
        Date: row.date || '',
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
        CreatedAt: row.created_at || ''
    };
}

function allotClientToDb_(row, allotmentNo, createdBy, createdAtIso) {
    const num = (v) => {
        if (v === '' || v == null) return null;
        const n = Number(String(v).replace(/,/g, ''));
        return Number.isNaN(n) ? null : n;
    };
    return {
        allotment_no: allotmentNo,
        date: String(row.Date || row.date || '').slice(0, 10),
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
        created_at: createdAtIso || new Date().toISOString()
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

async function createAllotmentInSupabase_(payload) {
    const createdBy = String(payload.createdBy || '').trim();
    const allotmentNo = await nextAllotmentNoSupabase_();
    const createdAt = new Date().toISOString();
    const rows = (payload.rows || []).map((r) => allotClientToDb_(r, allotmentNo, createdBy, createdAt));
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

async function loadAllotmentRowsCached_(force = false) {
    const now = Date.now();
    if (!force && allotListCache_.rows && now - allotListCache_.at < ALLOT_LIST_TTL_MS) {
        return { rows: allotListCache_.rows, source: allotListCache_.source || 'cache' };
    }

    // 1) Supabase primary
    try {
        const rows = await fetchAllotmentsFromSupabase_();
        if (rows && rows.length) {
            allotListCache_ = { at: now, rows, source: 'supabase' };
            return { rows, source: 'supabase' };
        }
        // empty supabase is still valid if table exists
        if (Array.isArray(rows)) {
            allotListCache_ = { at: now, rows: rows || [], source: 'supabase' };
            // fall through to sheet only if empty and we want migration continuity
            if (rows.length === 0) {
                /* try legacy below */
            } else {
                return { rows, source: 'supabase' };
            }
        }
    } catch (err) {
        console.warn('[stock/allotment] Supabase list failed:', err.message);
    }

    try {
        const text = await fetchAllotmentCsvText_();
        const rows = parseAllotmentCsv_(text);
        if (rows) {
            allotListCache_ = {
                at: now,
                rows,
                source: process.env.STOCK_ALLOTMENTS_CSV_URL ? 'csv' : 'apps-script-csv'
            };
            return { rows, source: allotListCache_.source };
        }
    } catch (err) {
        console.warn('[stock/allotment] CSV list failed, falling back to JSON:', err.message);
    }

    const scriptUrl = stockAllotmentScriptUrl_();
    const upstream = await fetch(scriptUrl, {
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
    const rows = Array.isArray(data.rows) ? data.rows : [];
    allotListCache_ = { at: now, rows, source: 'apps-script-json' };
    return { rows, source: 'apps-script-json' };
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

app.get('/api/stock/allotment', async (req, res) => {
    try {
        if (!requireStockAllotmentLogin_(req, res)) return;
        const action = req.query.action || 'listAllotments';
        if (action === 'listAllotments') {
            const force = String(req.query.force || '') === '1' || String(req.query.refresh || '') === '1';
            const loaded = await loadAllotmentRowsCached_(force);
            const rows = filterAllotmentRowsLocal_(loaded.rows, req.query);
            return res.json({
                status: 'success',
                rows,
                count: rows.length,
                source: loaded.source
            });
        }
        const payload = { action, ...req.query };
        return await proxyStockAllotment_(payload, res);
    } catch (err) {
        console.error('[stock/allotment] GET Error:', err.message);
        return res.status(500).json({ status: 'error', error: err.message });
    }
});

app.post('/api/stock/allotment', async (req, res) => {
    try {
        const payload = req.body || {};
        const action = payload.action || 'createAllotment';
        // Create stays restricted; list/get available to all logged-in users
        if (action === 'createAllotment') {
            if (!(await requireStockAllotmentAccess_(req, res))) return;
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
                console.warn('[stock/allotment] Supabase create failed, trying Apps Script:', e.message);
                return await proxyStockAllotment_(payload, res);
            }
        }

        if (action === 'listAllotments') {
            const force = !!(payload.force || payload.refresh);
            const loaded = await loadAllotmentRowsCached_(force);
            const rows = filterAllotmentRowsLocal_(loaded.rows, payload);
            return res.json({
                status: 'success',
                rows,
                count: rows.length,
                source: loaded.source
            });
        }

        if (action === 'getAllotment') {
            const force = !!(payload.force || payload.refresh);
            const loaded = await loadAllotmentRowsCached_(force);
            const no = String(payload.allotmentNo || payload.AllotmentNo || '').trim();
            if (!no) {
                return res.status(400).json({ status: 'error', error: 'allotmentNo is required' });
            }
            const rows = loaded.rows.filter((r) => String(r.AllotmentNo || '') === no);
            if (!rows.length) {
                return res.status(404).json({ status: 'error', error: `Allotment not found: ${no}` });
            }
            return res.json({
                status: 'success',
                allotmentNo: no,
                rows,
                count: rows.length,
                source: loaded.source
            });
        }

        return res.status(400).json({ status: 'error', error: 'Invalid action' });
    } catch (err) {
        console.error('[stock/allotment] Error:', err.message);
        return res.status(500).json({ status: 'error', error: err.message });
    }
});

// --- NSC raw upload → Supabase + local CACHE_NSC dataset (dm1 only) ---
const multer = require('multer');
const {
    processNscWorkbook,
    publishedFromCsv,
    toCsv: nscToCsv,
    dashboardRowToDb,
    dbRowsToCsv,
    DB_KEYS
} = require('./lib/nsc_pipeline');

const NSC_DATA_DIR = path.join(__dirname, 'data');
const NSC_CSV_FILE = path.join(NSC_DATA_DIR, 'nsc.csv');
const NSC_META_FILE = path.join(NSC_DATA_DIR, 'nsc_meta.json');
const NSC_SCHEMA = PORTAL_USERS_SCHEMA; // mzo_insight
const NSC_PENDING_TABLE = 'nsc_pending';
const NSC_META_TABLE = 'nsc_upload_meta';
const NSC_SHEET_FALLBACK_URL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vRsUU2viBvYhSgR0RFwmZ1H8LkYCats9roQVCKvQeoU7dzg6ryR6IWZex9FT9tksp_DEM23ZgQ28Iyo/pub?output=csv';
const NSC_INSERT_BATCH = 400;

const nscUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 60 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const name = String(file.originalname || '').toLowerCase();
        if (/\.(xlsx|xlsb|xls|csv)$/i.test(name)) return cb(null, true);
        cb(new Error('Only Excel (.xlsx/.xlsb/.xls) or CSV files are allowed.'));
    }
});

function canUploadNsc_(user) {
    if (!user) return false;
    const flag = String(
        user['nsc-upload-autho'] != null ? user['nsc-upload-autho'] : (user.nsc_upload_autho || '')
    )
        .trim()
        .toLowerCase();
    if (['y', 'yes', '1', 'true', 'upload'].includes(flag)) return true;
    // Temporary fallback until admin grants via portal (after SQL alter)
    const username = String((user.Username || user.username) || '')
        .trim()
        .toLowerCase();
    return username === 'dm1';
}

async function resolveNscUploadUser_(req) {
    if (!req.user || !req.user.Username) return null;
    try {
        const users = await getLoginCredentials({ forceRefresh: true });
        const key = String(req.user.Username).trim().toLowerCase();
        const fresh = users.find((u) => u.Username && String(u.Username).trim().toLowerCase() === key);
        if (fresh) return fresh;
    } catch (e) {
        console.warn('[NSC auth] profile refresh failed:', e.message);
    }
    return req.user;
}

function ensureDataDir_() {
    if (!fs.existsSync(NSC_DATA_DIR)) {
        fs.mkdirSync(NSC_DATA_DIR, { recursive: true });
    }
}

function readLocalNscMeta_() {
    try {
        if (!fs.existsSync(NSC_META_FILE)) return null;
        return JSON.parse(fs.readFileSync(NSC_META_FILE, 'utf8'));
    } catch (e) {
        return null;
    }
}

function writeLocalNscBackup_(csv, meta) {
    ensureDataDir_();
    fs.writeFileSync(NSC_CSV_FILE, csv, 'utf8');
    fs.writeFileSync(NSC_META_FILE, JSON.stringify(meta, null, 2), 'utf8');
}

function metaFromDbRow_(row) {
    if (!row) return null;
    return {
        uploadedAt: row.uploaded_at,
        uploadedBy: row.uploaded_by,
        originalName: row.original_name,
        sheetName: row.sheet_name,
        publishedRows: row.published_rows,
        withheldRows: row.withheld_rows,
        reportDate: row.report_date || (row.stats && row.stats.today) || '',
        stats: row.stats || { today: row.report_date },
        supabaseUploadId: row.id,
        source: 'supabase'
    };
}

async function fetchActiveNscMetaFromSupabase_() {
    const rows = await querySupabase(
        `${NSC_META_TABLE}?is_active=eq.true&select=*&order=id.desc&limit=1`,
        { schema: NSC_SCHEMA }
    );
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows[0];
}

async function fetchNscCsvFromSupabase_() {
    const active = await fetchActiveNscMetaFromSupabase_();
    if (!active) return null;

    const selectCols = ['upload_id', ...DB_KEYS].join(',');
    const pageSize = 1000;
    let from = 0;
    const all = [];

    while (true) {
        const batch = await querySupabase(
            `${NSC_PENDING_TABLE}?upload_id=eq.${active.id}&select=${selectCols}&order=id.asc&limit=${pageSize}&offset=${from}`,
            { schema: NSC_SCHEMA }
        );
        if (!Array.isArray(batch) || batch.length === 0) break;
        all.push(...batch);
        if (batch.length < pageSize) break;
        from += pageSize;
        if (from > 200000) break;
    }

    if (!all.length) return { csv: null, meta: metaFromDbRow_(active), rowCount: 0 };
    return {
        csv: dbRowsToCsv(all),
        meta: metaFromDbRow_(active),
        rowCount: all.length
    };
}

async function publishNscToSupabase_(publishedRows, metaInput) {
    // Mark previous uploads inactive
    try {
        await querySupabase(`${NSC_META_TABLE}?is_active=eq.true`, {
            schema: NSC_SCHEMA,
            method: 'PATCH',
            body: { is_active: false },
            prefer: 'return=minimal'
        });
    } catch (e) {
        // First run / empty table is fine
        if (!/HTTP 404|PGRST/i.test(e.message) && !/does not exist|42P01/i.test(e.message)) {
            console.warn('[NSC Supabase] deactivate previous:', e.message);
        }
    }

    const insertedMeta = await querySupabase(NSC_META_TABLE, {
        schema: NSC_SCHEMA,
        method: 'POST',
        body: {
            uploaded_by: metaInput.uploadedBy || '',
            original_name: metaInput.originalName || '',
            sheet_name: metaInput.sheetName || '',
            published_rows: publishedRows.length,
            withheld_rows: metaInput.withheldRows || 0,
            report_date: (metaInput.stats && metaInput.stats.today) || '',
            stats: metaInput.stats || {},
            is_active: true
        },
        prefer: 'return=representation'
    });

    const metaRow = Array.isArray(insertedMeta) ? insertedMeta[0] : insertedMeta;
    if (!metaRow || metaRow.id == null) {
        throw new Error('Supabase did not return nsc_upload_meta id.');
    }
    const uploadId = metaRow.id;

    // Remove any leftover rows for safety (old uploads without cascade cleanup)
    try {
        await querySupabase(`${NSC_PENDING_TABLE}?id=gte.0`, {
            schema: NSC_SCHEMA,
            method: 'DELETE',
            prefer: 'return=minimal'
        });
    } catch (e) {
        console.warn('[NSC Supabase] clear pending:', e.message);
    }

    for (let i = 0; i < publishedRows.length; i += NSC_INSERT_BATCH) {
        const chunk = publishedRows.slice(i, i + NSC_INSERT_BATCH).map((r) => dashboardRowToDb(r, uploadId));
        await querySupabase(NSC_PENDING_TABLE, {
            schema: NSC_SCHEMA,
            method: 'POST',
            body: chunk,
            prefer: 'return=minimal'
        });
    }

    return metaFromDbRow_(metaRow);
}

app.get('/api/nsc/meta', async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }

    const user = await resolveNscUploadUser_(req);

    let source = 'google_sheet_fallback';
    let meta = readLocalNscMeta_();
    const hasLocal = fs.existsSync(NSC_CSV_FILE);

    try {
        const sbMeta = await fetchActiveNscMetaFromSupabase_();
        if (sbMeta) {
            meta = metaFromDbRow_(sbMeta);
            source = 'supabase';
        } else if (hasLocal) {
            source = 'local';
        }
    } catch (e) {
        console.warn('[NSC meta] Supabase unavailable:', e.message);
        if (hasLocal) source = 'local';
    }

    return res.json({
        status: 'success',
        canUpload: canUploadNsc_(user),
        isAdmin: String((user && user.role) || '').trim().toLowerCase() === 'admin',
        hasLocalDataset: hasLocal,
        meta,
        source,
        setupHint:
            source === 'google_sheet_fallback'
                ? 'Run scripts/create_mzo_insight_nsc_pending.sql in Supabase SQL Editor, then upload once.'
                : null
    });
});

app.get('/api/nsc/dataset', async (req, res) => {
    try {
        // 1) Supabase active snapshot
        try {
            const fromSb = await fetchNscCsvFromSupabase_();
            if (fromSb && fromSb.csv) {
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('X-NSC-Source', 'supabase');
                return res.send(fromSb.csv);
            }
        } catch (e) {
            console.warn('[NSC dataset] Supabase read failed:', e.message);
        }

        // 2) Local backup
        if (fs.existsSync(NSC_CSV_FILE)) {
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-NSC-Source', 'local');
            return res.send(fs.readFileSync(NSC_CSV_FILE, 'utf8'));
        }

        // 3) Legacy Google Sheet
        const csv = await fetchSheet(NSC_SHEET_FALLBACK_URL);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-NSC-Source', 'google_sheet_fallback');
        return res.send(csv);
    } catch (err) {
        console.error('[NSC dataset] Error:', err.message);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

app.post('/api/nsc/upload', (req, res) => {
    nscUpload.single('file')(req, res, async (err) => {
        if (err) {
            return res.status(400).json({ status: 'error', message: err.message });
        }
        try {
            if (!req.user) {
                return res.status(401).json({ status: 'error', message: 'Unauthorized' });
            }
            const uploadUser = await resolveNscUploadUser_(req);
            if (!canUploadNsc_(uploadUser)) {
                return res.status(403).json({
                    status: 'error',
                    message: 'NSC raw upload is not authorised for this user. Ask an admin to enable NSC Upload in User Management.'
                });
            }
            if (!req.file || !req.file.buffer) {
                return res.status(400).json({ status: 'error', message: 'No file uploaded.' });
            }

            const reportDateRaw = String((req.body && req.body.reportDate) || '').trim();
            if (!reportDateRaw) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Report date is required. This becomes “Updated on” on the NSC dashboard.'
                });
            }

            const originalName = req.file.originalname || 'nsc_upload.xlsx';
            const result = processNscWorkbook(req.file.buffer, originalName, {
                reportDate: reportDateRaw
            });
            if (!result.published.length) {
                return res.status(400).json({
                    status: 'error',
                    message: 'No Working/Accepted rows found after processing.',
                    stats: result.stats
                });
            }

            const baseMeta = {
                uploadedAt: new Date().toISOString(),
                uploadedBy: uploadUser.Username || uploadUser.username || req.user.Username || 'user',
                originalName,
                sheetName: result.sheetName,
                stats: result.stats,
                publishedRows: result.published.length,
                withheldRows: result.withheld.length,
                reportDate: result.reportDateUsed || (result.stats && result.stats.today) || reportDateRaw
            };

            // Always keep local backup for offline / fast local reads
            writeLocalNscBackup_(result.csv, baseMeta);

            let supabaseMeta = null;
            let supabaseError = null;
            try {
                supabaseMeta = await publishNscToSupabase_(result.published, baseMeta);
                baseMeta.supabaseUploadId = supabaseMeta && supabaseMeta.supabaseUploadId;
                baseMeta.source = 'supabase';
                writeLocalNscBackup_(result.csv, baseMeta);
            } catch (e) {
                supabaseError = e.message;
                console.error('[NSC upload] Supabase publish failed:', e.message);
                baseMeta.source = 'local';
                baseMeta.supabaseError = supabaseError;
                writeLocalNscBackup_(result.csv, baseMeta);
            }

            console.log(
                `[NSC upload] ${baseMeta.uploadedBy} published ${baseMeta.publishedRows} rows` +
                    ` from ${originalName} (supabase=${supabaseMeta ? 'ok' : 'failed'})`
            );

            const message = supabaseMeta
                ? `Published ${baseMeta.publishedRows} NSC rows to Supabase. Refresh NSC dashboard to load.`
                : `Saved ${baseMeta.publishedRows} rows locally, but Supabase publish failed. ` +
                  `Run scripts/create_mzo_insight_nsc_pending.sql if tables are missing. (${supabaseError})`;

            return res.json({
                status: 'success',
                message,
                meta: baseMeta,
                supabase: supabaseMeta ? 'ok' : 'failed',
                supabaseError
            });
        } catch (e) {
            console.error('[NSC upload] Error:', e.message);
            return res.status(500).json({ status: 'error', message: e.message });
        }
    });
});

/**
 * Browser-cleaned NSC publish (Vercel-safe).
 * Raw Excel stays in the browser; only Working/Accepted CSV is posted (~2 MB).
 * Multipart /api/nsc/upload still works on localhost for large files.
 */
app.post('/api/nsc/publish', (req, res) => {
    nscUpload.single('csv')(req, res, async (err) => {
        if (err) {
            return res.status(400).json({ status: 'error', message: err.message });
        }
        try {
            if (!req.user) {
                return res.status(401).json({ status: 'error', message: 'Unauthorized' });
            }
            const uploadUser = await resolveNscUploadUser_(req);
            if (!canUploadNsc_(uploadUser)) {
                return res.status(403).json({
                    status: 'error',
                    message: 'NSC raw upload is not authorised for this user. Ask an admin to enable NSC Upload in User Management.'
                });
            }

            const body = req.body || {};
            let csv = '';
            if (req.file && req.file.buffer) {
                csv = req.file.buffer.toString('utf8').trim();
            } else {
                csv = String(body.csv || '').trim();
            }
            const reportDateRaw = String(body.reportDate || '').trim();
            const originalName = String(body.originalName || 'nsc_client.csv').trim() || 'nsc_client.csv';
            const sheetName = String(body.sheetName || '').trim();
            const withheldRows = Number(body.withheldRows) || 0;
            let clientStats = {};
            try {
                clientStats = body.stats ? JSON.parse(String(body.stats)) : {};
            } catch (_) {
                clientStats = {};
            }
            if (!clientStats || typeof clientStats !== 'object') clientStats = {};

            if (!csv) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Missing cleaned CSV. Process the Excel in the browser first.'
                });
            }
            if (!reportDateRaw) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Report date is required. This becomes “Updated on” on the NSC dashboard.'
                });
            }

            const published = publishedFromCsv(csv);
            if (!published.length) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Cleaned CSV has no data rows.'
                });
            }

            const csvOut = nscToCsv(published);
            const reportLabel = String(clientStats.today || body.reportDateUsed || reportDateRaw).trim();
            const stats = {
                rawRows: Number(clientStats.rawRows) || published.length + withheldRows,
                publishedRows: published.length,
                withheldRows,
                statusCounts: clientStats.statusCounts || {},
                regionCounts: clientStats.regionCounts || {},
                today: reportLabel
            };

            const baseMeta = {
                uploadedAt: new Date().toISOString(),
                uploadedBy: uploadUser.Username || uploadUser.username || req.user.Username || 'user',
                originalName,
                sheetName,
                stats,
                publishedRows: published.length,
                withheldRows,
                reportDate: reportLabel,
                publishMode: 'browser'
            };

            writeLocalNscBackup_(csvOut, baseMeta);

            let supabaseMeta = null;
            let supabaseError = null;
            try {
                supabaseMeta = await publishNscToSupabase_(published, baseMeta);
                baseMeta.supabaseUploadId = supabaseMeta && supabaseMeta.supabaseUploadId;
                baseMeta.source = 'supabase';
                writeLocalNscBackup_(csvOut, baseMeta);
            } catch (e) {
                supabaseError = e.message;
                console.error('[NSC publish] Supabase publish failed:', e.message);
                baseMeta.source = 'local';
                baseMeta.supabaseError = supabaseError;
                writeLocalNscBackup_(csvOut, baseMeta);
            }

            console.log(
                `[NSC publish] ${baseMeta.uploadedBy} published ${baseMeta.publishedRows} rows` +
                    ` from ${originalName} (supabase=${supabaseMeta ? 'ok' : 'failed'})`
            );

            const message = supabaseMeta
                ? `Published ${baseMeta.publishedRows} NSC rows to Supabase. Refresh NSC dashboard to load.`
                : `Saved ${baseMeta.publishedRows} rows locally, but Supabase publish failed. ` +
                  `Run scripts/create_mzo_insight_nsc_pending.sql if tables are missing. (${supabaseError})`;

            return res.json({
                status: 'success',
                message,
                meta: baseMeta,
                supabase: supabaseMeta ? 'ok' : 'failed',
                supabaseError
            });
        } catch (e) {
            console.error('[NSC publish] Error:', e.message);
            return res.status(500).json({ status: 'error', message: e.message });
        }
    });
});

// --- Stock dump upload → Supabase + local CACHE_STOCK ---
const {
    processStockWorkbook,
    dashboardRowToDb: stockRowToDb,
    dbRowsToCsv: stockDbRowsToCsv,
    DB_KEYS: STOCK_DB_KEYS
} = require('./lib/stock_pipeline');

const STOCK_CSV_FILE = path.join(NSC_DATA_DIR, 'stock.csv');
const STOCK_META_FILE = path.join(NSC_DATA_DIR, 'stock_meta.json');
const STOCK_SHEET_FALLBACK_URL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vSE7jMusI5YFc4fcuHMyWpbqGp1fIcWBNRYh6yieCY8yUyjOgC1ZRWB7flXE0DAVEbHUfG-KlzWCZyf/pub?gid=202809558&single=true&output=csv';
const STOCK_INSERT_BATCH = 400;

function canUploadStock_(user) {
    if (!user) return false;
    if (flagAuthoYes_(user['stock-upload-autho'] != null ? user['stock-upload-autho'] : user.stock_upload_autho)) {
        return true;
    }
    const username = String((user.Username || user.username) || '').trim().toLowerCase();
    return username === 'dm1';
}

function readLocalStockMeta_() {
    try {
        if (!fs.existsSync(STOCK_META_FILE)) return null;
        return JSON.parse(fs.readFileSync(STOCK_META_FILE, 'utf8'));
    } catch (e) {
        return null;
    }
}

function writeLocalStockBackup_(csv, meta) {
    ensureDataDir_();
    fs.writeFileSync(STOCK_CSV_FILE, csv, 'utf8');
    fs.writeFileSync(STOCK_META_FILE, JSON.stringify(meta, null, 2), 'utf8');
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

async function fetchStockCsvFromSupabase_() {
    const active = await fetchActiveStockMeta_();
    if (!active) return null;
    const selectCols = ['upload_id', ...STOCK_DB_KEYS].join(',');
    const pageSize = 1000;
    let from = 0;
    const all = [];
    while (true) {
        const batch = await querySupabase(
            `stock_snapshot?upload_id=eq.${active.id}&select=${selectCols}&order=id.asc&limit=${pageSize}&offset=${from}`,
            { schema: PORTAL_USERS_SCHEMA }
        );
        if (!Array.isArray(batch) || !batch.length) break;
        all.push(...batch);
        if (batch.length < pageSize) break;
        from += pageSize;
        if (from > 500000) break;
    }
    if (!all.length) return { csv: null, meta: stockMetaFromDb_(active) };
    return { csv: stockDbRowsToCsv(all), meta: stockMetaFromDb_(active) };
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
    return stockMetaFromDb_(metaRow);
}

app.get('/api/stock/meta', async (req, res) => {
    if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    const user = await resolveStockUser_(req);
    let source = 'google_sheet_fallback';
    let meta = readLocalStockMeta_();
    const hasLocal = fs.existsSync(STOCK_CSV_FILE);
    try {
        const sb = await fetchActiveStockMeta_();
        if (sb) {
            meta = stockMetaFromDb_(sb);
            source = 'supabase';
        } else if (hasLocal) source = 'local';
    } catch (e) {
        if (hasLocal) source = 'local';
    }
    return res.json({
        status: 'success',
        canUpload: canUploadStock_(user),
        isAdmin: String((user && user.role) || '').trim().toLowerCase() === 'admin',
        hasLocalDataset: hasLocal,
        meta,
        source,
        setupHint:
            source === 'google_sheet_fallback'
                ? 'Run scripts/create_mzo_insight_stock_snapshot.sql then upload once.'
                : null
    });
});

app.get('/api/stock/dataset', async (req, res) => {
    try {
        try {
            const fromSb = await fetchStockCsvFromSupabase_();
            if (fromSb && fromSb.csv) {
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('X-Stock-Source', 'supabase');
                return res.send(fromSb.csv);
            }
        } catch (e) {
            console.warn('[Stock dataset] Supabase read failed:', e.message);
        }
        if (fs.existsSync(STOCK_CSV_FILE)) {
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Stock-Source', 'local');
            return res.send(fs.readFileSync(STOCK_CSV_FILE, 'utf8'));
        }
        const csv = await fetchSheet(STOCK_SHEET_FALLBACK_URL);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Stock-Source', 'google_sheet_fallback');
        return res.send(csv);
    } catch (err) {
        console.error('[Stock dataset] Error:', err.message);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

app.post('/api/stock/upload', (req, res) => {
    nscUpload.single('file')(req, res, async (err) => {
        if (err) return res.status(400).json({ status: 'error', message: err.message });
        try {
            if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
            const uploadUser = await resolveStockUser_(req);
            if (!canUploadStock_(uploadUser)) {
                return res.status(403).json({
                    status: 'error',
                    message: 'Stock upload is not authorised. Ask an admin to enable Stock Upload in User Management.'
                });
            }
            if (!req.file || !req.file.buffer) {
                return res.status(400).json({ status: 'error', message: 'No file uploaded.' });
            }
            const reportDateRaw = String((req.body && req.body.reportDate) || '').trim();
            if (!reportDateRaw) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Report date is required (shown as stock as-of date).'
                });
            }
            const originalName = req.file.originalname || 'stock_upload.xlsx';
            const result = processStockWorkbook(req.file.buffer, originalName, { reportDate: reportDateRaw });
            const baseMeta = {
                uploadedAt: new Date().toISOString(),
                uploadedBy: uploadUser.Username || uploadUser.username || 'user',
                originalName,
                sheetName: result.sheetName,
                stats: result.stats,
                publishedRows: result.published.length,
                reportDate: result.reportDateUsed || reportDateRaw
            };
            writeLocalStockBackup_(result.csv, baseMeta);

            let supabaseMeta = null;
            let supabaseError = null;
            try {
                supabaseMeta = await publishStockToSupabase_(result.published, baseMeta);
                baseMeta.supabaseUploadId = supabaseMeta && supabaseMeta.supabaseUploadId;
                baseMeta.source = 'supabase';
                writeLocalStockBackup_(result.csv, baseMeta);
            } catch (e) {
                supabaseError = e.message;
                console.error('[Stock upload] Supabase publish failed:', e.message);
                baseMeta.source = 'local';
                baseMeta.supabaseError = supabaseError;
                writeLocalStockBackup_(result.csv, baseMeta);
            }

            return res.json({
                status: 'success',
                message: supabaseMeta
                    ? `Published ${baseMeta.publishedRows} stock rows to Supabase.`
                    : `Saved ${baseMeta.publishedRows} rows locally; Supabase failed (${supabaseError}). Run create_mzo_insight_stock_snapshot.sql.`,
                meta: baseMeta,
                supabase: supabaseMeta ? 'ok' : 'failed',
                supabaseError
            });
        } catch (e) {
            console.error('[Stock upload] Error:', e.message);
            return res.status(500).json({ status: 'error', message: e.message });
        }
    });
});

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
        console.log('Open your browser and navigate to http://localhost:3000 to use the estimator.');
        console.log('Navigate to http://localhost:3000/admin.html to manage structures.');
        console.log('NSC upload: http://localhost:3000/nsc/upload.html');
        console.log('Stock upload: http://localhost:3000/stock/upload.html');
    });
}

module.exports = app;
