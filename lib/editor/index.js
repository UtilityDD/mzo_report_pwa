'use strict';
// The data editor's server side: /api/editor/* (docs/data-editor.md). The page itself is the static
// folder editor/ (served at /editor/ like every other page, on the app's own sign-in cookie).
//
//   require('./lib/editor').mount(app, { refreshMirror, onChanged, isSensitive })
//
// Off unless the app has PocketBase superuser credentials (the VM): every route then answers 503.
// Every request needs a signed-in session; every write also needs Content-Type: application/json and
// the header X-MZO-Editor: 1 (a cross-site page cannot send either without a CORS preflight, which
// this server never grants), and an Origin, when sent, of this host.

const path = require('path');
const { spawn } = require('child_process');
const express = require('express');

const envMod = require('./env');
const nativeMod = require('./native');
const commitMod = require('./commit');
const permsMod = require('./perms');
const Q = require('./query');
const R = require('./records');
const F = require('./format');
const { clientIp } = require('../local_admins');

const { EditorError } = nativeMod;
const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const GROUP_ORDER = ['New service connection', 'Revenue', 'DD visit', 'Consumers & meters', 'Vendor advances', 'Substation & network', 'Important', 'Media', 'Administration', 'System'];
const BATCHES = 'app_edit_batches';
const LOG = 'app_edit_log';

