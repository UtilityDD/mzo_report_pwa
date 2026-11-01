#!/usr/bin/env node
'use strict';
// Development tool: build a local snapshot folder in the same format as vm/sync (manifest.json plus
// <key>.<ext>, .gz and .br), to run the app in mirror mode on a laptop before the real sync exists.
//
//   node vm/dev/make-snapshots.js --out <dir> [--server http://127.0.0.1:3400] [--only key,CACHE_KEY,…]
//                                [--skip-big] [--cookie-file <file>]
//
// What it downloads, GET only, the way the browser and the server read each dataset today:
//   - every DataHub dataset in mzo_data_hub.js DATASETS, from its URL; the NSC and Withheld dumps
//     through the app's own /api/nsc/dataset and /api/withheld/dataset redirects (--server);
//   - the Supabase Storage dumps (stock, defective, disconnection, pending MC, load extension) from the
//     new project's public bucket, the report CSV URLs taken from each report's meta.json;
//   - the tables the server reads in mirror mode, as the exact PostgREST body of the server's own query
//     (Power Map substations, stock allotments, unbilled months), with the public anon key from server.js.
// Never calls Apps Script, never writes anywhere but --out. Keys and dataHubKeys follow vm/sync, so the
// folder can stand in for /opt/mzo/data/snapshots. With --only, entries already in the manifest are kept.
//
// The cookie (only needed for the /api/* redirects) defaults to a local test session signed with the
// development secret, which only a local server without JWT_SECRET accepts.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const vm = require('vm');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const ROOT = path.join(__dirname, '..', '..');
const NEW_PROJECT = 'https://gmasnqebdogtavoudbke.supabase.co';
const OLD_PROJECT = 'https://unsmtschmcvftfqwabaq.supabase.co';
const STORAGE = `${NEW_PROJECT}/storage/v1/object/public`;
const BIG = 5 * 1024 * 1024;

// DataHub key -> vm/sync source key (sources/google.js `cache`, sources/supabase.js, sources/files.js).
const SYNC_KEYS = {
    CACHE_NSC_v5: 'nsc_pending', CACHE_WITHHELD_v4: 'withheld', CACHE_WEEKLY: 'weekly_report',
    CACHE_SOLAR: 'solar_connections', CACHE_JJM: 'jjm_connections', CACHE_METER_ERP: 'meter_erp',
    CACHE_METER_MASTER: 'meter_master', CACHE_METER_CRM: 'meter_crm', CACHE_METER_ISU: 'meter_isu',
    CACHE_WRIDD: 'wridd_schemes', CACHE_BHARATNET: 'bharatnet_connections', CACHE_ICDS_APLUS: 'icds_a_plus',
    CACHE_ICDS_A: 'icds_a', CACHE_LOSS: 'loss_report', CACHE_LOSS_TARGET: 'loss_targets',
    CACHE_COLLECTION: 'collection_report', CACHE_THEFT_ASSESSMENT_v2: 'theft_assessment', CACHE_REM_v2: 'rem_osd',
    CACHE_REM_DEFAULTERS: 'rem_defaulters_ind_com', CACHE_REM_AGRI: 'rem_defaulters_agri', CACHE_REM_DOM: 'rem_defaulters_dom',
    CACHE_DD_VISIT: 'dd_visit', CACHE_DOCKET: 'docket_calls', CACHE_CAPEX: 'capex_details', CACHE_VENDORS: 'vendor_map',
    CACHE_FEEDER_OUTAGE: 'feeder_outage', CACHE_CMO: 'cmo_grievances', CACHE_PMSGY_MALDA: 'pmsgy_malda',
    CACHE_PMSGY_UD: 'pmsgy_uttar_dinajpur', CACHE_PMSGY_DD: 'pmsgy_dakshin_dinajpur', CACHE_SAFETY_v2: 'safety_inspection',
    CACHE_STOCK_METADATA: 'stock_materials', CACHE_COSTCENTER: 'costcenter'
};

