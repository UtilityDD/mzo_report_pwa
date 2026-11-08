#!/usr/bin/env node
'use strict';
// Test of the Power Map V2 routes (GET /api/powermap/config, /api/powermap/me and the PostgREST proxy
// /api/powermap/rest/v1/*), with no network: every upstream call is answered by a stand-in fetch and
// recorded, so nothing reaches Supabase.
//
//   node vm/dev/test-powermap-proxy.js
//
// Checks: config needs a session and never carries a key; a viewer reads the map tables with the read key,
// but cannot write, call RPCs, read the editor tables or embed them; an admin writes the allow-listed tables
// and RPC with the write key, only from this host's Origin; unknown tables and schemas never go upstream;
// only allow-listed headers are forwarded (never the client's apikey); pin_hash never comes back;
// the map's source folder is not served while its build is; /me gives admins "super" and viewers no role.

const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const SECRET = 'test-secret-for-powermap-proxy';
const PM = 'https://pm.example.test';
const READ_KEY = 'read-key-for-the-test';
const WRITE_KEY = 'write-key-for-the-test';
process.env.JWT_SECRET = SECRET;
process.env.POWERMAP_SUPABASE_URL = PM;
process.env.POWERMAP_SUPABASE_KEY = READ_KEY;
process.env.POWERMAP_SUPABASE_SERVICE_KEY = WRITE_KEY;
delete process.env.MZO_USER_STORE;
delete process.env.MZO_DATA_MODE;
delete process.env.MZO_LOCAL_ADMINS;

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks++; };

function cookie(profile) {
    const payload = Buffer.from(JSON.stringify({ profile, expiry: Date.now() + 3600e3 })).toString('base64');
    return `mzo_session=${encodeURIComponent(payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64'))}`;
}
const VIEWER = cookie({ Username: 'viewer1', Name: 'Viewer', role: 'viewer', office_level: 'ZONE' });
const ADMIN = cookie({ Username: 'admin1', Name: 'Admin', role: 'admin', office_level: 'ZONE' });

const realFetch = global.fetch;
const upstream = [];
global.fetch = async (input, opts = {}) => {
    const url = String(input && input.url ? input.url : input);
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, opts);
    const method = String(opts.method || 'GET').toUpperCase();
    const headers = Object.assign({}, opts.headers || {});
    upstream.push({ method, url, headers, body: opts.body });
    const json = (v, status = 200, extra = {}) => new Response(JSON.stringify(v), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, extra) });
    if (!url.startsWith(PM + '/rest/v1/')) return method === 'GET' ? json([]) : json({ message: 'refused by the test' }, 599);
    const rest = url.slice((PM + '/rest/v1/').length);
    if (rest.startsWith('pm_v_substations')) return json([{ id: 'a', name: 'SS <b>' }], 200, { 'Content-Range': '0-0/1' });
    if (rest.startsWith('pm_editors')) return json([{ id: 'e1', name: 'Ed', pin_hash: 'deadbeef', active: true }]);
    if (method === 'GET' || method === 'HEAD') return json([]);
    return json([{ ok: true }], method === 'POST' ? 201 : 200);
};

