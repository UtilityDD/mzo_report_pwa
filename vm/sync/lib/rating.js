'use strict';
// The performance rating, precomputed next to the snapshots after each sync (docs/rating/metrics-layer.md).
//
// precompute(dir): reads the snapshots of the datasets lib/rating_metrics.js needs, turns each into
// lean uniform rows in this process with the rating's own schema (MzoRatingMetrics.schemaFor: only
// the fields it reads, so the page schemas never matter here), computes the metrics document, rates
// it with lib/rating.js and writes, each with .gz and .br (temp files, then rename):
//   rating.json          the rating document (MzoRating.rate output), served by GET /api/data/rating
//   rating-metrics.json  the metrics document it was rated from (GET /api/data/rating?part=metrics)
//   rating.meta.json     { inputs, code, asOf, builtAt, ms, maxRssMb, datasets, errors, files }, written last
// Nothing is rebuilt while the inputs are unchanged: the code (lib/rating_metrics.js, lib/rating.js,
// lib/uniform.js, lib/offices.js, data/costcenter.json), the reference date and every input
// snapshot's version. One dataset is held at a time where the metrics allow it (release).
//
// handler(ctx): Express-style GET /api/data/rating. 401 without a session; 204 when mirror mode is
// off, nothing is built yet, or it was built by other code than this process runs (the page then
// computes the rating in the browser); else the bytes with ETag / 304 and br / gzip.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const APP = path.resolve(__dirname, '..', '..', '..');
const CODE_FILES = ['lib/rating_metrics.js', 'lib/rating.js', 'lib/uniform.js', 'lib/offices.js', 'data/costcenter.json'];
const PARTS = { rating: 'rating.json', metrics: 'rating-metrics.json' };
const META = 'rating.meta.json';
const SNAPSHOT_FILE = /^[a-z0-9_]+\.(csv|tsv|json)$/;

const sha1 = (x) => crypto.createHash('sha1').update(x).digest('hex');

/** Identity of the code that computes the rating: a change makes the precomputed files stale. */
function codeHash(app) {
    const h = crypto.createHash('sha1');
    for (const f of CODE_FILES) {
        try { h.update(fs.readFileSync(path.join(app || APP, f))); } catch (_) { h.update('-'); }
        h.update('\u0000');
    }
    return h.digest('hex').slice(0, 16);
}

function readMeta(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, META), 'utf8')); } catch (_) { return null; }
}

/** The modules, with the old SAP cost centres loaded as vm/sync/lib/rows.js loads them. */
function libs(app) {
    const root = app || APP;
    const U = require(path.join(root, 'lib', 'uniform.js'));
    const O = require(path.join(root, 'lib', 'offices.js'));
    if (!U.__mzoOffices) {
        let cc = [];
        try { cc = JSON.parse(fs.readFileSync(path.join(root, 'data', 'costcenter.json'), 'utf8')); } catch (_) { /* none */ }
        U.useOffices(O, cc);
        U.__mzoOffices = true;
    }
    return { U, O, M: require(path.join(root, 'lib', 'rating_metrics.js')), R: require(path.join(root, 'lib', 'rating.js')) };
}

/**
 * One snapshot → the rating's uniform rows, holding only the columns it needs while building.
 * lib/uniform.js keeps every source column until the end of a build, which for the 18 MB meter
 * sheet is most of a 256 MB heap; here the cells are cut down first to the pinned fields, the
 * columns lib/offices.js reads the office from, and a sentinel that is non-empty exactly where the
 * source row is (so blank-row dropping is unchanged). The result equals U.build(text, schema) in
 * every field the schema pins and in the office fields (scripts/qa/rating-metrics-identity.js --vm
 * --lean-check). Falls back to the plain build where cutting columns could rename a field
 * (repeated or empty headers), for header-less sheets and for JSON.
 */
