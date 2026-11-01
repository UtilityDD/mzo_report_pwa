'use strict';
// Snapshot store: an untouched copy of each dataset's source bytes for the VM app to
// serve, next to the normalised PocketBase records. Per dataset: <key>.<csv|tsv|json> plus .gz
// and .br, written atomically (temp file + rename) and only when the sha1 of the bytes changed.
// manifest.json lists every snapshot; it is rewritten atomically whenever one changes and at
// the end of each run. Sensitive sources (PINs, bank data) never get a snapshot.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { once } = require('events');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const DEFAULT_DIR = '/opt/mzo/data/snapshots';
const CONTENT_TYPES = {
    csv: 'text/csv; charset=utf-8',
    tsv: 'text/tab-separated-values; charset=utf-8',
    json: 'application/json; charset=utf-8'
};

/** MZO_SNAPSHOT_DIR, else /opt/mzo/data/snapshots when it exists (the VM), else off. */
function snapshotDir(env) {
    if (env.MZO_SNAPSHOT_DIR) return path.resolve(env.MZO_SNAPSHOT_DIR);
    return fs.existsSync(DEFAULT_DIR) ? DEFAULT_DIR : null;
}

function extFor(contentType, fallback) {
    const ct = String(contentType || '').toLowerCase();
    if (ct.includes('tab-separated')) return 'tsv';
    if (ct.includes('json')) return 'json';
    if (ct.includes('csv') || ct.includes('text/plain')) return 'csv';
    return fallback || 'csv';
}

function contentTypeFor(file) {
    return CONTENT_TYPES[path.extname(String(file || '')).slice(1)] || 'application/octet-stream';
}

function unlinkQuiet(file) {
    try {
        fs.unlinkSync(file);
    } catch (_) { /* gone */ }
}

/** Streams bytes into a hidden temp file while hashing them; publish() makes it live. */
class SnapshotWriter {
    constructor(dir, key, ext) {
        fs.mkdirSync(dir, { recursive: true });
        this.dir = dir;
        this.key = key;
        this.ext = ext;
        this.file = `${key}.${ext}`;
        this.tmp = path.join(dir, `.${this.file}.${process.pid}.tmp`);
        this.out = fs.createWriteStream(this.tmp);
        this.hash = crypto.createHash('sha1');
        this.bytes = 0;
        this.done = false;
    }

    /** Write a chunk; resolves once the file can take more (backpressure). */
    async write(chunk) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        this.hash.update(buf);
        this.bytes += buf.length;
        if (!this.out.write(buf)) await once(this.out, 'drain');
    }

    async finish() {
        if (this.done) return;
        this.done = true;
        this.out.end();
        await once(this.out, 'finish');
        this.sha1 = this.hash.digest('hex');
    }

    async abort() {
        if (!this.out.closed) {
            const closed = once(this.out, 'close').catch(() => {});
            this.out.destroy();
            await closed; // a stream still opening would otherwise create the file after the unlink
        }
        unlinkQuiet(this.tmp);
        unlinkQuiet(this.tmp + '.gz');
        unlinkQuiet(this.tmp + '.br');
    }

    /**
     * Make the snapshot live unless it equals the current one.
     * @returns {Promise<{changed: boolean, file, sha1, bytes}>}
     */
    async publish(prevSha1) {
        await this.finish();
        const final = path.join(this.dir, this.file);
        const info = { file: this.file, sha1: this.sha1, bytes: this.bytes };
        const complete = [final, final + '.gz', final + '.br'].every((f) => fs.existsSync(f));
        if (prevSha1 && prevSha1 === this.sha1 && complete) {
            unlinkQuiet(this.tmp);
            return Object.assign({ changed: false }, info);
        }
        try {
            await pipeline(fs.createReadStream(this.tmp), zlib.createGzip({ level: 6 }), fs.createWriteStream(this.tmp + '.gz'));
            await pipeline(fs.createReadStream(this.tmp), zlib.createBrotliCompress({
                params: {
                    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
                    // Quality 9 for small files; 5 above 1 MB keeps a 20 MB dump to well under a second.
                    [zlib.constants.BROTLI_PARAM_QUALITY]: this.bytes > 1024 * 1024 ? 5 : 9,
                    // 1 MB window. With the default 4 MB window, Node's brotli took 270 to 440 MB of
                    // native memory on the DD summary and meter master dumps; 1 MB keeps it near 40 MB.
                    [zlib.constants.BROTLI_PARAM_LGWIN]: 20,
                    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: this.bytes
                }
            }), fs.createWriteStream(this.tmp + '.br'));
            // Compressed copies first, the plain file last: a reader never sees a new plain
            // file whose .gz/.br are still the old version for longer than two renames.
            fs.renameSync(this.tmp + '.gz', final + '.gz');
            fs.renameSync(this.tmp + '.br', final + '.br');
            fs.renameSync(this.tmp, final);
        } catch (err) {
            await this.abort();
            throw err;
        }
        return Object.assign({ changed: true }, info);
    }
}

