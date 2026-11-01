#!/usr/bin/env node
/* scripts/qa/rating-metrics-test.js: unit tests for lib/rating_metrics.js on small synthetic rows.
 *
 *   node scripts/qa/rating-metrics-test.js
 *
 * The aggregation rules (each level from its own summed inputs, own-level rows, zone rows, the
 * region HT residual, the year-earlier outlier fallback, the CCC outage proxy through the DTR
 * list), the quality flags, and the input handling (typed or raw values, the accepted row
 * shapes, missing fields, release, the async entry). No dependencies.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const APP = path.resolve(__dirname, '..', '..');
const M = require(path.join(APP, 'lib', 'rating_metrics.js'));
const O = require(path.join(APP, 'lib', 'offices.js'));

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const close = (a, b, msg) => assert.ok(a != null && Math.abs(a - b) < 6e-4, (msg || '') + ' expected ' + b + ', got ' + a); // values carry 3 decimals

/** Canonical office fields of a code, as lib/uniform.js writes them. */
function canon(code) {
    const o = code ? O.parseCode(code) : null;
    if (!o || !['ccc', 'division', 'region'].includes(o.level)) return { _region: '', _division: '', _ccc_code: '', _ccc: '' };
    return { _region: o.region || '', _division: o.division || '', _ccc_code: o.ccc_code || '', _ccc: o.ccc || '' };
}
/** A uniform row of a dataset: every needed field present (empty), then the given values. */
function row(key, values, code) {
    const r = {};
    for (const [f, spec] of Object.entries(M.NEEDS[key])) if (!spec.opt) r[f] = spec.type === 'text' ? '' : null;
    Object.assign(r, values);
    return Object.assign(r, code === undefined ? canon(values.ccc_code) : canon(code));
}
const entry = (doc, id, code) => doc.offices[code].metrics[id];
const MALDA_DIV = '6611000', MALDA_REG = '6610000', ZONE = '6600000', MANIKCHAK = '6611101', GOLAPGANJ = '6611102', BHALUKA = '6612101';

// ---- pending NSC: shares from summed counts, own-level rows, zone rows, flags ---------------

function nscRows() {
    const rows = [];
    const add = (code, n, over, extra) => { for (let i = 0; i < n; i++) rows.push(row('nsc_pending', Object.assign({ ccc_code: code, today: '2026-10-30', delayinsc: i < over ? 45 : 5, delayinwo: null, delayinqtn: 1 }, extra || {}))); };
    add(MANIKCHAK, 10, 1);          // 10 %
    add(GOLAPGANJ, 90, 81);         // 90 %
    add(MALDA_DIV, 20, 20);         // booked at the division office itself
    rows.push(row('nsc_pending', { ccc_code: '6600000', today: '2026-10-30', delayinsc: 100 }, '')); // the zone office: no canonical office
    rows.push(row('nsc_pending', { ccc_code: '9999999', today: '2026-10-30', delayinsc: 100 }, '')); // not an MZO office: unmapped
    add(BHALUKA, 5, 5);             // small base (minBase 20)
    return rows;
}

test('a level is computed from its summed numerators and denominators, never an average of its children', () => {
    const doc = M.computeSync({ nsc_pending: nscRows() }, { asOf: '2026-11-01', only: ['nsc_pending_over_30d_share'] });
    close(entry(doc, 'nsc_pending_over_30d_share', MANIKCHAK).value, 10);
    close(entry(doc, 'nsc_pending_over_30d_share', GOLAPGANJ).value, 90);
    const div = entry(doc, 'nsc_pending_over_30d_share', MALDA_DIV);
    // (1 + 81 + 20) / (10 + 90 + 20): the division's own rows count at the division
    assert.strictEqual(div.numerator, 102); assert.strictEqual(div.denominator, 120); close(div.value, 85);
    const reg = entry(doc, 'nsc_pending_over_30d_share', MALDA_REG);
    assert.strictEqual(reg.numerator, 102 + 5); assert.strictEqual(reg.denominator, 120 + 5); // + Bhaluka (Chanchal division)
    const zone = entry(doc, 'nsc_pending_over_30d_share', ZONE);
    assert.strictEqual(zone.denominator, 126); assert.strictEqual(zone.numerator, 108); // + the zone office's own row
    assert.strictEqual(doc.metrics.nsc_pending_over_30d_share.unmapped, 1);
});

