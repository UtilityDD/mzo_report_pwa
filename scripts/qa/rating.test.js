#!/usr/bin/env node
/* Unit tests for lib/rating.js (node:test, no dependencies):
 *   node --test scripts/qa/rating.test.js
 * Covers the linear scale (and a calibration against WBSEDCL's published 14th Integrated Rating
 * marks), grade bands, n/a re-weighting, pillar n/a, penalties, level aggregation, ranks,
 * "what would move it up", determinism, and the real sample (docs/rating/sample-metrics.json).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const R = require(path.join(REPO, 'lib', 'rating.js'));
const SAMPLE = require(path.join(REPO, 'docs', 'rating', 'sample-metrics.json'));

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' ' + a + ' vs ' + b + ' (±' + tol + ')');
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---- a synthetic metrics document --------------------------------------------------------------
const e = (value, extra) => Object.assign({ value, numerator: null, denominator: null, asOn: '2026-10-01', quality: { status: 'ok' } }, extra || {});
/** Every metric the engine reads, at full-marks values. */
function perfect() {
    return {
        atc_loss: e(10, { numerator: 10, denominator: 100 }),
        distribution_loss: e(10, { numerator: 10, denominator: 100, target: 12 }),
        collection_efficiency: e(100, { numerator: 100, denominator: 100 }),
        receivable_days: e(30, { numerator: 30, denominator: 1 }),
        atc_loss_change_yoy: e(-2, { inputs: { current: 10, yearEarlier: 12 } }),
        dtr_weighted_outage_hours: e(1, { numerator: 100, denominator: 100 }),
        feeder_outage_count: e(2, { numerator: 200, denominator: 100 }),
        nsc_pending_over_30d_share: e(10, { numerator: 10, denominator: 100 }),
        nsc_wo_delay_avg: e(3, { numerator: 300, denominator: 100 }),
        load_ext_pending_over_90d_share: e(10, { numerator: 1, denominator: 10 }),
        solar_pending_over_30d_share: e(10, { numerator: 10, denominator: 100 }),
        defective_meter_share: e(2, { numerator: 2000, denominator: 100000 }),
        defective_over5y_share: e(5, { numerator: 100, denominator: 2000 }),
        unbilled_3m_per_10k: e(0.5, { numerator: 5, denominator: 100000 }),
        first_bill_pending_per_10k: e(0.5, { numerator: 5, denominator: 100000 }),
        mc_pending_over_30d_share: e(5, { numerator: 5, denominator: 100 }),
        fault_dockets_open_over_24h_per_10k: e(0.5, { numerator: 5, denominator: 100000 }),
        docket_open_per_10k: e(2, { numerator: 20, denominator: 100000 }),
        cmo_open_share: e(2, { numerator: 2, denominator: 100 }),
        accidents_fatal_12m: e(0, { numerator: 0 }),
        safety_rectification_share: e(100, { numerator: 50, denominator: 50 }),
        live_consumers: e(100000, { numerator: 100000 })
    };
}
/** Every metric at zero-marks values. */
function worst() {
    const m = perfect();
    Object.assign(m.atc_loss, { value: 30 }); Object.assign(m.distribution_loss, { value: 30, target: 20 });
    Object.assign(m.collection_efficiency, { value: 90 }); Object.assign(m.receivable_days, { value: 200 });
    m.atc_loss_change_yoy.inputs = { current: 12, yearEarlier: 10 };
    Object.assign(m.dtr_weighted_outage_hours, { value: 40 }); Object.assign(m.feeder_outage_count, { value: 70 });
    for (const k of ['nsc_pending_over_30d_share', 'load_ext_pending_over_90d_share', 'solar_pending_over_30d_share', 'defective_over5y_share']) m[k].value = 95;
    m.nsc_wo_delay_avg.value = 60; m.defective_meter_share.value = 40; m.unbilled_3m_per_10k.value = 30; m.first_bill_pending_per_10k.value = 30;
    m.mc_pending_over_30d_share.value = 90; m.fault_dockets_open_over_24h_per_10k.value = 20; m.docket_open_per_10k.value = 90; m.cmo_open_share.value = 50;
    return m;
}
function office(level, name, parent, metrics) { return { level, name, parent, metrics }; }
function docOf(offices, metricsMeta) {
    return { generatedAt: '2026-11-01T00:00:00Z', logic: 'test', referenceDate: '2026-11-01', metrics: metricsMeta || { accidents_fatal_12m: { maxAgeDays: 60 }, mc_pending_over_30d_share: { minBase: 20 } }, offices };
}
const P = (off, id) => { for (const pl of off.pillars) for (const x of pl.params) if (x.id === id) return x; return null; };
const PL = (off, id) => off.pillars.find((p) => p.id === id);

