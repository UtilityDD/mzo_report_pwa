'use strict';
// Uniform rows next to each snapshot (docs/uniform-data.md). For every dataset that has a
// schema/<key>.json and a snapshot in the manifest, lib/uniform.js turns the snapshot bytes into
// <key>.rows.json (+ .gz, .br), and <key>.rows.meta.json records what it was built from:
//   { key, snapshot (manifest version), code (hash of lib/uniform.js, lib/offices.js,
//     data/costcenter.json), schemaFile (hash of the schema text, as mzo_rows.js computes it),
//     logic, schema, rows, bytes, sha1, etag, builtAt, ms }
// Rows are stale when any of snapshot / code / schemaFile differs; stale rows are never served
// (the browser then builds them itself from /api/data/file/<key>) and are rebuilt by
// `node vm/sync/rows.js` after each sync run. The same file serves GET /api/data/rows/:key.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const APP = path.resolve(__dirname, '..', '..', '..');
const KEY_RE = /^[a-z][a-z0-9_]{0,48}$/;

function sha1(buf) {
    return crypto.createHash('sha1').update(buf).digest('hex');
}

function uniform(app) {
    const U = require(path.join(app || APP, 'lib', 'uniform.js'));
    if (!U.__mzoOffices) {
        let offices = null;
        try { offices = require(path.join(app || APP, 'lib', 'offices.js')); } catch (_) { /* no office fields */ }
        let cc = [];
        try { cc = JSON.parse(fs.readFileSync(path.join(app || APP, 'data', 'costcenter.json'), 'utf8')); } catch (_) { /* none */ }
        U.useOffices(offices, cc); // the browser does the same with /data/costcenter.json
        U.__mzoOffices = true;
    }
    return U;
}

/** Identity of the code that builds rows: a change here makes every rows file stale. */
function codeHash(app) {
    const h = crypto.createHash('sha1');
    for (const f of ['lib/uniform.js', 'lib/offices.js', 'data/costcenter.json']) {
        try { h.update(fs.readFileSync(path.join(app || APP, f))); } catch (_) { h.update('-'); }
        h.update('\u0000');
    }
    return h.digest('hex').slice(0, 16);
}

/** schema/<key>.json → { doc, hash } (hash as mzo_rows.js computes it from the same text), or null. */
function schemaOf(app, key) {
    if (!KEY_RE.test(String(key || ''))) return null;
    let text;
    try { text = fs.readFileSync(path.join(app || APP, 'schema', key + '.json'), 'utf8'); } catch (_) { return null; }
    try { return { doc: JSON.parse(text), hash: uniform(app).hash32(text) }; } catch (_) { return null; }
}

function metaFile(dir, key) { return path.join(dir, key + '.rows.meta.json'); }
function rowsFile(dir, key) { return path.join(dir, key + '.rows.json'); }

function readMeta(dir, key) {
    try { return JSON.parse(fs.readFileSync(metaFile(dir, key), 'utf8')); } catch (_) { return null; }
}

function isStale(meta, entry, code, schema) {
    return !meta || !entry || !schema || meta.snapshot !== entry.version || meta.code !== code || meta.schemaFile !== schema.hash;
}

function unlinkQuiet(f) { try { fs.unlinkSync(f); } catch (_) { /* gone */ } }

/** Build one dataset's rows. → meta (also written to <key>.rows.meta.json). */
async function buildOne(dir, key, entry, opts) {
    const o = opts || {};
    const app = o.app || APP;
    const U = uniform(app);
    const schema = o.schema || schemaOf(app, key);
    if (!schema) throw new Error(`no schema/${key}.json`);
    const file = String(entry.file || '');
    if (!/^[a-z0-9_]+\.(csv|tsv|json)$/.test(file)) throw new Error(`bad snapshot file name ${file}`);
    const t0 = Date.now();
    let text = fs.readFileSync(path.join(dir, file), 'utf8');
    let res = U.build(text, { key, version: entry.version, format: path.extname(file).slice(1), schema: schema.doc });
    text = null;
    const final = rowsFile(dir, key);
    const tmp = path.join(dir, `.${key}.rows.json.${process.pid}.tmp`);
    const hash = crypto.createHash('sha1');
    let bytes = 0;
    const fd = fs.openSync(tmp, 'w');
    try {
        U.stringify(res, (chunk) => {
            const buf = Buffer.from(chunk, 'utf8');
            hash.update(buf);
            bytes += buf.length;
            fs.writeSync(fd, buf);
        });
    } finally {
        fs.closeSync(fd);
    }
    const rowCount = res.stats.rows;
    const logic = res.logic;
    const schemaId = res.schema;
    res = null;
    try {
        await pipeline(fs.createReadStream(tmp), zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp + '.gz'));
        await pipeline(fs.createReadStream(tmp), zlib.createBrotliCompress({
            params: {
                [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
                [zlib.constants.BROTLI_PARAM_QUALITY]: bytes > 1024 * 1024 ? 5 : 9,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes
            }
        }), fs.createWriteStream(tmp + '.br'));
        fs.renameSync(tmp + '.gz', final + '.gz');
        fs.renameSync(tmp + '.br', final + '.br');
        fs.renameSync(tmp, final);
    } catch (err) {
        [tmp, tmp + '.gz', tmp + '.br'].forEach(unlinkQuiet);
        throw err;
    }
    const digest = hash.digest('hex');
    const meta = {
        key, snapshot: entry.version, code: o.code || codeHash(app), schemaFile: schema.hash, logic, schema: schemaId,
        rows: rowCount, bytes, sha1: digest, etag: `"r-${digest.slice(0, 24)}"`, builtAt: new Date().toISOString(), ms: Date.now() - t0
    };
    const mtmp = metaFile(dir, key) + `.${process.pid}.tmp`;
    fs.writeFileSync(mtmp, JSON.stringify(meta, null, 1));
    fs.renameSync(mtmp, metaFile(dir, key));
    return meta;
}

