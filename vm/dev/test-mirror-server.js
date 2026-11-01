#!/usr/bin/env node
'use strict';
// Test of the server's mirror mode, with no network: every upstream request (Supabase, Google,
// Apps Script, the reports bucket) is answered from fixtures by a stand-in fetch, and any upstream
// write fails the test.
//
//   node vm/dev/test-mirror-server.js
//
// It runs server.js twice in child processes, in original mode and in mirror mode on a temporary
// snapshot folder holding the same data, then checks that:
//   - original mode has no mirror fields (no liveVersions, no X-Mzo-Data) and the manifest answers 204;
//   - /api/power-map/data, the allotment list and the unbilled months are byte-identical in both modes;
//   - the meta endpoints and /api/hub/versions take versions from the manifest in mirror mode, and
//     return the version original mode gives as liveVersions;
//   - apart from the fields mirror mode is meant to change, the JSON responses are equal.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const OLD = 'https://unsmtschmcvftfqwabaq.supabase.co/rest/v1/';
const REPORTS = 'https://reports.test/storage/v1/object/public/reports';
const NSC_SCRIPT = 'https://script.test/nsc';
const METADATA_SCRIPT = 'https://script.test/metadata';
const NSC_PEEK = 'https://docs.google.com/spreadsheets/d/1QnmPKSAtwmW-m1-gn4qmZBWanx9_Vwbk63XhwyQBiKU/gviz/tq?tqx=out:csv&sheet=nsc_working&range=A1:AZ2';

// ---- Fixtures (the same data for the live stand-in and the snapshots) ----------------------------
const pm = (id, sub, extra, updated) => Object.assign({
    id, Region: 'Malda', Division: 'Malda', Substation: sub, MVA: '10', LATITUDE: "N25°00.026'", LONGITUDE: "E88°05.038'",
    'Connected to': 'Ghorapir GSS', Colour: 'red', RL: '', LineStyle: 'solid', 'Para-1': '', 'Para-2': '', 'Para-3': '',
    Comment: 'red', Symbol: '⬤', SymbolSize: 15, LegendText: '', LegendSymbol: '', LegendColour: '', Remarks: 'Existing',
    ConductorSize: null, PeakLoad: null, updated_at: updated
}, extra);
const PM_ROWS = [
    pm(1, 'Englishbazar', {}, '2026-07-24T12:05:59.97+00:00'),
    pm(2, 'Kaliachak, Old', { Comment: 'says "hi"' }, '2026-07-24T12:05:59.978123+00:00'),
    pm(3, '', {}, '2026-06-01T00:00:00+00:00')
];
const PM_LATEST = '2026-07-24T12:05:59.978123+00:00';
const ALLOT_ROWS = [
    { id: 7, allotment_no: 'MZO/ALT/2026/0002', date: '2026-09-21', movement_type: 'Diversion', from_store: 'Malda (D) Division', division: 'Raiganj (D) Division', material_code: '401', allotted_qty: 5, created_at: '2026-09-21T05:00:00+00:00', status: 'active' },
    { id: 9, allotment_no: 'MZO/ALT/2026/0002', date: '2026-09-21', movement_type: 'Diversion', from_store: 'Malda (D) Division', division: 'Raiganj (D) Division', material_code: '402', allotted_qty: 2, created_at: '2026-09-21T05:00:00+00:00', status: 'active' },
    { id: 3, allotment_no: 'MZO/ALT/2026/0001', date: '2026-09-02', movement_type: 'Transfer', from_store: 'Gazole', division: 'Malda', material_code: '403', allotted_qty: 1, created_at: '2026-09-02T05:00:00+00:00', status: 'cancelled', cancelled_by: 'x' }
];
const UNBILLED_ROWS = [
    { id: 1, label: 'July', sheet_id: 's1', gid: '0', sort_order: 1, active: true },
    { id: 2, label: 'August', sheet_id: 's2', gid: '5', sort_order: 2, active: false },
    { id: 3, label: 'September', sheet_id: 's3', gid: null, sort_order: 3, active: true }
];
const STOCK_META = { id: 16, uploaded_at: '2026-09-14T05:50:10.782241+00:00', uploaded_by: 'Aritra', original_name: 'Stock.xlsx', sheet_name: 'Sheet1', published_rows: 2, report_date: '14/09/2026', stats: { today: '14/09/2026' }, is_active: true };
const REPORT_META = {
    defective: { version: 'v:20261016', reportDate: '16/10/2026', stats: { totalDefective: 5, over10: 2, divisions: {} }, summaryCsvUrl: `${REPORTS}/defective/summary.csv?v=20261016`, detailsCsvUrl: `${REPORTS}/defective/details.csv?v=20261016`, source: 'supabase_storage' },
    disconnection: { version: 'v:20261029050911', reportDate: '04/10/2026', stats: { totalConsumers: 3, noAction: { count: 1, amount: 100 } }, csvUrl: `${REPORTS}/disconnection/snapshot.csv?v=x`, source: 'supabase_storage' },
    pending_mc: { version: '2026-10-29T06:47:02.247Z', reportDate: '28/10/2026', stats: { totalPending: 4, delayed90: 1, divisions: { Malda: 4 } }, csvUrl: `${REPORTS}/pending_mc/snapshot.csv?v=y`, source: 'supabase_storage' },
    load_extension: { version: '2026-10-29T06:47:07.279Z', reportDate: '28/10/2026', stats: { totalPending: 2, ageing1y: 1, divisions: {} }, csvUrl: `${REPORTS}/load_extension/snapshot.csv?v=z`, source: 'supabase_storage' }
};
const NSC_META = { uploadedAt: '2026-10-30T10:00:00.000Z', uploadedBy: 'dm1', publishedRows: 2, withheldRows: 2, reportDate: '29/10/2026', stats: { today: '29/10/2026', withheldRows: 2 }, supabaseUploadId: 99, source: 'google_sheet' };
const NSC_CSV = '"APPL_NO","TODAY"\n"A1","30/10/2026"\n"A2","30/10/2026"\n';
const METADATA_VERSIONS = { CACHE_LOSS: 'm:2026-10-31T00:00:00Z' };