test('rows booked at an office itself are flagged with their own numerator and denominator', () => {
    const doc = M.computeSync({ nsc_pending: nscRows() }, { asOf: '2026-11-01', only: ['nsc_pending_over_30d_share'] });
    const div = entry(doc, 'nsc_pending_over_30d_share', MALDA_DIV);
    assert.ok(div.quality.flags.includes('includes_own_level_rows'));
    assert.deepStrictEqual(div.ownLevel, { numerator: 20, denominator: 20 });
    const z = entry(doc, 'nsc_pending_over_30d_share', ZONE);
    assert.deepStrictEqual(z.ownLevel, { numerator: 1, denominator: 1 });
    assert.ok(!('ownLevel' in entry(doc, 'nsc_pending_over_30d_share', MANIKCHAK)));
    assert.ok(!('ownLevel' in entry(doc, 'nsc_pending_over_30d_share', MALDA_REG))); // nothing at the region itself
});

test('small bases warn, offices with no cases are "no_cases", old data is stale', () => {
    let doc = M.computeSync({ nsc_pending: nscRows() }, { asOf: '2026-11-01', only: ['nsc_pending_over_30d_share'] });
    assert.deepStrictEqual(entry(doc, 'nsc_pending_over_30d_share', BHALUKA).quality, { status: 'warn', flags: ['small_base'] });
    const none = entry(doc, 'nsc_pending_over_30d_share', '6612102'); // Samsi: no rows
    assert.strictEqual(none.value, null); assert.deepStrictEqual(none.quality, { status: 'ok', flags: ['no_cases'] });
    assert.deepStrictEqual(entry(doc, 'nsc_pending_over_30d_share', GOLAPGANJ).quality, { status: 'ok' });
    doc = M.computeSync({ nsc_pending: nscRows() }, { asOf: '2026-12-31', only: ['nsc_pending_over_30d_share'] });
    assert.strictEqual(doc.metrics.nsc_pending_over_30d_share.ageDays, 62);
    assert.strictEqual(entry(doc, 'nsc_pending_over_30d_share', GOLAPGANJ).quality.status, 'stale');
});

// ---- loss report: region residual, zone, targets, year-earlier outliers ---------------------

const lossRow = (ccc, y, m, input, demand, coll) => row('loss_report', { ccc, year: y, month: m, update_on: '2026-10-30', cum_input_mu: input, cum_demand_mu: demand, cum_collec_mu: coll }, '');
function lossRows() {
    const rows = [];
    // Manikchak normally ~30 % AT&C, Golapganj ~10 %; in Sep 2025 the sheet swapped their rows.
    const months = [[2025, 8, false], [2025, 9, true], [2025, 10, false]];
    for (const [y, m, swap] of months) {
        rows.push(lossRow('MANIKCHAK', y, m, ...(swap ? [50, 46, 45] : [100, 75, 70])));
        rows.push(lossRow('GOLAPGANJ', y, m, ...(swap ? [100, 75, 70] : [50, 46, 45])));
    }
    rows.push(lossRow('MANIKCHAK', 2026, 9, 100, 80, 76));
    rows.push(lossRow('GOLAPGANJ', 2026, 9, 50, 45, 45));
    rows.push(lossRow('MALDA DIV TOTAL', 2026, 9, 150, 125, 121));
    rows.push(lossRow('BHALUKA', 2026, 9, 60, 50, 50));
    rows.push(lossRow('MALDA REGION', 2026, 9, 260, 220, 210)); // 50 MU of HT input that no division carries
    rows.push(lossRow('MALDA ZONE', 2026, 9, 260, 220, 210));
    rows.push(lossRow('MANIKCHAK', 2026, 9, 999, 999, 999)); // a pasted duplicate block: skipped
    return rows;
}
const targetRows = () => [
    row('loss_targets', { ccc: 'MANIKCHAK', cum_input_mu: 100, cum_demand_mu: 85, cum_collec_mu: 85 }, ''),
    row('loss_targets', { ccc: 'GOLAPGANJ', cum_input_mu: 50, cum_demand_mu: 45, cum_collec_mu: 45 }, '')
];

