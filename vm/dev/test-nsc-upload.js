'use strict';
/**
 * Synthetic checks for lib/nsc_pipeline.js (no real SAP file, no network).
 * Run: node vm/dev/test-nsc-upload.js
 */
const assert = require('assert');
const NP = require('../../lib/nsc_pipeline');

const reportDate = new Date(2026, 10, 10); // 10 Nov 2026

const raw = [
  { SCN_STATUS: 'Working', APPL_NO: 'A1', REG: 'MALDA REGION', DIVI: 'MALDA DIVISIOIN', CCC_CODE: '6611103', SUPP_OFF: 'Baishnabnagar CCC', COLL_DATE: '01/10/2026', NO_OF_POLES: 2, CONN_CLASS: 'D', NAME: 'Test' },
  { SCN_STATUS: 'Working', APPL_NO: 'A1', REG: 'MALDA REGION', CCC_CODE: '6611103', SUPP_OFF: 'Baishnabnagar', COLL_DATE: '01/10/2026', NO_OF_POLES: 2, CONN_CLASS: 'D', NAME: 'Test dup' },
  { SCN_STATUS: 'Withheld', APPL_NO: 'W1', REG: 'MALDA REGION', CCC_CODE: '6611103', SUPP_OFF: 'Baishnabnagar', CONN_CLASS: 'C', NAME: 'Wh', SCN_WITHELD_DATE: '01/09/2026', SCN_WITHELD_REASON: 'Doc' },
  { SCN_STATUS: 'Closed', APPL_NO: 'C1', REG: 'MALDA REGION', CCC_CODE: '6611103', NAME: 'Skip' }
];

const t = NP.transformRows(raw, reportDate);
assert.strictEqual(t.published.length, 1, 'one working after dedupe');
assert.strictEqual(t.withheld.length, 1, 'one withheld');
assert.strictEqual(t.stats.skippedDup, 1);
assert.ok(t.published[0].PoleNonPole === 'Pole Case');
assert.ok(Number(t.published[0].DelayInSC) > 30);

const slim = NP.slimWorking(t.published);
assert.ok(!('INSPECTION_DATE' in slim[0]) || slim[0].INSPECTION_DATE === undefined || Object.prototype.hasOwnProperty.call(slim[0], 'APPL_NO'));
assert.strictEqual(Object.keys(slim[0]).length, NP.SLIM_WORKING_COLUMNS.length);

const csv = NP.toCsv(slim, NP.SLIM_WORKING_COLUMNS);
const back = NP.readCsvRows(csv);
assert.strictEqual(back.length, 1);
assert.strictEqual(back[0].APPL_NO, 'A1');

const viz = NP.buildViz(t.published, 'working');
assert.strictEqual(viz.total, 1);
assert.strictEqual(viz.over30, 1);
assert.strictEqual(viz.pole, 1);

const rv = NP.review(
  { published: t.published, withheld: [], stats: t.stats, reportDateUsed: '10/11/2026', originalName: 'PNSC DATE 10-11-2026.xlsb' },
  { workingRows: 5000, withheldRows: 60000, reportDate: '10/11/2026' }
);
assert.ok(rv.warnings.some((w) => w.code === 'same_report_date'));
assert.ok(rv.warnings.some((w) => w.code === 'working_only'));
assert.ok(rv.warnings.some((w) => w.code === 'row_drop'));
assert.strictEqual(rv.blocks.length, 0);

const empty = NP.review(
  { published: [], withheld: [], stats: { rawRows: 0 }, reportDateUsed: '10/11/2026', originalName: 'x.xlsb' },
  null
);
assert.ok(empty.blocks.some((b) => b.code === 'empty'));

assert.deepStrictEqual(
  NP.missingRequiredColumns({ NAME: 'x' }, 'raw'),
  ['APPL_NO', 'SCN_STATUS', 'CCC_CODE or SUPP_OFF']
);
assert.deepStrictEqual(NP.missingRequiredColumns(raw[0], 'raw'), []);
assert.deepStrictEqual(NP.missingRequiredColumns(t.withheld[0], 'withheld'), []);

const badCols = NP.review(
  {
    published: [{ APPL_NO: '1', SCN_STATUS: 'Working', NAME: 'No office' }],
    withheld: [],
    stats: t.stats,
    reportDateUsed: '10/11/2026',
    originalName: 'x.xlsb',
    sourceRow: { APPL_NO: '1', SCN_STATUS: 'Working', NAME: 'No office' }
  },
  null
);
assert.ok(badCols.blocks.some((b) => b.code === 'missing_columns'));

console.log('test-nsc-upload: ok');
