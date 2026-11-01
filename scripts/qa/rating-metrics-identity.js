#!/usr/bin/env node
/* scripts/qa/rating-metrics-identity.js: lib/rating_metrics.js (uniform rows) against
 * scripts/rating/compute-metrics.js (raw snapshots), on the same snapshot folder.
 *
 *   node scripts/qa/rating-metrics-identity.js --snap <dir with manifest.json> [--schemas dir[,dir]]
 *        [--needs-only | --exact [--vercel]] [--as-of YYYY-MM-DD] [--out report.json] [--show 20]
 *
 * --exact: the browser path as it is: schema files only, no added fields; a dataset without a
 * schema file is built with no schema (keep all, inferred types), as MzoRows does on the VM.
 * --vercel: as --exact, but a dataset without a schema file is unavailable (MzoRows has no
 * source for it in original mode).
 *
 * 1. compute-metrics.js runs in its own process on the raw snapshot bytes (as it does on its own).
 * 2. Every dataset the module reads is turned into uniform rows the way the VM does it
 *    (vm/sync/lib/rows.js: lib/uniform.js + lib/offices.js + data/costcenter.json), with
 *    schema/<key>.json from the first --schemas folder that has it (default: this repo's schema/)
 *    plus the fields lib/rating_metrics.js NEEDS (what docs/rating/schema-needs.md asks the owners
 *    to add); --needs-only uses only those fields. The rows go through stringify → JSON.parse, so
 *    the module sees exactly what /api/data/rows/<key> serves.
 *    --needs-only builds them with MzoRatingMetrics.schemaFor(key) alone; --vm does that through
 *    vm/sync/lib/rating.js's leanBuild (the VM precompute's exact path), and --lean-check also
 *    compares each lean build with the plain lib/uniform.js build.
 * 3. Both documents are compared field by field (generatedAt and source.mode aside). Every
 *    difference must match an entry of KNOWN below, which says why it is right; anything else
 *    exits 1.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.resolve(__dirname, '..', '..');

// Differences that are explained (docs/rating/metrics-layer.md, "Identity with compute-metrics.js").
// match(d) gets { metric, office, field, a (script), b (module) }; verify(A, B) must hold too, else
// the differences stay open.
const n0 = (e) => (e && e.numerator) || 0;
const own = (e) => (e && e.ownLevel && e.ownLevel.numerator) || 0;
const KNOWN = [
    {
        id: 'old_cost_centre_accidents',
        why: 'accident rows on old SAP cost centre C333430000 ("CHANCHAL DIV" in data/costcenter.json): uniform rows place them in Chanchal division; '
            + 'the script resolves accidents before it loads the cost centres (it loads them only for capex), so they fall back to the legacy "North Malda" name and sit at Malda region. '
            + 'Malda region and the zone keep the same totals.',
        match: (d) => d.metric === 'accidents_fatal_12m' && (d.office === '6610000' || d.office === '6612000') && ['value', 'numerator', 'inputs', 'ownLevel', 'quality'].includes(d.field),
        verify(A, B) {
            if (!A.metrics.accidents_fatal_12m || !B.metrics.accidents_fatal_12m) return false;
            const a = (c) => A.offices[c].metrics.accidents_fatal_12m, b = (c) => B.offices[c].metrics.accidents_fatal_12m;
            const moved = own(a('6610000')) - own(b('6610000'));
            const movedAll = ((a('6610000').inputs || {}).allAccidents || 0) - ((b('6610000').inputs || {}).allAccidents || 0); // region totals equal
            return moved > 0 && movedAll === 0 && n0(a('6610000')) === n0(b('6610000')) && n0(b('6612000')) - n0(a('6612000')) === moved && n0(a('6600000')) === n0(b('6600000'));
        }
    },
    {
        id: 'onm_advance_without_schema',
        why: 'onm_advance has no schema file yet (batch D): lib/offices.js header rules see only Plant (old plant codes), not Resp. CCtr, so a few orders sit in another division; '
            + 'the zone total is the same, and schema/onm_advance.json (offices: codes resp_cctr, divisions plant) restores the script\'s placement. Stale and not rated.',
        when: (x) => x.info.onm_advance && x.info.onm_advance.schemaFile === false,
        match: (d) => d.metric === 'onm_advance_aged_share' && /^66\d{2}000$/.test(d.office) && !/0000$/.test(d.office),
        verify(A, B) {
            const z = (D) => D.offices['6600000'].metrics.onm_advance_aged_share;
            return !!(B.metrics.onm_advance_aged_share && Math.abs(z(A).denominator - z(B).denominator) < 0.01 && Math.abs(z(A).numerator - z(B).numerator) < 0.01);
        }
    },
    {
        id: 'vercel_no_schema',
        why: 'on Vercel MzoRows has no source for a dataset without a schema file, so the metrics that read it are left out (errors: dataset missing); they come back when the owning batch merges its schema',
        when: (x) => x.mode === 'vercel',
        match: (d) => /^dataset missing/.test(String(d.b && d.b.error || d.b || '')) || (d.b === undefined || d.b === false || d.b === null) && (d.field === 'entry' || /^meta|^checks$/.test(d.field)) || d.field === 'metric order' || d.field === 'error',
        verify: (A, B) => Object.values(B.errors).every((e) => /^dataset missing/.test(e))
    }
];

function args(argv) {
    const a = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const k = argv[i].slice(2);
        a[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
    return a;
}

/** schema/<key>.json (first folder that has it) + the module's needed fields. */
function schemaFor(key, dirs, needs, needsOnly, exact) {
    let doc = null;
    for (const d of dirs) {
        const f = path.join(d, key + '.json');
        if (fs.existsSync(f)) { doc = JSON.parse(fs.readFileSync(f, 'utf8')); break; }
    }
    if (exact) return { schema: doc, file: !!doc };
    if (needsOnly) return { schema: require(path.join(APP, 'lib', 'rating_metrics.js')).schemaFor(key), file: !!doc }; // the VM precompute's rows
    const want = needs[key] || {};
    const out = doc ? JSON.parse(JSON.stringify(doc)) : { key, keep: 'pinned', fields: {} };
    if (needsOnly) out.fields = {};
    out.keep = out.keep || 'all';
    for (const f of Object.keys(want)) {
        if (out.fields[f]) continue;
        const spec = { type: want[f].type };
        if (want[f].order) spec.order = want[f].order;
        out.fields[f] = spec;
    }
    return { schema: out, file: !!doc };
}

