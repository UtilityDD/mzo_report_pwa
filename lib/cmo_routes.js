'use strict';
/**
 * lib/cmo_routes.js — the CMO grievance upload on the VM (docs/cmo-upload.md). Server only (PRIVATE_PATH).
 *
 *   GET  /api/cmo/dataset          the list the page reads when the mirror cannot serve it: the uploaded CSV, else
 *                                  the mirror's last snapshot (the Google copy before the first upload), else a
 *                                  redirect to the old published sheet (Vercel, a local checkout)
 *   GET  /api/cmo/upload/meta      { canUpload, canUndo, last: { at, by, rows, … }, versions }
 *   POST /api/cmo/upload/preview   multipart "file": parse + check, keep the result under a one-time token (15 min)
 *   POST /api/cmo/upload/commit    { token, confirmWarnings: [codes] }: replace the list
 *   POST /api/cmo/upload/undo      admins: put the previous version back
 *
 * Storage, in the app's data folder (MZO_FILES_DIR on the VM; never in git, never in a release):
 *   cmo_grievances.csv             the list (17 snapshot columns), read by vm/sync/sources/files.js
 *   cmo_grievances_meta.json       who uploaded it, when, rows, file sha256, warnings accepted
 *   cmo_versions/<stamp>.csv|.json the previous 5 lists for undo (the first upload keeps the Google copy here)
 *   cmo_upload_audit.jsonl         one line per commit or undo: who, when, rows, file sha256, warnings accepted
 * The uploaded file itself is never kept. Names, mobiles and grievance text are never logged.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CU = require('./cmo_upload');

const KEY = 'cmo_grievances';
const FILE = 'cmo_grievances.csv';
const META = 'cmo_grievances_meta.json';
const VERSIONS = 'cmo_versions';
const AUDIT = 'cmo_upload_audit.jsonl';
const KEEP_VERSIONS = 5;
const TOKEN_MS = 15 * 60 * 1000;
const MAX_TOKENS = 8;
const FLAG = 'cmo-upload-autho';
// The published Google sheet the list came from until uploads moved to the VM (Vercel still reads it).
const LEGACY_SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS7GVh5HflVhouhVfFOEN2RuA1kCBedmD4Q0CJP02K61DAtWuo3P8XIS8CO7ocZQuJ20uCJBa9qsgZ6/pub?gid=1066071765&single=true&output=csv';

const sha = (alg, data) => crypto.createHash(alg).update(data).digest('hex');
const nameOf = (u) => String((u && (u.Username || u.username)) || '').trim();
const displayOf = (u) => String((u && (u.Name || u.name)) || nameOf(u) || 'Admin').trim().slice(0, 120);

function create(deps) {
    const d = deps || {};
    const dataDir = d.dataDir;
    const log = d.log || console;
    const enabled = d.enabled !== false;
    const file = (n) => path.join(dataDir, n);
    const versionsDir = () => path.join(dataDir, VERSIONS);

    /* ---------------- files ---------------- */

    function writeAtomic(target, data) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        try {
            fs.writeFileSync(tmp, data, { mode: 0o600 });
            fs.renameSync(tmp, target);
        } catch (err) {
            try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
            throw err;
        }
    }
    function readJson(p) {
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
    }
    function snapshotFile() {
        if (!d.mirror || !d.mirror.on() || !d.mirror.dir) return '';
        const p = path.join(d.mirror.dir, KEY + '.csv');
        try { return fs.statSync(p).size > 0 ? p : ''; } catch (_) { return ''; }
    }
    function uploadedFile() {
        try { return fs.statSync(file(FILE)).size > 0 ? file(FILE) : ''; } catch (_) { return ''; }
    }
    /** The list now served: { text, version, source: 'upload' | 'snapshot', rows } or null. */
    function current() {
        const up = uploadedFile();
        const p = up || snapshotFile();
        if (!p) return null;
        const text = fs.readFileSync(p, 'utf8');
        return { text, version: sha('sha1', text), source: up ? 'upload' : 'snapshot', path: p };
    }
    function listVersions() {
        let names = [];
        try { names = fs.readdirSync(versionsDir()); } catch (_) { return []; }
        return names.filter((n) => /^\d{8}T\d{9}Z(-\d+)?\.csv$/.test(n)).sort().reverse()
            .map((n) => ({ csv: path.join(versionsDir(), n), json: path.join(versionsDir(), n.replace(/\.csv$/, '.json')) }));
    }
    function stamp() {
        const base = new Date().toISOString().replace(/[-:.]/g, ''); // 20261108T043015123Z
        let s = base;
        for (let i = 1; fs.existsSync(path.join(versionsDir(), s + '.csv')); i++) s = `${base}-${i}`;
        return s;
    }
    /** Keep the list now served as a version (the Google copy, before the first upload), then prune to KEEP_VERSIONS. */
    function archiveCurrent(cur) {
        if (!cur) return;
        const s = stamp();
        const meta = cur.source === 'upload'
            ? (readJson(file(META)) || {})
            : { action: 'google', by: 'google-sheet', byName: 'Google sheet (before uploads)', at: fs.statSync(cur.path).mtime.toISOString() };
        meta.rows = meta.rows != null ? meta.rows : CU.readSnapshotRows(cur.text).length;
        meta.version = cur.version;
        writeAtomic(path.join(versionsDir(), s + '.csv'), cur.text);
        writeAtomic(path.join(versionsDir(), s + '.json'), JSON.stringify(meta, null, 1));
        for (const v of listVersions().slice(KEEP_VERSIONS)) {
            try { fs.unlinkSync(v.csv); } catch (_) { /* gone */ }
            try { fs.unlinkSync(v.json); } catch (_) { /* gone */ }
        }
    }
    function audit(entry) {
        const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n';
        fs.mkdirSync(dataDir, { recursive: true });
        fs.appendFileSync(file(AUDIT), line, { mode: 0o600 });
    }

    /* ---------------- who may ---------------- */

    async function access(req, force) {
        if (!req.user) return { user: null, admin: false, upload: false };
        const user = (await d.resolveFreshUser(req, !!force)) || req.user;
        const admin = d.isPortalAdmin(user) && (await d.stillAdmin(req));
        const flag = d.flagYes(user[FLAG] != null ? user[FLAG] : user.cmo_upload_autho);
        return { user, admin, upload: admin || flag };
    }

    /* ---------------- one-time preview tokens and the lock ---------------- */

    const tokens = new Map(); // token -> { by, exp, csv, … }
    function pruneTokens() {
        const now = Date.now();
        for (const [t, v] of tokens) if (v.exp <= now) tokens.delete(t);
        while (tokens.size > MAX_TOKENS) tokens.delete(tokens.keys().next().value);
    }
    let busy = '';
    function lock(what) {
        if (busy) return false;
        busy = what;
        return true;
    }
    const unlock = () => { busy = ''; };
    const BUSY_MSG = 'Another CMO upload is being processed. Please try again in a minute.';

    function lastOf(meta) {
        if (!meta) return null;
        return {
            at: meta.at || null, by: meta.byName || meta.by || '', username: meta.by || '', rows: meta.rows || 0,
            pendingMzo: meta.pendingMzo != null ? meta.pendingMzo : null, reportDate: meta.reportDate || '', action: meta.action || 'upload'
        };
    }

    /* ---------------- routes ---------------- */

    function mount(app) {
        const json401 = (res) => res.status(401).json({ status: 'error', message: 'Unauthorized. Please sign in to DISHA.' });
        const off = (res) => res.status(404).json({ status: 'error', message: 'CMO uploads are made on the DISHA server, not here.' });
        const upload = d.multer({
            storage: d.multer.memoryStorage(),
            limits: { fileSize: CU.LIMITS.maxBytes, files: 1, fields: 4, parts: 5 }
        });

        app.get('/api/cmo/dataset', async (req, res) => {
            if (!req.user) return json401(res);
            res.setHeader('Cache-Control', 'private, no-cache');
            const up = uploadedFile();
            if (up && (await d.sendDataFile(req, res, up, 'text/csv; charset=utf-8'))) return;
            const snap = snapshotFile();
            if (snap && (await d.sendDataFile(req, res, snap, 'text/csv; charset=utf-8'))) return;
            res.removeHeader('Cache-Control');
            return res.redirect(302, LEGACY_SHEET_URL);
        });

        app.get('/api/cmo/upload/meta', async (req, res) => {
            if (!req.user) return json401(res);
            res.setHeader('Cache-Control', 'private, no-store');
            const a = await access(req, false);
            const versions = enabled ? listVersions().length : 0;
            const up = enabled && uploadedFile();
            return res.json({
                status: 'success',
                enabled,
                canUpload: enabled && a.upload,
                canUndo: enabled && a.admin && versions > 0,
                isAdmin: a.admin,
                source: up ? 'upload' : (snapshotFile() ? 'snapshot' : 'google'),
                last: up ? lastOf(readJson(file(META))) : null,
                versions,
                limits: { maxBytes: CU.LIMITS.maxBytes, maxRows: CU.LIMITS.maxRows }
            });
        });

        app.post('/api/cmo/upload/preview', (req, res) => {
            if (!req.user) return json401(res);
            if (!enabled) return off(res);
            if (!lock('preview')) return res.status(429).json({ status: 'error', message: BUSY_MSG });
            let released = false;
            const release = () => { if (!released) { released = true; unlock(); } };
            res.on('close', release);
            upload.single('file')(req, res, async (err) => {
                try {
                    if (err) {
                        const tooBig = err.code === 'LIMIT_FILE_SIZE';
                        return res.status(tooBig ? 413 : 400).json({ status: 'blocked', blocks: [tooBig
                            ? { code: 'too_large', message: `The file is larger than ${CU.LIMITS.maxBytes / 1024 / 1024} MB. The CMO export is usually well under 1 MB; check that you picked the right file.` }
                            : { code: 'unreadable', message: 'The upload could not be read. Pick the file again and retry.' }] });
                    }
                    const a = await access(req, true);
                    if (!a.upload) return res.status(403).json({ status: 'error', message: 'You are not allowed to upload the CMO grievance list. Ask an admin.' });
                    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
                        return res.status(400).json({ status: 'blocked', blocks: [{ code: 'no_file', message: 'No file was received. Choose the .xlsx or .csv export and try again.' }] });
                    }
                    const fileSha256 = sha('sha256', req.file.buffer);
                    const fileBytes = req.file.buffer.length;
                    let parsed;
                    try {
                        parsed = await CU.parseExportIsolated(req.file.buffer, req.file.originalname, { timeoutMs: 60000, maxMemoryMb: 256, now: Date.now() });
                    } catch (parseErr) {
                        return res.status(422).json({ status: 'blocked', blocks: [{ code: 'unreadable', message: parseErr.message }] });
                    } finally {
                        req.file.buffer = null;
                    }
                    const cur = current();
                    const rv = CU.review(parsed, cur ? CU.readSnapshotRows(cur.text) : null);
                    if (rv.blocks.length) return res.status(422).json({ status: 'blocked', blocks: rv.blocks });
                    pruneTokens();
                    const token = crypto.randomBytes(24).toString('base64url');
                    const exp = Date.now() + TOKEN_MS;
                    tokens.set(token, {
                        by: nameOf(a.user).toLowerCase(), exp, csv: CU.toCsv(parsed.header, parsed.rows), rows: parsed.rows.length,
                        pendingMzo: rv.summary.pendingMzo, reportDate: rv.summary.reportDate, titleDate: rv.summary.titleDate,
                        warnings: rv.warnings.map((w) => w.code), fileSha256, fileBytes, baseVersion: cur ? cur.version : ''
                    });
                    pruneTokens();
                    return res.json({
                        status: 'ok', token, expiresAt: new Date(exp).toISOString(),
                        summary: rv.summary, diff: rv.diff, warnings: rv.warnings, notes: rv.notes,
                        current: cur ? { source: cur.source, rows: rv.diff ? rv.diff.currentRows : null } : null
                    });
                } catch (e) {
                    log.error('[CMO upload] preview failed:', e && e.message);
                    if (!res.headersSent) return res.status(500).json({ status: 'error', message: 'The file could not be checked. Please try again.' });
                } finally {
                    release();
                }
            });
        });

        app.post('/api/cmo/upload/commit', async (req, res) => {
            if (!req.user) return json401(res);
            if (!enabled) return off(res);
            const body = req.body || {};
            const a = await access(req, true);
            if (!a.upload) return res.status(403).json({ status: 'error', message: 'You are not allowed to upload the CMO grievance list. Ask an admin.' });
            pruneTokens();
            const token = typeof body.token === 'string' ? body.token : '';
            const held = token && tokens.get(token);
            if (!held) return res.status(410).json({ status: 'error', message: 'This preview has expired or was already used. Choose the file again.' });
            if (held.by !== nameOf(a.user).toLowerCase()) return res.status(403).json({ status: 'error', message: 'This preview was made by another user.' });
            const given = new Set(Array.isArray(body.confirmWarnings) ? body.confirmWarnings.map(String) : []);
            const missing = held.warnings.filter((c) => !given.has(c));
            if (missing.length) return res.status(409).json({ status: 'confirm', message: 'Tick every warning to confirm you have checked it.', missing });
            if (!lock('commit')) return res.status(429).json({ status: 'error', message: BUSY_MSG });
            try {
                const cur = current();
                if ((cur ? cur.version : '') !== held.baseVersion) {
                    tokens.delete(token);
                    return res.status(409).json({ status: 'error', message: 'The CMO list changed after this preview (another upload or an undo). Choose the file again to see the new comparison.' });
                }
                tokens.delete(token);
                archiveCurrent(cur);
                const csvSha1 = sha('sha1', held.csv);
                const meta = {
                    version: csvSha1, at: new Date().toISOString(), by: nameOf(a.user), byName: displayOf(a.user), action: 'upload',
                    rows: held.rows, pendingMzo: held.pendingMzo, reportDate: held.reportDate, titleDate: held.titleDate,
                    fileSha256: held.fileSha256, fileBytes: held.fileBytes, warningsAccepted: held.warnings
                };
                writeAtomic(file(FILE), held.csv);
                writeAtomic(file(META), JSON.stringify(meta, null, 1));
                audit({ action: 'upload', by: meta.by, byName: meta.byName, rows: meta.rows, pendingMzo: meta.pendingMzo, fileSha256: meta.fileSha256, csvSha1, warningsAccepted: meta.warningsAccepted, replaced: cur ? cur.source : 'none' });
                log.log(`[CMO upload] ${meta.by} replaced the list: ${meta.rows} rows (${meta.pendingMzo} pending with MZO)`);
                d.refreshMirror([KEY], `cmo upload by ${meta.by}`, { now: true });
                Promise.resolve(d.logActivity({ username: meta.by, name: meta.byName, type: 'report_sync', details: `Uploaded CMO grievances: ${meta.rows} rows (${meta.pendingMzo} pending with MZO officers)` })).catch(() => {});
                return res.json({ status: 'success', message: `Uploaded ${meta.rows.toLocaleString('en-IN')} CMO grievances (${meta.pendingMzo} pending with MZO officers).`, last: lastOf(meta) });
            } catch (e) {
                log.error('[CMO upload] commit failed:', e && e.message);
                return res.status(500).json({ status: 'error', message: 'The list could not be saved. Nothing was changed; please try again.' });
            } finally {
                unlock();
            }
        });

        app.post('/api/cmo/upload/undo', async (req, res) => {
            if (!req.user) return json401(res);
            if (!enabled) return off(res);
            const a = await access(req, true);
            if (!a.admin) return res.status(403).json({ status: 'error', message: 'Only an admin can undo a CMO upload.' });
            if (!lock('undo')) return res.status(429).json({ status: 'error', message: BUSY_MSG });
            try {
                const v = listVersions()[0];
                if (!v) return res.status(409).json({ status: 'error', message: 'There is no earlier version to go back to.' });
                const text = fs.readFileSync(v.csv, 'utf8');
                const was = readJson(v.json) || {};
                const rows = CU.readSnapshotRows(text);
                const pendingMzo = rows.filter((r) => r.pendingWith && r.pendingWith !== CU.DISPOSED).length;
                const meta = {
                    version: sha('sha1', text), at: new Date().toISOString(), by: nameOf(a.user), byName: displayOf(a.user), action: 'undo',
                    rows: rows.length, pendingMzo, reportDate: was.reportDate || '', restored: { at: was.at || null, by: was.byName || was.by || '', action: was.action || 'upload' }
                };
                writeAtomic(file(FILE), text);
                writeAtomic(file(META), JSON.stringify(meta, null, 1));
                fs.unlinkSync(v.csv);
                try { fs.unlinkSync(v.json); } catch (_) { /* no meta */ }
                audit({ action: 'undo', by: meta.by, byName: meta.byName, rows: meta.rows, pendingMzo, csvSha1: meta.version, restored: meta.restored });
                log.log(`[CMO upload] ${meta.by} undid the last upload: back to ${meta.rows} rows`);
                d.refreshMirror([KEY], `cmo undo by ${meta.by}`, { now: true });
                Promise.resolve(d.logActivity({ username: meta.by, name: meta.byName, type: 'report_sync', details: `Undid the last CMO grievances upload: back to ${meta.rows} rows` })).catch(() => {});
                return res.json({ status: 'success', message: `Restored the earlier list (${meta.rows.toLocaleString('en-IN')} grievances).`, last: lastOf(meta), versions: listVersions().length });
            } catch (e) {
                log.error('[CMO upload] undo failed:', e && e.message);
                return res.status(500).json({ status: 'error', message: 'The earlier list could not be restored.' });
            } finally {
                unlock();
            }
        });
    }

    return { mount, current, listVersions, _tokens: tokens };
}

module.exports = { create, KEY, FILE, META, VERSIONS, AUDIT, KEEP_VERSIONS, LEGACY_SHEET_URL };
