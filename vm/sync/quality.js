#!/usr/bin/env node
'use strict';
// Data quality checks after each sync run (docs/data-quality.md, "Admin → Data quality"):
//   node vm/sync/quality.js [--dir <snapshotDir>] [--only key[,key]] [--force] [--out <file>] [--now <iso>]
// Checks every dataset whose snapshot version changed since its last check (all of them with --force, or
// when the checks' code changed), each in a child process of its own with a capped heap, then writes
// quality.json next to the manifest: findings with first / last seen, held datasets (quality-held.json, written
// by the sync's hold-back) and a summary for GET /api/admin/data-quality. Staleness ("as on" too old) is judged
// on every run, without reading data. Never fails the sync: vm/sync/run.js calls it like views.js:
//   node --max-old-space-size=64 --max-semi-space-size=4 vm/sync/quality.js --dir <snapshotDir>
// Internal: --check <key> runs the checks of one dataset and prints its result as JSON (the child).

process.env.TZ = 'Asia/Kolkata';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const store = require('./lib/quality/store');
const holdback = require('./lib/holdback');
const { datasetRules, GENERIC } = require('./lib/quality/rules');

const APP = path.resolve(__dirname, '..', '..');
const CHILD_FLAGS = ['--max-old-space-size=96', '--max-semi-space-size=4'];
const CHILD_TIMEOUT_MS = 3 * 60000;
const SENSITIVE = /^(manpower_|portal_users|dd_user_auth|activity_logs|upcoming_dd|dd_visit|powermap_(org_units|editors|profiles))/;

function arg(name) {
    const i = process.argv.indexOf('--' + name);
    return i > 0 ? process.argv[i + 1] : undefined;
}
const log = (m) => console.log(new Date().toISOString().slice(11, 19), '[quality]', m);

/** Identity of the checking code: a change re-checks every dataset once. */
function codeHash() {
    const h = crypto.createHash('sha1');
    for (const f of ['vm/sync/lib/quality/rules.js', 'vm/sync/lib/quality/checks.js', 'vm/sync/lib/quality/engine.js', 'lib/uniform.js', 'lib/offices.js', 'data/costcenter.json']) {
        try { h.update(fs.readFileSync(path.join(APP, f))); } catch (_) { h.update('-'); }
        h.update('\u0000');
    }
    return h.digest('hex').slice(0, 16);
}

function readManifest(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (_) { return null; }
}

/** Sync schedules from the source lists, read without network (as lib/sources_info.js does). */
function schedules() {
    const out = {};
    const dir = path.join(__dirname, 'sources');
    try { (require(path.join(dir, 'google.js')).SHEETS || []).forEach((d) => { out[d.key] = d.schedule || 'hourly'; }); } catch (_) { /* none */ }
    try {
        const sb = require(path.join(dir, 'supabase.js'));
        (sb.TABLES || []).forEach((d) => { out[d.key] = d.schedule || 'hourly'; });
        (sb.STORAGE || []).forEach((d) => { out[d.key] = 'frequent'; });
    } catch (_) { /* none */ }
    return out;
}

// ---- the child: one dataset ------------------------------------------------------------------------

function checkOne(dir, key, stateFile) {
    const { checkDataset } = require('./lib/quality/engine');
    const man = readManifest(dir);
    const e = man && man.datasets && man.datasets[key];
    if (!e || !e.file) throw new Error('not in the manifest');
    const file = path.join(dir, path.basename(e.file));
    const format = path.extname(file).slice(1);
    let schema = null;
    try { schema = JSON.parse(fs.readFileSync(path.join(APP, 'schema', key + '.json'), 'utf8')); } catch (_) { /* none */ }
    let offices = null;
    try {
        offices = require(path.join(APP, 'lib', 'offices.js'));
        let cc = [];
        try { cc = JSON.parse(fs.readFileSync(path.join(APP, 'data', 'costcenter.json'), 'utf8')); } catch (_) { /* none */ }
        if (typeof offices.addCostCentres === 'function') offices.addCostCentres(cc);
    } catch (_) { offices = null; }
    const state = store.read(dir, stateFile);
    const old = state.datasets[key];
    const now = arg('now') ? Date.parse(arg('now')) : Date.now();
    const text = fs.readFileSync(file, 'utf8');
    const res = checkDataset({ key, text, format, schema, prev: old ? old.baseline : null, now, offices, header: e.header });
    res.peakRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
    return res;
}