async function main() {
    const app = require(path.join(ROOT, 'server.js'));
    const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const call = async (method, p, { who, body, origin, extra } = {}) => {
        const headers = { Accept: 'application/json' };
        if (who) headers.Cookie = who;
        if (origin === undefined && !['GET', 'HEAD'].includes(method)) headers.Origin = base;
        else if (origin) headers.Origin = origin;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        Object.assign(headers, extra || {});
        const before = upstream.length;
        const res = await realFetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
        return { status: res.status, text, json, headers: res.headers, up: upstream.slice(before).filter((u) => u.url.startsWith(PM)) };
    };
    const R = '/api/powermap/rest/v1/';
    try {
        // Config and identity.
        eq((await call('GET', '/api/powermap/config')).status, 401, 'config without a session: 401');
        const cfg = await call('GET', '/api/powermap/config', { who: VIEWER });
        eq(cfg.status, 200, 'config for a viewer');
        eq(cfg.json.configured, true, 'configured after the probe');
        eq(cfg.json.proxy, '/api/powermap', 'config names the proxy');
        ok(!('anonKey' in cfg.json) && !('url' in cfg.json), 'config has no url or key field');
        ok(!cfg.text.includes(READ_KEY) && !cfg.text.includes(WRITE_KEY) && !cfg.text.includes(PM), 'config never carries a key or the upstream URL');
        eq((await call('GET', '/api/powermap/me', { who: VIEWER })).json.role, null, 'viewer: no edit role');
        eq((await call('GET', '/api/powermap/me', { who: ADMIN })).json.role, 'super', 'admin: super');

        // Viewer reads.
        eq((await call('GET', R + 'pm_v_substations?select=*')).status, 401, 'proxy without a session: 401');
        const rd = await call('GET', R + 'pm_v_substations?select=id,name&order=name.asc', { who: VIEWER, extra: { apikey: 'client-key', Authorization: 'Bearer client-key', Range: '0-999', Prefer: 'count=exact, tx=commit' } });
        eq(rd.status, 200, 'viewer reads a map view');
        eq(rd.json, [{ id: 'a', name: 'SS <b>' }], 'body passed through');
        eq(rd.headers.get('content-range'), '0-0/1', 'Content-Range passed through');
        eq(rd.up.length, 1, 'one upstream call');
        eq(rd.up[0].url, PM + '/rest/v1/pm_v_substations?select=id,name&order=name.asc', 'query passed through');
        eq(rd.up[0].headers.apikey, READ_KEY, 'read key upstream, not the client key');
        eq(rd.up[0].headers.Authorization, `Bearer ${READ_KEY}`, 'read key as bearer');
        eq(rd.up[0].headers['Accept-Profile'], 'public', 'public profile by default');
        eq(rd.up[0].headers.Prefer, 'count=exact', 'only allow-listed Prefer values');
        eq(rd.up[0].headers.Range, '0-999', 'Range forwarded');
        const head = await call('HEAD', R + 'pm_v_lines?select=id', { who: VIEWER, extra: { Prefer: 'count=exact' } });
        eq([head.status, head.up.length, head.up[0] && head.up[0].method], [200, 1, 'HEAD'], 'HEAD count passes');
        const pmSchema = await call('GET', R + 'v_substations?select=*', { who: VIEWER, extra: { 'Accept-Profile': 'powermap' } });
        eq([pmSchema.status, pmSchema.up[0] && pmSchema.up[0].headers['Accept-Profile']], [200, 'powermap'], 'powermap schema read');

        // Viewer refused (nothing goes upstream).
        const refused = [
            ['GET', 'portal_users?select=*', 404, 'a table outside the map'],
            ['GET', 'pm_editors?select=*', 403, 'the editor accounts'],
            ['GET', 'pm_edit_suggestions?select=*', 403, 'the suggestions'],
            ['GET', 'pm_assets?select=*,pm_profiles(*)', 400, 'embedding an admin-only table'],
            ['GET', 'pm_v_substations?select=*', 400, 'an unknown schema', { 'Accept-Profile': 'auth' }],
            ['PATCH', 'pm_assets?id=eq.x', 403, 'a write', null, { name: 'x' }],
            ['POST', 'pm_substations', 403, 'an insert', null, { lat: 1 }],
            ['DELETE', 'pm_lines?id=eq.x', 403, 'a delete'],
            ['POST', 'rpc/pm_admin_update_substation_bundle', 403, 'the update RPC', null, { p_ss: {} }],
            ['PUT', 'pm_assets?id=eq.x', 405, 'PUT', null, { name: 'x' }]
        ];
        for (const [m, p, status, what, extra, body] of refused) {
            const r = await call(m, R + p, { who: VIEWER, extra: extra || undefined, body });
            eq([r.status, r.up.length], [status, 0], `viewer: ${what} refused with ${status}, nothing upstream`);
        }

        // Admin writes.
        const noOrigin = await call('PATCH', R + 'pm_assets?id=eq.x', { who: ADMIN, origin: null, body: { name: 'x' } });
        eq([noOrigin.status, noOrigin.up.length], [403, 0], 'admin write without this host as Origin: refused');
        const evil = await call('PATCH', R + 'pm_assets?id=eq.x', { who: ADMIN, origin: 'https://evil.example', body: { name: 'x' } });
        eq([evil.status, evil.up.length], [403, 0], 'admin write from another Origin: refused');
        const w = await call('PATCH', R + 'pm_assets?id=eq.x', { who: ADMIN, body: { name: 'New' }, extra: { Prefer: 'return=representation' } });
        eq(w.status, 200, 'admin PATCH passes');
        eq(w.up.length, 1, 'one upstream write');
        eq([w.up[0].method, w.up[0].url], ['PATCH', PM + '/rest/v1/pm_assets?id=eq.x'], 'PATCH target');
        eq(w.up[0].headers.apikey, WRITE_KEY, 'write key upstream');
        eq(w.up[0].headers['Content-Profile'], 'public', 'Content-Profile set');
        eq(JSON.parse(w.up[0].body), { name: 'New' }, 'body forwarded');
        const ups = await call('POST', R + 'pm_substations?on_conflict=asset_id', { who: ADMIN, body: { asset_id: 'a' }, extra: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
        eq([ups.status, ups.up[0].headers.Prefer], [201, 'resolution=merge-duplicates,return=minimal'], 'admin upsert with its Prefer');
        const del = await call('DELETE', R + 'pm_transformers?substation_asset_id=eq.a', { who: ADMIN });
        eq([del.status, del.up[0].method, del.up[0].body], [200, 'DELETE', undefined], 'admin DELETE, no body upstream');
        const rpc = await call('POST', R + 'rpc/pm_admin_update_substation_bundle', { who: ADMIN, body: { p_ss: { id: 'a' } } });
        eq([rpc.status, rpc.up[0].url, rpc.up[0].headers.apikey], [201, PM + '/rest/v1/rpc/pm_admin_update_substation_bundle', WRITE_KEY], 'admin RPC with the write key');
        eq((await call('POST', R + 'rpc/exec_sql', { who: ADMIN, body: {} })).up.length, 0, 'admin: an RPC outside the list never goes upstream');
        eq((await call('PATCH', R + 'pm_v_substations?id=eq.a', { who: ADMIN, body: {} })).status, 404, 'admin: read views are not writable');
        eq((await call('GET', R + 'rpc/pm_admin_update_substation_bundle', { who: ADMIN })).status, 404, 'admin: RPC by GET refused');

        // Editor accounts: admin only, and the PIN hash never leaves the server.
        const eds = await call('GET', R + 'pm_editors?select=*&active=eq.true', { who: ADMIN });
        eq(eds.status, 200, 'admin lists editors');
        ok(eds.json.length === 1 && !('pin_hash' in eds.json[0]) && !eds.text.includes('deadbeef'), 'pin_hash stripped');
        eq(eds.up[0].headers.apikey, WRITE_KEY, 'editor reads use the write key');
        eq((await call('GET', R + 'pm_editors?select=id&pin_hash=eq.abc', { who: ADMIN })).up.length, 0, 'filtering on pin_hash refused');
        eq((await call('GET', R + 'pm_editors?select=id&pin%5Fhash=eq.abc', { who: ADMIN })).up.length, 0, 'encoded pin_hash refused');

        // Static: the source folder is private, the build is served.
        for (const p of ['/power_map/powermap-v2/src/lib/supabase.ts', '/power_map/powermap-v2/src/data/legacyNetwork.json',
            '/power_map/powermap-v2/scripts/import-legacy.mjs', '/power_map/powermap-v2/package.json', '/power_map/%70owermap-v2/vercel.json',
            '/POWER_MAP/POWERMAP-V2/package.json', '/power_map/powermap-v2']) {
            eq((await call('GET', p)).status, 404, `not served: ${p}`);
        }
        eq((await call('GET', '/power_map/v2/index.html')).status, 200, 'the build is served');
    } finally {
        srv.close();
    }
}

main().then(() => {
    console.log(`test-powermap-proxy: ${checks} checks passed`);
    process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
