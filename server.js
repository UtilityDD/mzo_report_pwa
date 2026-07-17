const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const https = require('https');

// Middleware to parse JSON bodies
app.use(express.json());

// --- Authentication Session Storage & Helpers ---
const JWT_SECRET = process.env.JWT_SECRET || 'mzo-portal-super-secret-key-123456';
const LOGIN_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1GtWgPMm-WeDNfebubp5ac76waeZGESA2bQ8JkEpHlZ4/export?format=csv&gid=0';
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

// Supabase Configuration
let SUPABASE_URL = process.env.SUPABASE_URL;
let SUPABASE_KEY = process.env.SUPABASE_KEY;

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

// Zero-dependency Supabase REST Query Helper
async function querySupabase(apiPath, options = {}) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        throw new Error("Supabase credentials not configured. Please verify data/supabase_config.json.");
    }
    const url = `${SUPABASE_URL}/rest/v1/${apiPath}`;
    const headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        ...options.headers
    };
    
    const response = await fetch(url, {
        method: options.method || 'GET',
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

const LOGS_APPS_SCRIPT_URL = process.env.LOGS_APPS_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycby3lVmwORT3j9J2IKjjYebMVzOknRXjo85VmqIQOlBRGGmEi5eFYGMg90HJpFxlz0mM/exec';

async function sendLogToGoogle(entry) {
    if (!LOGS_APPS_SCRIPT_URL) return;
    try {
        if (typeof fetch === 'function') {
            await fetch(LOGS_APPS_SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'log_activity',
                    log: entry
                })
            });
        }
    } catch (err) {
        console.error("[Activity Log] Failed to send log to Google Sheets:", err.message);
    }
}

async function fetchLogsFromGoogle() {
    if (!LOGS_APPS_SCRIPT_URL) return [];
    try {
        if (typeof fetch === 'function') {
            const urlObj = new URL(LOGS_APPS_SCRIPT_URL);
            urlObj.searchParams.set('action', 'get_logs');
            const res = await fetch(urlObj.toString());
            if (res.ok) {
                const data = await res.json();
                return data.data || [];
            }
        }
    } catch (err) {
        console.error("[Activity Log] Failed to fetch logs from Google Sheets:", err.message);
    }
    return [];
}

async function initializeLocalUsers() {
    try {
        console.log(`[Auth] Initializing local users from Google Sheets...`);
        const csvText = await fetchSheet(LOGIN_SHEET_URL);
        const lines = csvText.trim().split('\n');
        if (lines.length < 2) return [];
        
        const headers = lines[0].split(',').map(h => h.trim());
        const users = [];
        
        for (let i = 1; i < lines.length; i++) {
            const values = parseCSVLine(lines[i]);
            if (values.length >= 2) {
                const user = {};
                for (let j = 0; j < headers.length; j++) {
                    user[headers[j]] = values[j] ? values[j].trim() : '';
                }
                users.push(user);
            }
        }
        
        // Cache in memory first to guarantee operation on serverless runtimes
        globalCachedUsers = users;
        
        try {
            const dataDir = path.join(__dirname, 'data');
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
            console.log(`[Auth] Local users file initialized with ${users.length} users.`);
        } catch (writeErr) {
            console.warn("[Auth] Failed to write local users file (read-only filesystem fallback):", writeErr.message);
        }
        return users;
    } catch (err) {
        console.error("[Auth] Failed to initialize local users:", err.message);
        return [];
    }
}

async function getLoginCredentials() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const data = fs.readFileSync(USERS_FILE, 'utf-8');
            const users = JSON.parse(data);
            globalCachedUsers = users;
            return users;
        }
        
        if (globalCachedUsers) {
            return globalCachedUsers;
        }
        
        return await initializeLocalUsers();
    } catch (err) {
        console.error("[Auth] Error reading local users file:", err.message);
        if (globalCachedUsers) return globalCachedUsers;
        return [];
    }
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
        
        globalCachedLogs.unshift(entry);
        if (globalCachedLogs.length > 5000) {
            globalCachedLogs = globalCachedLogs.slice(0, 5000);
        }
        
        // Await push to prevent Vercel serverless function freezing before completion
        await sendLogToGoogle(entry);
        
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
        console.error("[Activity Log] Error saving log:", err.message);
    }
}

