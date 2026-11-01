#!/usr/bin/env node
/* Unit tests for lib/uniform.js (node:test, no dependencies):
 *   node --test scripts/qa/uniform.test.js
 * Cases come from the real sheets where they were found (dataset named in the test). Set
 * UNIFORM_SNAP=<snapshotDir> to also run the checks that read real snapshots.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const U = require(path.join(REPO, 'lib', 'uniform.js'));
const O = require(path.join(REPO, 'lib', 'offices.js'));
U.useOffices(O, JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'costcenter.json'), 'utf8')));
const SNAP = process.env.UNIFORM_SNAP || '';

function build(text, opts) { return U.build(text, Object.assign({ key: 't', offices: null }, opts || {})); }
function col(res, name) { const i = res.columns.findIndex((c) => c.name === name); assert.ok(i >= 0, 'no column ' + name); return res.data[i]; }
function meta(res, name) { return res.columns.find((c) => c.name === name); }

// UI.csv from mzo_ui.js, loaded as the browser does, for parser equivalence.
const uiCsv = (() => {
  const ctx = { window: {}, document: { body: null, head: { appendChild() {} }, addEventListener() {}, querySelector: () => null, createElement: () => ({}) }, Intl };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'mzo_ui.js'), 'utf8'), ctx);
  return ctx.UI.csv;
})();

test('headers become the mirror\'s snake_case names', () => {
  assert.deepEqual(U.fieldNames(['CCC CODE', 'Report Date', 'PAID/DISCON DATE', 'IND&COM BASE DATE ', '1st Bill', 'Café №', '', 'id', 'ID', 'Created']),
    ['ccc_code', 'report_date', 'paid_discon_date', 'ind_com_base_date', 'c_1st_bill', 'cafe_no', 'col_g', 'id_2', 'id_3', 'created_2']);
  // solar_connections has APPL_NO three times; weekly_report has Division twice
  assert.deepEqual(U.fieldNames(['APPL_NO', 'X', 'APPL_NO', 'APPL_NO']), ['appl_no', 'x', 'appl_no_2', 'appl_no_3']);
  assert.equal(U.baseName('x'.repeat(80)).length, 60);
  assert.equal(U.cleanHeader('﻿  CCC   CODE '), 'CCC CODE');
});

test('CSV parsing gives the cells UI.csv gives', () => {
  const cases = [
    'a,b\n1,2\n', 'a,b\r\n1,2\r\n', 'a,b\r1,2', '﻿a,b\n"x, y",2', 'a,b\n"he said ""hi""",2',
    'a,b\n"multi\nline",2', 'a,b\nab"cd,ef"gh,2', 'a,b\n\n\n1,2\n', 'a,b\n,,,\n1,2', 'a,b\n"unterminated,2',
    'a,b\n1,2,3,4', 'a\n1\n2', 'a,b\n1,', 'a,b\n"",""\n'
  ];
  for (const text of cases) {
    const grid = U.parseText(text, ',', true);
    const head = grid[0].map((h) => h.trim());
    const objs = grid.slice(1).map((r) => { const o = {}; head.forEach((h, k) => { o[h] = r[k] != null ? r[k] : ''; }); return o; });
    assert.deepEqual(objs, JSON.parse(JSON.stringify(uiCsv(text))), JSON.stringify(text));
  }
  // TSV (Google never quotes it): quotes are literal (rem_defaulters_ind_com has two)
  assert.deepEqual(U.parseText('a\tb\n5" pipe\t2\n', '\t', false), [['a', 'b'], ['5" pipe', '2']]);
});

test('numbers: grouping, codes and junk', () => {
  assert.equal(U.parseNumber('12,34,567'), 1234567);
  assert.equal(U.parseNumber('1,234,567.50'), 1234567.5);
  assert.equal(U.parseNumber('-3245.23'), -3245.23);
  assert.equal(U.parseNumber('.5'), 0.5);
  assert.equal(U.parseNumber('1.38E+11'), 138000000000);
  assert.equal(U.parseNumber('0661101'), null); // leading zero: a code
  assert.equal(U.parseNumber('1234567890123456'), null); // > 15 significant digits
  assert.equal(U.parseNumber('12,3456'), null);
  assert.equal(U.parseNumber('3.5 kW'), null);
  assert.equal(U.parseNumber('03-10-2026 08:21'), null); // solar_connections LOAD_APPL, one broken row
});

test('dates: every sheet format, wall clock kept, zones to UTC', () => {
  const d = (s, o) => { const p = U.parseDate(s); return p && (o === 'mdy' ? p.mdy : p.dmy); };
  assert.equal(d('19/11/2025'), '2025-11-19');
  assert.equal(d('19.11.2025'), '2025-11-19');
  assert.equal(d('19-11-2025'), '2025-11-19');
  assert.equal(d('2025-11-19'), '2025-11-19');
  assert.equal(d('2025/11/19'), '2025-11-19');
  assert.equal(d('03-10-2026 08:21'), '2026-10-03T08:21:00');
  assert.equal(d('2025-08-29 18:38:00'), '2025-08-29T18:38:00');
  assert.equal(d('1/10/2026 4:05 PM'), '2026-10-01T16:05:00');
  assert.equal(d('12/1/2026 12:00 AM'), '2026-01-12T00:00:00');
  assert.equal(d('1-Oct-2026'), '2026-10-01');
  assert.equal(d('01-Oct-26'), '2026-10-01');
  assert.equal(d('Oct 1, 2026'), '2026-10-01');
  assert.equal(d('2026-07-27T05:39:57.785703+00:00'), '2026-07-27T05:39:57.785Z'); // Supabase timestamptz
  assert.equal(d('2026-07-27T11:09:57+05:30'), '2026-07-27T05:39:57.000Z');
  assert.equal(d('2026-07-27T05:39:57'), '2026-07-27T05:39:57'); // no zone: kept as written
  assert.equal(d('10/13/2026', 'mdy'), '2026-10-13');
  assert.equal(d('10/13/2026'), null); // no 13th month day-first
  assert.equal(U.parseDate('31/02/2026'), null);
  assert.equal(U.parseDate('29/02/2024').dmy, '2024-02-29');
  assert.equal(U.parseDate('29/02/2025'), null);
  assert.equal(U.parseDate('19.11.2025').mdy, null); // only slashes are ever month-first
  assert.equal(U.parseDate('202610'), null); // YYYYMM stays a number (feeder_outage REPORT MONTH)
});

test('the same output in every time zone', () => {
  const script = `const U=require(${JSON.stringify(path.join(REPO, 'lib', 'uniform.js'))});
    const r=U.build('a,b,c\\n19/11/2025 10:30,2026-07-27T05:39:57+00:00,1-Oct-26\\n01/02/2024,2024-02-29T23:59:59-05:00,Oct 1, 2026\\n',{offices:null});
    process.stdout.write(U.stringify(r));`;
  const outs = ['UTC', 'Asia/Kolkata', 'America/New_York', 'Pacific/Chatham'].map((tz) => execFileSync(process.execPath, ['-e', script], { env: Object.assign({}, process.env, { TZ: tz }) }).toString());
  outs.forEach((o) => assert.equal(o, outs[0]));
  assert.ok(outs[0].includes('"2025-11-19T10:30:00"') && outs[0].includes('"2024-03-01T04:59:59.000Z"'));
});

test('type inference: 98 % threshold, raw companions, null markers', () => {
  const rows = (vals) => 'v\n' + vals.join('\n');
  const n49 = Array.from({ length: 49 }, (_, i) => String(i + 1));
  let r = build(rows(n49.concat(['3 kW'])));
  assert.equal(meta(r, 'v').type, 'number');
  assert.equal(col(r, 'v')[49], null);
  assert.equal(col(r, 'v_raw')[49], '3 kW');
  assert.equal(meta(r, 'v_raw').raw_of, 'v');
  assert.equal(r.issues.find((i) => i.check === 'type.unparsed').count, 1);
  r = build(rows(n49.slice(0, 48).concat(['x', 'y'])));
  assert.equal(meta(r, 'v').type, 'text');
  // '(null)' (solar, pending_mc), '#N/A' (disconnection), 'NA', '-' do not count against a typed column
  r = build(rows(n49.concat(['(null)', '#N/A', 'NA', '-', '', 'NIL'])));
  assert.equal(meta(r, 'v').type, 'number');
  assert.ok(!r.columns.some((c) => c.name === 'v_raw'));
  // ...and stay as written in a text column
  r = build('name\nNA\n(null)\nRam');
  assert.deepEqual(col(r, 'name'), ['NA', '(null)', 'Ram']);
  // empty → null in typed columns, '' in text columns
  r = build('n,t\n1,a\n,b\n3,');
  assert.deepEqual(col(r, 'n'), [1, null, 3]);
  assert.deepEqual(col(r, 't'), ['a', 'b', '']);
});

test('identifier columns stay text, counts do not', () => {
  const r = build('APPL_NO,CON_ID,CCC CODE,PHONE_NO,REG_MOB_NO,WON,NO_OF_POLES,LOAD_WATTS\n6000188039,600138327,6611103,9647282467,9647282467,49407,2,3750\n6000191442,600141257,6611108,03512252100,7479179460,84426,8,600');
  for (const c of ['appl_no', 'con_id', 'ccc_code', 'phone_no', 'reg_mob_no', 'won']) assert.equal(meta(r, c).type, 'text', c);
  assert.equal(col(r, 'phone_no')[1], '03512252100'); // a landline keeps its zero
  assert.equal(meta(r, 'no_of_poles').type, 'number');
  assert.equal(meta(r, 'load_watts').type, 'number');
  assert.ok(U.isIdName('application_no') && U.isIdName('meter_number') && !U.isIdName('no_of_poles') && !U.isIdName('c_2026'));
});

test('dd/mm vs mm/dd: decided per column by the values', () => {
  let r = build('d\n01/02/2026\n13/02/2026\n05/03/2026');
  assert.equal(meta(r, 'd').date_order, 'dmy');
  assert.deepEqual(col(r, 'd'), ['2026-02-01', '2026-02-13', '2026-03-05']);
  r = build('d\n02/01/2026\n02/13/2026\n03/05/2026'); // stock dump writes m/d/yyyy
  assert.equal(meta(r, 'd').date_order, 'mdy');
  assert.deepEqual(col(r, 'd'), ['2026-02-01', '2026-02-13', '2026-03-05']);
  r = build('d\n01/02/2026\n03/04/2026'); // ambiguous: day first unless the dataset prefers m/d
  assert.equal(meta(r, 'd').date_order, 'dmy');
  assert.equal(meta(build('d\n01/02/2026\n03/04/2026', { dateOrder: 'mdy' }), 'd').date_order, 'mdy');
  assert.equal(meta(build('d\n10:30 01/02/2026\n2026-01-01'), 'd').type, 'text');
  assert.equal(meta(build('d\n01/02/2026 10:30\n2026-01-01'), 'd').has_time, true);
});

test('bool and json columns', () => {
  let r = build('wo,p\nY,true\nN,false\n,TRUE');
  assert.deepEqual(col(r, 'wo'), [true, false, null]);
  assert.deepEqual(col(r, 'p'), [true, false, true]);
  r = U.build([{ id: 1, tags: ['a'], meta: { x: 1 }, at: '2026-07-27T05:39:57.785703+00:00', ok: true }, { id: 2, tags: null, meta: { y: 2 }, at: null, ok: false }], { offices: null });
  assert.deepEqual(r.columns.map((c) => [c.name, c.type]), [['id_2', 'text'], ['tags', 'json'], ['meta', 'json'], ['at', 'date'], ['ok', 'bool']]);
  assert.deepEqual(col(r, 'meta'), [{ x: 1 }, { y: 2 }]);
  assert.deepEqual(col(r, 'at'), ['2026-07-27T05:39:57.785Z', null]);
});

test('rows: values trimmed, blank rows dropped, padding columns dropped, extra cells kept', () => {
  const r = build('A, B ,\n x , y ,\n,,\n1,2,,extra\n');
  assert.deepEqual(r.columns.map((c) => c.name), ['a', 'b', 'col_d']);
  assert.deepEqual(r.rows, [['x', 'y', ''], ['1', '2', 'extra']].map((x) => x));
  assert.equal(r.stats.rows, 2);
  assert.equal(r.stats.source_rows, 3);
});

test('schema: pinned types, aliases for renamed headers, missing fields, pruning', () => {
  const schema = { keep: 'pinned', fields: { appl_no: { type: 'text' }, load: { type: 'number', aliases: ['LOAD_WATTS'] }, paid: { type: 'date', order: 'dmy' }, gone: { type: 'number' }, flag: { type: 'text' } } };
  const r = build('APPL_NO,LOAD_WATTS,PAID,FLAG,OTHER\n0012,1500,01/02/2026,Y,x\n0013,n/a,03/02/2026,N,y', { schema });
  assert.deepEqual(r.columns.map((c) => c.name), ['appl_no', 'load', 'paid', 'flag', 'gone']);
  assert.deepEqual(col(r, 'appl_no'), ['0012', '0013']);
  assert.deepEqual(col(r, 'load'), [1500, null]); // 'n/a' is a null marker: no raw companion
  assert.deepEqual(col(r, 'paid'), ['2026-02-01', '2026-02-03']);
  assert.deepEqual(col(r, 'flag'), ['Y', 'N']); // pinned text: not a bool
  assert.deepEqual(col(r, 'gone'), [null, null]);
  assert.ok(r.issues.some((i) => i.check === 'header.alias' && i.column === 'load'));
  assert.ok(r.issues.some((i) => i.check === 'header.missing' && i.column === 'gone'));
  assert.equal(r.schema, U.schemaHash(schema));
  assert.notEqual(U.schemaHash(schema), U.schemaHash(Object.assign({}, schema, { keep: 'all' })));
  assert.equal(U.schemaHash(Object.assign({ label: 'x', notes: 'y' }, schema)), U.schemaHash(schema)); // labels do not change rows
});

test('schema: header row, skipped rows, report sheets without a header', () => {
  // pmsgy: row 2 is a glossary; report sheets (puja, important_*) are read by position
  let r = build('Title of the sheet\nAppl,Stage\nApplication number,Stage name\nA1,Done', { schema: { header_row: 1, skip_rows: [0] } });
  assert.deepEqual(r.columns.map((c) => c.name), ['appl', 'stage']);
  assert.deepEqual(r.rows, [['A1', 'Done']]);
  r = build('Report,,\nCCC,Load,MW\nMalda,1,2', { schema: { header: false } });
  assert.deepEqual(r.columns.map((c) => c.name), ['col_a', 'col_b', 'col_c']);
  assert.equal(r.stats.rows, 3);
});

test('offices: canonical _region/_division/_ccc_code/_ccc from codes and names', () => {
  const r = U.build('CCC_CODE,SUPP_OFF,DIVN_NAME\n6611103,Baishnabnagar,Malda\n,Kaliyaganj CCC,\n6632104,GANGARAMPUR CCC-6632104,\n,Somewhere,\n', { key: 't' });
  assert.deepEqual(r.columns.slice(-4).map((c) => c.name), ['_region', '_division', '_ccc_code', '_ccc']);
  const o = U.objects(r);
  assert.deepEqual([o[0]._region, o[0]._division, o[0]._ccc_code, o[0]._ccc], ['Malda', 'Malda', '6611103', 'Baishnabnagar']);
  assert.deepEqual([o[1]._region, o[1]._ccc], ['Raiganj', 'Kaliyaganj']);
  assert.equal(o[2]._ccc, 'Gangarampur');
  assert.deepEqual([o[3]._region, o[3]._ccc], ['', '']);
  assert.ok(r.issues.some((i) => i.check === 'office.unknown_ccc'));
  assert.match(r.logic, /^uniform\/\d+\+offices\/\d+/);
  assert.ok(!U.build('a\n1', { offices: null }).columns.some((c) => c.name === '_region'));
});

test('output: canonical JSON, chunks, round trip', () => {
  const r = build('a,b,d\n1,x,01/02/2026\n2,y,\n', { version: 'v1' });
  const json = U.stringify(r);
  assert.ok(json.startsWith('{"key":"t","version":"v1","logic":'));
  const chunks = [];
  U.stringify(r, (c) => chunks.push(c));
  assert.equal(chunks.join(''), json);
  const back = U.fromJSON(JSON.parse(json));
  assert.equal(U.stringify(back), json);
  assert.deepEqual(U.objects(back), [{ a: 1, b: 'x', d: '2026-02-01' }, { a: 2, b: 'y', d: null }]);
  const big = build('n\n' + Array.from({ length: 10000 }, (_, i) => i).join('\n'));
  const parts = [];
  U.stringify(big, (c) => parts.push(c));
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), U.stringify(big));
});

test('real snapshots: build, identical twice, every pinned field present', { skip: !SNAP && 'set UNIFORM_SNAP' }, () => {
  const files = fs.readdirSync(SNAP).filter((f) => /^[a-z0-9_]+\.(csv|tsv|json)$/.test(f) && f !== 'manifest.json');
  assert.ok(files.length > 10);
  for (const f of files) {
    const key = f.replace(/\.\w+$/, '');
    const text = fs.readFileSync(path.join(SNAP, f), 'utf8');
    let schema = null;
    try { schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schema', key + '.json'), 'utf8')); } catch (_) { /* none */ }
    const a = U.stringify(U.build(text, { key, format: f.split('.').pop(), schema }));
    const b = U.stringify(U.build(text, { key, format: f.split('.').pop(), schema }));
    assert.equal(a, b, key);
    if (schema) {
      const res = JSON.parse(a);
      assert.ok(!res.issues.some((i) => i.check === 'header.missing'), key + ': a pinned field is missing');
      Object.keys(schema.fields).forEach((name) => assert.equal(res.columns.find((c) => c.name === name).type, schema.fields[name].type, key + '.' + name));
    }
  }
});
