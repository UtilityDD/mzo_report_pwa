#!/usr/bin/env node
'use strict';
// Test of the VM user store (MZO_USER_STORE=pocketbase, lib/users_store.js) against a throwaway local
// PocketBase. Nothing leaves this machine: Google is answered by a stand-in fetch (its signing keys are a
// test RSA key made here, its tokeninfo a fixture), and any other upstream request fails the test.
//
//   node vm/dev/test-users-store.js
//   PB_BIN=/path/to/pocketbase TEST_PB_PORT=8191 node vm/dev/test-users-store.js
//
// It starts PocketBase (vm/pocketbase/local/pocketbase, v0.40.6) on 127.0.0.1:8191 with a temporary data
// folder and this repo's migrations, runs server.js in this process with the store on, and checks:
// the migrations apply (collections, fields, null API rules, unique email); admin seeding is idempotent
// and restores a built-in admin; Google ID tokens are checked (signature, aud, iss, exp, verified email)
// and access tokens through tokeninfo; an unknown Google user becomes pending and sees only its own
// pending status; approval needs a valid office scope, then the user signs in with the legacy profile
// the pages read (mzo_scope.js resolves it to the right CCC); modules hide and refuse other reports;
// a role change and a disable end open sessions; rejected and disabled users cannot sign in; the audit
// trail and the activity log (logins, page visits, admin changes) are written and pruned; the VM-only
// admin still works; and without the flag the store is off.

const fs = require('fs');
const os = require('os');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PB_BIN = process.env.PB_BIN || path.join(ROOT, 'vm', 'pocketbase', 'local', 'pocketbase');
const PB_PORT = Number(process.env.TEST_PB_PORT || 8191);
const PB_URL = `http://127.0.0.1:${PB_PORT}`;
const SU_EMAIL = 'test-superuser@mzo.local';
const SU_PASS = 'test-superuser-password-1234';
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const SECRET = 'test-secret-for-users-store';
const LOCAL_PW = 'break glass password';

const results = [];
function check(name, fn) {
    try {
        fn();
        results.push(['ok', name]);
    } catch (err) {
        results.push(['FAIL', name, err.message]);
    }
}

// ---- Google stand-in ---------------------------------------------------------------------------------
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const rogue = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-kid-1';
const JWKS = { keys: [Object.assign(google.publicKey.export({ format: 'jwk' }), { kid: KID, alg: 'RS256', use: 'sig' })] };

function idToken(claims, { key = google.privateKey, kid = KID, alg = 'RS256' } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(Object.assign({
        iss: 'https://accounts.google.com', aud: CLIENT_ID, iat: now, exp: now + 3600, email_verified: true
    }, claims))).toString('base64url');
    const sig = alg === 'none' ? '' : crypto.sign('RSA-SHA256', Buffer.from(header + '.' + body), key).toString('base64url');
    return `${header}.${body}.${sig || 'x'}`;
}

// Access tokens the stand-in tokeninfo knows.
const ACCESS = {
    'good-access': { aud: CLIENT_ID, email: 'popup.user@example.com', email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 3600), sub: '900000000000000000001' },
    'other-app-access': { aud: 'someone-else.apps.googleusercontent.com', email: 'popup.user@example.com', email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 3600), sub: '900000000000000000001' }
};

const upstream = [];
const realFetch = global.fetch;
global.fetch = async (input, opts) => {
    const url = String(input && input.url ? input.url : input);
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    if (/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return realFetch(input, opts);
    upstream.push({ method, url: url.replace(/\?.*$/, '') });
    const json = (v, status = 200, headers = {}) => new Response(JSON.stringify(v), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, headers) });
    if (method !== 'GET' && method !== 'HEAD') return new Response('{"message":"write refused by the test"}', { status: 599 });
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return json(JWKS, 200, { 'Cache-Control': 'public, max-age=19000' });
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo?access_token=')) {
        const info = ACCESS[decodeURIComponent(url.split('=')[1])];
        return info ? json(info) : json({ error: 'invalid_token' }, 400);
    }
    if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
        const auth = String((opts && opts.headers && opts.headers.Authorization) || '');
        const info = ACCESS[auth.replace(/^Bearer /, '')];
        return info ? json({ sub: info.sub, name: 'Popup User', picture: 'https://example.com/p.png' }) : json({}, 401);
    }
    return new Response('{"message":"unknown to the test"}', { status: 599 });
};