// Authentication middleware
async function requireAuth(req, res, next) {
    const pathName = req.path;
    
    // Whitelist static assets, login page, and login API
    if (
        pathName === '/login.html' || 
        pathName === '/api/login' || 
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
    
    // Redirect to login page if unauthenticated
    if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    } else {
        return res.redirect('/login.html');
    }
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

    if (!username || !pin) {
        return res.status(400).json({ status: 'error', message: 'Username and PIN are required.' });
    }

    try {
        const users = await getLoginCredentials();
        
        // Look up user (case-insensitive username)
        const matchedUser = users.find(u => 
            u.Username && u.Username.toLowerCase() === username.trim().toLowerCase() && 
            u.PIN && u.PIN === pin.trim()
        );

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

// API endpoint to verify session status
app.get('/api/session-check', (req, res) => {
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
        
        const users = await getLoginCredentials();
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
            zone_code: '',
            region_code: '',
            division_code: '',
            ccc_code: '',
            ...otherFields
        };
        
        users.push(newUser);
        globalCachedUsers = users;
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
        
        await logActivity({
            username: req.user.Username,
            name: req.user.Name,
            type: 'user_management',
            details: `Created user account: ${Username}`
        });
        
        res.json({ status: 'success', message: 'User created successfully.', user: newUser });
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
        
        const users = await getLoginCredentials();
        const idx = users.findIndex(u => u.Username && u.Username.toLowerCase() === Username.trim().toLowerCase());
        if (idx === -1) {
            return res.status(404).json({ status: 'error', message: 'User not found.' });
        }
        
        users[idx] = {
            ...users[idx],
            ...updatedUser,
            Username: users[idx].Username // Username cannot be changed
        };
        
        globalCachedUsers = users;
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
        
        await logActivity({
            username: req.user.Username,
            name: req.user.Name,
            type: 'user_management',
            details: `Updated user account: ${Username}`
        });
        
        res.json({ status: 'success', message: 'User updated successfully.', user: users[idx] });
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
        
        const users = await getLoginCredentials();
        const filteredUsers = users.filter(u => !u.Username || u.Username.toLowerCase() !== Username.trim().toLowerCase());
        
        if (filteredUsers.length === users.length) {
            return res.status(404).json({ status: 'error', message: 'User not found.' });
        }
        
        globalCachedUsers = filteredUsers;
        fs.writeFileSync(USERS_FILE, JSON.stringify(filteredUsers, null, 2), 'utf-8');
        
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

// 5. GET logs
app.get('/api/admin/logs', requireAdmin, async (req, res) => {
    try {
        if (LOGS_APPS_SCRIPT_URL) {
            const logs = await fetchLogsFromGoogle();
            if (logs && logs.length > 0) {
                globalCachedLogs = logs.map(l => ({
                    timestamp: l.timestamp,
                    username: l.username,
                    name: l.name,
                    type: l.type,
                    details: l.details
                }));
            }
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
        res.json({ status: 'success', logs: globalCachedLogs });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// 6. Force sync from Google Sheet
app.post('/api/admin/sync', requireAdmin, async (req, res) => {
    try {
        await initializeLocalUsers();
        res.json({ status: 'success', message: 'Successfully synced and updated local user database from Google Sheets.' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// 6.45. Expose endpoint to return substations CSV from Supabase
app.get('/api/power-map/data', async (req, res) => {
    try {
        const substations = await querySupabase('substations?select=*');
        
        // Convert to CSV
        if (!substations || substations.length === 0) {
            return res.send('');
        }
        
        // Casing and spacing matching Google Sheet column names exactly (all 22 columns)
        const columns = [
            "Region", "Division", "Substation", "MVA", "LATITUDE", "LONGITUDE", 
            "Connected to", "Colour", "RL", "LineStyle", "Para-1", "Para-2", "Para-3", 
            "Comment", "Symbol", "SymbolSize", "LegendText", "LegendSymbol", 
            "LegendColour", "Remarks", "ConductorSize", "PeakLoad"
        ];
        
        // Filter out empty rows or invalid entries to prevent Leaflet LatLng crashes
        const validSubstations = substations.filter(row => 
            row.Substation && 
            row.Substation.trim().length > 0 && 
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
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=substations.csv');
        return res.send(csvRows.join('\n'));
    } catch (err) {
        console.error("[Power Map Data] Error querying Supabase:", err.message);
        return res.status(500).send("Error fetching substations from database: " + err.message);
    }
});

// 6.5. Edit sheet row (Power Map Admin Edit - Supabase Table version)
app.post('/api/admin/edit-sheet-row', requireAdmin, async (req, res) => {
    try {
        const { rowKeyColumn, rowKeyValue, columnName, newValue, connectionTarget } = req.body;
        
        if (!rowKeyColumn || !rowKeyValue || !columnName) {
            return res.status(400).json({ status: 'error', message: 'Missing required parameters.' });
        }

        let finalValue = newValue;

        // Handle colon-separated connection modifications
        if (connectionTarget) {
            // Fetch the existing record to retrieve its connections arrays
            const records = await querySupabase(`substations?Substation=eq.${encodeURIComponent(rowKeyValue)}&select=*`);
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
        
        await querySupabase(`substations?Substation=eq.${encodeURIComponent(rowKeyValue)}`, {
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
app.post('/api/admin/append-sheet-row', requireAdmin, async (req, res) => {
    try {
        const { rowData } = req.body;
        
        if (!rowData) {
            return res.status(400).json({ status: 'error', message: 'Missing rowData.' });
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
        
        await querySupabase('substations', {
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
app.post('/api/admin/add-connection', requireAdmin, async (req, res) => {
    try {
        const { sourceSubstation, targetSubstation, rl, conductorSize, peakLoad } = req.body;
        
        if (!sourceSubstation || !targetSubstation) {
            return res.status(400).json({ status: 'error', message: 'Missing sourceSubstation or targetSubstation.' });
        }
        
        // Fetch the source record to retrieve its connections arrays
        const records = await querySupabase(`substations?Substation=eq.${encodeURIComponent(sourceSubstation)}&select=*`);
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
        
        await querySupabase(`substations?Substation=eq.${encodeURIComponent(sourceSubstation)}`, {
            method: 'PATCH',
            body: patchBody
        });

        return res.json({ status: 'success', message: 'Connection added successfully.' });
    } catch (err) {
        console.error("[Admin Add Connection] Error adding connection to Supabase:", err.message);
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
        await querySupabase(`substations?Substation=eq.${encodeURIComponent(substation)}`, {
            method: 'DELETE'
        });
        
        // 2. Clean up references in other substations' connections
        const allRecords = await querySupabase('substations?select=*');
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
                    
                    await querySupabase(`substations?Substation=eq.${encodeURIComponent(record.Substation)}`, {
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
        
        const records = await querySupabase(`substations?Substation=eq.${encodeURIComponent(source)}&select=*`);
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
        
        await querySupabase(`substations?Substation=eq.${encodeURIComponent(source)}`, {
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

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
        console.log('Open your browser and navigate to http://localhost:3000 to use the estimator.');
        console.log('Navigate to http://localhost:3000/admin.html to manage structures.');
    });
}

module.exports = app;