const leanResults = {};
function buildRows(snap, manifest, keys, dirs, needs, needsOnly, mode, vm, leanCheck) {
    const VM = vm ? require(path.join(APP, 'vm', 'sync', 'lib', 'rating.js')) : null;
    const U = require(path.join(APP, 'lib', 'uniform.js'));
    const offices = require(path.join(APP, 'lib', 'offices.js'));
    const cc = JSON.parse(fs.readFileSync(path.join(APP, 'data', 'costcenter.json'), 'utf8'));
    U.useOffices(offices, cc); // as vm/sync/lib/rows.js
    const docs = {}, info = {};
    for (const key of keys) {
        const e = manifest.datasets[key];
        if (!e) { info[key] = { missing: true }; continue; }
        const file = path.join(snap, e.file);
        if (!fs.existsSync(file)) { info[key] = { missing: true }; continue; }
        const { schema, file: hasFile } = schemaFor(key, dirs, needs, needsOnly, !!mode);
        if (mode === 'vercel' && !hasFile) { info[key] = { schemaFile: false, unavailable: true }; continue; }
        const t0 = Date.now();
        const text = fs.readFileSync(file, 'utf8'), format = path.extname(e.file).slice(1);
        // --vm: exactly vm/sync/lib/rating.js's build (columns cut down before lib/uniform.js runs)
        const res = vm ? VM.leanBuild({ U, O: offices, M: require(path.join(APP, 'lib', 'rating_metrics.js')) }, key, text, format, e.version) : U.build(text, { key, version: e.version, format, schema });
        if (vm && leanCheck) {
            const plain = U.build(text, { key, version: e.version, format, schema });
            const names = Object.keys(schema.fields).concat(U.OFFICE_FIELDS);
            const pick = (r) => { const o = {}; for (const n of names) { o[n] = r[n]; if (r[n + '_raw'] !== undefined) o[n + '_raw'] = r[n + '_raw']; } return o; };
            const a = U.objects(plain).map(pick), b = U.objects(res).map(pick);
            const same = JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(plain.issues.filter((i) => i.check !== 'header.missing')) === JSON.stringify(res.issues.filter((i) => i.check !== 'header.missing'));
            leanResults[key] = same ? 'same' : 'DIFFERENT';
        }
        const json = U.stringify(res);
        docs[key] = JSON.parse(json);
        const issues = docs[key].issues.filter((i) => /^header\.|^type\.unparsed/.test(i.check)).map((i) => i.check + ':' + i.column + ':' + i.count);
        info[key] = { rows: res.stats.rows, bytes: json.length, ms: Date.now() - t0, schemaFile: hasFile, fields: schema ? Object.keys(schema.fields).length : 'all', issues };
    }
    return { docs, info };
}

