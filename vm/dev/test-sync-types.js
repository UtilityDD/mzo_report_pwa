#!/usr/bin/env node
/* The mirror's types follow lib/uniform.js, and a collection from the older sync (mzo-sync/1)
 * migrates without losing values or showing the portal an empty column. Against a local
 * PocketBase with the repo's migrations (never the VM):
 *
 *   node vm/dev/test-sync-types.js --env <file with PB_URL, PB_SUPERUSER_EMAIL, PB_SUPERUSER_PASSWORD>
 *
 * 1. Builds ds_zz_sync_types_test as mzo-sync/1 left it: con_id a number, amount a number with an
 *    amount_raw companion for its one "(null)", flag text (its NA cells were not Y/N), no _nulls.
 * 2. Syncs the same rows with the current code, failing the second write batch: the run errors,
 *    the old fields keep every value (what the portal reads), the new types wait in _stage_ fields.
 *    Meanwhile _nulls describes the fields the portal shows: row 5's blank con_id (still the old
 *    number field, 0) is listed, so it shows empty, not 0.
 * 3. Syncs again: the run resumes, then swaps the fields in: con_id text, flag bool, no
 *    amount_raw, empty numbers/bools in _nulls, the same record ids; values equal lib/uniform.js's.
 * 4. Syncs a third time: row 5's _nulls still names the old con_id, so that one row is tidied;
 *    a fourth run is unchanged, nothing written.
 * 5. Edits three rows (rows without a primary key are keyed by their content, so they get new
 *    keys): each old record is deleted in the same batch as its new one is inserted, so the row
 *    count never changes, not even between batches.
 * Removes the collection and its registry rows at the end. Exit 1 on any failure.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const SYNC = path.join(__dirname, '..', 'sync', 'lib');
const U = require('../../lib/uniform.js');
const { PocketBase } = require(path.join(SYNC, 'pb'));
const { Registry } = require(path.join(SYNC, 'registry'));
const { syncSource } = require(path.join(SYNC, 'sync'));
const { rowKeyFn } = require(path.join(SYNC, 'upsert'));
const { recordId, sha1, pbDate } = require(path.join(SYNC, 'util'));

const KEY = 'zz_sync_types_test';
const COLL = 'ds_' + KEY;

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// 60 rows: con_id digits (an identifier: text now; row 5 blank), amount with one "(null)" and three blanks,
// paid Y/N with one blank, flag Y/N/NA (a bool now: NA is a placeholder), a dd/mm date.
const HEADER = ['CON_ID', 'AMOUNT', 'PAID', 'STATUS_DATE', 'NOTE', 'FLAG'];
const ROWS = [];
for (let i = 0; i < 60; i++) {
  ROWS.push([
    i === 4 ? '' : String(110000000 + i * 7),
    i === 5 ? '(null)' : i % 20 === 3 ? '' : String(1000 + i * 25) + (i % 4 ? '' : '.50'),
    i === 9 ? '' : i % 3 ? 'Y' : 'N',
    String((i % 28) + 1).padStart(2, '0') + '/10/2026',
    i % 10 ? 'ok' : '',
    i % 7 === 0 ? 'NA' : i % 2 ? 'Y' : 'N'
  ]);
}
const source = {
  key: KEY, label: 'sync-types test', group: 'System', pages: [], sourceType: 'other', sourceRef: { test: true },
  sourceUrl: '', schedule: 'hourly', primaryKey: null, notes: 'vm/dev/test-sync-types.js',
  async *rows() { yield HEADER; for (const r of ROWS) yield r.slice(); }
};

/** The collection and records as mzo-sync/1 wrote them (its types, 0 / false for blanks). */
async function makeV1(pb) {
  const PORTAL = '@request.auth.collectionName = "portal_users_auth"';
  await pb.createCollection({
    name: COLL, type: 'base', listRule: PORTAL, viewRule: PORTAL, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { name: 'con_id', type: 'number', onlyInt: false }, { name: 'amount', type: 'number', onlyInt: false },
      { name: 'amount_raw', type: 'text', max: 1000000 }, { name: 'paid', type: 'bool' }, { name: 'status_date', type: 'date' },
      { name: 'note', type: 'text', max: 1000000 }, { name: 'flag', type: 'text', max: 1000000 },
      { name: '_row_no', type: 'number', onlyInt: true }, { name: '_row_key', type: 'text', max: 2000, required: true },
      { name: '_hash', type: 'text', max: 64 }, { name: '_synced_at', type: 'date' }
    ],
    indexes: [`CREATE UNIQUE INDEX \`idx_${COLL}_row_key\` ON \`${COLL}\` (\`_row_key\`)`, `CREATE INDEX \`idx_${COLL}_row_no\` ON \`${COLL}\` (\`_row_no\`)`]
  });
  const keyer = rowKeyFn(HEADER.map((h, i) => ({ source_name: h, index: i, non_empty: 1 })), null, []);
  const reqs = ROWS.map((r, i) => {
    const key = keyer.key(r);
    const [d, m, y] = r[3].split('/');
    return { method: 'POST', url: `/api/collections/${COLL}/records`, body: {
      id: recordId(key), con_id: Number(r[0]), amount: r[1] === '' || r[1] === '(null)' ? 0 : Number(r[1]),
      amount_raw: r[1] === '(null)' ? '(null)' : '', paid: r[2] === 'Y', status_date: `${y}-${m}-${d} 00:00:00.000Z`,
      note: r[4], flag: r[5], _row_no: i + 1, _row_key: key, _hash: sha1('v1:' + i), _synced_at: pbDate(new Date())
    } };
  });
  await pb.batch(reqs);
  return ROWS.map((r) => recordId(keyer.key(r)));
}

