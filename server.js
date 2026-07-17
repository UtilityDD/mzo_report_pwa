const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const https = require('https');

// Middleware to parse JSON bodies
app.use(express.json());

// --- Authentication Session Storage & Helpers ---
const sessions = new Map(); // token -> user profile
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

function logActivity(activity) {
    try {
        const entry = {
            timestamp: new Date().toISOString(),
            username: activity.username,
            name: activity.name,
            type: activity.type,
            details: activity.details
        };
        
        let logs = [];
        if (fs.existsSync(LOGS_FILE)) {
            const fileContent = fs.readFileSync(LOGS_FILE, 'utf-8');
            try {
                logs = JSON.parse(fileContent);
            } catch (e) {
                logs = [];
            }
        }
        
        logs.unshift(entry);
        if (logs.length > 5000) {
            logs = logs.slice(0, 5000);
        }
        
        const dataDir = path.dirname(LOGS_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2), 'utf-8');
    } catch (err) {
        console.error("[Activity Log] Error saving log:", err.message);
    }
}

// Authentication middleware
function requireAuth(req, res, next) {
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
    
    if (token && sessions.has(token)) {
        const session = sessions.get(token);
        if (Date.now() < session.expiry) {
            req.user = session.profile;
            
            // Log page visits (intercept requests for HTML pages, excluding APIs and assets)
            const ext = path.extname(pathName).toLowerCase();
            const isHtml = ext === '.html' || pathName === '/' || pathName === '';
            const isAssetOrApi = pathName.startsWith('/api/') || pathName.startsWith('/icons/') || pathName.startsWith('/assets/') || ext === '.css' || ext === '.js' || ext === '.png' || ext === '.json' || ext === '.ico';
            
            if (isHtml && !isAssetOrApi && pathName !== '/login.html' && pathName !== '/admin_users.html') {
                logActivity({
                    username: req.user.Username,
                    name: req.user.Name || 'No Name',
                    type: 'page_visit',
                    details: `Visited page: ${pathName === '/' ? '/index.html' : pathName}`
                });
            }
            
            return next();
        } else {
            sessions.delete(token);
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
            // Generate a secure session token
            const token = require('crypto').randomBytes(16).toString('hex');
            
            // Exclude the PIN from user profile sent to the client
            const { PIN, ...clientProfile } = matchedUser;
            
            // Save session (valid for 24 hours)
            sessions.set(token, {
                profile: clientProfile,
                expiry: Date.now() + 24 * 60 * 60 * 1000
            });
            
            // Set session cookie
            res.setHeader('Set-Cookie', `mzo_session=${token}; Path=/; HttpOnly; Max-Age=${24 * 60 * 60}; SameSite=Lax`);
            console.log(`[Auth] User logged in: ${matchedUser.Username} (${matchedUser.Name || 'No Name'})`);
            
            // Log login event
            logActivity({
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
    const cookieHeader = req.headers.cookie || '';
    const cookies = parseCookies(cookieHeader);
    const token = cookies.mzo_session;
    
    if (token) {
        sessions.delete(token);
    }
    
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
        
        logActivity({
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
        
        logActivity({
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
        
        logActivity({
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
app.get('/api/admin/logs', requireAdmin, (req, res) => {
    try {
        let logs = [];
        if (fs.existsSync(LOGS_FILE)) {
            logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf-8'));
        }
        res.json({ status: 'success', logs });
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