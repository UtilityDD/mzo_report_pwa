/* lib/rating.js: the MZO office performance rating, modelled on the national DISCOM ratings
 * (REC Consumer Service Rating of DISCOMs, PFC Integrated Rating, RDSS targets, WBERC standards).
 * Shared by the browser (window.MzoRating) and Node (require). Pure and deterministic: the same
 * metrics document always gives the same rating document, byte for byte (no clock, no locale,
 * no randomness). No dependencies.
 *
 *   rate(metricsDoc, opts) -> ratingDoc     the whole rating (docs/rating/engine-contract.md)
 *   METHOD                                  pillars, parameters, thresholds, sources, bands, rules
 *   linear(value, full, zero)               the national "proportionate" scale: 1 at full, 0 at zero
 *   gradeOf(score)                          CSRD grade band of a score
 *   rank(list)                              competition ranks on the rounded score (1, 2, 2, 4)
 *   weighted3(t, t1, t2)                    the PFC 3-year weighting 60/25/15 (used in tests)
 *   step(value, steps)                      PFC step scales (days payable; used in tests)
 *
 * Input: the shape of docs/rating/sample-metrics.json (scripts/rating/compute-metrics.js or
 * lib/rating_metrics.js). Method and sources: docs/rating/methodology.md.
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.MzoRating = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const VERSION = 'rating/1';

// ---- grade bands: the CSRD family (REC CSRD FY24 p.73, FY25 PDF p.37) -----------------------
const BANDS = [
    { grade: 'A+', min: 90, label: 'Excellent' },
    { grade: 'A', min: 80, label: 'Very good' },
    { grade: 'B+', min: 70, label: 'Good' },
    { grade: 'B', min: 60, label: 'Fair' },
    { grade: 'C+', min: 50, label: 'Below average' },
    { grade: 'C', min: 40, label: 'Poor' },
    { grade: 'D', min: -Infinity, label: 'Very poor' }
];

// Sources, cited by key from every threshold (full text in docs/rating/sources.md).
const SOURCES = {
    RDSS: 'RDSS Guidelines v7 (MoP, 22.09.2023)',
    IR14: 'PFC 14th Integrated Rating, FY 2024-25',
    CSRD: 'REC Consumer Service Rating of DISCOMs, FY21-FY25 (Annex E)',
    WBERC_SOP: 'WBERC Standards of Performance, Reg. 46/WBERC (2010) as amended by 57/WBERC (2013) and later',
    WBERC_TARIFF: 'WBERC Tariff Regulations 2026 (82/WBERC)',
    ROC: 'Electricity (Rights of Consumers) Rules 2020, as amended 2022 and 2024',
    ZONE: 'Zone choice (no national or WBERC benchmark for this office-level measure)'
};

// ---- parameters ---------------------------------------------------------------------------
// value(o) -> { value, numerator, denominator, asOn, entry } from the office's metric entries.
// full / zero: the thresholds of the linear scale (full marks at `full`, zero marks at `zero`).
// gap(entry, param): the office's excess over the full-marks level, in the numerator's unit, so
// that children's excesses add up to the parent's (used for "how each child contributes").

const pct = (e) => (e ? e.value : null);
function ratioGap(scale, dir) {
    // value = scale × num / den; excess over `full` in numerator units.
    return function (e, p) {
        if (!e || e.numerator == null || e.denominator == null) return null;
        const at = p.full * e.denominator / scale;
        return dir === 'lower' ? e.numerator - at : at - e.numerator;
    };
}

const PILLARS = [
    {
        id: 'loss', label: 'Loss & revenue', short: 'Loss', weight: 30,
        basis: 'PFC Integrated Rating, Performance Excellence (billing and collection efficiency, distribution loss vs approved) and RDSS AT&C targets. Company-level finance (ACS-ARR gap, DSCR, subsidy, tariff) is left out: offices do not control it.',
        params: [
            {
                id: 'atc_loss', metric: 'atc_loss', label: 'AT&C loss', unit: '%', direction: 'lower', max: 10,
                full: 15, zero: 25, source: 'RDSS', ref: 'RDSS 2.1.1 (AT&C 12-15 % target); 3.2.2.2 (divisions above 25 % are priority loss areas)',
                formula: '100 × (input − min(collection, billed)) ÷ input, MU, 12 months to the latest month',
                gap: ratioGap(100, 'lower'), gapUnit: 'MU'
            },
            {
                id: 'dist_loss_vs_target', metric: 'distribution_loss', label: 'Distribution loss vs the office target', unit: '× target', direction: 'lower', max: 6,
                full: 1.0, zero: 1.2, source: 'IR14', ref: 'IR14 B1: actual ÷ approved loss, ≤ 1 full, > 1.2 zero; the office target is WBSEDCL\'s (loss_targets)',
                formula: 'distribution loss ÷ the office\'s target distribution loss (loss_targets)',
                value(o) {
                    const e = o.metrics.distribution_loss;
                    if (!e || e.value == null || !(e.target > 0)) return { value: null, entry: e, why: e && e.value != null ? 'no target for this office' : null };
                    return { value: e.value / e.target, numerator: e.value, denominator: e.target, entry: e, show: e.value.toFixed(2) + ' % vs target ' + e.target.toFixed(2) + ' %' };
                },
                gap(e) { return e && e.numerator != null && e.target > 0 ? e.numerator - e.target / 100 * e.denominator : null; }, gapUnit: 'MU'
            },
            {
                id: 'collection_efficiency', metric: 'collection_efficiency', label: 'Collection efficiency', unit: '%', direction: 'higher', max: 6,
                full: 99.5, zero: 91, source: 'IR14', ref: 'IR14 B3 absolute scale (≥ 99.5 % full, < 91 % zero); RDSS 3.1.5.4(xv) national target ≥ 98 %',
                formula: '100 × collection ÷ billed, MU (capped at 100 as in the loss sheet)',
                gap: ratioGap(100, 'higher'), gapUnit: 'MU'
            },
            {
                id: 'receivable_days', metric: 'receivable_days', label: 'Receivables', unit: 'days', direction: 'lower', max: 5,
                full: 60, zero: 120, source: 'IR14', ref: 'IR14 A2 days receivable (≤ 60 full, > 120 zero), on collection instead of revenue',
                formula: 'OSD of live consumers ÷ average daily collection over 12 months (LT; HT collections at regions excluded)',
                gap: ratioGap(1, 'lower'), gapUnit: '₹ lakh'
            },
            {
                id: 'atc_trend', metric: 'atc_loss_change_yoy', label: 'AT&C loss trend on a year earlier', unit: '% change', direction: 'lower', max: 3,
                full: -5, zero: 0, source: 'IR14', ref: 'IR14 trajectory marks (1-year improvement better than 5 %); RDSS REM 4.12.8 (no marks if the same or worse)',
                formula: '100 × (AT&C now − AT&C a year earlier) ÷ AT&C a year earlier',
                value(o) {
                    const e = o.metrics.atc_loss_change_yoy, i = e && e.inputs;
                    if (!i || i.current == null || !(i.yearEarlier > 0)) return { value: null, entry: e };
                    return { value: 100 * (i.current - i.yearEarlier) / i.yearEarlier, numerator: i.current, denominator: i.yearEarlier, entry: e,
                        show: i.yearEarlier.toFixed(2) + ' % → ' + i.current.toFixed(2) + ' %' };
                }
            }
        ]
    },
    {
        id: 'reliability', label: 'Reliability', short: 'Reliability', weight: 15,
        basis: 'CSRD Operational Reliability (45 nationally), weighted down to 15: we have feeder outage logs only, no consumers per feeder and no DT failure register, and CCCs are reached through a feeder-name match to the DT list.',
        params: [
            {
                id: 'supply_availability', metric: 'dtr_weighted_outage_hours', label: 'Supply availability', unit: '%', direction: 'higher', max: 9,
                full: 98.5, zero: 96.75, source: 'WBERC_TARIFF', ref: 'WBERC Tariff Regs 2026 Reg 96.2 (availability = 1 − SAIDI/8760), 96.3 (norm 98 %), 96.4 (incentive above 98.5 %), 96.5 (maximum disincentive at 96.75 %)',
                formula: '100 × (1 − 12 × outage hours a DT saw per month ÷ 8,760); outages over 5 minutes, 12 report months',
                value(o) {
                    const e = o.metrics.dtr_weighted_outage_hours;
                    if (!e || e.value == null) return { value: null, entry: e };
                    return { value: 100 * (1 - 12 * e.value / 8760), numerator: e.numerator, denominator: e.denominator, entry: e, show: (12 * e.value).toFixed(0) + ' outage hours a year' };
                },
                gap(e) { return e && e.numerator != null ? e.numerator - e.denominator * (1 - 98.5 / 100) * 8760 / 12 : null; }, gapUnit: 'DT-hours'
            },
            {
                id: 'interruptions', metric: 'feeder_outage_count', label: 'Interruptions per feeder', unit: 'a year', direction: 'lower', max: 6,
                full: 60, zero: 720, source: 'CSRD', ref: 'CSRD 1.2 interruption index, rural scale (< 60 a year full, > 720 zero)',
                formula: '12 × outages over 5 minutes per 11 kV feeder per month, 12 report months',
                value(o) {
                    const e = o.metrics.feeder_outage_count;
                    if (!e || e.value == null) return { value: null, entry: e };
                    return { value: 12 * e.value, numerator: e.numerator, denominator: e.denominator, entry: e };
                },
                gap(e) { return e && e.numerator != null ? e.numerator - 60 / 12 * e.denominator : null; }, gapUnit: 'outages'
            }
        ]
    },
    {
        id: 'connection', label: 'Connection services', short: 'Connections', weight: 20,
        basis: 'CSRD Connection and Other Services (10 nationally), weighted up to 20: the pending lists for new connections, load extensions and rooftop solar are complete and current. Timelines are WBERC\'s binding ones; the 2024 national limits are shown as a stretch reference, not scored.',
        params: [
            {
                id: 'nsc_beyond_sop', metric: 'nsc_pending_over_30d_share', label: 'Paid new connections pending beyond 30 days', unit: '%', direction: 'lower', max: 8,
                full: 20, zero: 80, source: 'ZONE', ref: 'Timeline: WBERC Reg 4.1 (30 days where the distributing main exists). Scale: zone choice, spanning the CCCs today (quartiles 48 / 64 / 75 %)',
                stretch: 'National limit (Rules 2024, rule 4(11)): 3 days metro, 7 other municipal, 15 rural',
                formula: '100 × paid applications pending more than 30 days since payment ÷ paid applications pending',
                gap: ratioGap(100, 'lower'), gapUnit: 'applications'
            },
            {
                id: 'nsc_wo_delay', metric: 'nsc_wo_delay_avg', label: 'Days from payment to work order', unit: 'days', direction: 'lower', max: 4,
                full: 7, zero: 30, source: 'ZONE', ref: 'Zone choice: by 30 days the whole WBERC connection timeline is used up; a week leaves time to build',
                formula: 'average days from quotation payment to work order, pending applications with a work order',
                gap: ratioGap(1, 'lower'), gapUnit: 'application-days'
            },
            {
                id: 'load_ext_beyond_sop', metric: 'load_ext_pending_over_90d_share', label: 'Load extensions pending 3 months or more', unit: '%', direction: 'lower', max: 4,
                full: 20, zero: 80, source: 'ZONE', ref: 'Timeline: WBERC Reg 4.2 (57/WBERC), longest LV/MV augmentation 90 days. Scale: zone choice, as for new connections',
                formula: '100 × load extensions pending 3 months or more ÷ load extensions pending',
                gap: ratioGap(100, 'lower'), gapUnit: 'applications'
            },
            {
                id: 'solar_beyond_sop', metric: 'solar_pending_over_30d_share', label: 'Rooftop solar not connected after 30 days', unit: '%', direction: 'lower', max: 4,
                full: 20, zero: 80, source: 'ZONE', ref: 'Timeline: Rights of Consumers Rules 2020, rule 11 (commissioning within 30 days). Scale: zone choice, as for new connections',
                stretch: 'National limit (2024 amendment): 15 days',
                formula: '100 × applications older than 30 days not yet connected ÷ applications older than 30 days',
                gap: ratioGap(100, 'lower'), gapUnit: 'applications'
            }
        ]
    },
    {
        id: 'metering', label: 'Metering & billing', short: 'Metering', weight: 25,
        basis: 'CSRD Metering, Billing and Collection (35 nationally; collection efficiency sits in Loss & revenue here). Bills on actual reading, digital payments, prepaid and SMS coverage have no office-level data and are not scored.',
        params: [
            {
                id: 'defective_meters', metric: 'defective_meter_share', label: 'Defective meters', unit: '% of live', direction: 'lower', max: 8,
                full: 5, zero: 35, source: 'ZONE', ref: 'Zone choice: WBERC Reg 11 asks for replacement within 7-30 days, so the stock should be small; 5 % is about the best CCC, 35 % is past the worst division',
                formula: '100 × defective meters (summary) ÷ live consumers',
                gap: ratioGap(100, 'lower'), gapUnit: 'meters'
            },
            {
                id: 'defective_old', metric: 'defective_over5y_share', label: 'Defective meters older than 5 years', unit: '% of defective', direction: 'lower', max: 3,
                full: 10, zero: 70, source: 'ZONE', ref: 'Zone choice: a meter defective for 5 years has missed every WBERC timeline; the scale spans the CCCs today',
                formula: '100 × defective meters with a defect over 5 years old ÷ defective meters',
                gap: ratioGap(100, 'lower'), gapUnit: 'meters'
            },
            {
                id: 'unbilled_3m', metric: 'unbilled_3m_per_10k', label: 'Consumers unbilled for 3 months', unit: 'per 10,000', direction: 'lower', max: 5,
                full: 1, zero: 15, source: 'ZONE', ref: 'CSRD 3.6 expects every required bill; scale: zone choice spanning the CCCs today',
                formula: 'existing consumers unbilled for 3 months ÷ live consumers × 10,000',
                gap: ratioGap(10000, 'lower'), gapUnit: 'consumers'
            },
            {
                id: 'first_bill', metric: 'first_bill_pending_per_10k', label: 'New connections without a first bill', unit: 'per 10,000', direction: 'lower', max: 5,
                full: 1, zero: 15, source: 'ZONE', ref: 'Rights of Consumers Rules 2020, rule 6(7): first bill within two billing cycles. Scale: zone choice',
                formula: 'live connections without a first bill ÷ live consumers × 10,000',
                gap: ratioGap(10000, 'lower'), gapUnit: 'consumers'
            },
            {
                id: 'master_cards', metric: 'mc_pending_over_30d_share', label: 'Master cards pending over 30 days', unit: '%', direction: 'lower', max: 4,
                full: 10, zero: 60, source: 'ZONE', ref: 'Zone choice: a meter installed 30 days ago without a master card misses the first billing cycle (Rules 2020, rule 6(7))',
                formula: '100 × master cards pending more than 30 days after meter installation ÷ master cards pending',
                gap: ratioGap(100, 'lower'), gapUnit: 'master cards'
            }
        ]
    },
    {
        id: 'grievance', label: 'Faults & grievances', short: 'Faults', weight: 10,
        basis: 'CSRD Fault Rectification and Grievance Redressal (10 nationally). Call-centre items are company-level; closed-docket times stop in June 2025, so open dockets are measured instead.',
        params: [
            {
                id: 'fault_dockets', metric: 'fault_dockets_open_over_24h_per_10k', label: 'Fault dockets open over 24 hours', unit: 'per 10,000', direction: 'lower', max: 6,
                full: 1, zero: 10, source: 'ZONE', ref: 'Timeline: WBERC Reg 9.1 (most faults restored within 24 hours). Scale: zone choice spanning the CCCs today',
                formula: 'technical dockets open 24 hours or more ÷ live consumers × 10,000',
                gap: ratioGap(10000, 'lower'), gapUnit: 'dockets'
            },
            {
                id: 'open_dockets', metric: 'docket_open_per_10k', label: 'All dockets still open', unit: 'per 10,000', direction: 'lower', max: 2,
                full: 5, zero: 50, source: 'ZONE', ref: 'Zone choice: an open docket is an unresolved complaint as far as the record goes (Rules 2020, rule 14 CRM)',
                formula: 'open dockets ÷ live consumers × 10,000',
                gap: ratioGap(10000, 'lower'), gapUnit: 'dockets'
            },
            {
                id: 'cmo_pending', metric: 'cmo_open_share', label: 'CMO grievances pending with an MZO officer', unit: '%', direction: 'lower', max: 2,
                full: 5, zero: 30, source: 'ZONE', ref: 'Zone choice; grievances name only the district, so this is scored for regions and the zone',
                formula: '100 × grievances pending with an MZO officer ÷ grievances on the report',
                gap: ratioGap(100, 'lower'), gapUnit: 'grievances'
            }
        ]
    }
];

// Penalties, like the IR's disincentives: they only subtract, are capped, and are never applied
// on stale data (so missing data can never improve a score).
const PENALTY_CAP = 5;
const PENALTIES = [
    {
        id: 'fatal_accidents', metric: 'accidents_fatal_12m', label: 'Fatal electrical accidents', unit: 'per lakh consumers', max: 4,
        none: 0, worst: 5, source: 'ZONE', ref: 'Modelled on IR14 Pillar D (capped disincentives); scale: zone choice, one fatal accident in an average CCC (55,000 consumers) costs about 1.5 marks',
        formula: 'fatal accidents to people in 12 months ÷ live consumers × 1,00,000',
        value(o) {
            const e = o.metrics.accidents_fatal_12m, l = o.metrics.live_consumers;
            if (!e || e.value == null || !l || !(l.value > 0)) return { value: null, entry: e };
            return { value: 1e5 * e.value / l.value, numerator: e.value, denominator: l.value, entry: e, show: e.value + ' in 12 months' };
        }
    },
    {
        id: 'unsafe_sites', metric: 'safety_rectification_share', label: 'Unsafe sites not rectified', unit: '%', max: 1,
        none: 10, worst: 50, source: 'ZONE', ref: 'Modelled on IR14 Pillar D; scale: zone choice',
        formula: '100 − share of unsafe sites found in safety inspections that are rectified',
        value(o) {
            const e = o.metrics.safety_rectification_share;
            if (!e || e.value == null) return { value: null, entry: e };
            return { value: 100 - e.value, numerator: e.denominator != null && e.numerator != null ? e.denominator - e.numerator : null, denominator: e.denominator, entry: e };
        }
    }
];

const RULES = {
    minRatedWeight: 60, // an office needs at least 60 of the 100 base marks measurable to get a grade
    excludeStatuses: ['stale', 'na', 'no_data'],
    excludeFlags: ['small_base', 'low_match_coverage'],
    // dataset caveats: scored, with the caveat shown next to the value
    noteFlags: {
        includes_own_level_rows: 'Includes rows booked at this office itself (HT / bulk / office-level), which no child office carries.',
        base_month_outlier: 'The year-earlier loss row was misplaced in the sheet (swapped CCC rows in Sep 2025); the median of Aug-Oct 2025 is the base.',
        feeder_name_match: 'Feeders are tied to CCCs through the DT list by substation and feeder name (84 % of DTs zone-wide).',
        ht_region_collections_excluded: 'LT only: HT collections booked at region offices are left out, because the OSD sheet has no HT rows.',
        details_mixed_as_on_not_used: 'Only the defective-meter summary (all as on one date) is used; the details tab mixes two dumps.',
        storage_copy_behind_sheet: 'The app\'s copy of pending master cards (Supabase Storage) is two days behind the Google sheet.',
        no_date_in_sheet: 'The sheet has no report date of its own.',
        columns_inferred_from_page_labels: 'Column meaning follows the Important data page (merged headers are lost in the export).',
        as_on_from_work_order_tab: 'The date is the work-order tab\'s, as the dashboard shows.',
        pending_withheld_overlap_12: 'A few applications are in both the pending and the withheld list.'
    }
};

const METHOD = { version: VERSION, bands: BANDS, pillars: PILLARS, penalties: PENALTIES, penaltyCap: PENALTY_CAP, rules: RULES, sources: SOURCES };

// ---- scoring primitives --------------------------------------------------------------------

/** Linear ("proportionate") scale: 1 at or beyond `full`, 0 at or beyond `zero`. Works both ways. */
function linear(value, full, zero) {
    if (value == null || !isFinite(value)) return null;
    if (full === zero) return value === full ? 1 : 0;
    const f = (value - zero) / (full - zero);
    return f <= 0 ? 0 : f >= 1 ? 1 : f;
}
/** The value at which the linear scale gives fraction f. */
function inverse(f, full, zero) { return zero + f * (full - zero); }

