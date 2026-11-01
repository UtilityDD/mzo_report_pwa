'use strict';
// Pass 2 of a sync: read the spool, build typed records, and write only the difference:
// insert rows with a new _row_key, update rows whose _hash or _row_no changed, delete rows that
// are gone from the source. Record ids derive from _row_key, so no id lookups are needed.
// Values are converted a chunk of rows at a time by lib/uniform.js (infer.js Converter).
// Memory: per row one Map entry (15-char id → slot) plus 13 bytes in typed arrays (hash prefix,
// row number, seen flag): about 60 bytes a row, ~15 MB for the 240k-row meter dump.

const { sha1, recordId, stableStringify, pbDate } = require('./util');
const { readSpool } = require('./spool');
const { PbError } = require('./pb');
const { Converter } = require('./infer');
const { NULLS_FIELD } = require('./collections');

const CHUNK_ROWS = 500; // rows per conversion

/** id → { 52-bit hash prefix, row number, seen in this run } without an object per row. */
class RowIndex {
    constructor() {
        this.map = new Map();
        this.n = 0;
        this.cap = 1024;
        this.hash = new Float64Array(this.cap);
        this.row = new Int32Array(this.cap);
        this.seen = new Uint8Array(this.cap);
    }

    static hashNum(hex) {
        return hex ? parseInt(String(hex).slice(0, 13), 16) || 0 : 0;
    }

    add(id, hashNum, rowNo, seen) {
        if (this.n === this.cap) {
            this.cap *= 2;
            const h = new Float64Array(this.cap); h.set(this.hash); this.hash = h;
            const r = new Int32Array(this.cap); r.set(this.row); this.row = r;
            const s = new Uint8Array(this.cap); s.set(this.seen); this.seen = s;
        }
        const i = this.n++;
        this.map.set(id, i);
        this.hash[i] = hashNum;
        this.row[i] = rowNo | 0;
        this.seen[i] = seen ? 1 : 0;
        return i;
    }
}

function rowKeyFn(columns, primaryKey, warnings) {
    const pkIdx = [];
    for (const name of primaryKey || []) {
        const col = columns.find((c) => c.source_name === name);
        if (!col) {
            warnings.push(`primary key column "${name}" not found; using row hashes as keys`);
            pkIdx.length = 0;
            break;
        }
        pkIdx.push(col.index);
    }
    // Over the columns that have a header or a value: a header-less source's all-empty columns
    // (kept as fields, as lib/uniform.js keeps them) do not change its row keys.
    const keptIdx = columns.filter((c) => c.source_name !== '' || c.non_empty !== 0).map((c) => c.index);
    const rowHash = (values) => sha1(stableStringify(keptIdx.map((i) => (values[i] === undefined || values[i] === null ? '' : values[i]))));
    if (!pkIdx.length) return { usesPk: false, key: rowHash };
    return {
        usesPk: true,
        key(values) {
            const parts = pkIdx.map((i) => {
                const v = values[i];
                return v === undefined || v === null ? '' : typeof v === 'object' ? stableStringify(v) : String(v);
            });
            if (parts.every((p) => p === '')) return 'h:' + rowHash(values);
            return parts.join('|');
        }
    };
}

/**
 * @param writeName  column name → the field to write it to (a staging field while a column's type
 *                   changes, collections.js); default: the column name
 * @param force      write every row, even when its _hash is unchanged (a field was added that the
 *                   existing rows have no value in yet)
 * @param oldTypes   staged column → type of the old field the portal shows until the swap; _nulls
 *                   describes that field meanwhile (stats.provisional rows: the next run tidies them)
 * @returns {Promise<{total, inserted, updated, deleted, unchanged, failed, failures: string[], batches, writeMs}>}
 */