const SNAPSHOTS = {
    nsc_pending: { ext: 'csv', body: NSC_CSV, dataHubKeys: ['CACHE_NSC_v5'], sourceType: 'google_sheet' },
    withheld: { ext: 'csv', body: 'APPL_NO\nW1\nW2\n', dataHubKeys: ['CACHE_WITHHELD_v4'], sourceType: 'google_sheet' },
    stock_snapshot: { ext: 'csv', body: 'Plant,Material,Date\n3432,0101011011,10/30/2026\n3434,0101011011,10/30/2026\n', dataHubKeys: ['CACHE_STOCK'], sourceType: 'supabase_storage' },
    defective_summary: { ext: 'csv', body: 'CON_ID,DIV\n1,MALDA\n', dataHubKeys: ['CACHE_DEFECTIVE'], sourceType: 'supabase_storage' },
    defective_details: { ext: 'csv', body: 'CON_ID,AGE\n1,11\n', dataHubKeys: ['CACHE_DEFECTIVE_DETAILS'], sourceType: 'supabase_storage' },
    disconnection: { ext: 'csv', body: 'CON_ID,OSD\n1,100\n', dataHubKeys: ['CACHE_DISCONNECTION'], sourceType: 'supabase_storage' },
    pending_mc: { ext: 'csv', body: 'APPL_NO\nP1\n', dataHubKeys: ['CACHE_PENDING_MC'], sourceType: 'supabase_storage' },
    load_extension: { ext: 'csv', body: 'APPL_NO\nL1\n', dataHubKeys: ['CACHE_LOAD_EXT'], sourceType: 'supabase_storage' },
    loss_report: { ext: 'csv', body: 'CCC,LOSS\nMalda,9.5\n', dataHubKeys: ['CACHE_LOSS'], sourceType: 'google_sheet' },
    power_map_substations: { ext: 'json', body: JSON.stringify(PM_ROWS), dataHubKeys: ['CACHE_POWER_MAP'], dataHubUrl: '/api/power-map/data', sourceType: 'supabase_table' },
    stock_allotments: { ext: 'json', body: JSON.stringify(ALLOT_ROWS), dataHubKeys: [], sourceType: 'supabase_table' },
    important_unbilled_months: { ext: 'json', body: JSON.stringify(UNBILLED_ROWS), dataHubKeys: [], sourceType: 'supabase_table' }
};
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// ---- Stand-in for every upstream request ----------------------------------------------------------
function upstream(url, method) {
    const json = (v) => ({ status: 200, type: 'application/json', body: JSON.stringify(v) });
    if (method !== 'GET' && method !== 'HEAD') return { write: true };
    if (url.startsWith(OLD)) {
        const q = url.slice(OLD.length);
        if (q.startsWith('portal_users?')) return json([]);
        if (q === 'mzo_power_substations?select=*&limit=5000') return { status: 200, type: 'application/json', body: SNAPSHOTS.power_map_substations.body };
        if (q === 'mzo_power_substations?select=updated_at&order=updated_at.desc&limit=1') {
            const sorted = PM_ROWS.slice().sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || (b.updated_at > a.updated_at ? 1 : -1));
            return json([{ updated_at: sorted[0].updated_at }]);
        }
        if (q === 'mzo_power_substations?select=Substation') return json(PM_ROWS.map((r) => ({ Substation: r.Substation })));
        if (q === 'stock_allotments?select=*&order=date.desc,allotment_no.desc&limit=1000&offset=0') return { status: 200, type: 'application/json', body: SNAPSHOTS.stock_allotments.body };
        if (q.startsWith('stock_allotments?select=*&order=date.desc,allotment_no.desc&limit=1000&offset=')) return json([]);
        if (q === 'important_unbilled_months?select=*&order=sort_order.asc,id.asc') return { status: 200, type: 'application/json', body: SNAPSHOTS.important_unbilled_months.body };
        if (q === 'important_unbilled_months?select=*&order=sort_order.asc,id.asc&active=eq.true') return json(UNBILLED_ROWS.filter((r) => r.active === true));
        if (q === 'stock_upload_meta?is_active=eq.true&select=*&order=id.desc&limit=1') return json([STOCK_META]);
    }
    for (const folder of Object.keys(REPORT_META)) {
        if (url === `${REPORTS}/${folder}/meta.json`) return json(REPORT_META[folder]);
    }
    if (url === `${NSC_SCRIPT}?meta=1`) return json({ status: 'ok', meta: NSC_META });
    if (url === NSC_PEEK) return { status: 200, type: 'text/csv', body: NSC_CSV.split('\n').slice(0, 2).join('\n') + '\n' };
    if (url === METADATA_SCRIPT) return json({ status: 'success', versions: METADATA_VERSIONS });
    return null;
}