// Read from Supabase Storage by the sync (their Google sheets are only fallbacks).
const STORAGE_SOURCES = [
    { key: 'stock_snapshot', dataHubKey: 'CACHE_STOCK', label: 'Stock snapshot', object: 'stock/snapshot.csv' },
    { key: 'defective_summary', dataHubKey: 'CACHE_DEFECTIVE', label: 'Defective meters: summary', meta: 'defective', field: 'summaryCsvUrl', object: 'reports/defective/summary.csv' },
    { key: 'defective_details', dataHubKey: 'CACHE_DEFECTIVE_DETAILS', label: 'Defective meters: details', meta: 'defective', field: 'detailsCsvUrl', object: 'reports/defective/details.csv' },
    { key: 'disconnection', dataHubKey: 'CACHE_DISCONNECTION', label: 'Disconnection tracker', meta: 'disconnection', field: 'csvUrl', object: 'reports/disconnection/snapshot.csv' },
    { key: 'pending_mc', dataHubKey: 'CACHE_PENDING_MC', label: 'Pending master card', meta: 'pending_mc', field: 'csvUrl', object: 'reports/pending_mc/snapshot.csv' },
    { key: 'load_extension', dataHubKey: 'CACHE_LOAD_EXT', label: 'Pending load extension', meta: 'load_extension', field: 'csvUrl', object: 'reports/load_extension/snapshot.csv' }
];

// Tables the server reads, with the exact query server.js sends (old project, anon key).
const TABLES = [
    { key: 'power_map_substations', label: 'Power Map substations', schema: 'public',
        query: 'mzo_power_substations?select=*&limit=5000', dataHubKeys: ['CACHE_POWER_MAP'], dataHubUrl: '/api/power-map/data' },
    { key: 'stock_allotments', label: 'Stock allotments', schema: 'mzo_insight',
        query: 'stock_allotments?select=*&order=date.desc,allotment_no.desc', pageSize: 1000 },
    { key: 'important_unbilled_months', label: 'Important sheets: unbilled months', schema: 'mzo_insight',
        query: 'important_unbilled_months?select=*&order=sort_order.asc,id.asc' }
];

const SKIP = new Set(['CACHE_POWER_MAP']); // built from the power_map_substations table snapshot

function parseArgs(argv) {
    const a = { out: '', server: 'http://127.0.0.1:3400', only: [], skipBig: false, cookieFile: '' };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--out') a.out = argv[++i];
        else if (k === '--server') a.server = String(argv[++i] || '').replace(/\/$/, '');
        else if (k === '--only') a.only.push(...String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean));
        else if (k === '--skip-big') a.skipBig = true;
        else if (k === '--cookie-file') a.cookieFile = argv[++i];
        else if (k === '-h' || k === '--help') a.help = true;
        else throw new Error('Unknown option: ' + k);
    }
    return a;
}

function localCookie() {
    const payload = Buffer.from(JSON.stringify({
        profile: { Username: 'local-preview', Name: 'Local Preview', role: 'admin', office_level: 'CE' },
        expiry: Date.now() + 3600 * 1000
    })).toString('base64');
    const sig = crypto.createHmac('sha256', 'mzo-portal-super-secret-key-123456').update(payload).digest('base64');
    return `mzo_session=${encodeURIComponent(`${payload}.${sig}`)}`;
}

/** DATASETS from mzo_data_hub.js: the array literal only, evaluated without the rest of the file. */
function loadDatasets() {
    const src = fs.readFileSync(path.join(ROOT, 'mzo_data_hub.js'), 'utf8');
    const m = src.match(/const DATASETS = (\[[\s\S]*?\n\]);/);
    if (!m) throw new Error('DATASETS not found in mzo_data_hub.js');
    return vm.runInNewContext(`(${m[1]})`, {}, { timeout: 1000 });
}

/** The public anon key server.js already ships (never printed). */
function anonKey() {
    const m = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').match(/SUPABASE_FALLBACK_ANON_KEY = '([^']+)'/);
    if (!m) throw new Error('anon key not found in server.js');
    return m[1];
}

async function get(url, headers, { redirect = 'follow', timeoutMs = 120000 } = {}) {
    if (/script\.google(usercontent)?\.com/i.test(url)) throw new Error('Apps Script URLs are never called: ' + url);
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(url, { method: 'GET', headers: headers || {}, redirect, signal: AbortSignal.timeout(timeoutMs) });
            if (res.status >= 500 && attempt < 3) throw new Error(`HTTP ${res.status}`);
            return res;
        } catch (err) {
            if (attempt >= 3) throw err;
            await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
    }
}

function extFor(url, type) {
    if (type === 'json') return 'json';
    return /[?&]output=tsv\b/.test(url) ? 'tsv' : 'csv';
}

