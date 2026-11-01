'use strict';
// Pass 1 of a sync: stream a source's rows into a temporary NDJSON file (one JSON array of raw
// cell values per line) while hashing the content and counting per-column statistics. Nothing
// but the counters stays in memory, so a 20 MB sheet costs the same RAM as a 20 KB one.
// Pass 2 (upsert.js) reads the file back once the column types are known.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { ColumnStats } = require('./infer');
const { Readable, pipeline } = require('stream');
const { cleanHeader } = require('./normalise');
const { stableStringify } = require('./util');
const { SnapshotWriter, teeInto, extFor } = require('./snapshot');

function normValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
    return v; // object / array (json)
}

/**
 * @param {object} source adapter (rows() yields arrays — first one the header — or objects)
 * @param {object} ctx adapter context (signal is honoured between rows)
 * @param {{tmpDir: string, salt: string, snapshotDir?: string}} opts
 *   snapshotDir: also capture a snapshot of a source with raw(). It is downloaded once: the
 *   bytes go to the snapshot file and, through ctx.input, to rows().
 * @returns {Promise<{file, rows, columns: {source_name, index, stats}[], hash, mode, snapshot, modifiedAt}>}
 *   snapshot: an unpublished SnapshotWriter (the caller publishes or aborts it), or null.
 *   modifiedAt: raw().modifiedAt (Last-Modified or a report date the source exposes), or null.
 */
async function spool(source, ctx, { tmpDir, salt, snapshotDir }) {
    fs.mkdirSync(tmpDir, { recursive: true });
    let writer = null;
    let rctx = ctx;
    let modifiedAt = null; // when the source says it last changed (raw().modifiedAt), if it says
    if (typeof source.raw === 'function') {
        const raw = await source.raw(ctx);
        let input = raw && raw.stream;
        if (!input) throw new Error('raw() returned no stream');
        if (typeof input.getReader === 'function') input = Readable.fromWeb(input);
        if (snapshotDir) {
            writer = new SnapshotWriter(snapshotDir, source.key, extFor(raw.contentType, source.rawExt));
            const tee = teeInto(writer);
            pipeline(input, tee, () => { /* errors reach rows() through the tee */ });
            input = tee;
        }
        rctx = Object.assign({}, ctx, { input });
        modifiedAt = raw.modifiedAt || null;
    }
    const file = path.join(tmpDir, `${source.key}.${process.pid}.${Date.now()}.ndjson`);
    const out = fs.createWriteStream(file);
    const hash = crypto.createHash('sha1').update(String(salt || ''));
    const columns = [];
    const byName = new Map();
    let mode = null;
    let header = null;
    let rows = 0;
    try {
        for await (const item of source.rows(rctx)) {
            if (ctx.signal && ctx.signal.aborted) throw ctx.signal.reason || new Error('Aborted');
            let values;
            if (Array.isArray(item)) {
                if (mode === 'object') throw new Error('rows() mixed arrays and objects');
                mode = 'table';
                if (!header) {
                    header = item.map(cleanHeader);
                    header.forEach((h, i) => columns.push({ source_name: h, index: i, stats: new ColumnStats() }));
                    continue;
                }
                values = item.map(normValue);
            } else if (item && typeof item === 'object') {
                if (mode === 'table') throw new Error('rows() mixed arrays and objects');
                mode = 'object';
                values = [];
                for (const k of Object.keys(item)) {
                    let idx = byName.get(k);
                    if (idx === undefined) {
                        idx = columns.length;
                        byName.set(k, idx);
                        columns.push({ source_name: k, index: idx, stats: new ColumnStats() });
                    }
                    values[idx] = normValue(item[k]);
                }
                for (let i = 0; i < values.length; i++) if (values[i] === undefined) values[i] = '';
            } else {
                continue;
            }
            let last = values.length - 1;
            while (last >= 0 && values[last] === '') last--;
            if (last < 0) continue; // blank row
            if (last < values.length - 1) values.length = last + 1;
            while (columns.length < values.length) {
                columns.push({ source_name: '', index: columns.length, stats: new ColumnStats() });
            }
            for (let i = 0; i < values.length; i++) columns[i].stats.add(values[i]);
            const line = stableStringify(values) + '\n'; // sorted json keys: stable content hash
            hash.update(line);
            rows++;
            if (!out.write(line)) await once(out, 'drain');
        }
        hash.update('\u0000' + JSON.stringify(columns.map((c) => c.source_name)));
        out.end();
        await once(out, 'finish');
        if (rctx.input && !rctx.input.readableEnded) {
            for await (const _ of rctx.input) { /* rows() stopped early: the snapshot still needs every byte */ }
        }
        if (writer) await writer.finish();
    } catch (err) {
        await closeQuietly(out); // the stream may still be opening: remove the file only once it is closed
        removeFile(file);
        if (writer) await writer.abort();
        throw err;
    }
    return { file, rows, columns, hash: hash.digest('hex'), mode: mode || 'table', snapshot: writer, modifiedAt };
}

async function closeQuietly(stream) {
    if (stream.closed) return;
    const closed = once(stream, 'close').catch(() => {});
    stream.destroy();
    await closed;
}

/** Spool files left by a crashed run (older than an hour). */
function cleanSpool(dir) {
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - 3600000;
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.ndjson')) continue;
        const f = path.join(dir, name);
        try {
            if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f);
        } catch (_) { /* raced */ }
    }
}

function removeFile(file) {
    try {
        fs.unlinkSync(file);
    } catch (_) { /* already gone */ }
}

/** Read the spool back: yields arrays of raw values. */
async function* readSpool(file) {
    const input = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 256 * 1024 });
    let rest = '';
    for await (const chunk of input) {
        const text = rest + chunk;
        let start = 0;
        let nl;
        while ((nl = text.indexOf('\n', start)) !== -1) {
            if (nl > start) yield JSON.parse(text.slice(start, nl));
            start = nl + 1;
        }
        rest = text.slice(start);
    }
    if (rest.trim()) yield JSON.parse(rest);
}

module.exports = { spool, readSpool, removeFile, cleanSpool, normValue };