function leanBuild(L, key, text, format, version) {
    const { U, O, M } = L;
    const schema = M.schemaFor(key);
    const plain = () => U.build(text, { key, version, format, schema });
    if (format === 'json' || schema.header === false || schema.header_row) return plain();
    let head = null;
    U.eachRow(text, format === 'tsv' ? '\t' : ',', format !== 'tsv', (r) => { if (!head) head = r.slice(); });
    if (!head) return plain();
    const src = head.map((h) => U.cleanHeader(h));
    if (src.some((h) => h === '')) return plain();
    const names = U.fieldNames(src);
    const want = new Set(Object.keys(schema.fields));
    const keep = new Set();
    names.forEach((n, i) => { if (want.has(n)) keep.add(i); });
    for (const f of Object.keys(schema.fields)) for (const a of (schema.fields[f].aliases || [])) src.forEach((h, i) => { if (h === a || U.baseName(h, i) === U.baseName(a, 0)) keep.add(i); });
    if (schema.offices !== false) {
        if (schema.offices && typeof schema.offices === 'object') {
            for (const role of ['codes', 'cccs', 'divisions', 'regions']) for (const f of schema.offices[role] || []) names.forEach((n, i) => { if (n === f || U.baseName(src[i], i) === f) keep.add(i); });
        } else {
            const roles = O.officeColumns(key, src.map((h, i) => ({ source_name: h, name: names[i], index: i })));
            if (roles) for (const role of Object.keys(roles)) for (const c of roles[role]) keep.add(c.index);
        }
    }
    const idx = [...keep].sort((a, b) => a - b);
    const sub = idx.map((i) => src[i]);
    const subNames = U.fieldNames(sub);
    if (subNames.some((n, k) => n !== names[idx[k]]) || subNames.includes('rating_row')) return plain(); // a name would change
    const grid = [sub.concat(['rating row'])];
    let first = true;
    U.eachRow(text, format === 'tsv' ? '\t' : ',', format !== 'tsv', (r) => {
        if (first) { first = false; return; }
        const out = new Array(idx.length + 1);
        for (let k = 0; k < idx.length; k++) out[k] = r[idx[k]] === undefined ? '' : r[idx[k]];
        let any = false;
        for (let c = 0; c < r.length && !any; c++) if (String(r[c]).trim() !== '') any = true;
        out[idx.length] = any ? '1' : '';
        grid.push(out);
    });
    return U.build(grid, { key, version, format, schema });
}

/** What the rating is computed from: code, reference date and each input's snapshot version. */
function inputsOf(manifest, M, code, asOf) {
    const versions = {};
    for (const k of M.DATASETS) {
        const e = manifest.datasets && manifest.datasets[k];
        versions[k] = e && !e.sensitive ? String(e.version || '') : null;
    }
    return { key: sha1(JSON.stringify([code, asOf, versions])).slice(0, 24), versions };
}