// ---- linear scale --------------------------------------------------------------------------------
test('linear scale: full and zero thresholds, both directions, clamped', () => {
    // lower is better: full at 15, zero at 25 (AT&C)
    assert.equal(R.linear(15, 15, 25), 1);
    assert.equal(R.linear(10, 15, 25), 1);
    assert.equal(R.linear(25, 15, 25), 0);
    assert.equal(R.linear(30, 15, 25), 0);
    near(R.linear(22.35, 15, 25), 0.265, 1e-12);
    // higher is better: full at 99.5, zero at 91 (collection efficiency)
    assert.equal(R.linear(100, 99.5, 91), 1);
    assert.equal(R.linear(91, 99.5, 91), 0);
    near(R.linear(95.25, 99.5, 91), 0.5, 1e-12);
    // degenerate and missing
    assert.equal(R.linear(5, 5, 5), 1);
    assert.equal(R.linear(4, 5, 5), 0);
    assert.equal(R.linear(null, 1, 2), null);
    assert.equal(R.linear(NaN, 1, 2), null);
    // inverse gives back the value
    near(R.inverse(R.linear(22.35, 15, 25), 15, 25), 22.35, 1e-9);
});

// The 14th Integrated Rating (PFC, FY 2024-25), WBSEDCL, IR14 p.144-145: published marks, and the
// inputs as printed (docs/rating/sources.md 3.10). The linear ("proportionate") reading and the
// 60/25/15 three-year weighting must reproduce them; the small tolerances are the rounding of the
// printed inputs.
test('calibration: WBSEDCL 14th Integrated Rating parameter marks', () => {
    const be = R.weighted3(84.63, 83.75, 83.28);
    near(be, 84.21, 0.005, 'billing efficiency, 3-year weighted');
    near(4 * R.linear(be, 92, 82) + 0, 0.88, 0.005, 'billing efficiency marks (of 5; trajectory 0)');

    const ce = R.weighted3(97.87, 98.94, 99.15);
    near(ce, 98.33, 0.005, 'collection efficiency, 3-year weighted');
    near(4 * R.linear(ce, 99.5, 91) + 1, 4.45, 0.005, 'collection efficiency marks (of 5; trajectory 1 as FY23 >= 95 %)');

    near(10 * R.linear(0.90, 1.1, 0.6), 6.04, 0.05, 'DSCR marks (of 10)');
    near(28 * R.linear(0.07, -0.05, 0.9) + 7, 31.37, 0.1, 'ACS-ARR gap marks (of 35)');
    near(2 * R.linear(15.37 / 15.50, 1, 1.2), 2.00, 1e-9, 'distribution loss vs approved (of 2)');
    near(10 * R.linear(0.27, 1, 0.4), 0, 1e-9, 'adjusted quick ratio (of 10)');
    assert.equal(R.step(162, [[60, 10], [75, 8], [90, 6]], 0), 0, 'days payable (step scale)');
    assert.equal(R.step(70, [[60, 10], [75, 8], [90, 6]], 0), 8);
    // totals: base 66.89, tariff-cycle disincentive -1.50 → 65.39 (grade A on the IR scale, >= 65)
    near(47.41 + 8.33 + 11.14, 66.88, 0.01, 'pillar sum');
    near(66.89 - 1.5, 65.39, 1e-9, 'with disincentive');
    // CSRD FY25: WBSEDCL 76.8 is B+ on the CSRD bands this rating uses
    assert.equal(R.gradeOf(76.8), 'B+');
});

