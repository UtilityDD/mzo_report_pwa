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
// lib/local_admins.js and the hash helper.

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
    const call = async (name, method, p, { body, cookie, ip } = {}) => {
        const headers = { Accept: 'application/json' };
        if (body) headers['Content-Type'] = 'application/json';
        if (cookie) headers.Cookie = cookie;
        if (ip) headers['X-Forwarded-For'] = ip;
        const before = upstream.length;
        const res = await realFetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        const setCookie = res.headers.get('set-cookie') || '';
        results[name] = { status: res.status, body: text, cookie: setCookie.split(';')[0], upstream: upstream.slice(before) };
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

function runMode(mode, admins, tmp, cookieIn) {
    const out = path.join(tmp, `${mode}.json`);
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'UTC', JWT_SECRET: SECRET, TEST_MODE: mode };
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
        const rot = runMode('rotated', `vmadmin|VM Admin|${LA.hashPassword('a different password')}`, tmp, R.cookieOut);
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
