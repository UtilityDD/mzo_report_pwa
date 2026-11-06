'use strict';
// Page views: what a heavy report page computes from several datasets, precomputed once per sync
// next to the snapshots, so the browser downloads one small JSON instead of every dataset and
// repeats none of the joins (docs/uniform-data.md, "Page views").
//
// A view (vm/sync/lib/views/<name>.js) declares:
//   inputs   uniform-rows keys it reads (their <key>.rows.json, built by vm/sync/rows.js in the same run)
//   files    app files its result depends on besides itself (e.g. the page whose rules it runs)
//   build(ctx) → { main, parts? }   ctx.each(key, fn(row object)) streams one dataset's rows,
//            ctx.doc(key) parses one whole rows document (small datasets only)
// and is written as <name>.view.json (+ <name>.<part>.view.json), each with .gz and .br, and
// <name>.view.meta.json last: { name, inputs: { key: rows sha1 }, code, files, builtAt, ms, maxRssMb }.
//
// A view is served only while it is fresh: every input's rows are fresh for the current manifest
// (vm/sync/lib/rows.js isStale) and are the bytes the view was built from, and the view's code is
// the code this process runs. Otherwise GET /api/data/view/:name answers 204 and the page computes
// what it needs itself, exactly as before (Vercel, a new dataset version not yet rebuilt, a code change).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const rows = require('./rows');

const APP = path.resolve(__dirname, '..', '..', '..');
const NAME_RE = /^[a-z][a-z0-9_]{0,48}$/;
const PART_RE = /^[a-z][a-z0-9_]{0,24}$/;
const VIEWS = ['meter_utilization', 'smart_meter', 'sheet_links_dates'];

const sha1 = (x) => crypto.createHash('sha1').update(x).digest('hex');

function viewModule(name) {
    if (!VIEWS.includes(name)) return null;
    try {
        return require(path.join(__dirname, 'views', name + '.js'));
    } catch (err) {
        console.warn(`[views] ${name}: module unusable:`, err.message);
        return null;
    }
}

/** Identity of a view's code: this file, the view's module and the app files it names. */
function codeHash(app, name) {
    const mod = viewModule(name);
    const h = crypto.createHash('sha1');
    const files = ['vm/sync/lib/views.js', `vm/sync/lib/views/${name}.js`].concat((mod && mod.files) || []);
    for (const f of files) {
        try { h.update(fs.readFileSync(path.join(app || APP, f))); } catch (_) { h.update('-'); }
        h.update('\u0000');
    }
    return h.digest('hex').slice(0, 16);
}

function file(dir, name, part) { return path.join(dir, `${name}${part ? '.' + part : ''}.view.json`); }
function metaFile(dir, name) { return path.join(dir, `${name}.view.meta.json`); }
function readJsonQuiet(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }

/**
 * The rows sha1 of each input when all are fresh for this manifest, else null. With partial (a view
 * whose inputs are independent, e.g. one date per dataset), the fresh ones only (null if none).
 * rowsCode: vm/sync/lib/rows.js codeHash of the running code.
 */