test('grade bands are the CSRD family with inclusive lower bounds', () => {
    const cases = [[100, 'A+'], [90, 'A+'], [89.99, 'A'], [80, 'A'], [79.99, 'B+'], [70, 'B+'], [69.99, 'B'], [60, 'B'],
        [59.99, 'C+'], [50, 'C+'], [49.99, 'C'], [40, 'C'], [39.99, 'D'], [0, 'D']];
    for (const [s, g] of cases) assert.equal(R.gradeOf(s), g, String(s));
    assert.deepEqual(R.BANDS.map((b) => b.grade), ['A+', 'A', 'B+', 'B', 'C+', 'C', 'D']);
    assert.deepEqual(R.bandOf('B'), { grade: 'B', min: 60, max: 70, label: 'Fair' });
});

test('weights sum to 100 and every threshold names a source', () => {
    assert.equal(R.PILLARS.reduce((s, p) => s + p.weight, 0), 100);
    for (const pl of R.PILLARS) {
        assert.equal(pl.params.reduce((s, p) => s + p.max, 0), pl.weight, pl.id + ' parameter marks = pillar weight');
        for (const p of pl.params) {
            assert.ok(R.SOURCES[p.source], p.id + ' source');
            assert.ok(p.ref && p.ref.length > 10, p.id + ' reference text');
            assert.ok(p.full !== p.zero, p.id + ' thresholds differ');
            assert.equal(p.direction === 'lower', p.full < p.zero, p.id + ' direction matches thresholds');
        }
    }
});

// ---- whole offices --------------------------------------------------------------------------------
test('all full marks gives 100 (A+); all zero gives 0 (D)', () => {
    const d = R.rate(docOf({ '1': office('ccc', 'Best', null, perfect()), '2': office('ccc', 'Worst', null, worst()) }));
    assert.equal(d.offices['1'].score, 100); assert.equal(d.offices['1'].grade, 'A+');
    assert.equal(d.offices['2'].score, 0); assert.equal(d.offices['2'].grade, 'D');
    for (const pl of d.offices['1'].pillars) assert.equal(pl.marks, pl.weight, pl.id);
});

test('a metric that is n/a at the level gives its marks to the rest of its pillar', () => {
    const m = perfect();
    m.feeder_outage_count = { value: null, numerator: null, denominator: null, quality: { status: 'na', flags: ['level_not_available'], reason: 'no CCC column' } };
    m.dtr_weighted_outage_hours.value = 14.6; // availability 98.0 %: (98 - 96.75) / 1.75 = 0.714
    const d = R.rate(docOf({ c: office('ccc', 'X', null, m) }));
    const o = d.offices.c, rel = PL(o, 'reliability'), av = P(o, 'supply_availability'), it = P(o, 'interruptions');
    assert.equal(it.status, 'na'); assert.equal(it.naCode, 'level'); assert.equal(it.naReason, 'no CCC column'); assert.equal(it.effMax, 0);
    assert.equal(av.effMax, 15, 'availability now carries the whole pillar');
    near(av.marks, 15 * (100 * (1 - 12 * 14.6 / 8760) - 96.75) / 1.75, 0.01);
    assert.equal(rel.max, 15); assert.equal(rel.na, false);
    near(o.score, 85 + av.marks, 0.01);
    assert.match(it.reweight, /go to the other Reliability parameters/);
});