async function records(pb) {
  const out = [];
  for await (const page of pb.pages(COLL, { fields: '*' })) out.push(...page);
  return out.sort((a, b) => a._row_no - b._row_no);
}

async function cleanup(pb) {
  try { await pb.req('DELETE', `/api/collections/${COLL}`); } catch (_) { /* none */ }
  try { await pb.req('DELETE', `/api/collections/sys_datasets/records/${Registry.idFor(KEY)}`); } catch (_) { /* none */ }
  try {
    const res = await pb.listRecords('sys_sync_runs', { perPage: 200, fields: 'id', filter: `dataset = "${KEY}"` });
    if (res.items.length) await pb.batch(res.items.map((r) => ({ method: 'DELETE', url: `/api/collections/sys_sync_runs/records/${r.id}` })));
  } catch (_) { /* none */ }
}

async function main() {
  const i = process.argv.indexOf('--env');
  if (i < 0) throw new Error('usage: node vm/dev/test-sync-types.js --env <pb env file>');
  const env = readEnv(process.argv[i + 1]);
  if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(env.PB_URL || '')) throw new Error('PB_URL must be a local PocketBase');
  const pb = new PocketBase({ url: env.PB_URL, email: env.PB_SUPERUSER_EMAIL, password: env.PB_SUPERUSER_PASSWORD });
  await pb.auth();
  await cleanup(pb);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-types-'));
  const run = async (client) => {
    const registry = new Registry(client);
    await registry.load();
    return syncSource(source, { pb: client, registry, tmpDir, batchSize: 20, dryRun: false, force: false, snapshotDir: null, fullCheck: true, reason: 'test', onSnapshot: null });
  };
  let ok = false;
  try {
    const ids = await makeV1(pb);
    const v1 = await records(pb);

    // 2. a run that dies after its first write batch
    let batches = 0;
    const failing = new Proxy(pb, { get(t, p) {
      if (p === 'batch') return async (reqs) => { if (++batches === 2) throw new Error('simulated crash'); return t.batch(reqs); };
      const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
    } });
    const s1 = await run(failing);
    assert.equal(s1.status, 'error', 'interrupted run reports an error');
    let coll = await pb.getCollection(COLL);
    const type = (c, n) => (c.fields.find((f) => f.name === n) || {}).type;
    assert.equal(type(coll, 'con_id'), 'number', 'old con_id kept during the migration');
    assert.equal(type(coll, '_stage_con_id'), 'text', 'new con_id staged');
    assert.equal(type(coll, '_stage_flag'), 'bool', 'new flag staged');
    assert.equal(type(coll, 'amount_raw'), 'text', 'amount_raw kept until the swap');
    const mid = await records(pb);
    mid.forEach((r, k) => {
      assert.equal(r.con_id, v1[k].con_id, 'con_id values intact mid-migration');
      assert.equal(r.flag, v1[k].flag, 'flag values intact mid-migration');
    });
    assert.ok(mid[4]._stage_con_id === '' && (mid[4]._nulls || []).includes('con_id'), 'row 5: the shown (old, number) con_id is listed as empty while staged');
    assert.ok(mid.some((r) => r._stage_con_id) && mid.some((r) => !r._stage_con_id), 'the first batch was written, the rest not');
    console.log('ok   interrupted run: old fields kept every value, new types staged');

    // 3. the next run resumes and swaps
    const s2 = await run(pb);
    assert.equal(s2.status, 'ok', s2.message);
    assert.ok(s2.updated > 0 && s2.updated < ROWS.length, `resumed: wrote ${s2.updated} rows (the ones the first run did not)`);
    coll = await pb.getCollection(COLL);
    const names = coll.fields.map((f) => f.name + ':' + f.type);
    assert.deepEqual(names, ['id:text', 'con_id:text', 'amount:number', 'paid:bool', 'status_date:date', 'note:text', 'flag:bool',
      '_row_no:number', '_row_key:text', '_hash:text', '_synced_at:date', '_nulls:json'], 'final fields');
    const res = U.build([HEADER].concat(ROWS), { offices: null });
    const col = (n) => res.data[res.columns.findIndex((c) => c.name === n)];
    const after = await records(pb);
    assert.deepEqual(after.map((r) => r.id), ids, 'record ids unchanged');
    after.forEach((r, k) => {
      assert.equal(r.con_id, col('con_id')[k]);
      assert.equal(r.amount, col('amount')[k] === null ? 0 : col('amount')[k]);
      assert.equal(r.paid, col('paid')[k] === null ? false : col('paid')[k]);
      assert.equal(r.flag, col('flag')[k] === null ? false : col('flag')[k]);
      assert.equal(r.status_date.slice(0, 10), col('status_date')[k]);
      const want = ['amount', 'paid', 'flag'].filter((n) => col(n)[k] === null);
      if (k === 4) want.unshift('con_id'); // still the staged list until the next run tidies it
      assert.deepEqual(r._nulls || [], want, `row ${k + 1} _nulls`);
    });
    const ds = new Registry(pb); await ds.load();
    assert.deepEqual(ds.get(KEY).columns.map((c) => c.name + ':' + c.type), res.columns.map((c) => c.name + ':' + c.type), 'registry columns = uniform columns');
    console.log(`ok   resumed run: ${s2.updated} rows written, fields swapped; types, values and _nulls equal lib/uniform.js`);

    // 4. the next run tidies row 5's _nulls, then nothing changes
    const s3 = await run(pb);
    assert.equal(s3.status, 'ok', s3.message);
    assert.equal(s3.updated, 1, 'only the provisional row is written');
    const tidy = await records(pb);
    assert.deepEqual(tidy[4]._nulls || [], ['amount', 'paid', 'flag'].filter((n) => col(n)[4] === null), 'row 5 _nulls tidied');
    const s3b = await run(pb);
    assert.equal(s3b.status, 'unchanged', s3b.message);
    console.log('ok   third run tidied the one provisional _nulls; fourth run unchanged');

    // 5. re-keyed rows are replaced within one batch
    for (const k of [2, 30, 59]) ROWS[k][4] = 'edited';
    let count = ROWS.length, low = count, high = count, batchesSeen = 0;
    const counting = new Proxy(pb, { get(t, p) {
      if (p === 'batch') return async (reqs) => {
        const r = await t.batch(reqs);
        batchesSeen++;
        for (const q of reqs) count += q.method === 'POST' ? 1 : q.method === 'DELETE' ? -1 : 0;
        low = Math.min(low, count); high = Math.max(high, count);
        return r;
      };
      const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
    } });
    const s4 = await run(counting);
    assert.equal(s4.status, 'ok', s4.message);
    assert.equal(s4.inserted, 3, 'three re-keyed rows inserted');
    assert.equal(s4.deleted, 3, 'their old records deleted');
    assert.equal(low, ROWS.length, `row count never dropped (lowest ${low})`);
    assert.equal(high, ROWS.length, `row count never grew (highest ${high})`);
    const fin = await records(pb);
    assert.equal(fin.length, ROWS.length);
    assert.deepEqual(fin.filter((r) => r.note === 'edited').map((r) => r._row_no), [3, 31, 60]);
    console.log(`ok   re-keyed rows: 3 replaced in ${batchesSeen} batch(es), the row count stayed ${ROWS.length} throughout`);
    ok = true;
  } finally {
    await cleanup(pb);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error('FAIL', e && e.message ? e.message : e); process.exit(1); });
