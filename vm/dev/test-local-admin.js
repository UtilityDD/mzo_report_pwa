#!/usr/bin/env node
'use strict';
// Test of the VM-only admin accounts (MZO_LOCAL_ADMINS), with no network: Supabase is answered from
// fixtures by a stand-in fetch, and every upstream write is refused and recorded.
//
//   node vm/dev/test-local-admin.js
//
// It runs server.js in child processes (accounts set, password changed, variable unset) and checks:
// POST /api/auth/local with the right password gives an admin session that passes the session check and
// an admin endpoint; a wrong password and an unknown username (a Supabase user's PIN included) get the
// same answer and never reach Supabase; a local admin is never demoted by a Supabase row of the same
// name; the backoff (username and IP, unknown usernames counting against the IP) locks silently; a
// session ends when its entry is changed or removed; local admins cause no upstream write; with the
// variable unset the route is 404 and /api/auth/config does not offer it. Also checks
// lib/local_admins.js and the hash helper, and the CRM upload key (x-sync-key): accepted only on the
// upload routes and their read-back GETs, and only when the variable holds 32+ characters (the old
// built-in default never); the unbilled and disconnection reads need a session or the key, send no CORS
// header, and read the data folder (MZO_FILES_DIR); the payment upload writes it atomically (mode 600);
// API writes need this host's Origin (or Referer); server-side files stay hidden however their path is spelled.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const LA = require(path.join(ROOT, 'lib', 'local_admins.js'));
const SECRET = 'test-secret-for-local-admins';
const OLD = 'https://unsmtschmcvftfqwabaq.supabase.co/rest/v1/';
const ADMIN_PW = 'correct horse battery';
const OPS_PW = 'another long password';
const SYNC_KEY = crypto.randomBytes(32).toString('hex');
const SHORT_KEY = 'k'.repeat(31);
const PRIVATE_PATHS = ['/server.js', '/server%2ejs', '/%73erver.js', '/%2egit/HEAD', '/.git/HEAD', '/%64ata/activity_log.json', '/data/activity_log.json',
    '/lib/%65ditor/index.js', '/lib/editor/index.js', '/LIB/EDITOR/index.js', '/docs/HANDOFF%2emd', '/%73cripts/sync/common.js', '/%76m/sync/run.js',
    '/%6eode_modules/express/package.json', '/data/disconnection.csv', '/data/disconnection_payments.json', '/data/disconnection_meta.json', '/data/unbilled_chronic.csv', '/assets/..%2fserver.js', '/assets/%2e%2e/server.js', '//server.js', '/x%5c..%5cserver.js', '/%E0%A4%A', '/server.js%00.html'];
const PUBLIC_FILES = ['/login.html', '/version.json', '/data/costcenter.json', '/lib/offices.js'];
const CONSUMER_READS = ['/api/unbilled/meta', '/api/unbilled/outsort', '/api/unbilled/chronic', '/api/unbilled/summary', '/api/disconnection/meta', '/api/disconnection/dataset', '/api/disconnection/payments'];
const OLD_DEFAULT_KEY = 'mzo-crm-db2-sync-key-2026'; // a built-in fallback key in 3.37-3.42; must never work
// Fixture files in the data folder (MZO_FILES_DIR): headers and made-up values only.
const FIXTURES = {
    'disconnection.csv': 'CCC_CODE,MRU,CON_ID,NOTOSD\n6611108,M1,100000001,5000\n',
    'disconnection_payments.json': JSON.stringify({ generatedAt: 'fixture', totalMatched: 1, totalCollected: 10, consumers: { 100000001: { totalPaid: 10, items: [] } } }),
    'unbilled_chronic.csv': 'CON_ID,INV_PENDING_FLAG\n100000001,Y\n'
};

/** Supabase-style PIN hash (scrypt$salt$hash), as server.js hashPin writes it. */
function pinHash(pin) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 });
    return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

const PORTAL_USERS = [
    // Same username as a local admin, deliberately: it must neither sign in nor demote the local admin.
    { username: 'vmadmin', pin: pinHash('1234'), name: 'Supabase vmadmin', role: 'viewer', user_status: 'active', office_level: 'CCC', ccc_code: '6611108' },
    { username: 'clerk', pin: pinHash('5678'), name: 'Clerk', role: 'viewer', user_status: 'active', office_level: 'CCC', ccc_code: '6611108' }
];

