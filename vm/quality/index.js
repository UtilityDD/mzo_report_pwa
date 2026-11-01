'use strict';
// MZO data quality checks (see docs/data-quality.md).
//
//   require('vm/quality').check(datasetKey, collectionName, ctx)
//
// is called by vm/sync/run.js after each successful sync of a dataset. It streams the dataset
// once (the raw snapshot the sync keeps, or the ds_ records for sensitive datasets without a
// snapshot), runs the per-dataset checks, the cross-dataset checks the dataset takes part in,
// and writes sys_quality_issues and sys_quality_scores. It never throws: a failure is logged and
// the sync goes on.
//
// ctx: { pb, registry, source, summary, log, before?, snapshotDir?, officeIssues?, now? }
//   pb           vm/sync PocketBase client (superuser)
//   registry     vm/sync Registry (sys_datasets records by key, already updated by this sync)
//   source       the source adapter (primaryKey, schedule, header, …)
//   before       the sys_datasets record from before this sync (for header drift), optional
//   officeIssues office.* findings of the office enrichment (dq-offices), optional
//
// Memory: one pass, constant per column, ~12 bytes per row for the duplicate checks.

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { Checker, freshnessIssue } = require('./lib/engine');
const { createResolver } = require('./lib/offices');
const input = require('./lib/input');
const cross = require('./lib/cross');
const { saveDataset } = require('./lib/store');
const { score } = require('./lib/score');

// Check ids the office enrichment reports itself; with ctx.officeIssues these are taken from it.
const OFFICE_EXTERNAL = ['office.unknown_region', 'office.unknown_division', 'office.unknown_ccc', 'office.unknown_code',
    'office.code_name_mismatch', 'office.parent_mismatch', 'office.legacy_division', 'office.outside_zone'];
const STORAGE_META_BASE = 'https://gmasnqebdogtavoudbke.supabase.co/storage/v1/object/public/reports/';

let resolverCache = null;
let officesLib; // lib/offices.js (dq-offices' canonical office list), when present

/** The canonical office module, if this checkout has it (or MZO_OFFICES_LIB points at one). */
function officeModule() {
    if (officesLib !== undefined) return officesLib;
    officesLib = null;
    for (const f of [process.env.MZO_OFFICES_LIB, path.join(__dirname, '..', '..', 'lib', 'offices.js')]) {
        if (!f) continue;
        try {
            const m = require(f);
            if (m && typeof m.enricher === 'function') {
                officesLib = m;
                break;
            }
        } catch (_) { /* not there */ }
    }
    return officesLib;
}
function resolver() {
    if (!resolverCache) resolverCache = createResolver();
    return resolverCache;
}

/** GET only, with a timeout (the checks never write to a source). */
async function httpGet(url, timeoutMs = 120000) {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
        try { await res.body?.cancel(); } catch (_) { /* ignore */ }
        throw new Error(`GET ${url.split('?')[0]}: HTTP ${res.status}`);
    }
    return res;
}

// ---- header drift ----------------------------------------------------------------------------

function stateFile() {
    const dir = process.env.MZO_QUALITY_STATE_DIR || process.env.CACHE_DIRECTORY || path.join(__dirname, '.state');
    return path.join(dir, 'headers.json');
}

function readState() {
    try {
        return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    } catch (_) {
        return {};
    }
}

/** Per dataset: { header: [...], asOn: {column, date, max_age_days}, agedOn: 'yyyy-mm-dd' } (an array is an old header-only entry). */
function stateOf(key) {
    const e = readState()[key];
    return Array.isArray(e) ? { header: e } : e || {};
}

function writeState(key, patch) {
    try {
        const file = stateFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const st = readState();
        st[key] = Object.assign(Array.isArray(st[key]) ? { header: st[key] } : st[key] || {}, patch);
        const tmp = file + '.' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(st));
        fs.renameSync(tmp, file);
    } catch (_) { /* drift and re-ageing just restart next time */ }
}