const ENDPOINTS = [
    'power-map/data', 'power-map/meta', 'nsc/meta', 'stock/meta', 'defective/meta', 'disconnection/meta',
    'pending-mc/meta', 'load-extension/meta', 'hub/versions', 'executive/briefing',
    'stock/allotment?action=listAllotments', 'stock/allotment?action=getAllotment&allotmentNo=MZO/ALT/2026/0002',
    'important-sheets/unbilled', 'important-sheets/unbilled?all=1', 'data/manifest'
];

// ---- Child: one server, one mode ------------------------------------------------------------------
async function child(out) {
    const realFetch = global.fetch;
    const problems = [];
    global.fetch = async (input, opts) => {
        const url = String(input && input.url ? input.url : input);
        const method = String((opts && opts.method) || 'GET').toUpperCase();
        if (url.startsWith('http://127.0.0.1:')) return realFetch(input, opts);
        const r = upstream(url, method);
        if (!r || r.write) {
            problems.push(`${r && r.write ? 'WRITE' : 'unknown'} ${method} ${url}`);
            return new Response('{"message":"refused by the test"}', { status: 599 });
        }
        return new Response(r.body, { status: r.status, headers: { 'Content-Type': r.type } });
    };
    const app = require(process.env.TEST_SERVER || path.join(ROOT, 'server.js'));
    const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const payload = Buffer.from(JSON.stringify({ profile: { Username: 'local-preview', Name: 'Local Preview', role: 'admin', office_level: 'CE' }, expiry: Date.now() + 3600e3 })).toString('base64');
    const cookie = `mzo_session=${encodeURIComponent(payload + '.' + crypto.createHmac('sha256', 'mzo-portal-super-secret-key-123456').update(payload).digest('base64'))}`;
    const results = {};
    for (const ep of ENDPOINTS) {
        const res = await realFetch(`http://127.0.0.1:${srv.address().port}/api/${ep}`, { headers: { Cookie: cookie } });
        results[ep] = { status: res.status, mirror: res.headers.get('x-mzo-data') || '', body: await res.text() };
    }
    srv.close();
    fs.writeFileSync(out, JSON.stringify({ results, problems }));
    process.exit(0);
}