/** Pass-through stream that copies every chunk into a SnapshotWriter. */
function teeInto(writer) {
    return new Transform({
        transform(chunk, enc, cb) {
            writer.write(chunk).then(() => cb(null, chunk), cb);
        }
    });
}

/** Remove a dataset's snapshot files (used when a source is sensitive or gone). */
function removeSnapshot(dir, file) {
    if (!dir || !file) return false;
    const base = path.join(dir, path.basename(file));
    let removed = false;
    for (const f of [base, base + '.gz', base + '.br']) {
        if (fs.existsSync(f)) {
            unlinkQuiet(f);
            removed = true;
        }
    }
    return removed;
}

/** Temp files left by a crashed run (older than an hour). */
function cleanTemp(dir) {
    if (!dir || !fs.existsSync(dir)) return;
    const cutoff = Date.now() - 3600000;
    for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith('.') || !/\.tmp(\.gz|\.br)?$/.test(name)) continue;
        const f = path.join(dir, name);
        try {
            if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f);
        } catch (_) { /* raced */ }
    }
}

function isoOf(pbDateStr) {
    if (!pbDateStr) return null;
    const t = Date.parse(String(pbDateStr).replace(' ', 'T'));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Write manifest.json from the registry rows and source definitions (contract fields plus
 * label, snapshotAt, checkedAt and rows).
 */
function writeManifest(dir, sources, registry) {
    if (!dir) return null;
    fs.mkdirSync(dir, { recursive: true });
    const datasets = {};
    for (const src of [...sources].sort((a, b) => a.key.localeCompare(b.key))) {
        if (src.sensitive) continue;
        const ds = registry.get(src.key);
        if (!ds || !ds.snapshot_file || !ds.snapshot_sha1) continue;
        if (!fs.existsSync(path.join(dir, ds.snapshot_file))) continue;
        datasets[src.key] = {
            version: ds.snapshot_sha1,
            bytes: ds.snapshot_bytes || 0,
            contentType: contentTypeFor(ds.snapshot_file),
            file: ds.snapshot_file,
            fetchedAt: isoOf(ds.last_fetched_at) || isoOf(ds.snapshot_at),
            snapshotAt: isoOf(ds.snapshot_at),
            checkedAt: isoOf(ds.last_checked_at),
            sourceType: src.sourceType || 'other',
            dataHubKeys: Array.isArray(src.dataHubKeys) ? src.dataHubKeys : [],
            urls: Array.isArray(src.urls) ? src.urls : [],
            sensitive: false,
            label: src.label || src.key,
            rows: ds.row_count || 0
        };
        // Optional: a same-origin URL the client should load this DataHub key from instead of
        // /api/data/file/<key> (Power Map: /api/power-map/data).
        if (src.dataHubUrl) datasets[src.key].dataHubUrl = src.dataHubUrl;
        // When the source itself says it last changed (HTTP Last-Modified or a report date it
        // exposes). Google sheets send neither, except NSC/Withheld (their TODAY report date):
        // for the rest, snapshotAt (when the mirror first saw these bytes) is the best "updated".
        const modified = isoOf(ds.source_modified_at);
        if (modified) datasets[src.key].sourceModifiedAt = modified;
    }
    const manifest = { generatedAt: new Date().toISOString(), datasets };
    const final = path.join(dir, 'manifest.json');
    const tmp = path.join(dir, `.manifest.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 1));
    fs.renameSync(tmp, final);
    return manifest;
}

module.exports = { snapshotDir, extFor, contentTypeFor, SnapshotWriter, teeInto, removeSnapshot, cleanTemp, writeManifest, CONTENT_TYPES };
