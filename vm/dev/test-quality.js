#!/usr/bin/env node
'use strict';
// Tests of the data quality checks (Admin → Data quality; docs/data-quality.md), with synthetic data only:
//
//   node vm/dev/test-quality.js
//
//  1. every generic check of vm/sync/lib/quality (engine.js + checks.js) on small made-up datasets;
//  2. the specific rules of rules.js (REM all zero, Collection office codes, Loss roll-up, coordinates);
//  3. examples never carry cell values in a dataset with personal columns;
//  4. the hold-back rule (vm/sync/lib/holdback.js) on its own and inside syncSource (stand-in PocketBase):
//     a partial copy is held, the snapshot is untouched, the registry says "held: …", it retries, and a
//     good copy clears it; a held copy is accepted after 24 h of identical bytes or with --force;
//  5. vm/sync/quality.js end to end on a temp snapshot folder: quality.json, first / last seen, resolved
//     findings disappear, staleness, held datasets;
//  6. GET /api/admin/data-quality (lib/data_quality.js): the admin gate and the aggregation by dataset
//     with the report names from the Sources payload.
// No network, no PocketBase. Exit 1 on any failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const { Readable } = require('stream');

const ROOT = path.join(__dirname, '..', '..');
const { checkDataset } = require(path.join(ROOT, 'vm/sync/lib/quality/engine'));
const store = require(path.join(ROOT, 'vm/sync/lib/quality/store'));
const holdback = require(path.join(ROOT, 'vm/sync/lib/holdback'));
const offices = require(path.join(ROOT, 'lib/offices.js'));
const dataQuality = require(path.join(ROOT, 'lib/data_quality.js'));

const NOW = Date.parse('2026-11-07T06:00:00Z');
const DAY = 86400000;
let passed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log('ok   ' + name);
    } catch (err) {
        failures.push(name);
        console.log('FAIL ' + name + '\n     ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n     ') : err));
    }
}

const csv = (rows) => rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v))).join(',')).join('\n') + '\n';
const run = (key, rows, extra) => checkDataset(Object.assign({ key, text: csv(rows), format: 'csv', schema: null, offices, now: NOW }, extra || {}));
const find = (res, check, column) => res.findings.find((f) => f.check === check && (column === undefined || f.column === column));
const range = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-dq-' + name + '-'));

