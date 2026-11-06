'use strict';
/* lib/google_auth.js: checks a Google sign-in token on the server (both user stores, Vercel and the VM).
 *
 *   tokenInfo(kind, token, { clientId, fetch })  -> claims, or null when the token does not qualify.
 *                                                   Throws when Google cannot be reached.
 *
 * kind 'id_token' (Sign-In button, One Tap): a JWT checked here, without asking Google per sign-in:
 *   RS256 signature against Google's published keys (https://www.googleapis.com/oauth2/v3/certs, cached
 *   for as long as Google's Cache-Control allows, refetched once for an unknown key id), iss
 *   accounts.google.com, aud equal to GOOGLE_CLIENT_ID, exp in the future (iat not in the future), and a
 *   verified email.
 * kind 'access_token' (the OAuth popup login.html uses): an opaque token only Google can check, so it
 *   goes to Google's tokeninfo endpoint, which rejects forged and expired tokens; we then require that
 *   it was issued to GOOGLE_CLIENT_ID (aud or azp), is unexpired and carries a verified email. Name and
 *   photo come from userinfo with the same token.
 *
 * Claims returned: { email (lowercase), email_verified: true, sub, name, picture, aud, iss, exp }.
 * Server-only (in server.js's PRIVATE_PATH list). No dependencies: node:crypto only.
 */
const crypto = require('crypto');

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CLOCK_SKEW_S = 60;
const TIMEOUT_MS = 8000;

let certs = { keys: new Map(), expiresAt: 0 };
let certsInFlight = null;

function b64urlJson(part) {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function maxAgeMs(cacheControl) {
    const m = /max-age=(\d+)/i.exec(String(cacheControl || ''));
    const s = m ? Number(m[1]) : 0;
    // At least 5 minutes, at most a day, whatever the header says.
    return Math.min(Math.max(s, 300), 86400) * 1000;
}

async function loadCerts(fetchFn, force) {
    if (!force && certs.keys.size && Date.now() < certs.expiresAt) return certs.keys;
    if (certsInFlight) return certsInFlight;
    certsInFlight = (async () => {
        const res = await fetchFn(CERTS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) throw new Error(`Google certs HTTP ${res.status}`);
        const body = await res.json();
        const keys = new Map();
        for (const jwk of (body && body.keys) || []) {
            if (!jwk || jwk.kty !== 'RSA' || !jwk.kid) continue;
            try { keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch (_) { /* skip a bad key */ }
        }
        if (!keys.size) throw new Error('Google certs: no usable keys');
        const cc = res.headers && typeof res.headers.get === 'function' ? res.headers.get('cache-control') : '';
        certs = { keys, expiresAt: Date.now() + maxAgeMs(cc) };
        return keys;
    })();
    try {
        return await certsInFlight;
    } finally {
        certsInFlight = null;
    }
}

function emailVerified(v) {
    return v === true || String(v) === 'true';
}

/** A Google ID token's claims after every check, or null. Throws only when the keys cannot be fetched. */
async function verifyIdToken(token, { clientId, fetch: fetchFn = globalThis.fetch } = {}) {
    if (!clientId) return null;
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
    let header;
    let claims;
    try {
        header = b64urlJson(parts[0]);
        claims = b64urlJson(parts[1]);
    } catch (_) {
        return null;
    }
    if (!header || header.alg !== 'RS256' || !header.kid || !claims || typeof claims !== 'object') return null;
    let keys = await loadCerts(fetchFn, false);
    if (!keys.has(header.kid)) keys = await loadCerts(fetchFn, true); // Google rotated its keys
    const key = keys.get(header.kid);
    if (!key) return null;
    const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'));
    if (!ok) return null;
    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(clientId)) return null;
    if (!ISSUERS.has(claims.iss)) return null;
    if (!(Number(claims.exp) > now)) return null;
    if (claims.iat != null && Number(claims.iat) > now + CLOCK_SKEW_S) return null;
    if (!claims.email || !emailVerified(claims.email_verified)) return null;
    return {
        email: String(claims.email).trim().toLowerCase(),
        email_verified: true,
        sub: String(claims.sub || ''),
        name: String(claims.name || claims.given_name || '').trim(),
        picture: String(claims.picture || ''),
        aud: clientId,
        iss: claims.iss,
        exp: Number(claims.exp)
    };
}

/** A Google OAuth access token checked by Google's tokeninfo, then our audience and email checks; or null. */
async function verifyAccessToken(token, { clientId, fetch: fetchFn = globalThis.fetch } = {}) {
    if (!clientId || !token) return null;
    const res = await fetchFn(`${TOKENINFO_URL}?access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const info = await res.json().catch(() => null);
    if (!info || !info.email) return null;
    if ((info.aud || info.azp) !== clientId) return null;
    if (!(Number(info.exp) * 1000 > Date.now())) return null;
    if (!emailVerified(info.email_verified)) return null;
    const out = {
        email: String(info.email).trim().toLowerCase(),
        email_verified: true,
        sub: String(info.sub || ''),
        name: '',
        picture: '',
        aud: clientId,
        iss: 'tokeninfo',
        exp: Number(info.exp)
    };
    try {
        const u = await fetchFn(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (u.ok) {
            const g = await u.json();
            // userinfo answers for the same account; a different subject means something is wrong.
            if (g && g.sub && out.sub && String(g.sub) !== out.sub) return null;
            out.name = String((g && (g.name || g.given_name)) || '').trim();
            out.picture = String((g && g.picture) || '');
        }
    } catch (_) { /* the profile is optional */ }
    return out;
}

function tokenInfo(kind, token, opts) {
    if (kind === 'id_token') return verifyIdToken(token, opts);
    if (kind === 'access_token') return verifyAccessToken(token, opts);
    return Promise.resolve(null);
}

/** Forget the cached keys (tests). */
function resetCache() {
    certs = { keys: new Map(), expiresAt: 0 };
}

module.exports = { tokenInfo, verifyIdToken, verifyAccessToken, resetCache, CERTS_URL, TOKENINFO_URL, USERINFO_URL };
