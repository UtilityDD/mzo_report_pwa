'use strict';
// VM mirror mode (server only, never loaded in the browser).
//
// On the VM the sync (vm/sync/run.js) keeps an untouched copy of every dataset the site reads in
// MZO_SNAPSHOT_DIR: <key>.<csv|tsv|json> plus .gz and .br, and manifest.json listing them.
// With MZO_DATA_MODE=mirror and that folder present, this module:
//   - serves GET /api/data/manifest, /api/data/file/:key and /api/data/status (session required);
//   - lets server.js read report data from the snapshots instead of Google or Supabase;
//   - refreshes datasets right after a write in the app (write-through, refreshMirror).
// Anywhere else (Vercel, local default) it is off: /api/data/manifest answers 204, the other
// /api/data/* routes 404, and every helper returns null, so server.js keeps its live reads.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const os = require('os');

const DEFAULT_DIR = '/opt/mzo/data/snapshots';
const KEY_RE = /^[a-z0-9_]{1,64}$/;
// Never served even if a manifest lists them (the sync already leaves them out).
const SENSITIVE_KEYS = new Set([
    'portal_users', 'dd_user_auth', 'activity_logs', 'manpower_staff', 'manpower_pins',
    'powermap_org_units', 'powermap_editors', 'powermap_profiles'
]);
const SENSITIVE_PREFIX = /^(manpower_|portal_users)/;
// Datasets the browser writes itself (through Apps Script), which it may ask to refresh.
const CLIENT_REFRESH_KEYS = new Set(['nsc_followups', 'dtr_peak_load', 'prt_oil_tests', 'dd_visit']);
const SECRET_PARAM = /^(apikey|api_key|key|token|access_token|auth|authorization|signature|sig|secret|password|pass|pin|x-amz-signature|x-goog-signature)$/i;
const JWT_LIKE = /eyJ[\w-]{8,}\.eyJ[\w-]{8,}\./;

const DEBOUNCE_MS = 2000;
// A dataset just written is read live until its refresh finishes (read-your-writes), at most this long.
const DIRTY_MAX_MS = 3 * 60 * 1000;
const DIRTY_AFTER_FAIL_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const PARSED_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const TYPES = {
    csv: 'text/csv; charset=utf-8',
    tsv: 'text/tab-separated-values; charset=utf-8',
    json: 'application/json; charset=utf-8'
};

function sha1(text) {
    return crypto.createHash('sha1').update(text).digest('hex');
}

function isSensitive(key, entry) {
    return SENSITIVE_KEYS.has(key) || SENSITIVE_PREFIX.test(key) || !!(entry && entry.sensitive === true);
}

/** True when a URL would hand out a key or token (query secrets, credentials, JWTs). */
function urlCarriesKey(raw) {
    const s = String(raw || '');
    if (JWT_LIKE.test(s)) return true;
    try {
        const u = new URL(s, 'http://local.invalid');
        if (u.username || u.password) return true;
        for (const name of u.searchParams.keys()) if (SECRET_PARAM.test(name)) return true;
    } catch (_) {
        return true;
    }
    return false;
}

