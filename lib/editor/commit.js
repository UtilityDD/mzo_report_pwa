'use strict';
// Commits to a native dataset: every change the editor makes (cell edits, pastes, imports, deletes,
// undo) goes through here as one batch. docs/data-editor.md describes the guarantees:
//
//   all or nothing   up to CHUNK requests (rows, their audit rows and the batch row) go to
//                    PocketBase's batch API as one transaction. A bigger batch is sent in parts; if a
//                    later part fails, the parts already applied are reverted from the audit log, and
//                    a batch left half-applied by a crash is reverted when the server next starts.
//   no lost updates  each update and delete names the _hash the user saw; a row changed or deleted
//                    since is a conflict, and nothing is written.
//   exactly once     the batch row's id comes from the client's idempotency key and is written in the
//                    same transaction as the first rows: a retry after a lost answer gets the stored result.
//   consistent       records are built by lib/editor/records.js exactly as the sync builds them.

const path = require('path');
const R = require('./records');
const { EditorError } = require('./native');

const CHUNK = 900; // requests per PocketBase batch (its settings allow 1000)
const MAX_OPS = 5000;
const MAX_CELL = 50000;
const STALE_APPLYING_MS = 2 * 60000;
const SYSTEM_KEYS = new Set(['collectionId', 'collectionName', 'created', 'updated', 'expand']);

