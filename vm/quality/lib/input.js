'use strict';
// Row inputs for the checker. Every input is an async generator of arrays: the first array is
// the header, the rest are rows aligned with it (object rows are turned into arrays; a key that
// appears later extends the header).
//
//   fromSnapshot(file, contentType)  the raw source bytes the sync keeps (CSV, TSV or JSON)
//   fromPocketBase(pb, collection, registryColumns)  the ds_ records (sensitive datasets, no snapshot)
//   fromObjects(iterable)            any iterable of plain objects
//   fromNdjson(file)                 a test dump: one JSON array or object per line

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function csvParse() {
    // csv-parse ships with vm/sync (the mirror's only CSV parser).
    const candidates = [path.join(__dirname, '..', '..', 'sync', 'node_modules', 'csv-parse'), 'csv-parse'];
    for (const c of candidates) {
        try {
            return require(c).parse;
        } catch (_) { /* next */ }
    }
    throw new Error('csv-parse not found (run npm ci in vm/sync)');
}

async function* fromCsvStream(stream, tsv) {
    const parse = csvParse();
    const parser = parse({
        delimiter: tsv ? '\t' : ',',
        quote: tsv ? false : '"',
        bom: true,
        relax_column_count: true,
        relax_quotes: true,
        skip_empty_lines: false
    });
    stream.on('error', (e) => parser.destroy(e));
    stream.pipe(parser);
    for await (const rec of parser) yield rec;
}

async function* fromObjects(iterable) {
    const header = [];
    const index = new Map();
    let headerSent = false;
    const pending = [];
    for await (const obj of iterable) {
        if (!obj || typeof obj !== 'object') continue;
        for (const k of Object.keys(obj)) {
            if (!index.has(k)) {
                index.set(k, header.length);
                header.push(k);
                if (headerSent) yield { extendHeader: header.slice() };
            }
        }
        if (!headerSent) {
            yield header.slice();
            headerSent = true;
        }
        const row = new Array(header.length).fill('');
        for (const k of Object.keys(obj)) {
            const v = obj[k];
            row[index.get(k)] = v === null || v === undefined ? '' : v;
        }
        yield row;
    }
    if (!headerSent) yield header;
    void pending;
}

async function* fromSnapshot(file, contentType) {
    const ct = String(contentType || '');
    if (/json/.test(ct) || /\.json$/.test(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8')); // JSON snapshots are Supabase tables (small)
        yield* fromObjects(Array.isArray(data) ? data : []);
        return;
    }
    const tsv = /tab-separated/.test(ct) || /\.tsv$/.test(file);
    yield* fromCsvStream(fs.createReadStream(file), tsv);
}

/**
 * ds_ records → arrays in source column order (sorted by _row_no). Typed values come back as
 * stored; a _raw companion (the cell text that did not parse) wins over the typed value. Used
 * for datasets without a snapshot (the sensitive ones, all small), so offset paging is fine.
 */
async function* fromPocketBase(pb, collection, registryColumns) {
    const cols = (registryColumns || []).filter((c) => !c.raw_of);
    const rawOf = new Map((registryColumns || []).filter((c) => c.raw_of).map((c) => [c.raw_of, c.name]));
    yield cols.map((c) => c.source_name);
    const fields = ['_row_no', '_nulls'].concat(cols.map((c) => c.name), [...rawOf.values()]).join(',');
    for (let page = 1; ; page++) {
        const res = await pb.listRecords(collection, { page, perPage: 500, sort: '_row_no', fields, skipTotal: 1 });
        const items = (res && res.items) || [];
        for (const r of items) {
            // _nulls: number / bool fields that are empty in the source (PocketBase stores 0 / false)
            const nulls = Array.isArray(r._nulls) && r._nulls.length ? new Set(r._nulls) : null;
            yield cols.map((c) => {
                const raw = rawOf.get(c.name);
                if (raw && r[raw]) return r[raw];
                if (nulls && nulls.has(c.name)) return '';
                const v = r[c.name];
                if (c.type === 'date' && typeof v === 'string') return v ? v.slice(0, 10) : '';
                if (c.type === 'bool') return v ? 'TRUE' : 'FALSE';
                return v === null || v === undefined ? '' : v;
            });
        }
        if (items.length < 500) return;
    }
}

async function* fromNdjson(file) {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    const it = rl[Symbol.asyncIterator]();
    async function* lines() {
        for (;;) {
            const { value, done } = await it.next();
            if (done) return;
            if (value) yield JSON.parse(value);
        }
    }
    const src = lines();
    const first = await src.next();
    if (first.done) return;
    if (Array.isArray(first.value)) {
        yield first.value;
        yield* src;
        return;
    }
    yield* fromObjects((async function* () {
        yield first.value;
        yield* src;
    })());
}

/** Feed an input into a Checker (handles header extension from object inputs). */
async function feed(checker, input) {
    let first = true;
    for await (const item of input) {
        if (first) {
            checker.setHeader(Array.isArray(item) ? item : []);
            first = false;
            continue;
        }
        if (item && item.extendHeader) {
            checker.setHeader(item.extendHeader);
            continue;
        }
        checker.row(item);
    }
    if (first) checker.setHeader([]);
}

module.exports = { fromSnapshot, fromPocketBase, fromObjects, fromNdjson, fromCsvStream, feed };