(async () => {
    // ---- 1. generic checks ---------------------------------------------------------------------------
    await test('rows: a drop of more than 20% or to 0 rows is critical; 15% is not', () => {
        const head = [['ID', 'CCC CODE', 'COUNT']];
        const rows = (n) => head.concat(range(n, (i) => ['A' + i, '6611101', String(i % 7)]));
        const prev = run('zz_rows', rows(100)).baseline;
        const r70 = run('zz_rows', rows(70), { prev });
        const f = find(r70, 'rows.drop');
        assert.ok(f, 'rows.drop');
        assert.equal(f.severity, 'critical');
        assert.equal(f.count, 30);
        assert.equal(f.total, 100);
        assert.equal(find(run('zz_rows', rows(85), { prev }), 'rows.drop'), undefined);
        const r0 = run('zz_rows', head, { prev });
        assert.equal(find(r0, 'rows.empty').severity, 'critical');
    });

    await test('header: removed columns are a warning (critical when a page reads them), added ones info', () => {
        const prev = run('zz_head', [['ID', 'NAME OF THING', 'AMOUNT'], ['1', 'x', '5']]).baseline;
        const r = run('zz_head', [['ID', 'AMOUNT', 'NEW COL'], ['1', '5', 'y']], { prev });
        const rm = find(r, 'header.removed');
        assert.equal(rm.severity, 'warning');
        assert.deepEqual(rm.examples, ['name_of_thing']);
        assert.equal(find(r, 'header.added').severity, 'info');
        const pinned = run('zz_head', [['ID', 'AMOUNT'], ['1', '5']], { prev, schema: { fields: { name_of_thing: { type: 'text' } } } });
        assert.equal(find(pinned, 'header.removed').severity, 'critical');
    });

    await test('duplicates: repeated keys (rules.js keys) and exact copies of rows, with row numbers', () => {
        const rows = [['ID', 'DIVISION', 'LAT', 'LONG'], ['K1', 'Malda', '25.0', '88.1'], ['K2', 'Malda', '25.1', '88.2'], ['K1', 'Malda', '25.2', '88.3'], ['K2', 'Malda', '25.1', '88.2']];
        const r = run('highway_crossings', rows);
        const k = find(r, 'key.duplicate', 'id_2');
        assert.equal(k.count, 2);
        assert.deepEqual(k.examples, ['row 4', 'row 5']);
        const d = find(r, 'row.duplicate');
        assert.equal(d.count, 1);
        assert.deepEqual(d.examples, ['row 5']);
    });

    await test('offices: blank and unknown offices against lib/offices.js (codes shown where no personal data)', () => {
        const rows = [['CCC CODE', 'COUNT']].concat(range(20, (i) => [i < 3 ? '' : i < 5 ? '9999999' : '6611101', '1']));
        const r = run('zz_office', rows);
        const blank = find(r, 'office.blank');
        assert.equal(blank.count, 3);
        assert.equal(blank.severity, 'warning'); // 15% > 10%
        const unk = find(r, 'office.unknown');
        assert.equal(unk.count, 2);
        assert.deepEqual(unk.examples, ['9999999']);
    });

    await test('personal datasets: examples are row numbers only, never cell values', () => {
        const rows = [['CCC CODE', 'NAME', 'PHONE_NO'], ['9999999', 'Somebody', '9800000000'], ['6611101', 'Other', '9800000001']];
        const r = run('zz_personal', rows);
        assert.equal(r.personal, true);
        const unk = find(r, 'office.unknown');
        assert.deepEqual(unk.examples, ['row 2']);
        const all = JSON.stringify(r.findings);
        assert.ok(!/Somebody|9800000000/.test(all), 'no personal value in any finding');
    });

    await test('numbers: scientific notation in IDs and amounts, text in a number column, negatives, a date in an amount', () => {
        const rows = [['APPLICATION_NO', 'OSD', 'NO_OF_POLES', 'CCC CODE']].concat(range(60, (i) => [
            i === 3 ? '6.00E+09' : String(6000000000 + i),
            i === 7 ? '20261103' : i === 8 ? 'NO' : String(1000 + i * 3),
            i === 9 ? '-2' : String(i % 4),
            '6611101']));
        const r = run('zz_numbers', rows);
        const sci = find(r, 'number.scientific', 'application_no');
        assert.ok(sci && sci.count === 1, 'scientific');
        assert.deepEqual(sci.examples, ['row 5']);
        const text = find(r, 'number.text');
        assert.ok(text && text.count === 1 && text.severity === 'warning', 'text in the amount column');
        const dn = find(r, 'value.date_in_number', 'osd');
        assert.ok(dn && dn.count === 1, 'yyyymmdd in an amount');
        assert.deepEqual(dn.examples, ['row 9']);
        const neg = find(r, 'number.negative', 'no_of_poles');
        assert.ok(neg && neg.severity === 'warning', 'negative count');
        // 4E229-style codes are codes, not E-notation (no sign after the E)
        const codes = run('zz_codes', [['DTR_CODE'], ['4E229'], ['12A3B']]);
        assert.equal(find(codes, 'number.scientific'), undefined);
    });

    await test('rules.js nonNegative: a negative loan balance is a warning; ordinary negative amounts are info', () => {
        const rows = [['OUTSTANDING AMOUNT (INR)', 'OSD']].concat(range(30, (i) => [i === 2 ? '-229000' : '150000', i === 3 ? '-50' : '400']));
        const r = run('pmsgy_malda', rows);
        assert.equal(find(r, 'number.negative', 'outstanding_amount_inr').severity, 'warning');
        assert.equal(find(r, 'number.negative', 'osd').severity, 'info');
    });

    await test('dates: impossible years, future beyond the margin, before 1950, 1900–1912 placeholders, yyyymmdd numbers', () => {
        const vals = ['9982-09-12', '0204-02-15', '12.10.20256', '2027-09-27', '1940-01-05', '1900-02-27', '1912-06-01', '2026-11-20'];
        const rows = [['DIS DATE', 'DATE_OF_CO']].concat(range(200, (i) => [i < vals.length ? vals[i] : '2025-0' + (1 + (i % 9)) + '-1' + (i % 9), i === 0 ? '19120227' : '20240115']));
        const r = run('zz_dates', rows);
        assert.equal(find(r, 'date.impossible', 'dis_date').count, 3);
        assert.equal(find(r, 'date.future', 'dis_date').count, 1); // 2026-11-20 is inside the 31-day margin
        assert.equal(find(r, 'date.too_old', 'dis_date').count, 1);
        assert.equal(find(r, 'date.placeholder', 'dis_date').count, 2);
        assert.equal(find(r, 'date.placeholder', 'date_of_co').count, 1);
    });

    await test('columns that became all zero or blank (critical when a page reads them)', () => {
        const head = ['ID', 'AMOUNT_PAID', 'REMARK'];
        const prev = run('zz_fill', [head].concat(range(10, (i) => ['A' + i, String(i), 'x']))).baseline;
        const r = run('zz_fill', [head].concat(range(10, (i) => ['A' + i, '0', ''])), { prev, schema: { fields: { amount_paid: { type: 'number' } } } });
        assert.equal(find(r, 'column.went_zero', 'amount_paid').severity, 'critical');
        assert.equal(find(r, 'column.went_blank', 'remark').severity, 'warning');
    });

    await test('staleness: the "as on" date against rules.js maxAgeDays, judged by the store', () => {
        const r = run('weekly_report', [['DATE OF REPORT IN CURRENT WEEK', 'CCC CODE'], ['23/02/2026', '6611101'], ['16/02/2026', '6611101']]);
        assert.deepEqual(r.asOn, { column: 'date_of_report_in_current_week', date: '2026-02-23' });
        const f = store.staleFinding('weekly_report', r.asOn, 14, NOW);
        assert.equal(f.severity, 'critical'); // 257 days > 3 × 14 and > 90
        assert.ok(f.count > 250);
        assert.equal(store.staleFinding('weekly_report', { column: 'x', date: '2026-11-01' }, 14, NOW), null);
        assert.equal(store.staleFinding('x', { column: 'x', date: '2026-10-01' }, 14, NOW).severity, 'warning');
    });

    // ---- 2. specific rules ---------------------------------------------------------------------------
    await test('rule rem.osd_all_zero: NOTOSD_UPD 0 everywhere is critical, even with one stray row', () => {
        const rows = [['CCC_CODE', 'CON_ID', 'NOTOSD', 'NOTOSD_UPD']].concat(range(50, (i) => ['6611101', String(400000000 + i), '1200', i === 4 ? '20261103' : '0']));
        const f = find(run('rem_defaulters_ind_com', rows), 'rem.osd_all_zero');
        assert.equal(f.severity, 'critical');
        assert.equal(f.count, 49);
        const ok = [['CCC_CODE', 'CON_ID', 'NOTOSD_UPD']].concat(range(50, (i) => ['6611101', String(i), String(100 + i)]));
        assert.equal(find(run('rem_defaulters_dom', ok), 'rem.osd_all_zero'), undefined);
    });

    await test('rule collection.office_codes: payments booked to region office codes, with the ₹ share', () => {
        const rows = [['PAYMENT_DT', 'CCC_CODE', 'MODE', 'COUNT', 'AMOUNT PAID'], ['05/11/2026', '6611101', 'CASH', '10', '300'], ['05/11/2026', '6630000', 'ONLINE', '2', '100'], ['05/11/2026', '6610000', 'ONLINE', '1', '100']];
        const f = find(run('collection_report', rows), 'collection.office_codes');
        assert.equal(f.count, 2);
        assert.deepEqual(f.examples, ['6630000', '6610000']);
        assert.equal(f.sum, 200);
        assert.match(f.message, /₹2 Cr of ₹5 Cr/);
    });

    await test('rule loss.rollup: region rows carrying input that no CCC row has, latest month only', () => {
        const rows = [['CCC', 'CUM INPUT MU', 'MONTH', 'YEAR'],
            ['Manikchak', '100', '8', '2026'], ['MALDA REGION', '100', '8', '2026'],
            ['Manikchak', '100', '9', '2026'], ['Itahar', '50', '9', '2026'], ['MALDA REGION', '130', '9', '2026'], ['U/DINAJPUR REGION', '50', '9', '2026']];
        const f = find(run('loss_report', rows), 'loss.rollup');
        assert.ok(f, 'roll-up finding');
        assert.equal(f.count, 30);
        assert.equal(f.total, 180);
        assert.equal(f.examples[0], 'Malda +30 MU');
    });

    await test('rule geo.range: coordinates outside the zone or with the decimal point lost; degrees-minutes read', () => {
        const rows = [['ID', 'LAT', 'LONG'], ['a', '25.01', '88.12'], ['b', '24,870,257.0000000', '88.1'], ['c', '22.5', '88.3'], ['d', "N25°01.234'", "E88°08.100'"]];
        const f = find(run('highway_crossings', rows), 'geo.range');
        assert.equal(f.count, 2);
        assert.deepEqual(f.examples, ['row 3', 'row 4']);
    });

    // ---- 4. hold-back --------------------------------------------------------------------------------
    await test('hold-back rule: half the rows, a lost header, or a lost column with a 20% drop', () => {
        const cols = ['a', 'b', 'c', 'd'];
        assert.equal(holdback.assess({ prevRows: 1000, prevColumns: cols, rows: 499, columns: cols }).hold, true);
        assert.equal(holdback.assess({ prevRows: 1000, prevColumns: cols, rows: 501, columns: cols }).hold, false);
        assert.equal(holdback.assess({ prevRows: 1000, prevColumns: cols, rows: 1000, columns: ['x', 'y'] }).hold, true);
        assert.equal(holdback.assess({ prevRows: 1000, prevColumns: cols, rows: 1000, columns: ['a', 'b', 'x'] }).hold, false); // 2 of 4 lost: not more than half
        const withheld = holdback.assess({ prevRows: 66760, prevColumns: cols.concat('scn_witheld_date'), rows: 45600, columns: cols });
        assert.equal(withheld.hold, true);
        assert.match(withheld.reason, /scn_witheld_date gone/);
        assert.equal(holdback.assess({ prevRows: 66760, prevColumns: cols.concat('e'), rows: 60000, columns: cols }).hold, false); // column gone, 10% fewer
        assert.equal(holdback.assess({ prevRows: 10, prevColumns: cols, rows: 2, columns: cols }).hold, false); // too small to judge
    });

    await test('hold-back state: retries count, accepted after 24 h of the same copy, --force, cleared by a good copy', () => {
        const dir = tmp('hold');
        const ds = { row_count: 1000, columns: [{ name: 'a' }, { name: 'b' }, { name: 'a_raw', raw_of: 'a' }] };
        const small = { dir, key: 'k', ds, rows: 100, columns: ['a', 'b'], hash: 'h1' };
        let d = holdback.decide(Object.assign({ now: NOW }, small));
        assert.equal(d.hold, true);
        assert.match(d.message, /^held: new copy looks incomplete/);
        assert.ok(holdback.isHeldMessage(d.message) && holdback.isHeldMessage('[write-through] ' + d.message));
        d = holdback.decide(Object.assign({ now: NOW + 3600e3 }, small));
        assert.equal(holdback.read(dir).k.attempts, 2);
        // new bytes at +25 h: the 24 hours start again for them (a copy that keeps changing is still being written)
        assert.equal(holdback.decide(Object.assign({ now: NOW + 25 * 3600e3 }, small, { hash: 'h2' })).hold, true, 'different bytes: still held');
        assert.equal(holdback.decide(Object.assign({ now: NOW + 30 * 3600e3 }, small, { hash: 'h2' })).hold, true, 'the same bytes for 5 h: still held');
        assert.equal(holdback.read(dir).k.since, new Date(NOW).toISOString(), 'held since the first attempt');
        const acc = holdback.decide(Object.assign({ now: NOW + 49 * 3600e3 }, small, { hash: 'h2' }));
        assert.equal(acc.hold, false);
        assert.match(acc.accepted, /accepted after 24 h/);
        assert.equal(holdback.read(dir).k, undefined);
        assert.equal(holdback.decide(Object.assign({ now: NOW }, small)).hold, true);
        const forced = holdback.decide(Object.assign({ now: NOW, force: true }, small));
        assert.equal(forced.hold, false);
        assert.match(forced.accepted, /--force/);
        holdback.decide(Object.assign({ now: NOW }, small));
        assert.equal(holdback.decide(Object.assign({ now: NOW }, small, { rows: 990 })).hold, false);
        assert.equal(holdback.read(dir).k, undefined, 'a good copy clears the hold');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('hold-back inside syncSource: the partial copy is not published, the registry says held, a good copy clears it', async () => {
        const { syncSource } = require(path.join(ROOT, 'vm/sync/lib/sync'));
        const snap = tmp('snap');
        const spool = tmp('spool');
        const full = csv([['APPL_NO', 'NAME', 'SCN_WITHELD_DATE']].concat(range(200, (i) => ['A' + i, 'n', '01/11/2026'])));
        const partial = csv([['APPL_NO', 'NAME']].concat(range(120, (i) => ['A' + i, 'n'])));
        fs.writeFileSync(path.join(snap, 'zz_hold.csv'), full);
        const ds = { key: 'zz_hold', last_status: 'ok', row_count: 200, column_count: 3, content_hash: 'old', snapshot_sha1: 'sha-of-full', snapshot_file: 'zz_hold.csv',
            last_fetched_at: new Date().toISOString().replace('T', ' '), columns: [{ name: 'appl_no' }, { name: 'name' }, { name: 'scn_witheld_date' }] };
        const saves = [];
        const writes = [];
        const registry = { get: () => ds, save: async (k, v) => { saves.push(v); }, logRun: async () => {} };
        const pb = new Proxy({}, { get: (t, prop) => (prop === 'withSignal' ? () => pb : prop === 'getCollection' ? async () => ({ fields: [{ name: '_nulls' }] }) : async () => { writes.push(prop); throw new Error('no writes in this test'); }) });
        let body = partial;
        const src = {
            key: 'zz_hold', schedule: 'frequent', sourceType: 'google_sheet', primaryKey: ['APPL_NO'],
            raw: async () => ({ stream: Readable.from([Buffer.from(body)]), contentType: 'text/csv' }),
            rows: async function* (ctx) {
                const chunks = [];
                for await (const c of ctx.input) chunks.push(c);
                for (const line of Buffer.concat(chunks).toString('utf8').trim().split('\n')) yield line.split(',');
            }
        };
        const env = { pb, registry, tmpDir: spool, batchSize: 100, snapshotDir: snap, dryRun: false, force: false, fullCheck: false };
        const quiet = console.log;
        console.log = () => {};
        let r;
        try { r = await syncSource(src, env); } finally { console.log = quiet; }
        assert.equal(r.status, 'error');
        assert.match(r.message, /^held: new copy looks incomplete \(120 rows against 200/);
        assert.equal(saves.at(-1).last_status, 'error');
        assert.ok(holdback.isHeldMessage(saves.at(-1).last_error));
        assert.equal(fs.readFileSync(path.join(snap, 'zz_hold.csv'), 'utf8'), full, 'the served snapshot is untouched');
        assert.deepEqual(fs.readdirSync(snap).filter((f) => f.startsWith('.')), [], 'no temp files left');
        assert.deepEqual(writes, [], 'nothing written to PocketBase');
        assert.equal(holdback.read(snap).zz_hold.attempts, 1);
        console.log = () => {};
        try { await syncSource(src, env); } finally { console.log = quiet; }
        assert.equal(holdback.read(snap).zz_hold.attempts, 2, 'retried on the next run');
        body = full;
        console.log = () => {};
        try { r = await syncSource(src, env); } finally { console.log = quiet; }
        assert.equal(holdback.read(snap).zz_hold, undefined, 'a good copy clears the hold');
        fs.rmSync(snap, { recursive: true, force: true });
        fs.rmSync(spool, { recursive: true, force: true });
    });

    // ---- 5. quality.js end to end --------------------------------------------------------------------
    await test('quality.js: checks changed datasets in child processes, keeps first seen, drops resolved, shows held and stale', () => {
        const dir = tmp('run');
        const write = (key, rows, version) => {
            fs.writeFileSync(path.join(dir, key + '.csv'), csv(rows));
            const m = fs.existsSync(path.join(dir, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) : { datasets: {} };
            m.datasets[key] = { version, file: key + '.csv', label: key.replace(/_/g, ' '), rows: rows.length - 1 };
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
        };
        const hw = [['ID', 'DIVISION', 'LAT', 'LONG']].concat(range(40, (i) => ['K' + (i % 38), 'Malda', '25.1', '88.1']));
        write('highway_crossings', hw, 'v1');
        write('weekly_report', [['DATE OF REPORT IN CURRENT WEEK', 'CCC CODE'], ['23/02/2026', '6611101']], 'w1');
        const q = (now, extra) => {
            const r = spawnSync(process.execPath, [path.join(ROOT, 'vm/sync/quality.js'), '--dir', dir, '--now', new Date(now).toISOString()].concat(extra || []), { encoding: 'utf8' });
            assert.equal(r.status, 0, r.stderr);
            return JSON.parse(fs.readFileSync(path.join(dir, 'quality.json'), 'utf8'));
        };
        let s = q(NOW);
        assert.equal(s.lastRun.checked.length, 2);
        const dup = s.findings.find((f) => f.dataset === 'highway_crossings' && f.check === 'key.duplicate');
        assert.ok(dup, 'duplicate IDs found');
        assert.equal(dup.firstSeen, new Date(NOW).toISOString());
        assert.ok(s.findings.some((f) => f.dataset === 'weekly_report' && f.check === 'source.stale' && f.severity === 'critical'));
        assert.equal(s.summary.critical, 1);
        // unchanged versions are not read again, findings keep their first seen
        s = q(NOW + DAY);
        assert.equal(s.lastRun.checked.length, 0);
        assert.equal(s.findings.find((f) => f.id === dup.id).firstSeen, new Date(NOW).toISOString());
        // a partial new copy: rows.drop critical against the last good copy; then fixed: resolved and gone
        write('highway_crossings', hw.slice(0, 20), 'v2');
        s = q(NOW + 2 * DAY);
        assert.equal(s.findings.find((f) => f.dataset === 'highway_crossings' && f.check === 'rows.drop').severity, 'critical');
        assert.equal(s.datasets.highway_crossings.baseline.rows, 40, 'the baseline stays the last good copy');
        const fixed = [['ID', 'DIVISION', 'LAT', 'LONG']].concat(range(40, (i) => ['K' + i, 'Malda', '25.1', '88.1']));
        write('highway_crossings', fixed, 'v3');
        s = q(NOW + 3 * DAY);
        assert.equal(s.findings.filter((f) => f.dataset === 'highway_crossings').length, 0, 'resolved findings disappear');
        assert.ok(s.resolved[dup.id], 'remembered as resolved');
        // it comes back: it keeps its original age
        write('highway_crossings', hw, 'v4');
        s = q(NOW + 4 * DAY);
        assert.equal(s.findings.find((f) => f.id === dup.id).firstSeen, new Date(NOW).toISOString());
        // a held dataset (written by the sync's hold-back)
        fs.writeFileSync(path.join(dir, holdback.FILE), JSON.stringify({ highway_crossings: { since: new Date(NOW).toISOString(), lastTry: new Date(NOW).toISOString(), attempts: 3, reason: '10 rows against 40', rows: 10, prevRows: 40, lost: [], hash: 'x' } }));
        s = q(NOW + 4 * DAY + 60000);
        assert.equal(s.held.length, 1);
        assert.equal(s.held[0].hash, undefined, 'no hash in quality.json');
        assert.equal(s.findings.find((f) => f.check === 'copy.held').severity, 'critical');
        assert.equal(s.summary.held, 1);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // ---- 6. API --------------------------------------------------------------------------------------
    await test('GET /api/admin/data-quality: admin gate, findings grouped by dataset with their reports, held list', async () => {
        const dir = tmp('api');
        const qfile = path.join(dir, 'quality.json');
        const state = store.merge(store.empty(), {
            manifest: { withheld: { version: 'a', label: 'Withheld' }, solar_connections: { version: 'b', label: 'Solar' } },
            results: {
                withheld: { rows: 45600, columns: [{ name: 'appl_no' }], findings: [{ check: 'rows.drop', column: '', severity: 'critical', count: 21160, total: 66760, examples: [], message: 'm', fix: 'f' }], baseline: { rows: 45600, columns: ['appl_no'] } },
                solar_connections: { rows: 10, columns: [{ name: 'application_no' }], findings: [{ check: 'number.scientific', column: 'application_no', severity: 'warning', count: 4, total: 10, examples: ['row 2'], message: 'm', fix: 'f' }], baseline: { rows: 10, columns: [] } }
            },
            held: { withheld: { since: new Date(NOW).toISOString(), attempts: 1, reason: 'r', rows: 45600, prevRows: 66760, hash: 'h' } },
            now: NOW
        });
        store.write(dir, state, qfile);
        const sources = { cached: async () => ({ datasets: [{ key: 'withheld', label: 'Withheld', status: 'held', pages: ['withheld.html'] }],
            reports: [{ id: 'withheld', label: 'Withheld', page: 'withheld.html', group: 'New service connection', sources: ['withheld'] },
                { id: 'briefing', label: 'Briefing', page: 'executive_briefing.html', group: '', sources: ['withheld', 'solar_connections'] }] }) };
        const api = dataQuality.create({ env: { MZO_QUALITY_FILE: qfile }, sources, log: { warn() {}, error() {} } });
        const call = async (user) => {
            const res = { code: 200, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
            await api.handler({ user, query: {} }, res);
            return res;
        };
        assert.equal((await call(null)).code, 401);
        assert.equal((await call({ role: 'ccc', username: 'x' })).code, 403);
        const ok = await call({ role: 'admin' });
        assert.equal(ok.code, 200);
        assert.equal(ok.headers['Cache-Control'], 'private, no-store');
        const b = ok.body;
        assert.equal(b.available, true);
        assert.equal(b.summary.critical, 2); // rows.drop + copy.held
        assert.equal(b.summary.warning, 1);
        assert.equal(b.summary.datasets, 2);
        assert.equal(b.summary.held, 1);
        assert.equal(b.datasets[0].key, 'withheld');
        assert.equal(b.datasets[0].held, true);
        assert.deepEqual(b.datasets[0].reports.map((r) => r.label), ['Withheld', 'Briefing']);
        assert.deepEqual(b.datasets[1].reports.map((r) => r.label), ['Briefing']);
        assert.equal(b.held[0].label, 'Withheld');
        assert.deepEqual(b.reports.map((r) => [r.label, r.datasets]), [['Briefing', 2], ['Withheld', 1]]);
        assert.equal((await call({ isAdmin: true })).code, 200);
        // no quality.json: still 200, not available
        const none = dataQuality.create({ env: { MZO_QUALITY_FILE: path.join(dir, 'missing.json') }, log: { warn() {}, error() {} } });
        const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(x) { this.body = x; return this; }, setHeader() {} };
        await none.handler({ user: { role: 'admin' } }, res);
        assert.equal(res.code, 200);
        assert.equal(res.body.available, false);
        assert.equal(res.body.datasets.length, 0);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // ---- 7. audit findings (lib/quality/audit_findings.json) ---------------------------------------------
    await test('audit findings file: every item complete, enums valid, ids unique, auto_check ids exist, no personal data', () => {
        const file = path.join(ROOT, 'lib/quality/audit_findings.json');
        const text = fs.readFileSync(file, 'utf8');
        const a = JSON.parse(text);
        assert.ok(Array.isArray(a.findings) && a.findings.length >= 20, 'at least 20 findings');
        // Every check id the automatic checks can produce: checks.js finding() calls, the rules' ids, and store.js's own.
        const checksSrc = fs.readFileSync(path.join(ROOT, 'vm/sync/lib/quality/checks.js'), 'utf8');
        const known = new Set([...checksSrc.matchAll(/finding\(ctx, '([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]));
        require(path.join(ROOT, 'vm/sync/lib/quality/rules')).RULES.forEach((r) => known.add(r.id));
        ['source.stale', 'copy.held'].forEach((c) => known.add(c));
        const ids = new Set();
        for (const f of a.findings) {
            const where = f.id || JSON.stringify(f).slice(0, 60);
            for (const k of ['id', 'title', 'severity', 'found', 'summary', 'evidence', 'impact', 'cause', 'owner', 'fix', 'status', 'status_note']) {
                assert.ok(typeof f[k] === 'string' && f[k].trim(), `${where}: ${k} is set`);
            }
            assert.ok(Array.isArray(f.reports) && Array.isArray(f.datasets), `${where}: reports and datasets are lists`);
            f.reports.forEach((r) => assert.ok(r.label, `${where}: report label`));
            assert.ok(!ids.has(f.id), `${where}: unique id`);
            ids.add(f.id);
            assert.ok(['critical', 'high', 'medium', 'low'].includes(f.severity), `${where}: severity`);
            assert.ok(['open', 'fixed', 'mitigated', 'monitoring'].includes(f.status), `${where}: status`);
            assert.ok(['source sheet', 'app', 'sync'].includes(f.owner), `${where}: owner`);
            assert.match(f.found, /^\d{4}-\d{2}-\d{2}$/, `${where}: found is a date`);
            if (f.status === 'fixed') assert.match(String(f.fixed_in || ''), /^\d+\.\d+/, `${where}: a fixed finding names its release`);
            const checks = [].concat(f.auto_check || []).filter(Boolean);
            checks.forEach((c) => assert.ok(known.has(c), `${where}: auto_check ${c} is a real check`));
            if (checks.length) assert.ok(f.datasets.length || (f.auto_datasets || []).length, `${where}: a linked check needs datasets`);
            (f.auto_datasets || []).forEach((d) => assert.ok(f.datasets.includes(d), `${where}: auto_datasets ⊂ datasets`));
            if (f.auto_count) assert.ok(['sum', 'datasets'].includes(f.auto_count), `${where}: auto_count`);
        }
        // Counts and office codes only: no long digit runs (consumer, application or phone numbers), no e-mail addresses.
        assert.ok(!/\b\d{9,}\b/.test(text), 'no 9+ digit numbers');
        assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(text), 'no e-mail addresses');
        // The statuses this list was written against.
        const by = (id) => a.findings.find((f) => f.id === id);
        assert.equal(a.findings.find((f) => /Raiganj/.test(f.title)).status, 'fixed');
        assert.equal(a.findings.find((f) => /partial copy/.test(f.title)).status, 'mitigated');
        assert.equal(by('AF-02').status, 'open');
    });

    await test('audit view: live state linked from quality.json (detected, sums, columns, by dataset, clear, not checked, unavailable)', () => {
        const iso = (t) => new Date(t).toISOString();
        const fnd = (dataset, check, column, count, severity, extra) => Object.assign({ id: `${dataset}|${check}|${column}`, dataset, check, column, severity: severity || 'warning',
            count, total: 1000, examples: [], message: 'm', fix: 'f', firstSeen: iso(NOW - 2 * DAY), lastSeen: iso(NOW) }, extra || {});
        const q = {
            generatedAt: iso(NOW),
            datasets: {
                rem_defaulters_dom: { label: 'REM dom', checkedAt: iso(NOW) }, rem_defaulters_agri: { label: 'REM agri', checkedAt: iso(NOW) },
                pmsgy_malda: { label: 'PMSGY Malda', checkedAt: iso(NOW) }, highway_crossings: { label: 'Crossings', checkedAt: iso(NOW - DAY) },
                weekly_report: { label: 'Weekly', checkedAt: iso(NOW) }, historical_nsc: { label: 'Historical', checkedAt: iso(NOW) }
            },
            findings: [
                fnd('rem_defaulters_dom', 'rem.osd_all_zero', 'notosd_upd', 8107, 'critical'),
                fnd('rem_defaulters_agri', 'rem.osd_all_zero', 'notosd_upd', 5624, 'critical', { firstSeen: iso(NOW - 3 * DAY) }),
                fnd('rem_defaulters_ind_com', 'date.placeholder', 'date_of_co', 177, 'info'),
                fnd('pmsgy_malda', 'number.negative', 'outstanding_amount_inr', 45),
                fnd('pmsgy_malda', 'number.negative', 'sanctioned_amount_inr', 3),
                fnd('weekly_report', 'source.stale', 'date_of_report_in_current_week', 257, 'critical'),
                fnd('historical_nsc', 'source.stale', 'meter_install_date', 244, 'critical')
            ],
            resolved: { 'highway_crossings|geo.range|lat, long': { firstSeen: iso(NOW - 5 * DAY), resolvedAt: iso(NOW - DAY) } }
        };
        const file = { audit: 'Audit', audited: '2026-11-06', updated: '2026-11-07', findings: [
            { id: 'A', title: 'REM zero', reports: [{ label: 'REM defaulters', page: 'rem/defaulters.html' }], datasets: ['rem_defaulters_dom', 'rem_defaulters_agri', 'rem_defaulters_ind_com'],
                severity: 'critical', status: 'open', owner: 'app', auto_check: 'rem.osd_all_zero' },
            { id: 'B', title: 'Negative loans', reports: [{ label: 'PM Surya Ghar', page: 'pmsgy.html' }], datasets: ['pmsgy_malda'], severity: 'medium', status: 'open',
                owner: 'source sheet', auto_check: 'number.negative', auto_columns: ['outstanding_amount_inr'] },
            { id: 'C', title: 'Stale', reports: [{ label: 'Weekly', page: 'weekly.html' }], datasets: ['weekly_report', 'historical_nsc', 'docket_kpi'], severity: 'medium', status: 'open',
                owner: 'source sheet', auto_check: 'source.stale', auto_count: 'datasets', auto_unit: 'source|sources' },
            { id: 'D', title: 'Coordinates', reports: [], datasets: ['highway_crossings'], severity: 'medium', status: 'open', owner: 'source sheet', auto_check: 'geo.range' },
            { id: 'E', title: 'Never checked', reports: [], datasets: ['solar_connections'], severity: 'low', status: 'open', owner: 'source sheet', auto_check: 'number.scientific' },
            { id: 'F', title: 'Fixed by hand', reports: [{ label: 'Performance index', page: 'performance_index.html' }], datasets: [], severity: 'low', status: 'fixed', fixed_in: '3.48', owner: 'app' },
            { id: 'G', title: 'Bad enums fall back', datasets: [], severity: 'urgent', status: 'whatever', owner: 'someone' }
        ] };
        const v = dataQuality.auditView(file, q);
        assert.equal(v.available, true);
        assert.equal(v.summary.total, 7);
        assert.deepEqual(v.summary.status, { open: 6, mitigated: 0, monitoring: 0, fixed: 1 });
        assert.equal(v.summary.severity.critical.open, 1);
        assert.equal(v.summary.severity.low.fixed, 1);
        assert.equal(v.summary.owner['source sheet'], 4);
        assert.equal(v.summary.detected, 3);
        const get = (id) => v.findings.find((f) => f.id === id);
        const a = get('A').live;
        assert.equal(a.state, 'detected');
        assert.equal(a.count, 8107 + 5624, 'counts summed across datasets');
        assert.equal(a.matches.length, 2, 'only its own check (not date.placeholder in the same family)');
        assert.equal(a.firstSeen, iso(NOW - 3 * DAY));
        assert.equal(a.lastSeen, iso(NOW));
        assert.equal(get('B').live.count, 45, 'auto_columns limits the match to one column');
        const c = get('C').live;
        assert.equal(c.count, 2, 'counted by dataset, not by days');
        assert.equal(c.unit, 'source|sources');
        const d = get('D').live;
        assert.equal(d.state, 'clear');
        assert.equal(d.count, 0);
        assert.equal(d.resolvedAt, iso(NOW - DAY), 'a resolved finding gives the time it went away');
        assert.equal(get('E').live.state, 'not_checked');
        assert.equal(get('F').live, null, 'no auto_check: no live block');
        assert.equal(get('F').fixedIn, '3.48');
        assert.deepEqual([get('G').severity, get('G').status, get('G').owner], ['medium', 'open', 'app']);
        assert.deepEqual(v.reports.map((r) => [r.label, r.findings]), [['Performance index', 1], ['PM Surya Ghar', 1], ['REM defaulters', 1], ['Weekly', 1]]);
        // No quality.json: the list still comes, with live state 'unavailable'.
        const none = dataQuality.auditView(file, null);
        assert.equal(none.findings.find((f) => f.id === 'A').live.state, 'unavailable');
        assert.equal(none.summary.detected, 0);
        assert.equal(dataQuality.auditView(null, q).available, false);
    });

    await test('GET /api/admin/data-quality carries audit; GET /api/admin/data-quality/audit: admin gate and shape', async () => {
        const dir = tmp('audit');
        const qfile = path.join(dir, 'quality.json');
        const state = store.merge(store.empty(), {
            manifest: { rem_defaulters_dom: { version: 'a', label: 'REM dom' } },
            results: { rem_defaulters_dom: { rows: 10, columns: [{ name: 'notosd_upd' }], findings: [{ check: 'rem.osd_all_zero', column: 'notosd_upd', severity: 'critical', count: 10, total: 10, examples: [], message: 'm', fix: 'f' }], baseline: { rows: 10, columns: ['notosd_upd'] } } },
            now: NOW
        });
        store.write(dir, state, qfile);
        const mk = (env, extra) => dataQuality.create(Object.assign({ env, log: { warn() {}, error() {} } }, extra || {}));
        const call = async (api, fn, user) => {
            const res = { code: 200, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
            await api[fn]({ user, query: {} }, res);
            return res;
        };
        const api = mk({ MZO_QUALITY_FILE: qfile });
        assert.equal((await call(api, 'auditHandler', null)).code, 401);
        assert.equal((await call(api, 'auditHandler', { role: 'ccc' })).code, 403);
        const main = await call(api, 'handler', { role: 'admin' });
        assert.equal(main.code, 200);
        assert.equal(main.body.audit.available, true);
        const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/quality/audit_findings.json'), 'utf8'));
        assert.equal(main.body.audit.findings.length, shipped.findings.length);
        const rem = main.body.audit.findings.find((f) => f.autoCheck.includes('rem.osd_all_zero'));
        assert.equal(rem.live.state, 'detected');
        assert.equal(rem.live.count, 10);
        const own = await call(api, 'auditHandler', { isAdmin: true });
        assert.equal(own.code, 200);
        assert.equal(own.headers['Cache-Control'], 'private, no-store');
        assert.equal(own.body.status, 'success');
        assert.equal(own.body.qualityAvailable, true);
        for (const f of own.body.findings) {
            for (const k of ['id', 'title', 'reports', 'datasets', 'severity', 'found', 'summary', 'evidence', 'impact', 'cause', 'owner', 'fix', 'status', 'statusNote', 'fixedIn', 'autoCheck', 'live']) {
                assert.ok(k in f, `${f.id}: ${k} in the answer`);
            }
            if (f.autoCheck.length) assert.ok(f.live && ['detected', 'clear', 'not_checked'].includes(f.live.state), `${f.id}: live state`);
            else assert.equal(f.live, null);
        }
        // No quality.json (Vercel): the audit list still comes, live 'unavailable'; a missing findings file: available false.
        const bare = await call(mk({ MZO_QUALITY_FILE: path.join(dir, 'none.json') }), 'auditHandler', { role: 'admin' });
        assert.equal(bare.body.qualityAvailable, false);
        assert.ok(bare.body.findings.filter((f) => f.live).every((f) => f.live.state === 'unavailable'));
        const noFile = await call(mk({ MZO_QUALITY_FILE: qfile }, { auditFile: path.join(dir, 'missing.json') }), 'handler', { role: 'admin' });
        assert.equal(noFile.code, 200);
        assert.equal(noFile.body.audit.available, false);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('Sources payload (GET /api/admin/sources-info) shows a held dataset as "held", not "error"', async () => {
        const pbDate = (t) => new Date(t).toISOString().replace('T', ' ');
        const now = Date.now();
        const registry = [{ key: 'withheld', schedule: 'frequent', last_status: 'error', last_checked_at: pbDate(now - 60000), last_fetched_at: pbDate(now - 3600e3),
            last_error: 'held: new copy looks incomplete (45,600 rows against 66,760 in the copy being served (32% fewer)); kept the previous copy, retrying next run', row_count: 66760 }];
        const pb = { list: async (coll) => (coll === 'sys_datasets' ? registry : []) };
        const mirror = { on: () => true, dir: os.tmpdir(), manifest: async () => ({ data: { generatedAt: new Date(now).toISOString(), datasets: { withheld: { version: 'v', file: 'withheld.csv', rows: 66760 } } } }) };
        const info = require(path.join(ROOT, 'lib/sources_info.js')).create({ appRoot: ROOT, mirror, pb, env: {}, log: { warn() {}, error() {} } });
        const body = await info.build(now);
        const w = body.datasets.find((d) => d.key === 'withheld');
        assert.equal(w.status, 'held');
        assert.equal(w.held, true);
        assert.equal(w.error, false);
        const rep = body.reports.find((r) => r.page === 'withheld.html');
        assert.equal(rep.status, 'held');
        assert.ok(body.reports.some((r) => r.page === 'admin_users.html?tab=quality'), 'the Data quality palette entry is in the NAV');
    });

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) process.exit(1);
})();