const CONTENT_TYPES = {
    csv: 'text/csv; charset=utf-8',
    tsv: 'text/tab-separated-values; charset=utf-8',
    json: 'application/json; charset=utf-8'
};

/** Stream a body to <dir>/<key>.<ext> (+ .gz, .br) atomically; returns sha1, bytes and a row count. */
async function writeSnapshot(dir, key, ext, body) {
    const file = `${key}.${ext}`;
    const final = path.join(dir, file);
    const tmp = path.join(dir, `.${file}.${process.pid}.tmp`);
    const hash = crypto.createHash('sha1');
    let bytes = 0;
    let newlines = 0;
    let lastByte = 10;
    const source = Buffer.isBuffer(body) ? Readable.from([body]) : Readable.fromWeb(body);
    await pipeline(source, async function* (chunks) {
        for await (const chunk of chunks) {
            hash.update(chunk);
            bytes += chunk.length;
            for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) newlines++;
            if (chunk.length) lastByte = chunk[chunk.length - 1];
            yield chunk;
        }
    }, fs.createWriteStream(tmp));
    await pipeline(fs.createReadStream(tmp), zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp + '.gz'));
    await pipeline(fs.createReadStream(tmp), zlib.createBrotliCompress({
        params: {
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
            [zlib.constants.BROTLI_PARAM_QUALITY]: bytes > 1024 * 1024 ? 5 : 9,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes
        }
    }), fs.createWriteStream(tmp + '.br'));
    // Compressed copies first, the plain file last (as vm/sync does).
    fs.renameSync(tmp + '.gz', final + '.gz');
    fs.renameSync(tmp + '.br', final + '.br');
    fs.renameSync(tmp, final);
    const lines = newlines + (lastByte === 10 || !bytes ? 0 : 1);
    return { file, sha1: hash.digest('hex'), bytes, lines };
}

