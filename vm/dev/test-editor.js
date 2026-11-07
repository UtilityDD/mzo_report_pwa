#!/usr/bin/env node
/* The data editor (lib/editor, editor/, docs/data-editor.md) against a local PocketBase (never the VM):
 *
 *   node vm/dev/test-editor.js            starts its own throwaway PocketBase (vm/dev/lib/local-pb.js:
 *                                         temp --dir, a copy of the migrations, --automigrate=false)
 *   node vm/dev/test-editor.js --env <file with PB_URL, PB_SUPERUSER_EMAIL, PB_SUPERUSER_PASSWORD>
 *                                         a PocketBase you started (local only). Start it with
 *                                         --automigrate=false and a copy of the migrations, or the
 *                                         collections this test creates become migration files.
 *
 * No network: the datasets come from fixture sources (zz_editor_pk keyed by APPL_NO with office
 * columns, zz_editor_nopk keyed by content), synced into PocketBase by the sync's own code. The
 * editor runs in this process on an Express app (a test header stands in for the session cookie),
 * and server.js itself is started once to check the mount, the sign-in gate and CSRF.
 *
 * Covers: the clipboard parser and the snapshot format on tricky inputs; native check and take-over
 * (snapshot byte-identical, manifest entry); the sync skipping a native dataset (run.js --only) and
 * writeManifest keeping native entries; permissions (view, add, edit, delete, scope_only, sensitive);
 * a paste commit (adds + edits) and record parity with the sync; all-or-nothing on a bad batch (a
 * type error, a failure in the only part, a failure in a later part with rollback, a crash and the
 * recovery); conflicts; idempotent retries (also after a lost answer); undo and its conflicts;
 * snapshot regeneration parity; a new dataset; back to mirror; CSRF. Removes what it created. Exit 1 on failure.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const http = require('http');
const assert = require('assert/strict');
const { Readable } = require('stream');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SYNC_DIR = path.join(ROOT, 'vm', 'sync');
const SYNC = path.join(SYNC_DIR, 'lib');
const express = require(path.join(ROOT, 'node_modules', 'express'));
const { parse: csvParse } = require(path.join(SYNC_DIR, 'node_modules', 'csv-parse'));
const Clip = require(path.join(ROOT, 'editor', 'clipboard.js'));
const F = require(path.join(ROOT, 'lib', 'editor', 'format.js'));
const envMod = require(path.join(ROOT, 'lib', 'editor', 'env.js'));
const editor = require(path.join(ROOT, 'lib', 'editor', 'index.js'));
const { PocketBase } = require(path.join(SYNC, 'pb'));
const { Registry } = require(path.join(SYNC, 'registry'));
const { syncSource } = require(path.join(SYNC, 'sync'));
const snapshot = require(path.join(SYNC, 'snapshot'));
const localPb = require('./lib/local-pb');

const KEY = 'zz_editor_pk';
const KEY2 = 'zz_editor_nopk';
const NEWKEY = 'zz_editor_new';
const ADMIN = { email: 'zz-admin@example.com', role: 'admin', Username: 'zzadmin', Name: 'Test admin' };
const VIEWER = (extra) => Object.assign({ email: 'zz-user@example.com', role: 'viewer', Username: 'zzuser', Name: 'Test user' }, extra || {});

let passed = 0;
const fails = [];
async function t(name, fn) {
    try {
        await fn();
        passed++;
        console.log('ok   ' + name);
    } catch (err) {
        fails.push(name);
        console.log('FAIL ' + name + '\n     ' + String(err && err.stack || err).split('\n').slice(0, 6).join('\n     '));
    }
}

function readEnv(file) {
    const out = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

// ---- Fixtures: Google-style CSV (CRLF, quotes only where needed, no final line ending) ----
const HEADER = ['APPL_NO', 'CCC CODE', 'CCC NAME', 'AMOUNT', 'APPLIED ON', 'REMARKS', 'DONE'];
function fixtureRows() {
    const rows = [];
    for (let i = 1; i <= 40; i++) {
        const malda = i % 2 === 1;
        rows.push([
            'A' + String(i).padStart(3, '0'),
            malda ? '6611101' : '6621101',
            malda ? 'Manikchak' : 'Itahar',
            i % 9 === 0 ? '' : (1000 + i * 37).toLocaleString('en-IN') + '.50',
            String((i % 27) + 1).padStart(2, '0') + '/10/2026',
            i === 3 ? 'has, a comma' : i === 4 ? 'says "hello"' : i === 5 ? 'two\nlines' : i % 5 === 0 ? '' : 'note ' + i,
            i % 3 ? 'Y' : 'N'
        ]);
    }
    return rows;
}
const FMT = { delimiter: ',', quote: 'minimal', eol: '\r\n', trailingEol: false, bom: false };
const TEXT1 = F.serialize([HEADER].concat(fixtureRows()), FMT);
const TEXT2 = F.serialize([['Feeder', 'Hours', 'Remark']].concat([['F1', '2', 'ok'], ['F2', '3.5', ''], ['F3', '1', 'trip'], ['F1', '2', 'ok']]), FMT);

function fixtureSource(key, text, pk) {
    return {
        key, label: 'Editor test ' + key, group: 'Important', pages: [], sourceType: 'google_sheet', sourceRef: { test: true },
        sourceUrl: 'https://docs.google.com/spreadsheets/d/test-' + key + '/edit', schedule: 'hourly', primaryKey: pk, rawExt: 'csv',
        dataHubKeys: ['CACHE_' + key.toUpperCase()], urls: ['https://docs.google.com/test/' + key + '.csv'],
        async raw() { return { contentType: 'text/csv', stream: Readable.from([Buffer.from(fixtureText[key], 'utf8')]) }; },
        async *rows(ctx) {
            const parser = csvParse({ delimiter: ',', quote: '"', relax_quotes: true, relax_column_count: true, bom: true, skip_empty_lines: false });
            const input = ctx.input || Readable.from([Buffer.from(fixtureText[key], 'utf8')]);
            input.pipe(parser);
            for await (const r of parser) yield r;
        }
    };
}
const fixtureText = { [KEY]: TEXT1, [KEY2]: TEXT2 };
const SOURCES = { [KEY]: fixtureSource(KEY, TEXT1, ['APPL_NO']), [KEY2]: fixtureSource(KEY2, TEXT2, null) };

// ---- Unit tests (no PocketBase) ----
async function unitTests() {
    await t('clipboard: Sheets TSV with quoted tabs, newlines, quotes and a trailing line ending', () => {
        const text = 'a\t"b\tc"\t"line1\nline2"\r\n"say ""hi"""\t\tx\r\n';
        assert.deepEqual(Clip.parseTsv(text), [['a', 'b\tc', 'line1\nline2'], ['say "hi"', '', 'x']]);
    });
    await t('clipboard: a stray quote is text; trailing empty lines are no rows; CR-only line ends', () => {
        assert.deepEqual(Clip.parseTsv('5" pipe\tok\n"open\tend\n\n\n'), [['5" pipe', 'ok'], ['"open', 'end']]);
        assert.deepEqual(Clip.parseTsv('a\tb\rc\td'), [['a', 'b'], ['c', 'd']]);
        assert.deepEqual(Clip.parseTsv('only'), [['only']]);
        assert.deepEqual(Clip.parseTsv(''), []);
        assert.deepEqual(Clip.parseTsv('\t\n'), [['', '']]);
        assert.deepEqual(Clip.parseTsv('a\t\n\tb\n'), [['a', ''], ['', 'b']]);
    });
    await t('clipboard: Excel HTML fallback (entities, <br>, colspan, nested tags)', () => {
        const html = '<html><body><table><tr><td>A &amp; B</td><td colspan="2"><b>x</b></td><td>1<br>2</td></tr>\n<tr><th>&lt;tag&gt;</th><td>&#8377;5</td><td></td><td>&nbsp;y</td></tr></table></body></html>';
        assert.deepEqual(Clip.parseHtml(html), [['A & B', 'x', '', '1\n2'], ['<tag>', '₹5', '', ' y']]);
        assert.deepEqual(Clip.parseHtml('<p>no table</p>'), []);
    });
    await t('clipboard: CSV file parsing with BOM, quoted commas and CRLF', () => {
        assert.deepEqual(Clip.parseDelimited('﻿A,B\r\n"1,5","x ""y"""\r\n', ','), [['A', 'B'], ['1,5', 'x "y"']]);
    });
    await t('clipboard: header detection maps columns by name', () => {
        const cols = [{ name: 'appl_no', label: 'APPL_NO' }, { name: 'amount', label: 'AMOUNT' }, { name: 'ccc_name', label: 'CCC NAME' }];
        const m = Clip.headerMatch(['Amount', 'appl no', 'Extra'], cols);
        assert.equal(m.isHeader, true);
        assert.deepEqual(m.map, [1, 0, -1]);
        assert.deepEqual(m.unknown, ['Extra']);
        assert.equal(Clip.headerMatch(['A001', '12', 'x'], cols).isHeader, false);
    });
    await t('filters: a date-time column\'s day is an India day; a date column\'s is UTC midnight', () => {
        const Q = require(path.join(__dirname, '..', '..', 'lib', 'editor', 'query.js'));
        assert.equal(Q.clause({ op: 'on', value: '2026-11-05' }, { name: 'd', type: 'date', has_time: true }), "(d >= '2026-11-04 18:30:00.000Z' && d < '2026-11-05 18:30:00.000Z')");
        assert.equal(Q.clause({ op: 'on', value: '2026-11-05' }, { name: 'd', type: 'date' }), "(d >= '2026-11-05 00:00:00.000Z' && d < '2026-11-06 00:00:00.000Z')");
        assert.equal(Q.clause({ op: 'after', value: '2026-11-05' }, { name: 'd', type: 'date', has_time: true }), "d >= '2026-11-04 18:30:00.000Z'");
    });
    await t('format: Google pub CSV, gviz CSV, TSV, BOM and final line endings round-trip byte for byte', () => {
        const cases = [
            [TEXT1, 'csv', 'minimal'],
            ['"A","B"\n"1","x, y"\n"",""', 'csv', 'all'],
            ['A\tB\r\n1\t"q"\r\n', 'tsv', 'none'],
            ['﻿A,B\n1,2\n', 'csv', 'minimal'],
            ['A,B\r\n,\r\n1,2', 'csv', 'minimal']
        ];
        for (const [text, ext, quote] of cases) {
            const r = F.roundTrip(text, ext);
            assert.equal(r.identical, true, JSON.stringify(text));
            assert.equal(r.fmt.quote, quote);
        }
        assert.equal(F.roundTrip('A,B\r\n,\r\n1,2', 'csv').blankRowsDropped, 1);
    });
}

// ---- PocketBase tests ----
async function main() {
    const i = process.argv.indexOf('--env');
    let own = null;
    let env;
    if (i > 0) {
        env = readEnv(process.argv[i + 1]);
        localPb.assertLocal(env.PB_URL);
    } else {
        own = await localPb.start();
        env = { PB_URL: own.url, PB_SUPERUSER_EMAIL: own.email, PB_SUPERUSER_PASSWORD: own.password };
    }
    try {
        await testAll(env);
    } finally {
        if (own) await own.stop();
    }
}

let structureExisted = true; // ds_structure was there before this run (then it is left alone)

async function testAll(env) {
    await unitTests();

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-editor-test-'));
    const snapDir = path.join(tmp, 'snapshots');
    const tmpDir = path.join(tmp, 'sync-tmp');
    fs.mkdirSync(snapDir, { recursive: true });
    const testEnv = Object.assign({}, env, { MZO_SNAPSHOT_DIR: snapDir, SYNC_TMP_DIR: tmpDir });
    const pb = new PocketBase({ url: env.PB_URL, email: env.PB_SUPERUSER_EMAIL, password: env.PB_SUPERUSER_PASSWORD });
    await pb.auth();
    for (const c of ['app_dataset_permissions', 'app_edit_batches', 'app_edit_log']) {
        if (!(await pb.getCollection(c))) throw new Error(`${c} is missing: start PocketBase with --migrationsDir <a copy of vm/pocketbase/pb_migrations> --automigrate=false`);
    }
    structureExisted = !!(await pb.getCollection('ds_structure'));
    await cleanup(pb);

    // The fixtures, synced by the sync's own code (snapshot + rows + registry).
    const registry = new Registry(pb);
    await registry.load();
    for (const key of [KEY, KEY2]) {
        const r = await syncSource(SOURCES[key], { pb, registry, tmpDir, batchSize: 500, snapshotDir: snapDir, fullCheck: true,
            onSnapshot: () => snapshot.writeManifest(snapDir, Object.values(SOURCES), registry) });
        assert.equal(r.status, 'ok', r.message);
    }
    snapshot.writeManifest(snapDir, Object.values(SOURCES), registry);

    // The editor in this process, with fault injection on PocketBase batches.
    const faults = { failBatchAt: 0, lostAnswerAt: 0, calls: 0, failRollback: false };
    const base = envMod.create(testEnv);
    const envx = Object.assign({}, base, {
        source: async (key) => SOURCES[key] || base.source(key),
        client: async () => {
            const c = await base.client();
            if (!c.__wrapped) {
                const orig = c.batch.bind(c);
                c.batch = async (reqs) => {
                    faults.calls++;
                    if (faults.failBatchAt && faults.calls === faults.failBatchAt) {
                        const { PbError } = require(path.join(SYNC, 'pb'));
                        throw new PbError(400, { message: 'injected failure', data: { requests: { 0: { response: { message: 'injected failure' } } } } }, 'PocketBase POST /api/batch');
                    }
                    if (faults.failRollback && reqs.some((r) => r.method === 'DELETE' && /app_edit_log/.test(r.url))) throw new Error('injected crash during rollback');
                    const out = await orig(reqs);
                    if (faults.lostAnswerAt && faults.calls === faults.lostAnswerAt) throw new TypeError('fetch failed (injected lost answer)');
                    return out;
                };
                c.__wrapped = true;
            }
            return c;
        }
    });
    const refreshed = [];
    const changed = [];
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use((req, res, next) => { const u = req.headers['x-test-user']; if (u) req.user = JSON.parse(u); next(); });
    const mounted = editor.mount(app, { envx, noTimers: true, noDerived: true, chunk: 12, staleMs: 0, writeLimit: 10000, readLimit: 100000, modeLimit: 100,
        refreshMirror: (keys) => refreshed.push(...keys), onChanged: (keys) => changed.push(...keys) });
    const server = http.createServer(app);
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const port = server.address().port;

    async function call(user, method, p, body, headers) {
        const h = Object.assign({ Accept: 'application/json' }, user ? { 'x-test-user': JSON.stringify(user) } : {});
        if (method !== 'GET') Object.assign(h, { 'Content-Type': 'application/json', 'X-MZO-Editor': '1' });
        Object.assign(h, headers || {});
        const res = await fetch(`http://127.0.0.1:${port}/api/editor${p}`, { method, headers: h, body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body || {})) });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = text; }
        return { status: res.status, body: json };
    }
    const rowsOf = async (user, key, qs) => (await call(user, 'GET', `/datasets/${key}/rows?limit=500${qs || ''}`)).body;
    const idem = () => crypto.randomBytes(12).toString('hex');
    const sha = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
    const snapFile = (key) => path.join(snapDir, key + '.csv');
    const manifest = () => JSON.parse(fs.readFileSync(path.join(snapDir, 'manifest.json'), 'utf8'));

    try {
        await t('native check: the fixture is eligible and its cells give the sync\'s records', async () => {
            const r = await call(ADMIN, 'GET', `/datasets/${KEY}/native-check`);
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.equal(r.body.eligible, true, JSON.stringify(r.body.reasons));
            assert.equal(r.body.info.compared, 40);
            assert.equal(r.body.info.parity.identical, true);
        });

        await t('mirror datasets are read-only: commits refused with a clear message', async () => {
            const r = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'create', cells: { appl_no: 'X1' } }] });
            assert.equal(r.status, 409);
            assert.match(r.body.message, /Edit it there/);
        });

        const before1 = sha(snapFile(KEY));
        await t('mode switch: take-over needs the typed key, then makes the dataset native with a byte-identical snapshot', async () => {
            let r = await call(ADMIN, 'POST', `/datasets/${KEY}/mode`, { mode: 'native', confirm: 'nope' });
            assert.equal(r.status, 400);
            r = await call(VIEWER(), 'POST', `/datasets/${KEY}/mode`, { mode: 'native', confirm: KEY });
            assert.equal(r.status, 403);
            r = await call(ADMIN, 'POST', `/datasets/${KEY}/mode`, { mode: 'native', confirm: KEY });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            const ds = await pb.getRecord('sys_datasets', Registry.idFor(KEY));
            assert.equal(ds.mode, 'native');
            assert.equal(ds.native_by, ADMIN.email);
            assert.ok(ds.native_since);
            assert.equal(sha(snapFile(KEY)), before1);
            assert.equal(manifest().datasets[KEY].version, before1);
            const hist = await call(ADMIN, 'GET', `/datasets/${KEY}/history`);
            assert.equal(hist.body.batches[0].kind, 'takeover');
            const r2 = await call(ADMIN, 'POST', `/datasets/${KEY2}/mode`, { mode: 'native', confirm: KEY2 });
            assert.equal(r2.status, 200, JSON.stringify(r2.body));
        });

        await t('sync: run.js --only skips a native dataset, logs it and leaves its registry row alone', async () => {
            // `structure` (a repo file, no network): synced normally first, then made native.
            const envFile = path.join(tmp, 'pb.env');
            fs.writeFileSync(envFile, `PB_URL=${env.PB_URL}\nPB_SUPERUSER_EMAIL=${env.PB_SUPERUSER_EMAIL}\nPB_SUPERUSER_PASSWORD=${env.PB_SUPERUSER_PASSWORD}\n`);
            const run = () => spawnSync(process.execPath, ['--env-file=' + envFile, path.join(SYNC_DIR, 'run.js'), '--only', 'structure', '--reason', 'editor test'],
                { cwd: SYNC_DIR, env: Object.assign({}, process.env, { MZO_SNAPSHOT_DIR: path.join(tmp, 'snap-structure'), SYNC_TMP_DIR: tmpDir }), encoding: 'utf8', timeout: 120000 });
            const r1 = run();
            assert.match(r1.stdout, /(ok|unchanged)\s+structure/, r1.stdout + r1.stderr);
            const runsBefore = (await pb.listRecords('sys_sync_runs', { filter: "dataset='structure'", perPage: 1 })).totalItems;
            const regBefore = await pb.getRecord('sys_datasets', Registry.idFor('structure'));
            await pb.updateRecord('sys_datasets', Registry.idFor('structure'), { mode: 'native' });
            const r2 = run();
            assert.match(r2.stdout, /native\s+structure\s+skipped/, r2.stdout);
            assert.match(r2.stdout, /1 native \(skipped\)/);
            const runsAfter = (await pb.listRecords('sys_sync_runs', { filter: "dataset='structure'", perPage: 1 })).totalItems;
            assert.equal(runsAfter, runsBefore);
            const regAfter = await pb.getRecord('sys_datasets', Registry.idFor('structure'));
            assert.equal(regAfter.last_checked_at, regBefore.last_checked_at);
        });

        await t('sync: writeManifest keeps the editor\'s entry for native datasets and lists editor-made ones', async () => {
            const dir = path.join(tmp, 'man');
            fs.mkdirSync(dir);
            fs.writeFileSync(path.join(dir, 'a.csv'), 'x');
            fs.writeFileSync(path.join(dir, 'n.csv'), 'y');
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ datasets: { a: { version: 'EDITOR', file: 'a.csv' }, n: { version: 'NEW', file: 'n.csv' } } }));
            const reg = { byKey: new Map([['a', { mode: 'native', snapshot_file: 'a.csv', snapshot_sha1: 'STALE' }], ['n', { mode: 'native', snapshot_file: 'n.csv' }], ['m', { mode: '', snapshot_file: 'a.csv', snapshot_sha1: 'S' }]]) };
            reg.get = (k) => reg.byKey.get(k);
            const m = snapshot.writeManifest(dir, [{ key: 'a' }, { key: 'm' }], reg);
            assert.equal(m.datasets.a.version, 'EDITOR');
            assert.equal(m.datasets.n.version, 'NEW');
            assert.equal(m.datasets.m.version, 'S');
        });

        // Permissions
        const grant = (key, rights, extra) => call(ADMIN, 'POST', '/permissions', { grants: [Object.assign({ user_email: VIEWER().email, dataset_key: key }, rights, extra || {})] });
        const revokeAll = async () => {
            const list = await call(ADMIN, 'GET', '/permissions?email=' + encodeURIComponent(VIEWER().email));
            if (list.body.permissions.length) await call(ADMIN, 'POST', '/permissions/revoke', { items: list.body.permissions.map((p) => ({ user_email: p.user_email, dataset_key: p.dataset_key })) });
        };
        let rows = (await rowsOf(ADMIN, KEY)).rows;
        const byAppl = (list, appl) => list.find((r) => r.cells[0] === appl);

        await t('export: the CSV has every row the grid has (keyset paging on _row_no and id)', async () => {
            const res = await fetch(`http://127.0.0.1:${port}/api/editor/datasets/${KEY}/export.csv`, { headers: { 'x-test-user': JSON.stringify(ADMIN) } });
            assert.equal(res.status, 200);
            const lines = (await res.text()).replace(/^﻿/, '').split('\r\n').filter(Boolean);
            assert.equal(lines.length - 1, rows.length);
        });

        await t('permissions: no row → no access; can_view → read but no writes', async () => {
            let r = await call(VIEWER(), 'GET', `/datasets/${KEY}/rows`);
            assert.equal(r.status, 403);
            assert.equal((await call(VIEWER(), 'GET', '/datasets')).body.datasets.length, 0);
            assert.equal((await grant(KEY, { can_view: true })).status, 200);
            r = await call(VIEWER(), 'GET', `/datasets/${KEY}/rows`);
            assert.equal(r.status, 200);
            const row = rows[0];
            for (const op of [{ op: 'create', cells: { appl_no: 'V1' } }, { op: 'update', id: row.id, hash: row.hash, cells: { remarks: 'v' } }, { op: 'delete', id: row.id, hash: row.hash }]) {
                r = await call(VIEWER(), 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [op] });
                assert.equal(r.status, 403, op.op);
            }
            r = await call(VIEWER(), 'GET', '/permissions');
            assert.equal(r.status, 403);
        });

        await t('permissions: can_add allows only new rows; can_edit only changes; can_delete only deletes', async () => {
            await grant(KEY, { can_add: true });
            const row = rows[1];
            let r = await call(VIEWER(), 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'update', id: row.id, hash: row.hash, cells: { remarks: 'x' } }] });
            assert.equal(r.status, 403);
            r = await call(VIEWER(), 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'create', cells: { appl_no: 'P001', ccc_code: '6611101', amount: '10' } }] });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            await grant(KEY, { can_edit: true });
            r = await call(VIEWER(), 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'create', cells: { appl_no: 'P002' } }] });
            assert.equal(r.status, 403);
            r = await call(VIEWER(), 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'delete', id: row.id, hash: row.hash }] });
            assert.equal(r.status, 403);
            r = await call(VIEWER(), 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'update', id: row.id, hash: row.hash, cells: { remarks: 'edited by user' } }] });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            await grant(KEY, { can_delete: true });
            const p1 = byAppl((await rowsOf(ADMIN, KEY)).rows, 'P001');
            r = await call(VIEWER(), 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'update', id: p1.id, hash: p1.hash, cells: { remarks: 'x' } }] });
            assert.equal(r.status, 403);
            r = await call(VIEWER(), 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'delete', id: p1.id, hash: p1.hash }] });
            assert.equal(r.status, 200, JSON.stringify(r.body));
        });

        await t('permissions: scope_only limits reading and writing to the office of the login', async () => {
            await grant(KEY, { can_view: true, can_add: true, can_edit: true, can_delete: true, scope_only: true });
            const malda = VIEWER({ division_code: 'Malda', region_code: 'Malda' });
            const seen = (await rowsOf(malda, KEY)).rows;
            assert.ok(seen.length >= 19 && seen.length < 40, String(seen.length));
            assert.ok(seen.every((r) => r.office === 'Manikchak'));
            const cur = (await rowsOf(ADMIN, KEY)).rows;
            const itahar = cur.find((r) => r.office === 'Itahar');
            const manik = cur.find((r) => r.office === 'Manikchak');
            let r = await call(malda, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'update', id: itahar.id, hash: itahar.hash, cells: { remarks: 'no' } }] });
            assert.equal(r.status, 403);
            r = await call(malda, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'update', id: manik.id, hash: manik.hash, cells: { ccc_code: '6621101', ccc_name: 'Itahar' } }] });
            assert.equal(r.status, 403, 'moving a row out of the office');
            r = await call(malda, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'create', cells: { appl_no: 'S001', ccc_code: '6621101' } }] });
            assert.equal(r.status, 403);
            r = await call(malda, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'update', id: manik.id, hash: manik.hash, cells: { remarks: 'in my office' } }] });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            // A dataset with no office columns: nothing to write for an office-limited user.
            await grant(KEY2, { can_view: true, can_edit: true, scope_only: true });
            const r2 = (await rowsOf(ADMIN, KEY2)).rows[0];
            r = await call(malda, 'POST', `/datasets/${KEY2}/commit`, { idempotencyKey: idem(), ops: [{ op: 'update', id: r2.id, hash: r2.hash, cells: { remark: 'x' } }] });
            assert.equal(r.status, 403);
            await revokeAll();
        });

        await t('permissions: sensitive datasets stay admin-only, whatever the grants', async () => {
            const r = await call(ADMIN, 'POST', '/permissions', { grants: [{ user_email: VIEWER().email, dataset_key: 'manpower_staff', can_view: true }] });
            assert.equal(r.status, 400);
            assert.match(r.body.message, /sensitive/);
        });

        await t('paste commit: adds and edits in one batch; preview shows the diff; the records equal the sync\'s', async () => {
            rows = (await rowsOf(ADMIN, KEY)).rows;
            const a1 = byAppl(rows, 'A001');
            const a2 = byAppl(rows, 'A002');
            const ops = [
                { op: 'update', id: a1.id, hash: a1.hash, cells: { amount: '9,99,999.25', remarks: 'pasted, with "quotes"\nand a line' } },
                { op: 'update', id: a2.id, hash: a2.hash, cells: { done: 'N' } },
                { op: 'create', cells: { appl_no: 'B001', ccc_code: '6611101', ccc_name: 'Manikchak', amount: '12.5', applied_on: '01/11/2026', remarks: '', done: 'Y' } },
                { op: 'create', cells: { appl_no: 'B002', ccc_code: '6621101', ccc_name: 'Itahar', amount: '', applied_on: '', remarks: 'x', done: '' } }
            ];
            const pv = await call(ADMIN, 'POST', `/datasets/${KEY}/preview`, { ops });
            assert.equal(pv.status, 200, JSON.stringify(pv.body));
            assert.deepEqual([pv.body.counts.added, pv.body.counts.changed], [2, 2]);
            const ch = pv.body.rows.find((x) => x.op === 'update' && x.id === a1.id);
            assert.equal(ch.before[3], a1.cells[3]);
            assert.equal(ch.after[3], '9,99,999.25');
            const r = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops, kind: 'paste' });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.deepEqual([r.body.counts.added, r.body.counts.changed], [2, 2]);
            const rec = (await pb.listRecords('ds_' + KEY, { filter: "appl_no='A001'" })).items[0];
            assert.equal(rec.amount, 999999.25);
            assert.equal(rec._ccc, 'Manikchak');
            assert.equal(rec._division, 'Malda');
            assert.ok(changed.includes(KEY));
            // The whole collection is what the sync would build from the regenerated snapshot.
            const a = await mounted.nativeApi.analyse(KEY, { allowNative: true });
            assert.equal(a.eligible, true, JSON.stringify(a.reasons));
        });

        await t('snapshot regeneration: same format, .gz/.br copies, manifest version, the edit visible to pages', async () => {
            const text = fs.readFileSync(snapFile(KEY), 'utf8');
            assert.ok(text.startsWith(F.serialize([HEADER], FMT) + '\r\n'));
            assert.ok(text.includes('A001,6611101,Manikchak,"9,99,999.25",'));
            assert.ok(text.includes('"pasted, with ""quotes""\nand a line"'));
            assert.ok(!text.endsWith('\r\n'));
            assert.equal(zlib.gunzipSync(fs.readFileSync(snapFile(KEY) + '.gz')).toString('utf8'), text);
            assert.equal(zlib.brotliDecompressSync(fs.readFileSync(snapFile(KEY) + '.br')).toString('utf8'), text);
            const m = manifest().datasets[KEY];
            assert.equal(m.version, sha(snapFile(KEY)));
            assert.equal(m.bytes, fs.statSync(snapFile(KEY)).size);
            assert.deepEqual(m.dataHubKeys, ['CACHE_ZZ_EDITOR_PK']);
            assert.equal(F.roundTrip(text, 'csv').identical, true);
        });

        await t('all or nothing: a value that does not fit its column refuses the whole batch (or holds that row back)', async () => {
            const count = (await rowsOf(ADMIN, KEY)).total;
            const ops = [{ op: 'create', cells: { appl_no: 'C001', amount: '5' } }, { op: 'create', cells: { appl_no: 'C002', amount: 'five', applied_on: '31/02/2026' } }];
            let r = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops });
            assert.equal(r.status, 422);
            assert.equal(r.body.invalid.length, 2);
            assert.equal((await rowsOf(ADMIN, KEY)).total, count);
            r = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops, skipInvalid: true });
            assert.equal(r.status, 200);
            assert.equal(r.body.counts.added, 1);
            assert.equal(r.body.counts.held, 1);
            r = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'create', cells: { appl_no: 'C001' } }] });
            assert.equal(r.status, 422, 'a repeated primary key');
            assert.match(r.body.invalid[0].message, /APPL_NO/);
        });

        await t('all or nothing: a PocketBase failure in the only part writes nothing', async () => {
            const count = (await rowsOf(ADMIN, KEY)).total;
            const logs = (await pb.listRecords('app_edit_log', { filter: `dataset_key='${KEY}'`, perPage: 1 })).totalItems;
            faults.calls = 0; faults.failBatchAt = 1;
            const r = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'create', cells: { appl_no: 'D001' } }] });
            faults.failBatchAt = 0;
            assert.equal(r.status, 422);
            assert.match(r.body.message, /Nothing was saved/);
            assert.equal((await rowsOf(ADMIN, KEY)).total, count);
            assert.equal((await pb.listRecords('app_edit_log', { filter: `dataset_key='${KEY}'`, perPage: 1 })).totalItems, logs);
        });

        await t('all or nothing: a failure in a later part reverts the parts already applied', async () => {
            const before = (await rowsOf(ADMIN, KEY)).rows.map((r) => r.id + r.hash).sort().join();
            const snapBefore = sha(snapFile(KEY));
            const cur = (await rowsOf(ADMIN, KEY)).rows;
            const ops = [];
            for (let k = 0; k < 12; k++) ops.push({ op: 'create', cells: { appl_no: 'E' + k, ccc_code: '6611101' } });
            ops.push({ op: 'update', id: byAppl(cur, 'A003').id, hash: byAppl(cur, 'A003').hash, cells: { remarks: 'changed in part 1' } });
            ops.push({ op: 'delete', id: byAppl(cur, 'A006').id, hash: byAppl(cur, 'A006').hash });
            faults.calls = 0; faults.failBatchAt = 3; // chunk 12 → parts of 5 items; the third part fails
            const key = idem();
            const r = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: key, ops });
            faults.failBatchAt = 0;
            assert.equal(r.status, 422, JSON.stringify(r.body));
            assert.match(r.body.message, /earlier parts were reverted/);
            const after = (await rowsOf(ADMIN, KEY)).rows.map((x) => x.id + x.hash).sort().join();
            assert.equal(after, before);
            assert.equal(sha(snapFile(KEY)), snapBefore);
            const b = await pb.getRecord('app_edit_batches', mounted.commits.batchIdFor(ADMIN.email, key));
            assert.equal(b.status, 'rolled_back');
            assert.equal((await pb.listRecords('app_edit_log', { filter: `batch_id='${b.id}'`, perPage: 1 })).totalItems, 0);
            // Retrying the same key starts afresh and succeeds.
            const again = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: key, ops });
            assert.equal(again.status, 200, JSON.stringify(again.body));
            assert.equal(again.body.counts.added, 12);
            await call(ADMIN, 'POST', `/datasets/${KEY}/batches/${again.body.batchId}/undo`, { idempotencyKey: idem() });
            assert.equal((await rowsOf(ADMIN, KEY)).rows.map((x) => x.id + x.hash).sort().join(), before);
        });

        await t('crash recovery: a batch left half-applied is reverted by recover()', async () => {
            const before = (await rowsOf(ADMIN, KEY)).rows.map((r) => r.id + r.hash).sort().join();
            const ops = [];
            for (let k = 0; k < 12; k++) ops.push({ op: 'create', cells: { appl_no: 'F' + k } });
            faults.calls = 0; faults.failBatchAt = 2; faults.failRollback = true;
            const key = idem();
            const r = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: key, ops });
            faults.failBatchAt = 0; faults.failRollback = false;
            assert.equal(r.status, 500);
            assert.match(r.body.message, /reverted automatically/);
            const id = mounted.commits.batchIdFor(ADMIN.email, key);
            assert.equal((await pb.getRecord('app_edit_batches', id)).status, 'applying');
            assert.notEqual((await rowsOf(ADMIN, KEY)).rows.map((x) => x.id + x.hash).sort().join(), before);
            const n = await mounted.commits.recover();
            assert.ok(n >= 1);
            assert.equal((await pb.getRecord('app_edit_batches', id)).status, 'rolled_back');
            assert.equal((await rowsOf(ADMIN, KEY)).rows.map((x) => x.id + x.hash).sort().join(), before);
        });

        await t('conflicts: an edit based on an old version of a row is refused with the current values', async () => {
            const cur = (await rowsOf(ADMIN, KEY)).rows;
            const row = byAppl(cur, 'A010');
            let r = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'update', id: row.id, hash: row.hash, cells: { remarks: 'first' } }] });
            assert.equal(r.status, 200);
            r = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'update', id: row.id, hash: row.hash, cells: { remarks: 'second' } }, { op: 'create', cells: { appl_no: 'G1' } }] });
            assert.equal(r.status, 409);
            assert.equal(r.body.conflicts[0].reason, 'changed');
            assert.equal(r.body.conflicts[0].current.cells[5], 'first');
            assert.equal(byAppl((await rowsOf(ADMIN, KEY)).rows, 'G1'), undefined);
            r = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'delete', id: row.id, hash: row.hash }] });
            assert.equal(r.status, 409);
        });

        await t('idempotency: a retried commit is answered from the first, also when the first answer was lost', async () => {
            const key = idem();
            const ops = [{ op: 'create', cells: { appl_no: 'H001' } }];
            const r1 = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: key, ops });
            const r2 = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: key, ops });
            assert.equal(r1.status, 200);
            assert.equal(r2.status, 200);
            assert.equal(r2.body.replayed, true);
            assert.equal(r2.body.batchId, r1.body.batchId);
            assert.equal((await pb.listRecords('ds_' + KEY, { filter: "appl_no='H001'" })).totalItems, 1);
            // PocketBase applied it but the answer never came back: the server checks, and does not re-apply.
            faults.calls = 0; faults.lostAnswerAt = 1;
            const key2 = idem();
            const r3 = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: key2, ops: [{ op: 'create', cells: { appl_no: 'H002' } }] });
            faults.lostAnswerAt = 0;
            assert.equal(r3.status, 200, JSON.stringify(r3.body));
            const r4 = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: key2, ops: [{ op: 'create', cells: { appl_no: 'H002' } }] });
            assert.equal(r4.body.replayed, true);
            assert.equal((await pb.listRecords('ds_' + KEY, { filter: "appl_no='H002'" })).totalItems, 1);
        });

        await t('undo: a whole batch is undone (snapshot back to the same bytes); twice or after a later change, refused', async () => {
            const snapBefore = sha(snapFile(KEY));
            const cur = (await rowsOf(ADMIN, KEY)).rows;
            const a = byAppl(cur, 'A011');
            const b = byAppl(cur, 'A012');
            const r = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [
                { op: 'update', id: a.id, hash: a.hash, cells: { remarks: 'undo me' } }, { op: 'delete', id: b.id, hash: b.hash }, { op: 'create', cells: { appl_no: 'U001' } }] });
            assert.equal(r.status, 200);
            assert.notEqual(sha(snapFile(KEY)), snapBefore);
            let u = await call(VIEWER(), 'POST', `/datasets/${KEY}/batches/${r.body.batchId}/undo`, { idempotencyKey: idem() });
            assert.equal(u.status, 403);
            u = await call(ADMIN, 'POST', `/datasets/${KEY}/batches/${r.body.batchId}/undo`, { idempotencyKey: idem() });
            assert.equal(u.status, 200, JSON.stringify(u.body));
            assert.equal(sha(snapFile(KEY)), snapBefore);
            u = await call(ADMIN, 'POST', `/datasets/${KEY}/batches/${r.body.batchId}/undo`, { idempotencyKey: idem() });
            assert.equal(u.status, 409);
            // A later change to one of its rows blocks the undo.
            const c = byAppl((await rowsOf(ADMIN, KEY)).rows, 'A013');
            const r2 = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'update', id: c.id, hash: c.hash, cells: { remarks: 'v1' } }] });
            const c2 = byAppl((await rowsOf(ADMIN, KEY)).rows, 'A013');
            await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'update', id: c2.id, hash: c2.hash, cells: { remarks: 'v2' } }] });
            u = await call(ADMIN, 'POST', `/datasets/${KEY}/batches/${r2.body.batchId}/undo`, { idempotencyKey: idem() });
            assert.equal(u.status, 409);
            assert.match(u.body.message, /changed since/);
            const det = await call(ADMIN, 'GET', `/datasets/${KEY}/batches/${r.body.batchId}`);
            assert.equal(det.body.batch.status, 'undone');
            assert.equal(det.body.changes.length, 3);
        });

        await t('content-keyed rows: an edit re-keys the row as the sync would; repeats keep ":2"', async () => {
            const cur = (await rowsOf(ADMIN, KEY2)).rows;
            assert.equal(cur.length, 4);
            const r = await call(ADMIN, 'POST', `/datasets/${KEY2}/commit`, { idempotencyKey: idem(), ops: [{ op: 'update', id: cur[3].id, hash: cur[3].hash, cells: { remark: 'ok!' } }, { op: 'create', cells: { feeder: 'F1', hours: '2', remark: 'ok' } }] });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            const a = await mounted.nativeApi.analyse(KEY2, { allowNative: true });
            assert.equal(a.eligible, true, JSON.stringify(a.reasons));
        });

        await t('new dataset: created native with a header-only snapshot; rows added; the sync\'s manifest keeps it', async () => {
            let r = await call(ADMIN, 'POST', '/datasets', { key: NEWKEY, label: 'Editor test new', group: 'Important', primaryKey: ['Code'], columns: [{ source_name: 'Code', type: 'text' }, { source_name: 'Qty', type: 'number' }, { source_name: 'On', type: 'date' }] });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.equal(fs.readFileSync(snapFile(NEWKEY), 'utf8'), 'Code,Qty,On');
            r = await call(ADMIN, 'POST', `/datasets/${NEWKEY}/commit`, { idempotencyKey: idem(), ops: [{ op: 'create', cells: { code: 'X', qty: '3', on: '02/11/2026' } }, { op: 'create', cells: { code: 'Y, z', qty: '', on: '' } }] });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.equal(fs.readFileSync(snapFile(NEWKEY), 'utf8'), 'Code,Qty,On\r\nX,3,02/11/2026\r\n"Y, z",,');
            assert.equal(manifest().datasets[NEWKEY].sourceType, 'native');
            const reg = new Registry(pb);
            await reg.load();
            snapshot.writeManifest(snapDir, Object.values(SOURCES), reg);
            assert.equal(manifest().datasets[NEWKEY].version, sha(snapFile(NEWKEY)));
            assert.equal((await call(ADMIN, 'POST', '/datasets', { key: NEWKEY, columns: [{ source_name: 'a' }] })).status, 409);
            assert.equal((await call(ADMIN, 'POST', '/datasets', { key: 'Bad Key', columns: [{ source_name: 'a' }] })).status, 400);
            assert.equal((await call(VIEWER(), 'POST', '/datasets', { key: 'zz_editor_x', columns: [{ source_name: 'a' }] })).status, 403);
        });

        await t('mode switch back: native → mirror needs the key, starts a sync and clears the native mark', async () => {
            const r = await call(ADMIN, 'POST', `/datasets/${KEY2}/mode`, { mode: 'mirror', confirm: KEY2 });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            const ds = await pb.getRecord('sys_datasets', Registry.idFor(KEY2));
            assert.equal(ds.mode, 'mirror');
            assert.equal(ds.content_hash, '');
            assert.ok(refreshed.includes(KEY2));
            const c = await call(ADMIN, 'POST', `/datasets/${KEY2}/commit`, { idempotencyKey: idem(), ops: [{ op: 'create', cells: { feeder: 'F9' } }] });
            assert.equal(c.status, 409);
            const n = await call(ADMIN, 'POST', `/datasets/${NEWKEY}/mode`, { mode: 'mirror', confirm: NEWKEY });
            assert.equal(n.status, 422, 'an editor-made dataset has no original');
        });

        await t('CSRF: writes need JSON, the editor header and a same-site Origin; reads need a session', async () => {
            const body = { idempotencyKey: idem(), ops: [{ op: 'create', cells: { appl_no: 'Z1' } }] };
            let r = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, body, { 'X-MZO-Editor': '' });
            assert.equal(r.status, 403);
            r = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, 'ops=1', { 'Content-Type': 'application/x-www-form-urlencoded' });
            assert.equal(r.status, 403);
            r = await call(ADMIN, 'POST', `/datasets/${KEY}/commit`, body, { Origin: 'https://evil.example' });
            assert.equal(r.status, 403);
            r = await call(null, 'GET', '/datasets');
            assert.equal(r.status, 401);
            assert.equal(byAppl((await rowsOf(ADMIN, KEY)).rows, 'Z1'), undefined);
        });

        await t('server.js: mounts the editor behind the session cookie and hides lib/editor', async () => {
            const sport = 36000 + Math.floor(Math.random() * 2000);
            const child = spawn(process.execPath, ['--require', path.join(ROOT, 'scripts', 'qa', 'guard-writes.js'), path.join(ROOT, 'server.js')], {
                cwd: ROOT, env: Object.assign({}, process.env, testEnv, { PORT: String(sport), MZO_DATA_MODE: 'mirror', JWT_SECRET: 'editor-test-secret' }), stdio: ['ignore', 'pipe', 'pipe']
            });
            let log = '';
            child.stdout.on('data', (d) => { log += d; });
            child.stderr.on('data', (d) => { log += d; });
            try {
                const url = (p) => `http://127.0.0.1:${sport}${p}`;
                for (let k = 0; k < 100; k++) { try { await fetch(url('/login.html')); break; } catch (_) { await new Promise((ok) => setTimeout(ok, 150)); } }
                const payload = Buffer.from(JSON.stringify({ profile: { Username: 'zzadmin', email: ADMIN.email, role: 'admin' }, expiry: Date.now() + 3600000 })).toString('base64');
                const cookie = 'mzo_session=' + payload + '.' + crypto.createHmac('sha256', 'editor-test-secret').update(payload).digest('base64');
                let r = await fetch(url('/api/editor/me'));
                assert.equal(r.status, 401);
                r = await fetch(url('/api/editor/me'), { headers: { Cookie: cookie } });
                assert.equal(r.status, 200, log);
                assert.equal((await r.json()).user.isAdmin, true);
                r = await fetch(url(`/api/editor/datasets/${KEY}/commit`), { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
                assert.equal(r.status, 403);
                r = await fetch(url('/lib/editor/commit.js'));
                assert.equal(r.status, 404);
                r = await fetch(url('/editor/'), { redirect: 'manual' });
                assert.ok(r.status === 200 || r.status === 301 || r.status === 302, String(r.status));
            } finally {
                child.kill('SIGTERM');
            }
        });
    } finally {
        server.close();
        await cleanup(pb);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`\n${passed} passed, ${fails.length} failed`);
    if (fails.length) process.exitCode = 1;
}

async function cleanup(pb) {
    const q = (v) => "'" + v + "'";
    for (const key of [KEY, KEY2, NEWKEY]) {
        const coll = await pb.getCollection('ds_' + key);
        if (coll) await pb.req('DELETE', '/api/collections/' + coll.id);
        try { await pb.deleteRecord('sys_datasets', Registry.idFor(key)); } catch (_) { /* none */ }
        for (const c of ['app_edit_log', 'app_edit_batches']) {
            for (;;) {
                const res = await pb.listRecords(c, { perPage: 500, fields: 'id', filter: 'dataset_key=' + q(key) });
                if (!res.items.length) break;
                await pb.batch(res.items.map((r) => ({ method: 'DELETE', url: `/api/collections/${c}/records/${r.id}` })));
            }
        }
        const runs = await pb.listRecords('sys_sync_runs', { perPage: 500, fields: 'id', filter: 'dataset=' + q(key) });
        if (runs.items.length) await pb.batch(runs.items.map((r) => ({ method: 'DELETE', url: `/api/collections/sys_sync_runs/records/${r.id}` })));
    }
    const perms = await pb.listRecords('app_dataset_permissions', { perPage: 500, fields: 'id', filter: "user_email~'zz-'" });
    if (perms.items.length) await pb.batch(perms.items.map((r) => ({ method: 'DELETE', url: `/api/collections/app_dataset_permissions/records/${r.id}` })));
    try {
        const s = await pb.getRecord('sys_datasets', Registry.idFor('structure'));
        if (s.mode === 'native') await pb.updateRecord('sys_datasets', s.id, { mode: '' });
    } catch (_) { /* never synced here */ }
    if (!structureExisted) { // the sync test synced `structure` here: remove what it created
        const coll = await pb.getCollection('ds_structure');
        if (coll) await pb.req('DELETE', '/api/collections/' + coll.id);
        try { await pb.deleteRecord('sys_datasets', Registry.idFor('structure')); } catch (_) { /* none */ }
        const runs = await pb.listRecords('sys_sync_runs', { perPage: 500, fields: 'id', filter: "dataset='structure'" });
        if (runs.items.length) await pb.batch(runs.items.map((r) => ({ method: 'DELETE', url: `/api/collections/sys_sync_runs/records/${r.id}` })));
    }
}

main().catch((err) => {
    console.error('FATAL', err && err.stack || err);
    process.exitCode = 1;
});