function runChild(dir, key, stateFile) {
    return new Promise((resolve) => {
        const args = CHILD_FLAGS.concat([__filename, '--dir', dir, '--check', key]);
        if (stateFile) args.push('--out', stateFile);
        if (arg('now')) args.push('--now', arg('now'));
        const ch = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
        const parts = [];
        let size = 0;
        ch.stdout.on('data', (b) => { size += b.length; if (size < 8 * 1048576) parts.push(b); });
        const timer = setTimeout(() => ch.kill('SIGKILL'), CHILD_TIMEOUT_MS);
        ch.on('close', (code, sig) => {
            clearTimeout(timer);
            if (code !== 0) return resolve({ error: sig ? `stopped (${sig}) after ${CHILD_TIMEOUT_MS / 60000} min or out of memory` : `exit ${code}` });
            try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (err) { resolve({ error: 'bad output: ' + err.message }); }
        });
    });
}

// ---- the planner ---------------------------------------------------------------------------------

async function main() {
    const dir = path.resolve(arg('dir') || process.env.MZO_SNAPSHOT_DIR || '/opt/mzo/data/snapshots');
    const stateFile = arg('out') ? path.resolve(arg('out')) : null;
    if (arg('check')) {
        const res = checkOne(dir, arg('check'), stateFile);
        process.stdout.write(JSON.stringify(res));
        return;
    }
    const man = readManifest(dir);
    if (!man || !man.datasets) {
        log(`no manifest in ${dir}: nothing to do`);
        return;
    }
    const t0 = Date.now();
    const state = store.read(dir, stateFile);
    const code = codeHash();
    const force = process.argv.includes('--force') || state.code !== code;
    const only = (arg('only') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const datasets = {};
    for (const [k, e] of Object.entries(man.datasets)) if (!e.sensitive && !SENSITIVE.test(k)) datasets[k] = e;
    const todo = Object.keys(datasets).filter((k) => (only.length ? only.includes(k) : force || !state.datasets[k] || state.datasets[k].version !== datasets[k].version));
    const results = {};
    let peak = 0;
    for (const key of todo) {
        const r = await runChild(dir, key, stateFile);
        results[key] = r;
        if (r.peakRssMb) peak = Math.max(peak, r.peakRssMb);
        if (r.error) log(`${key}: check failed: ${r.error}`);
        else {
            const n = { critical: 0, warning: 0, info: 0 };
            r.findings.forEach((f) => { n[f.severity]++; });
            log(`${key.padEnd(30)} ${String(r.rows).padStart(7)} rows  ${n.critical} critical ${n.warning} warning ${n.info} info  ${r.ms} ms, ${r.peakRssMb} MB`);
        }
    }
    const sched = schedules();
    const maxAge = (key) => {
        const r = datasetRules(key);
        if (r.maxAgeDays === null) return null;
        if (r.maxAgeDays) return r.maxAgeDays;
        return GENERIC.defaultMaxAgeDays[sched[key]] || GENERIC.defaultMaxAgeDays.daily;
    };
    const held = holdback.read(dir);
    const next = store.merge(state, { results, manifest: datasets, held, maxAge, now: arg('now') ? Date.parse(arg('now')) : Date.now(),
        code: only.length ? state.code : code, // --only checks a few: the rest still need the new code
        startedAt: t0, peakRssMb: peak || null });
    store.write(dir, next, stateFile);
    const s = next.summary;
    log(`${todo.length} checked, ${Object.keys(datasets).length - todo.length} unchanged; ${s.critical} critical, ${s.warning} warning, ${s.info} info in ${s.datasets} datasets` +
        (s.held ? `; ${s.held} held` : '') + ` in ${Date.now() - t0} ms; largest child ${peak || 0} MB, planner ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
}

main().catch((err) => {
    console.error('[quality]', err && err.stack || err);
    process.exitCode = 1;
});