function entryFor(meta, snap, rows) {
    const now = new Date().toISOString();
    const e = {
        version: snap.sha1,
        bytes: snap.bytes,
        contentType: CONTENT_TYPES[path.extname(snap.file).slice(1)],
        file: snap.file,
        fetchedAt: now,
        snapshotAt: now,
        checkedAt: now,
        sourceType: meta.sourceType,
        dataHubKeys: meta.dataHubKeys || [],
        urls: meta.urls || [],
        sensitive: false,
        label: meta.label,
        rows
    };
    if (meta.dataHubUrl) e.dataHubUrl = meta.dataHubUrl;
    return e;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.out) {
        console.log('Usage: node vm/dev/make-snapshots.js --out <dir> [--server <url>] [--only a,b] [--skip-big] [--cookie-file f]');
        return args.help ? 0 : 2;
    }
    const dir = path.resolve(args.out);
    fs.mkdirSync(dir, { recursive: true });
    const cookie = args.cookieFile ? fs.readFileSync(args.cookieFile, 'utf8').trim() : localCookie();
    const wanted = (key, dataHubKey) => !args.only.length || args.only.includes(key) || (dataHubKey && args.only.includes(dataHubKey));

    const jobs = [];
    // 1. DataHub datasets (Google Sheets and the repo's JSON) as the browser loads them.
    for (const d of loadDatasets()) {
        if (SKIP.has(d.key) || STORAGE_SOURCES.some((s) => s.dataHubKey === d.key)) continue;
        const key = SYNC_KEYS[d.key] || ('hub_' + d.key.toLowerCase());
        if (!wanted(key, d.key)) continue;
        jobs.push(async () => {
            let url = d.url;
            const urls = [];
            if (url.startsWith('/')) {
                // /api/nsc/dataset and /api/withheld/dataset redirect to the sheet; /data/costcenter.json is static.
                const res = await get(args.server + url, { Cookie: cookie }, { redirect: 'manual' });
                if (res.status >= 300 && res.status < 400 && res.headers.get('location')) url = res.headers.get('location');
                else if (!res.ok) throw new Error(`${d.url}: HTTP ${res.status} from ${args.server}`);
                else url = args.server + url;
                await res.body?.cancel().catch(() => {});
            }
            if (!url.startsWith(args.server)) urls.push(url);
            if (d.url.startsWith('http') && !urls.includes(d.url)) urls.push(d.url);
            const res = await get(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const ext = extFor(url, d.type);
            if (args.skipBig && Number(res.headers.get('content-length')) > BIG) {
                await res.body.cancel();
                return { key, skipped: 'big' };
            }
            const snap = await writeSnapshot(dir, key, ext, res.body);
            const sourceType = /docs\.google\.com/.test(url) ? 'google_sheet' : 'json_file';
            return { key, entry: entryFor({ label: d.label, sourceType, dataHubKeys: [d.key], urls }, snap, ext === 'json' ? null : Math.max(0, snap.lines - 1)) };
        });
    }
    // 2. Supabase Storage dumps (new project, public), report CSV URLs from meta.json.
    const metaCache = {};
    for (const s of STORAGE_SOURCES) {
        if (!wanted(s.key, s.dataHubKey)) continue;
        jobs.push(async () => {
            let url = `${STORAGE}/${s.object}`;
            if (s.meta) {
                metaCache[s.meta] = metaCache[s.meta] || get(`${STORAGE}/reports/${s.meta}/meta.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
                const meta = await metaCache[s.meta];
                if (meta && meta[s.field]) url = meta[s.field];
            }
            const res = await get(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            if (args.skipBig && Number(res.headers.get('content-length')) > BIG) {
                await res.body.cancel();
                return { key: s.key, skipped: 'big' };
            }
            const snap = await writeSnapshot(dir, s.key, 'csv', res.body);
            const objectUrl = `${STORAGE}/${s.object}`;
            return { key: s.key, entry: entryFor({ label: s.label, sourceType: 'supabase_storage', dataHubKeys: [s.dataHubKey], urls: [objectUrl] }, snap, Math.max(0, snap.lines - 1)) };
        });
    }
    // 3. Tables the server reads: the PostgREST body of its own query (pages joined into one array).
    const key = anonKey();
    for (const t of TABLES) {
        if (!wanted(t.key)) continue;
        jobs.push(async () => {
            const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': t.schema, Accept: 'application/json' };
            const base = `${OLD_PROJECT}/rest/v1/${t.query}`;
            const pages = [];
            for (let offset = 0; ; offset += t.pageSize) {
                const url = t.pageSize ? `${base}&limit=${t.pageSize}&offset=${offset}` : base;
                const res = await get(url, headers);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const text = await res.text();
                const rows = JSON.parse(text);
                pages.push({ text, rows: rows.length });
                if (!t.pageSize || rows.length < t.pageSize) break;
            }
            const body = pages.length === 1
                ? pages[0].text
                : '[' + pages.map((p) => p.text.trim().replace(/^\[|\]$/g, '')).filter(Boolean).join(', \n ') + ']';
            const snap = await writeSnapshot(dir, t.key, 'json', Buffer.from(body, 'utf8'));
            const rows = pages.reduce((n, p) => n + p.rows, 0);
            return { key: t.key, entry: entryFor({ label: t.label, sourceType: 'supabase_table', dataHubKeys: t.dataHubKeys, dataHubUrl: t.dataHubUrl, urls: [base] }, snap, rows) };
        });
    }

    // Four at a time; one failure never stops the rest.
    const manifestFile = path.join(dir, 'manifest.json');
    let datasets = {};
    if (args.only.length) {
        try { datasets = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).datasets || {}; } catch (_) { datasets = {}; }
    }
    let failed = 0;
    const queue = jobs.slice();
    const started = Date.now();
    await Promise.all(Array.from({ length: 4 }, async () => {
        while (queue.length) {
            const job = queue.shift();
            const t0 = Date.now();
            try {
                const r = await job();
                if (r.entry) {
                    datasets[r.key] = r.entry;
                    console.log(`ok       ${r.key.padEnd(28)} ${String(r.entry.bytes).padStart(10)} B  ${String(Date.now() - t0).padStart(6)} ms`);
                } else {
                    console.log(`skipped  ${r.key.padEnd(28)} (${r.skipped})`);
                }
            } catch (err) {
                failed++;
                console.log(`error    ${String(err && err.message).slice(0, 160)}`);
            }
        }
    }));
    const sorted = {};
    Object.keys(datasets).sort().forEach((k) => { sorted[k] = datasets[k]; });
    const tmp = path.join(dir, `.manifest.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ generatedAt: new Date().toISOString(), datasets: sorted }, null, 1));
    fs.renameSync(tmp, manifestFile);
    console.log(`${Object.keys(sorted).length} datasets in ${manifestFile}, ${failed} failed, ${Date.now() - started} ms`);
    return failed ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(err && err.message);
    process.exitCode = 1;
});