test('small bases, low coverage, stale data and no cases are n/a, never zero', () => {
    const m = perfect();
    m.mc_pending_over_30d_share = e(100, { numerator: 3, denominator: 3, quality: { status: 'warn', flags: ['small_base'] } });
    m.nsc_wo_delay_avg = e(80, { quality: { status: 'stale', flags: ['stale'] }, asOn: '2025-01-01' });
    m.load_ext_pending_over_90d_share = e(null, { quality: { status: 'ok', flags: ['no_cases'] } });
    const d = R.rate(docOf({ c: office('ccc', 'X', null, m) }));
    const o = d.offices.c;
    assert.equal(P(o, 'master_cards').naCode, 'small_base');
    assert.equal(P(o, 'nsc_wo_delay').naCode, 'stale');
    assert.equal(P(o, 'load_ext_beyond_sop').naCode, 'no_cases');
    assert.equal(o.score, 100, 'the rest still earns every mark');
    near(P(o, 'nsc_beyond_sop').effMax, 8 * 20 / 12, 1e-2);
    near(P(o, 'defective_meters').effMax, 8 * 25 / 21, 1e-2);
});

test('a pillar with nothing measurable gives its weight to the other pillars', () => {
    const m = perfect();
    m.dtr_weighted_outage_hours = e(5, { quality: { status: 'warn', flags: ['low_match_coverage'] } });
    m.feeder_outage_count = { value: null, quality: { status: 'na' } };
    const d = R.rate(docOf({ c: office('ccc', 'X', null, m) }));
    const o = d.offices.c;
    assert.equal(PL(o, 'reliability').na, true);
    assert.equal(PL(o, 'reliability').max, 0);
    near(PL(o, 'loss').max, 30 * 100 / 85, 0.01);
    near(o.pillars.reduce((s, p) => s + p.max, 0), 100, 0.02);
    assert.equal(o.score, 100);
    assert.equal(P(o, 'supply_availability').naCode, 'coverage');
});

test('offices with too little measurable are not graded or ranked', () => {
    const m = perfect();
    for (const k of ['atc_loss', 'distribution_loss', 'collection_efficiency', 'receivable_days', 'atc_loss_change_yoy', 'nsc_pending_over_30d_share', 'nsc_wo_delay_avg', 'defective_meter_share', 'unbilled_3m_per_10k'])
        m[k] = { value: null, quality: { status: 'no_data' } };
    const d = R.rate(docOf({ a: office('ccc', 'A', null, m), b: office('ccc', 'B', null, perfect()) }));
    assert.equal(d.offices.a.rated, false); assert.equal(d.offices.a.grade, null); assert.equal(d.offices.a.score, null); assert.equal(d.offices.a.rank, null);
    assert.ok(d.offices.a.measurable < 60);
    assert.equal(d.offices.b.rank, 1); assert.equal(d.offices.b.of, 1);
    assert.deepEqual(d.levels.ccc.order, ['b', 'a']);
});

test('penalties subtract, are capped, and are never applied on stale data', () => {
    const fresh = perfect(); fresh.accidents_fatal_12m = e(5); // 5 per lakh → -4
    fresh.safety_rectification_share = e(40, { numerator: 20, denominator: 50 }); // 60 % unrectified → -1
    const stale = perfect(); stale.accidents_fatal_12m = e(9, { asOn: '2025-06-21', quality: { status: 'stale', flags: ['stale'] } });
    const zero = perfect();
    const d = R.rate(docOf({ f: office('ccc', 'F', null, fresh), s: office('ccc', 'S', null, stale), z: office('ccc', 'Z', null, zero) }));
    assert.equal(d.offices.f.penaltyTotal, -5); assert.equal(d.offices.f.score, 95);
    const fp = d.offices.f.penalties.find((p) => p.id === 'fatal_accidents');
    assert.equal(fp.applied, true); assert.equal(fp.marks, -4);
    const sp = d.offices.s.penalties.find((p) => p.id === 'fatal_accidents');
    assert.equal(sp.applied, false); assert.equal(sp.marks, 0); assert.match(sp.naReason, /stale|older than/);
    assert.equal(d.offices.s.score, d.offices.z.score, 'stale accident data neither costs nor earns anything');
    assert.ok(d.offices.s.why.some((t) => /not applied/.test(t)));
    for (const o of Object.values(d.offices)) for (const p of o.penalties) assert.ok(p.marks <= 0);
    // the cap holds even when both penalties are at their worst
    const both = perfect(); both.accidents_fatal_12m = e(50); both.safety_rectification_share = e(0, { numerator: 0, denominator: 50 });
    const d2 = R.rate(docOf({ x: office('ccc', 'X', null, both) }));
    assert.equal(d2.offices.x.penaltyTotal, -5);
});

