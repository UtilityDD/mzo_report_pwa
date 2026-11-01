#!/usr/bin/env node
'use strict';
// Run the data quality checks outside the sync, e.g. to write docs/data-quality.md.
//
//   node vm/quality/audit.js --sources [--only a,b] [--out report.json]
//        read every source directly through the sync adapters (GET only, no PocketBase)
//   node vm/quality/audit.js --dumps <dir> [--only a,b] [--out report.json]
//        read NDJSON copies (<dir>/<key>.ndjson, one JSON array or object per line, and
//        <dir>/_index.json with each source's metadata)
//   node vm/quality/audit.js --pb [--only a,b]
//        the sync hook for every dataset in sys_datasets (writes sys_quality_*); needs
//        PB_URL, PB_SUPERUSER_EMAIL, PB_SUPERUSER_PASSWORD
//
// Samples in the report are masked (see lib/mask.js). The report JSON is the input for
// docs/data-quality.md.

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const Q = require('./index');
const cross = require('./lib/cross');
const input = require('./lib/input');
const { score } = require('./lib/score');

function args(argv) {
    const a = { mode: null, only: null, out: null, dir: null };
    for (let i = 0; i < argv.length; i++) {
        const x = argv[i];
        if (x === '--sources') a.mode = 'sources';
        else if (x === '--pb') a.mode = 'pb';
        else if (x === '--dumps') { a.mode = 'dumps'; a.dir = argv[++i]; }
        else if (x === '--only') a.only = String(argv[++i] || '').split(',').filter(Boolean);
        else if (x === '--out') a.out = argv[++i];
        else throw new Error('Unknown option ' + x);
    }
    return a;
}

/** Turn a sync adapter's rows() (arrays, header first, or objects) into header-first arrays. */
async function* adapterRows(src, ctx) {
    let mode = null;
    async function* objects(first, it) {
        yield first;
        for (;;) {
            const { value, done } = await it.next();
            if (done) return;
            yield value;
        }
    }
    const it = src.rows(ctx)[Symbol.asyncIterator]();
    const first = await it.next();
    if (first.done) {
        yield [];
        return;
    }
    if (Array.isArray(first.value)) {
        mode = 'table';
        yield first.value;
        for (;;) {
            const { value, done } = await it.next();
            if (done) return;
            yield value;
        }
    }
    void mode;
    yield* input.fromObjects(objects(first.value, it));
}

async function loadAdapters(only) {
    const dir = path.join(__dirname, '..', 'sync', 'sources');
    const { makeSourceFetch } = require(path.join(__dirname, '..', 'sync', 'lib', 'http.js'));
    const ctx = { fetch: makeSourceFetch({ timeoutMs: 15 * 60000 }), log: () => {}, env: process.env, limits: { maxRowsPerBatch: 500 } };
    const list = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
        const mod = require(path.join(dir, f));
        const fn = typeof mod === 'function' ? mod : mod.sources;
        if (typeof fn !== 'function') continue;
        const srcs = await fn(ctx);
        const defs = mod.SHEETS || [];
        for (const s of srcs) {
            const def = defs.find((d) => d.key === s.key);
            if (def && def.header === false) s.header = false;
            list.push(s);
        }
    }
    return { list: only ? list.filter((s) => only.includes(s.key)) : list, ctx };
}

function fmt(r) {
    const c = { error: 0, warn: 0, info: 0 };
    r.issues.forEach((i) => c[i.severity]++);
    return `${String(r.score).padStart(3)}  ${r.key.padEnd(34)} ${String(r.rows).padStart(8)} rows  E${c.error} W${c.warn} I${c.info}`;
}

