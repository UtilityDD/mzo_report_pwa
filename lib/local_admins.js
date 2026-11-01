'use strict';
// VM-only admin accounts (server only, never loaded in the browser).
//
// MZO_LOCAL_ADMINS, set only in the VM's /etc/mzo/app.env, lists accounts that exist nowhere else:
//   username|Display Name|scrypt$N$r$p$saltB64$hashB64[;username|…]
// The hash comes from scripts/tools/hash-password.js; no password is ever stored. Such a username
// signs in only against its hash (never against Supabase), and its session carries a signed key tied
// to that hash, so removing the entry or changing the password ends existing sessions after a restart.
// Unset (Vercel, local default): nothing here is active and the app behaves as before.

const crypto = require('crypto');

const USERNAME_RE = /^[A-Za-z0-9._-]{2,64}$/;
const MAX_FAILS = 5; // failed attempts per username or client IP …
const LOCK_MS = 60 * 1000; // … lock that username / IP for a minute
const FAIL_WINDOW_MS = 15 * 60 * 1000; // failures older than this are forgotten

/** scrypt$N$r$p$saltB64$hashB64 → parameters, or null when malformed or out of range. */
function parseHash(text) {
    const p = String(text || '').split('$');
    if (p.length !== 6 || p[0] !== 'scrypt') return null;
    const N = Number(p[1]);
    const r = Number(p[2]);
    const par = Number(p[3]);
    if (!Number.isInteger(N) || N < 16384 || N > 1048576 || (N & (N - 1)) !== 0) return null;
    if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(par) || par < 1 || par > 16) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(p[4]) || !/^[A-Za-z0-9+/]+={0,2}$/.test(p[5])) return null;
    const salt = Buffer.from(p[4], 'base64');
    const hash = Buffer.from(p[5], 'base64');
    if (salt.length < 16 || hash.length < 32 || hash.length > 128) return null;
    return { N, r, p: par, salt, hash };
}

/** The scrypt string for a password (used by scripts/tools/hash-password.js). */
function hashPassword(password, { N = 32768, r = 8, p = 1 } = {}) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 32, { N, r, p, maxmem: 256 * N * r * p });
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Client IP for the backoff: behind the local proxy (Caddy) its X-Forwarded-For, else the socket peer. */
function clientIp(req) {
    const peer = String((req.socket && req.socket.remoteAddress) || '');
    const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return loopback && xff.length ? xff[xff.length - 1] : peer || 'unknown';
}

function create(options) {
    const opts = options || {};
    const env = opts.env || process.env;
    const secret = String(opts.secret || '');
    const log = opts.log || console;
    const admins = new Map(); // lowercase username -> { username, name, hashText, params }

    String(env.MZO_LOCAL_ADMINS || '').split(';').forEach((part, i) => {
        const text = part.trim();
        if (!text) return;
        const fields = text.split('|');
        const username = String(fields[0] || '').trim();
        const name = String(fields[1] || '').trim();
        const hashText = String(fields[2] || '').trim();
        const params = parseHash(hashText);
        // Never log the entry itself: it holds the hash.
        if (fields.length !== 3 || !USERNAME_RE.test(username) || !name || !params) {
            log.warn(`[Local admin] entry ${i + 1} of MZO_LOCAL_ADMINS is not username|Display Name|scrypt$N$r$p$salt$hash: skipped`);
            return;
        }
        const key = username.toLowerCase();
        if (admins.has(key)) {
            log.warn(`[Local admin] ${username} is listed twice in MZO_LOCAL_ADMINS: the first entry is used`);
            return;
        }
        admins.set(key, { username, name, hashText, params });
    });
    if (admins.size) log.log(`[Local admin] ${admins.size} VM-only admin account(s): ${[...admins.values()].map((a) => a.username).join(', ')}`);

    /** The local admin with this username (trimmed, case-insensitive), else null. */
    function find(username) {
        return admins.get(String(username || '').trim().toLowerCase()) || null;
    }

    /** True when password matches the admin's hash (scrypt off the main thread, constant-time compare). */
    function verify(admin, password) {
        const { N, r, p, salt, hash } = admin.params;
        return new Promise((resolve) => {
            crypto.scrypt(String(password), salt, hash.length, { N, r, p, maxmem: 256 * N * r * p }, (err, derived) => {
                resolve(!err && derived.length === hash.length && crypto.timingSafeEqual(derived, hash));
            });
        });
    }

    /** Signed key stored in the session: changes when the entry's hash changes. */
    function sessionKey(admin) {
        return crypto.createHmac('sha256', secret)
            .update(`mzo-local-admin\n${admin.username.toLowerCase()}\n${admin.hashText}`)
            .digest('base64url').slice(0, 32);
    }

    /** A session that claims to be a local admin is valid only while its entry exists with the same hash. */
    function sessionValid(session) {
        const admin = session && session.profile ? find(session.profile.Username) : null;
        if (!admin || typeof session.local !== 'string') return false;
        const want = Buffer.from(sessionKey(admin));
        const got = Buffer.from(session.local);
        return want.length === got.length && crypto.timingSafeEqual(want, got);
    }

    // ---- Backoff: MAX_FAILS failures for a username or an IP lock it for LOCK_MS ------------------
    const fails = new Map(); // 'u:<name>' | 'ip:<addr>' -> { n, first, until }
    function sweep(now) {
        if (fails.size < 1000) return;
        for (const [k, v] of fails) if (now - v.first > FAIL_WINDOW_MS && now > v.until) fails.delete(k);
    }
    function locked(keys) {
        const now = Date.now();
        return keys.some((k) => {
            const v = fails.get(k);
            return v && now < v.until;
        });
    }
    function recordFailure(keys) {
        const now = Date.now();
        sweep(now);
        keys.forEach((k) => {
            let v = fails.get(k);
            if (!v || now - v.first > FAIL_WINDOW_MS) v = { n: 0, first: now, until: 0 };
            v.n += 1;
            if (v.n >= MAX_FAILS) {
                v.until = now + LOCK_MS;
                v.n = 0;
                v.first = now;
            }
            fails.set(k, v);
        });
    }
    function recordSuccess(keys) {
        keys.forEach((k) => fails.delete(k));
    }

    /**
     * Check a sign-in for a local admin. Resolves to true or false. While the username or the client IP
     * is locked it resolves false without checking the password, so a lock looks like any wrong PIN.
     */
    async function attempt(admin, password, req) {
        const keys = [`u:${admin.username.toLowerCase()}`, `ip:${clientIp(req)}`];
        if (locked(keys)) {
            log.warn(`[Local admin] sign-in for ${admin.username} refused: too many failed attempts (${clientIp(req)})`);
            return false;
        }
        const ok = await verify(admin, password);
        if (ok) recordSuccess(keys);
        else {
            recordFailure(keys);
            log.warn(`[Local admin] wrong password for ${admin.username} from ${clientIp(req)}`);
        }
        return ok;
    }

    return {
        enabled: admins.size > 0,
        find,
        attempt,
        sessionKey,
        sessionValid,
        isLocalUsername: (username) => !!find(username)
    };
}

module.exports = { create, parseHash, hashPassword, clientIp, MAX_FAILS, LOCK_MS };