// ---- levels ---------------------------------------------------------------------------------------
test('each level is scored on its own summed inputs, not the average of its children', () => {
    // Two CCCs at 10 % and 40 % AT&C (mean 25 %: zero marks); the division's own summed input gives 21 %.
    const c1 = perfect(), c2 = perfect(), dv = perfect();
    Object.assign(c1.atc_loss, { value: 10, numerator: 10, denominator: 100 });
    Object.assign(c2.atc_loss, { value: 40, numerator: 4, denominator: 10 });
    Object.assign(dv.atc_loss, { value: 21, numerator: 23.1, denominator: 110 });
    const d = R.rate(docOf({ D: office('division', 'Div', null, dv), A: office('ccc', 'A', 'D', c1), B: office('ccc', 'B', 'D', c2) }));
    near(P(d.offices.D, 'atc_loss').marks, 10 * (25 - 21) / 10, 1e-9, 'division marks from its own 21 %');
    assert.equal(P(d.offices.A, 'atc_loss').marks, 10);
    assert.equal(P(d.offices.B, 'atc_loss').marks, 0);
    assert.deepEqual(d.offices.D.children, ['A', 'B']);
    assert.deepEqual(d.offices.A.path, { ccc: 'A', division: 'D' });
    // children's excess over 15 % adds up to the division's: A is 5 MU under, B 2.5 MU over, and the
    // rest (9.1 MU) is booked at the division itself; the division is 6.6 MU over
    const c = d.offices.D.contributions.atc_loss;
    assert.equal(c.parentExcess, 6.6);
    const rows = Object.fromEntries(c.rows.map((r) => [r.own ? 'own' : r.code, r]));
    assert.equal(rows.B.excess, 2.5); assert.equal(rows.A.excess, -5); assert.equal(rows.own.excess, 9.1);
    assert.equal(rows.A.share, 0); near(rows.B.share, 2.5 / 6.6, 0.001);
    near(c.rows.reduce((s, r) => s + r.excess, 0), c.parentExcess, 1e-9);
});

test('the real sample: summed inputs add up across levels (loss sheet)', () => {
    const offs = SAMPLE.offices;
    for (const [code, o] of Object.entries(offs)) {
        const a = o.metrics.atc_loss;
        near(a.value, 100 * a.numerator / a.denominator, 0.002, code + ' AT&C = 100 × num ÷ den');
        if (o.level === 'division') {
            const kids = Object.values(offs).filter((k) => k.parent === code);
            near(kids.reduce((s, k) => s + k.metrics.atc_loss.denominator, 0), a.denominator, 0.05, code + ' input = Σ CCC input');
        }
        if (o.level === 'region') {
            const kids = Object.values(offs).filter((k) => k.parent === code);
            const sum = kids.reduce((s, k) => s + k.metrics.atc_loss.denominator, 0);
            assert.ok(a.denominator > sum, code + ' region input includes HT input booked at the region');
            assert.ok((a.quality.flags || []).includes('includes_own_level_rows'));
        }
    }
});

// ---- ranks ----------------------------------------------------------------------------------------
test('ranks: competition ranking within a level, ties share a rank', () => {
    const rk = R.rank([{ code: 'a', name: 'A', score: 70 }, { code: 'b', name: 'B', score: 80 }, { code: 'c', name: 'C', score: 70.001 }, { code: 'd', name: 'D', score: 60 }, { code: 'e', name: 'E', score: null }]);
    assert.deepEqual(rk.ranks, { b: 1, a: 2, c: 2, d: 4 });
    assert.deepEqual(rk.order, ['b', 'a', 'c', 'd']);
    assert.equal(rk.of, 4);
    // ranks are per level: a region and a CCC never share a ranking
    const d = R.rate(docOf({ r: office('region', 'R', null, worst()), c1: office('ccc', 'C1', 'r', perfect()), c2: office('ccc', 'C2', 'r', worst()) }));
    assert.equal(d.offices.r.rank, 1); assert.equal(d.offices.r.of, 1);
    assert.equal(d.offices.c1.rank, 1); assert.equal(d.offices.c2.rank, 2); assert.equal(d.offices.c2.of, 2);
});

