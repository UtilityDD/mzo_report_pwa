#!/usr/bin/env node
'use strict';
// Test of GET /api/admin/sources-info (Admin → Sources), with no network: PocketBase is answered by a
// stand-in fetch, and any other upstream request fails the test.
//
//   node vm/dev/test-sources-info.js
//
// It runs server.js in child processes and checks:
//   - access: no session 401, a non-admin 403, role admin and isAdmin: true 200;
//   - without mirror mode (Vercel, local): a static answer, no PocketBase request, every source read live,
//     the report list from the app.html NAV;
//   - in mirror mode with PocketBase: categories (VM copy, sensitive live, VM only), schedule, next due,
//     overdue / stale / error, the data editor's mode (missing = mirror), the latest run and failures,
//     report freshness (the oldest of its copies), and that keys in errors are scrubbed;
//   - in mirror mode with PocketBase down: still 200, with the registry marked unavailable.
// Also unit-checks nextDue() and parseNav() of lib/sources_info.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PB = 'http://pb.test:8090';
const NOW = Number(process.env.TEST_NOW) || Date.now(); // the children use the parent's clock for the fixtures
const pbDate = (t) => new Date(t).toISOString().replace('T', ' ');
const MIN = 60000;

// ---- Fixtures ----------------------------------------------------------------------------------
const REGISTRY = [
    { key: 'nsc_pending', schedule: 'frequent', last_status: 'unchanged', last_checked_at: pbDate(NOW - 2 * MIN), last_fetched_at: pbDate(NOW - 2 * MIN),
        last_synced_at: pbDate(NOW - 3 * 3600e3), snapshot_at: pbDate(NOW - 3 * 3600e3), source_modified_at: pbDate(NOW - 24 * 3600e3), row_count: 4807, pages: ['nsc.html'] },
    { key: 'withheld', schedule: 'frequent', last_status: 'error', last_error: 'GET https://x.test/a?apikey=SECRET123 failed', last_checked_at: pbDate(NOW - 3 * MIN), last_fetched_at: pbDate(NOW - 2 * 3600e3), row_count: 10 },
    { key: 'meter_erp', schedule: 'daily', last_status: 'unchanged', last_checked_at: pbDate(NOW - 40 * 3600e3), last_fetched_at: pbDate(NOW - 40 * 3600e3), row_count: 240525 },
    { key: 'dtr_peak_load', schedule: 'frequent', last_status: 'ok', last_checked_at: pbDate(NOW - 90 * MIN), mode: 'native', native_since: pbDate(NOW - 86400e3), native_by: 'tester', row_count: 91 },
    { key: 'manpower_staff', schedule: 'hourly', last_status: 'unchanged', last_checked_at: pbDate(NOW - 10 * MIN), row_count: 818 },
    { key: 'stock_snapshot', schedule: 'frequent', last_status: 'unchanged', last_checked_at: pbDate(NOW - 1 * MIN), row_count: 947 },
    { key: 'power_map_substations', schedule: 'hourly', last_status: 'unchanged', last_checked_at: pbDate(NOW - 20 * MIN), row_count: 98 },
    { key: 'structure', schedule: 'daily', last_status: 'unchanged', last_checked_at: pbDate(NOW - 5 * 3600e3), row_count: 26 }
];
const RUNS = [
    { dataset: 'nsc_pending', started_at: pbDate(NOW - 2 * MIN), finished_at: pbDate(NOW - 2 * MIN + 900), status: 'unchanged', message: 'version unchanged', duration_ms: 900 },
    { dataset: 'nsc_pending', started_at: pbDate(NOW - 7 * MIN), finished_at: pbDate(NOW - 7 * MIN + 900), status: 'ok', message: 'older', duration_ms: 900 }
];
const FAILURES = [
    { dataset: 'withheld', started_at: pbDate(NOW - 3 * MIN), status: 'error', message: 'token=abc.def leaked eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig' },
    { dataset: 'withheld', started_at: pbDate(NOW - 90 * MIN), status: 'error', message: 'Google answered HTTP 400' }
];
const SNAPSHOTS = ['nsc_pending', 'withheld', 'meter_erp', 'dtr_peak_load', 'stock_snapshot', 'power_map_substations', 'structure'];

