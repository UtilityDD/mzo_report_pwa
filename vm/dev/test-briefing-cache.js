#!/usr/bin/env node
'use strict';
// Test of the Briefing cache in mirror mode (stale-while-revalidate), with no network: the report
// meta, the NSC upload meta and the sync job's sheet come from fixtures (answered slowly, like the
// real sources), the clock is simulated, the write-through sync is stubbed (no vm/sync run) and
// files the server would write under data/ go to a temporary folder.
//
//   node vm/dev/test-briefing-cache.js
//
// Mirror mode: a cold start computes; under 2 min the cached Briefing is answered at once; between
// 2 and 10 min it is answered at once and refreshed in the background, one refresh for many requests;
// over 10 min it is computed again; a sync button (a write-through on pending_mc) refreshes it with the
// new numbers. Original mode: computed on every request, as before.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const REPORTS = 'https://reports.test/storage/v1/object/public/reports';
const NSC_SCRIPT = 'https://script.test/nsc';
const PENDING_MC_CSV = 'https://sheets.test/pending_mc.csv';
const SLOW_MS = 300; // each upstream answer takes this long

const REPORT_META = {
    pending_mc: { version: 'v1', reportDate: '28/10/2026', stats: { totalPending: 4, delayed90: 1, industrial: 0, divisions: { Malda: 4 } }, source: 'supabase_storage' },
    load_extension: { version: 'v1', reportDate: '28/10/2026', stats: { totalPending: 2, ageing1y: 1, divisions: {} }, source: 'supabase_storage' },
    disconnection: { version: 'v1', reportDate: '04/10/2026', stats: { noAction: { count: 1, amount: 100 }, divisions: {} }, source: 'supabase_storage' },
    defective: { version: 'v1', reportDate: '16/10/2026', stats: { totalDefective: 5, over10: 2, divisions: {} }, source: 'supabase_storage' }
};
// The sheet the Pending MC sync button reads: 3 pending, 2 of them over 90 days, 1 industrial.
const PENDING_MC_SHEET = [
    'Region,Division,CLASS,Report Date,Meter Installation Date',
    'Malda,Malda,Industrial,30/10/2026,01/01/2026',
    'Malda,Chanchal,Domestic,30/10/2026,01/02/2026',
    'Raiganj,Raiganj,Domestic,30/10/2026,20/10/2026'
].join('\n') + '\n';