function runMode(mode, snapDir, tmp) {
    const out = path.join(tmp, `${mode}.json`);
    const env = {
        PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'UTC',
        NSC_SHEET_SCRIPT_URL: NSC_SCRIPT, METADATA_SCRIPT_URL: METADATA_SCRIPT, REPORTS_PUBLIC_BASE: REPORTS,
        STOCK_ALLOTMENT_SCRIPT_URL: 'https://script.test/allotments'
    };
    if (process.env.TEST_SERVER) env.TEST_SERVER = process.env.TEST_SERVER;
    if (mode === 'mirror') Object.assign(env, { MZO_DATA_MODE: 'mirror', MZO_SNAPSHOT_DIR: snapDir });
    const r = spawnSync(process.execPath, [__filename, '--child', out], { env, encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`${mode} server failed:\n${r.stdout}\n${r.stderr}`);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function writeSnapshots(dir) {
    const datasets = {};
    for (const [key, s] of Object.entries(SNAPSHOTS)) {
        const file = `${key}.${s.ext}`;
        fs.writeFileSync(path.join(dir, file), s.body);
        fs.writeFileSync(path.join(dir, file + '.gz'), zlib.gzipSync(s.body));
        fs.writeFileSync(path.join(dir, file + '.br'), zlib.brotliCompressSync(s.body));
        datasets[key] = {
            version: sha1(s.body), bytes: Buffer.byteLength(s.body), file, sourceType: s.sourceType,
            contentType: s.ext === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
            dataHubKeys: s.dataHubKeys, urls: [], sensitive: false, fetchedAt: new Date().toISOString()
        };
        if (s.dataHubUrl) datasets[key].dataHubUrl = s.dataHubUrl;
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), datasets }));
    return datasets;
}