async function offline(a) {
    const report = { generatedAt: new Date().toISOString(), mode: a.mode, datasets: {} };
    const facts = {}; // key → checkId → facts
    const keys = [];
    let meta = {};
    let adapters = null;
    if (a.mode === 'dumps') meta = JSON.parse(fs.readFileSync(path.join(a.dir, '_index.json'), 'utf8')).sources;
    else {
        adapters = await loadAdapters(a.only);
        for (const s of adapters.list) meta[s.key] = s;
    }
    const wanted = Object.keys(meta).filter((k) => (!a.only || a.only.includes(k)) && !/^x_/.test(k)).sort();
    for (const key of wanted) {
        const m = meta[key];
        const t0 = Date.now();
        let rows;
        let objectRows = false;
        try {
            if (a.mode === 'dumps') {
                if (!m.result || !m.result.ok) continue;
                rows = input.fromNdjson(path.join(a.dir, key + '.ndjson'));
                objectRows = m.result.mode === 'object';
            } else {
                if (m.skip) continue;
                rows = adapterRows(m, adapters.ctx);
                objectRows = m.sourceType === 'supabase_table' || m.sourceType === 'supabase_storage' || m.sourceType === 'json_file';
            }
            const res = await Q.analyse({
                key, meta: m, rows, rawValues: true, objectRows, firstRowNo: objectRows ? 1 : (m.header === false ? 1 : 2)
            });
            facts[key] = res.facts;
            report.datasets[key] = {
                key, label: m.label, group: m.group, sourceType: m.sourceType, sourceUrl: m.sourceUrl, schedule: m.schedule,
                rows: res.rows, columns: res.columns, asOn: res.asOn, issues: res.issues, ms: Date.now() - t0
            };
            keys.push(key);
        } catch (err) {
            report.datasets[key] = { key, label: m.label, error: String(err.message || err), issues: [], rows: 0 };
        }
    }
    // The Google fallbacks of the Storage snapshots, for the cross checks only.
    const getFacts = async (k, checkId, spec) => {
        if (facts[k] && facts[k][checkId]) return facts[k][checkId];
        if (!cross.GOOGLE_FALLBACKS[k]) return null;
        let rows;
        if (a.mode === 'dumps' && fs.existsSync(path.join(a.dir, k + '.ndjson'))) rows = input.fromNdjson(path.join(a.dir, k + '.ndjson'));
        else {
            const res = await fetch(cross.GOOGLE_FALLBACKS[k], { method: 'GET', signal: AbortSignal.timeout(300000) });
            if (!res.ok) return null;
            rows = input.fromCsvStream(Readable.fromWeb(res.body), false);
        }
        return (await Q.collectFacts(rows, { [checkId]: spec }))[checkId];
    };
    const done = new Set();
    for (const c of cross.CHECKS) {
        if (done.has(c.id) || !c.needs.every((k) => facts[k] || cross.GOOGLE_FALLBACKS[k])) continue;
        done.add(c.id);
        const f = {};
        for (const k of c.needs) f[k] = await getFacts(k, c.id, c.facts[k]);
        if (c.needs.some((k) => !f[k])) continue;
        const issues = c.run(f, { resolver: require('./lib/offices').createResolver() });
        if (report.datasets[c.primary]) report.datasets[c.primary].issues.push(...issues);
    }
    // Storage meta.json totals.
    for (const [key, folder] of Object.entries(cross.STORAGE_META)) {
        const d = report.datasets[key];
        if (!d || !facts[key] || !facts[key].meta) continue;
        try {
            const res = await fetch(`https://gmasnqebdogtavoudbke.supabase.co/storage/v1/object/public/reports/${folder}/meta.json`, { signal: AbortSignal.timeout(20000) });
            if (res.ok) d.issues.push(...cross.metaChecks(key, await res.json(), facts[key].meta));
        } catch (_) { /* offline */ }
    }
    for (const d of Object.values(report.datasets)) {
        d.score = score(d.issues, d.rows);
        console.log(fmt(d));
    }
    return report;
}

async function online(a) {
    const { PocketBase } = require(path.join(__dirname, '..', 'sync', 'lib', 'pb.js'));
    const { Registry } = require(path.join(__dirname, '..', 'sync', 'lib', 'registry.js'));
    const pb = new PocketBase({ url: process.env.PB_URL || 'http://127.0.0.1:8090', email: process.env.PB_SUPERUSER_EMAIL, password: process.env.PB_SUPERUSER_PASSWORD });
    await pb.auth();
    const registry = new Registry(pb);
    await registry.load();
    let adapters = { list: [] };
    try { adapters = await loadAdapters(a.only); } catch (_) { /* metadata from the registry only */ }
    const report = { generatedAt: new Date().toISOString(), mode: 'pb', datasets: {} };
    for (const [key, ds] of registry.byKey) {
        if (a.only && !a.only.includes(key)) continue;
        if (ds.last_status !== 'ok' && ds.last_status !== 'unchanged') continue;
        const src = adapters.list.find((s) => s.key === key) || null;
        const r = await Q.check(key, ds.collection || 'ds_' + key, { pb, registry, source: src, log: (m) => console.log(m) });
        report.datasets[key] = { key, label: ds.label, score: r ? r.score : null, open: r ? r.open : null };
    }
    return report;
}

(async () => {
    const a = args(process.argv.slice(2));
    if (!a.mode) {
        console.log('usage: node vm/quality/audit.js (--sources | --dumps <dir> | --pb) [--only a,b] [--out report.json]');
        process.exitCode = 2;
        return;
    }
    const report = a.mode === 'pb' ? await online(a) : await offline(a);
    if (a.out) fs.writeFileSync(a.out, JSON.stringify(report, null, 1));
    console.log(`peak RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
})().catch((err) => {
    console.error('audit failed:', err && err.message ? err.message : err);
    process.exitCode = 1;
});