function inputVersions(app, dir, manifest, inputs, rowsCode, partial) {
    const out = {};
    for (const key of inputs) {
        const entry = manifest && manifest.datasets && manifest.datasets[key];
        const schema = entry && !entry.sensitive ? rows.schemaOf(app, key) : null;
        const meta = schema ? rows.readMeta(dir, key) : null;
        if (!schema || rows.isStale(meta, entry, rowsCode, schema)) {
            if (partial) continue;
            return null;
        }
        out[key] = meta.sha1;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * Stream the rows of <key>.rows.json: onRow(object) per row, in file order, without holding the
 * document (the rows array is scanned in 1 MB chunks; each row is parsed on its own).
 * → the document's header ({ key, version, columns, stats, … } without rows).
 */
function eachRow(dir, key, onRow) {
    const fd = fs.openSync(path.join(dir, key + '.rows.json'), 'r');
    const buf = Buffer.alloc(1 << 20);
    const dec = new StringDecoder('utf8'); // keeps a character cut at a chunk end for the next chunk
    const MARK = '"rows":[';
    let head = '', header = null, names = null, done = false;
    let pending = '', inStr = false, esc = false, depth = 0;
    try {
        for (let pos = 0; !done;) {
            const n = fs.readSync(fd, buf, 0, buf.length, pos);
            if (!n) break;
            pos += n;
            let s = dec.write(buf.subarray(0, n));
            if (!header) {
                head += s;
                const at = head.indexOf(MARK);
                if (at < 0) continue;
                header = JSON.parse(head.slice(0, at) + '"rows":[]}');
                names = header.columns.map((c) => c.name);
                s = head.slice(at + MARK.length);
                head = '';
            }
            let from = depth > 0 ? 0 : -1; // where the open row starts in s (its earlier text is in pending)
            for (let i = 0; i < s.length; i++) {
                const ch = s.charCodeAt(i);
                if (inStr) {
                    if (esc) esc = false;
                    else if (ch === 92) esc = true; // backslash
                    else if (ch === 34) inStr = false; // quote
                } else if (ch === 34) inStr = true;
                else if (ch === 91) { if (depth++ === 0) from = i; } // [
                else if (ch === 93) { // ]
                    if (depth === 0) { done = true; break; } // the end of the rows array
                    if (--depth === 0) {
                        const a = JSON.parse(pending + s.slice(from, i + 1));
                        pending = '';
                        const o = {};
                        for (let k = 0; k < names.length; k++) o[names[k]] = a[k];
                        onRow(o);
                    }
                }
            }
            if (!done && depth > 0) pending += s.slice(from);
        }
    } finally {
        fs.closeSync(fd);
    }
    if (!header) throw new Error(`${key}.rows.json has no rows array`);
    if (!done) throw new Error(`${key}.rows.json ends inside the rows array`);
    return header;
}

/** Encodings the client accepts (q > 0), br first. */
function encodings(header) {
    const ok = {};
    String(header || '').toLowerCase().split(',').forEach((part) => {
        const [enc, ...params] = part.trim().split(';');
        const q = params.map((x) => /^\s*q=([\d.]+)/.exec(x)).filter(Boolean)[0];
        if (enc) ok[enc.trim()] = q ? Number(q[1]) > 0 : true;
    });
    return ['br', 'gzip'].filter((e) => ok[e] || (ok[e] === undefined && ok['*']));
}

function writeOut(final, text) {
    const tmp = path.join(path.dirname(final), '.' + path.basename(final) + '.' + process.pid + '.tmp');
    const buf = Buffer.from(text, 'utf8');
    const unlink = (f) => { try { fs.unlinkSync(f); } catch (_) { /* gone */ } };
    try {
        fs.writeFileSync(tmp, buf);
        fs.writeFileSync(tmp + '.gz', zlib.gzipSync(buf, { level: 9 }));
        fs.writeFileSync(tmp + '.br', zlib.brotliCompressSync(buf, { params: {
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
            [zlib.constants.BROTLI_PARAM_QUALITY]: buf.length > 1024 * 1024 ? 6 : 9,
            [zlib.constants.BROTLI_PARAM_LGWIN]: 20,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }));
        fs.renameSync(tmp + '.gz', final + '.gz');
        fs.renameSync(tmp + '.br', final + '.br');
        fs.renameSync(tmp, final);
    } catch (err) {
        [tmp, tmp + '.gz', tmp + '.br'].forEach(unlink);
        throw err;
    }
    const digest = sha1(buf);
    return { bytes: buf.length, sha1: digest, etag: `"w-${digest.slice(0, 24)}"` };
}

/** Build one view (inputs must be fresh). → meta. */
function buildOne(dir, name, opts) {
    const o = opts || {};
    const app = o.app || APP;
    const mod = viewModule(name);
    if (!mod) throw new Error('unknown view ' + name);
    const manifest = o.manifest || JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const versions = inputVersions(app, dir, manifest, mod.inputs, o.rowsCode || rows.codeHash(app), !!mod.partial);
    if (!versions) throw new Error('inputs not fresh');
    const t0 = Date.now();
    const ctx = {
        app,
        manifest,
        inputs: Object.keys(versions),
        each: (key, fn) => eachRow(dir, key, fn),
        doc: (key) => JSON.parse(fs.readFileSync(path.join(dir, key + '.rows.json'), 'utf8'))
    };
    const out = mod.build(ctx);
    const files = { main: writeOut(file(dir, name), JSON.stringify(Object.assign({ view: name, inputs: versions }, out.main))) };
    for (const part of Object.keys(out.parts || {})) {
        if (!PART_RE.test(part) || part === 'main') throw new Error('bad part name ' + part);
        files[part] = writeOut(file(dir, name, part), JSON.stringify(Object.assign({ view: name, part, inputs: versions }, out.parts[part])));
    }
    const meta = {
        name, inputs: versions, code: codeHash(app, name), files,
        builtAt: new Date().toISOString(), ms: Date.now() - t0, maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024)
    };
    const mtmp = metaFile(dir, name) + '.' + process.pid + '.tmp';
    fs.writeFileSync(mtmp, JSON.stringify(meta, null, 1));
    fs.renameSync(mtmp, metaFile(dir, name));
    return meta;
}

/** Rebuild every view whose inputs or code changed (or the `only` ones, or all with force). */
function buildAll(dir, opts) {
    const o = opts || {};
    const app = o.app || APP;
    const log = o.log || (() => {});
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const rowsCode = rows.codeHash(app);
    const only = o.only && o.only.length ? new Set(o.only) : null;
    const out = { built: [], fresh: [], waiting: [], failed: [] };
    for (const name of VIEWS) {
        if (only && !only.has(name)) continue;
        const mod = viewModule(name);
        if (!mod) { out.failed.push({ name, error: 'module unusable' }); continue; }
        const versions = inputVersions(app, dir, manifest, mod.inputs, rowsCode, !!mod.partial);
        if (!versions) { out.waiting.push(name); log(`[views] ${name}: inputs not fresh yet, skipped`); continue; }
        const meta = readJsonQuiet(metaFile(dir, name));
        const same = meta && meta.code === codeHash(app, name) && JSON.stringify(meta.inputs) === JSON.stringify(versions) &&
            Object.keys(meta.files || {}).every((p) => fs.existsSync(file(dir, name, p === 'main' ? '' : p)));
        if (same && !o.force) { out.fresh.push(name); continue; }
        try {
            const m = buildOne(dir, name, { app, manifest, rowsCode });
            out.built.push(m);
            log(`[views] ${name}: ${Object.keys(m.files).map((p) => p + ' ' + m.files[p].bytes + ' bytes').join(', ')} in ${m.ms} ms, max RSS ${m.maxRssMb} MB`);
        } catch (err) {
            out.failed.push({ name, error: err.message });
            log(`[views] ${name}: FAILED ${err.message}`);
        }
    }
    return out;
}

/* ---------------- GET /api/data/view/:name[?part=x] ---------------- */

function etagHit(req, etag) {
    const inm = req.headers['if-none-match'];
    return !!inm && String(inm).split(',').some((p) => { p = p.trim().replace(/^W\//i, ''); return p === '*' || p === etag; });
}

/**
 * Express-style handler. ctx: { dir, app, on() → bool, manifest() → Promise<{ data }>, log }.
 * 401 without a session; 204 (no body) when mirror mode is off or the view is missing or not fresh
 * (the page then computes it itself); 200 with ETag, 304, precompressed br / gzip.
 */
function handler(ctx) {
    const app = ctx.app || APP;
    const rowsCode = rows.codeHash(app);
    const codes = {};
    for (const name of VIEWS) if (viewModule(name)) codes[name] = codeHash(app, name);
    const log = ctx.log || console;
    const none = (res) => { res.setHeader('Cache-Control', 'private, no-cache'); return res.status(204).end(); };
    return async function view(req, res) {
        if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
        const name = String((req.params && req.params.name) || '');
        const part = String((req.query && req.query.part) || 'main');
        if (!NAME_RE.test(name) || !VIEWS.includes(name) || !PART_RE.test(part)) return res.status(404).json({ status: 'error', message: 'Not found' });
        if (!ctx.dir || !ctx.on || !ctx.on()) return none(res);
        try {
            const m = await ctx.manifest();
            const meta = readJsonQuiet(metaFile(ctx.dir, name));
            const f = meta && codes[name] && meta.code === codes[name] && meta.files && meta.files[part];
            if (!f || !m || !m.data) return none(res);
            // Every input the view was built from must still be fresh and unchanged.
            const versions = inputVersions(app, ctx.dir, m.data, Object.keys(meta.inputs || {}), rowsCode, false);
            if (!versions || JSON.stringify(versions) !== JSON.stringify(meta.inputs)) return none(res);
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'private, no-cache');
            res.setHeader('Vary', 'Accept-Encoding');
            res.setHeader('ETag', f.etag);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            if (etagHit(req, f.etag)) return res.status(304).end();
            const base = file(ctx.dir, name, part === 'main' ? '' : part);
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
            log.error(`[views] ${name}:`, err.message);
            if (!res.headersSent) return res.status(500).json({ status: 'error', message: 'View unavailable' });
            res.destroy();
        }
    };
}

module.exports = { VIEWS, codeHash, eachRow, inputVersions, buildOne, buildAll, handler };
