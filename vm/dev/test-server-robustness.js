#!/usr/bin/env node
'use strict';
// Robustness test of server.js with no network: every non-local request is refused by a preload.
//
//   node vm/dev/test-server-robustness.js
//
// Runs server.js in a child process with the VM user store configured (PocketBase unreachable) and checks
// that requests built to break a handler get an answer and leave the process running:
//   - a malformed or forged mzo_pending cookie on the public /api/auth/pending-status;
//   - a body that is not JSON, and one over the size limit (JSON answers, no HTML error page);
//   - a rejected async handler reaches the JSON error handler instead of ending the process.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 3990 + Math.floor(Math.random() * 9);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-robust-'));
const PRELOAD = path.join(TMP, 'offline.js');
fs.writeFileSync(PRELOAD, `'use strict';
const local = (u) => /^https?:\\/\\/(127\\.0\\.0\\.1|localhost)(:\\d+)?\\//i.test(String(u || ''));
const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
    const u = typeof input === 'string' ? input : (input && input.url) || String(input);
    return local(u) ? real(input, init) : Promise.reject(new Error('offline test: ' + u.replace(/\\?.*$/, '')));
};
`);

let passed = 0;
function ok(cond, label) { assert.ok(cond, label); passed++; console.log('  ok  ' + label); }

function start(extraEnv) {
    const env = Object.assign({}, process.env, {
        PORT: String(PORT), NODE_OPTIONS: `--require ${PRELOAD}`, MZO_FILES_DIR: path.join(TMP, 'files'),
        MZO_USER_STORE: 'pocketbase', PB_URL: 'http://127.0.0.1:9', PB_SUPERUSER_EMAIL: 'x@example.com', PB_SUPERUSER_PASSWORD: 'not-a-real-password',
        JWT_SECRET: 'robustness-test-secret', MZO_DATA_MODE: '', HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: ''
    }, extraEnv || {});
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    child.log = () => log;
    return child;
}

async function waitUp() {
    for (let i = 0; i < 100; i++) {
        try { const r = await fetch(`http://127.0.0.1:${PORT}/login.html`); if (r.ok) return; } catch (_) { /* not yet */ }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not start');
}

const req = (p, init) => fetch(`http://127.0.0.1:${PORT}${p}`, Object.assign({ redirect: 'manual' }, init || {}));
const origin = { Origin: `http://127.0.0.1:${PORT}` };

async function main() {
    const child = start();
    let alive = true;
    child.exited.then(() => { alive = false; });
    try {
        await waitUp();

        // B1: the pending-status cookie is anyone's input.
        for (const cookie of ['mzo_pending=%E0%A4%A', 'mzo_pending=%', 'mzo_pending=YQ.%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9', 'mzo_pending=a.b.c', 'mzo_pending=']) {
            const r = await req('/api/auth/pending-status?email=a@example.com', { headers: { Cookie: cookie } });
            const body = await r.json();
            ok(r.status === 200 && body.status === 'not_found', `pending-status with cookie ${cookie.slice(0, 30)}…: 200 not_found`);
        }
        await new Promise((r) => setTimeout(r, 200));
        ok(alive, 'the app is still running after the malformed cookies');

        // B16: body parser errors answer JSON.
        const bad = await req('/api/auth/local', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, origin), body: '{"username":' });
        ok(bad.status === 400 && /json/.test(bad.headers.get('content-type') || ''), `invalid JSON body: ${bad.status} JSON`);
        const big = await req('/api/auth/local', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, origin), body: JSON.stringify({ x: 'y'.repeat(6 * 1024 * 1024) }) });
        ok(big.status === 413 && /json/.test(big.headers.get('content-type') || ''), `oversized body: ${big.status} JSON`);
        ok(alive, 'the app is still running after the bad bodies');
    } finally {
        child.kill('SIGTERM');
        await child.exited;
    }
    if (/unhandled|URIError|RangeError/.test(child.log())) {
        console.log(child.log());
        throw new Error('the server logged an unhandled error');
    }
    ok(true, 'no unhandled error in the server log');

    await supabasePath();

    // The safety net itself: an async handler that rejects answers 500 at once instead of hanging the
    // request (and, without a rejection handler, ending the process).
    delete process.env.MZO_USER_STORE;
    process.env.MZO_FILES_DIR = path.join(TMP, 'files');
    const app = require(path.join(ROOT, 'server.js'));
    app.get('/__reject_test.css', async () => { throw new Error('boom (expected in this test)'); });
    const server = app.listen(PORT + 20);
    await new Promise((r) => server.once('listening', r));
    try {
        const r = await fetch(`http://127.0.0.1:${PORT + 20}/__reject_test.css`, { signal: AbortSignal.timeout(5000) });
        ok(r.status === 500, `a rejecting async handler answers ${r.status}, not a hang`);
    } finally {
        server.close();
    }
    console.log(`server robustness test: ${passed} checks passed`);
}