/** Field-by-field differences between two metrics documents. */
function diff(A, B) {
    const out = [];
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    const top = ['logic', 'referenceDate', 'notes', 'flags'];
    for (const k of top) if (!same(A[k], B[k])) out.push({ metric: '*', office: '*', field: k, a: A[k], b: B[k] });
    if (!same(A.source.manifestGeneratedAt, B.source.manifestGeneratedAt)) out.push({ metric: '*', office: '*', field: 'source.manifestGeneratedAt', a: A.source.manifestGeneratedAt, b: B.source.manifestGeneratedAt });
    const ids = [...new Set(Object.keys(A.metrics).concat(Object.keys(B.metrics), Object.keys(A.errors), Object.keys(B.errors)))];
    if (!same(Object.keys(A.metrics), Object.keys(B.metrics))) out.push({ metric: '*', office: '*', field: 'metric order', a: Object.keys(A.metrics), b: Object.keys(B.metrics) });
    for (const id of ids) {
        if (!same(A.errors[id], B.errors[id])) out.push({ metric: id, office: '*', field: 'error', a: A.errors[id], b: B.errors[id] });
        const ma = A.metrics[id], mb = B.metrics[id];
        if (ma && mb) {
            for (const k of new Set(Object.keys(ma).concat(Object.keys(mb)))) if (!same(ma[k], mb[k])) out.push({ metric: id, office: '*', field: 'meta.' + k, a: ma[k], b: mb[k] });
            if (!same(Object.keys(ma), Object.keys(mb))) out.push({ metric: id, office: '*', field: 'meta key order', a: Object.keys(ma), b: Object.keys(mb) });
        }
        if (!same(A.checks[id], B.checks[id])) out.push({ metric: id, office: '*', field: 'checks', a: A.checks[id], b: B.checks[id] });
    }
    if (!same(Object.keys(A.offices), Object.keys(B.offices))) out.push({ metric: '*', office: '*', field: 'office order', a: Object.keys(A.offices), b: Object.keys(B.offices) });
    for (const code of Object.keys(A.offices)) {
        const oa = A.offices[code], ob = B.offices[code];
        if (!ob) { out.push({ metric: '*', office: code, field: 'office', a: true, b: null }); continue; }
        for (const k of ['level', 'name', 'parent', 'region', 'division']) if (!same(oa[k], ob[k])) out.push({ metric: '*', office: code, field: k, a: oa[k], b: ob[k] });
        for (const id of new Set(Object.keys(oa.metrics).concat(Object.keys(ob.metrics)))) {
            const ea = oa.metrics[id], eb = ob.metrics[id];
            if (!ea || !eb) { out.push({ metric: id, office: code, field: 'entry', a: !!ea, b: !!eb }); continue; }
            for (const k of new Set(Object.keys(ea).concat(Object.keys(eb)))) if (!same(ea[k], eb[k])) out.push({ metric: id, office: code, field: k, a: ea[k], b: eb[k] });
            if (same(ea, eb) && !same(Object.keys(ea), Object.keys(eb))) out.push({ metric: id, office: code, field: 'key order', a: Object.keys(ea), b: Object.keys(eb) });
        }
    }
    return out;
}