// ---- Child: one server, one configuration ---------------------------------------------------------
async function child(out) {
    const realFetch = global.fetch;
    const problems = [];
    const pbCalls = [];
    global.fetch = async (input, opts) => {
        const url = String(input && input.url ? input.url : input);
        const method = String((opts && opts.method) || 'GET').toUpperCase();
        if (url.startsWith('http://127.0.0.1:')) return realFetch(input, opts);
        const json = (v, status) => new Response(JSON.stringify(v), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
        if (url.startsWith(PB)) {
            pbCalls.push(`${method} ${url.slice(PB.length).split('?')[0]}`);
            if (process.env.TEST_PB_DOWN) throw new TypeError('fetch failed');
            if (method === 'POST' && url.endsWith('/api/collections/_superusers/auth-with-password')) return json({ token: 'tok' });
            if (method !== 'GET') { problems.push(`WRITE ${method} ${url}`); return json({}, 599); }
            const u = new URL(url);
            if (u.pathname === '/api/collections/sys_datasets/records') return json({ items: REGISTRY });
            if (u.pathname === '/api/collections/sys_sync_runs/records') {
                const f = u.searchParams.get('filter') || '';
                return json({ items: /status = "error"/.test(f) ? FAILURES : RUNS });
            }
            problems.push(`unknown PB ${url}`);
            return json({}, 404);
        }
        problems.push(`upstream ${method} ${url}`);
        return new Response('{"message":"refused by the test"}', { status: 599 });
    };
    const app = require(path.join(ROOT, 'server.js'));
    const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const cookie = (profile) => {
        const payload = Buffer.from(JSON.stringify({ profile, expiry: Date.now() + 3600e3 })).toString('base64');
        return `mzo_session=${encodeURIComponent(payload + '.' + crypto.createHmac('sha256', 'mzo-portal-super-secret-key-123456').update(payload).digest('base64'))}`;
    };
    const who = {
        anon: null,
        viewer: { Username: 'viewer', role: 'viewer' },
        flagged: { Username: 'flagged', role: 'viewer', isAdmin: true },
        admin: { Username: 'admin', role: 'admin' }
    };
    const results = {};
    for (const [name, profile] of Object.entries(who)) {
        const headers = { Accept: 'application/json' };
        if (profile) headers.Cookie = cookie(profile);
        const res = await realFetch(`http://127.0.0.1:${srv.address().port}/api/admin/sources-info`, { headers });
        results[name] = { status: res.status, body: await res.text() };
    }
    srv.close();
    fs.writeFileSync(out, JSON.stringify({ results, problems, pbCalls }));
    process.exit(0);
}

function run(name, tmp, env) {
    const out = path.join(tmp, `${name}.json`);
    const full = Object.assign({ PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'UTC', TEST_NOW: String(NOW) }, env);
    const r = spawnSync(process.execPath, [__filename, '--child', out], { env: full, encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`${name} server failed:\n${r.stdout}\n${r.stderr}`);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function writeSnapshots(dir) {
    const datasets = {};
    SNAPSHOTS.forEach((key) => {
        datasets[key] = { version: key + '-v', bytes: 1234, file: key + '.csv', fetchedAt: new Date(NOW - 5 * MIN).toISOString(),
            snapshotAt: new Date(NOW - 6 * 3600e3).toISOString(), checkedAt: new Date(NOW - 5 * MIN).toISOString(), sourceType: 'google_sheet',
            dataHubKeys: [], urls: [], sensitive: false, label: key, rows: 5 };
        fs.writeFileSync(path.join(dir, key + '.csv'), 'a\n1\n');
    });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ generatedAt: new Date(NOW - MIN).toISOString(), datasets }));
}