function mount(app, options) {
    const opts = options || {};
    const envx = opts.envx || envMod.create(opts.env || process.env);
    const isSensitiveKey = (key) => nativeMod.SENSITIVE.test(key) || !!(opts.isSensitive && opts.isSensitive(key));
    const hooks = {
        refreshMirror: opts.refreshMirror,
        onChanged: opts.onChanged,
        afterSnapshot: (key) => scheduleDerived(key),
        snapshotFailed: (key) => retrySnapshots.add(key)
    };
    const nativeApi = nativeMod.create(envx, hooks);
    const commits = commitMod.create(envx, nativeApi, hooks, { chunk: opts.chunk, staleMs: opts.staleMs });
    const perms = permsMod.create(envx, { isSensitive: (key) => isSensitiveKey(key) });
    const router = express.Router();

    // ---- Derived files after a snapshot changes: uniform rows and the performance rating --------
    const derivedKeys = new Set();
    let derivedTimer = null;
    let derivedRunning = false;
    function scheduleDerived(key) {
        if (!envx.snapshotDir || opts.noDerived) return;
        derivedKeys.add(key);
        if (!derivedTimer) derivedTimer = setTimeout(runDerived, opts.derivedDelayMs || 5000);
    }
    function runDerived() {
        derivedTimer = null;
        if (derivedRunning) { derivedTimer = setTimeout(runDerived, 5000); return; }
        const keys = [...derivedKeys];
        derivedKeys.clear();
        if (!keys.length) return;
        derivedRunning = true;
        const node = process.execPath;
        const dir = envx.snapshotDir;
        const step = (args, next) => {
            let child;
            try { child = spawn(node, args, { cwd: envx.SYNC_DIR, stdio: ['ignore', 'ignore', 'inherit'], env: process.env }); } catch (_) { return next(); }
            const t = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) { /* gone */ } }, 10 * 60000);
            child.on('error', () => { clearTimeout(t); next(); });
            child.on('exit', () => { clearTimeout(t); next(); });
        };
        step(['--max-old-space-size=256', '--max-semi-space-size=4', path.join(envx.SYNC_DIR, 'rows.js'), '--dir', dir, '--only', keys.join(',')], () => {
            step(['--max-old-space-size=160', '--max-semi-space-size=4', path.join(envx.SYNC_DIR, 'rating.js'), '--dir', dir, '--min-minutes', '5'], () => {
                derivedRunning = false;
                if (derivedKeys.size && !derivedTimer) derivedTimer = setTimeout(runDerived, 1000);
            });
        });
    }

    // Snapshots that could not be written after a commit are retried every minute.
    const retrySnapshots = new Set();
    if (envx.enabled && !opts.noTimers) {
        const t = setInterval(() => {
            for (const key of [...retrySnapshots]) {
                retrySnapshots.delete(key);
                nativeApi.regenerate(key).then(() => hooks.onChanged && hooks.onChanged([key])).catch((err) => {
                    // 4xx (e.g. 409: the dataset went back to mirror mode, so the sync writes its snapshot): stop.
                    const status = err && err.status;
                    if (status >= 400 && status < 500) {
                        console.warn(`[Editor] snapshot of ${key} not retried: ${err.message}`);
                        return;
                    }
                    console.warn(`[Editor] snapshot of ${key} failed, retrying in a minute:`, err && err.message);
                    retrySnapshots.add(key);
                });
            }
        }, 60000);
        t.unref();
        const r = setTimeout(() => commits.recover().catch((err) => console.warn('[Editor] recovery check failed:', err.message)), 5000);
        r.unref();
    }

    // ---- Helpers --------------------------------------------------------------------------------
    const pbText = (v) => "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; // a PocketBase filter literal
    const wrap = (fn) => (req, res) => {
        Promise.resolve().then(() => fn(req, res)).catch((err) => sendError(res, err));
    };
    function sendError(res, err) {
        if (res.headersSent) { try { res.end(); } catch (_) { /* closed */ } return; }
        const status = err && err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
        const body = { status: 'error', message: status === 500 ? 'Something went wrong on the server: ' + String(err && err.message || err).slice(0, 300) : err.message };
        for (const k of ['conflicts', 'invalid', 'denied', 'reasons', 'info']) if (err && err[k]) body[k] = err[k];
        if (status >= 500) console.warn('[Editor]', String(err && err.stack || err).slice(0, 2000));
        res.status(status).json(body);
    }
    function clientInfo(req) {
        const ip = String(clientIp(req)).slice(0, 64); // the proxy's view, not a client-sent header
        return { ip, ua: String(req.headers['user-agent'] || '').slice(0, 200) };
    }

    // Fixed-window limits per user: reads, writes, mode switches.
    const hits = new Map();
    function limited(who, bucket, max, windowMs) {
        const k = who + '|' + bucket;
        const now = Date.now();
        let h = hits.get(k);
        if (!h || now - h.at > windowMs) { h = { at: now, n: 0 }; hits.set(k, h); }
        h.n++;
        if (hits.size > 5000) for (const [kk, v] of hits) if (now - v.at > 3600000) hits.delete(kk);
        return h.n > max;
    }

    // Dataset registry rows (sys_datasets) and collection fields, cached briefly.
    const dsCache = new Map();
    async function dataset(key, fresh) {
        if (!KEY_RE.test(String(key || ''))) throw new EditorError(404, 'No such dataset.');
        const hit = dsCache.get(key);
        if (hit && !fresh && Date.now() - hit.at < 5000) return hit.ds;
        const ds = await nativeApi.registryRow(key);
        if (!ds) throw new EditorError(404, 'No such dataset.');
        const pb = await envx.client();
        const coll = await pb.getCollection(ds.collection || 'ds_' + key);
        ds._hasOffices = !!(coll && coll.fields.some((f) => f.name === '_ccc_code'));
        ds._hasCollection = !!coll;
        dsCache.set(key, { at: Date.now(), ds });
        return ds;
    }
    const forget = (key) => dsCache.delete(key);

    async function context(req, key, need) {
        const user = req.editorUser;
        const ds = await dataset(key);
        const rights = await perms.rights(user, key, ds);
        if (!rights.can_view) throw new EditorError(user.isAdmin ? 404 : 403, 'You do not have access to this dataset.');
        if (need && !rights[need]) throw new EditorError(403, 'You do not have the right to do that here.');
        if (rights.scope && rights.scope.noOffices && need) throw new EditorError(403, 'Your access is limited to your office, and this dataset has no office columns.');
        return { ds, rights, user, scope: rights.scope, isAdmin: user.isAdmin, layout: ds.native_format || null };
    }

    function requireNative(ctx) {
        if (ctx.ds.mode !== 'native' || !ctx.layout) {
            throw new EditorError(409, 'This dataset is copied from its original (Google Sheet or Supabase). Edit it there; the next sync brings the change here.');
        }
    }

    function adminOnly(req) {
        if (!req.editorUser.isAdmin) throw new EditorError(403, 'Only an admin can do that.');
    }

    // ---- Gate: session, editor on, CSRF, limits ----------------------------------------------------
    router.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (!req.user) return res.status(401).json({ status: 'error', message: 'Please sign in.' });
        const user = permsMod.userOf(req);
        if (!user || !user.id) return res.status(403).json({ status: 'error', message: 'Your login has no email address, so no dataset can be shared with you.' });
        req.editorUser = user;
        if (!envx.enabled) return res.status(503).json({ status: 'error', message: 'The data editor runs on the VM only.' });
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            const ct = String(req.headers['content-type'] || '').toLowerCase();
            if (!ct.startsWith('application/json') || req.headers['x-mzo-editor'] !== '1') {
                return res.status(403).json({ status: 'error', message: 'Refused: editor requests must be JSON with the editor header.' });
            }
            const origin = req.headers.origin;
            if (origin) {
                let host = '';
                try { host = new URL(origin).host; } catch (_) { host = '!'; }
                if (host !== String(req.headers.host || '')) return res.status(403).json({ status: 'error', message: 'Refused: request from another site.' });
            }
            if (limited(user.id, 'write', opts.writeLimit || 40, 60000)) return res.status(429).json({ status: 'error', message: 'Too many changes in a minute; wait a little.' });
        } else if (limited(user.id, 'read', opts.readLimit || 900, 60000)) {
            return res.status(429).json({ status: 'error', message: 'Too many requests in a minute; wait a little.' });
        }
        next();
    });

    router.get('/me', wrap(async (req, res) => {
        const u = req.editorUser;
        const office = permsMod.officeOf(u.profile);
        const scope = permsMod.scopeFor(office);
        res.json({ status: 'success', user: { email: u.email, id: u.id, name: u.name, isAdmin: u.isAdmin, office: scope ? scope.label : 'Malda Zone' }, limits: { maxOps: commitMod.MAX_OPS } });
    }));

    // ---- Datasets ---------------------------------------------------------------------------------
    router.get('/datasets', wrap(async (req, res) => {
        const pb = await envx.client();
        const u = req.editorUser;
        const out = [];
        const fields = 'key,label,group,mode,row_count,column_count,last_synced_at,last_checked_at,last_status,source_type,source_url,collection,snapshot_file,native_since,native_by,schedule';
        for await (const page of pb.pages('sys_datasets', { fields: 'id,' + fields })) {
            for (const d of page) {
                if (!KEY_RE.test(String(d.key || ''))) continue;
                const rights = await perms.rights(u, d.key, d);
                if (!rights.can_view) continue;
                out.push({
                    key: d.key, label: d.label || d.key, group: d.group || 'Other', mode: d.mode === 'native' ? 'native' : 'mirror',
                    rows: d.row_count || 0, columns: d.column_count || 0, lastChange: d.last_synced_at || '', lastChecked: d.last_checked_at || '',
                    status: d.last_status || '', sourceType: d.source_type || '', sourceUrl: safeUrl(d.source_url), snapshot: !!d.snapshot_file,
                    nativeSince: d.native_since || '', nativeBy: u.isAdmin ? d.native_by || '' : '',
                    rights: { view: true, add: rights.can_add, edit: rights.can_edit, delete: rights.can_delete, scopeOnly: rights.scope_only }
                });
            }
        }
        const rank = (g) => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? 99 : i; };
        out.sort((a, b) => rank(a.group) - rank(b.group) || a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
        res.json({ status: 'success', datasets: out, groups: GROUP_ORDER });
    }));

    function safeUrl(u) {
        const s = String(u || '');
        return /^https:\/\//i.test(s) && !/[?&](key|apikey|token)=/i.test(s) ? s : '';
    }

    router.get('/datasets/:key', wrap(async (req, res) => {
        const ctx = await context(req, req.params.key);
        const ds = await dataset(req.params.key, true);
        const cols = Q.gridColumns(ds);
        const layout = ds.native_format || null;
        res.json({
            status: 'success',
            dataset: {
                key: ds.key, label: ds.label || ds.key, group: ds.group || '', mode: ds.mode === 'native' ? 'native' : 'mirror',
                rows: ds.row_count || 0, lastChange: ds.last_synced_at || '', sourceType: ds.source_type || '', sourceUrl: safeUrl(ds.source_url),
                schedule: ds.schedule || '', notes: ds.notes || '', nativeSince: ds.native_since || '', nativeBy: ctx.isAdmin ? ds.native_by || '' : '',
                primaryKey: Array.isArray(ds.primary_key) ? ds.primary_key : [], hasOffices: !!ds._hasOffices,
                columns: cols.map((c) => ({ name: c.name, label: c.source_name || c.name, type: c.type, dateOrder: c.date_order || null })),
                createdHere: !!(layout && layout.created),
                format: layout ? { ext: layout.fmt.ext, quote: layout.fmt.quote } : null
            },
            rights: { view: true, add: ctx.rights.can_add, edit: ctx.rights.can_edit, delete: ctx.rights.can_delete, scopeOnly: ctx.rights.scope_only, scope: ctx.scope ? ctx.scope.label : null, admin: ctx.isAdmin }
        });
    }));

    function listInput(req) {
        let filters = [];
        if (req.query.filters) {
            try { filters = JSON.parse(String(req.query.filters)); } catch (_) { throw new EditorError(400, 'Bad filters.'); }
            if (!Array.isArray(filters)) throw new EditorError(400, 'Bad filters.');
        }
        return { filters, q: String(req.query.q || ''), sort: String(req.query.sort || '') };
    }

    router.get('/datasets/:key/rows', wrap(async (req, res) => {
        const ctx = await context(req, req.params.key);
        if (!ctx.ds._hasCollection) return res.json({ status: 'success', total: 0, offset: 0, rows: [] });
        const cols = Q.gridColumns(ctx.ds);
        const native = ctx.ds.mode === 'native' && !!ctx.layout;
        const { filter, sort } = Q.build(cols, listInput(req), ctx.scope);
        const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
        const offset = Math.max(0, Math.floor((Number(req.query.offset) || 0) / limit) * limit);
        const pb = await envx.client();
        const r = await pb.listRecords(ctx.ds.collection || 'ds_' + ctx.ds.key, {
            page: Math.floor(offset / limit) + 1, perPage: limit, sort, filter: filter || undefined, fields: Q.fieldsFor(cols, native),
            skipTotal: req.query.total === '0' ? 1 : undefined
        });
        const width = native ? ctx.layout.width : 0;
        res.json({ status: 'success', total: r.totalItems >= 0 ? r.totalItems : null, offset, rows: (r.items || []).map((rec) => Q.toRow(rec, cols, native, width)) });
    }));

    router.get('/datasets/:key/export.csv', wrap(async (req, res) => {
        const ctx = await context(req, req.params.key);
        const cols = Q.gridColumns(ctx.ds);
        const native = ctx.ds.mode === 'native' && !!ctx.layout;
        const { filter } = Q.build(cols, listInput(req), ctx.scope);
        const pb = await envx.client();
        const coll = ctx.ds.collection || 'ds_' + ctx.ds.key;
        const fmt = { delimiter: ',', quote: 'minimal' };
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${ctx.ds.key}.csv"`);
        res.write('﻿' + F.line(cols.map((c) => c.source_name || c.name), fmt) + '\r\n');
        // Keyset paging on (_row_no, id), the sort order, so rows sharing a _row_no (mid-sync) are not skipped;
        // stop when the client goes away.
        let closed = false;
        res.once('close', () => { closed = true; });
        let last = null;
        for (let guard = 0; guard < 2000 && !closed; guard++) {
            const parts = [];
            if (filter) parts.push('(' + filter + ')');
            if (last !== null) parts.push(`(_row_no > ${last.row} || (_row_no = ${last.row} && id > ${pbText(last.id)}))`);
            const r = await pb.listRecords(coll, { page: 1, perPage: 1000, skipTotal: 1, sort: '_row_no,id', filter: parts.join(' && ') || undefined, fields: Q.fieldsFor(cols, native) });
            const items = r.items || [];
            let chunk = '';
            for (const rec of items) chunk += F.line(Q.toRow(rec, cols, native, native ? ctx.layout.width : 0).cells, fmt) + '\r\n';
            if (chunk && !res.write(chunk)) await new Promise((ok) => { res.once('drain', ok); res.once('close', ok); });
            if (items.length < 1000) break;
            const tail = items[items.length - 1];
            last = { row: Number(tail._row_no) || 0, id: String(tail.id || '') };
        }
        if (!closed) res.end();
    }));

    // ---- Writes -----------------------------------------------------------------------------------
    function needFor(ops) {
        const kinds = new Set((Array.isArray(ops) ? ops : []).map((o) => o && o.op));
        if (kinds.has('create')) return 'can_add';
        if (kinds.has('update')) return 'can_edit';
        if (kinds.has('delete')) return 'can_delete';
        return 'can_view';
    }

    router.post('/datasets/:key/preview', wrap(async (req, res) => {
        const ctx = await context(req, req.params.key, needFor(req.body && req.body.ops));
        requireNative(ctx);
        const out = await commits.preview(ctx, req.body || {});
        res.json(Object.assign({ status: 'success' }, out));
    }));

    router.post('/datasets/:key/commit', wrap(async (req, res) => {
        const ctx = await context(req, req.params.key, needFor(req.body && req.body.ops));
        requireNative(ctx);
        const kind = ['edit', 'paste', 'import', 'add', 'delete'].includes(req.body.kind) ? req.body.kind : 'edit';
        const r = await commits.commit(ctx, Object.assign({}, req.body, { kind }), { who: ctx.user.id, client: clientInfo(req) });
        forget(ctx.ds.key);
        res.status(r.status).json(Object.assign({ status: 'success' }, r.body));
    }));

    router.get('/datasets/:key/history', wrap(async (req, res) => {
        const ctx = await context(req, req.params.key);
        const pb = await envx.client();
        const page = Math.max(1, Math.min(1000, Number(req.query.page) || 1));
        const q = (v) => "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
        const r = await pb.listRecords(BATCHES, { page, perPage: 50, sort: '-created', filter: 'dataset_key=' + q(ctx.ds.key) + " && status!='rolled_back'",
            fields: 'id,kind,status,user_email,summary,counts,undo_of,undone_by,parts,created,error' });
        res.json({ status: 'success', page, totalPages: r.totalPages, batches: (r.items || []).map((b) => ({
            id: b.id, kind: b.kind, status: b.status, user: b.user_email, summary: b.summary, counts: b.counts, undoOf: b.undo_of, undoneBy: b.undone_by, at: b.created,
            canUndo: b.status === 'committed' && ['edit', 'paste', 'import', 'add', 'delete', 'commit', 'undo'].includes(b.kind) && (ctx.isAdmin || b.user_email === ctx.user.id)
        })) });
    }));

    router.get('/datasets/:key/batches/:id', wrap(async (req, res) => {
        const ctx = await context(req, req.params.key);
        const id = String(req.params.id || '');
        if (!/^[a-z0-9]{15}$/.test(id)) throw new EditorError(404, 'No such commit.');
        const pb = await envx.client();
        let b;
        try { b = await pb.getRecord(BATCHES, id); } catch (err) { if (err.status === 404) throw new EditorError(404, 'No such commit.'); throw err; }
        if (b.dataset_key !== ctx.ds.key) throw new EditorError(404, 'No such commit.');
        const res1 = await pb.listRecords(LOG, { page: 1, perPage: 500, sort: 'seq', filter: "batch_id='" + id + "'" });
        const cols = Q.gridColumns(ctx.ds);
        const width = ctx.layout ? ctx.layout.width : 0;
        const show = (rec) => (rec ? (ctx.layout ? cols.map((c) => { const s = R.cellsOf(rec, width); return s[c.index] == null ? '' : String(s[c.index]); }) : null) : null);
        const visible = (rec) => !ctx.scope || !rec || ctx.scope.match(rec);
        const changes = (res1.items || []).filter((l) => visible(l.before) && visible(l.after)).map((l) => ({
            op: l.op, row_no: l.row_no, recordId: l.record_id, before: show(l.before), after: show(l.after), at: l.at, user: l.user_email
        }));
        res.json({ status: 'success', batch: { id: b.id, kind: b.kind, status: b.status, user: b.user_email, summary: b.summary, counts: b.counts, at: b.created, undoOf: b.undo_of, undoneBy: b.undone_by, error: b.error },
            columns: cols.map((c) => c.source_name || c.name), changes, more: (res1.totalItems || 0) > 500 });
    }));

    router.post('/datasets/:key/batches/:id/undo', wrap(async (req, res) => {
        const ctx = await context(req, req.params.key);
        requireNative(ctx);
        const id = String(req.params.id || '');
        if (!/^[a-z0-9]{15}$/.test(id)) throw new EditorError(404, 'No such commit.');
        if (ctx.scope && !ctx.isAdmin) throw new EditorError(403, 'Undo is for users who can edit every row; ask an admin.');
        const r = await commits.undo(ctx, id, req.body || {}, { who: ctx.user.id, client: clientInfo(req) });
        forget(ctx.ds.key);
        res.status(r.status).json(Object.assign({ status: 'success' }, r.body));
    }));

    // ---- Mode (admins) ------------------------------------------------------------------------------
    router.get('/datasets/:key/native-check', wrap(async (req, res) => {
        adminOnly(req);
        const ds = await dataset(req.params.key, true);
        const a = await nativeApi.analyse(ds.key, { ds });
        res.json({ status: 'success', eligible: a.eligible, reasons: a.reasons, info: a.info });
    }));

    router.post('/datasets/:key/mode', wrap(async (req, res) => {
        adminOnly(req);
        const u = req.editorUser;
        const ds = await dataset(req.params.key, true);
        const want = String((req.body && req.body.mode) || '');
        if (String((req.body && req.body.confirm) || '') !== ds.key) throw new EditorError(400, 'Type the dataset key to confirm.');
        if (limited(u.id, 'mode', opts.modeLimit || 6, 3600000)) throw new EditorError(429, 'Too many mode changes in an hour.');
        const pb = await envx.client();
        let out;
        if (want === 'native') out = await nativeApi.takeOver(ds.key, u.id, { lockWaitMs: opts.lockWaitMs });
        else if (want === 'mirror') out = await nativeApi.release(ds.key, u.id);
        else throw new EditorError(400, 'Mode must be native or mirror.');
        await pb.createRecord(BATCHES, {
            dataset_key: ds.key, kind: want === 'native' ? 'takeover' : 'release', status: 'committed', user_email: u.id,
            summary: want === 'native' ? 'The VM became the source of this dataset (no more syncs from the original).' : 'Back to the original source; the next sync replaces the VM\'s rows.',
            counts: {}, client: clientInfo(req), parts: 1
        });
        forget(ds.key);
        if (opts.onChanged) opts.onChanged([ds.key]);
        res.json(Object.assign({ status: 'success', mode: want }, out));
    }));

    router.post('/datasets', wrap(async (req, res) => {
        adminOnly(req);
        const u = req.editorUser;
        if (limited(u.id, 'mode', opts.modeLimit || 6, 3600000)) throw new EditorError(429, 'Too many new datasets in an hour.');
        const b = req.body || {};
        const created = await nativeApi.createDataset({ key: b.key, label: b.label, group: b.group, columns: b.columns, primaryKey: b.primaryKey, notes: b.notes }, u.id);
        const pb = await envx.client();
        await pb.createRecord(BATCHES, { dataset_key: created.key, kind: 'create_dataset', status: 'committed', user_email: u.id, summary: `Dataset created with ${created.columns.length} columns.`, counts: {}, client: clientInfo(req), parts: 1 });
        res.json({ status: 'success', key: created.key, columns: created.columns });
    }));

    // ---- Permissions (admins) -----------------------------------------------------------------------
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    router.get('/permissions', wrap(async (req, res) => {
        adminOnly(req);
        const q = (v) => "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
        const parts = [];
        if (req.query.email) parts.push('user_email=' + q(String(req.query.email).toLowerCase()));
        if (req.query.dataset) parts.push('dataset_key=' + q(String(req.query.dataset)));
        const rows = await perms.list(parts.join(' && '));
        res.json({ status: 'success', permissions: rows.map((r) => ({ id: r.id, user_email: r.user_email, dataset_key: r.dataset_key, can_view: r.can_view, can_add: r.can_add, can_edit: r.can_edit, can_delete: r.can_delete, scope_only: r.scope_only, granted_by: r.granted_by, notes: r.notes, updated: r.updated })) });
    }));

    router.post('/permissions', wrap(async (req, res) => {
        adminOnly(req);
        const grants = Array.isArray(req.body && req.body.grants) ? req.body.grants : [];
        if (!grants.length || grants.length > 2000) throw new EditorError(400, 'Give between 1 and 2,000 grants.');
        const pb = await envx.client();
        const { recordId } = require(path.join(envx.SYNC, 'util'));
        const reqs = [];
        const seen = new Set();
        for (const g of grants) {
            const email = String(g.user_email || '').trim().toLowerCase();
            const key = String(g.dataset_key || '').trim();
            if (!EMAIL_RE.test(email) || email.length > 320) throw new EditorError(400, `Not an email address: ${email.slice(0, 80)}`);
            if (key !== '*' && !KEY_RE.test(key)) throw new EditorError(400, `Not a dataset key: ${key.slice(0, 80)}`);
            if (key !== '*' && isSensitiveKey(key)) throw new EditorError(400, `${key} holds sensitive data and stays admin-only.`);
            const id = recordId('editor-perm:' + email + '|' + key);
            if (seen.has(id)) continue;
            seen.add(id);
            const body = { user_email: email, dataset_key: key, can_view: !!g.can_view || !!g.can_add || !!g.can_edit || !!g.can_delete, can_add: !!g.can_add, can_edit: !!g.can_edit, can_delete: !!g.can_delete,
                scope_only: !!g.scope_only, granted_by: req.editorUser.id, notes: String(g.notes || '').slice(0, 2000) };
            let exists = false;
            try { await pb.getRecord(perms.PERMS, id); exists = true; } catch (err) { if (err.status !== 404) throw err; }
            reqs.push(exists ? { method: 'PATCH', url: `/api/collections/${perms.PERMS}/records/${id}`, body } : { method: 'POST', url: `/api/collections/${perms.PERMS}/records`, body: Object.assign({ id }, body) });
        }
        for (let i = 0; i < reqs.length; i += 500) await pb.batch(reqs.slice(i, i + 500));
        perms.invalidate();
        res.json({ status: 'success', saved: reqs.length });
    }));

    router.post('/permissions/revoke', wrap(async (req, res) => {
        adminOnly(req);
        const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
        if (!items.length || items.length > 2000) throw new EditorError(400, 'Nothing to remove.');
        const pb = await envx.client();
        const { recordId } = require(path.join(envx.SYNC, 'util'));
        const reqs = [];
        for (const it of items) {
            const id = recordId('editor-perm:' + String(it.user_email || '').trim().toLowerCase() + '|' + String(it.dataset_key || '').trim());
            try { await pb.getRecord(perms.PERMS, id); reqs.push({ method: 'DELETE', url: `/api/collections/${perms.PERMS}/records/${id}` }); } catch (err) { if (err.status !== 404) throw err; }
        }
        for (let i = 0; i < reqs.length; i += 500) await pb.batch(reqs.slice(i, i + 500));
        perms.invalidate();
        res.json({ status: 'success', removed: reqs.length });
    }));

    router.get('/users', wrap(async (req, res) => {
        adminOnly(req);
        const pb = await envx.client();
        const users = new Map();
        let source = 'permissions';
        try {
            if (await pb.getCollection('app_users')) {
                source = 'app_users';
                for await (const page of pb.pages('app_users', { fields: '*' })) {
                    for (const r of page) {
                        const email = String(r.email || r.user_email || '').toLowerCase();
                        if (EMAIL_RE.test(email)) users.set(email, { email, name: String(r.name || r.display_name || r.full_name || ''), role: String(r.role || ''), status: String(r.status || r.user_status || '') });
                    }
                }
            }
        } catch (_) { source = 'permissions'; }
        for (const p of await perms.list('')) if (!users.has(p.user_email)) users.set(p.user_email, { email: p.user_email, name: '', role: '', status: '' });
        res.json({ status: 'success', source, users: [...users.values()].sort((a, b) => a.email.localeCompare(b.email)) });
    }));

    router.use((req, res) => res.status(404).json({ status: 'error', message: 'Not found' }));

    app.use('/api/editor', router);
    return { envx, nativeApi, commits, perms, router };
}

module.exports = { mount };