// ---- PocketBase --------------------------------------------------------------------------------------
async function startPocketBase(dir) {
    // A copy of the repo's migrations next to the throwaway data folder: nothing can be written into the repo.
    const mig = path.join(path.dirname(dir), 'pb_migrations');
    fs.cpSync(path.join(ROOT, 'vm', 'pocketbase', 'pb_migrations'), mig, { recursive: true });
    const up = spawnSync(PB_BIN, ['superuser', 'upsert', SU_EMAIL, SU_PASS, `--dir=${dir}`, `--migrationsDir=${mig}`, '--automigrate=false'], { encoding: 'utf8' });
    if (up.status !== 0) throw new Error('superuser upsert failed: ' + up.stderr + up.stdout);
    const proc = spawn(PB_BIN, ['serve', `--http=127.0.0.1:${PB_PORT}`, `--dir=${dir}`, `--migrationsDir=${mig}`, '--automigrate=false'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    for (let i = 0; i < 100; i++) {
        try {
            const r = await realFetch(`${PB_URL}/api/health`);
            if (r.ok) return proc;
        } catch (_) { /* not up yet */ }
        if (proc.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    proc.kill();
    throw new Error(`PocketBase did not start on ${PB_URL} (is the port free?):\n${out}`);
}

async function pbAdmin() {
    const r = await realFetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: SU_EMAIL, password: SU_PASS })
    });
    const { token } = await r.json();
    return async (method, p, body) => {
        const res = await realFetch(PB_URL + p, { method, headers: { Authorization: token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
}

// ---- Supabase mode (Vercel, no flag): same verification, users from portal_users ---------------------
const OLD = 'https://unsmtschmcvftfqwabaq.supabase.co/rest/v1/';
async function supabaseChild(out) {
    const portal = [{ username: 'sbuser', name: 'Supabase User', role: 'viewer', user_status: 'active', email: 'sb.user@example.com', ccc_code: 'Samsi', division_code: 'Chanchal', region_code: 'Malda' }];
    const inner = global.fetch;
    global.fetch = async (input, opts) => {
        const url = String(input && input.url ? input.url : input);
        const method = String((opts && opts.method) || 'GET').toUpperCase();
        if (method === 'GET' && url.startsWith(OLD + 'portal_users?')) return new Response(JSON.stringify(portal), { status: 200, headers: { 'Content-Type': 'application/json' } });
        return inner(input, opts);
    };
    Object.assign(process.env, { GOOGLE_CLIENT_ID: CLIENT_ID, JWT_SECRET: SECRET });
    for (const k of ['MZO_USER_STORE', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'MZO_LOCAL_ADMINS', 'MZO_DATA_MODE', 'VERCEL']) delete process.env[k];
    sandboxDataWrites(fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-users-sb-')));
    const app = require(path.join(ROOT, 'server.js'));
    const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const post = async (credential) => {
        const r = await realFetch(base + '/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ credential }) });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const res = {
        good: await post(idToken({ email: 'SB.User@example.com', sub: '5', name: 'SB' })),
        rogue: await post(idToken({ email: 'sb.user@example.com', sub: '5' }, { key: rogue.privateKey })),
        aud: await post(idToken({ email: 'sb.user@example.com', sub: '5', aud: 'other' })),
        upstream: upstream.map((u) => `${u.method} ${u.url}`)
    };
    srv.close();
    fs.writeFileSync(out, JSON.stringify(res));
    process.exit(0);
}

// ---- Main --------------------------------------------------------------------------------------------
async function main() {
    if (process.argv[2] === '--supabase-child') return supabaseChild(process.argv[3]);
    if (!fs.existsSync(PB_BIN)) {
        console.error(`No PocketBase binary at ${PB_BIN}. Copy v0.40.6 there (git-ignored) or set PB_BIN.`);
        process.exit(2);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-users-test-'));
    const pbProc = await startPocketBase(path.join(tmp, 'pb_data'));
    let srv;
    try {
        srv = await run(tmp);
    } finally {
        if (srv) srv.close();
        pbProc.kill();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    const failed = results.filter((r) => r[0] !== 'ok');
    for (const r of results) console.log(r[0] === 'ok' ? `  ok    ${r[1]}` : `  FAIL  ${r[1]}\n        ${r[2]}`);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
}

async function run(tmp) {
    const pb = await pbAdmin();

    // 1. Migrations
    const cols = {};
    for (const c of ['app_users', 'app_activity', 'app_user_audit']) cols[c] = (await pb('GET', `/api/collections/${c}`)).body;
    check('migrations: the three collections exist as base collections', () => {
        for (const c of Object.keys(cols)) assert.strictEqual(cols[c] && cols[c].type, 'base', c);
    });
    check('migrations: every API rule is null (superuser only)', () => {
        for (const c of Object.values(cols)) for (const r of ['listRule', 'viewRule', 'createRule', 'updateRule', 'deleteRule']) assert.strictEqual(c[r], null, `${c.name}.${r}`);
    });
    check('migrations: app_users has the identity, access, scope, module, revocation and tracking fields', () => {
        const names = cols.app_users.fields.map((f) => f.name);
        for (const f of ['email', 'google_sub', 'name', 'photo_url', 'phone', 'designation', 'employee_id', 'role', 'status', 'scope_level', 'region', 'division',
            'ccc_code', 'modules', 'feature_flags', 'session_version', 'requested_at', 'approved_by', 'approved_at', 'disabled_reason', 'last_login_at', 'last_seen_at',
            'login_count', 'notes', 'created', 'updated']) assert.ok(names.includes(f), f);
        assert.deepStrictEqual(cols.app_users.fields.find((f) => f.name === 'role').values, ['admin', 'editor', 'viewer']);
        assert.deepStrictEqual(cols.app_users.fields.find((f) => f.name === 'status').values, ['pending', 'active', 'disabled', 'rejected']);
        assert.ok(cols.app_users.indexes.some((i) => /UNIQUE INDEX `idx_app_users_email`.*COLLATE NOCASE/.test(i)));
    });
    const up1 = await pb('POST', '/api/collections/app_users/records', { email: 'dup@example.com', username: 'dup1', role: 'viewer', status: 'pending' });
    const up2 = await pb('POST', '/api/collections/app_users/records', { email: 'DUP@example.com', username: 'dup2', role: 'viewer', status: 'pending' });
    const up3 = await pb('POST', '/api/collections/app_users/records', { email: 'dup@example.com', username: 'dup3', role: 'viewer', status: 'pending' });
    check('migrations: email must be lowercase and is unique', () => {
        assert.strictEqual(up1.status, 200);
        assert.strictEqual(up2.status, 400);
        assert.strictEqual(up3.status, 400);
    });
    await pb('DELETE', `/api/collections/app_users/records/${up1.body.id}`);

    // 2. The app, in this process, with the store on
    Object.assign(process.env, {
        MZO_USER_STORE: 'pocketbase', PB_URL, PB_SUPERUSER_EMAIL: SU_EMAIL, PB_SUPERUSER_PASSWORD: SU_PASS,
        GOOGLE_CLIENT_ID: CLIENT_ID, JWT_SECRET: SECRET, TZ: 'UTC',
        MZO_LOCAL_ADMINS: `breakglass|Break Glass|${require(path.join(ROOT, 'lib', 'local_admins.js')).hashPassword(LOCAL_PW, { N: 16384 })}`
    });
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'MZO_ADMIN_EMAILS', 'MZO_DATA_MODE', 'VERCEL']) delete process.env[k];
    sandboxDataWrites(tmp);
    const app = require(path.join(ROOT, 'server.js'));
    const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const host = `127.0.0.1:${srv.address().port}`;

    const call = async (method, p, { body, cookie, referer } = {}) => {
        const headers = { Accept: 'application/json', 'User-Agent': 'users-store-test' };
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.Origin = base; // API writes come from the app's own pages
        if (body) headers['Content-Type'] = 'application/json';
        if (cookie) headers.Cookie = cookie;
        if (referer) headers.Referer = referer;
        const res = await realFetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* html or text */ }
        const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
        const jar = cookies.map((c) => c.split(';')[0]).filter((c) => !/^[^=]+=$/.test(c));
        return { status: res.status, json, text, jar, session: jar.find((c) => c.startsWith('mzo_session=')) || '', pending: jar.find((c) => c.startsWith('mzo_pending=')) || '' };
    };
    const google = (claims, opts) => call('POST', '/api/auth/google', { body: { credential: idToken(claims, opts) } });
    const users = async (filter) => (await pb('GET', `/api/collections/app_users/records?perPage=200${filter ? '&filter=' + encodeURIComponent(filter) : ''}`)).body.items;
    const one = async (email) => (await users(`email = "${email}"`))[0];
    const audits = async (email) => (await pb('GET', `/api/collections/app_user_audit/records?perPage=200&sort=created&filter=${encodeURIComponent(`user_email = "${email}"`)}`)).body.items;

    // 3. Seeding
    let seeded;
    for (let i = 0; i < 50 && !seeded; i++) {
        const list = await users();
        if (list.some((u) => u.email === 'dipnkr.das@gmail.com') && list.some((u) => u.email === 'smartlinemanapp@gmail.com')) seeded = list;
        else await new Promise((r) => setTimeout(r, 100));
    }
    check('seed: dipnkr.das@gmail.com and the root admin are active admins with zone scope', () => {
        assert.ok(seeded, 'seed did not run');
        for (const e of ['dipnkr.das@gmail.com', 'smartlinemanapp@gmail.com']) {
            const u = seeded.find((x) => x.email === e);
            assert.strictEqual(u.role, 'admin');
            assert.strictEqual(u.status, 'active');
            assert.strictEqual(u.scope_level, 'zone');
        }
    });
    const storeLib = require(path.join(ROOT, 'lib', 'users_store.js'));
    const quiet = { log() {}, warn() {}, error() {} };
    const second = storeLib.create({ env: process.env, secret: SECRET, appRoot: ROOT, log: quiet });
    const beforeUsers = (await users()).length;
    const beforeAudit = (await pb('GET', '/api/collections/app_user_audit/records?perPage=1')).body.totalItems;
    await second.init(['smartlinemanapp@gmail.com']);
    await second.init(['smartlinemanapp@gmail.com']);
    const afterUsers = (await users()).length;
    const afterAudit = (await pb('GET', '/api/collections/app_user_audit/records?perPage=1')).body.totalItems;
    check('seed: idempotent (no new users, no new audit rows on re-run)', () => {
        assert.strictEqual(afterUsers, beforeUsers);
        assert.strictEqual(afterAudit, beforeAudit);
    });
    const dip = await one('dipnkr.das@gmail.com');
    await pb('PATCH', `/api/collections/app_users/records/${dip.id}`, { role: 'viewer', status: 'disabled' });
    await second.init(['smartlinemanapp@gmail.com']);
    const dip2 = await one('dipnkr.das@gmail.com');
    check('seed: a built-in admin changed in the dashboard is restored', () => {
        assert.strictEqual(dip2.role, 'admin');
        assert.strictEqual(dip2.status, 'active');
    });
    check('seed: MZO_ADMIN_EMAILS replaces the default list; root admins are always added', () => {
        const s = storeLib.create({ env: { MZO_USER_STORE: 'pocketbase', MZO_ADMIN_EMAILS: 'A.Boss@Example.com, b@example.com' }, log: quiet });
        assert.deepStrictEqual(s.seedAdmins(), ['a.boss@example.com', 'b@example.com']);
        assert.deepStrictEqual(storeLib.create({ env: { MZO_USER_STORE: 'pocketbase' }, log: quiet }).seedAdmins(), ['dipnkr.das@gmail.com']);
    });

    // 4. Google verification
    const bad = {
        wrongAud: await google({ email: 'x@example.com', sub: '1', aud: 'other-client' }),
        wrongIss: await google({ email: 'x@example.com', sub: '1', iss: 'https://evil.example.com' }),
        expired: await google({ email: 'x@example.com', sub: '1', exp: Math.floor(Date.now() / 1000) - 10 }),
        unverified: await google({ email: 'x@example.com', sub: '1', email_verified: false }),
        rogueKey: await google({ email: 'x@example.com', sub: '1' }, { key: rogue.privateKey }),
        unknownKid: await google({ email: 'x@example.com', sub: '1' }, { kid: 'no-such-kid' }),
        algNone: await google({ email: 'x@example.com', sub: '1' }, { alg: 'none' }),
        otherAppAccess: await call('POST', '/api/auth/google', { body: { accessToken: 'other-app-access' } }),
        junkAccess: await call('POST', '/api/auth/google', { body: { accessToken: 'junk' } })
    };
    check('google: tokens with a wrong aud, iss, expiry, unverified email, foreign key, unknown kid or alg none are refused (401)', () => {
        for (const [k, r] of Object.entries(bad)) assert.strictEqual(r.status, 401, `${k}: ${r.status} ${r.text}`);
    });
    const xUser = await one('x@example.com');
    check('google: no account was created for the refused tokens', () => assert.strictEqual(xUser, undefined));
    const ga = require(path.join(ROOT, 'lib', 'google_auth.js'));
    const okClaims = await ga.verifyIdToken(idToken({ email: 'Mixed.Case@Example.com', sub: '42', name: 'M C' }), { clientId: CLIENT_ID });
    const noClaims = await ga.verifyIdToken(idToken({ email: 'a@example.com', sub: '42' }), { clientId: 'another' });
    check('google: verifyIdToken returns lowercase email and claims, null for another audience', () => {
        assert.strictEqual(okClaims.email, 'mixed.case@example.com');
        assert.strictEqual(okClaims.sub, '42');
        assert.strictEqual(noClaims, null);
    });

    // 5. Unknown user -> pending
    const reg = await google({ email: 'New.Officer@example.com', sub: '111111111111111111111', name: 'New Officer', picture: 'https://example.com/n.png' });
    const pendingRec = await one('new.officer@example.com');
    check('register: an unknown Google user gets status pending, no session, a pending ticket', () => {
        assert.strictEqual(reg.status, 200, reg.text);
        assert.strictEqual(reg.json.status, 'pending');
        assert.strictEqual(reg.json.email, 'new.officer@example.com');
        assert.strictEqual(reg.session, '');
        assert.ok(reg.pending, 'no mzo_pending cookie');
        assert.strictEqual(pendingRec.status, 'pending');
        assert.strictEqual(pendingRec.role, 'viewer');
        assert.strictEqual(pendingRec.google_sub, '111111111111111111111');
        assert.strictEqual(pendingRec.username, 'new.officer');
    });
    const reg2 = await google({ email: 'new.officer@example.com', sub: '111111111111111111111' });
    const ps0 = await call('GET', '/api/auth/pending-status?email=new.officer@example.com');
    const ps1 = await call('GET', '/api/auth/pending-status?email=new.officer@example.com', { cookie: reg.pending });
    const ps2 = await call('GET', '/api/auth/pending-status?email=dipnkr.das@gmail.com', { cookie: reg.pending });
    check('register: signing in again while pending stays pending; pending-status answers only the registering browser', () => {
        assert.strictEqual(reg2.json.status, 'pending');
        assert.strictEqual(ps0.json.status, 'not_found');
        assert.strictEqual(ps1.json.user_status, 'pending');
        assert.strictEqual(ps2.json.status, 'not_found');
    });

    // 6. Admin signs in
    const adm = await google({ email: 'dipnkr.das@gmail.com', sub: '222222222222222222222', name: 'Dipankar Das' });
    check('admin: the seeded admin signs in with Google; profile carries email, role and isAdmin', () => {
        assert.strictEqual(adm.status, 200, adm.text);
        assert.strictEqual(adm.json.status, 'success');
        assert.ok(adm.session);
        const p = adm.json.profile;
        assert.strictEqual(p.email, 'dipnkr.das@gmail.com');
        assert.strictEqual(p.role, 'admin');
        assert.strictEqual(p.isAdmin, true);
        assert.strictEqual(p['nsc-upload-autho'], 'Y');
        assert.strictEqual(p.modules, null);
    });
    const A = adm.session;
    const list = await call('GET', '/api/admin/users', { cookie: A });
    check('admin: /api/admin/users lists the users with the store, module catalogue and built-in admins', () => {
        assert.strictEqual(list.status, 200, list.text);
        assert.strictEqual(list.json.store, 'pocketbase');
        assert.ok(list.json.users.some((u) => u.email === 'new.officer@example.com' && u.user_status === 'pending'));
        assert.ok(list.json.modules.length > 40 && list.json.modules.some((m) => m.key === 'nsc'));
        assert.ok(list.json.builtInAdmins.includes('dipnkr.das@gmail.com'));
        assert.ok(!list.text.includes('google_sub'), 'google_sub must not be sent');
    });
    const nonAdminList = await call('GET', '/api/admin/users', { cookie: reg.pending });
    check('admin: /api/admin/users needs an admin session', () => assert.strictEqual(nonAdminList.status, 401));

    // 7. Approval and scope validation
    const U = 'new.officer';
    const quick = await call('POST', '/api/admin/users/approve', { cookie: A, body: { username: U, user_status: 'active' } });
    const wrongDiv = await call('POST', '/api/admin/users/approve', { cookie: A, body: { username: U, role: 'user', office_level: 'CCC', region_code: 'Malda', division_code: 'Chanchal', ccc_code: 'Kaliachak' } });
    const wrongRegion = await call('POST', '/api/admin/users/approve', { cookie: A, body: { username: U, role: 'user', office_level: 'DE', region_code: 'Raiganj', division_code: 'Chanchal', ccc_code: '' } });
    const unknown = await call('POST', '/api/admin/users/approve', { cookie: A, body: { username: U, role: 'user', scope_level: 'ccc', ccc_code: '6699999' } });
    const tier = await call('POST', '/api/admin/users/approve', { cookie: A, body: { username: U, role: 'user', office_level: 'CCC', region_code: 'Malda', division_code: 'Chanchal', ccc_code: '' } });
    const stillPending = await one('new.officer@example.com');
    check('scope: approval without an office, with a CCC outside its division, a division outside its region, an unknown code or a tier mismatch is refused', () => {
        for (const r of [quick, wrongDiv, wrongRegion, unknown, tier]) assert.strictEqual(r.status, 400, r.text);
        assert.match(quick.json.message, /office/i);
        assert.match(wrongDiv.json.message, /Kaliachak CCC is in Malda division/);
        assert.match(wrongRegion.json.message, /Chanchal division is in Malda region/);
        assert.strictEqual(stillPending.status, 'pending');
    });
    check('scope: validateScope normalises names and codes', () => {
        assert.deepStrictEqual(storeLib.validateScope('ccc', '', '', 'samsi ccc'), { scope_level: 'ccc', region: 'Malda', division: 'Chanchal', ccc_code: '6612102' });
        assert.deepStrictEqual(storeLib.validateScope('ccc', '', '', '6611108'), { scope_level: 'ccc', region: 'Malda', division: 'Malda', ccc_code: '6611108' });
        assert.deepStrictEqual(storeLib.validateScope('division', '', 'Raigunj', ''), { scope_level: 'division', region: 'Uttar Dinajpur', division: 'Raiganj', ccc_code: '' });
        assert.deepStrictEqual(storeLib.validateScope('region', 'dakshin dinajpur', '', ''), { scope_level: 'region', region: 'Dakshin Dinajpur', division: '', ccc_code: '' });
        // Old region names are accepted and saved under the current name; the division keeps its name.
        assert.deepStrictEqual(storeLib.validateScope('region', 'Balurghat Region', '', ''), { scope_level: 'region', region: 'Dakshin Dinajpur', division: '', ccc_code: '' });
        assert.deepStrictEqual(storeLib.validateScope('division', 'Raiganj', 'Raiganj', ''), { scope_level: 'division', region: 'Uttar Dinajpur', division: 'Raiganj', ccc_code: '' });
        assert.deepStrictEqual(storeLib.validateScope('zone', '', '', ''), { scope_level: 'zone', region: '', division: '', ccc_code: '' });
        assert.throws(() => storeLib.validateScope('zone', 'Malda', '', ''), /zone scope takes no/);
        assert.throws(() => storeLib.validateScope('region', 'Atlantis', '', ''), /Unknown region/);
        assert.throws(() => storeLib.validateScope('planet', '', '', ''), /zone, region, division or ccc/);
    });
    const approve = await call('POST', '/api/admin/users/approve', {
        cookie: A, body: { username: U, role: 'user', office_level: 'CCC', region_code: 'Malda', division_code: 'Chanchal', ccc_code: 'Samsi', sheets_autho: '', can_comment: true, upload_permissions: ['nsc', 'stock'] }
    });
    const approved = await one('new.officer@example.com');
    check('approve: a valid CCC approval activates the account with the scope and grants', () => {
        assert.strictEqual(approve.status, 200, approve.text);
        assert.strictEqual(approved.status, 'active');
        assert.strictEqual(approved.role, 'viewer');
        assert.deepStrictEqual([approved.scope_level, approved.region, approved.division, approved.ccc_code], ['ccc', 'Malda', 'Chanchal', '6612102']);
        assert.strictEqual(approved.feature_flags.nsc_upload_autho, 'Y');
        assert.strictEqual(approved.feature_flags.stock_upload_autho, 'Y');
        assert.strictEqual(approved.feature_flags.defective_upload_autho, '');
        assert.strictEqual(approved.approved_by, 'dipnkr.das@gmail.com');
        assert.ok(approved.approved_at);
    });
    const ps3 = await call('GET', '/api/auth/pending-status?email=new.officer@example.com', { cookie: reg.pending });
    check('approve: the pending screen now sees active', () => assert.strictEqual(ps3.json.user_status, 'active'));

    // 8. The approved user signs in: legacy profile
    const usr = await google({ email: 'new.officer@example.com', sub: '111111111111111111111' });
    const p = usr.json && usr.json.profile;
    check('login: the approved user signs in', () => {
        assert.strictEqual(usr.status, 200, usr.text);
        assert.strictEqual(usr.json.status, 'success');
        assert.ok(usr.session);
    });
    check('profile: legacy fields the pages read (Username, Name, role, office names, office_level, kebab flags, upload_permissions)', () => {
        assert.strictEqual(p.Username, 'new.officer');
        assert.strictEqual(p.Name, 'New Officer');
        assert.strictEqual(p.role, 'viewer');
        assert.strictEqual(p.isAdmin, false);
        assert.strictEqual(p.email, 'new.officer@example.com');
        assert.strictEqual(p.user_status, 'active');
        assert.strictEqual(p.zone_code, 'MZO');
        assert.strictEqual(p.region_code, 'Malda');
        assert.strictEqual(p.division_code, 'Chanchal');
        assert.strictEqual(p.ccc_code, 'Samsi');
        assert.strictEqual(p.scope_ccc_code, '6612102');
        assert.strictEqual(p.office_level, 'CCC');
        assert.strictEqual(p['nsc-upload-autho'], 'Y');
        assert.strictEqual(p['stock-allot-autho'], '');
        assert.deepStrictEqual(p.upload_permissions, ['nsc', 'stock']);
        assert.strictEqual(p.can_comment, true);
        assert.strictEqual(p.modules, null);
        assert.ok(!('PIN' in p));
    });
    check('profile: mzo_scope.js resolves it to Samsi CCC only', () => {
        const scope = scopeFor(p);
        assert.strictEqual(scope.level, 'ccc');
        assert.strictEqual(scope.unscoped, false);
        assert.deepStrictEqual([...scope.cccs], ['Samsi']);
    });
    const S = usr.session;
    const sc = await call('GET', '/api/session-check', { cookie: S, referer: `http://${host}/nsc.html` });
    const sc2 = await call('GET', '/api/session-check', { cookie: S, referer: `http://${host}/nsc.html` });
    await call('GET', '/api/session-check', { cookie: S, referer: 'https://elsewhere.example.com/loss.html' });
    const nscMeta = await call('GET', '/api/nsc/meta', { cookie: S });
    check('session: session-check returns the current profile', () => {
        assert.strictEqual(sc.status, 200);
        assert.strictEqual(sc.json.profile.email, 'new.officer@example.com');
        assert.strictEqual(sc2.status, 200);
    });
    check('session: server permission checks read the profile (NSC canUpload from the flag)', () => {
        assert.strictEqual(nscMeta.status, 200, nscMeta.text.slice(0, 200));
        assert.strictEqual(nscMeta.json.canUpload, true);
    });

    // 9. Modules
    const mod = await call('POST', '/api/admin/users/update', { cookie: A, body: { Username: U, modules: ['nsc', 'loss'] } });
    const modBad = await call('POST', '/api/admin/users/update', { cookie: A, body: { Username: U, modules: ['nsc', 'no_such_report'] } });
    const pageOk = await call('GET', '/nsc.html', { cookie: S });
    const pageNo = await call('GET', '/collection.html', { cookie: S });
    const pageFree = await call('GET', '/executive_briefing.html', { cookie: S });
    const pageAdmin = await call('GET', '/collection.html', { cookie: A });
    const scMods = await call('GET', '/api/session-check', { cookie: S });
    check('modules: a modules list keeps the session, refuses other report pages, leaves non-report pages and admins alone', () => {
        assert.strictEqual(mod.status, 200, mod.text);
        assert.strictEqual(modBad.status, 400);
        assert.strictEqual(scMods.status, 200);
        assert.deepStrictEqual(scMods.json.profile.modules, ['nsc', 'loss']);
        assert.strictEqual(pageOk.status, 200);
        assert.strictEqual(pageNo.status, 403);
        assert.strictEqual(pageFree.status, 200);
        assert.strictEqual(pageAdmin.status, 200);
    });
    await call('POST', '/api/admin/users/update', { cookie: A, body: { Username: U, modules: null } });

    // 10. Role change and disable revoke sessions
    const roleChange = await call('POST', '/api/admin/users/update', { cookie: A, body: { Username: U, role: 'editor' } });
    const afterRole = await call('GET', '/api/session-check', { cookie: S });
    const again = await google({ email: 'new.officer@example.com', sub: '111111111111111111111' });
    check('revoke: a role change ends the old session; signing in again gives the new role', () => {
        assert.strictEqual(roleChange.status, 200, roleChange.text);
        assert.strictEqual(afterRole.status, 401);
        assert.strictEqual(again.json.profile.role, 'editor');
    });
    const S2 = again.session;
    const scopeChange = await call('POST', '/api/admin/users/update', { cookie: A, body: { Username: U, region_code: 'Malda', division_code: 'Chanchal', ccc_code: '' } });
    const afterScope = await call('GET', '/api/session-check', { cookie: S2 });
    const S3 = (await google({ email: 'new.officer@example.com', sub: '111111111111111111111' })).session;
    const disable = await call('POST', '/api/admin/users/update', { cookie: A, body: { Username: U, user_status: 'suspended', disabled_reason: 'left the office' } });
    const afterDisable = await call('GET', '/api/session-check', { cookie: S3 });
    const disabledLogin = await google({ email: 'new.officer@example.com', sub: '111111111111111111111' });
    const disabledRec = await one('new.officer@example.com');
    check('revoke: a scope change ends the session too', () => {
        assert.strictEqual(scopeChange.status, 200, scopeChange.text);
        assert.strictEqual(afterScope.status, 401);
    });
    check('disable: ends the open session at once and refuses sign-in (403 suspended)', () => {
        assert.strictEqual(disable.status, 200, disable.text);
        assert.strictEqual(afterDisable.status, 401);
        assert.strictEqual(disabledLogin.status, 403);
        assert.strictEqual(disabledLogin.json.status, 'suspended');
        assert.strictEqual(disabledLogin.session, '');
        assert.strictEqual(disabledRec.status, 'disabled');
        assert.strictEqual(disabledRec.disabled_reason, 'left the office');
    });
    const enable = await call('POST', '/api/admin/users/update', { cookie: A, body: { Username: U, user_status: 'active' } });
    const enabledLogin = await google({ email: 'new.officer@example.com', sub: '111111111111111111111' });
    check('disable: re-enabling lets the user sign in again', () => {
        assert.strictEqual(enable.status, 200, enable.text);
        assert.strictEqual(enabledLogin.json.status, 'success');
    });
    const otherSub = await google({ email: 'new.officer@example.com', sub: '999999999999999999999' });
    check('google: a different Google account for a linked email is refused', () => assert.strictEqual(otherSub.status, 403));

    // 11. Admin guard rails
    const selfDemote = await call('POST', '/api/admin/users/update', { cookie: A, body: { Username: 'dipnkr.das', role: 'viewer' } });
    const rootDisable = await call('POST', '/api/admin/users/update', { cookie: A, body: { Username: 'smartlinemanapp', user_status: 'suspended' } });
    const rootDelete = await call('POST', '/api/admin/users/delete', { cookie: A, body: { Username: 'smartlinemanapp' } });
    check('guard: built-in admins cannot be demoted, disabled or deleted through the API', () => {
        for (const r of [selfDemote, rootDisable, rootDelete]) assert.strictEqual(r.status, 400, r.text);
    });

    // 12. Reject, create, delete
    await google({ email: 'stranger@example.com', sub: '333333333333333333333', name: 'Stranger' });
    const rej = await call('POST', '/api/admin/users/reject', { cookie: A, body: { username: 'stranger', reason: 'not staff' } });
    const rejLogin = await google({ email: 'stranger@example.com', sub: '333333333333333333333' });
    check('reject: a rejected user cannot sign in (403 rejected)', () => {
        assert.strictEqual(rej.status, 200, rej.text);
        assert.strictEqual(rejLogin.status, 403);
        assert.strictEqual(rejLogin.json.status, 'rejected');
    });
    const created = await call('POST', '/api/admin/users/create', { cookie: A, body: { Username: 'de_raiganj', Name: 'DE Raiganj', email: 'DE.Raiganj@Example.com', role: '', user_status: 'active', zone_code: 'MZO', region_code: 'Raiganj', division_code: 'Raiganj', ccc_code: '', 'si-autho': 'edit', 'si-divisions': 'Raiganj', designation: 'Divisional Engineer' } });
    const noEmail = await call('POST', '/api/admin/users/create', { cookie: A, body: { Username: 'nomail', Name: 'No Mail' } });
    const dupe = await call('POST', '/api/admin/users/create', { cookie: A, body: { Username: 'someone', email: 'de.raiganj@example.com', region_code: 'Raiganj' } });
    const createdLogin = await google({ email: 'de.raiganj@example.com', sub: '444444444444444444444', name: 'Google Name' });
    check('create: an admin-created account (by email) signs in at once with its division scope', () => {
        assert.strictEqual(created.status, 200, created.text);
        assert.strictEqual(noEmail.status, 400);
        assert.strictEqual(dupe.status, 400);
        assert.strictEqual(createdLogin.json.status, 'success', createdLogin.text);
        const cp = createdLogin.json.profile;
        assert.strictEqual(cp.Username, 'de_raiganj');
        assert.strictEqual(cp.Name, 'DE Raiganj');
        assert.strictEqual(cp.division_code, 'Raiganj');
        assert.strictEqual(cp.region_code, 'Uttar Dinajpur'); // asked for as "Raiganj": the region's current name
        assert.strictEqual(cp.office_level, 'DE');
        assert.strictEqual(cp['si-autho'], 'edit');
        assert.strictEqual(scopeFor(cp).level, 'division');
    });
    const del = await call('POST', '/api/admin/users/delete', { cookie: A, body: { Username: 'stranger' } });
    const goneRec = await one('stranger@example.com');
    check('delete: removes the account', () => {
        assert.strictEqual(del.status, 200, del.text);
        assert.strictEqual(goneRec, undefined);
    });

    // 13. Audit trail
    const trail = await audits('new.officer@example.com');
    const strangerTrail = await audits('stranger@example.com');
    const auditApi = await call('GET', '/api/admin/users/audit?username=new.officer', { cookie: A });
    check('audit: register, approve, update, disable, enable with who changed which field from what to what', () => {
        const actions = trail.map((t) => t.action);
        for (const a of ['register', 'approve', 'update', 'disable', 'enable']) assert.ok(actions.includes(a), `${a} in ${actions}`);
        const dis = trail.find((t) => t.action === 'disable');
        assert.strictEqual(dis.actor_email, 'dipnkr.das@gmail.com');
        assert.ok(dis.changes.some((c) => c.field === 'status' && c.from === 'active' && c.to === 'disabled'));
        const role = trail.find((t) => t.changes.some((c) => c.field === 'role'));
        assert.ok(role.changes.some((c) => c.from === 'viewer' && c.to === 'editor'));
        assert.deepStrictEqual(strangerTrail.map((t) => t.action), ['register', 'reject', 'delete']);
        assert.strictEqual(auditApi.status, 200);
        assert.ok(auditApi.json.audit.length >= 5);
    });

    // 14. Activity log
    const logs = await call('GET', '/api/admin/logs', { cookie: A });
    const recent = await call('GET', '/api/admin/logs?days=15', { cookie: A });
    const rows = (await pb('GET', '/api/collections/app_activity/records?perPage=500&sort=created')).body.items;
    check('activity: logins, page visits (from session-check, same origin only, once a minute) and admin changes are logged', () => {
        assert.strictEqual(logs.status, 200);
        const l = logs.json.logs;
        assert.ok(l.some((x) => x.type === 'login' && x.username === 'new.officer'));
        assert.ok(l.some((x) => x.type === 'login' && x.username === 'dipnkr.das'));
        assert.ok(l.some((x) => x.type === 'user_management' && /Approved user: new.officer/.test(x.details)));
        assert.ok(l.some((x) => x.type === 'user_management' && /New Google user requested registration: new.officer@example.com/.test(x.details)));
        assert.ok(l.some((x) => x.type === 'login_refused' && x.username === 'new.officer'));
        const visits = rows.filter((r) => r.action === 'page_visit' && r.username === 'new.officer');
        assert.strictEqual(visits.length, 1, JSON.stringify(visits.map((v) => v.page)));
        assert.strictEqual(visits[0].page, '/nsc.html');
        assert.strictEqual(visits[0].user_email, 'new.officer@example.com');
        assert.strictEqual(visits[0].user_agent, 'users-store-test');
        assert.ok(visits[0].ip);
        assert.ok(recent.json.logs.length > 0 && Object.keys(recent.json.logs[0]).sort().join() === 'timestamp,username');
    });
    const seenRec = await one('new.officer@example.com');
    check('activity: last_login_at, last_seen_at and login_count are kept on the account', () => {
        assert.ok(seenRec.last_login_at && seenRec.last_seen_at);
        assert.strictEqual(seenRec.login_count, 4); // four successful sign-ins; refused ones do not count
    });

    // 15. Access token (popup) sign-in
    const popup = await call('POST', '/api/auth/google', { body: { accessToken: 'good-access' } });
    const popupRec = await one('popup.user@example.com');
    check('google: an access token checked by tokeninfo registers the user with its userinfo name', () => {
        assert.strictEqual(popup.json.status, 'pending', popup.text);
        assert.strictEqual(popupRec.name, 'Popup User');
        assert.strictEqual(popupRec.google_sub, '900000000000000000001');
    });

    // 16. VM-only admin still works and reaches the store
    const local = await call('POST', '/api/auth/local', { body: { username: 'breakglass', password: LOCAL_PW } });
    const localUsers = await call('GET', '/api/admin/users', { cookie: local.session });
    const localCheck = await call('GET', '/api/session-check', { cookie: local.session });
    check('local admin: MZO_LOCAL_ADMINS still signs in and manages users; its profile has isAdmin', () => {
        assert.strictEqual(local.status, 200, local.text);
        assert.strictEqual(localUsers.status, 200);
        assert.strictEqual(localCheck.json.profile.isAdmin, true);
        assert.strictEqual(localCheck.json.profile.email, '');
    });

    // 17. Retention prune (clock moved past the retention window)
    await second.flush();
    const future = storeLib.create({ env: process.env, secret: SECRET, appRoot: ROOT, log: quiet, now: () => Date.now() + 400 * 86400000 });
    const keep = storeLib.create({ env: process.env, secret: SECRET, appRoot: ROOT, log: quiet });
    const keptNone = await keep.prune();
    const pruned = await future.prune();
    const left = (await pb('GET', '/api/collections/app_activity/records?perPage=1')).body.totalItems;
    const auditLeft = (await pb('GET', '/api/collections/app_user_audit/records?perPage=1')).body.totalItems;
    check('activity: the prune keeps recent rows and removes rows past MZO_ACTIVITY_RETENTION_DAYS; the audit trail stays', () => {
        assert.strictEqual(keptNone, 0);
        assert.ok(pruned > 10, String(pruned));
        assert.strictEqual(left, 0);
        assert.ok(auditLeft > 10);
    });

    // 18. Supabase mode (no flag) in a child process: verification and portal_users sign-in unchanged
    const sbOut = path.join(tmp, 'supabase.json');
    const child = spawnSync(process.execPath, [__filename, '--supabase-child', sbOut], { env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'UTC' }, encoding: 'utf8', timeout: 60000 });
    const sb = fs.existsSync(sbOut) ? JSON.parse(fs.readFileSync(sbOut, 'utf8')) : null;
    check('supabase mode: a valid ID token signs in the portal_users account; forged or foreign-audience tokens get 401', () => {
        assert.ok(sb, child.stderr + child.stdout);
        assert.strictEqual(sb.good.status, 200, JSON.stringify(sb.good));
        assert.strictEqual(sb.good.body.profile.Username, 'sbuser');
        assert.strictEqual(sb.rogue.status, 401);
        assert.strictEqual(sb.aud.status, 401);
        assert.ok(sb.upstream.includes('GET https://www.googleapis.com/oauth2/v3/certs'));
        assert.ok(!sb.upstream.some((u) => u.includes('tokeninfo')), 'ID tokens no longer go to tokeninfo');
    });

    // 19. Off without the flag; no upstream writes
    check('off: without MZO_USER_STORE=pocketbase the store is off', () => {
        assert.strictEqual(storeLib.create({ env: {} }).on, false);
        assert.strictEqual(storeLib.create({ env: { MZO_USER_STORE: 'supabase' } }).on, false);
    });
    check('no upstream writes and no Supabase calls for users or logs', () => {
        assert.deepStrictEqual(upstream.filter((u) => u.method !== 'GET'), []);
        assert.deepStrictEqual(upstream.filter((u) => /portal_users|activity_logs/.test(u.url)), []);
    });
    for (const f of ['users_store', 'google_auth', 'report_modules']) {
        const r = await call('GET', `/lib/${f}.js`);
        check(`private: /lib/${f}.js is 404`, () => assert.strictEqual(r.status, 404));
    }
    return srv;
}

/** window.MzoScope.getScope() for this profile, from the real mzo_scope.js and lib/offices.js. */
function scopeFor(profile) {
    const store = { mzo_user_profile: JSON.stringify(profile) };
    const ctx = {
        localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem() {}, removeItem() {} }, console,
        document: { readyState: 'loading', addEventListener() {} } // the banner boot never runs
    };
    ctx.window = ctx;
    ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', 'offices.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'mzo_scope.js'), 'utf8'), ctx);
    return ctx.MzoScope.getScope();
}

/** Files server.js writes under data/ go to the test's temporary folder. */
function sandboxDataWrites(tmp) {
    const DATA = path.join(ROOT, 'data') + path.sep;
    const sandbox = path.join(tmp, 'data');
    fs.mkdirSync(sandbox, { recursive: true });
    const inData = (p) => (path.resolve(String(p)) + path.sep).startsWith(DATA);
    const moved = (p) => path.join(sandbox, path.relative(DATA, path.resolve(String(p))));
    const { writeFileSync, mkdirSync } = fs;
    fs.writeFileSync = (p, ...a) => writeFileSync(inData(p) ? moved(p) : p, ...a);
    fs.mkdirSync = (p, ...a) => (inData(p) ? undefined : mkdirSync(p, ...a));
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