/** header.drift: columns renamed, added or removed since the previous run. */
function headerDrift(prev, cur) {
    if (!Array.isArray(prev) || !prev.length || !Array.isArray(cur)) return null;
    const norm = (h) => String(h || '').replace(/\s+/g, ' ').trim();
    const p = prev.map(norm).filter(Boolean);
    const c = cur.map(norm).filter(Boolean);
    const removed = p.filter((h) => !c.includes(h));
    const added = c.filter((h) => !p.includes(h));
    if (!removed.length && !added.length) return null;
    const changes = [];
    const renamedFrom = new Set();
    const renamedTo = new Set();
    // Same position, different name → renamed.
    for (const r of removed) {
        const i = p.indexOf(r);
        const at = c[i];
        if (at && added.includes(at) && !renamedTo.has(at)) {
            changes.push({ change: 'renamed', from: r, to: at });
            renamedFrom.add(r);
            renamedTo.add(at);
        }
    }
    for (const r of removed) if (!renamedFrom.has(r)) changes.push({ change: 'removed', column: r });
    for (const a of added) if (!renamedTo.has(a)) changes.push({ change: 'added', column: a });
    const breaking = changes.some((x) => x.change !== 'added');
    return {
        check: 'header.drift', severity: breaking ? 'warn' : 'info', column: '', count: changes.length, sample: changes.slice(0, 10), source_fix: breaking,
        hint: breaking
            ? 'Columns were renamed or removed since the last sync. Pages look columns up by header text, so a renamed column shows up empty. Restore the old header, or tell the app team so the page can follow.'
            : 'New columns appeared since the last sync. Nothing breaks; pages ignore columns they do not know.'
    };
}

// ---- one dataset -------------------------------------------------------------------------------

/**
 * Run the per-dataset checks on one input.
 * @param {object} o { key, meta (source-like: primaryKey, schedule, header, sourceType), rows (async iterable of arrays,
 *   header first), rawValues, objectRows, firstRowNo, officeIssues, previousHeader, now }
 * @returns {Promise<{rows, issues, facts, asOn, header, stats}>}
 */
async function analyse(o) {
    const specs = cross.factSpecsFor(o.key);
    const facts = specs.map((s, i) => cross.collector(s.check + '#' + i, s.spec));
    // Outside the sync (audit), run the office enrichment here so the findings match the hook's.
    const lib = !Array.isArray(o.officeIssues) && o.useOfficeLib !== false ? officeModule() : null;
    let enr = null;
    const external = Array.isArray(o.officeIssues) || !!lib;
    const checker = new Checker({
        key: o.key,
        primaryKey: (o.meta && o.meta.primaryKey) || null,
        schedule: o.meta && o.meta.schedule,
        sourceType: o.meta && o.meta.sourceType,
        header: o.meta ? o.meta.header : undefined,
        dateOrder: o.meta && o.meta.dateOrder,
        resolver: resolver(),
        rawValues: !!o.rawValues,
        objectRows: !!o.objectRows,
        firstRowNo: o.firstRowNo,
        skipOffice: external ? OFFICE_EXTERNAL : [],
        facts,
        now: o.now
    });
    let header = null;
    const layoutSheet = o.meta && o.meta.header === false;
    async function* tap(src) {
        for await (const item of src) {
            if (header === null && Array.isArray(item)) {
                header = item.map((x) => String(x == null ? '' : x));
                if (lib && !layoutSheet) enr = lib.enricher(o.key, header.map((h, i) => ({ source_name: h.replace(/\s+/g, ' ').trim(), name: h.replace(/\s+/g, ' ').trim(), index: i })));
            } else if (item && item.extendHeader) {
                header = item.extendHeader.map(String);
                if (lib && !layoutSheet) enr = lib.enricher(o.key, header.map((h, i) => ({ source_name: h, name: h, index: i })));
            } else if (enr && Array.isArray(item)) {
                enr.enrich(item.map((v) => (typeof v === 'string' ? v.trim() : v)));
            }
            yield item;
        }
    }
    await input.feed(checker, tap(o.rows));
    const res = checker.finish();
    if (!checker.layout && !o.objectRows) {
        const drift = headerDrift(o.previousHeader, header);
        if (drift) res.issues.push(drift);
    }
    const officeIssues = Array.isArray(o.officeIssues) ? o.officeIssues : enr ? enr.issues() : [];
    if (external) {
        for (const i of officeIssues) {
            if (i && (!i.dataset || i.dataset === o.key)) res.issues.push(Object.assign({ severity: 'warn', source_fix: true, column: '', count: 0, sample: [] }, i));
        }
    }
    // Facts by cross check id (several specs may serve one check).
    const byCheck = {};
    specs.forEach((s, i) => { byCheck[s.check] = res.facts[s.check + '#' + i]; });
    res.facts = byCheck;
    res.header = header;
    return res;
}

/** Stream a dataset into fact collectors only (the other side of a cross check). */
async function collectFacts(rows, specsByCheck) {
    const cols = Object.entries(specsByCheck).map(([id, spec]) => cross.collector(id, spec));
    let first = true;
    for await (const item of rows) {
        if (first) {
            first = false;
            for (const c of cols) c.header(Array.isArray(item) ? item : []);
            continue;
        }
        if (item && item.extendHeader) {
            for (const c of cols) c.header(item.extendHeader);
            continue;
        }
        for (const c of cols) c.row(item);
    }
    const out = {};
    for (const c of cols) out[c.id] = c.done();
    return out;
}