// ---- explanations ---------------------------------------------------------------------------------
test('"what would move it up": the single-parameter target reaches the next grade exactly', () => {
    const d = R.rate(SAMPLE);
    let checked = 0;
    for (const o of Object.values(d.offices)) {
        if (!o.rated) continue;
        assert.ok(o.why.length >= 2, o.code + ' why');
        assert.match(o.why[0], new RegExp('gives ' + o.grade.replace('+', '\\+')));
        for (const it of o.improve) {
            assert.ok(it.gain > 0);
            if (!it.nextGrade || checked > 25) continue;
            // set that one metric to the target value and re-rate
            const m = clone(SAMPLE);
            const mo = m.offices[o.code].metrics;
            const id = it.param;
            const cfg = R.PILLARS.flatMap((p) => p.params).find((p) => p.id === id);
            if (cfg.value) continue; // derived parameters: covered by the linear inverse test above
            mo[cfg.metric].value = it.toNext;
            const d2 = R.rate(m);
            near(d2.offices[o.code].score, R.BANDS.find((b) => b.grade === it.nextGrade).min, 0.02, o.name + ' ' + id);
            checked++;
        }
    }
    assert.ok(checked > 10, 'checked ' + checked + ' improvements');
});

test('deterministic, and the input is not changed', () => {
    const before = JSON.stringify(SAMPLE);
    const a = JSON.stringify(R.rate(SAMPLE));
    const b = JSON.stringify(R.rate(clone(SAMPLE)));
    assert.equal(a, b);
    assert.equal(JSON.stringify(SAMPLE), before);
    // key order of the offices does not matter
    const shuffled = clone(SAMPLE);
    shuffled.offices = Object.fromEntries(Object.entries(shuffled.offices).reverse());
    assert.equal(JSON.stringify(R.rate(shuffled)), a);
});

test('the real sample: shape, levels and arithmetic', () => {
    const d = R.rate(SAMPLE);
    assert.equal(d.engine, R.VERSION);
    assert.deepEqual(Object.fromEntries(Object.entries(d.levels).map(([k, v]) => [k, v.order.length])), { zone: 1, region: 3, division: 7, ccc: 41 });
    assert.equal(d.offices[d.zone].level, 'zone');
    assert.equal(d.methodology.filter((r) => r.kind === 'parameter').length, R.PILLARS.reduce((s, p) => s + p.params.length, 0));
    for (const o of Object.values(d.offices)) {
        if (!o.rated) continue;
        near(o.pillars.reduce((s, p) => s + p.max, 0), 100, 0.03, o.code + ' maxima');
        near(o.pillars.reduce((s, p) => s + p.marks, 0) + o.penaltyTotal, o.score, 0.03, o.code + ' score = Σ marks + penalties');
        for (const p of o.pillars) {
            assert.ok(p.marks <= p.max + 0.01, o.code + ' ' + p.id);
            near(p.params.reduce((s, x) => s + (x.marks || 0), 0), p.marks, 0.03, o.code + ' ' + p.id + ' params');
            for (const x of p.params) if (x.status === 'na') assert.ok(x.naReason, o.code + ' ' + x.id + ' n/a reason');
        }
        assert.ok(o.rank >= 1 && o.rank <= o.of);
        assert.equal(o.grade, R.gradeOf(o.score));
    }
    // the CCC reliability parameter that has no CCC data is n/a at every CCC, never scored
    for (const c of d.levels.ccc.order) assert.equal(P(d.offices[c], 'interruptions').naCode, 'level');
    // stale safety data: no office gets a penalty this month
    for (const o of Object.values(d.offices)) assert.equal(o.penaltyTotal, 0);
});