function etagHit(req, etag) {
    const inm = req.headers['if-none-match'];
    if (!inm) return false;
    return String(inm).split(',').some((part) => {
        const p = part.trim().replace(/^W\//i, '');
        return p === '*' || p === etag;
    });
}

/** Encodings the client accepts, best first, from Accept-Encoding (q-values respected). */
function acceptedEncodings(header) {
    const q = {};
    String(header || '').split(',').forEach((part) => {
        const [name, ...params] = part.trim().toLowerCase().split(';');
        if (!name) return;
        let weight = 1;
        params.forEach((p) => {
            const m = p.trim().match(/^q=([\d.]+)$/);
            if (m) weight = Number(m[1]);
        });
        q[name] = weight;
    });
    const weight = (enc) => (q[enc] != null ? q[enc] : (q['*'] != null ? q['*'] : 0));
    return ['br', 'gzip'].filter((enc) => weight(enc) > 0).sort((a, b) => weight(b) - weight(a));
}

function contentTypeOf(entry, file) {
    const ext = path.extname(file).slice(1).toLowerCase();
    let ct = String((entry && entry.contentType) || TYPES[ext] || 'application/octet-stream');
    if (!/charset=/i.test(ct) && /^(text\/|application\/json)/i.test(ct)) ct += '; charset=utf-8';
    return ct;
}

function create(options) {
    const opts = options || {};
    const env = opts.env || process.env;
    const appRoot = opts.appRoot || path.join(__dirname, '..');
    const log = opts.log || console;
    const wanted = String(env.MZO_DATA_MODE || '').trim().toLowerCase() === 'mirror';
    const dir = path.resolve(env.MZO_SNAPSHOT_DIR || DEFAULT_DIR);
    const manifestFile = path.join(dir, 'manifest.json');
    const runJs = path.join(appRoot, 'vm', 'sync', 'run.js');

    // ---- On / off ---------------------------------------------------------------------------
    let dirSeen = { at: 0, ok: false };
    function on() {
        if (!wanted) return false;
        const now = Date.now();
        if (now - dirSeen.at > 5000) {
            let ok = false;
            try { ok = fs.statSync(dir).isDirectory(); } catch (_) { ok = false; }
            if (ok !== dirSeen.ok && dirSeen.at) log.warn(`[Mirror] snapshot folder ${ok ? 'is back' : 'is gone'}: ${ok ? 'serving snapshots' : 'using live sources'}`);
            dirSeen = { at: now, ok };
        }
        return dirSeen.ok;
    }

    if (wanted) {
        const status = on() ? `on, snapshots in ${dir}` : `requested, but ${dir} does not exist: using live sources until it does`;
        log.log(`[Mirror] data mode ${status}`);
    }

    // ---- Read-your-writes: datasets being refreshed after a write are read live --------------
    const dirty = new Map(); // key -> until (ms)
    function markDirty(key, ms) {
        const until = Date.now() + ms;
        if ((dirty.get(key) || 0) < until) dirty.set(key, until);
    }
    function isDirty(key) {
        const until = dirty.get(key);
        if (!until) return false;
        if (Date.now() > until) {
            dirty.delete(key);
            return false;
        }
        return true;
    }
    function dirtyKeys() {
        return [...dirty.keys()].filter(isDirty);
    }

    // ---- Manifest (read from disk, cached by mtime + size) ----------------------------------
    let man = { mtimeMs: -1, size: -1, data: null, entries: {}, pub: null };
    let loading = null;

    function buildPublic(data) {
        const entries = {};
        const src = (data && data.datasets) || {};
        Object.keys(src).sort().forEach((key) => {
            const e = src[key];
            if (!KEY_RE.test(key) || !e || typeof e !== 'object' || isSensitive(key, e)) return;
            const out = Object.assign({}, e);
            if (Array.isArray(e.urls)) out.urls = e.urls.filter((u) => !urlCarriesKey(u));
            entries[key] = out;
        });
        return entries;
    }

    function encodeBody(generatedAt, entries) {
        const body = Buffer.from(JSON.stringify({ generatedAt: generatedAt || null, datasets: entries }), 'utf8');
        return {
            body,
            etag: `"m-${sha1(body).slice(0, 32)}"`,
            gzip: zlib.gzipSync(body, { level: 9 }),
            br: zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } })
        };
    }

    async function manifest() {
        if (!on()) return null;
        let st;
        try {
            st = await fsp.stat(manifestFile);
        } catch (_) {
            man = { mtimeMs: -1, size: -1, data: null, entries: {}, pub: null };
            return null;
        }
        if (man.data && st.mtimeMs === man.mtimeMs && st.size === man.size) return man;
        if (loading) return loading;
        loading = (async () => {
            try {
                const data = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
                const entries = buildPublic(data);
                man = { mtimeMs: st.mtimeMs, size: st.size, data, entries, pub: encodeBody(data.generatedAt, entries) };
            } catch (err) {
                // The sync renames a finished file into place, so this is a damaged manifest: keep the last good one.
                log.warn('[Mirror] manifest.json unreadable:', err.message);
                if (!man.data) return null;
            }
            return man;
        })().finally(() => { loading = null; });
        return loading;
    }

    /** The manifest as clients see it: datasets being refreshed after a write are left out, so clients load them live. */
    let partial = { sig: '', pub: null };
    async function publicManifest() {
        const m = await manifest();
        if (!m) return null;
        const skip = dirtyKeys().filter((k) => m.entries[k]).sort();
        if (!skip.length) return m.pub;
        const sig = `${m.mtimeMs}:${m.size}:${skip.join(',')}`;
        if (partial.sig !== sig) {
            const entries = Object.assign({}, m.entries);
            skip.forEach((k) => { delete entries[k]; });
            partial = { sig, pub: encodeBody(m.data.generatedAt, entries) };
        }
        return partial.pub;
    }

    function fileName(key, entry) {
        const file = String((entry && entry.file) || '');
        // Only <key>.<ext> inside the snapshot folder: never manifest.json, temp files or paths.
        return /^[a-z0-9_]+\.(csv|tsv|json)$/.test(file) && file.startsWith(key + '.') ? file : '';
    }

    /**
     * Manifest entry of a dataset the server may read from the mirror, else null: mirror off,
     * not listed, sensitive, file missing, or just written (being refreshed).
     */
    async function entry(key) {
        if (!KEY_RE.test(String(key || '')) || isSensitive(key) || isDirty(key)) return null;
        const m = await manifest();
        const e = m && m.entries[key];
        if (!e || !fileName(key, e)) return null;
        return Object.assign({ key }, e);
    }

    /** Entry whose dataHubKeys include this DataHub key (e.g. CACHE_STOCK → stock_snapshot), else null. */
    async function entryForDataHubKey(dataHubKey) {
        const m = await manifest();
        if (!m) return null;
        const key = Object.keys(m.entries).find((k) => (m.entries[k].dataHubKeys || []).includes(dataHubKey));
        return key ? entry(key) : null;
    }

    /** [{ dataHubKey, key, version, url }] for every DataHub key the mirror can serve. */
    async function dataHubEntries() {
        const m = await manifest();
        if (!m) return [];
        const out = [];
        for (const key of Object.keys(m.entries)) {
            const e = await entry(key);
            if (!e) continue;
            (e.dataHubKeys || []).forEach((dataHubKey) => out.push({ dataHubKey, key, version: e.version, url: hubUrl(e) }));
        }
        return out;
    }

    function fileUrl(key) {
        return `/api/data/file/${key}`;
    }

    /** Where the client loads a DataHub key from: the entry's same-origin dataHubUrl, else its file. */
    function hubUrl(e) {
        const u = String((e && e.dataHubUrl) || '');
        return u.startsWith('/') && !u.startsWith('//') ? u : fileUrl(e.key);
    }

    // Parsed JSON / first bytes, cached per dataset version (small files only).
    const parsed = new Map(); // key -> { version, value }
    async function readJson(key) {
        const e = await entry(key);
        if (!e) return null;
        const hit = parsed.get('j:' + key);
        if (hit && hit.version === e.version) return hit.value;
        try {
            const text = await fsp.readFile(path.join(dir, fileName(key, e)), 'utf8');
            const value = JSON.parse(text);
            if (text.length <= PARSED_CACHE_MAX_BYTES) parsed.set('j:' + key, { version: e.version, value });
            return value;
        } catch (err) {
            log.warn(`[Mirror] ${key}: snapshot unreadable, using the live source:`, err.message);
            return null;
        }
    }

    /** The first `bytes` bytes of a snapshot as text (e.g. a CSV header and first row), else null. */
    async function readHead(key, bytes) {
        const e = await entry(key);
        if (!e) return null;
        const cacheKey = `h:${key}:${bytes}`;
        const hit = parsed.get(cacheKey);
        if (hit && hit.version === e.version) return hit.value;
        let fh;
        try {
            fh = await fsp.open(path.join(dir, fileName(key, e)), 'r');
            const buf = Buffer.alloc(bytes);
            const { bytesRead } = await fh.read(buf, 0, bytes, 0);
            const value = buf.subarray(0, bytesRead).toString('utf8');
            parsed.set(cacheKey, { version: e.version, value });
            return value;
        } catch (err) {
            log.warn(`[Mirror] ${key}: snapshot unreadable, using the live source:`, err.message);
            return null;
        } finally {
            if (fh) await fh.close().catch(() => {});
        }
    }

    // ---- Write-through ------------------------------------------------------------------------
    const pendingKeys = new Set();
    const pendingReasons = [];
    let timer = null;
    let running = null; // { keys, reason, startedAt, child }
    let last = null; // { keys, reason, startedAt, finishedAt, code }
    let warnedMissing = false;

    /**
     * Refresh these datasets in the mirror soon (detached `node vm/sync/run.js --only …`),
     * coalescing calls within 2 s and running one at a time. Never blocks or throws.
     */
    function refreshMirror(keys, reason) {
        try {
            if (!on()) return false;
            const list = [].concat(keys || []).map(String).filter((k) => KEY_RE.test(k));
            if (!list.length) return false;
            if (!fs.existsSync(runJs)) {
                if (!warnedMissing) log.warn(`[Mirror] ${path.relative(appRoot, runJs)} not found: write-through refresh skipped`);
                warnedMissing = true;
                return false;
            }
            list.forEach((k) => {
                pendingKeys.add(k);
                markDirty(k, DIRTY_MAX_MS);
            });
            const why = String(reason || 'write-through').replace(/[\r\n]+/g, ' ').slice(0, 120);
            if (!pendingReasons.includes(why)) pendingReasons.push(why);
            if (!timer && !running) timer = setTimeout(flush, DEBOUNCE_MS);
            return true;
        } catch (err) {
            log.warn('[Mirror] refresh not started:', err.message);
            return false;
        }
    }

    function flush() {
        timer = null;
        if (running || !pendingKeys.size) return;
        const keys = [...pendingKeys];
        pendingKeys.clear();
        const reason = ('write-through: ' + pendingReasons.splice(0).join('; ')).slice(0, 200);
        // The same heap flags the sync's systemd unit passes, so run.js does not start a second process.
        const args = ['--max-old-space-size=160', '--max-semi-space-size=4', runJs, '--only', keys.join(','), '--reason', reason];
        let child;
        try {
            child = spawn(process.execPath, args, {
                cwd: path.dirname(runJs),
                env: Object.assign({}, process.env, { MZO_SNAPSHOT_DIR: dir }),
                detached: true,
                stdio: ['ignore', 'inherit', 'inherit']
            });
        } catch (err) {
            log.warn('[Mirror] could not start the sync:', err.message);
            keys.forEach((k) => markDirty(k, DIRTY_AFTER_FAIL_MS));
            return;
        }
        child.unref();
        // Like the timer's sync unit: low CPU priority, and first to go if memory runs out (the app
        // unit protects itself with a negative OOM score, which a child would otherwise inherit).
        try { os.setPriority(child.pid, 10); } catch (_) { /* not permitted */ }
        try { fs.writeFileSync(`/proc/${child.pid}/oom_score_adj`, '500'); } catch (_) { /* not Linux */ }
        const startedAt = Date.now();
        running = { keys, reason, startedAt, child };
        log.log(`[Mirror] refreshing ${keys.join(', ')} (${reason})`);
        const killer = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} }, RUN_TIMEOUT_MS);
        killer.unref();
        let finished = false;
        const done = (code, why) => {
            if (finished) return;
            finished = true;
            clearTimeout(killer);
            running = null;
            last = { keys, reason, startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), code };
            if (code === 0) {
                // A key written again meanwhile is still pending and stays dirty until its own run.
                keys.forEach((k) => { if (!pendingKeys.has(k)) dirty.delete(k); });
                log.log(`[Mirror] refreshed ${keys.join(', ')} in ${Date.now() - startedAt} ms`);
            } else {
                keys.forEach((k) => markDirty(k, DIRTY_AFTER_FAIL_MS));
                log.warn(`[Mirror] refresh of ${keys.join(', ')} failed (${why}); reading them live for 10 min`);
            }
            if (pendingKeys.size && !timer) timer = setTimeout(flush, 0);
        };
        child.on('error', (err) => done(-1, err.message));
        child.on('exit', (code, signal) => done(code === 0 ? 0 : (code == null ? -1 : code), signal ? `signal ${signal}` : `exit ${code}`));
    }

    // ---- HTTP routes --------------------------------------------------------------------------
    function notFound(res) {
        return res.status(404).json({ status: 'error', message: 'Not found' });
    }

    function sendBuffered(req, res, pub, contentType) {
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'private, no-cache');
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('ETag', pub.etag);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (etagHit(req, pub.etag)) return res.status(304).end();
        const enc = acceptedEncodings(req.headers['accept-encoding'])[0];
        const body = enc === 'br' ? pub.br : enc === 'gzip' ? pub.gzip : pub.body;
        if (enc) res.setHeader('Content-Encoding', enc);
        res.setHeader('Content-Length', body.length);
        return res.status(200).end(req.method === 'HEAD' ? undefined : body);
    }

    async function openVariant(base, encodings) {
        for (const enc of encodings.concat([''])) {
            try {
                const fh = await fsp.open(enc ? `${base}.${enc === 'gzip' ? 'gz' : 'br'}` : base, 'r');
                const st = await fh.stat();
                if (st.isFile()) return { fh, size: st.size, enc };
                await fh.close();
            } catch (_) { /* try the next */ }
        }
        return null;
    }

    /**
     * Copy an open file to the response through two reused 64 KB buffers: a buffer is read into again
     * only after the socket has taken its previous bytes, so a slow client holds at most 128 KB and
     * multi-MB files never churn the allocator (a plain read stream allocates a new buffer per chunk).
     */
    async function sendFile(fh, size, res) {
        const CHUNK = 64 * 1024;
        const bufs = [Buffer.allocUnsafeSlow(CHUNK), Buffer.allocUnsafeSlow(CHUNK)];
        const flushed = [null, null];
        let closed = false;
        const onClose = new Promise((resolve) => res.once('close', () => { closed = true; resolve(); }));
        const write = (chunk) => new Promise((resolve, reject) => res.write(chunk, (err) => (err ? reject(err) : resolve())));
        try {
            let pos = 0;
            for (let i = 0; pos < size && !closed; i ^= 1) {
                if (flushed[i]) await Promise.race([flushed[i], onClose]);
                if (closed) break;
                const { bytesRead } = await fh.read(bufs[i], 0, Math.min(CHUNK, size - pos), pos);
                if (!bytesRead) break;
                pos += bytesRead;
                flushed[i] = write(bytesRead === CHUNK ? bufs[i] : bufs[i].subarray(0, bytesRead));
                flushed[i].catch(() => {});
            }
            if (!closed) {
                await Promise.race([Promise.all(flushed.filter(Boolean)), onClose]);
                res.end();
            }
        } finally {
            await fh.close().catch(() => {});
        }
    }

    function mount(app) {
        app.get('/api/data/manifest', async (req, res) => {
            if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
            try {
                const pub = await publicManifest();
                // No mirror here (Vercel, local default) or no manifest yet: 204, so browsers log no error and use the live sources.
                if (!pub) {
                    res.setHeader('Cache-Control', 'private, no-cache');
                    return res.status(204).end();
                }
                return sendBuffered(req, res, pub, 'application/json; charset=utf-8');
            } catch (err) {
                log.error('[Mirror] manifest:', err.message);
                return res.status(500).json({ status: 'error', message: 'Manifest unavailable' });
            }
        });

        app.get('/api/data/file/:key', async (req, res) => {
            // Checked here too: requireAuth lets *.json/*.js paths through without a session.
            if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
            const key = String(req.params.key || '');
            if (!on() || !KEY_RE.test(key) || isSensitive(key)) return notFound(res);
            let opened = null;
            try {
                const m = await manifest();
                const e = m && m.entries[key];
                const file = e && fileName(key, e);
                if (!file || !e.version) return notFound(res);
                const etag = `"${String(e.version).replace(/[^\w.:-]/g, '')}"`;
                res.setHeader('Cache-Control', 'private, no-cache');
                res.setHeader('Vary', 'Accept-Encoding');
                res.setHeader('ETag', etag);
                res.setHeader('X-Content-Type-Options', 'nosniff');
                if (etagHit(req, etag)) return res.status(304).end();
                // An open file keeps its bytes even if the sync renames a new copy into place meanwhile.
                opened = await openVariant(path.join(dir, file), acceptedEncodings(req.headers['accept-encoding']));
                if (!opened) return notFound(res);
                res.setHeader('Content-Type', contentTypeOf(e, file));
                if (opened.enc) res.setHeader('Content-Encoding', opened.enc);
                res.setHeader('Content-Length', opened.size);
                res.setHeader('Accept-Ranges', 'none');
                res.status(200);
                if (req.method === 'HEAD') {
                    await opened.fh.close();
                    return res.end();
                }
                const { fh, size } = opened;
                opened = null; // sendFile closes the file
                await sendFile(fh, size, res);
            } catch (err) {
                if (opened) await opened.fh.close().catch(() => {});
                log.error(`[Mirror] file ${key}:`, err.message);
                if (!res.headersSent) return res.status(500).json({ status: 'error', message: 'Snapshot unavailable' });
                res.destroy();
            }
        });

        app.get('/api/data/status', async (req, res) => {
            if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
            const m = await manifest().catch(() => null);
            if (!m) return notFound(res);
            const generatedAt = m.data.generatedAt || null;
            const t = Date.parse(generatedAt || '');
            res.setHeader('Cache-Control', 'private, no-cache');
            return res.json({
                status: 'success',
                mode: 'mirror',
                generatedAt,
                datasets: Object.keys(m.entries).length,
                ageSeconds: Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null,
                refreshing: dirtyKeys(),
                lastRefresh: last
            });
        });

        // The browser writes a few sheets itself (NSC follow-ups, DTR load, PRT oil, DD visit) through
        // Apps Script; after a successful write it may ask for those datasets to be refreshed.
        const refreshHits = new Map(); // username -> [timestamps]
        app.post('/api/data/refresh', (req, res) => {
            if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
            if (!on()) return notFound(res);
            const asked = [].concat((req.body && req.body.keys) || []).map(String);
            const keys = asked.filter((k) => CLIENT_REFRESH_KEYS.has(k));
            if (!keys.length) return res.status(400).json({ status: 'error', message: 'No refreshable datasets named.' });
            const who = String(req.user.Username || req.user.username || 'user').slice(0, 40);
            const now = Date.now();
            const recent = (refreshHits.get(who) || []).filter((t) => now - t < 10 * 60 * 1000);
            if (recent.length >= 30) return res.status(429).json({ status: 'error', message: 'Too many refresh requests.' });
            recent.push(now);
            refreshHits.set(who, recent);
            const what = String((req.body && req.body.reason) || 'browser write').replace(/[^\w .:/-]/g, '').slice(0, 60);
            refreshMirror(keys, `${what} by ${who}`);
            return res.status(202).json({ status: 'success', keys });
        });
    }

    return {
        on,
        dir,
        mount,
        manifest,
        entry,
        entryForDataHubKey,
        dataHubEntries,
        fileUrl,
        hubUrl,
        readJson,
        readHead,
        refreshMirror,
        isDirty,
        _flush: flush
    };
}

module.exports = { create, urlCarriesKey, acceptedEncodings, isSensitive, CLIENT_REFRESH_KEYS };