/**
 * Rebuild stale rows (or the `only` keys, or all with force) for datasets with a schema file.
 * One at a time; a failure is logged and the next dataset still runs.
 * @returns {Promise<{built: object[], fresh: string[], failed: {key, error}[], skipped: string[]}>}
 */
async function buildAll(dir, opts) {
    const o = opts || {};
    const app = o.app || APP;
    const log = o.log || (() => {});
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const code = codeHash(app);
    const only = o.only && o.only.length ? new Set(o.only) : null;
    const out = { built: [], fresh: [], failed: [], skipped: [] };
    for (const key of Object.keys(manifest.datasets || {}).sort()) {
        const entry = manifest.datasets[key];
        if (only && !only.has(key)) continue;
        if (entry.sensitive) { out.skipped.push(key); continue; }
        const schema = schemaOf(app, key);
        if (!schema) { if (only) out.skipped.push(key); continue; }
        if (!o.force && !isStale(readMeta(dir, key), entry, code, schema)) { out.fresh.push(key); continue; }
        try {
            const meta = await buildOne(dir, key, entry, { app, code, schema });
            out.built.push(meta);
            log(`[rows] ${key}: ${meta.rows} rows, ${meta.bytes} bytes in ${meta.ms} ms`);
        } catch (err) {
            out.failed.push({ key, error: err.message });
            log(`[rows] ${key}: FAILED ${err.message}`);
        }
    }
    return out;
}

/** Remove rows files whose dataset has no schema or snapshot any more. */
function prune(dir, opts) {
    const app = (opts && opts.app) || APP;
    let manifest = { datasets: {} };
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (_) { return []; }
    const gone = [];
    for (const f of fs.readdirSync(dir)) {
        const m = /^([a-z][a-z0-9_]*)\.rows\.meta\.json$/.exec(f);
        if (!m) continue;
        const e = manifest.datasets[m[1]];
        if (e && !e.sensitive && schemaOf(app, m[1])) continue;
        [rowsFile(dir, m[1]), rowsFile(dir, m[1]) + '.gz', rowsFile(dir, m[1]) + '.br', metaFile(dir, m[1])].forEach(unlinkQuiet);
        gone.push(m[1]);
    }
    return gone;
}

/* ---------------- GET /api/data/rows/:key ---------------- */

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
 * Express-style handler for GET /api/data/rows/:key. ctx: { dir, app, on() → bool, manifest() →
 * Promise<{ entries: { key: entry } }>, log }. Session-gated (req.user), sensitive and unknown keys
 * 404, stale rows 404 (the client then builds its own from /api/data/file/<key>).
 * ETag = hash of the rows bytes, 304 on If-None-Match, precompressed br/gzip, no-cache.
 */
function handler(ctx) {
    const app = ctx.app || APP;
    const code = codeHash(app); // this process's code: rows built by other code are stale
    const log = ctx.log || console;
    const notFound = (res, why) => res.status(404).json({ status: 'error', message: 'Not found', reason: why });
    return async function rows(req, res) {
        if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
        const key = String((req.params && req.params.key) || '');
        if (!ctx.on() || !KEY_RE.test(key)) return notFound(res, 'off');
        try {
            const m = await ctx.manifest();
            const e = m && m.entries && m.entries[key];
            if (!e || e.sensitive) return notFound(res, 'unknown');
            const schema = schemaOf(app, key);
            if (!schema) return notFound(res, 'no schema');
            const meta = readMeta(ctx.dir, key);
            if (isStale(meta, e, code, schema)) return notFound(res, 'stale');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'private, no-cache');
            res.setHeader('Vary', 'Accept-Encoding');
            res.setHeader('ETag', meta.etag);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            if (etagHit(req, meta.etag)) return res.status(304).end();
            const base = rowsFile(ctx.dir, key);
            let fh = null, enc = '';
            for (const x of encodings(req.headers['accept-encoding']).concat([''])) {
                try { fh = await fs.promises.open(x ? base + (x === 'br' ? '.br' : '.gz') : base, 'r'); enc = x; break; } catch (_) { /* next */ }
            }
            if (!fh) return notFound(res, 'missing');
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
            log.error(`[rows] ${key}:`, err.message);
            if (!res.headersSent) return res.status(500).json({ status: 'error', message: 'Rows unavailable' });
            res.destroy();
        }
    };
}

module.exports = { codeHash, schemaOf, readMeta, isStale, buildOne, buildAll, prune, handler, KEY_RE };