/**
 * Cross checks that involve `key`, given a way to get any dataset's facts.
 * @param {string} key
 * @param {(datasetKey, checkId, spec) => Promise<object|null>} getFacts
 * @returns {Promise<{ byPrimary: { [dataset]: issue[] }, evaluated: { [dataset]: Set<checkId> } }>}
 */
async function runCross(key, getFacts, ctx) {
    const byPrimary = {};
    const evaluated = {};
    for (const c of cross.checksInvolving(key)) {
        const f = {};
        let ok = true;
        for (const k of c.needs) {
            try {
                f[k] = await getFacts(k, c.id, c.facts[k]);
            } catch (err) {
                if (ctx && ctx.log) ctx.log(`quality: ${c.id} could not read ${k}: ${err.message}`);
                f[k] = null;
            }
            if (!f[k]) ok = false;
        }
        if (!ok) continue;
        const issues = c.run(f, { resolver: resolver() }) || [];
        (byPrimary[c.primary] = byPrimary[c.primary] || []).push(...issues);
        const ev = (evaluated[c.primary] = evaluated[c.primary] || new Set());
        for (const id of c.produces || producedBy(c)) ev.add(id);
    }
    return { byPrimary, evaluated };
}

function producedBy(c) {
    const map = {
        'cross.nsc_withheld': ['cross.overlap', 'cross.report_date'],
        'cross.stock_materials': ['cross.unknown_material'],
        'cross.allotment_materials': ['cross.unknown_material'],
        'cross.defective_totals': ['cross.total_mismatch', 'cross.report_date'],
        'cross.portal_user_offices': ['cross.portal_unknown_office']
    };
    return map[c.id] || ['cross.snapshot_mismatch'];
}

// ---- inputs in the sync hook ---------------------------------------------------------------------

function snapshotDir(ctx) {
    return (ctx && ctx.snapshotDir) || process.env.MZO_SNAPSHOT_DIR || '/opt/mzo/data/snapshots';
}

/** The best input for a mirrored dataset: its raw snapshot, else its ds_ records. */
function openDataset(key, ds, src, ctx) {
    const dir = snapshotDir(ctx);
    const layout = (src && src.header === false) || (ds && Array.isArray(ds.columns) && ds.columns.length && ds.columns.every((c) => !c.source_name));
    if (ds && ds.snapshot_file) {
        const file = path.join(dir, ds.snapshot_file);
        if (fs.existsSync(file)) {
            const json = /\.json$/.test(file);
            const rows = input.fromSnapshot(file, json ? 'application/json' : /\.tsv$/.test(file) ? 'text/tab-separated-values' : 'text/csv');
            return {
                rows: layout ? prepend([], rows) : rows,
                rawValues: true,
                objectRows: json,
                firstRowNo: json || layout ? 1 : 2,
                mode: 'snapshot'
            };
        }
    }
    if (!ctx.pb || !ds) return null;
    return {
        rows: input.fromPocketBase(ctx.pb, ds.collection || 'ds_' + key, ds.columns || []),
        rawValues: false,
        objectRows: src && src.sourceType === 'supabase_table',
        firstRowNo: src && src.sourceType === 'google_sheet' && !layout ? 2 : 1,
        mode: 'pocketbase'
    };
}

async function* prepend(first, rows) {
    yield first;
    yield* rows;
}

function metaOf(src, ds) {
    return {
        primaryKey: (src && src.primaryKey) || (ds && ds.primary_key) || null,
        schedule: (src && src.schedule) || (ds && ds.schedule),
        header: src ? src.header : undefined,
        sourceType: (src && src.sourceType) || (ds && ds.source_type),
        dateOrder: src && src.dateOrder
    };
}