function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-mirror-test-'));
    const snapDir = path.join(tmp, 'snapshots');
    fs.mkdirSync(snapDir);
    const manifest = writeSnapshots(snapDir);
    const orig = runMode('original', snapDir, tmp);
    const mir = runMode('mirror', snapDir, tmp);
    const O = orig.results;
    const M = mir.results;
    const body = (r) => JSON.parse(r.body);
    let checks = 0;
    const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
    const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks++; };

    eq(orig.problems, [], 'original mode: unexpected or write upstream requests');
    eq(mir.problems, [], 'mirror mode: unexpected or write upstream requests');
    for (const ep of ENDPOINTS) {
        ok(!O[ep].body.includes('"liveVersions"'), `original ${ep}: has liveVersions`);
        ok(!O[ep].mirror, `original ${ep}: has X-Mzo-Data`);
        if (ep !== 'data/manifest') {
            ok(O[ep].status === 200, `original ${ep}: HTTP ${O[ep].status}`);
            ok(M[ep].status === 200, `mirror ${ep}: HTTP ${M[ep].status}`);
        }
    }
    eq([O['data/manifest'].status, M['data/manifest'].status], [204, 200], 'manifest status (off, on)');

    // Byte parity of the reads that come from table snapshots.
    for (const ep of ['power-map/data', 'stock/allotment?action=listAllotments', 'stock/allotment?action=getAllotment&allotmentNo=MZO/ALT/2026/0002', 'important-sheets/unbilled', 'important-sheets/unbilled?all=1']) {
        eq(M[ep].body, O[ep].body, `${ep}: mirror body differs from original`);
        eq(M[ep].mirror, 'mirror', `${ep}: not served from the mirror`);
    }
    ok(!O['power-map/data'].body.includes('\n,'), 'power map: blank substation row kept');

    // Meta endpoints: manifest versions, live versions alongside.
    const metas = {
        'power-map/meta': { version: 'power_map_substations' },
        'nsc/meta': { version: 'nsc_pending', withheldVersion: 'withheld' },
        'stock/meta': { version: 'stock_snapshot' },
        'defective/meta': { version: null },
        'disconnection/meta': { version: 'disconnection' },
        'pending-mc/meta': { version: 'pending_mc' },
        'load-extension/meta': { version: 'load_extension' }
    };
    for (const [ep, fields] of Object.entries(metas)) {
        const o = body(O[ep]);
        const m = body(M[ep]);
        ok(m.liveVersions && typeof m.liveVersions === 'object', `${ep}: no liveVersions in mirror mode`);
        for (const [field, key] of Object.entries(fields)) {
            ok(o[field] != null, `${ep}: original ${field} is empty (fixture problem)`);
            eq(m.liveVersions[field], o[field], `${ep}: liveVersions.${field} is not the original ${field}`);
            if (key) eq(m[field], manifest[key].version, `${ep}: ${field} is not the manifest version`);
        }
        eq(Object.keys(m.liveVersions).sort(), Object.keys(fields).sort(), `${ep}: liveVersions keys`);
    }
    eq(body(O['power-map/meta']).version, PM_LATEST, 'power map: live version is the latest updated_at');
    eq(body(M['defective/meta']).version, manifest.defective_summary.version.slice(0, 20) + manifest.defective_details.version.slice(0, 20), 'defective: combined manifest version');

    // Apart from the fields mirror mode changes, the JSON is the same.
    const strip = (ep, v) => {
        const c = JSON.parse(JSON.stringify(v));
        ['version', 'withheldVersion', 'csvUrl', 'withheldCsvUrl', 'summaryCsvUrl', 'detailsCsvUrl', 'liveVersions'].forEach((k) => delete c[k]);
        if (ep === 'stock/meta') { delete c.meta; delete c.source; }
        if (ep === 'executive/briefing') delete c.briefing.generatedAt;
        return c;
    };
    for (const ep of Object.keys(metas).concat(['executive/briefing'])) eq(strip(ep, body(M[ep])), strip(ep, body(O[ep])), `${ep}: other fields differ`);
    eq(body(M['stock/meta']).meta.reportDate, '30/10/2026', 'stock: as-on date from the snapshot');
    eq(body(M['stock/meta']).csvUrl, '/api/data/file/stock_snapshot', 'stock: csvUrl');
    eq(body(M['power-map/meta']).csvUrl, '/api/power-map/data', 'power map: csvUrl');
    eq(body(M['nsc/meta']).meta, body(O['nsc/meta']).meta, 'nsc: meta (TODAY from the snapshot equals the live peek)');

    // /api/hub/versions: manifest versions, and liveVersions = what original mode returns for those keys.
    const oh = body(O['hub/versions']);
    const mh = body(M['hub/versions']);
    const hubKeys = {};
    Object.entries(manifest).forEach(([key, e]) => e.dataHubKeys.forEach((k) => { hubKeys[k] = key; }));
    ok(Object.keys(oh.versions).length >= 8, 'hub: original versions missing (fixture problem)');
    for (const [k, v] of Object.entries(oh.versions)) {
        if (hubKeys[k]) {
            eq(mh.liveVersions[k], v, `hub: liveVersions.${k}`);
            eq(mh.versions[k], manifest[hubKeys[k]].version, `hub: versions.${k} is not the manifest version`);
        } else {
            eq(mh.versions[k], v, `hub: versions.${k} changed without a snapshot`);
        }
    }
    eq(Object.keys(mh.liveVersions).sort(), Object.keys(oh.versions).filter((k) => hubKeys[k]).sort(), 'hub: liveVersions keys');
    eq(mh.liveVersions.CACHE_POWER_MAP, PM_LATEST, 'hub: Power Map live version from the snapshot');
    eq(mh.liveVersions.CACHE_LOSS, METADATA_VERSIONS.CACHE_LOSS, 'hub: Apps Script metadata version kept as live');
    eq(mh.csvUrls.CACHE_POWER_MAP, '/api/power-map/data', 'hub: Power Map URL');
    eq(mh.csvUrls.CACHE_NSC_v5, '/api/data/file/nsc_pending', 'hub: NSC URL');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`mirror server test: ${checks} checks passed`);
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