// ---- Child: one server, one mode ------------------------------------------------------------------
async function child(out) {
    // Files the server writes under data/ (local meta and log caches) go to a temporary folder instead.
    const DATA = path.join(ROOT, 'data') + path.sep;
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-test-data-'));
    const inData = (p) => (path.resolve(String(p)) + path.sep).startsWith(DATA);
    const moved = (p) => path.join(sandbox, path.relative(DATA, path.resolve(String(p))));
    const { writeFileSync, mkdirSync, readFileSync } = fs;
    fs.writeFileSync = (p, ...a) => writeFileSync(inData(p) ? moved(p) : p, ...a);
    fs.mkdirSync = (p, ...a) => (inData(p) ? undefined : mkdirSync(p, ...a));
    fs.readFileSync = (p, ...a) => readFileSync(inData(p) && fs.existsSync(moved(p)) ? moved(p) : p, ...a);
    // The server's data folder (uploaded datasets and their meta) is the empty sandbox, not a checkout's data/.
    process.env.MZO_FILES_DIR = sandbox;

    // Simulated clock (minutes go by in milliseconds).
    let offset = 0;
    const realNow = Date.now;
    Date.now = () => realNow() + offset;

    // The write-through sync is recorded, never run.
    const spawned = [];
    require('child_process').spawn = (cmd, args) => {
        spawned.push(args.join(' '));
        const c = new EventEmitter();
        c.pid = 999999;
        c.unref = () => {};
        c.kill = () => {};
        setTimeout(() => c.emit('exit', 0, null), 5);
        return c;
    };

    const realFetch = global.fetch;
    const upstream = [];
    global.fetch = async (input, opts) => {
        const url = String(input && input.url ? input.url : input);
        const method = String((opts && opts.method) || 'GET').toUpperCase();
        if (url.startsWith('http://127.0.0.1:')) return realFetch(input, opts);
        upstream.push(`${method} ${url}`);
        await new Promise((r) => setTimeout(r, SLOW_MS));
        const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (method !== 'GET') return new Response('{"message":"write refused by the test"}', { status: 599 });
        for (const folder of Object.keys(REPORT_META)) if (url === `${REPORTS}/${folder}/meta.json`) return json(REPORT_META[folder]);
        if (url === `${NSC_SCRIPT}?meta=1`) return json({ status: 'ok', meta: { reportDate: '29/10/2026', stats: { today: '29/10/2026', withheldRows: 3 }, withheldRows: 3 } });
        if (url === PENDING_MC_CSV) return new Response(PENDING_MC_SHEET, { status: 200, headers: { 'Content-Type': 'text/csv' } });
        if (url.includes('/rest/v1/portal_users?')) return json([]);
        return new Response('{"message":"unknown to the test"}', { status: 599 });
    };

    const app = require(process.env.TEST_SERVER || path.join(ROOT, 'server.js'));
    const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const payload = Buffer.from(JSON.stringify({ profile: { Username: 'local-preview', Name: 'Local Preview', role: 'admin', office_level: 'CE' }, expiry: realNow() + 3600e3 })).toString('base64');
    const cookie = `mzo_session=${encodeURIComponent(payload + '.' + crypto.createHmac('sha256', 'mzo-portal-super-secret-key-123456').update(payload).digest('base64'))}`;
    const base = `http://127.0.0.1:${srv.address().port}`;
    const steps = [];
    const get = async (label) => {
        const before = upstream.filter((u) => u.includes('/meta.json')).length;
        const t0 = realNow();
        const res = await realFetch(`${base}/api/executive/briefing`, { headers: { Cookie: cookie } });
        const j = await res.json();
        const step = {
            label, status: res.status, ms: realNow() - t0, cc: res.headers.get('cache-control'),
            generatedAt: j.briefing && j.briefing.generatedAt, briefing: j.briefing,
            metaFetches: upstream.filter((u) => u.includes('/meta.json')).length - before,
            metaTotal: upstream.filter((u) => u.includes('/meta.json')).length
        };
        steps.push(step);
        return step;
    };
    const minutes = (m) => { offset += m * 60 * 1000; };
    const settle = () => new Promise((r) => setTimeout(r, SLOW_MS * 3));

    await get('cold');
    minutes(0.5);
    await get('30s');
    minutes(2.5); // 3 min old: stale
    await Promise.all([get('3min-a'), get('3min-b'), get('3min-c')]);
    await settle();
    await get('after-background');
    minutes(12); // 12 min after the background refresh: too old
    await get('15min');
    let sync = null;
    if (process.env.MZO_DATA_MODE === 'mirror') {
        minutes(0.5);
        const r = await realFetch(`${base}/api/pending-mc/sync`, { method: 'POST', headers: { Cookie: cookie, Accept: 'application/json', Origin: base } });
        sync = { status: r.status, body: await r.json() };
        await get('right-after-sync');
        await settle();
        await get('after-sync-refresh');
        await new Promise((r) => setTimeout(r, 2500)); // write-through runs after its 2 s debounce
    }
    srv.close();
    fs.writeFileSync(out, JSON.stringify({ steps, sync, spawned, upstream }));
    fs.rmSync(sandbox, { recursive: true, force: true });
    process.exit(0);
}