function writeAtomic(dir, name, text) {
    const final = path.join(dir, name);
    const tmp = path.join(dir, '.' + name + '.' + process.pid + '.tmp');
    const buf = Buffer.from(text, 'utf8');
    const unlink = (f) => { try { fs.unlinkSync(f); } catch (_) { /* gone */ } };
    try {
        fs.writeFileSync(tmp, buf);
        fs.writeFileSync(tmp + '.gz', zlib.gzipSync(buf, { level: 6 }));
        fs.writeFileSync(tmp + '.br', zlib.brotliCompressSync(buf, { params: {
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
            [zlib.constants.BROTLI_PARAM_QUALITY]: buf.length > 1024 * 1024 ? 6 : 9,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }));
        fs.renameSync(tmp + '.gz', final + '.gz');
        fs.renameSync(tmp + '.br', final + '.br');
        fs.renameSync(tmp, final);
    } catch (err) {
        [tmp, tmp + '.gz', tmp + '.br'].forEach(unlink);
        throw err;
    }
    const digest = sha1(buf);
    return { file: name, bytes: buf.length, sha1: digest, etag: '"g-' + digest.slice(0, 24) + '"' };
}

/**
 * Compute and write the rating when its inputs changed (or with force).
 * opts: { app, force, asOf, minMinutes (rebuild changed inputs at most this often), log }
 * @returns {{ status: 'built'|'fresh'|'recent'|'no-manifest', meta?: object }}
 */
function precompute(dir, opts) {
    const o = opts || {};
    const app = o.app || APP;
    const log = o.log || (() => {});
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (_) { return { status: 'no-manifest' }; }
    const L = libs(app), { M, R } = L;
    const code = codeHash(app);
    const asOf = o.asOf || String(manifest.generatedAt || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    const inputs = inputsOf(manifest, M, code, asOf);
    const old = readMeta(dir);
    const present = old && Object.values(PARTS).every((f) => fs.existsSync(path.join(dir, f)));
    if (!o.force && present && old.inputs === inputs.key && old.code === code) return { status: 'fresh', meta: old };
    // Inputs changed but the last build is recent (the docket sheet changes at nearly every sync):
    // wait, unless the code changed (then the server would not serve the old files at all).
    const age = old ? (Date.now() - Date.parse(old.builtAt)) / 60000 : Infinity;
    if (!o.force && present && old.code === code && age < (o.minMinutes || 0)) return { status: 'recent', meta: old };
    const t0 = Date.now();
    const datasets = {};
    // One dataset's snapshot → lean uniform rows (lib/uniform.js, the rating's own schema).
    const source = (key) => {
        const e = manifest.datasets && manifest.datasets[key];
        if (!e || e.sensitive || !SNAPSHOT_FILE.test(String(e.file || ''))) return null;
        const file = path.join(dir, e.file);
        if (!fs.existsSync(file)) return null;
        const t = Date.now();
        let text = fs.readFileSync(file, 'utf8');
        const res = leanBuild(L, key, text, path.extname(e.file).slice(1), e.version);
        text = null;
        const missing = res.issues.filter((i) => i.check === 'header.missing').map((i) => i.column);
        const d = datasets[key] || (datasets[key] = { version: e.version, rows: res.stats.rows, loads: 0, ms: 0 });
        d.loads++; d.ms += Date.now() - t;
        if (missing.length) d.missing = missing;
        return res;
    };
    const metrics = M.computeSync(source, { manifest, asOf, mode: 'vm', release: true, generatedAt: new Date().toISOString() });
    const tm = Date.now();
    const rating = R.rate(metrics);
    const tr = Date.now();
    const files = { metrics: writeAtomic(dir, PARTS.metrics, JSON.stringify(metrics)), rating: writeAtomic(dir, PARTS.rating, JSON.stringify(rating)) };
    const meta = {
        inputs: inputs.key, code, asOf, builtAt: new Date().toISOString(), ms: Date.now() - t0,
        msMetrics: tm - t0, msRate: tr - tm, maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
        manifestGeneratedAt: manifest.generatedAt || null, datasets, errors: metrics.errors, warnings: metrics.warnings || {}, files
    };
    const mtmp = path.join(dir, '.' + META + '.' + process.pid + '.tmp');
    fs.writeFileSync(mtmp, JSON.stringify(meta, null, 1));
    fs.renameSync(mtmp, path.join(dir, META));
    log(`[rating] ${Object.keys(metrics.metrics).length} metrics, ${Object.keys(metrics.offices).length} offices` +
        (Object.keys(metrics.errors).length ? `, ${Object.keys(metrics.errors).length} left out (${Object.keys(metrics.errors).join(', ')})` : '') +
        ` in ${meta.ms} ms, max RSS ${meta.maxRssMb} MB`);
    return { status: 'built', meta };
}

/* ---------------- GET /api/data/rating ---------------- */

function etagHit(req, etag) {
    const inm = req.headers['if-none-match'];
    return !!inm && String(inm).split(',').some((p) => { p = p.trim().replace(/^W\//i, ''); return p === '*' || p === etag; });
}

/** Encodings the client accepts (q > 0), br first. */
function encodings(header) {
    const ok = {};
    String(header || '').toLowerCase().split(',').forEach((part) => {
        const [name, ...params] = part.trim().split(';');
        const q = params.map((x) => /^\s*q=([\d.]+)/.exec(x)).filter(Boolean)[0];
        if (name) ok[name.trim()] = q ? Number(q[1]) > 0 : true;
    });
    return ['br', 'gzip'].filter((e) => ok[e] || (ok[e] === undefined && ok['*']));
}

/**
 * Express-style handler for GET /api/data/rating[?part=metrics]. ctx: { dir, app, on() → bool, log }.
 * 401 without a session; 204 (no body) when mirror mode is off, nothing is built yet, or the files
 * were built by other code than this process runs; 200 with ETag, 304, precompressed br / gzip.
 */
function handler(ctx) {
    const app = ctx.app || APP;
    const code = codeHash(app); // this process's code: a rating built by other code is not served
    const log = ctx.log || console;
    const none = (res) => { res.setHeader('Cache-Control', 'private, no-cache'); return res.status(204).end(); };
    return async function rating(req, res) {
        if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
        const part = String((req.query && req.query.part) || 'rating');
        if (!PARTS[part]) return res.status(400).json({ status: 'error', message: 'part must be rating or metrics' });
        if (!ctx.dir || !ctx.on || !ctx.on()) return none(res);
        try {
            const meta = readMeta(ctx.dir);
            const f = meta && meta.code === code && meta.files && meta.files[part];
            if (!f) return none(res);
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'private, no-cache');
            res.setHeader('Vary', 'Accept-Encoding');
            res.setHeader('ETag', f.etag);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            if (etagHit(req, f.etag)) return res.status(304).end();
            const base = path.join(ctx.dir, PARTS[part]);
            let fh = null, enc = '';
            for (const x of encodings(req.headers['accept-encoding']).concat([''])) {
                try { fh = await fs.promises.open(x ? base + (x === 'br' ? '.br' : '.gz') : base, 'r'); enc = x; break; } catch (_) { /* next */ }
            }
            if (!fh) { res.removeHeader('ETag'); res.removeHeader('Content-Type'); return none(res); }
            const st = await fh.stat();
            if (enc) res.setHeader('Content-Encoding', enc);
            res.setHeader('Content-Length', st.size);
            res.status(200);
            if (req.method === 'HEAD') { await fh.close(); return res.end(); }
            // The open handle keeps these bytes even if a rebuild renames a new file into place.
            const stream = fh.createReadStream({ highWaterMark: 64 * 1024 });
            stream.on('error', () => res.destroy());
            stream.pipe(res);
        } catch (err) {
            log.error('[rating]', err.message);
            if (!res.headersSent) return res.status(500).json({ status: 'error', message: 'Rating unavailable' });
            res.destroy();
        }
    };
}

module.exports = { codeHash, readMeta, inputsOf, leanBuild, libs, precompute, handler, PARTS, META, CODE_FILES };