test('loss: each level from its summed MU; a region\'s own HT input is its row minus its divisions', () => {
    const doc = M.computeSync({ loss_report: lossRows(), loss_targets: targetRows() }, { asOf: '2026-11-01', only: ['atc_loss', 'distribution_loss'] });
    close(entry(doc, 'atc_loss', MANIKCHAK).value, 24);
    close(entry(doc, 'atc_loss', MALDA_DIV).value, 100 * (150 - 121) / 150);
    const reg = entry(doc, 'atc_loss', MALDA_REG);
    close(reg.denominator, 260); close(reg.value, 100 * 50 / 260);
    assert.ok(reg.quality.flags.includes('includes_own_level_rows'));
    assert.deepStrictEqual(reg.ownLevel, { numerator: 11, denominator: 50 }); // 50 − min(39, 45)
    const zone = entry(doc, 'atc_loss', ZONE);
    close(zone.denominator, 260); assert.ok(!zone.ownLevel); // the zone row equals Σ regions
    // targets from the target sheet's own MU (the typed target % is not used)
    assert.strictEqual(entry(doc, 'atc_loss', MANIKCHAK).target, 15);
    assert.strictEqual(entry(doc, 'atc_loss', MALDA_DIV).target, +(100 * (150 - 130) / 150).toFixed(2));
    assert.strictEqual(entry(doc, 'distribution_loss', GOLAPGANJ).target, 10);
    assert.strictEqual(entry(doc, 'atc_loss', BHALUKA).target, undefined);
    assert.ok(doc.checks.atc_loss.some((c) => c.kind === 'region_row_minus_divisions' && c.own.input === 50));
});

test('loss: a misplaced year-earlier row falls back to the median of its three months (Sep-2025 swap)', () => {
    const doc = M.computeSync({ loss_report: lossRows() }, { asOf: '2026-11-01', only: ['atc_loss_change_yoy'] });
    const a = entry(doc, 'atc_loss_change_yoy', MANIKCHAK);
    assert.deepStrictEqual(a.inputs, { current: 24, yearEarlier: 30, baseMonthOutlier: true });
    close(a.value, -6);
    assert.deepStrictEqual(a.quality, { status: 'warn', flags: ['base_month_outlier'] });
    assert.strictEqual(entry(doc, 'atc_loss_change_yoy', GOLAPGANJ).inputs.yearEarlier, 10);
    // the swap is inside one division: its summed inputs are right, so no fallback there
    const div = entry(doc, 'atc_loss_change_yoy', MALDA_DIV);
    assert.strictEqual(div.inputs.baseMonthOutlier, false);
    close(div.inputs.yearEarlier, +(100 * (150 - 115) / 150).toFixed(2));
    assert.deepStrictEqual(doc.checks.atc_loss_change_yoy, [{ kind: 'base_month_outliers', offices: [MANIKCHAK, GOLAPGANJ] }]);
});

// ---- reliability: feeder metrics stop at divisions; the CCC proxy goes through the DTR list ---

function reliabilityRows() {
    const f = (sub, fdr, minutes, count) => row('feeder_outage', { report_month: '202608', division_name: 'MALDA', circle_name: 'MALDA', substation_name: sub, feeder_name: fdr, total_count_of_outage_over_5_min: count, total_duration_of_outage_over_5_min: minutes }, MALDA_DIV);
    const d = (code, ccc, sub, fdr, n) => Array.from({ length: n }, () => row('dtr_records', { supp_off: ccc, divn_name: 'MALDA', region: 'MALDA', ss_name: sub, fdr_name: fdr, capa_kv: 100 }, code));
    return {
        feeder_outage: [f('SS ONE', '11KV ALPHA FEEDER', 600, 5), f('SS TWO X', 'BETA', 1200, 40), f('SS ONE', 'GAMMA', 300, 2)],
        dtr_records: [].concat(
            d(MANIKCHAK, 'MANIKCHAK CCC', 'SS ONE', 'ALPHA', 3), // division + substation + feeder name
            d(MANIKCHAK, 'MANIKCHAK CCC', 'SS TWO', 'BETA', 2), // substation differs: matched by division + feeder name
            d(GOLAPGANJ, 'GOLAPGANJ CCC', 'ONE', 'ALPHA FDR', 1),
            d(GOLAPGANJ, 'GOLAPGANJ CCC', 'SS ONE', 'NOT IN OUTAGES', 4))
    };
}

test('reliability: feeder metrics are n/a at CCCs; DTR-weighted hours reach CCCs through the DTR list', () => {
    const doc = M.computeSync(reliabilityRows(), { asOf: '2026-09-15', only: ['feeder_outage_hours', 'feeder_concern_share', 'dtr_weighted_outage_hours'] });
    const na = entry(doc, 'feeder_outage_hours', MANIKCHAK);
    assert.deepStrictEqual(na.quality, { status: 'na', flags: ['level_not_available'], reason: 'feeder outage data has no CCC column (division and substation only)' });
    close(entry(doc, 'feeder_outage_hours', MALDA_DIV).value, (600 + 1200 + 300) / 60 / 3);
    close(entry(doc, 'feeder_concern_share', MALDA_DIV).value, 100 / 3); // BETA: 40 outages
    const a = entry(doc, 'dtr_weighted_outage_hours', MANIKCHAK);
    close(a.value, (3 * 10 + 2 * 20) / 5); assert.strictEqual(a.inputs.coverage, 100);
    const b = entry(doc, 'dtr_weighted_outage_hours', GOLAPGANJ);
    close(b.value, 10); assert.deepStrictEqual(b.inputs, { dtrsOnMatchedFeeders: 1, dtrs: 5, coverage: 20 });
    assert.deepStrictEqual(b.quality, { status: 'warn', flags: ['feeder_name_match', 'small_base', 'low_match_coverage'] });
    const div = entry(doc, 'dtr_weighted_outage_hours', MALDA_DIV);
    close(div.value, 80 / 6); assert.strictEqual(div.inputs.coverage, 60); assert.ok(!div.quality.flags.includes('low_match_coverage'));
    assert.deepStrictEqual(doc.checks.dtr_weighted_outage_hours, [{ kind: 'feeder_months_matched', value: 2, of: 3 }]);
});

