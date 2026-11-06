'use strict';
// Native datasets: the VM is the source of truth (sys_datasets.mode = 'native', docs/data-editor.md).
//
//   analyse(key)      can this dataset go native? Its snapshot must survive snapshot → cells →
//                     snapshot byte for byte (lib/editor/format.js), the cells must give exactly the
//                     records the sync wrote (same ids and hashes), and it must be CSV or TSV.
//   takeOver(key)     holding the sync lock: one last fresh copy from the source, analyse it, keep
//                     every row's exact cells in _src, then mode = 'native'. The sync skips it from then on.
//   release(key)      back to mode 'mirror': the next sync replaces the VM's rows with the source's.
//   create(def)       a brand-new native dataset (no Google or Supabase source at all).
//   regenerate(key)   after every commit: the snapshot from the rows (_src in _row_no order), in the
//                     format the source had, atomically with .gz/.br, then the manifest entry.

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const F = require('./format');
const R = require('./records');

function sync(envx) {
    const S = envx.SYNC;
    return {
        spool: require(path.join(S, 'spool')),
        schema: require(path.join(S, 'schema')),
        collections: require(path.join(S, 'collections')),
        snapshot: require(path.join(S, 'snapshot')),
        registry: require(path.join(S, 'registry')),
        util: require(path.join(S, 'util')),
        lock: require(path.join(S, 'lock')),
        normalise: require(path.join(S, 'normalise')),
        officeEnrich: require(path.join(S, 'office_enrich'))
    };
}

const MAX_NATIVE_ROWS = 100000;
const MAX_NATIVE_BYTES = 40 * 1024 * 1024;
const SENSITIVE = /^(manpower_|portal_users|dd_user_auth|activity_logs|powermap_(org_units|editors|profiles)|upcoming_dd|dd_visit)/;

class EditorError extends Error {
    constructor(status, message, extra) {
        super(message);
        this.status = status;
        if (extra) Object.assign(this, extra);
    }
}

