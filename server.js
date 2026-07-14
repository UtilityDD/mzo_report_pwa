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

let cachedUsers = null;
let lastCacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache

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

async function getLoginCredentials() {
    const now = Date.now();
    if (cachedUsers && (now - lastCacheTime < CACHE_DURATION)) {
        return cachedUsers;
    }

    try {
        const csvText = await fetchSheet(LOGIN_SHEET_URL);
        
        // Parse CSV text
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
        
        cachedUsers = users;
        lastCacheTime = now;
        console.log(`[Auth] Loaded ${users.length} user credentials from Google Sheets`);
        return users;
    } catch (err) {
        console.error("[Auth] Error loading credentials sheet:", err.message);
        return cachedUsers || []; // Return stale cache if load fails
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

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
        console.log('Open your browser and navigate to http://localhost:3000 to use the estimator.');
        console.log('Navigate to http://localhost:3000/admin.html to manage structures.');
    });
}

module.exports = app;