/** A session cookie as server.js issues it (HMAC with JWT_SECRET), for the Supabase-path store. */
function sessionCookie(profile, secret) {
    const payload = Buffer.from(JSON.stringify({ profile, expiry: Date.now() + 3600 * 1000 })).toString('base64');
    const sig = require('crypto').createHmac('sha256', secret).update(payload).digest('base64');
    return `mzo_session=${encodeURIComponent(payload + '.' + sig)}`;
}

/** A local "Supabase" that never answers: outbound requests must give up on their own. */
function stallingServer() {
    const http = require('http');
    const sockets = new Set();
    const srv = http.createServer(() => { /* never answer */ });
    srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    srv.stop = () => { sockets.forEach((s) => s.destroy()); srv.close(); };
    return srv;
}

async function supabasePath() {
    const SECRET = 'robustness-test-secret';
    const files = path.join(TMP, 'files');
    fs.mkdirSync(files, { recursive: true });
    fs.writeFileSync(path.join(files, 'disconnection.csv'), 'CCC_CODE,CON_ID\n6611108,100000001\n');
    const stall = stallingServer();
    await new Promise((r) => stall.listen(0, '127.0.0.1', r));
    const child = start({
        MZO_USER_STORE: '', PB_URL: '', SUPABASE_URL: `http://127.0.0.1:${stall.address().port}`, SUPABASE_KEY: 'test-anon-key',
        MZO_OUTBOUND_TIMEOUT_MS: '1500'
    });
    try {
        await waitUp();
        const viewer = { Cookie: sessionCookie({ Username: 'viewer1', Name: 'Viewer', role: 'viewer' }, SECRET) };

        // B3: data files go out with validators and revalidate to 304; a missing one is a 404, not a crash.
        const d1 = await req('/api/disconnection/dataset', { headers: viewer });
        const etag = d1.headers.get('etag');
        ok(d1.status === 200 && (await d1.text()).includes('100000001'), 'disconnection list from the data folder: 200');
        ok(!!etag && !!d1.headers.get('last-modified'), 'data file has an ETag and Last-Modified');
        ok(/text\/csv/.test(d1.headers.get('content-type') || '') && d1.headers.get('cache-control') === 'private, max-age=60', 'data file keeps its type and Cache-Control');
        const d2 = await req('/api/disconnection/dataset', { headers: Object.assign({ 'If-None-Match': etag, 'Cache-Control': 'max-age=0' }, viewer) });
        // (an explicit Cache-Control: undici would otherwise add no-cache, as a forced reload does)
        ok(d2.status === 304, `revalidation with the ETag: ${d2.status}`);
        const miss = await req('/api/unbilled/outsort', { headers: viewer });
        ok(miss.status === 404, `missing unbilled file: ${miss.status}`);
        const anon = await req('/api/disconnection/dataset');
        ok(anon.status === 401, `data file without a session: ${anon.status}`);

        // B2: a stalled upstream gives up after the outbound timeout instead of 5 minutes.
        const t0 = Date.now();
        const pm = await req('/api/power-map/meta', { headers: viewer, signal: AbortSignal.timeout(10000) });
        const took = Date.now() - t0;
        ok(pm.status === 200 && took < 6000, `power map meta with a stalled Supabase answers in ${took} ms`);
        ok(child.exitCode === null, 'the app is still running');
    } finally {
        child.kill('SIGTERM');
        await child.exited;
        stall.stop();
    }
}

main().then(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(0);
}, (err) => {
    console.error('FAIL:', err && err.message);
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
});