// ---- other placement rules ---------------------------------------------------------------

test('CMO grievances: a district that is no region counts at the zone; below regions the metric is n/a', () => {
    const r = (district, pending) => row('cmo_grievances', { district, report_date: '2026-10-28', pending_with: pending, grievance_since: 10 }, district === 'Malda' ? MALDA_REG : '');
    const doc = M.computeSync({ cmo_grievances: [r('Malda', 'EE'), r('Malda', 'Disposed / pending with HQ'), r('Not Known', 'EE')] }, { asOf: '2026-11-01', only: ['cmo_open_share'] });
    assert.strictEqual(entry(doc, 'cmo_open_share', MALDA_REG).value, 50);
    assert.deepStrictEqual(entry(doc, 'cmo_open_share', ZONE).ownLevel, { numerator: 1, denominator: 1 });
    assert.strictEqual(entry(doc, 'cmo_open_share', MALDA_DIV).quality.status, 'na');
});

test('a dataset without canonical office fields is placed from its own office cells', () => {
    const rows = nscRows().map((r) => { const o = Object.assign({}, r); delete o._region; delete o._division; delete o._ccc_code; delete o._ccc; return o; });
    const a = M.computeSync({ nsc_pending: nscRows() }, { asOf: '2026-11-01', only: ['nsc_pending_over_30d_share'], generatedAt: 'x' });
    const b = M.computeSync({ nsc_pending: rows }, { asOf: '2026-11-01', only: ['nsc_pending_over_30d_share'], generatedAt: 'x' });
    assert.deepStrictEqual(b, a);
});

// ---- values: typed, raw text, unparsed text all read the same ------------------------------

test('typed values, source text and "_raw" leftovers give the same numbers and dates', () => {
    const typed = nscRows();
    const text = typed.map((r) => Object.assign({}, r, { delayinsc: r.delayinsc == null ? '' : String(r.delayinsc), today: '30/10/2026', delayinqtn: '1' }));
    const raw = typed.map((r) => Object.assign({}, r, { delayinsc: null, delayinsc_raw: r.delayinsc + ' days%'.slice(5), today: null, today_raw: '30.10.2026' }));
    const opts = { asOf: '2026-11-01', generatedAt: 'x', only: ['nsc_pending_over_30d_share', 'nsc_pending_avg_days'] };
    const a = M.computeSync({ nsc_pending: typed }, opts);
    assert.deepStrictEqual(M.computeSync({ nsc_pending: text }, opts), a);
    assert.deepStrictEqual(M.computeSync({ nsc_pending: raw }, opts), a);
    assert.strictEqual(M.num('12,34,567.5'), 1234567.5); assert.strictEqual(M.num('(0.37)'), -0.37); assert.strictEqual(M.num('22.35%'), 22.35);
    assert.ok(isNaN(M.num('3 days')));
    assert.strictEqual(M.date('2026-10-30T10:22:00'), '2026-10-30'); assert.strictEqual(M.date('30.10.2026'), '2026-10-30');
    assert.strictEqual(M.date('3/8/26', 'mdy'), '2026-03-08'); assert.strictEqual(M.date('15-July-26'), '2026-07-15');
    assert.strictEqual(M.date(20240101), '2024-01-01'); assert.strictEqual(M.date('(null)'), ''); assert.strictEqual(M.date('0'), '');
});