function create(envx, hooks) {
    const S = sync(envx);
    const { pbDate } = S.util;
    const idFor = (key) => S.registry.Registry.idFor(key);

    async function registryRow(key) {
        const pb = await envx.client();
        try {
            return await pb.getRecord('sys_datasets', idFor(key));
        } catch (err) {
            if (err.status === 404) return null;
            throw err;
        }
    }

    async function patchRegistry(key, fields) {
        const pb = await envx.client();
        return pb.updateRecord('sys_datasets', idFor(key), fields);
    }

    function snapFile(ds) {
        const dir = envx.snapshotDir;
        const file = ds && ds.snapshot_file;
        if (!dir || !file || !/^[a-z0-9_]+\.(csv|tsv|json)$/.test(file)) return null;
        const full = path.join(dir, file);
        return fs.existsSync(full) ? full : null;
    }

    /**
     * The layout and cells of a dataset's current snapshot, checked against the sync's own reading
     * of the same bytes. Never writes. → { eligible, reasons[], parity, layout?, cells?, info }
     */
    async function analyse(key, opts) {
        const o = opts || {};
        const reasons = [];
        const ds = o.ds || await registryRow(key);
        if (!ds) throw new EditorError(404, 'No such dataset.');
        const src = await envx.source(key);
        const info = { key, rows: ds.row_count || 0, snapshot: ds.snapshot_file || '', sourceType: ds.source_type || '' };
        if (!src) reasons.push('Its source definition was not found in vm/sync/sources.');
        if (src && src.sensitive) reasons.push('Sensitive datasets have no snapshot; their pages read the original source.');
        if (SENSITIVE.test(key)) reasons.push('Sensitive datasets cannot be edited here.');
        const file = snapFile(ds);
        if (!file) reasons.push('It has no snapshot, so the pages do not read it from the VM.');
        const ext = file ? path.extname(file).slice(1) : '';
        if (file && ext === 'json') reasons.push('Its snapshot is JSON (a Supabase table); only CSV and TSV datasets can be native.');
        if (src && src.header === false) reasons.push('It is a report-style sheet without a header row; the pages read its cells by position.');
        if ((ds.row_count || 0) > MAX_NATIVE_ROWS) reasons.push(`It has more than ${MAX_NATIVE_ROWS.toLocaleString('en-IN')} rows.`);
        if (file && fs.statSync(file).size > MAX_NATIVE_BYTES) reasons.push('Its snapshot is larger than 40 MB.');
        if (ds.mode === 'native' && !o.allowNative) reasons.push('It is already native.');
        if (reasons.length) return { eligible: false, reasons, info };

        const text = fs.readFileSync(file, 'utf8');
        const rt = F.roundTrip(text, ext);
        info.parity = { identical: rt.identical, blankRowsDropped: rt.blankRowsDropped, format: rt.fmt, firstDiff: rt.firstDiff || null };
        if (!rt.identical) {
            reasons.push('Its snapshot does not come back byte for byte from its cells (' + (rt.firstDiff ? 'first difference at byte ' + rt.firstDiff.offset : 'unknown difference') + ').');
            return { eligible: false, reasons, info };
        }

        // The sync's own reading of these bytes: its parser (the source's rows()), statistics and columns.
        const fake = Object.assign({}, src, {
            version: undefined,
            raw: async () => ({ contentType: ext === 'tsv' ? 'text/tab-separated-values' : 'text/csv', stream: Readable.from([Buffer.from(text, 'utf8')]) })
        });
        const tmpDir = path.join(envx.tmpDir, 'editor');
        const sp = await S.spool.spool(fake, { signal: null }, { tmpDir, salt: 'editor-analyse', snapshotDir: null });
        let spoolRows = [];
        try {
            for await (const v of S.spool.readSpool(sp.file)) spoolRows.push(v);
        } finally {
            S.spool.removeFile(sp.file);
        }
        const { columns, registryColumns } = S.schema.buildColumns(sp.columns, src);
        const regCols = Array.isArray(ds.columns) ? ds.columns : [];
        const sameCols = regCols.length === registryColumns.length &&
            regCols.every((c, i) => c.name === registryColumns[i].name && c.type === registryColumns[i].type && (c.date_order || '') === (registryColumns[i].date_order || ''));
        if (!sameCols) reasons.push('Its columns differ from the mirror\'s (the sheet changed since the last sync).');

        // Our cells, in the same rows the sync kept.
        const all = F.parse(text, rt.fmt);
        const header = src.header === false ? null : (all.length ? all[0] : []);
        const dataRows = (src.header === false ? all : all.slice(1)).filter((r) => !R.isBlank(r));
        if (dataRows.length !== spoolRows.length) {
            reasons.push(`It reads as ${dataRows.length} rows here but ${spoolRows.length} in the sync.`);
        } else {
            for (let i = 0; i < dataRows.length; i++) {
                const a = R.spoolValues(dataRows[i]);
                const b = spoolRows[i];
                if (a.length !== b.length || a.some((v, j) => v !== b[j])) {
                    reasons.push(`Row ${i + 1} reads differently here than in the sync.`);
                    break;
                }
            }
        }
        spoolRows = null;
        const width = Math.max(header ? header.length : 0, ...dataRows.map((r) => r.length), 0);
        const layout = {
            v: 1,
            key,
            fmt: rt.fmt,
            file: path.basename(file),
            header,
            width,
            columns,
            primaryKey: src.primaryKey && src.primaryKey.length ? src.primaryKey : null,
            officeColumns: src.officeColumns === false ? false : undefined,
            blankRowsDropped: rt.blankRowsDropped
        };
        if (reasons.length) return { eligible: false, reasons, info };

        // The records these cells give must be the ones the sync wrote.
        const builder = R.makeBuilder(layout);
        const built = [];
        for (let i = 0; i < dataRows.length; i += 2000) built.push(...builder.build(dataRows.slice(i, i + 2000)));
        const keys = R.claimKeys(built.map((b) => b.baseKey));
        if (o.compare !== false) {
            const pb = await envx.client();
            const have = new Map();
            for await (const page of pb.pages(ds.collection || 'ds_' + key, { fields: 'id,_hash,_row_no' })) {
                for (const r of page) have.set(r.id, r);
            }
            let bad = 0;
            let example = '';
            for (let i = 0; i < built.length; i++) {
                const h = have.get(keys[i].id);
                if (!h || h._hash !== built[i].hash || h._row_no !== i + 1) {
                    bad++;
                    if (!example) example = `row ${i + 1}: ${!h ? 'no such record' : h._hash !== built[i].hash ? 'different values' : 'different position'}`;
                }
            }
            if (have.size !== built.length) reasons.push(`The mirror holds ${have.size} rows, the snapshot ${built.length}.`);
            if (bad) reasons.push(`${bad} rows differ from the mirror's records (${example}); run a sync first.`);
            info.compared = built.length;
        }
        info.rows = built.length;
        info.columns = columns.length;
        return { eligible: reasons.length === 0, reasons, info, layout, cells: dataRows, keys, built };
    }

    /** Add the _src field (exact cells) to a ds_ collection if it is missing. */
    async function ensureSrcField(collection) {
        const pb = await envx.client();
        const coll = await pb.getCollection(collection);
        if (!coll) throw new EditorError(404, `Collection ${collection} is missing.`);
        if (coll.fields.some((f) => f.name.startsWith(S.collections.STAGE))) throw new EditorError(409, 'A column type change is half-way in this dataset; let the sync finish it first.');
        if (coll.fields.some((f) => f.name === R.SRC_FIELD)) return coll;
        const fields = coll.fields.concat([{ name: R.SRC_FIELD, type: 'json', maxSize: 2000000, required: false }]);
        return pb.updateCollection(coll.id, { fields });
    }

    /**
     * Make a mirror dataset native. Holds the sync lock throughout, so no sync touches it between its
     * last copy and the switch. → { analysis, snapshot }
     */
    async function takeOver(key, who, opts) {
        const o = opts || {};
        const ds0 = await registryRow(key);
        if (!ds0) throw new EditorError(404, 'No such dataset.');
        if (ds0.mode === 'native') throw new EditorError(409, 'This dataset is already native.');
        // Reasons the fresh copy below cannot fix (source kind, size, format) stop it before the lock.
        const pre = await analyse(key, { ds: ds0, compare: false });
        const hard = pre.reasons.filter((r) => !/differ|reads (as|differently)|holds/.test(r));
        if (hard.length) throw new EditorError(422, 'This dataset cannot be native: ' + hard.join(' '), { reasons: hard });
        const release = await S.lock.waitLock(envx.tmpDir, o.lockWaitMs == null ? 10 * 60000 : o.lockWaitMs, 1000);
        if (!release) throw new EditorError(503, 'A sync is still running after 10 minutes; try again later.');
        try {
            // One last fresh copy from the source (GET only, like every sync).
            if (o.freshCopy !== false) {
                const src = await envx.source(key);
                const pb = await envx.client();
                const { Registry } = S.registry;
                const registry = new Registry(pb);
                await registry.load();
                const { syncSource } = require(path.join(envx.SYNC, 'sync'));
                const r = await syncSource(src, {
                    pb, registry, tmpDir: envx.tmpDir, batchSize: 500, snapshotDir: envx.snapshotDir,
                    fullCheck: true, reason: `final copy before the VM takes over (${who})`,
                    onSnapshot: () => writeEntry(key, src, registry.get(key))
                });
                if (r.status !== 'ok' && r.status !== 'unchanged') throw new EditorError(502, `The final copy from the source failed: ${r.message}`);
            }
            const ds = await registryRow(key);
            const a = await analyse(key, { ds });
            if (!a.eligible) throw new EditorError(422, 'This dataset cannot be native: ' + a.reasons.join(' '), { reasons: a.reasons, info: a.info });
            const collection = ds.collection || 'ds_' + key;
            await ensureSrcField(collection);
            const pb = await envx.client();
            const base = `/api/collections/${collection}/records`;
            for (let i = 0; i < a.cells.length; i += 500) {
                const reqs = [];
                for (let j = i; j < Math.min(a.cells.length, i + 500); j++) {
                    reqs.push({ method: 'PATCH', url: `${base}/${a.keys[j].id}?fields=id`, body: { [R.SRC_FIELD]: a.cells[j] } });
                }
                await pb.batch(reqs);
            }
            const layout = a.layout;
            layout.takenFrom = { sha1: ds.snapshot_sha1, bytes: ds.snapshot_bytes, at: new Date().toISOString(), by: who };
            await patchRegistry(key, { mode: 'native', native_since: pbDate(new Date()), native_by: who, native_format: layout });
            const snap = await regenerate(key, { expectSha1: a.info.parity.blankRowsDropped ? null : ds.snapshot_sha1 });
            return { analysis: { reasons: [], info: a.info }, snapshot: snap };
        } finally {
            release();
        }
    }

    /** Native → mirror: the next sync (started at once) replaces the VM's rows with the source's. */
    async function release(key, who) {
        const ds = await registryRow(key);
        if (!ds) throw new EditorError(404, 'No such dataset.');
        if (ds.mode !== 'native') throw new EditorError(409, 'This dataset is not native.');
        const src = await envx.source(key);
        if (!src) throw new EditorError(422, 'This dataset was created in the editor and has no original source to go back to.');
        await patchRegistry(key, { mode: 'mirror', content_hash: '', last_version: '', notes: (ds.notes || '') });
        if (hooks && hooks.refreshMirror) hooks.refreshMirror([key], `back to the source (${who})`);
        return { mode: 'mirror' };
    }

    /**
     * A brand-new native dataset.
     * @param def { key, label, group, columns: [{ source_name, type, date_order? }], primaryKey?: string[] }
     */
    async function createDataset(def, who) {
        const key = String(def.key || '').trim();
        if (!S.normalise.validKey(key) || key.length > 40) throw new EditorError(400, 'Key: lowercase letters, digits and _, starting with a letter, at most 40 characters.');
        if (SENSITIVE.test(key)) throw new EditorError(400, 'That key is reserved.');
        if (await registryRow(key)) throw new EditorError(409, 'A dataset with this key already exists.');
        if (await envx.source(key)) throw new EditorError(409, 'A mirrored source already uses this key.');
        const cols = Array.isArray(def.columns) ? def.columns : [];
        if (!cols.length || cols.length > 200) throw new EditorError(400, 'Give between 1 and 200 columns.');
        const header = cols.map((c) => S.normalise.cleanHeader(c.source_name));
        if (header.some((h) => !h)) throw new EditorError(400, 'Every column needs a name.');
        const lower = header.map((h) => h.toLowerCase());
        if (new Set(lower).size !== lower.length) throw new EditorError(400, 'Column names must be different.');
        const names = S.normalise.fieldNames(header, header.map((_, i) => i));
        const TYPES = new Set(['text', 'number', 'date', 'bool']);
        const columns = cols.map((c, i) => {
            const type = TYPES.has(c.type) ? c.type : 'text';
            const col = { name: names[i], source_name: header[i], type, index: i, non_empty: 1 };
            if (type === 'date') col.date_order = c.date_order === 'mdy' ? 'mdy' : 'dmy';
            return col;
        });
        const pk = Array.isArray(def.primaryKey) ? def.primaryKey.filter((n) => header.includes(n)) : [];
        const layout = {
            v: 1, key, fmt: { v: F.FORMAT_VERSION, ext: 'csv', delimiter: ',', quote: 'minimal', eol: '\r\n', trailingEol: false, bom: false },
            file: key + '.csv', header, width: header.length, columns, primaryKey: pk.length ? pk : null, created: true, blankRowsDropped: 0
        };
        const oe = S.officeEnrich.prepare({ key }, columns);
        const collection = 'ds_' + key;
        const pb = await envx.client();
        await S.collections.ensureCollection(pb, collection, S.schema.fieldList(columns).concat(oe ? oe.fields : []));
        await ensureSrcField(collection);
        const now = pbDate(new Date());
        await pb.upsertRecord('sys_datasets', idFor(key), {
            key,
            label: String(def.label || key).slice(0, 200),
            group: String(def.group || 'Important').slice(0, 100),
            pages: [],
            source_type: 'native',
            source_ref: { created_in: 'data editor', by: who },
            source_url: '',
            collection,
            row_count: 0,
            column_count: columns.length,
            columns: S.schema.registryView(columns),
            primary_key: layout.primaryKey,
            schedule: 'native',
            last_status: 'ok',
            last_checked_at: now,
            last_synced_at: now,
            notes: String(def.notes || 'Created in the data editor; the VM is its only copy.').slice(0, 5000),
            mode: 'native',
            native_since: now,
            native_by: who,
            native_format: layout
        });
        const snap = await regenerate(key);
        return { key, collection, columns: S.schema.registryView(columns), snapshot: snap };
    }

    /** Write (or replace) one dataset's manifest entry, inside the manifest lock. */
    function writeEntry(key, src, ds, patch) {
        const dir = envx.snapshotDir;
        if (!dir || !ds || !ds.snapshot_file) return null;
        return S.snapshot.withManifestLock(dir, () => {
            const m = S.snapshot.readManifest(dir) || { generatedAt: null, datasets: {} };
            m.datasets = m.datasets || {};
            const prev = m.datasets[key] || null;
            let entry;
            if (src) entry = S.snapshot.entryFor(src, ds);
            else {
                entry = prev ? Object.assign({}, prev) : {
                    version: '', bytes: 0, contentType: S.snapshot.contentTypeFor(ds.snapshot_file), file: ds.snapshot_file,
                    fetchedAt: null, snapshotAt: null, checkedAt: null, sourceType: 'native', dataHubKeys: [], urls: [],
                    sensitive: false, label: ds.label || key, rows: 0
                };
            }
            Object.assign(entry, patch || {});
            m.datasets[key] = entry;
            const sorted = {};
            for (const k of Object.keys(m.datasets).sort()) sorted[k] = m.datasets[k];
            m.datasets = sorted;
            m.generatedAt = new Date().toISOString();
            S.snapshot.saveManifest(dir, m);
            return entry;
        });
    }

    async function* nativeRows(collection, width) {
        const pb = await envx.client();
        let last = -Infinity;
        for (;;) {
            const filter = Number.isFinite(last) ? `_row_no > ${last}` : '';
            const res = await pb.listRecords(collection, { page: 1, perPage: 1000, skipTotal: 1, sort: '_row_no,id', fields: '_row_no,' + R.SRC_FIELD, filter: filter || undefined });
            const items = (res && res.items) || [];
            for (const r of items) {
                const cells = R.cellsOf(r, 0);
                yield cells.length ? cells : R.cellsOf(r, width); // (every native row has _src; never empty)
            }
            if (items.length < 1000) return;
            last = items[items.length - 1]._row_no;
        }
    }

    /**
     * The snapshot of a native dataset from its rows; then sys_datasets and manifest.json.
     * Serialised per dataset (two commits never write the same file at once).
     */
    const regenChains = new Map();
    function regenerate(key, opts) {
        const prev = regenChains.get(key) || Promise.resolve();
        const run = prev.catch(() => {}).then(() => regenerateNow(key, opts));
        regenChains.set(key, run);
        run.finally(() => { if (regenChains.get(key) === run) regenChains.delete(key); }).catch(() => {});
        return run;
    }

    async function regenerateNow(key, opts) {
        const o = opts || {};
        const ds = await registryRow(key);
        if (!ds || ds.mode !== 'native') throw new EditorError(409, 'This dataset is not native.');
        const layout = ds.native_format;
        const dir = envx.snapshotDir;
        const pb = await envx.client();
        const collection = ds.collection || 'ds_' + key;
        const count = await pb.listRecords(collection, { page: 1, perPage: 1, fields: 'id' });
        const rows = count.totalItems || 0;
        if (!dir) {
            await patchRegistry(key, { row_count: rows, last_synced_at: pbDate(new Date()) });
            return { written: false, reason: 'no snapshot folder', rows };
        }
        const fmt = layout.fmt;
        const writer = new S.snapshot.SnapshotWriter(dir, key, fmt.ext);
        try {
            async function* all() {
                if (layout.header) yield layout.header;
                for await (const r of nativeRows(collection, layout.width)) yield r;
            }
            await F.serializeTo(all(), fmt, (chunk) => writer.write(chunk));
        } catch (err) {
            await writer.abort();
            throw err;
        }
        const snap = await writer.publish(ds.snapshot_sha1);
        if (o.expectSha1 && snap.sha1 !== o.expectSha1) {
            // Never expected: analyse() proved the bytes come back. Logged, not fatal (the rows are right).
            console.warn(`[Editor] ${key}: regenerated snapshot differs from the source copy (${snap.sha1} vs ${o.expectSha1})`);
        }
        const now = new Date();
        const fields = { row_count: rows, snapshot_file: snap.file, snapshot_sha1: snap.sha1, snapshot_bytes: snap.bytes, last_synced_at: pbDate(now) };
        if (snap.changed) fields.snapshot_at = pbDate(now);
        const saved = await patchRegistry(key, fields);
        const src = await envx.source(key);
        writeEntry(key, src, saved, { checkedAt: now.toISOString(), fetchedAt: now.toISOString(), rows });
        if (hooks && hooks.afterSnapshot) hooks.afterSnapshot(key, snap);
        return { written: snap.changed, version: snap.sha1, bytes: snap.bytes, rows, file: snap.file };
    }

    return { analyse, takeOver, release, createDataset, regenerate, registryRow, patchRegistry, writeEntry, MAX_NATIVE_ROWS };
}

module.exports = { create, EditorError, MAX_NATIVE_ROWS, SENSITIVE };
