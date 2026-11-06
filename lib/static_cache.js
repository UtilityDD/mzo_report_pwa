'use strict';
// Static files (server only, never served): compression and cache headers for what express.static serves.
//
//   - Text files (HTML, JS, CSS, JSON, SVG, CSV, GeoJSON …) between 1 KB and 4 MB go out brotli- or
//     gzip-compressed. Each file version (size + mtime) is compressed once, off the main thread, and
//     the result is kept in memory (at most maxBytes, least recently used first out). The ETag is the
//     weak one express.static gives the same file, so 304s work the same whichever encoding a browser takes.
//   - A request carrying ?v= for anything but an HTML page is a versioned asset: it may be cached for a
//     year without revalidation (public, max-age=31536000, immutable). Pages bump ?v= when a shared file
//     changes (AGENTS.md), so a changed file is always a new URL. Everything else keeps max-age=0 and
//     revalidates by ETag, as before.
// On Vercel the CDN serves static files and this code never runs for them.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const COMPRESSIBLE = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.csv', '.xml',
    '.webmanifest', '.geojson', '.topojson', '.map']);
const MIN_BYTES = 1024;
const MAX_BYTES = 4 * 1024 * 1024;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, max-age=0';

/** 'br' | 'gzip' | '' from Accept-Encoding (q=0 respected; br preferred). */
function pickEncoding(header) {
    const ok = {};
    String(header || '').toLowerCase().split(',').forEach((part) => {
        const [name, ...params] = part.trim().split(';');
        const q = params.map((x) => /^\s*q=([\d.]+)/.exec(x)).filter(Boolean)[0];
        if (name) ok[name.trim()] = q ? Number(q[1]) > 0 : true;
    });
    for (const enc of ['br', 'gzip']) if (ok[enc] || (ok[enc] === undefined && ok['*'])) return enc;
    return '';
}

/** The weak ETag express.static (the etag package) gives a file: size and mtime in hex. */
function weakEtag(st) {
    return `W/"${st.size.toString(16)}-${st.mtime.getTime().toString(16)}"`;
}

function isVersioned(req) {
    const v = req.query && req.query.v;
    return typeof v === 'string' && v !== '' && !/\.html?$/i.test(req.path || '');
}

/** Cache-Control for a static file response (express.static setHeaders, and the compressed path). */
function cacheControl(req) {
    return isVersioned(req) ? IMMUTABLE : REVALIDATE;
}

function etagMatches(req, etag) {
    const inm = req.headers['if-none-match'];
    if (!inm) return false;
    const want = etag.replace(/^W\//, '');
    return String(inm).split(',').some((p) => { p = p.trim(); return p === '*' || p.replace(/^W\//, '') === want; });
}

function create(options) {
    const opts = options || {};
    const root = path.resolve(opts.root);
    const maxBytes = opts.maxBytes || 16 * 1024 * 1024;
    const log = opts.log || console;
    const cache = new Map(); // `${enc}:${abs}` -> { etag, buf } (Map order = least recently used first)
    const pending = new Map();
    let total = 0;

    function remember(key, entry) {
        const old = cache.get(key);
        if (old) { total -= old.buf.length; cache.delete(key); }
        cache.set(key, entry);
        total += entry.buf.length;
        for (const [k, e] of cache) {
            if (total <= maxBytes) break;
            cache.delete(k);
            total -= e.buf.length;
        }
    }

    function compressed(abs, enc, etag, size) {
        const key = `${enc}:${abs}`;
        const hit = cache.get(key);
        if (hit && hit.etag === etag) {
            cache.delete(key); // move to the most recently used end
            cache.set(key, hit);
            return Promise.resolve(hit.buf);
        }
        const job = `${key}|${etag}`;
        if (pending.has(job)) return pending.get(job);
        const p = fs.promises.readFile(abs).then((raw) => new Promise((resolve, reject) => {
            const done = (err, buf) => (err ? reject(err) : resolve(buf));
            if (enc === 'br') {
                zlib.brotliCompress(raw, { params: {
                    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
                    [zlib.constants.BROTLI_PARAM_QUALITY]: size > 512 * 1024 ? 7 : 9,
                    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }, done);
            } else {
                zlib.gzip(raw, { level: 9 }, done);
            }
        })).then((buf) => {
            remember(key, { etag, buf });
            return buf;
        }).finally(() => pending.delete(job));
        pending.set(job, p);
        return p;
    }

    /** Serves the compressed copy of a static text file; anything else goes on to express.static. */
    function middleware(req, res, next) {
        if ((req.method !== 'GET' && req.method !== 'HEAD') || req.headers.range) return next();
        let rel;
        try { rel = decodeURIComponent(req.path); } catch (_) { return next(); }
        if (/[\0\\]/.test(rel) || !COMPRESSIBLE.has(path.extname(rel).toLowerCase())) return next();
        const abs = path.join(root, path.posix.normalize(rel));
        if (!abs.startsWith(root + path.sep) || path.basename(abs).startsWith('.')) return next();
        res.setHeader('Vary', 'Accept-Encoding');
        const enc = pickEncoding(req.headers['accept-encoding']);
        if (!enc) return next();
        fs.stat(abs, (err, st) => {
            if (err || !st.isFile() || st.size < MIN_BYTES || st.size > MAX_BYTES) return next();
            const etag = weakEtag(st);
            res.setHeader('ETag', etag);
            res.setHeader('Last-Modified', st.mtime.toUTCString());
            res.setHeader('Cache-Control', cacheControl(req));
            if (etagMatches(req, etag)) return res.status(304).end();
            compressed(abs, enc, etag, st.size).then((buf) => {
                if (res.headersSent) return;
                res.type(path.extname(abs));
                res.setHeader('Content-Encoding', enc);
                res.setHeader('Content-Length', buf.length);
                res.status(200).end(req.method === 'HEAD' ? undefined : buf);
            }, (e) => {
                log.warn('[static] compression failed, sending the file as is:', rel, e && e.message);
                res.removeHeader('ETag');
                next();
            });
        });
    }

    return { middleware, setHeaders: (res) => res.setHeader('Cache-Control', cacheControl(res.req)), stats: () => ({ files: cache.size, bytes: total }) };
}

module.exports = { create, pickEncoding, weakEtag, cacheControl, isVersioned };