test('a needed field missing from the rows stops the metric instead of reading zeros', () => {
    const t = targetRows().map((r) => { const o = Object.assign({}, r); delete o.cum_input_mu; return o; });
    let doc = M.computeSync({ loss_report: lossRows(), loss_targets: t }, { asOf: '2026-11-01', only: ['atc_loss', 'collection_efficiency'] });
    assert.ok(/^field missing: loss_targets\.cum_input_mu/.test(doc.errors.atc_loss), doc.errors.atc_loss);
    assert.ok(!doc.metrics.atc_loss && doc.metrics.collection_efficiency); // collection efficiency does not read targets
    // a pinned field whose header vanished arrives empty with a header.missing issue: same rule
    const tDoc = { all: targetRows(), columns: Object.keys(targetRows()[0]).map((name) => ({ name })), issues: [{ check: 'header.missing', column: 'cum_demand_mu', count: 2, sample: [] }] };
    doc = M.computeSync({ loss_report: lossRows(), loss_targets: tDoc }, { asOf: '2026-11-01', only: ['atc_loss'] });
    assert.ok(/loss_targets\.cum_demand_mu/.test(doc.errors.atc_loss));
    doc = M.computeSync({ loss_report: lossRows() }, { asOf: '2026-11-01', only: ['atc_loss'] });
    assert.strictEqual(doc.errors.atc_loss, 'dataset missing: loss_targets');
});

// ---- input shapes, release, async ----------------------------------------------------------

function asDoc(rows) {
    const names = [...new Set([].concat(...rows.map(Object.keys)))];
    return { key: 'x', columns: names.map((name) => ({ name, type: 'text', source_name: name })), issues: [], stats: { rows: rows.length }, rows: rows.map((r) => names.map((n) => (n in r ? r[n] : ''))) };
}

test('row arrays, MzoRows t, rows documents (parsed or text) and build() results give one document', () => {
    const opts = { asOf: '2026-11-01', generatedAt: 'x', only: ['atc_loss', 'atc_loss_change_yoy'] };
    const base = M.computeSync({ loss_report: lossRows(), loss_targets: targetRows() }, opts);
    const d = asDoc(lossRows());
    const t = { all: lossRows(), rows: [], columns: d.columns, issues: [] };
    const built = { columns: d.columns, stats: { rows: d.rows.length }, issues: [] };
    Object.defineProperty(built, 'data', { value: d.columns.map((c, k) => d.rows.map((r) => r[k])), enumerable: false });
    for (const x of [d, JSON.stringify(d), t, built]) assert.deepStrictEqual(M.computeSync({ loss_report: x, loss_targets: targetRows() }, opts), base);
});

test('release (drop rows after their last metric) changes nothing', () => {
    const src = Object.assign({ nsc_pending: nscRows(), loss_report: lossRows(), loss_targets: targetRows() }, reliabilityRows());
    let loads = 0;
    const fn = (k) => { loads++; return src[k]; };
    const a = M.computeSync(src, { asOf: '2026-11-01', generatedAt: 'x' });
    const b = M.computeSync(fn, { asOf: '2026-11-01', generatedAt: 'x', release: true });
    assert.deepStrictEqual(b, a);
    assert.ok(loads >= 6);
});

test('compute() takes promises and gives the same document as computeSync()', async () => {
    const src = Object.assign({ nsc_pending: nscRows(), loss_report: lossRows(), loss_targets: targetRows() }, reliabilityRows());
    const opts = { asOf: '2026-11-01', generatedAt: 'x', manifest: null };
    const a = M.computeSync(src, Object.assign({ mode: 'browser' }, opts));
    const b = await M.compute((k) => new Promise((res) => setTimeout(() => res(src[k] || null), 1)), opts);
    assert.deepStrictEqual(b, a);
    assert.ok(/^dataset missing: consumers/.test(b.errors.receivable_days));
});

test('dataset lists: DATASETS, datasetsFor and the ids lib/rating.js rates', () => {
    assert.strictEqual(M.METRICS.length, 46);
    assert.strictEqual(M.DATASETS.length, 37); // costcenter is not read: offices come placed in the rows
    for (const m of M.METRICS) for (const k of m.datasets) if (k !== 'costcenter') assert.ok(M.DATASETS.includes(k), k);
    const R = require(path.join(APP, 'lib', 'rating.js'));
    const rated = M.ratedIds(R.METHOD);
    for (const id of ['atc_loss', 'cmo_open_share', 'accidents_fatal_12m', 'live_consumers']) assert.ok(rated.includes(id), id);
    const ds = M.datasetsFor(rated);
    assert.ok(ds.includes('dtr_records') && ds.includes('loss_targets') && !ds.includes('meter_master') && !ds.includes('withheld'));
    assert.deepStrictEqual(M.datasetsFor(['nsc_withheld_network_share']), ['withheld', 'nsc_pending']);
});

(async () => {
    for (const t of tests) {
        try { await t.fn(); passed++; console.log('ok   ' + t.name); }
        catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); }
    }
    console.log(passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
})();