function main() {
    const a = args(process.argv.slice(2));
    if (!a.snap) { process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 20).join('\n') + '\n'); process.exit(2); }
    const snap = path.resolve(a.snap);
    const manifest = JSON.parse(fs.readFileSync(path.join(snap, 'manifest.json'), 'utf8'));
    const asOf = a['as-of'] || String(manifest.generatedAt || '').slice(0, 10);
    const generatedAt = '2026-01-01T00:00:00.000Z';
    const dirs = String(a.schemas || path.join(APP, 'schema')).split(',').map((d) => path.resolve(d));
    const M = require(path.join(APP, 'lib', 'rating_metrics.js'));

    // 1. the script, on its own
    const tmp = path.join(APP, '.scratch', 'identity-script-' + process.pid + '.json');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    let t0 = Date.now();
    execFileSync(process.execPath, [path.join(APP, 'scripts', 'rating', 'compute-metrics.js'), '--snapshots', snap, '--as-of', asOf, '--generated-at', generatedAt, '--out', tmp], { stdio: ['ignore', 'ignore', 'inherit'] });
    const A = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    fs.unlinkSync(tmp);
    const scriptMs = Date.now() - t0;

    // 2. uniform rows, then the module
    t0 = Date.now();
    const mode = a.vercel ? 'vercel' : a.exact ? 'exact' : null;
    const { docs, info } = buildRows(snap, manifest, M.DATASETS, dirs, M.NEEDS, !!(a['needs-only'] || a.vm), mode, !!a.vm, !!a['lean-check']);
    const buildMs = Date.now() - t0;
    t0 = Date.now();
    const B = JSON.parse(JSON.stringify(M.computeSync(docs, { manifest, asOf, generatedAt, mode: 'snapshots' }))); // as served
    const moduleMs = Date.now() - t0;
    B.source.mode = A.source.mode;

    // 3. compare
    const all = diff(A, B);
    const explained = [], open = [];
    const holds = new Map(KNOWN.map((k) => [k.id, (!k.when || !!k.when({ info, mode })) && (!k.verify || !!k.verify(A, B))]));
    for (const d of all) {
        const k = KNOWN.find((x) => holds.get(x.id) && x.match(d));
        if (k) explained.push(Object.assign({ why: k.id }, d)); else open.push(d);
    }
    const byMetric = {};
    for (const d of all) byMetric[d.metric] = (byMetric[d.metric] || 0) + 1;
    let entries = 0;
    for (const o of Object.values(B.offices)) entries += Object.keys(o.metrics).length;
    const show = +a.show || 25;
    console.log('snapshots   ' + snap + ' (manifest ' + manifest.generatedAt + ', as of ' + asOf + ')');
    console.log('schemas     ' + dirs.join(', ') + (mode === 'vercel' ? ' as they are; no schema file = unavailable (Vercel)' : mode ? ' as they are; no schema file = keep all (VM browser path)' : a['needs-only'] || a.vm ? ' ignored: MzoRatingMetrics.schemaFor (the VM precompute)' : ' + needed fields'));
    console.log('datasets    ' + Object.keys(docs).length + ' built as uniform rows in ' + buildMs + ' ms; no schema file: ' + (Object.keys(info).filter((k) => info[k].schemaFile === false).join(', ') || 'none'));
    for (const k of Object.keys(info)) if (info[k].issues && info[k].issues.length) console.log('  ' + k + ': ' + info[k].issues.join(' '));
    if (a['lean-check']) { const bad = Object.keys(leanResults).filter((k) => leanResults[k] !== 'same'); console.log('lean build  ' + (bad.length ? 'DIFFERS from the plain build for ' + bad.join(', ') : 'equal to the plain build for all ' + Object.keys(leanResults).length + ' datasets (pinned and office fields, issues)')); if (bad.length) process.exitCode = 1; }
    console.log('script      ' + scriptMs + ' ms (own process, incl. reading the files)');
    console.log('module      ' + moduleMs + ' ms; ' + Object.keys(B.metrics).length + ' metrics, ' + Object.keys(B.offices).length + ' offices, ' + entries + ' office entries; errors: ' + (Object.keys(B.errors).map((k) => k + ' (' + B.errors[k] + ')').join('; ') || 'none'));
    console.log('differences ' + all.length + ' (' + explained.length + ' explained, ' + open.length + ' open)' + (all.length ? ' by metric: ' + JSON.stringify(byMetric) : ''));
    for (const k of KNOWN) { const n = explained.filter((d) => d.why === k.id).length; if (n) console.log('  explained ' + k.id + ': ' + n + ' — ' + k.why); }
    if (Object.keys(B.errors).length) console.log('left out    ' + Object.keys(B.errors).length + ' metrics: ' + Object.keys(B.errors).map((k) => k + ' (' + B.errors[k].replace(/ \(add to schema.*$/, '') + ')').join('; '));
    for (const d of open.slice(0, show)) console.log('  OPEN ' + d.metric + ' @' + d.office + ' ' + d.field + ': script ' + JSON.stringify(d.a) + ' | module ' + JSON.stringify(d.b));
    if (open.length > show) console.log('  … ' + (open.length - show) + ' more');
    if (a.out) fs.writeFileSync(a.out, JSON.stringify({ snap, asOf, info, scriptMs, buildMs, moduleMs, explained, open }, null, 1) + '\n');
    process.exitCode = open.length || process.exitCode ? 1 : 0;
}

if (require.main === module) main();
module.exports = { diff, schemaFor, buildRows, KNOWN };