function runMode(mode, tmp) {
    const out = path.join(tmp, `${mode}.json`);
    const env = {
        PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'UTC',
        NSC_SHEET_SCRIPT_URL: NSC_SCRIPT, REPORTS_PUBLIC_BASE: REPORTS, PENDING_MC_SHEET_CSV_URL: PENDING_MC_CSV,
        METADATA_SCRIPT_URL: 'https://script.test/metadata'
    };
    if (process.env.TEST_SERVER) env.TEST_SERVER = process.env.TEST_SERVER;
    if (mode === 'mirror') {
        const snap = path.join(tmp, 'snapshots');
        fs.mkdirSync(snap, { recursive: true });
        Object.assign(env, { MZO_DATA_MODE: 'mirror', MZO_SNAPSHOT_DIR: snap });
    }
    const r = spawnSync(process.execPath, [__filename, '--child', out], { env, encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`${mode} server failed:\n${r.stdout}\n${r.stderr}`);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function main() {
    let checks = 0;
    const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
    const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks++; };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-briefing-test-'));
    const M = runMode('mirror', tmp);
    const O = runMode('original', tmp);
    const step = (X, label) => X.steps.find((s) => s.label === label);
    const FAST = SLOW_MS / 2;
    const metric = (b, id) => (b.items.find((i) => i.id === id) || {}).metric;

    // ---- Mirror mode ------------------------------------------------------------------------------
    M.steps.forEach((s) => eq(s.status, 200, `mirror ${s.label}: HTTP ${s.status}`));
    M.steps.forEach((s) => eq(s.cc, 'private, max-age=30, must-revalidate', `mirror ${s.label}: Cache-Control unchanged`));
    const cold = step(M, 'cold');
    ok(cold.ms >= SLOW_MS && cold.metaFetches === 4, `cold start computes (${cold.ms} ms, ${cold.metaFetches} meta reads)`);
    const s30 = step(M, '30s');
    ok(s30.ms < FAST && s30.metaFetches === 0 && s30.generatedAt === cold.generatedAt, `under 2 min: cached, at once (${s30.ms} ms)`);
    const stale = ['3min-a', '3min-b', '3min-c'].map((l) => step(M, l));
    ok(stale.every((s) => s.ms < FAST && s.generatedAt === cold.generatedAt), `2-10 min: the cached one at once (${stale.map((s) => s.ms).join('/')} ms)`);
    const bg = step(M, 'after-background');
    ok(bg.ms < FAST && bg.generatedAt !== cold.generatedAt, 'the background refresh replaced it');
    eq(bg.metaTotal - s30.metaTotal, 4, 'one background refresh for three requests (single-flight)');
    const old = step(M, '15min');
    ok(old.ms >= SLOW_MS && old.generatedAt !== bg.generatedAt, `over 10 min: computed again before answering (${old.ms} ms)`);
    eq(M.sync.status, 200, 'Pending MC sync button');
    ok(M.spawned.some((a) => /run\.js --only pending_mc --reason/.test(a)), 'the sync button started the write-through refresh');
    const right = step(M, 'right-after-sync');
    ok(right.ms < FAST, `right after the sync: still answered at once (${right.ms} ms)`);
    const after = step(M, 'after-sync-refresh');
    const stats = M.sync.body.meta.stats;
    ok(after.generatedAt !== old.generatedAt, 'the write-through refreshed the Briefing');
    eq(metric(after.briefing, 'mc-delayed-90'), stats.delayed90.toLocaleString(), 'the Briefing shows the new Pending MC numbers');
    eq(metric(after.briefing, 'mc-industrial-pending'), String(stats.industrial), '… and the new industrial count');
    ok(metric(old.briefing, 'mc-delayed-90') !== metric(after.briefing, 'mc-delayed-90'), 'the fixture numbers really changed');
    eq(M.upstream.filter((u) => !u.startsWith('GET ') && !u.endsWith('/activity_logs')), [], 'no upstream writes besides the refused activity rows');

    // ---- Original mode: computed on every request, same shape ------------------------------------
    O.steps.forEach((s) => eq(s.status, 200, `original ${s.label}: HTTP ${s.status}`));
    // (Concurrent requests may finish in the same millisecond, so only the sequential ones are compared.)
    const gens = ['cold', '30s', 'after-background', '15min'].map((l) => step(O, l).generatedAt);
    eq(new Set(gens).size, gens.length, 'original: a new Briefing on every request (no cache)');
    const strip = (b) => Object.assign({}, b, { generatedAt: null });
    eq(strip(step(O, 'cold').briefing), strip(cold.briefing), 'same Briefing in both modes');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`briefing cache test: ${checks} checks passed`);
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