// ---- Child: one server, one configuration ---------------------------------------------------------
async function child(out, cookieIn) {
    // Files the server writes under data/ (the activity log cache) go to a temporary folder instead.
    const DATA = path.join(ROOT, 'data') + path.sep;
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-test-data-'));
    const inData = (p) => (path.resolve(String(p)) + path.sep).startsWith(DATA);
    const moved = (p) => path.join(sandbox, path.relative(DATA, path.resolve(String(p))));
    const { writeFileSync, mkdirSync, readFileSync } = fs;
    fs.writeFileSync = (p, ...a) => writeFileSync(inData(p) ? moved(p) : p, ...a);
    fs.mkdirSync = (p, ...a) => (inData(p) ? undefined : mkdirSync(p, ...a));
    fs.readFileSync = (p, ...a) => readFileSync(inData(p) && fs.existsSync(moved(p)) ? moved(p) : p, ...a);

    const realFetch = global.fetch;
    const upstream = [];
    global.fetch = async (input, opts) => {
        const url = String(input && input.url ? input.url : input);
        const method = String((opts && opts.method) || 'GET').toUpperCase();
        if (url.startsWith('http://127.0.0.1:')) return realFetch(input, opts);
        upstream.push({ method, url: url.replace(/\?.*$/, ''), body: opts && opts.body ? String(opts.body).slice(0, 300) : '' });
        if (method !== 'GET' && method !== 'HEAD') return new Response('{"message":"write refused by the test"}', { status: 599 });
        const q = url.startsWith(OLD) ? url.slice(OLD.length) : '';
        const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (q.startsWith('portal_users?')) return json(PORTAL_USERS);
        if (q.startsWith('activity_logs?')) return json([]);
        if (q.startsWith('stock_upload_meta?')) return json([]);
        return new Response('{"message":"unknown to the test"}', { status: 599 });
    };
    const app = require(process.env.TEST_SERVER || path.join(ROOT, 'server.js'));
    const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const results = {};
    const call = async (name, method, p, { body, cookie, ip, extra, origin } = {}) => {
        const headers = { Accept: 'application/json' };
        // API writes come from the app's own pages; origin: null sends none, a string sends that one.
        if (origin === undefined && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.Origin = base;
        else if (origin) headers.Origin = origin;
        if (body) headers['Content-Type'] = 'application/json';
        if (cookie) headers.Cookie = cookie;
        if (ip) headers['X-Forwarded-For'] = ip;
        Object.assign(headers, extra || {});
        const before = upstream.length;
        const res = await realFetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
        const text = await res.text();
        const setCookie = res.headers.get('set-cookie') || '';
        results[name] = { status: res.status, body: text, cookie: setCookie.split(';')[0], acao: res.headers.get('access-control-allow-origin'), upstream: upstream.slice(before) };
        return results[name];
    };
    const login = (name, username, password, ip) => call(name, 'POST', '/api/auth/local', { body: { username, password }, ip });
    const forge = (session) => {
        const payload = Buffer.from(JSON.stringify(session)).toString('base64');
        return `mzo_session=${encodeURIComponent(payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64'))}`;
    };
    const mode = process.env.TEST_MODE;
    const A = '203.0.113.5';
    const B = '198.51.100.20';
    const C = '198.51.100.7';

    await call('config', 'GET', '/api/auth/config');
    // CRM upload key: the configured key ('sync') or keys the server must refuse ('rotated': short value set,
    // 'unset': nothing set).
    const syncKey = process.env.UNBILLED_SYNC_SECRET || ''; // the parent's random key (each process makes its own SYNC_KEY)
    const key = { 'x-sync-key': mode === 'sync' ? syncKey : SHORT_KEY };
    const viewer = forge({ profile: { Username: 'clerk', Name: 'Clerk', role: 'viewer', office_level: 'CCC', ccc_code: '6611108' }, expiry: Date.now() + 3600e3 });
    if (mode === 'sync' || mode === 'rotated' || mode === 'unset') {
        await call('sync_unbilled', 'POST', '/api/unbilled/upload', { extra: key, origin: null });
        await call('sync_disconnection', 'POST', '/api/disconnection/upload', { extra: key, origin: null });
        await call('sync_payments', 'POST', '/api/disconnection/payments-upload', { extra: key, origin: null });
        await call('sync_payments_old_default', 'POST', '/api/disconnection/payments-upload', { extra: { 'x-sync-key': OLD_DEFAULT_KEY }, origin: null });
        await call('sync_read_short', 'GET', '/api/disconnection/dataset', { extra: key });
    }
    if (mode === 'sync') {
        await call('sync_wrong_key', 'POST', '/api/unbilled/upload', { extra: { 'x-sync-key': syncKey.slice(0, -1) + (syncKey.endsWith('0') ? '1' : '0') } });
        await call('sync_bearer', 'POST', '/api/unbilled/upload', { extra: { Authorization: `Bearer ${syncKey}` } });
        await call('sync_admin_users', 'GET', '/api/admin/users', { extra: key });
        await call('sync_admin_update', 'POST', '/api/admin/users/update', { extra: key, body: { Username: 'clerk', role: 'admin' } });
        await call('sync_session_check', 'GET', '/api/session-check', { extra: key });
        await call('sync_get_read', 'GET', '/api/unbilled/chronic', { extra: key });
        await call('sync_get_dataset', 'GET', '/api/disconnection/dataset', { extra: key });
        await call('sync_get_wrong_key', 'GET', '/api/disconnection/dataset', { extra: { 'x-sync-key': syncKey.slice(0, -1) + (syncKey.endsWith('0') ? '1' : '0') } });
        await call('sync_get_other', 'GET', '/api/nsc/meta', { extra: key });
        await call('viewer_dataset', 'GET', '/api/disconnection/dataset', { cookie: viewer });
        await call('viewer_payments', 'GET', '/api/disconnection/payments', { cookie: viewer });
        // Payment history upload (multipart, as scripts/sync/sync_disconnection_payments.js sends it).
        const upload = async (name, headers, files) => {
            const fd = new FormData();
            for (const [field, fname, text] of files) fd.append(field, new Blob([text]), fname);
            const res = await realFetch(base + '/api/disconnection/payments-upload', { method: 'POST', headers, body: fd });
            results[name] = { status: res.status, body: await res.text(), acao: res.headers.get('access-control-allow-origin') };
        };
        const payJson = JSON.stringify({ generatedAt: 'upload', totalMatched: 2, totalCollected: 20, consumers: { 100000002: { totalPaid: 20, items: [] } } });
        const metaJson = JSON.stringify({ version: 'v:test', stats: { totalConsumers: 1 } });
        await upload('pay_key', key, [['file', 'disconnection_payments.json', payJson], ['meta', 'disconnection_meta.json', metaJson]]);
        const filesDir = process.env.MZO_FILES_DIR;
        const st = fs.statSync(path.join(filesDir, 'disconnection_payments.json'));
        results.pay_written = {
            same: readFileSync(path.join(filesDir, 'disconnection_payments.json'), 'utf8') === payJson,
            meta: readFileSync(path.join(filesDir, 'disconnection_meta.json'), 'utf8').includes('v:test'),
            mode: (st.mode & 0o777).toString(8),
            leftovers: fs.readdirSync(filesDir).filter((f) => f.endsWith('.tmp'))
        };
        await call('viewer_payments_after', 'GET', '/api/disconnection/payments', { cookie: viewer });
        await call('viewer_meta_after', 'GET', '/api/disconnection/meta', { cookie: viewer });
        await upload('pay_old_default', { 'x-sync-key': OLD_DEFAULT_KEY }, [['file', 'disconnection_payments.json', payJson]]);
        await upload('pay_bearer_key', { Authorization: `Bearer ${syncKey}` }, [['file', 'disconnection_payments.json', payJson]]);
        await upload('pay_viewer', { Cookie: viewer, Origin: base }, [['file', 'disconnection_payments.json', payJson]]);
        await upload('pay_csv_name', key, [['file', 'payments.csv', payJson]]);
        await upload('pay_bad_json', key, [['file', 'disconnection_payments.json', '{not json']]);
        await upload('pay_no_consumers', key, [['file', 'disconnection_payments.json', '{"generatedAt":"x"}']]);
        results.pay_after_bad = readFileSync(path.join(filesDir, 'disconnection_payments.json'), 'utf8') === payJson;
        await call('sync_other_post', 'POST', '/api/disconnection/sync', { extra: key });
        await call('viewer_upload', 'POST', '/api/disconnection/upload', { cookie: viewer });
        for (const p of CONSUMER_READS) {
            await call(`anon ${p}`, 'GET', p);
            await call(`viewer ${p}`, 'GET', p, { cookie: viewer });
        }
        await call('anon_options', 'OPTIONS', '/api/unbilled/chronic');
        // Origin check on API writes (logout is a harmless write).
        const admin = forge({ profile: { Username: 'boss', Name: 'Boss', role: 'admin', office_level: 'CE' }, expiry: Date.now() + 3600e3 });
        const EVIL = 'https://evil.1.2.3.4.sslip.io';
        await call('csrf_same_origin', 'POST', '/api/logout', { cookie: admin });
        await call('csrf_same_referer', 'POST', '/api/logout', { cookie: admin, origin: null, extra: { Referer: base + '/app.html' } });
        await call('csrf_evil_origin', 'POST', '/api/logout', { cookie: admin, origin: EVIL });
        await call('csrf_evil_referer', 'POST', '/api/logout', { cookie: admin, origin: null, extra: { Referer: EVIL + '/x.html' } });
        await call('csrf_none', 'POST', '/api/logout', { cookie: admin, origin: null });
        await call('csrf_null_origin', 'POST', '/api/logout', { cookie: admin, origin: 'null' });
        await call('csrf_upper_path', 'POST', '/API/logout', { cookie: admin, origin: EVIL });
        await call('csrf_admin_update', 'POST', '/api/admin/users/update', { cookie: admin, origin: EVIL, body: { Username: 'clerk', role: 'admin' } });
        await call('csrf_editor', 'POST', '/api/editor/datasets/x/commit', { cookie: admin, origin: EVIL, body: {} });
        await call('csrf_cookie_upload', 'POST', '/api/unbilled/upload', { cookie: admin, origin: null });
        await call('csrf_key_upload_evil', 'POST', '/api/unbilled/upload', { extra: key, origin: EVIL });
        await call('csrf_bearer_upload', 'POST', '/api/disconnection/upload', { origin: null, extra: { Authorization: 'Bearer not-a-session' } });
        await call('csrf_key_other_route', 'POST', '/api/disconnection/sync', { cookie: admin, origin: null, extra: key });
        await call('csrf_get', 'GET', '/api/session-check', { cookie: admin, origin: EVIL });
        // Paths that must never be served, however they are spelled.
        for (const p of PRIVATE_PATHS) await call(`private ${p}`, 'GET', p);
        for (const p of PUBLIC_FILES) await call(`public ${p}`, 'GET', p);
        srv.close();
        fs.writeFileSync(out, JSON.stringify({ results, upstream }));
        fs.rmSync(sandbox, { recursive: true, force: true });
        process.exit(0);
    }
    if (mode === 'set') {
        const ok = await login('local_ok', ' VMAdmin ', ADMIN_PW, B);
        await call('local_session_check', 'GET', '/api/session-check', { cookie: ok.cookie });
        await call('local_admin_users', 'GET', '/api/admin/users', { cookie: ok.cookie });
        await call('local_stock_meta', 'GET', '/api/stock/meta', { cookie: ok.cookie });
        // Failures: vmadmin 1 (C, the same-name Supabase PIN is a wrong local password) + 3 (A);
        // IP A: those 3, the unknown username clerk (with its right Supabase PIN) and vmops once = 5.
        await login('supabase_same_name', 'vmadmin', '1234', C);
        await login('local_wrong', 'vmadmin', 'wrong password', A);
        await login('unknown_user', 'clerk', '5678', A);
        await login('missing_password', 'vmadmin', '  ', A);
        for (let i = 2; i <= 3; i++) await login(`local_wrong_${i}`, 'vmadmin', 'wrong password ' + i, A);
        await login('ops_wrong_1', 'vmops', 'wrong password 1', A);
        await login('ops_locked_ip', 'vmops', OPS_PW, A); // IP A: 5 failures, locked
        await login('unknown_locked_ip', 'clerk', '5678', A);
        await login('local_other_ip', 'vmadmin', ADMIN_PW, C); // vmadmin: 4 failures, not locked; resets
        for (let i = 1; i <= 5; i++) await login(`local_spread_${i}`, 'vmadmin', 'wrong password ' + i, `192.0.2.${10 + i}`);
        await login('local_locked_user', 'vmadmin', ADMIN_PW, '192.0.2.99'); // vmadmin: 5 failures from 5 IPs, locked
        await login('ops_other_ip', 'vmops', OPS_PW, C);
        await call('forged_local_key', 'GET', '/api/session-check', {
            cookie: forge({ profile: { Username: 'vmadmin', role: 'admin', auth_provider: 'local' }, expiry: Date.now() + 3600e3, local: 'x'.repeat(32) })
        });
        const noKey = forge({ profile: { Username: 'vmadmin', role: 'viewer', auth_provider: 'local' }, expiry: Date.now() + 3600e3 });
        await call('forged_no_key_check', 'GET', '/api/session-check', { cookie: noKey });
        await call('forged_no_key_admin', 'GET', '/api/admin/users', { cookie: noKey });
        results.cookieOut = ok.cookie;
    } else {
        // 'rotated' (vmadmin's password changed) and 'unset' (no MZO_LOCAL_ADMINS): the old session ends.
        await call('old_session_check', 'GET', '/api/session-check', { cookie: cookieIn });
        await call('old_session_admin', 'GET', '/api/admin/users', { cookie: cookieIn });
        await login('supabase_same_name', 'vmadmin', '1234', C);
        await login('local_password', 'vmadmin', ADMIN_PW, C);
        await login('unknown_user', 'clerk', '5678', A);
    }
    srv.close();
    fs.writeFileSync(out, JSON.stringify({ results, upstream }));
    fs.rmSync(sandbox, { recursive: true, force: true });
    process.exit(0);
}

function runMode(mode, admins, tmp, cookieIn, extraEnv) {
    const out = path.join(tmp, `${mode}.json`);
    const files = fs.mkdtempSync(path.join(tmp, `files-${mode}-`));
    for (const [name, text] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(files, name), text);
    const env = Object.assign({ PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'UTC', JWT_SECRET: SECRET, TEST_MODE: mode, MZO_FILES_DIR: files }, extraEnv || {});
    if (admins) env.MZO_LOCAL_ADMINS = admins;
    if (process.env.TEST_SERVER) env.TEST_SERVER = process.env.TEST_SERVER;
    const r = spawnSync(process.execPath, [__filename, '--child', out, cookieIn || ''], { env, encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`${mode} server failed:\n${r.stdout}\n${r.stderr}`);
    return Object.assign(JSON.parse(fs.readFileSync(out, 'utf8')), { log: r.stdout + r.stderr });
}

function main() {
    let checks = 0;
    const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
    const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks++; };

    // ---- lib/local_admins.js on its own --------------------------------------------------------------
    const hashA = LA.hashPassword(ADMIN_PW);
    ok(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(hashA), 'hash format');
    ok(LA.parseHash(hashA), 'hash parses');
    ['', 'scrypt$1$2', 'scrypt$1000$8$1$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaA==', 'bcrypt$16384$8$1$a$b', hashA.replace('$8$', '$99$'), hashA.replace('$32768$8$1$', '$1048576$32$1$'), `${hashA}$x`]
        .forEach((h) => ok(LA.parseHash(h) === null, `bad hash accepted: ${h.slice(0, 30)}`));
    const quiet = { log() {}, warn() {}, error() {} };
    const warns = [];
    const mod = LA.create({
        env: { MZO_LOCAL_ADMINS: ` vmadmin|VM Admin|${hashA} ; bad entry ; x|Short|${hashA};VMADMIN|Dup|${hashA}` },
        secret: SECRET,
        log: { log() {}, warn: (m) => warns.push(m), error() {} }
    });
    ok(mod.enabled && mod.find('VMadmin ') && !mod.find('x') && mod.find('vmadmin').name === 'VM Admin', 'entries parsed, bad ones skipped, first duplicate wins');
    eq(warns.length, 3, 'one warning per skipped entry');
    ok(warns.every((w) => !w.includes(hashA.split('$')[5]) && !w.includes(hashA.split('$')[4])), 'warnings never contain the hash');
    ok(!LA.create({ env: {}, secret: SECRET, log: quiet }).enabled, 'unset: disabled');
    const fakeReq = (ip, peer = '127.0.0.1') => ({ socket: { remoteAddress: peer }, headers: ip ? { 'x-forwarded-for': ip } : {} });
    eq(LA.clientIp(fakeReq('10.0.0.1, 203.0.113.9')), '203.0.113.9', 'IP: last X-Forwarded-For behind the local proxy');
    eq(LA.clientIp(fakeReq('203.0.113.9', '198.51.100.1')), '198.51.100.1', 'IP: X-Forwarded-For ignored from a remote peer');
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    const run = async () => {
        const admin = mod.find('vmadmin');
        ok(await mod.attempt(admin, ADMIN_PW, fakeReq('192.0.2.1')), 'right password');
        for (let i = 0; i < LA.MAX_FAILS; i++) ok(!(await mod.attempt(admin, 'nope', fakeReq('192.0.2.1'))), 'wrong password');
        ok(!(await mod.attempt(admin, ADMIN_PW, fakeReq('192.0.2.2'))), 'locked after 5 failures, even with the right password');
        now += LA.LOCK_MS - 1000;
        ok(!(await mod.attempt(admin, ADMIN_PW, fakeReq('192.0.2.2'))), 'still locked before a minute');
        now += 2000;
        ok(await mod.attempt(admin, ADMIN_PW, fakeReq('192.0.2.2')), 'unlocked after a minute');
        const s = { profile: { Username: 'vmadmin' }, local: mod.sessionKey(admin) };
        ok(mod.sessionValid(s), 'session key valid');
        ok(!mod.sessionValid({ ...s, local: s.local.slice(1) }), 'tampered session key refused');
        ok(!LA.create({ env: { MZO_LOCAL_ADMINS: `vmadmin|VM Admin|${LA.hashPassword(ADMIN_PW)}` }, secret: SECRET, log: quiet }).sessionValid(s), 'new hash ends the session');
    };
    return run().then(() => {
        Date.now = realNow;

        // ---- The hash helper ----------------------------------------------------------------------------
        const helper = path.join(ROOT, 'scripts', 'tools', 'hash-password.js');
        const h = spawnSync(process.execPath, [helper, 'vmadmin', 'VM Admin'], { input: ADMIN_PW + '\n', encoding: 'utf8' });
        eq(h.status, 0, 'helper exit code');
        const entry = h.stdout.trim();
        ok(entry.startsWith('vmadmin|VM Admin|scrypt$') && !h.stdout.includes(ADMIN_PW), 'helper prints the entry, not the password');
        const viaHelper = LA.create({ env: { MZO_LOCAL_ADMINS: entry }, secret: SECRET, log: quiet });
        ok(viaHelper.find('vmadmin'), 'helper entry parses');
        ok(spawnSync(process.execPath, [helper], { input: 'short\n', encoding: 'utf8' }).status === 1, 'helper refuses a short password');
        ok(spawnSync(process.execPath, [helper], { input: ' padded password \n', encoding: 'utf8' }).status === 1, 'helper refuses surrounding spaces');
        ok(spawnSync(process.execPath, [helper, 'vmadmin', 'VM Admin', ADMIN_PW], { input: '', encoding: 'utf8' }).status === 2, 'helper refuses a password on the command line');

        // ---- The server ---------------------------------------------------------------------------------
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-local-admin-test-'));
        const admins = `${entry};vmops|VM Ops|${LA.hashPassword(OPS_PW)}`;
        const S = runMode('set', admins, tmp);
        const R = S.results;
        const body = (r) => JSON.parse(r.body);
        const WRONG = { status: 'error', message: 'Invalid username or password.' };

        eq(body(R.config).localSignIn, true, 'set: /api/auth/config offers the local sign-in');
        eq(R.local_ok.status, 200, 'local admin: sign-in');
        const profile = body(R.local_ok).profile;
        eq(Object.keys(profile), ['Username', 'Name', 'email', 'auth_provider', 'user_status', 'role', 'office_level', 'sheets_autho', 'can_comment',
            'disconnection_sync_autho', 'pending_mc_sync_autho', 'load_ext_sync_autho', 'defective_upload_autho', 'nsc_upload_autho',
            'stock_upload_autho', 'stock_allot_autho', 'stock_cancel_autho', 'upload_permissions', 'requested_at', 'approved_at', 'approved_by'],
        'local admin: profile shaped like the Google root admin');
        ok(profile.Username === 'vmadmin' && profile.Name === 'VM Admin' && profile.role === 'admin' && profile.office_level === 'CE' &&
            profile.auth_provider === 'local' && profile.upload_permissions.length === 8, 'local admin: profile values');
        eq(R.local_ok.upstream, [], 'local admin: sign-in makes no upstream request (no Supabase lookup, no activity write)');
        eq(R.local_session_check.status, 200, 'local admin: session check');
        eq(body(R.local_session_check).profile, profile, 'local admin: session check returns the env profile');
        eq(R.local_session_check.upstream, [], 'local admin: session check does not read Supabase');
        eq(R.local_admin_users.status, 200, 'local admin: admin endpoint');
        const meta = body(R.local_stock_meta);
        ok(meta.isAdmin === true && meta.canUpload === true, 'local admin: not demoted by the Supabase row of the same name');
        eq([R.supabase_same_name.status, body(R.supabase_same_name)], [401, WRONG], 'same-name Supabase user cannot sign in (no fall-through)');
        eq(R.supabase_same_name.upstream, [], 'no Supabase lookup for a local admin username');
        eq([R.local_wrong.status, body(R.local_wrong)], [401, WRONG], 'local admin: wrong password');
        eq([R.unknown_user.status, R.unknown_user.body], [401, R.local_wrong.body], 'unknown username (a Supabase user with its PIN) answers exactly like a wrong password');
        eq(R.unknown_user.upstream, [], 'unknown username: no Supabase lookup');
        eq(R.missing_password.status, 400, 'blank password: 400');
        eq([R.ops_locked_ip.status, R.ops_locked_ip.body], [401, R.local_wrong.body], 'backoff: IP with 5 failures (unknown usernames included) locked, answered like a wrong password');
        eq([R.unknown_locked_ip.status, R.unknown_locked_ip.body], [401, R.local_wrong.body], 'backoff: locked IP, unknown username, same answer');
        eq(R.local_other_ip.status, 200, 'backoff: under 5 failures, the right password from another IP signs in');
        eq([R.local_locked_user.status, R.local_locked_user.body], [401, R.local_wrong.body], 'backoff: username with 5 failures locked, from any IP');
        eq(R.ops_other_ip.status, 200, 'backoff: the other admin from an unlocked IP signs in');
        eq(R.forged_local_key.status, 401, 'a session with a wrong local key is refused');
        ok(body(R.forged_no_key_check).profile.role === 'viewer', 'auth_provider local without the signed key is an ordinary session');
        eq(R.forged_no_key_admin.status, 403, '… and gets no admin access');
        ok(!S.log.includes(ADMIN_PW) && !S.log.includes(entry.split('|')[2]), 'server log has neither password nor hash');
        // Local admins' activity goes to the journal: no upstream write at all.
        eq(S.upstream.filter((u) => u.method !== 'GET'), [], 'no upstream write');

        // Password changed / variable removed: the old session ends; Supabase users are untouched.
        const rot = runMode('rotated', `vmadmin|VM Admin|${LA.hashPassword('a different password')}`, tmp, R.cookieOut,
            { UNBILLED_SYNC_SECRET: SHORT_KEY, DISCONNECTION_SYNC_SECRET: SHORT_KEY });
        const un = runMode('unset', '', tmp, R.cookieOut);
        for (const [name, X] of [['rotated', rot], ['unset', un]]) {
            eq(X.results.old_session_check.status, 401, `${name}: old local admin session ends`);
            eq(X.results.old_session_admin.status, 401, `${name}: old local admin session has no admin access`);
        }
        eq(rot.results.local_password.status, 401, 'rotated: old local password no longer signs in');
        eq(rot.results.supabase_same_name.status, 401, 'rotated: same-name Supabase PIN still cannot sign in');
        eq(rot.results.unknown_user.body, R.local_wrong.body, 'rotated: unknown username, same answer');
        eq(body(rot.results.config).localSignIn, true, 'rotated: local sign-in still offered');
        eq(body(un.results.config), { googleClientId: '' }, 'unset: /api/auth/config does not offer the local sign-in');
        for (const k of ['local_password', 'supabase_same_name', 'unknown_user']) {
            eq([un.results[k].status, un.results[k].upstream], [404, []], `unset: /api/auth/local is 404 (${k}), no upstream request`);
        }

        // ---- CRM upload key ----------------------------------------------------------------------------
        const Y = runMode('sync', '', tmp, '', { UNBILLED_SYNC_SECRET: SYNC_KEY, DISCONNECTION_SYNC_SECRET: SYNC_KEY }).results;
        eq([Y.sync_unbilled.status, body(Y.sync_unbilled).message], [400, 'No CSV files received. Please select at least one CSV file to upload.'], 'sync key: unbilled upload accepted (no files sent)');
        eq([Y.sync_disconnection.status, body(Y.sync_disconnection).message], [400, 'No file uploaded'], 'sync key: disconnection upload accepted (no file sent)');
        eq(Y.sync_wrong_key.status, 401, 'sync key: a wrong key is refused');
        eq(Y.sync_bearer.status, 401, 'sync key: not accepted as a Bearer token');
        eq(Y.sync_admin_users.status, 401, 'sync key: no admin user list');
        eq(Y.sync_admin_update.status, 401, 'sync key: no user changes');
        eq(Y.sync_session_check.status, 401, 'sync key: not a session');
        eq([Y.sync_get_read.status, Y.sync_get_read.body], [200, FIXTURES['unbilled_chronic.csv']], 'sync key: reads back the unbilled file from MZO_FILES_DIR');
        eq([Y.sync_get_dataset.status, Y.sync_get_dataset.body], [200, FIXTURES['disconnection.csv']], 'sync key: reads back the disconnection list (payment sync)');
        eq(Y.sync_get_wrong_key.status, 401, 'sync key: a wrong key is refused on reads');
        eq(Y.sync_get_other.status, 401, 'sync key: not accepted on other reads');
        eq([Y.viewer_dataset.status, Y.viewer_dataset.body], [200, FIXTURES['disconnection.csv']], 'signed-in user: dataset from MZO_FILES_DIR');
        eq([Y.viewer_payments.status, JSON.parse(Y.viewer_payments.body).generatedAt], [200, 'fixture'], 'signed-in user: payments from MZO_FILES_DIR');
        eq([Y.pay_key.status, Y.pay_key.acao], [200, null], 'payments upload: accepted with the key, no CORS header');
        eq(Y.pay_written, { same: true, meta: true, mode: '600', leftovers: [] }, 'payments upload: file and meta written whole, mode 600, no temp files left');
        eq(JSON.parse(Y.viewer_payments_after.body).generatedAt, 'upload', 'payments upload: served right after');
        eq(JSON.parse(Y.viewer_meta_after.body).version, 'v:test', 'payments upload: meta served right after');
        eq(Y.pay_old_default.status, 401, 'payments upload: the old built-in key is refused');
        eq(Y.pay_bearer_key.status, 401, 'payments upload: the key is not accepted as a Bearer token');
        eq(Y.pay_viewer.status, 403, 'payments upload: a viewer without the grant is refused');
        eq(Y.pay_csv_name.status, 400, 'payments upload: only .json files');
        eq(Y.pay_bad_json.status, 400, 'payments upload: invalid JSON refused');
        eq(Y.pay_no_consumers.status, 400, 'payments upload: JSON without consumers refused');
        eq(Y.pay_after_bad, true, 'payments upload: a refused upload leaves the file alone');
        eq(Y.sync_payments.status, 400, 'sync key: payments upload accepted (no file sent)');
        eq(Y.sync_payments_old_default.status, 401, 'sync key: the old built-in key is refused when a real key is set');
        eq(Y.sync_read_short.status, 200, 'sync key: read-back accepted');
        eq(Y.sync_other_post.status, 401, 'sync key: not accepted on other writes');
        eq(Y.viewer_upload.status, 403, 'viewer without the grant cannot upload the disconnection dataset');
        for (const p of CONSUMER_READS) {
            eq(Y[`anon ${p}`].status, 401, `${p}: 401 without a session`);
            ok(Y[`anon ${p}`].acao === null && Y[`viewer ${p}`].acao === null, `${p}: no CORS header`);
            ok(Y[`viewer ${p}`].status !== 401, `${p}: a signed-in user gets past the session check (HTTP ${Y[`viewer ${p}`].status})`);
        }
        eq([Y.anon_options.status, Y.anon_options.acao], [401, null], 'OPTIONS: no CORS preflight answer');
        eq(Y.csrf_same_origin.status, 200, 'origin check: same Origin passes');
        eq(Y.csrf_same_referer.status, 200, 'origin check: same-host Referer passes when there is no Origin');
        for (const k of ['csrf_evil_origin', 'csrf_evil_referer', 'csrf_none', 'csrf_null_origin', 'csrf_upper_path', 'csrf_admin_update', 'csrf_editor', 'csrf_cookie_upload', 'csrf_key_other_route']) {
            eq(Y[k].status, 403, `origin check: ${k} refused`);
        }
        eq(Y.csrf_key_upload_evil.status, 400, 'origin check: the upload key needs no Origin (accepted, no files sent)');
        eq(Y.csrf_bearer_upload.status, 401, 'origin check: a Bearer token on an upload route skips the Origin check (then fails the session check)');
        eq(Y.csrf_get.status, 200, 'origin check: reads are not affected');
        for (const p of PRIVATE_PATHS) eq(Y[`private ${p}`].status, 404, `private path ${p}`);
        for (const p of PUBLIC_FILES) eq(Y[`public ${p}`].status, 200, `public file ${p}`);
        // The pages' shared escaping helper (mzo_esc.js).
        require(path.join(ROOT, 'mzo_esc.js'));
        eq(globalThis.mzoEsc('<img src=x onerror="a(\'b\')">&`'), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;&#96;', 'mzoEsc escapes markup and quotes');
        eq([globalThis.mzoEsc(null), globalThis.mzoEsc(undefined), globalThis.mzoEsc(0), globalThis.mzoEsc('⬤')], ['', '', '0', '⬤'], 'mzoEsc: empty values, numbers, symbols');
        for (const [name, X] of [['short key', rot.results], ['unset', un.results]]) {
            eq(X.sync_unbilled.status, 401, `${name}: unbilled upload refused`);
            eq(X.sync_disconnection.status, 401, `${name}: disconnection upload refused`);
            eq(X.sync_payments.status, 401, `${name}: payments upload refused`);
            eq(X.sync_payments_old_default.status, 401, `${name}: the old built-in key is refused`);
            eq(X.sync_read_short.status, 401, `${name}: read-back refused`);
        }

        fs.rmSync(tmp, { recursive: true, force: true });
        console.log(`local admin test: ${checks} checks passed`);
    });
}

if (process.argv[2] === '--child') {
    child(process.argv[3], process.argv[4]).catch((err) => { console.error(err); process.exit(1); });
} else {
    main().catch((err) => {
        console.error('FAIL:', err.message);
        process.exitCode = 1;
    });
}