/** The sync hook. Never throws. */
async function check(datasetKey, collectionName, ctx = {}) {
    const log = typeof ctx.log === 'function' ? ctx.log : () => {};
    const t0 = Date.now();
    try {
        if (!ctx.pb || !datasetKey) return null;
        if ((ctx.summary && ctx.summary.status === 'unchanged') || ctx.unchanged) return await reage(datasetKey, ctx, log);
        const reg = ctx.registry;
        const ds = reg && typeof reg.get === 'function' ? reg.get(datasetKey) : null;
        const src = ctx.source || null;
        const opened = openDataset(datasetKey, Object.assign({ collection: collectionName }, ds || {}), src, ctx);
        if (!opened) return null;
        let previousHeader = null;
        if (ctx.before && Array.isArray(ctx.before.columns)) previousHeader = ctx.before.columns.filter((c) => !c.raw_of).map((c) => c.source_name);
        else previousHeader = stateOf(datasetKey).header || null;
        const officeIssues = Array.isArray(ctx.officeIssues) ? ctx.officeIssues
            : ctx.summary && Array.isArray(ctx.summary.officeIssues) ? ctx.summary.officeIssues : undefined;

        const res = await analyse({
            key: datasetKey, meta: metaOf(src, ds), rows: opened.rows, rawValues: opened.rawValues, objectRows: opened.objectRows,
            firstRowNo: opened.firstRowNo, officeIssues, previousHeader, now: ctx.now
        });
        const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
        writeState(datasetKey, Object.assign(res.header && !opened.objectRows ? { header: res.header } : {},
            { asOn: res.asOn ? { column: res.asOn.column, date: res.asOn.date, max_age_days: res.asOn.max_age_days } : null, agedOn: today }));

        // Storage snapshots: compare with the totals in their meta.json.
        const extra = [];
        const evaluated = { [datasetKey]: new Set(['*own']) };
        if (cross.STORAGE_META[datasetKey] && res.facts.meta) {
            try {
                const meta = await (await httpGet(STORAGE_META_BASE + cross.STORAGE_META[datasetKey] + '/meta.json', 20000)).json();
                extra.push(...cross.metaChecks(datasetKey, meta, res.facts.meta));
                evaluated[datasetKey].add('cross.meta_mismatch');
            } catch (err) {
                log(`quality: ${datasetKey} meta.json: ${err.message}`);
            }
        }

        // Cross checks: this dataset's facts come from the pass above; the others are read now.
        const getFacts = async (k, checkId, spec) => {
            if (k === datasetKey) return res.facts[checkId] || null;
            let rows = null;
            if (cross.GOOGLE_FALLBACKS[k]) {
                const resp = await httpGet(cross.GOOGLE_FALLBACKS[k], 5 * 60000);
                rows = input.fromCsvStream(Readable.fromWeb(resp.body), false);
            } else {
                const other = reg && reg.get(k);
                if (!other || other.last_status === 'error') return null;
                const o = openDataset(k, other, null, ctx);
                if (!o) return null;
                rows = o.rows;
            }
            return (await collectFacts(rows, { [checkId]: spec }))[checkId];
        };
        const cr = await runCross(datasetKey, getFacts, { log });

        // Write: this dataset (own + cross issues stored under it), then any other dataset whose cross issues were re-evaluated.
        const now = ctx.now ? new Date(ctx.now) : new Date();
        const own = res.issues.concat(extra, cr.byPrimary[datasetKey] || []);
        const ownFamilies = (check) => !/^cross\./.test(check) || evaluated[datasetKey].has(check) || (cr.evaluated[datasetKey] && cr.evaluated[datasetKey].has(check));
        const saved = await saveDataset(ctx.pb, datasetKey, own, { families: ownFamilies, rows: res.rows, now });
        for (const other of Object.keys(cr.evaluated)) {
            if (other === datasetKey) continue;
            const otherDs = reg && reg.get(other);
            if (!otherDs) continue;
            await saveDataset(ctx.pb, other, cr.byPrimary[other] || [], {
                families: (c) => cr.evaluated[other].has(c), rows: otherDs.row_count || 0, now
            });
        }
        log(`quality ${datasetKey}: score ${saved.score}, ${saved.open} open (${saved.opened} new, ${saved.resolved} resolved), ${res.rows} rows via ${opened.mode} in ${Date.now() - t0} ms`);
        return saved;
    } catch (err) {
        log(`quality check for ${datasetKey} failed: ${err && err.message ? err.message : err}`);
        return null;
    }
}

/**
 * A dataset that did not change still gets older: once a day, re-age its "as on" date (kept in
 * the state file by the last full check) and update freshness.stale / freshness.future. No data is read.
 */
async function reage(key, ctx, log) {
    const st = stateOf(key);
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    if (!st.asOn || !st.asOn.date || st.agedOn === today) return null;
    const age = Math.round((Date.parse(today) - Date.parse(st.asOn.date)) / 86400000);
    const issue = freshnessIssue(Object.assign({}, st.asOn, { age_days: age }));
    const ds = ctx.registry && ctx.registry.get(key);
    const saved = await saveDataset(ctx.pb, key, issue ? [issue] : [], {
        families: (c) => c === 'freshness.stale' || c === 'freshness.future', rows: (ds && ds.row_count) || 0, now: ctx.now ? new Date(ctx.now) : new Date()
    });
    writeState(key, { agedOn: today });
    log(`quality ${key}: unchanged, as on ${st.asOn.date} is ${age} days old; score ${saved.score}`);
    return saved;
}

module.exports = { check, reage, analyse, collectFacts, runCross, headerDrift, openDataset, score, OFFICE_EXTERNAL };