function create(envx, nativeApi, hooks) {
    const util = require(path.join(envx.SYNC, 'util'));
    const { PbError } = require(path.join(envx.SYNC, 'pb'));
    const { recordId, pbDate } = util;
    const LOG = 'app_edit_log';
    const BATCHES = 'app_edit_batches';

    // One commit at a time per dataset (in this process; the editor is the only writer of native rows).
    const chains = new Map();
    function exclusive(key, fn) {
        const prev = chains.get(key) || Promise.resolve();
        const run = prev.catch(() => {}).then(fn);
        chains.set(key, run);
        run.finally(() => { if (chains.get(key) === run) chains.delete(key); }).catch(() => {});
        return run;
    }

    const q = (v) => "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    const clean = (rec) => {
        if (!rec) return null;
        const out = {};
        for (const k of Object.keys(rec)) if (!SYSTEM_KEYS.has(k)) out[k] = rec[k];
        return out;
    };

    async function fetchByIds(pb, collection, ids) {
        const out = new Map();
        const list = [...new Set(ids)];
        for (let i = 0; i < list.length; i += 60) {
            const part = list.slice(i, i + 60);
            const res = await pb.listRecords(collection, { page: 1, perPage: 200, skipTotal: 1, filter: part.map((id) => 'id=' + q(id)).join('||') });
            for (const r of res.items || []) out.set(r.id, r);
        }
        return out;
    }

    async function takenKeys(pb, collection, keys) {
        const out = new Map(); // _row_key → id
        const list = [...new Set(keys)];
        for (let i = 0; i < list.length; i += 40) {
            const part = list.slice(i, i + 40);
            const res = await pb.listRecords(collection, { page: 1, perPage: 200, skipTotal: 1, fields: 'id,_row_key', filter: part.map((k) => '_row_key=' + q(k)).join('||') });
            for (const r of res.items || []) out.set(r._row_key, r.id);
        }
        return out;
    }

    async function maxRowNo(pb, collection) {
        const res = await pb.listRecords(collection, { page: 1, perPage: 1, skipTotal: 1, sort: '-_row_no', fields: '_row_no' });
        const it = (res.items || [])[0];
        return it ? Number(it._row_no) || 0 : 0;
    }

    function batchIdFor(who, idem) {
        return recordId('editor-batch:' + who + ':' + idem);
    }

    /**
     * Turn the client's operations into a checked plan. Nothing is written.
     * @param ctx { ds, layout, rights, who, scope }
     * @param ops [{ op: 'create'|'update'|'delete', id?, hash?, cells?: { field: text } }]
     * @returns { items, invalid, conflicts, denied, unchanged, counts }
     */
    async function plan(ctx, ops, opts) {
        const o = opts || {};
        const { ds, layout } = ctx;
        if (!Array.isArray(ops) || !ops.length) throw new EditorError(400, 'Nothing to commit.');
        if (ops.length > MAX_OPS) throw new EditorError(413, `At most ${MAX_OPS.toLocaleString('en-IN')} rows in one commit; split it into parts.`);
        const pb = await envx.client();
        const collection = ds.collection || 'ds_' + ds.key;
        const builder = R.makeBuilder(layout);
        const colIndex = new Map(layout.columns.map((c) => [c.name, c.index]));
        const width = layout.width;

        const ids = ops.filter((x) => x && (x.op === 'update' || x.op === 'delete')).map((x) => String(x.id || ''));
        const current = await fetchByIds(pb, collection, ids);
        const items = [];
        const invalid = [];
        const conflicts = [];
        const denied = [];
        const seenIds = new Set();
        ops.forEach((x, i) => {
            const op = x && x.op;
            if (op !== 'create' && op !== 'update' && op !== 'delete') throw new EditorError(400, `Operation ${i + 1}: unknown kind.`);
            const cells = x.cells && typeof x.cells === 'object' ? x.cells : {};
            for (const f of Object.keys(cells)) {
                if (!colIndex.has(f)) throw new EditorError(400, `Operation ${i + 1}: unknown column ${f}.`);
                const v = cells[f];
                if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new EditorError(400, `Operation ${i + 1}: ${f} must be text.`);
                if (String(v == null ? '' : v).length > MAX_CELL) invalid.push({ i, field: f, value: String(v).slice(0, 80) + '…', message: 'Longer than 50,000 characters' });
            }
            const right = op === 'create' ? 'can_add' : op === 'update' ? 'can_edit' : 'can_delete';
            if (!ctx.rights[right]) { denied.push({ i, reason: `You may not ${op === 'create' ? 'add rows to' : op === 'update' ? 'edit' : 'delete rows of'} this dataset.` }); return; }
            let before = null;
            if (op !== 'create') {
                const id = String(x.id || '');
                if (seenIds.has(id)) throw new EditorError(400, `Operation ${i + 1}: the same row appears twice.`);
                seenIds.add(id);
                before = current.get(id) || null;
                if (!before) { conflicts.push({ i, id, reason: 'deleted', message: 'This row was deleted by someone else.' }); return; }
                if (!x.hash || before._hash !== x.hash) {
                    conflicts.push({ i, id, reason: 'changed', message: 'This row was changed by someone else.', current: { hash: before._hash, cells: R.cellsOf(before, width) } });
                    return;
                }
                if (ctx.scope && !ctx.scope.match(before)) { denied.push({ i, reason: 'This row is outside your office.' }); return; }
            }
            let cellsArr = null;
            if (op !== 'delete') {
                cellsArr = op === 'create' ? new Array(width).fill('') : R.cellsOf(before, width);
                for (const f of Object.keys(cells)) cellsArr[colIndex.get(f)] = cells[f] == null ? '' : String(cells[f]);
                for (const f of Object.keys(cells)) {
                    const msg = builder.validate(f, cells[f]);
                    if (msg) invalid.push({ i, field: f, value: String(cells[f]).slice(0, 200), message: msg });
                }
                if (op === 'create' && R.isBlank(cellsArr)) { invalid.push({ i, field: '', value: '', message: 'The row is empty' }); }
            }
            items.push({ i, op, id: before ? before.id : null, before, cells: cellsArr });
        });

        // Rows with invalid cells are refused, or left out when the user chose to hold them back.
        // (They are never built: a value that does not fit its column has no typed value.)
        const badRows = new Set(invalid.map((v) => v.i));
        let held = 0;
        let work = items;
        if (badRows.size) {
            work = items.filter((it) => !badRows.has(it.i));
            if (o.skipInvalid) held = items.length - work.length;
        }

        // Records the new cells give, keys and record ids, as the sync would give them.
        const toBuild = work.filter((it) => it.op !== 'delete');
        const updates = toBuild.filter((it) => it.op === 'update');
        const built = toBuild.length ? builder.build(toBuild.map((it) => it.cells).concat(updates.map((it) => R.cellsOf(it.before, width)))) : [];
        toBuild.forEach((it, k) => { it.built = built[k]; });
        updates.forEach((it, k) => { it.beforeBase = built[toBuild.length + k].baseKey; });
        const freed = new Set(); // keys that this batch takes away (deleted or re-keyed rows)
        for (const it of work) if (it.op === 'delete') freed.add(it.before._row_key);
        // An update that keeps its key keeps its record; others need a free key.
        // (Its key is the same when the key cells did not change: a repeat keeps its ':2'.)
        for (const it of work) {
            if (it.op !== 'update') continue;
            if (it.built.baseKey === it.beforeBase) it.key = it.before._row_key;
            else freed.add(it.before._row_key);
        }
        const need = work.filter((it) => it.op !== 'delete' && !it.key);
        const claimed = new Set(work.filter((it) => it.key).map((it) => it.key));
        if (need.length) {
            let candidates = need.map((it) => ({ it, base: it.built.baseKey, occ: 1 }));
            for (let round = 0; candidates.length && round < 50; round++) {
                const keys = candidates.map((c) => (c.occ === 1 ? c.base : c.base + ':' + c.occ));
                const taken = await takenKeys(pb, collection, keys);
                const next = [];
                candidates.forEach((c, k) => {
                    const key = keys[k];
                    const busy = (taken.has(key) && !freed.has(key)) || claimed.has(key);
                    if (!busy) { c.it.key = key; claimed.add(key); return; }
                    if (builder.usesPk && !/^h:/.test(c.base)) {
                        const pk = (layout.primaryKey || []).join(', ');
                        invalid.push({ i: c.it.i, field: '', value: c.base.slice(0, 200), message: `Another row already has this ${pk}` });
                        c.it.dup = true;
                        return;
                    }
                    c.occ++;
                    next.push(c);
                });
                candidates = next;
            }
            if (candidates.length) throw new EditorError(500, 'Could not find free row keys.');
        }
        if (o.skipInvalid) {
            const dupRows = new Set(work.filter((it) => it.dup).map((it) => it.i));
            if (dupRows.size) { work = work.filter((it) => !dupRows.has(it.i)); held += dupRows.size; }
        }

        // Scope: the new values must keep the row inside the user's office.
        if (ctx.scope) {
            for (const it of work) if (it.built && !ctx.scope.match(it.built.record)) denied.push({ i: it.i, reason: 'The row would be outside your office (check its office columns).' });
        }

        let unchanged = 0;
        const final = [];
        for (const it of work) {
            if (it.op === 'update' && it.key === it.before._row_key && it.built.hash === it.before._hash && sameCells(R.cellsOf(it.before, width), it.cells)) {
                unchanged++;
                continue;
            }
            final.push(it);
        }
        // Deletes first, then updates, then new rows: a key freed in this batch is free before it is reused.
        const rank = { delete: 0, update: 1, create: 2 };
        final.sort((a, b) => rank[a.op] - rank[b.op] || a.i - b.i);
        const counts = { added: 0, changed: 0, deleted: 0, unchanged, held };
        for (const it of final) counts[it.op === 'create' ? 'added' : it.op === 'update' ? 'changed' : 'deleted']++;
        const blocking = o.skipInvalid ? [] : invalid;
        return { items: final, invalid, conflicts, denied, counts, blocking, collection };
    }

    function sameCells(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    /** Requests for one planned item: the row change and its audit row. */
    function requestsFor(item, base, rowNo, batchId, seq, logMeta) {
        const reqs = [];
        const now = pbDate(new Date());
        let after = null;
        let recordIdOut = item.id;
        if (item.op === 'delete') {
            reqs.push({ method: 'DELETE', url: `${base}/${item.before.id}` });
        } else {
            const id = recordId(item.key);
            const body = Object.assign({}, item.built.record, {
                _row_key: item.key,
                _row_no: item.op === 'create' ? rowNo : item.before._row_no,
                _synced_at: now,
                [R.SRC_FIELD]: item.cells
            });
            if (item.op === 'update' && id === item.before.id) {
                reqs.push({ method: 'PATCH', url: `${base}/${id}?fields=id`, body });
            } else {
                if (item.op === 'update') reqs.push({ method: 'DELETE', url: `${base}/${item.before.id}` });
                reqs.push({ method: 'POST', url: `${base}?fields=id`, body: Object.assign({ id }, body) });
            }
            after = Object.assign({ id }, body);
            recordIdOut = id;
        }
        reqs.push({
            method: 'POST',
            url: `/api/collections/${LOG}/records?fields=id`,
            body: {
                batch_id: batchId, dataset_key: logMeta.key, record_id: recordIdOut, op: item.op, seq,
                row_no: after ? after._row_no : item.before._row_no,
                before: clean(item.before), after, user_email: logMeta.who, at: now, client: logMeta.client
            }
        });
        return { reqs, after };
    }

    /** Which request of a failed batch, and why, from PocketBase's answer. */
    function batchFailure(err) {
        const reqs = err && err.data && err.data.data && err.data.data.requests;
        if (reqs && typeof reqs === 'object') {
            const k = Object.keys(reqs)[0];
            const resp = reqs[k] && reqs[k].response;
            return { index: Number(k), message: resp ? PbError.describe(resp) : err.message };
        }
        return { index: -1, message: err ? err.message : 'unknown error' };
    }

    async function logsOf(pb, batchId) {
        const out = [];
        let page = 1;
        for (;;) {
            const res = await pb.listRecords(LOG, { page, perPage: 500, skipTotal: 1, sort: 'seq', filter: 'batch_id=' + q(batchId) });
            out.push(...(res.items || []));
            if ((res.items || []).length < 500) return out;
            page++;
        }
    }

    /** Requests that put back what these audit rows changed (reverse order). */
    function inverse(logs, collection) {
        const base = `/api/collections/${collection}/records`;
        const reqs = [];
        for (const l of [...logs].sort((a, b) => b.seq - a.seq)) {
            const before = l.before;
            const after = l.after;
            if (l.op === 'create') reqs.push([{ method: 'DELETE', url: `${base}/${after.id}` }]);
            else if (l.op === 'delete') reqs.push([{ method: 'POST', url: `${base}?fields=id`, body: before }]);
            else if (before.id === after.id) {
                const body = Object.assign({}, before);
                delete body.id;
                reqs.push([{ method: 'PATCH', url: `${base}/${before.id}?fields=id`, body }]);
            } else reqs.push([{ method: 'DELETE', url: `${base}/${after.id}` }, { method: 'POST', url: `${base}?fields=id`, body: before }]);
        }
        return reqs;
    }

    /** Revert a batch that stopped half-way (its applied parts are in the audit log). */
    async function rollback(pb, batchId, collection, why) {
        const logs = await logsOf(pb, batchId);
        const groups = inverse(logs, collection);
        let chunk = [];
        const flush = async () => { if (chunk.length) { await pb.batch(chunk); chunk = []; } };
        for (const g of groups) {
            if (chunk.length + g.length > CHUNK) await flush();
            chunk.push(...g);
        }
        // The audit rows of a reverted batch describe nothing that happened: they go with the last part.
        for (const l of logs) {
            if (chunk.length + 1 > CHUNK) await flush();
            chunk.push({ method: 'DELETE', url: `/api/collections/${LOG}/records/${l.id}` });
        }
        if (chunk.length + 1 > CHUNK) await flush();
        chunk.push({ method: 'PATCH', url: `/api/collections/${BATCHES}/records/${batchId}`, body: { status: 'rolled_back', error: String(why || '').slice(0, 5000) } });
        await flush();
        return logs.length;
    }

    /** Batches left 'applying' by a crash: revert them. Called at start and before each commit. */
    async function recover(datasetKey) {
        const pb = await envx.client();
        const cutoff = pbDate(new Date(Date.now() - STALE_APPLYING_MS));
        const filter = "status='applying' && updated < " + q(cutoff) + (datasetKey ? ' && dataset_key=' + q(datasetKey) : '');
        const res = await pb.listRecords(BATCHES, { page: 1, perPage: 50, skipTotal: 1, filter });
        let n = 0;
        for (const b of res.items || []) {
            if (chains.has(b.dataset_key) && !datasetKey) continue; // being applied right now
            const ds = await nativeApi.registryRow(b.dataset_key);
            const collection = (ds && ds.collection) || 'ds_' + b.dataset_key;
            await rollback(pb, b.id, collection, 'Reverted after an interrupted commit.');
            n++;
        }
        return n;
    }

    /**
     * Apply a plan as one batch. → stored result (also kept on the batch row for idempotent retries).
     * @param meta { kind, idem, who, client, summary, undoOf }
     */
    async function apply(ctx, planned, meta) {
        const pb = await envx.client();
        const { ds } = ctx;
        const collection = planned.collection;
        const base = `/api/collections/${collection}/records`;
        const batchId = meta.batchId || batchIdFor(meta.who, meta.idem);
        let rowNo = await maxRowNo(pb, collection);
        const groups = [];
        const out = [];
        let seq = 0;
        for (const it of planned.items) {
            const r = requestsFor(it, base, it.op === 'create' ? ++rowNo : 0, batchId, ++seq, { key: ds.key, who: meta.who, client: meta.client || null });
            groups.push({ reqs: r.reqs, it });
            out.push({ i: it.i, op: it.op, id: r.after ? r.after.id : it.before.id, oldId: it.before ? it.before.id : null,
                hash: r.after ? r.after._hash : null, row_no: r.after ? r.after._row_no : it.before._row_no, cells: it.cells });
        }
        const result = { batchId, status: 'committed', counts: planned.counts, rows: out.length <= 2000 ? out : null };
        const batchRow = {
            id: batchId, dataset_key: ds.key, kind: meta.kind || 'commit', user_email: meta.who,
            summary: String(meta.summary || summarise(planned.counts)).slice(0, 2000), counts: planned.counts,
            undo_of: meta.undoOf || '', client: meta.client || null, parts: 1, error: ''
        };
        // Parts of at most CHUNK requests; an item's requests never split.
        const parts = [];
        let cur = [];
        let curItems = [];
        for (const g of groups) {
            if (cur.length + g.reqs.length > CHUNK - 2) { parts.push({ reqs: cur, items: curItems }); cur = []; curItems = []; }
            cur.push(...g.reqs);
            if (g.it) curItems.push(g.it);
        }
        parts.push({ reqs: cur, items: curItems });
        batchRow.parts = parts.length;
        if (parts.length === 1) {
            parts[0].reqs.unshift({ method: 'POST', url: `/api/collections/${BATCHES}/records?fields=id`, body: Object.assign({}, batchRow, { status: 'committed', result }) });
        } else {
            parts[0].reqs.unshift({ method: 'POST', url: `/api/collections/${BATCHES}/records?fields=id`, body: Object.assign({}, batchRow, { status: 'applying' }) });
            parts[parts.length - 1].reqs.push({ method: 'PATCH', url: `/api/collections/${BATCHES}/records/${batchId}?fields=id`, body: { status: 'committed', result } });
        }
        for (let p = 0; p < parts.length; p++) {
            try {
                await pb.batch(parts[p].reqs);
            } catch (err) {
                let applied = false;
                if (!(err instanceof PbError)) {
                    // No answer: did this part commit? Its last audit row says.
                    applied = await partLanded(pb, batchId, parts[p], p === parts.length - 1);
                }
                if (applied) continue;
                const why = describeFailure(err, parts[p], p);
                if (p > 0) {
                    try { await rollback(pb, batchId, collection, why); } catch (e2) {
                        throw new EditorError(500, `Part ${p + 1} of ${parts.length} failed (${why}) and the earlier parts could not be reverted yet (${e2.message}); they will be reverted automatically.`);
                    }
                    throw new EditorError(422, `Nothing was saved: part ${p + 1} of ${parts.length} failed (${why}), and the earlier parts were reverted.`);
                }
                throw new EditorError(err instanceof PbError && err.status < 500 ? 422 : 502, 'Nothing was saved: ' + why);
            }
        }
        return result;
    }

    async function partLanded(pb, batchId, part, last) {
        try {
            if (last) {
                const b = await pb.getRecord(BATCHES, batchId);
                return b.status === 'committed';
            }
            const logs = part.reqs.filter((r) => r.url.startsWith(`/api/collections/${LOG}/`));
            const lastSeq = logs.length ? logs[logs.length - 1].body.seq : null;
            if (lastSeq == null) return false;
            const res = await pb.listRecords(LOG, { page: 1, perPage: 1, skipTotal: 1, filter: 'batch_id=' + q(batchId) + ' && seq=' + lastSeq });
            return (res.items || []).length > 0;
        } catch (_) {
            return false;
        }
    }

    function describeFailure(err, part, p) {
        if (!(err instanceof PbError)) return 'PocketBase did not answer (' + err.message + ')';
        const f = batchFailure(err);
        const req = part.reqs[f.index];
        let where = '';
        if (req && req.body && req.body._row_no) where = `row ${req.body._row_no}: `;
        if (/_row_key/.test(f.message) && /unique/i.test(f.message)) return where + 'another row has the same key';
        return where + f.message.slice(0, 300);
    }

    function summarise(c) {
        const parts = [];
        if (c.added) parts.push(`${c.added} added`);
        if (c.changed) parts.push(`${c.changed} changed`);
        if (c.deleted) parts.push(`${c.deleted} deleted`);
        return parts.join(', ') || 'no changes';
    }

    /**
     * Full commit: idempotency, plan, checks, apply, snapshot. Serialised per dataset.
     * @returns {status, body}
     */
    function commit(ctx, body, meta) {
        return exclusive(ctx.ds.key, async () => {
            const pb = await envx.client();
            const idem = String(body.idempotencyKey || '');
            if (!/^[A-Za-z0-9_-]{8,80}$/.test(idem)) throw new EditorError(400, 'Missing idempotency key.');
            const batchId = batchIdFor(meta.who, idem);
            const prior = await getBatch(pb, batchId);
            if (prior) {
                if (prior.status === 'committed' || prior.status === 'undone') return { status: 200, body: Object.assign({}, prior.result || {}, { replayed: true }) };
                if (prior.status === 'applying') throw new EditorError(409, 'This commit is still being applied; try again in a minute.');
                await pb.deleteRecord(BATCHES, batchId); // rolled back earlier: this retry starts afresh
            }
            await recover(ctx.ds.key);
            const planned = await plan(ctx, body.ops, { skipInvalid: !!body.skipInvalid });
            if (planned.denied.length) throw new EditorError(403, planned.denied[0].reason, { denied: planned.denied });
            if (planned.conflicts.length) throw new EditorError(409, `${planned.conflicts.length} row(s) were changed by someone else since you loaded them.`, { conflicts: planned.conflicts });
            if (planned.blocking.length) throw new EditorError(422, `${new Set(planned.blocking.map((v) => v.i)).size} row(s) have values that do not fit their column.`, { invalid: planned.invalid });
            if (!planned.items.length) return { status: 200, body: { batchId: null, status: 'nothing', counts: planned.counts } };
            const result = await apply(ctx, planned, Object.assign({}, meta, { batchId, kind: body.kind || meta.kind || 'commit' }));
            result.snapshot = await afterCommit(ctx.ds.key);
            return { status: 200, body: result };
        });
    }

    async function afterCommit(key) {
        try {
            const snap = await nativeApi.regenerate(key);
            if (hooks && hooks.onChanged) hooks.onChanged([key]);
            return snap;
        } catch (err) {
            console.warn(`[Editor] ${key}: snapshot not written after a commit: ${err.message}`);
            if (hooks && hooks.snapshotFailed) hooks.snapshotFailed(key);
            return { written: false, error: 'The change is saved, but the app copy could not be refreshed yet; it will be retried.' };
        }
    }

    async function getBatch(pb, id) {
        try { return await pb.getRecord(BATCHES, id); } catch (err) { if (err.status === 404) return null; throw err; }
    }

    /** Preview: the plan without writing, with per-cell before/after for the diff screen. */
    async function preview(ctx, body) {
        const planned = await plan(ctx, body.ops, { skipInvalid: !!body.skipInvalid });
        const width = ctx.layout.width;
        const rows = planned.items.slice(0, 3000).map((it) => ({
            i: it.i, op: it.op, id: it.before ? it.before.id : null, row_no: it.before ? it.before._row_no : null,
            before: it.before ? R.cellsOf(it.before, width) : null, after: it.cells
        }));
        return { counts: planned.counts, rows, invalid: planned.invalid, conflicts: planned.conflicts, denied: planned.denied };
    }

    /**
     * Undo a whole committed batch, if none of its rows changed since. → result like commit()
     */
    function undo(ctx, batchId, body, meta) {
        return exclusive(ctx.ds.key, async () => {
            const pb = await envx.client();
            const idem = String((body && body.idempotencyKey) || '');
            if (!/^[A-Za-z0-9_-]{8,80}$/.test(idem)) throw new EditorError(400, 'Missing idempotency key.');
            const newId = batchIdFor(meta.who, idem);
            const prior = await getBatch(pb, newId);
            if (prior && prior.status === 'committed') return { status: 200, body: Object.assign({}, prior.result || {}, { replayed: true }) };
            if (prior && prior.status === 'applying') throw new EditorError(409, 'This undo is still being applied; try again in a minute.');
            if (prior) await pb.deleteRecord(BATCHES, newId);
            const b = await getBatch(pb, batchId);
            if (!b || b.dataset_key !== ctx.ds.key) throw new EditorError(404, 'No such commit.');
            if (b.status !== 'committed') throw new EditorError(409, b.status === 'undone' ? 'This commit was already undone.' : `This commit is ${b.status}.`);
            if (!ctx.isAdmin && b.user_email !== meta.who) throw new EditorError(403, 'Only an admin can undo someone else\'s commit.');
            const logs = await logsOf(pb, batchId);
            if (!logs.length) throw new EditorError(409, 'This commit changed no rows.');
            const collection = ctx.ds.collection || 'ds_' + ctx.ds.key;
            // Every row must still be as the commit left it.
            const ids = new Set();
            for (const l of logs) { if (l.after) ids.add(l.after.id); if (l.before) ids.add(l.before.id); }
            const now = await fetchByIds(pb, collection, [...ids]);
            const conflicts = [];
            for (const l of logs) {
                const a = l.after;
                const bf = l.before;
                if (l.op === 'create' || l.op === 'update') {
                    const cur = now.get(a.id);
                    if (!cur) conflicts.push({ row_no: a._row_no, message: 'deleted since' });
                    else if (cur._hash !== a._hash) conflicts.push({ row_no: a._row_no, message: 'changed since' });
                }
                if ((l.op === 'delete' || (l.op === 'update' && bf.id !== a.id)) && now.get(bf.id)) conflicts.push({ row_no: bf._row_no, message: 'added again since' });
                if (!ctx.isAdmin) {
                    const need = l.op === 'create' ? 'can_add' : l.op === 'update' ? 'can_edit' : 'can_delete';
                    if (!ctx.rights[need]) throw new EditorError(403, 'You no longer have the rights this commit used.');
                }
            }
            if (conflicts.length) throw new EditorError(409, `${conflicts.length} row(s) of this commit changed since; it cannot be undone as a whole.`, { conflicts });
            // The inverse as a new batch with its own audit rows.
            const items = [];
            for (const l of [...logs].sort((x, y) => y.seq - x.seq)) {
                if (l.op === 'create') items.push({ op: 'delete', before: now.get(l.after.id), i: items.length });
                else if (l.op === 'delete') items.push({ op: 'restore', after: l.before, i: items.length });
                else items.push({ op: 'revert', before: now.get(l.after.id), after: l.before, i: items.length });
            }
            const counts = { added: 0, changed: 0, deleted: 0, unchanged: 0, held: 0 };
            for (const it of items) counts[it.op === 'delete' ? 'deleted' : it.op === 'restore' ? 'added' : 'changed']++;
            const result = await applyRaw(pb, ctx, collection, items, counts, {
                batchId: newId, who: meta.who, client: meta.client, kind: 'undo', undoOf: batchId,
                summary: `Undo of ${b.summary || batchId}`,
                last: [{ method: 'PATCH', url: `/api/collections/${BATCHES}/records/${batchId}?fields=id`, body: { status: 'undone', undone_by: newId } }]
            });
            result.snapshot = await afterCommit(ctx.ds.key);
            return { status: 200, body: result };
        });
    }

    /** Apply restore/revert/delete items built from audit rows (undo). Same parts and rollback as apply(). */
    async function applyRaw(pb, ctx, collection, items, counts, meta) {
        const base = `/api/collections/${collection}/records`;
        const now = pbDate(new Date());
        const groups = [];
        let seq = 0;
        for (const it of items) {
            const reqs = [];
            let op;
            let before = null;
            let after = null;
            if (it.op === 'delete') {
                op = 'delete';
                before = clean(it.before);
                reqs.push({ method: 'DELETE', url: `${base}/${it.before.id}` });
            } else if (it.op === 'restore') {
                op = 'create';
                after = Object.assign({}, it.after, { _synced_at: now });
                reqs.push({ method: 'POST', url: `${base}?fields=id`, body: after });
            } else {
                op = 'update';
                before = clean(it.before);
                after = Object.assign({}, it.after, { _synced_at: now });
                if (it.before.id === after.id) {
                    const body = Object.assign({}, after);
                    delete body.id;
                    reqs.push({ method: 'PATCH', url: `${base}/${after.id}?fields=id`, body });
                } else {
                    reqs.push({ method: 'DELETE', url: `${base}/${it.before.id}` });
                    reqs.push({ method: 'POST', url: `${base}?fields=id`, body: after });
                }
            }
            reqs.push({ method: 'POST', url: `/api/collections/${LOG}/records?fields=id`, body: {
                batch_id: meta.batchId, dataset_key: ctx.ds.key, record_id: after ? after.id : before.id, op, seq: ++seq,
                row_no: after ? after._row_no : before._row_no, before, after, user_email: meta.who, at: now, client: meta.client || null } });
            groups.push(reqs);
        }
        const result = { batchId: meta.batchId, status: 'committed', counts, undoOf: meta.undoOf };
        const batchRow = { id: meta.batchId, dataset_key: ctx.ds.key, kind: meta.kind, user_email: meta.who, summary: String(meta.summary).slice(0, 2000),
            counts, undo_of: meta.undoOf || '', client: meta.client || null, error: '' };
        const parts = [];
        let cur = [];
        for (const g of groups) {
            if (cur.length + g.length > CHUNK - 3) { parts.push(cur); cur = []; }
            cur.push(...g);
        }
        parts.push(cur);
        batchRow.parts = parts.length;
        parts[0].unshift({ method: 'POST', url: `/api/collections/${BATCHES}/records?fields=id`, body: Object.assign({}, batchRow, parts.length === 1 ? { status: 'committed', result } : { status: 'applying' }) });
        if (parts.length > 1) parts[parts.length - 1].push({ method: 'PATCH', url: `/api/collections/${BATCHES}/records/${meta.batchId}?fields=id`, body: { status: 'committed', result } });
        parts[parts.length - 1].push(...(meta.last || []));
        for (let p = 0; p < parts.length; p++) {
            try {
                await pb.batch(parts[p]);
            } catch (err) {
                const why = describeFailure(err, { reqs: parts[p] }, p);
                if (p > 0) {
                    try { await rollback(pb, meta.batchId, collection, why); } catch (_) { /* recovered at start */ }
                }
                throw new EditorError(422, 'Nothing was undone: ' + why);
            }
        }
        return result;
    }

    return { plan, preview, commit, undo, recover, rollback, batchIdFor, CHUNK, MAX_OPS, _apply: apply };
}

module.exports = { create, CHUNK, MAX_OPS };