/** PFC step scale: steps = [[limit, marks], ...] checked in order with value <= limit; else last. */
function step(value, steps, otherwise) {
    for (const [limit, marks] of steps) if (value <= limit) return marks;
    return otherwise;
}
/** PFC 3-year weighted average (60 % year T, 25 % T-1, 15 % T-2). */
function weighted3(t, t1, t2) { return 0.6 * t + 0.25 * t1 + 0.15 * t2; }

function gradeOf(score) {
    if (score == null) return null;
    for (const b of BANDS) if (score >= b.min) return b.grade;
    return 'D';
}
function bandOf(grade) {
    const i = BANDS.findIndex((b) => b.grade === grade);
    return i < 0 ? null : { grade, min: isFinite(BANDS[i].min) ? BANDS[i].min : 0, max: i ? BANDS[i - 1].min : 100, label: BANDS[i].label };
}
const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
const r3 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000);

/** Competition ranks on the score rounded to 2 decimals; ties share a rank. Input: [{code, name, score}]. */
function rank(list) {
    const rated = list.filter((x) => x.score != null).sort((a, b) => (r2(b.score) - r2(a.score)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const out = {};
    let prev = null, at = 0;
    rated.forEach((x, i) => { if (prev === null || r2(x.score) !== prev) { at = i + 1; prev = r2(x.score); } out[x.code] = at; });
    return { ranks: out, order: rated.map((x) => x.code), of: rated.length };
}

// ---- formatting (plain, locale-free) -------------------------------------------------------
function fmt(v, unit) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    const d = unit === '× target' ? 2 : a >= 100 ? 0 : a >= 10 ? 1 : 2;
    const s = v.toFixed(d);
    if (unit === '%' || unit === '% change' || unit === '% of live' || unit === '% of defective') return s + ' %';
    if (unit === '× target') return s + ' ×';
    return s + ' ' + unit;
}

/** A threshold as written in the method (no padding zeros): 5 → "5 %", 0.995 → "0.995". */
function fmtT(v, unit) {
    if (v == null) return '—';
    const s = String(r3(v));
    if (unit === '%' || unit === '% change' || unit === '% of live' || unit === '% of defective') return s + ' %';
    if (unit === '× target') return s + ' ×';
    return s + ' ' + unit;
}

// ---- per office -----------------------------------------------------------------------------

function flagNotes(flags) {
    return (flags || []).filter((f) => RULES.noteFlags[f]).map((f) => ({ flag: f, text: RULES.noteFlags[f] }));
}

/** Is this parameter measurable at this office? → { ok, reason, code } */
function availability(p, got, metricMeta) {
    const e = got.entry;
    if (!e) return { ok: false, code: 'missing', reason: 'not in the metrics input' };
    const q = e.quality || { status: 'ok' };
    const flags = q.flags || [];
    if (q.status === 'na') return { ok: false, code: 'level', reason: q.reason || (metricMeta && metricMeta.naReason) || 'not measurable at this level' };
    if (q.status === 'stale' || flags.includes('stale')) {
        return { ok: false, code: 'stale', reason: 'data as on ' + (e.asOn || '?') + ' is older than ' + ((metricMeta && metricMeta.maxAgeDays) || '?') + ' days' };
    }
    if (flags.includes('small_base')) return { ok: false, code: 'small_base', reason: 'fewer than ' + ((metricMeta && metricMeta.minBase) || '?') + ' cases: too few to judge' };
    if (flags.includes('low_match_coverage')) return { ok: false, code: 'coverage', reason: 'under 60 % of the office\'s DTs are on matched feeders' };
    if (flags.includes('no_cases')) return { ok: false, code: 'no_cases', reason: 'no cases on the list' };
    if (got.value == null) return { ok: false, code: 'no_data', reason: got.why || 'no data for this office' };
    return { ok: true };
}

function getValue(p, o) {
    if (p.value) return p.value(o);
    const e = o.metrics[p.metric];
    return { value: e ? e.value : null, numerator: e ? e.numerator : null, denominator: e ? e.denominator : null, entry: e };
}

function rateOffice(o, doc) {
    const metricsMeta = doc.metrics || {};
    // 1. parameters
    const pillars = PILLARS.map((pl) => {
        const params = pl.params.map((p) => {
            const got = getValue(p, o);
            const av = availability(p, got, metricsMeta[p.metric]);
            const e = got.entry || {};
            const q = e.quality || {};
            return {
                id: p.id, pillar: pl.id, metric: p.metric, label: p.label, unit: p.unit, direction: p.direction,
                value: r3(got.value), display: got.value == null ? '—' : fmt(got.value, p.unit), detail: got.show || null,
                numerator: r3(got.numerator), denominator: r3(got.denominator), asOn: e.asOn || null,
                full: p.full, zero: p.zero, source: p.source,
                max: p.max, effMax: 0, marks: null, fraction: av.ok ? r3(linear(got.value, p.full, p.zero)) : null,
                status: av.ok ? 'scored' : 'na', naCode: av.ok ? null : av.code, naReason: av.ok ? null : av.reason,
                quality: { status: q.status || 'ok', flags: (q.flags || []).slice() }, notes: flagNotes(q.flags), reweight: null,
                _f: av.ok ? linear(got.value, p.full, p.zero) : null
            };
        });
        const avail = params.filter((x) => x.status === 'scored');
        return { id: pl.id, label: pl.label, short: pl.short, weight: pl.weight, params, availMax: avail.reduce((s, x) => s + x.max, 0), baseMax: pl.params.reduce((s, x) => s + x.max, 0) };
    });

    // 2. weights: n/a parameters give their marks to the rest of their pillar (pro rata); a pillar with
    //    nothing measurable gives its weight to the other pillars (pro rata).
    const live = pillars.filter((pl) => pl.availMax > 0);
    const liveWeight = live.reduce((s, pl) => s + pl.weight, 0);
    const measurable = pillars.reduce((s, pl) => s + (pl.availMax > 0 ? pl.params.filter((x) => x.status === 'scored').reduce((t, x) => t + x.max * pl.weight / pl.baseMax, 0) : 0), 0);
    const rated = liveWeight > 0 && measurable >= RULES.minRatedWeight;
    let total = 0;
    for (const pl of pillars) {
        pl.effWeight = pl.availMax > 0 && liveWeight > 0 ? pl.weight * 100 / liveWeight : 0;
        pl.na = pl.availMax === 0;
        let marks = 0;
        for (const x of pl.params) {
            if (x.status !== 'scored') {
                x.effMax = 0;
                x.reweight = pl.na ? 'pillar n/a: its ' + pl.weight + ' marks go to the other pillars' : 'n/a: its ' + x.max + ' marks go to the other ' + pl.label + ' parameters';
                continue;
            }
            x.effMax = x.max * pl.effWeight / pl.availMax;
            x.marks = x.effMax * x._f;
            if (Math.abs(x.effMax - x.max) > 1e-9) x.reweight = 'counts ' + r2(x.effMax) + ' of 100 (base ' + x.max + ') after re-weighting';
            marks += x.marks;
        }
        pl.marks = marks;
        pl.max = pl.effWeight;
        pl.note = pl.na ? 'nothing measurable at this office; weight shared by the other pillars'
            : pl.availMax < pl.baseMax ? (pl.baseMax - pl.availMax) + ' of ' + pl.baseMax + ' parameter marks n/a, shared within the pillar'
            : (Math.abs(pl.effWeight - pl.weight) > 1e-9 ? 'weight raised from ' + pl.weight + ' to ' + r2(pl.effWeight) + ' (another pillar is n/a)' : null);
        total += marks;
    }

    // 3. penalties
    let pen = 0;
    const penalties = PENALTIES.map((p) => {
        const got = p.value(o);
        const av = availability(p, got, metricsMeta[p.metric]);
        const f = av.ok ? linear(got.value, p.worst, p.none) : null;
        const marks = av.ok ? -p.max * f : 0;
        pen += marks;
        const e = got.entry || {};
        return {
            id: p.id, metric: p.metric, label: p.label, unit: p.unit, value: r3(got.value), display: got.value == null ? '—' : fmt(got.value, p.unit), detail: got.show || null,
            asOn: e.asOn || null, none: p.none, worst: p.worst, max: p.max, source: p.source,
            applied: av.ok, marks: r2(marks), naCode: av.ok ? null : av.code, naReason: av.ok ? null : 'not applied: ' + av.reason
        };
    });
    pen = Math.max(-PENALTY_CAP, pen);

    const score = rated ? Math.max(0, Math.min(100, total + pen)) : null;
    return { pillars, penalties, penaltyTotal: pen, base: total, score, rated, measurable };
}

// ---- explanations --------------------------------------------------------------------------

function why(off, r) {
    const out = [];
    if (!r.rated) { out.push('Not graded: only ' + r2(r.measurable) + ' of 100 base marks can be measured here (at least ' + RULES.minRatedWeight + ' needed).'); return out; }
    const b = bandOf(off.grade);
    out.push('Score ' + r2(off.score).toFixed(1) + ' of 100 gives ' + off.grade + ' (' + b.label.toLowerCase() + ': ' + b.min + (b.grade === 'A+' ? ' and above' : ' to under ' + b.max) + ').');
    const pl = r.pillars.filter((p) => !p.na).map((p) => ({ p, f: p.max ? p.marks / p.max : 0 })).sort((a, b) => b.f - a.f || (a.p.id < b.p.id ? -1 : 1));
    if (pl.length) {
        const best = pl[0], worst = pl[pl.length - 1];
        out.push('Strongest: ' + best.p.label + ', ' + r2(best.p.marks).toFixed(1) + ' of ' + r2(best.p.max).toFixed(1) + '. Weakest: ' + worst.p.label + ', ' + r2(worst.p.marks).toFixed(1) + ' of ' + r2(worst.p.max).toFixed(1) + '.');
    }
    const zeros = [];
    for (const p of r.pillars) for (const x of p.params) if (x.status === 'scored' && x._f === 0) zeros.push(x.label + ' (' + x.display + ')');
    if (zeros.length) out.push('No marks for ' + zeros.join('; ') + '.');
    const na = [];
    for (const p of r.pillars) for (const x of p.params) if (x.status === 'na' && x.naCode !== 'level') na.push(x.label + ': ' + x.naReason);
    if (na.length) out.push('Not scored here (weight shared within the pillar): ' + na.join('; ') + '.');
    const lv = [];
    for (const p of r.pillars) for (const x of p.params) if (x.status === 'na' && x.naCode === 'level') lv.push(x.label);
    if (lv.length) out.push('Not measurable at this level: ' + lv.join(', ') + '.');
    const pens = r.penalties.filter((p) => p.applied && p.marks < 0);
    if (pens.length) out.push('Penalties: ' + pens.map((p) => p.label + ' ' + p.marks).join(', ') + '.');
    const skipped = r.penalties.filter((p) => !p.applied && p.naCode === 'stale');
    if (skipped.length) out.push('Safety penalties not applied (data stale): ' + skipped.map((p) => p.label + ', as on ' + (p.asOn || '?')).join('; ') + '.');
    return out;
}

function improve(off, r) {
    if (!r.rated) return [];
    const items = [];
    for (const pl of r.pillars) for (const x of pl.params) {
        if (x.status !== 'scored' || x.marks == null) continue;
        const gain = x.effMax - x.marks;
        if (gain < 0.005) continue;
        items.push({ param: x.id, pillar: pl.id, label: x.label, unit: x.unit, from: x.value, fromDisplay: x.display, toFull: x.full, toFullDisplay: fmtT(x.full, x.unit), gain: r2(gain), x });
    }
    items.sort((a, b) => b.gain - a.gain || (a.param < b.param ? -1 : 1));
    const i = BANDS.findIndex((b) => b.grade === off.grade);
    const next = i > 0 ? BANDS[i - 1] : null;
    const need = next ? next.min - off.score : null;
    return items.slice(0, 4).map((it) => {
        const x = it.x;
        const o = { param: it.param, pillar: it.pillar, label: it.label, unit: it.unit, from: it.from, fromDisplay: it.fromDisplay, toFull: it.toFull, toFullDisplay: it.toFullDisplay, gain: it.gain, nextGrade: null, toNext: null, toNextDisplay: null };
        if (next && need > 0 && need <= it.gain + 1e-9) {
            const v = inverse((x.marks + need) / x.effMax, x.full, x.zero);
            o.nextGrade = next.grade; o.toNext = r3(v); o.toNextDisplay = fmt(v, x.unit);
        }
        o.text = it.label + ': ' + (x.direction === 'higher' ? 'raise' : 'bring down') + ' from ' + it.fromDisplay + ' to ' + it.toFullDisplay + ' for +' + it.gain.toFixed(1) + ' marks' +
            (o.nextGrade ? '; ' + o.toNextDisplay + ' alone would lift the grade to ' + o.nextGrade : '') + '.';
        return o;
    });
}

// ---- children's share of a parent's weak parameters -------------------------------------------

function contributions(parent, kids, cfgById) {
    const out = {};
    for (const pl of parent.pillars) for (const x of pl.params) {
        if (x.status !== 'scored' || x.fraction == null || x.fraction >= 0.5) continue;
        const p = cfgById[x.id];
        if (!p.gap) continue;
        const g = (off) => { const e = off._src.metrics[p.metric]; return e && e.quality && e.quality.status === 'na' ? null : p.gap(e, p); };
        const pg = g(parent);
        if (pg == null || !(pg > 0)) continue;
        const rows = kids.map((k) => {
            const kp = k.pillars.find((y) => y.id === pl.id).params.find((y) => y.id === x.id);
            const ex = g(k);
            return { code: k.code, name: k.name, value: kp.value, display: kp.display, excess: r2(ex), share: ex != null && ex > 0 ? r3(ex / pg) : 0 };
        });
        const sum = rows.reduce((s, y) => s + (y.excess || 0), 0);
        const own = pg - sum;
        if (Math.abs(own) > Math.max(0.01, Math.abs(pg) * 0.001)) rows.push({ code: parent.code, name: 'Booked at ' + parent.name + ' itself', own: true, value: null, display: '', excess: r2(own), share: own > 0 ? r3(own / pg) : 0 });
        rows.sort((a, b) => (b.excess || 0) - (a.excess || 0) || (a.name < b.name ? -1 : 1));
        out[x.id] = { label: x.label, unit: p.gapUnit, parentExcess: r2(pg), note: 'Excess over the full-marks level (' + fmtT(p.full, p.unit) + '), in ' + p.gapUnit + '; children add up to the parent', rows };
    }
    return out;
}

// ---- methodology rows (the Methodology tab) ------------------------------------------------

function methodologyRows() {
    const rows = [];
    for (const pl of PILLARS) for (const p of pl.params) {
        rows.push({
            kind: 'parameter', pillar: pl.id, pillarLabel: pl.label, pillarWeight: pl.weight, id: p.id, metric: p.metric, label: p.label, unit: p.unit,
            direction: p.direction, max: p.max, full: p.full, zero: p.zero, fullDisplay: fmtT(p.full, p.unit), zeroDisplay: fmtT(p.zero, p.unit),
            formula: p.formula, source: p.source, sourceText: SOURCES[p.source], ref: p.ref, stretch: p.stretch || null
        });
    }
    for (const p of PENALTIES) {
        rows.push({ kind: 'penalty', pillar: 'penalty', pillarLabel: 'Safety penalties (cap −' + PENALTY_CAP + ')', pillarWeight: 0, id: p.id, metric: p.metric, label: p.label, unit: p.unit, direction: 'lower',
            max: -p.max, full: p.none, zero: p.worst, fullDisplay: fmtT(p.none, p.unit), zeroDisplay: fmtT(p.worst, p.unit), formula: p.formula, source: p.source, sourceText: SOURCES[p.source], ref: p.ref, stretch: null });
    }
    return rows;
}

// ---- the whole rating ----------------------------------------------------------------------

const LEVELS = ['zone', 'region', 'division', 'ccc'];

/**
 * @param {object} doc  metrics document (docs/rating/sample-metrics.json shape)
 * @param {{ generatedAt?: string }} opts
 * @returns rating document (docs/rating/engine-contract.md)
 */
function rate(doc, opts) {
    opts = opts || {};
    const cfgById = {};
    for (const pl of PILLARS) for (const p of pl.params) cfgById[p.id] = p;
    const codes = Object.keys(doc.offices || {}).sort();
    const kids = {};
    for (const c of codes) { const par = doc.offices[c].parent; if (par) (kids[par] = kids[par] || []).push(c); }
    const offices = {};
    for (const c of codes) {
        const src = doc.offices[c];
        const r = rateOffice(src, doc);
        const off = {
            code: c, name: src.name, level: src.level, parent: src.parent || null, children: (kids[c] || []).slice(),
            region: src.region || null, division: src.division || null, path: null,
            score: r.score == null ? null : r2(r.score), grade: r.rated ? gradeOf(r2(r.score)) : null, rated: r.rated,
            rank: null, of: null, band: null, base: r2(r.base), penaltyTotal: r2(r.penaltyTotal), measurable: r2(r.measurable),
            pillars: r.pillars, penalties: r.penalties, why: [], improve: [], contributions: {}, _r: r, _src: src
        };
        off.band = off.grade ? bandOf(off.grade) : null;
        offices[c] = off;
    }
    // the office's chain of codes, for highlighting the signed-in office and its parents
    for (const c of codes) {
        const path = {};
        for (let at = c; at && offices[at]; at = offices[at].parent) path[offices[at].level] = at;
        offices[c].path = path;
    }
    // ranks within each level
    const levels = {};
    for (const lv of LEVELS) {
        const list = codes.filter((c) => offices[c].level === lv).map((c) => ({ code: c, name: offices[c].name, score: offices[c].score }));
        const rk = rank(list);
        levels[lv] = { order: rk.order.concat(list.filter((x) => x.score == null).map((x) => x.code).sort()), of: rk.of };
        for (const x of list) { offices[x.code].rank = rk.ranks[x.code] || null; offices[x.code].of = rk.of; }
    }
    for (const c of codes) {
        const off = offices[c];
        off.why = why(off, off._r);
        off.improve = improve(off, off._r);
    }
    for (const c of codes) {
        const off = offices[c];
        if (off.children.length) off.contributions = contributions(off, off.children.map((k) => offices[k]), cfgById);
    }
    // strip working fields and parameter internals
    for (const c of codes) {
        const off = offices[c];
        for (const pl of off.pillars) {
            pl.marks = r2(pl.marks); pl.max = r2(pl.max); pl.effWeight = r2(pl.effWeight);
            delete pl.availMax; delete pl.baseMax;
            for (const x of pl.params) { x.marks = r2(x.marks); x.effMax = r2(x.effMax); delete x._f; }
        }
        delete off._r; delete off._src;
    }
    const zoneCode = codes.find((c) => offices[c].level === 'zone') || null;
    const asOn = {};
    for (const [id, m] of Object.entries(doc.metrics || {})) asOn[id] = { asOn: m.asOn || null, period: m.period || null, stale: (m.flags || []).includes('stale') };
    return {
        engine: VERSION,
        generatedAt: opts.generatedAt || doc.generatedAt || null,
        referenceDate: doc.referenceDate || null,
        inputs: { metricsLogic: doc.logic || null, metricsGeneratedAt: doc.generatedAt || null, source: doc.source || null, asOn },
        bands: BANDS.map((b) => ({ grade: b.grade, min: isFinite(b.min) ? b.min : null, label: b.label })),
        pillars: PILLARS.map((pl) => ({ id: pl.id, label: pl.label, short: pl.short, weight: pl.weight, basis: pl.basis })),
        penaltyCap: PENALTY_CAP,
        rules: {
            linear: 'marks = max × clamp((value − zero) ÷ (full − zero), 0, 1)',
            naParameter: 'A parameter that cannot be measured at an office (not at this level, no data, stale, too few cases, low coverage) is n/a; its marks go to the other parameters of its pillar in proportion to their marks.',
            naPillar: 'If nothing in a pillar can be measured, the pillar\'s weight goes to the other pillars in proportion to their weights.',
            minRated: 'An office is graded only if at least ' + RULES.minRatedWeight + ' of the 100 base marks can be measured.',
            penalties: 'Penalties only subtract (cap −' + PENALTY_CAP + ') and are never applied on stale data.',
            levels: 'Each office is computed from its own summed inputs (including rows booked at the office itself, such as HT input at regions), never as an average of its children; ranks are within a level.',
            ranks: 'Competition ranking on the score rounded to 2 decimals (equal scores share a rank).'
        },
        sources: SOURCES,
        methodology: methodologyRows(),
        zone: zoneCode,
        levels,
        offices
    };
}

return { VERSION, METHOD, BANDS, PILLARS, PENALTIES, RULES, SOURCES, rate, linear, inverse, step, weighted3, gradeOf, bandOf, rank, fmt };
});