function main() {
    let checks = 0;
    const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
    const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks++; };

    // ---- Unit: schedule and NAV parsing
    const SI = require(path.join(ROOT, 'lib', 'sources_info.js'));
    const at = (s) => Date.parse(s);
    eq(SI.nextDue('frequent', '2026-11-06T04:00:00.000Z', 'ok'), at('2026-11-06T04:05:00.000Z'), 'frequent: +5 min');
    eq(SI.nextDue('hourly', '2026-11-06T04:00:00.000Z', 'error'), at('2026-11-06T05:00:00.000Z'), 'hourly error: retry within the hour');
    // 02:30 IST on 6 Nov = 21:00 UTC on 5 Nov → next 02:00 IST on 7 Nov = 20:30 UTC on 6 Nov
    eq(SI.nextDue('daily', '2026-11-05T21:00:00.000Z', 'ok'), at('2026-11-06T20:30:00.000Z'), 'daily after 02:00 IST: next night');
    // 01:00 IST on 6 Nov = 19:30 UTC on 5 Nov → 02:00 IST the same night = 20:30 UTC on 5 Nov
    eq(SI.nextDue('daily', '2026-11-05T19:30:00.000Z', 'ok'), at('2026-11-05T20:30:00.000Z'), 'daily before 02:00 IST: the same night');
    eq(SI.nextDue('daily', null, 'ok'), null, 'never checked');
    const sched = require(path.join(ROOT, 'vm', 'sync', 'lib', 'schedule.js'));
    eq(SI.INTERVAL_MS, sched.INTERVAL_MS, 'intervals match vm/sync/lib/schedule.js');
    const nav = SI.parseNav(fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8'));
    ok(nav.length >= 55, `NAV parsed (${nav.length} items)`);
    ok(nav.some((n) => n.page === 'executive_briefing.html') && nav.some((n) => n.page === 'assistant.html'), 'NAV: Briefing and Ask');
    ok(nav.some((n) => n.page === 'admin_users.html?tab=sources' && n.group === 'Administration'), 'NAV: Admin → Sources');
    ok(nav.every((n) => n.id && n.label && n.page), 'NAV: every item has id, label and page');
    ok(!/apikey=SECRET/.test(SI.scrub('x?apikey=SECRET&y=1')), 'scrub: query key');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-sources-info-test-'));
    const snap = path.join(tmp, 'snapshots');
    fs.mkdirSync(snap);
    writeSnapshots(snap);
    const PBENV = { PB_URL: PB, PB_SUPERUSER_EMAIL: 'su@test', PB_SUPERUSER_PASSWORD: 'pw' };

    // ---- Static (no mirror): PocketBase configured but not read
    const st = run('static', tmp, PBENV);
    eq(st.problems, [], 'static: unexpected upstream requests');
    eq(st.pbCalls, [], 'static: PocketBase must not be read outside mirror mode');
    eq(st.results.anon.status, 401, 'static: no session');
    eq(st.results.viewer.status, 403, 'static: non-admin');
    eq(st.results.flagged.status, 200, 'static: isAdmin flag');
    eq(st.results.admin.status, 200, 'static: admin');
    const S = JSON.parse(st.results.admin.body);
    eq(S.mode, 'static', 'static: mode');
    eq(S.mirror.on, false, 'static: mirror off');
    ok(S.datasets.length >= 120, `static: datasets (${S.datasets.length})`);
    ok(S.reports.length >= 55, `static: reports (${S.reports.length})`);
    const sd = Object.fromEntries(S.datasets.map((d) => [d.key, d]));
    eq(sd.nsc_pending.category, 'live_google', 'static: a sheet is read live');
    eq(sd.stock_snapshot.category, 'live_supabase', 'static: a Storage file is read live');
    eq(sd.costcenter.category, 'vm_only', 'static: a repo file');
    eq(sd.nsc_pending.status, 'live', 'static: status');
    ok(sd.script_dd_visit && sd.script_dd_visit.category === 'live_script', 'static: descriptor rows');
    ok(!S.datasets.some((d) => /^vm_(google|supabase)/.test(d.category)), 'static: no VM copies');
    ok(S.categories.find((c) => c.id === 'vm_only').label === 'Server only', 'static: VM only is "Server only"');

    // ---- Mirror mode with PocketBase
    const mi = run('mirror', tmp, Object.assign({ MZO_DATA_MODE: 'mirror', MZO_SNAPSHOT_DIR: snap }, PBENV));
    eq(mi.problems, [], 'mirror: unexpected upstream requests');
    ok(mi.pbCalls.length >= 3 && mi.pbCalls.every((c) => c.startsWith('GET ') || c.endsWith('/auth-with-password')), 'mirror: PocketBase reads are GETs (plus sign-in)');
    eq([mi.results.anon.status, mi.results.viewer.status, mi.results.flagged.status, mi.results.admin.status], [401, 403, 200, 200], 'mirror: access');
    const M = JSON.parse(mi.results.admin.body);
    ok(!/SECRET123|abc\.def|eyJhbGciOiJIUzI1NiJ9\.eyJ/.test(mi.results.admin.body), 'mirror: keys and tokens are scrubbed');
    eq(M.mode, 'mirror', 'mirror: mode');
    eq(M.pocketbase.ok, true, 'mirror: registry read');
    eq(M.mirror.snapshots, SNAPSHOTS.length, 'mirror: manifest');
    ['status', 'generatedAt', 'categories', 'schedules', 'datasets', 'reports', 'timerMinutes'].forEach((k) => ok(k in M, `shape: ${k}`));
    const md = Object.fromEntries(M.datasets.map((d) => [d.key, d]));
    ['key', 'label', 'group', 'category', 'sourceType', 'sourceUrl', 'schedule', 'scheduleText', 'sensitive', 'mode', 'copy', 'checkedAt', 'fetchedAt',
        'changedAt', 'nextDueAt', 'lastStatus', 'lastError', 'lastRun', 'failures7d', 'rows', 'bytes', 'pages', 'status', 'overdue', 'stale', 'error']
        .forEach((k) => ok(k in md.nsc_pending, `shape: dataset.${k}`));
    const n = md.nsc_pending;
    eq([n.category, n.status, n.copy, n.mode, n.scheduleText], ['vm_google', 'ok', 'snapshot', 'mirror', 'Every 5 min'], 'nsc_pending');
    eq(Date.parse(n.nextDueAt) - Date.parse(n.checkedAt), 5 * MIN, 'nsc_pending: next due');
    eq(n.lastRun.message, 'version unchanged', 'nsc_pending: latest run');
    eq(n.rows, 4807, 'nsc_pending: rows from the registry');
    eq(n.changedAt, new Date(NOW - 24 * 3600e3).toISOString(), 'nsc_pending: source change time');
    ok(md.nsc_pending.sourceUrl.startsWith('https://docs.google.com/spreadsheets/d/'), 'nsc_pending: link to the sheet');
    eq([md.withheld.status, md.withheld.error], ['error', true], 'withheld: error');
    eq(md.withheld.failures7d.count, 2, 'withheld: failures in 7 days');
    eq([md.meter_erp.status, md.meter_erp.overdue, md.meter_erp.stale], ['overdue', true, true], 'meter_erp: overdue');
    eq([md.dtr_peak_load.mode, md.dtr_peak_load.nativeBy, md.dtr_peak_load.status, md.dtr_peak_load.overdue], ['native', 'tester', 'ok', false], 'dtr_peak_load: native');
    eq([md.manpower_staff.category, md.manpower_staff.sensitive, md.manpower_staff.status, md.manpower_staff.copy], ['live_google', true, 'live', 'portal'], 'manpower_staff: sensitive');
    eq(md.stock_snapshot.category, 'vm_supabase_storage', 'stock_snapshot');
    eq(md.power_map_substations.category, 'vm_supabase_table', 'power_map_substations');
    eq([md.structure.category, md.structure.status], ['vm_only', 'ok'], 'structure');
    eq(md.consumers.status, 'never', 'consumers: not in the registry yet');
    eq(md.ask_api.status, 'off', 'ask: no ANTHROPIC_API_KEY');
    eq(md.crm_unbilled_files.category, 'vm_only', 'unbilled: server files');
    const R = Object.fromEntries(M.reports.map((r) => [r.page, r]));
    ok(R['nsc.html'].sources.includes('nsc_pending') && R['nsc.html'].sources.includes('script_nsc_followups') && !R['nsc.html'].sources.includes('nsc_followups'), 'report nsc.html: sources');
    eq(R['nsc.html'].category, 'mixed', 'report nsc.html: mixed');
    eq(R['si-works/si.html'].categories, ['live_supabase'], 'report si.html: live Supabase');
    eq(R['meter_utilization.html'].freshAt, md.meter_erp.checkedAt, 'report meter_utilization: oldest copy');
    eq(R['meter_utilization.html'].status, 'overdue', 'report meter_utilization: worst status');
    eq(R['health_checkup.html'].categories, ['none'], 'report health check-up: no data');
    ok(R['performance_index.html'].sources.length >= 30, 'report performance index: rating inputs');
    ok(!M.reports.some((r, i) => M.reports.findIndex((x) => x.page === r.page) !== i), 'reports: one row per page');

    // ---- Mirror mode, PocketBase down
    const down = run('pbdown', tmp, Object.assign({ MZO_DATA_MODE: 'mirror', MZO_SNAPSHOT_DIR: snap, TEST_PB_DOWN: '1' }, PBENV));
    eq(down.results.admin.status, 200, 'PocketBase down: still answers');
    const D = JSON.parse(down.results.admin.body);
    eq([D.mode, D.pocketbase.ok], ['mirror', false], 'PocketBase down: marked');
    ok(D.pocketbase.error && !/pw|su@test/.test(D.pocketbase.error), 'PocketBase down: error without credentials');
    const dd = Object.fromEntries(D.datasets.map((d) => [d.key, d]));
    eq([dd.nsc_pending.category, dd.nsc_pending.checkedAt], ['vm_google', new Date(NOW - 5 * MIN).toISOString()], 'PocketBase down: manifest times');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`sources-info test: ${checks} checks passed`);
}

if (process.argv[2] === '--child') {
    child(process.argv[3]).catch((err) => { console.error(err); process.exit(1); });
} else {
    try {
        main();
    } catch (err) {
        console.error('FAIL:', err.message);
        process.exitCode = 1;
    }
}