async function writeRows({ pb, collection, columns, primaryKey, spoolFile, batchSize, syncedAt, signal, warnings, log, enrich, writeName, force, oldTypes }) {
    const stats = { total: 0, inserted: 0, updated: 0, deleted: 0, unchanged: 0, failed: 0, failures: [], batches: 0, writeMs: 0, loadMs: 0, duplicateKeys: 0, provisional: 0 };
    const base = `/api/collections/${collection}/records`;
    const t0 = Date.now();

    const index = new RowIndex();
    for await (const page of pb.pages(collection, { fields: 'id,_hash,_row_no' })) {
        for (const r of page) index.add(r.id, RowIndex.hashNum(r._hash), r._row_no, false);
    }
    stats.loadMs = Date.now() - t0;
    const existingCount = index.n;
    const isSeen = (id) => {
        const i = index.map.get(id);
        return i !== undefined && index.seen[i] === 1;
    };

    const keyer = rowKeyFn(columns, primaryKey, warnings);
    const syncedAtStr = pbDate(syncedAt);
    let queue = [];

    const flush = async () => {
        if (!queue.length) return;
        const items = queue;
        queue = [];
        const t = Date.now();
        await sendBatch(pb, items, stats);
        stats.writeMs += Date.now() - t;
        if (signal && signal.aborted) throw signal.reason || new Error('Aborted');
    };

    // The record id of a source row (its key; repeats get an occurrence suffix), marked seen in
    // this run. A new id gets a slot past existingCount.
    const claim = (values) => {
        const baseKey = keyer.key(values);
        let key = baseKey;
        let id = recordId(key);
        const dup = isSeen(id);
        for (let occ = 2; isSeen(id); occ++) {
            key = baseKey + ':' + occ; // exact duplicate (or repeated key): occurrence index
            id = recordId(key);
        }
        let slot = index.map.get(id);
        if (slot === undefined) slot = index.add(id, 0, 0, true);
        else index.seen[slot] = 1;
        return { key, id, slot, dup };
    };

    // Pass 1, keys only: the existing records this run deletes, by their row number. Each is
    // deleted in the same batch transaction as the new record inserted at its row number, so a
    // row whose key changed (content-keyed rows whose content changed, or a re-keyed dataset)
    // is replaced in one step: the portal never sees it twice, nor missing.
    const replaceAt = new Map(); // _row_no → { id, slot } of an existing record that goes
    if (existingCount) {
        for await (const values of readSpool(spoolFile)) claim(values);
        for (const [id, slot] of index.map) {
            if (slot < existingCount && !index.seen[slot] && !replaceAt.has(index.row[slot])) replaceAt.set(index.row[slot], { id, slot });
        }
        index.seen.fill(0);
    }

    const conv = new Converter(columns, oldTypes);
    const target = columns.map((c) => (writeName ? writeName(c.name) : c.name));
    const rawTarget = columns.map((c) => (c.raw_name ? (writeName ? writeName(c.raw_name) : c.raw_name) : null));
    const rawSlot = new Array(columns.length); // column → its index in Converter's raw list, or -1
    for (let i = 0, k = 0; i < columns.length; i++) rawSlot[i] = columns[i].raw_name ? k++ : -1;

    let rowNo = 0;
    const writeChunk = async (chunk) => {
        const cv = conv.convert(chunk);
        for (let r = 0; r < chunk.length; r++) {
            const values = chunk[r];
            rowNo++;
            const { key, id, slot, dup } = claim(values);
            if (dup) stats.duplicateKeys++;
            const isNew = slot >= existingCount;
            const record = {};
            const typed = [];
            for (let ci = 0; ci < columns.length; ci++) {
                const v = cv.values[ci][r];
                record[target[ci]] = v;
                typed.push(v);
                if (rawSlot[ci] >= 0) {
                    const raw = cv.raw[rawSlot[ci]];
                    const rawText = raw ? raw[r] : '';
                    record[rawTarget[ci]] = rawText;
                    typed.push(rawText);
                }
            }
            if (enrich) { // extra fields computed from the row (office_enrich.js); part of the row hash
                const extra = enrich(values);
                for (const k of Object.keys(extra)) {
                    record[writeName ? writeName(k) : k] = extra[k];
                    typed.push(extra[k]);
                }
            }
            // Empty numbers and bools (stored as 0 / false). Only a row that has some changes its
            // hash, so a row without any keeps the hash it had before _nulls existed.
            const nulls = cv.nulls[r];
            record[NULLS_FIELD] = nulls;
            if (cv.provisional[r]) stats.provisional++;
            if (nulls) typed.push(nulls);
            const hash = sha1(stableStringify(typed));
            const hashNum = RowIndex.hashNum(hash);
            if (!isNew && !force && index.hash[slot] === hashNum && index.row[slot] === rowNo) {
                stats.unchanged++;
                continue;
            }
            record._row_no = rowNo;
            record._row_key = key;
            record._hash = hash;
            record._synced_at = syncedAtStr;
            if (isNew) {
                record.id = id;
                const old = replaceAt.get(rowNo);
                if (old && !index.seen[old.slot]) { // the record this row replaces: same transaction
                    index.seen[old.slot] = 1;
                    queue.push({ kind: 'deleted', req: { method: 'DELETE', url: `${base}/${old.id}` } });
                }
                queue.push({ kind: 'inserted', req: { method: 'POST', url: base + '?fields=id', body: record } });
            } else {
                queue.push({ kind: 'updated', req: { method: 'PATCH', url: `${base}/${id}?fields=id`, body: record } });
            }
            if (queue.length >= batchSize) await flush();
        }
    };

    let chunk = [];
    for await (const values of readSpool(spoolFile)) {
        chunk.push(values);
        if (chunk.length >= CHUNK_ROWS) {
            await writeChunk(chunk);
            chunk = [];
        }
    }
    if (chunk.length) await writeChunk(chunk);
    stats.total = rowNo;
    await flush();

    // Rows no longer in the source (the ones no new row replaced).
    for (const [id, slot] of index.map) {
        if (index.seen[slot]) continue;
        queue.push({ kind: 'deleted', req: { method: 'DELETE', url: `${base}/${id}` } });
        if (queue.length >= batchSize) await flush();
    }
    await flush();
    index.map.clear();
    stats.existingBefore = existingCount;
    if (stats.duplicateKeys && keyer.usesPk) warnings.push(`${stats.duplicateKeys} rows repeat a primary key value (kept with an occurrence suffix)`);
    return stats;
}

/** Send one batch; on a validation failure, split it to isolate and skip the bad rows. */
async function sendBatch(pb, items, stats) {
    try {
        stats.batches++;
        await pb.batch(items.map((i) => i.req));
        for (const i of items) stats[i.kind]++;
    } catch (err) {
        if (!(err instanceof PbError) || err.status !== 400) throw err;
        if (items.length === 1) {
            stats.failed++;
            if (stats.failures.length < 5) {
                const r = items[0].req;
                const key = r.body && r.body._row_key ? ` row ${r.body._row_no} (${String(r.body._row_key).slice(0, 60)})` : '';
                stats.failures.push(`${r.method}${key}: ${innerError(err)}`);
            }
            return;
        }
        const mid = items.length >> 1;
        await sendBatch(pb, items.slice(0, mid), stats);
        await sendBatch(pb, items.slice(mid), stats);
    }
}

function innerError(err) {
    const reqs = err.data && err.data.data && err.data.data.requests;
    if (reqs && typeof reqs === 'object') {
        const first = reqs[Object.keys(reqs)[0]];
        const resp = first && first.response;
        if (resp) return PbError.describe(resp).slice(0, 400);
    }
    return err.message.slice(0, 400);
}

module.exports = { writeRows, rowKeyFn };
