/* lib/rating_metrics.js: the performance rating's metric layer, from uniform rows.
 * Shared by the browser (window.MzoRatingMetrics) and Node (require). No dependencies besides
 * lib/offices.js (the canonical office list), which the caller passes or which is found as
 * window.MzoOffices / require('./offices.js').
 *
 * It computes the 46 candidate metrics for all 52 offices (zone, 3 regions, 7 divisions, 41 CCCs)
 * from the uniform rows of 37 datasets (docs/uniform-data.md) and returns the metrics document
 * that lib/rating.js rates (the shape of docs/rating/sample-metrics.json). It is a port of
 * scripts/rating/compute-metrics.js, which reads the raw snapshots; scripts/qa/rating-metrics-identity.js
 * proves both give the same document, and docs/rating/metrics-layer.md lists the few justified
 * differences (rows are placed by their canonical office fields).
 *
 *   computeSync(source, opts) -> metricsDoc
 *       source  { <datasetKey>: rows } or a function key -> rows. rows: an MzoRows `t`, an array of
 *               uniform row objects, a lib/uniform.js build() result, or a rows document (parsed or text).
 *       opts    { offices, asOf 'YYYY-MM-DD', generatedAt, manifest, mode, only: [metricId], release }
 *   compute(source?, opts?) -> Promise<metricsDoc>     the browser entry: with no source it loads
 *               DATASETS through MzoRows.get(key, { scope: false }); a function source may return promises;
 *               opts.rated: true computes only what lib/rating.js scores (17 datasets instead of 37).
 *   loadRows(keys?) -> Promise<{ key: t }>              MzoRows.get for each key (all offices)
 *   DATASETS, NEEDS (fields read per dataset), schemaFor(key) (the rating's own lean schema),
 *   METRICS, FLAGS, datasetsFor(ids), ratedIds(METHOD)
 *
 * Office rule: a row belongs to the office its canonical fields name (_ccc_code, else _division,
 * else _region). A row with none of them belongs to the zone only when its own office cells name
 * the zone (6600000, "Malda Zone"); otherwise it is unmapped. Each level is computed from its own
 * summed inputs: an office's sums = the rows booked at the office itself + the sums of its children.
 * Metric definitions and data caveats: docs/rating/data-map.md.
 */
(function (root, factory) {
    'use strict';
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.MzoRatingMetrics = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
'use strict';

// Same logic id as compute-metrics.js: both give the same document for the same data.
const LOGIC = 'rating-metrics/1';

// ---- values -------------------------------------------------------------------------------
// The raw-text parsers of compute-metrics.js. Uniform rows carry typed values (numbers, ISO dates)
// and keep text that a typed column could not parse in "<field>_raw"; the accessors below read
// the typed value, else the raw text, and apply these parsers, so every value means what it meant
// to the script whatever type a schema pins.

/** "12,34,567.8", "22.35%", "(0.37)" → number; anything else → NaN. */
function num(v) {
    let s = String(v == null ? '' : v).trim();
    if (!s) return NaN;
    let neg = false;
    const m = s.match(/^\((.*)\)$/);
    if (m) { neg = true; s = m[1]; }
    s = s.replace(/[,\s%]/g, '');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
    const n = parseFloat(s);
    return neg ? -n : n;
}

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function iso(y, m, d) {
    if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    const t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCMonth() !== m - 1) return '';
    return t.toISOString().slice(0, 10);
}
/** Any date the sources use (and uniform ISO dates) → 'YYYY-MM-DD' ('' when blank or not a date). */
function date(v, order) {
    const s = String(v == null ? '' : v).trim();
    if (!s || /^\(?null\)?$/i.test(s) || /^#?n\/?a$/i.test(s) || s === '0') return '';
    let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return iso(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return iso(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
    if (m) {
        const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
        return order === 'mdy' ? iso(y, +m[1], +m[2]) : iso(y, +m[2], +m[1]);
    }
    m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{2,4})\b/);
    if (m && MON[m[2].toLowerCase()]) {
        const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
        return iso(y, MON[m[2].toLowerCase()], +m[1]);
    }
    return '';
}
const dayNo = (d) => Date.parse(d + 'T00:00:00Z') / 864e5;
const daysBetween = (a, b) => (a && b ? dayNo(b) - dayNo(a) : NaN);
const addDays = (d, n) => new Date((dayNo(d) + n) * 864e5).toISOString().slice(0, 10);
const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const maxDate = (list) => list.filter(Boolean).reduce((a, b) => (b > a ? b : a), '');
const ISO_OUT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/; // a uniform date value

/** The field's value as the source wrote it: the typed value, or the raw text where it did not parse. */
function cell(r, f) {
    const v = r[f];
    if (v === null || v === undefined || v === '') {
        const raw = r[f + '_raw'];
        return raw === undefined || raw === null ? v : raw;
    }
    return v;
}
/** Text of a field ('' when empty), as the script's trimmed cells. */
function str(r, f) {
    const v = cell(r, f);
    return v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v);
}
/** num() of a field: a typed number as is, else the script's parse of the text. */
function numv(r, f) {
    const v = cell(r, f);
    return typeof v === 'number' ? v : num(v);
}
const nz = (r, f) => { const n = numv(r, f); return isFinite(n) ? n : 0; };
/** +cell, as the script coerced YEAR / MONTH. */
const plus = (r, f) => { const v = cell(r, f); return typeof v === 'number' ? v : +(v == null ? '' : v); };
const dv = (r, f, order) => date(cell(r, f), order);

// ---- offices ------------------------------------------------------------------------------

function officeTree(O) {
    const list = O.dimRows().map((r) => ({
        code: r.code, level: r.level, name: r.name, parent: r.parent_code || null,
        region: r.region || '', division: r.division || ''
    }));
    const byCode = new Map(list.map((o) => [o.code, o]));
    const children = new Map(list.map((o) => [o.code, []]));
    for (const o of list) if (o.parent) children.get(o.parent).push(o.code);
    const divCode = new Map(O.DIVISIONS.map((d) => [d.name, d.code]));
    const regCode = new Map(O.REGIONS.map((r) => [r.name, r.code]));
    function codeOf(o) {
        if (!o) return null;
        if (o.level === 'ccc') return o.ccc_code || null;
        if (o.level === 'division') return divCode.get(o.division) || null;
        if (o.level === 'region') return regCode.get(o.region) || null;
        if (o.level === 'zone') return O.ZONE.code;
        return null;
    }
    const memo = new Map();
    /** Office code of a row from its raw office cells ({codes, cccs, divisions, regions}), or null. */
    function locate(cells) {
        const k = JSON.stringify(cells);
        if (memo.has(k)) return memo.get(k);
        const code = codeOf(O.resolve(cells).office);
        if (memo.size < 200000) memo.set(k, code);
        return code;
    }
    const zone = O.ZONE.code;
    /**
     * Office code of a uniform row: its canonical office; with none, the zone when its own office
     * cells (cells(r)) name the zone, else null. Rows of a dataset without canonical office fields
     * are placed from their cells alone.
     */
    function place(r, cells) {
        if ('_ccc_code' in r || '_region' in r) {
            if (r._ccc_code) return byCode.has(r._ccc_code) ? r._ccc_code : null;
            if (r._division) return divCode.get(r._division) || null;
            if (r._region) return regCode.get(r._region) || null;
            return cells && locate(cells(r)) === zone ? zone : null;
        }
        return cells ? locate(cells(r)) : null;
    }
    return { list, byCode, children, codeOf, locate, place, zone, divCode, regCode };
}

/** Sums of named inputs per office, then rolled up: total(office) = own rows + Σ total(children). */
function makeSums(tree) {
    const own = new Map();
    let unmapped = 0;
    return {
        add(code, obj) {
            if (!code || !tree.byCode.has(code)) { unmapped++; return; }
            let s = own.get(code);
            if (!s) own.set(code, (s = {}));
            for (const k in obj) s[k] = (s[k] || 0) + (obj[k] || 0);
        },
        get unmapped() { return unmapped; },
        rollup() {
            const total = new Map();
            const walk = (code) => {
                const t = Object.assign({}, own.get(code) || {});
                for (const c of tree.children.get(code)) {
                    const ct = walk(c);
                    for (const k in ct) t[k] = (t[k] || 0) + ct[k];
                }
                total.set(code, t);
                return t;
            };
            walk(tree.zone);
            return { total, own, unmapped };
        }
    };
}

// ---- input --------------------------------------------------------------------------------

/** Any accepted rows input → { rows: object[], columns: string[] | null, missing: Set<field> }. */
function asTable(x) {
    if (x == null) return null;
    if (typeof x === 'string') x = JSON.parse(x);
    let rows = null, columns = null;
    const missing = new Set();
    if (Array.isArray(x)) rows = x;
    else if (Array.isArray(x.all)) { rows = x.all; columns = x.columns ? x.columns.map((c) => c.name || c) : null; } // MzoRows t
    else if (Array.isArray(x.columns)) {
        columns = x.columns.map((c) => c.name);
        if (Array.isArray(x.data)) { // lib/uniform.js build() result (values per column)
            const n = x.stats ? x.stats.rows : (x.data[0] || []).length;
            rows = new Array(n);
            for (let i = 0; i < n; i++) { const o = {}; for (let k = 0; k < columns.length; k++) o[columns[k]] = x.data[k][i]; rows[i] = o; }
        } else { // rows document: row-major arrays
            const src = x.rows || [];
            rows = new Array(src.length);
            for (let i = 0; i < src.length; i++) { const a = src[i], o = {}; for (let k = 0; k < columns.length; k++) o[columns[k]] = a[k]; rows[i] = o; }
        }
    } else if (Array.isArray(x.rows)) rows = x.rows;
    if (!rows) return null;
    for (const i of (x && x.issues) || []) if (i && i.check === 'header.missing') missing.add(i.column);
    return { rows, columns, missing };
}

// ---- data access --------------------------------------------------------------------------

function makeContext(load, manifest, tree, O, uses, release) {
    const cache = new Map();
    const tables = new Map();
    const shapes = new Map(); // key → { exists, have: Set | null, missing: Set }, kept after rows are dropped
    const shapeOf = (t) => (t ? { exists: true, have: t.columns ? new Set(t.columns) : t.rows.length ? new Set(Object.keys(t.rows[0])) : null, missing: t.missing } : { exists: false });
    const ctx = {
        tree, O, manifest: manifest || null,
        table(key) {
            if (!tables.has(key)) { const t = load(key); tables.set(key, t); shapes.set(key, shapeOf(t)); }
            return tables.get(key);
        },
        shape(key) { if (!shapes.has(key)) ctx.table(key); return shapes.get(key); },
        has(key) { return ctx.shape(key).exists; },
        rows(key) {
            const t = ctx.table(key);
            if (!t) throw new Error('missing dataset ' + key);
            return t.rows;
        },
        /** With release: forget a dataset's rows now (a later read loads them again). */
        drop(key) { if (release) tables.delete(key); },
        /** Fields a metric needs that the dataset does not carry (not in its columns, or header.missing). */
        lacks(key, fields) {
            const t = ctx.shape(key);
            if (!t.exists) return [];
            return fields.filter((f) => t.missing.has(f) || (t.have && !t.have.has(f)));
        },
        memo(name, fn) {
            const k = 'memo:' + name;
            if (!cache.has(k)) cache.set(k, fn());
            return cache.get(k);
        },
        snapshotAt(key) {
            const d = manifest && manifest.datasets && manifest.datasets[key];
            return d ? String(d.snapshotAt || d.fetchedAt || '').slice(0, 10) : '';
        },
        /** After a metric: drop rows no later metric lists (they are reloaded if a memo needs them again). */
        done(m) {
            if (!release) return;
            for (const k of m.datasets) {
                uses.set(k, (uses.get(k) || 1) - 1);
                if (uses.get(k) <= 0) tables.delete(k);
            }
        }
    };
    return ctx;
}

// ---- shared inputs ------------------------------------------------------------------------

/** Live consumers per office (consumers sheet, CONN_STAT = LIVE), plus metering counts. */
function consumerBase(ctx) {
    return ctx.memo('consumers', () => {
        const rows = ctx.rows('consumers');
        const sums = makeSums(ctx.tree);
        let asOn = '';
        for (const r of rows) {
            asOn = asOn || dv(r, 'date');
            const code = ctx.tree.place(r, (x) => ({ codes: [str(x, 'ccc_code')] }));
            const stat = str(r, 'conn_stat');
            const live = stat === 'LIVE';
            const count = nz(r, 'count');
            sums.add(code, {
                live: live ? count : 0,
                live_unmetered: live && /no meter/i.test(str(r, 'type_of_meter')) ? count : 0,
                live_smart: live && /smart/i.test(str(r, 'type_of_meter')) ? count : 0,
                osd_live: live ? nz(r, 'osd_lakh') : 0,
                osd_deemed: /deemed/i.test(stat) ? nz(r, 'osd_lakh') : 0,
                all: count
            });
        }
        return { sums: sums.rollup(), asOn, unmapped: sums.unmapped };
    });
}

/** Loss report (and targets): per-month component sums by the office named in the CCC column. */
function lossData(ctx, key) {
    return ctx.memo('loss:' + key, () => {
        const { O, tree } = ctx;
        const rows = ctx.rows(key);
        const months = new Map(); // yyyymm → { ccc: Map, div: Map, reg: Map, zone }
        const seen = new Set();
        let updateOn = '';
        for (const r of rows) {
            updateOn = updateOn || dv(r, 'update_on');
            const name = str(r, 'ccc').trim();
            if (!name) continue;
            const ym = key === 'loss_targets' ? 0 : plus(r, 'year') * 100 + plus(r, 'month');
            const dk = ym + '|' + name.toLowerCase();
            if (seen.has(dk)) continue; // the pasted duplicate block repeats month and name
            seen.add(dk);
            const v = { input: nz(r, 'cum_input_mu'), demand: nz(r, 'cum_demand_mu'), coll: nz(r, 'cum_collec_mu') };
            let m = months.get(ym);
            if (!m) months.set(ym, (m = { ccc: new Map(), div: new Map(), reg: new Map(), zone: null }));
            // "… Div Total" rows and region / zone rows are told apart by name, as the loss page does.
            if (/\bdiv\.?\s*total\b/i.test(name)) {
                const d = O.parseDivision(name.replace(/\bdiv\.?\s*total\b/i, ' Division'));
                const code = tree.codeOf(d);
                if (code) m.div.set(code, v);
                continue;
            }
            const o = O.parseCccName(name);
            const code = tree.codeOf(o);
            if (!code) continue;
            const lvl = tree.byCode.get(code).level;
            if (lvl === 'ccc') m.ccc.set(code, v);
            else if (lvl === 'region') m.reg.set(code, v);
            else if (lvl === 'zone') m.zone = v;
            else if (lvl === 'division') m.div.set(code, v);
        }
        const keys = [...months.keys()].sort((a, b) => a - b);
        return { months, keys, latest: keys[keys.length - 1], updateOn };
    });
}

const COMP = ['input', 'demand', 'coll'];
/** One month's sums: CCC rows own; a region's own = its row − Σ its divisions (HT / region-level input). */
function lossSums(ctx, m) {
    const { tree } = ctx;
    const sums = makeSums(tree);
    const checks = [];
    for (const [code, v] of m.ccc) sums.add(code, v);
    const bottom = sums.rollup().total;
    for (const [code, row] of m.div) {
        const b = bottom.get(code) || {};
        const diff = COMP.map((k) => +(row[k] - (b[k] || 0)).toFixed(2));
        if (diff.some((x) => Math.abs(x) > 0.05)) checks.push({ office: code, kind: 'division_row_vs_ccc_sum', diff: { input: diff[0], demand: diff[1], coll: diff[2] } });
    }
    for (const [code, row] of m.reg) {
        const b = bottom.get(code) || {};
        const own = {};
        COMP.forEach((k) => { own[k] = +(row[k] - (b[k] || 0)).toFixed(3); });
        sums.add(code, own);
        checks.push({ office: code, kind: 'region_row_minus_divisions', own });
    }
    if (m.zone) {
        const regs = [...m.reg.values()];
        const own = {};
        COMP.forEach((k) => { own[k] = +(m.zone[k] - regs.reduce((s, v) => s + v[k], 0)).toFixed(3); });
        sums.add(tree.zone, own);
        checks.push({ office: tree.zone, kind: 'zone_row_minus_regions', own });
    }
    return { rolled: sums.rollup(), checks };
}
const atc = (s) => (s.input ? 100 * (s.input - Math.min(s.coll, s.demand)) / s.input : null);

// ---- metric catalogue ---------------------------------------------------------------------
// Each metric: compute(ctx) → { sums (rolled), asOn, period, flags, checks, extra(code)? };
// value(s) → { value, numerator, denominator } from that office's summed inputs.
// Ids, labels, formulas and limits are those of compute-metrics.js, word for word.

const NONE = { value: null, numerator: null, denominator: null };
const ratio = (n, d, scale) => ({ value: d ? (scale || 1) * (n || 0) / d : null, numerator: d ? n || 0 : n == null ? null : n, denominator: d == null ? null : d });
const ALL = ['ccc', 'division', 'region', 'zone'];
const ABOVE_CCC = ['division', 'region', 'zone'];

const METRICS = [
    // ---------------------------------------------------------------- Loss & revenue
    {
        id: 'atc_loss', pillar: 'loss_revenue', label: 'AT&C loss', unit: '%', direction: 'lower', levels: ALL,
        datasets: ['loss_report', 'loss_targets'], maxAgeDays: 75, minBase: 0,
        formula: '100 × (input − min(collection, demand)) ÷ input, MU, 12-month cumulative to the latest month',
        compute(ctx) {
            const L = lossData(ctx, 'loss_report');
            const { rolled, checks } = lossSums(ctx, L.months.get(L.latest));
            const T = lossData(ctx, 'loss_targets');
            const tg = lossSums(ctx, T.months.get(0)).rolled.total;
            const y = Math.floor(L.latest / 100), mo = L.latest % 100;
            return {
                sums: rolled, asOn: monthEnd(y, mo), period: '12 months to ' + monthEnd(y, mo).slice(0, 7) + ' (sheet "CUM."; updated ' + L.updateOn + ')',
                checks,
                extra: (code) => { const t = tg.get(code); return t && t.input ? { target: +atc(t).toFixed(2), targetInputs: round(t) } : {}; }
            };
        },
        value: (s) => ({ value: atc(s), numerator: s.input - Math.min(s.coll, s.demand), denominator: s.input, inputs: round(s) })
    },
    {
        id: 'atc_loss_change_yoy', pillar: 'loss_revenue', label: 'AT&C loss change vs a year earlier', unit: 'pts', direction: 'lower', levels: ALL,
        datasets: ['loss_report'], maxAgeDays: 75,
        formula: 'AT&C loss (latest month) − AT&C loss (same month a year earlier), both from summed inputs; when the year-earlier month is more than 10 pts away from the median of it and its two neighbouring months, that median is used instead (flag base_month_outlier)',
        compute(ctx) {
            const L = lossData(ctx, 'loss_report');
            const shift = (ym, n) => { let y = Math.floor(ym / 100), m = ym % 100 + n; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return y * 100 + m; };
            const at = (ym) => (L.months.get(ym) ? lossSums(ctx, L.months.get(ym)).rolled.total : null);
            const cur = at(L.latest), base = [-13, -12, -11].map((n) => at(shift(L.latest, n)));
            const sums = { total: new Map(), own: new Map() };
            const outliers = [];
            for (const [code, s] of cur) {
                const vals = base.map((t) => { const p = t && t.get(code); return p && p.input ? atc(p) : null; });
                let prev = vals[1];
                const ok = vals.filter((v) => v != null).sort((x, y) => x - y);
                const med = ok.length === 3 ? ok[1] : null;
                let flag = false;
                if (prev != null && med != null && Math.abs(prev - med) > 10) { prev = med; flag = true; outliers.push(code); }
                sums.total.set(code, { cur: atc(s), prev, flag });
            }
            const y = Math.floor(L.latest / 100), mo = L.latest % 100;
            return { sums, asOn: monthEnd(y, mo), period: monthEnd(y - 1, mo).slice(0, 7) + ' → ' + monthEnd(y, mo).slice(0, 7), checks: [{ kind: 'base_month_outliers', offices: outliers }] };
        },
        value: (s) => ({ value: s.cur != null && s.prev != null ? s.cur - s.prev : null, numerator: null, denominator: null, inputs: { current: r2(s.cur), yearEarlier: r2(s.prev), baseMonthOutlier: !!s.flag } }),
        warn: (s) => (s.flag ? ['base_month_outlier'] : [])
    },
    {
        id: 'distribution_loss', pillar: 'loss_revenue', label: 'Distribution loss', unit: '%', direction: 'lower', levels: ALL,
        datasets: ['loss_report', 'loss_targets'], maxAgeDays: 75,
        formula: '100 × (input − demand) ÷ input, MU (billing efficiency = 100 − this)',
        compute(ctx) {
            const base = METRICS_BY_ID.atc_loss.compute(ctx);
            const T = lossData(ctx, 'loss_targets');
            const tg = lossSums(ctx, T.months.get(0)).rolled.total;
            return Object.assign({}, base, { checks: [], extra: (code) => { const t = tg.get(code); return t && t.input ? { target: +(100 * (t.input - t.demand) / t.input).toFixed(2) } : {}; } });
        },
        value: (s) => ratio(s.input - s.demand, s.input, 100)
    },
    {
        id: 'collection_efficiency', pillar: 'loss_revenue', label: 'Collection efficiency', unit: '%', direction: 'higher', levels: ALL,
        datasets: ['loss_report'], maxAgeDays: 75,
        formula: '100 × collection ÷ demand, MU, capped at 100 as in the sheet (uncapped ratio in inputs)',
        compute: (ctx) => Object.assign({}, METRICS_BY_ID.atc_loss.compute(ctx), { checks: [], extra: null }),
        value: (s) => ({ value: s.demand ? Math.min(100, 100 * s.coll / s.demand) : null, numerator: s.coll, denominator: s.demand, inputs: { uncapped: s.demand ? r2(100 * s.coll / s.demand) : null } })
    },
    {
        id: 'receivable_days', pillar: 'loss_revenue', label: 'Receivables in days of collection', unit: 'days', direction: 'lower', levels: ALL,
        datasets: ['consumers', 'collection_report'], maxAgeDays: 45,
        formula: 'OSD of live consumers (₹ lakh) ÷ average daily collection over the 365 days to the OSD date (₹ lakh)',
        compute(ctx) {
            const C = consumerBase(ctx);
            const end = C.asOn, start = addDays(end, -364);
            const sums = makeSums(ctx.tree);
            let regionRows = 0, lastPay = '';
            for (const r of ctx.rows('collection_report')) {
                const d = dv(r, 'payment_dt');
                lastPay = d > lastPay ? d : lastPay;
                if (!d || d < start || d > end) continue;
                const code = ctx.tree.place(r, (x) => ({ codes: [str(x, 'ccc_code')] }));
                // Region-office rows (HT, billed at the region) have no OSD in the consumer sheet: left out at every level.
                if (code && ctx.tree.byCode.get(code).level !== 'ccc') { regionRows += nz(r, 'amount_paid'); continue; }
                sums.add(code, { coll: nz(r, 'amount_paid') });
            }
            for (const [code, s] of C.sums.own) sums.add(code, { osd: s.osd_live || 0 });
            return {
                sums: sums.rollup(), asOn: end, period: 'OSD as on ' + end + '; collections ' + start + ' to ' + end,
                flags: ['ht_region_collections_excluded'],
                checks: [{ kind: 'region_level_collections_left_out_lakh', value: +regionRows.toFixed(2) }]
            };
        },
        value: (s) => ({ value: s.coll ? s.osd / (s.coll / 365) : null, numerator: s.osd, denominator: s.coll / 365, inputs: { osdLakh: r2(s.osd), collection365Lakh: r2(s.coll) } })
    },
    {
        id: 'rem_defaulters_per_1000', pillar: 'loss_revenue', label: 'Defaulters with OSD over ₹5,000 per 1,000 live consumers', unit: 'per 1,000', direction: 'lower', levels: ALL,
        datasets: ['rem_osd', 'consumers'], maxAgeDays: 14,
        formula: 'REM OSD > ₹5,000 Total-Count (latest weekly report) ÷ live consumers × 1,000',
        compute(ctx) {
            const R = remWeeks(ctx);
            const sums = makeSums(ctx.tree);
            for (const r of R.byDate.get(R.latest)) sums.add(r.code, { n: r.count, amt: r.amount, rows: 1 });
            for (const [code, s] of consumerBase(ctx).sums.own) sums.add(code, { live: s.live || 0 });
            return { sums: sums.rollup(), asOn: R.latest, period: 'week of ' + R.latest };
        },
        value: (s) => (s.rows ? Object.assign(ratio(s.n, s.live, 1000), { inputs: { amountLakh: r2(s.amt) } }) : NONE)
    },
    {
        id: 'rem_osd_change_13w', pillar: 'loss_revenue', label: 'Change in OSD over ₹5,000 over 13 weeks', unit: '%', direction: 'lower', levels: ALL,
        datasets: ['rem_osd'], maxAgeDays: 14,
        formula: '100 × (amount latest − amount 13 weeks earlier) ÷ amount 13 weeks earlier, ₹ lakh',
        compute(ctx) {
            const R = remWeeks(ctx);
            const target = addDays(R.latest, -91);
            const base = R.dates.reduce((a, b) => (Math.abs(daysBetween(b, target)) < Math.abs(daysBetween(a, target)) ? b : a));
            const sums = makeSums(ctx.tree);
            for (const r of R.byDate.get(R.latest)) sums.add(r.code, { cur: r.amount });
            for (const r of R.byDate.get(base)) sums.add(r.code, { prev: r.amount });
            return { sums: sums.rollup(), asOn: R.latest, period: base + ' → ' + R.latest };
        },
        value: (s) => ({ value: s.prev ? 100 * (s.cur - s.prev) / s.prev : null, numerator: s.cur - s.prev, denominator: s.prev, inputs: { latestLakh: r2(s.cur), baseLakh: r2(s.prev) } })
    },
    {
        id: 'disconnection_action_share', pillar: 'loss_revenue', label: 'Disconnection list acted on', unit: '%', direction: 'higher', levels: ALL, listType: true,
        datasets: ['disconnection'], maxAgeDays: 21, minBase: 20,
        formula: '100 × (fully paid + part paid + disconnected) ÷ consumers on the disconnection list',
        compute(ctx) {
            const sums = makeSums(ctx.tree);
            const rows = ctx.rows('disconnection');
            let last = '', domBase = '', icBase = '';
            // The list's base dates sit in the first data row.
            if (rows[0]) { domBase = dv(rows[0], 'dom_base_date'); icBase = dv(rows[0], 'ind_com_base_date'); }
            for (const r of rows) {
                if (!str(r, 'ccc_code') && !str(r, 'con_id')) continue;
                // An action date is dd.mm.yyyy in the sheet (a uniform date when the schema types the column).
                const ds = str(r, 'paid_discon_date').trim();
                const d = /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(ds) || ISO_OUT.test(ds) ? date(ds) : '';
                if (d > last) last = d;
                const pv = cell(r, 'final_paid_amount');
                const paidStr = typeof pv === 'number' ? String(pv) : String(pv == null ? '' : pv).trim();
                const hasPaid = paidStr !== '' && !/^#n\/a$/i.test(paidStr) && paidStr !== '0';
                const o = numv(r, 'notosd');
                const osd = isFinite(o) ? o : nz(r, 'notosd_upd');
                const st = !d ? 'none' : !hasPaid ? 'disconnected' : (typeof pv === 'number' ? pv : nz(r, 'final_paid_amount')) >= osd ? 'paid' : 'part';
                sums.add(ctx.tree.place(r, (x) => ({ codes: [str(x, 'ccc_code')] })), { n: 1, acted: st === 'none' ? 0 : 1, paid: st === 'paid' ? 1 : 0, part: st === 'part' ? 1 : 0, disc: st === 'disconnected' ? 1 : 0, osd });
            }
            return { sums: sums.rollup(), asOn: last, period: 'list base dates DOM ' + domBase + ', IND/COM ' + icBase + '; latest action ' + last, unmapped: sums.unmapped };
        },
        value: (s) => Object.assign(ratio(s.acted, s.n, 100), { inputs: { fullyPaid: s.paid, partPaid: s.part, disconnected: s.disc, noAction: s.n - s.acted, osdRs: Math.round(s.osd) } })
    },
    {
        id: 'theft_realisation', pillar: 'loss_revenue', label: 'Theft assessment realised', unit: '%', direction: 'higher', levels: ALL, listType: true,
        datasets: ['theft_assessment'], maxAgeDays: 60, minBase: 10,
        formula: '100 × payment received ÷ amount assessed (final bill, else provisional) for cases inspected in the 12 months to the latest inspection',
        compute(ctx) {
            const rows = ctx.rows('theft_assessment');
            const last = maxDate(rows.map((r) => dv(r, 'inspection_date')));
            const start = addDays(last, -364);
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                const d = dv(r, 'inspection_date');
                if (!d || d < start) continue;
                const fin = nz(r, 'final_bill_amt'), prov = nz(r, 'provsnl_bill_amt');
                sums.add(ctx.tree.place(r, (x) => ({ codes: [str(x, 'location_code')], cccs: [str(x, 'ccc_name')] })), { cases: 1, assessed: fin > 0 ? fin : prov, paid: nz(r, 'payment_amt') });
            }
            return { sums: sums.rollup(), asOn: last, period: start + ' to ' + last };
        },
        value: (s) => Object.assign(ratio(s.paid, s.assessed, 100), { inputs: { cases: s.cases } }),
        base: (s) => s.cases
    },

    // ---------------------------------------------------------------- Connection services
    {
        id: 'nsc_pending_over_30d_share', pillar: 'connection', label: 'Paid NSC pending over 30 days', unit: '%', direction: 'lower', levels: ALL, listType: true,
        datasets: ['nsc_pending'], maxAgeDays: 14, minBase: 20,
        formula: '100 × pending applications with DelayInSC > 30 days ÷ pending applications (paid, Working)',
        compute: (ctx) => nscPass(ctx),
        value: (s) => Object.assign(ratio(s.over30, s.n, 100), { inputs: { upTo7: s.le7, upTo15: s.le15, upTo30: s.n - s.over30, over180: s.over180, over365: s.over365 } })
    },
    {
        id: 'nsc_pending_avg_days', pillar: 'connection', label: 'Average age of pending NSC since payment', unit: 'days', direction: 'lower', levels: ALL, listType: true,
        datasets: ['nsc_pending'], maxAgeDays: 14, minBase: 20,
        formula: 'Σ DelayInSC ÷ pending applications (days from quotation payment to the report date)',
        compute: (ctx) => nscPass(ctx),
        value: (s) => ratio(s.ageSum, s.n)
    },
    {
        id: 'nsc_qtn_delay_avg', pillar: 'connection', label: 'Average quotation delay (pending NSC)', unit: 'days', direction: 'lower', levels: ALL, listType: true,
        datasets: ['nsc_pending'], maxAgeDays: 14, minBase: 20,
        formula: 'Σ DelayInQtn ÷ pending applications (inspection → quotation)',
        compute: (ctx) => nscPass(ctx),
        value: (s) => ratio(s.qtnSum, s.n)
    },
    {
        id: 'nsc_wo_delay_avg', pillar: 'connection', label: 'Average work-order delay (pending NSC with a WO)', unit: 'days', direction: 'lower', levels: ALL, listType: true,
        datasets: ['nsc_pending'], maxAgeDays: 14, minBase: 20,
        formula: 'Σ DelayInWO ÷ pending applications with a work order (payment → work order)',
        compute: (ctx) => nscPass(ctx),
        value: (s) => ratio(s.woSum, s.woN)
    },
    {
        id: 'nsc_pending_per_10k', pillar: 'connection', label: 'Pending NSC per 10,000 live consumers', unit: 'per 10,000', direction: 'lower', levels: ALL, listType: true,
        datasets: ['nsc_pending', 'consumers'], maxAgeDays: 14,
        formula: 'pending applications ÷ live consumers × 10,000',
        compute(ctx) {
            const p = nscPass(ctx);
            const sums = makeSums(ctx.tree);
            for (const [code, s] of p.sums.own) sums.add(code, { n: s.n });
            for (const [code, s] of consumerBase(ctx).sums.own) sums.add(code, { live: s.live || 0 });
            return Object.assign({}, p, { sums: sums.rollup() });
        },
        value: (s) => ratio(s.n, s.live, 10000)
    },
    {
        id: 'nsc_withheld_network_share', pillar: 'connection', label: 'Applications withheld for want of network (12 months)', unit: '%', direction: 'lower', levels: ALL, listType: true,
        datasets: ['withheld'], maxAgeDays: 14, minBase: 20,
        formula: '100 × applications withheld in the 365 days to the report for a network reason (LT infrastructure required, way leave for LT infrastructure, WBSEDCL unable, techno-economically not feasible, transformer location) ÷ all applications withheld in those 365 days',
        compute(ctx) {
            const rows = ctx.rows('withheld');
            const today = rows[0] ? dv(rows[0], 'today') : '';
            const start = addDays(today, -364);
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                const d = dv(r, 'scn_witheld_date');
                if (!d || d < start || d > today) continue;
                const net = /LT Infrastructure|unable to provide|Techno Economically|installation of Transformer/i.test(str(r, 'scn_witheld_reason'));
                sums.add(ctx.tree.place(r, (x) => ({ codes: [str(x, 'ccc_code')], cccs: [str(x, 'supp_off')], divisions: [str(x, 'divn_name')], regions: [str(x, 'region')] })), { w: 1, net: net ? 1 : 0 });
            }
            for (const [code, s] of nscPass(ctx).sums.own) sums.add(code, { p: s.n });
            return { sums: sums.rollup(), asOn: today, period: start + ' to ' + today, flags: ['pending_withheld_overlap_12'] };
        },
        value: (s) => Object.assign(ratio(s.net, s.w, 100), { inputs: { withheld12m: s.w || 0, pendingNow: s.p || 0 } })
    },
    {
        id: 'nsc_released_12m', pillar: 'connection', label: 'New connections released in 12 months (historical NSC)', unit: 'count', direction: 'context', levels: ALL, listType: true,
        datasets: ['historical_nsc'], maxAgeDays: 45,
        formula: 'Σ connections (D + C + I + A + O) with METER_INSTALL_DATE in the 365 days to the latest date',
        compute(ctx) {
            const rows = ctx.rows('historical_nsc');
            const last = maxDate(rows.map((r) => dv(r, 'meter_install_date', 'mdy')));
            const start = addDays(last, -364);
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                const d = dv(r, 'meter_install_date', 'mdy');
                if (!d || d < start) continue;
                sums.add(ctx.tree.place(r, (x) => ({ codes: [str(x, 'ccc_code')] })), { n: nz(r, 'd') + nz(r, 'c') + nz(r, 'i') + nz(r, 'a') + nz(r, 'o') });
            }
            return { sums: sums.rollup(), asOn: last, period: start + ' to ' + last };
        },
        value: (s) => ({ value: s.n || 0, numerator: s.n || 0, denominator: null })
    },
    {
        id: 'weekly_disposal_share', pillar: 'connection', label: 'Weekly applications disposed (deposit vs disposal)', unit: '%', direction: 'higher', levels: ALL,
        datasets: ['weekly_report'], maxAgeDays: 14, minBase: 20,
        formula: '100 × Σ Total disposed ÷ Σ To be disposed (DOM + COM + IND), last 4 report weeks',
        compute(ctx) {
            const rows = ctx.rows('weekly_report');
            const dates = [...new Set(rows.map((r) => dv(r, 'date_of_report_in_current_week')).filter(Boolean))].sort();
            const keep = new Set(dates.slice(-4));
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                if (!keep.has(dv(r, 'date_of_report_in_current_week'))) continue;
                let td = 0, dis = 0, eff = 0;
                for (const c of ['dom', 'com', 'ind']) { td += nz(r, 'to_be_disposed_' + c); dis += nz(r, 'total_disposed_' + c); eff += nz(r, 'conn_eff_' + c); }
                sums.add(ctx.tree.place(r, (x) => ({ codes: [str(x, 'ccc_code')], cccs: [str(x, 'ccc')] })), { td, dis, eff });
            }
            return { sums: sums.rollup(), asOn: dates[dates.length - 1], period: dates.slice(-4)[0] + ' to ' + dates[dates.length - 1] };
        },
        value: (s) => Object.assign(ratio(s.dis, s.td, 100), { inputs: { connected: s.eff } }),
        base: (s) => s.td
    },
    {
        id: 'mc_pending_over_30d_share', pillar: 'connection', label: 'Master cards pending over 30 days after meter installation', unit: '%', direction: 'lower', levels: ALL, listType: true,
        datasets: ['pending_mc'], maxAgeDays: 14, minBase: 20,
        formula: '100 × pending master cards with Report Date − Meter Installation Date > 30 days ÷ pending master cards',
        compute(ctx) {
            const rows = ctx.rows('pending_mc');
            const sums = makeSums(ctx.tree);
            let asOn = '', noDate = 0;
            for (const r of rows) {
                const rep = dv(r, 'report_date'); asOn = rep > asOn ? rep : asOn;
                const age = daysBetween(dv(r, 'meter_installation_date'), rep);
                if (!isFinite(age)) noDate++;
                sums.add(ctx.tree.place(r, (x) => ({ codes: [str(x, 'substr_a_supp_off_7_7')], cccs: [str(x, 'ccc') || str(x, 'supp_off')], divisions: [str(x, 'division') || str(x, 'divn')], regions: [str(x, 'region')] })),
                    { n: 1, over30: age > 30 ? 1 : 0, over90: age >= 90 ? 1 : 0, ageSum: isFinite(age) ? age : 0, aged: isFinite(age) ? 1 : 0 });
            }
            return { sums: sums.rollup(), asOn, period: 'as on ' + asOn, flags: ['storage_copy_behind_sheet'], checks: [{ kind: 'rows_without_install_date', value: noDate }] };
        },
        value: (s) => Object.assign(ratio(s.over30, s.n, 100), { inputs: { days90OrMore: s.over90, avgDays: s.aged ? r2(s.ageSum / s.aged) : null } })
    },
    {
        id: 'load_ext_pending_over_90d_share', pillar: 'connection', label: 'Load extensions pending 3 months or more', unit: '%', direction: 'lower', levels: ALL, listType: true,
        datasets: ['load_extension'], maxAgeDays: 14, minBase: 10,
        formula: '100 × pending load extensions with AGE_MONTHS ≥ 3 ÷ pending load extensions (the page counts AGE_MONTHS ≥ 12 as over a year)',
        compute(ctx) {
            const rows = ctx.rows('load_extension');
            const asOn = maxDate(rows.map((r) => dv(r, 'report_date')));
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                const a = parseInt(str(r, 'age_months'), 10) || 0; // whole months, as the page reads it
                sums.add(ctx.tree.place(r, (x) => ({ codes: [str(x, 'ccc_code')] })), { n: 1, over3: a >= 3 ? 1 : 0, over12: a >= 12 ? 1 : 0 });
            }
            return { sums: sums.rollup(), asOn, period: 'as on ' + asOn };
        },
        value: (s) => Object.assign(ratio(s.over3, s.n, 100), { inputs: { yearOrMore: s.over12 || 0 } })
    },
    {
        id: 'solar_pending_over_30d_share', pillar: 'connection', label: 'Rooftop solar applications over 30 days old not yet connected', unit: '%', direction: 'lower', levels: ALL, listType: true,
        datasets: ['solar_connections'], maxAgeDays: 14, minBase: 20,
        formula: '100 × applications created more than 30 days before the report without a successful net-meter replacement ÷ applications created more than 30 days before the report',
        compute(ctx) {
            const rows = ctx.rows('solar_connections');
            const asOn = maxDate(rows.map((r) => dv(r, 'report_date')));
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                if (!str(r, 'solar_appl_no') && !str(r, 'con_id')) continue;
                const s = str(r, 'replace_status').trim().toUpperCase();
                const st = ['SUCCESS', 'EFFECTED', 'DONE'].includes(s) ? 'done' : (!s || s === '(NULL)' || s === 'NOT YET' || s === 'PENDING') ? 'pending' : 'issue';
                const age = daysBetween(dv(r, 'creation_date'), asOn);
                const old = age > 30;
                sums.add(ctx.tree.place(r, (x) => ({ codes: [str(x, 'ccc_code')], cccs: [str(x, 'supp_off')] })), { n: 1, done: st === 'done' ? 1 : 0, old: old ? 1 : 0, oldOpen: old && st !== 'done' ? 1 : 0, issue: st === 'issue' ? 1 : 0, recent: age <= 30 ? 1 : 0 });
            }
            return { sums: sums.rollup(), asOn, period: 'as on ' + asOn };
        },
        value: (s) => Object.assign(ratio(s.oldOpen, s.old, 100), { inputs: { applications: s.n || 0, connected: s.done || 0, createdLast30d: s.recent || 0, meterIssue: s.issue || 0 } })
    },
    {
        id: 'pmsgy_net_metering_share', pillar: 'connection', label: 'PM Surya Ghar installations net-metered', unit: '%', direction: 'higher', levels: ALL, listType: true,
        datasets: ['pmsgy_malda', 'pmsgy_uttar_dinajpur', 'pmsgy_dakshin_dinajpur'], maxAgeDays: 21, minBase: 10,
        formula: '100 × installations completed with a Net Metering Date ÷ installations completed',
        compute(ctx) {
            const sums = makeSums(ctx.tree);
            let asOn = '';
            for (const key of ['pmsgy_malda', 'pmsgy_uttar_dinajpur', 'pmsgy_dakshin_dinajpur']) {
                for (const r of ctx.rows(key)) {
                    if (isGlossary(r)) continue; // the portal's column glossary under the header
                    const inst = /installation completed/i.test(str(r, 'installation_status'));
                    const nm = dv(r, 'net_metering_date');
                    const la = dv(r, 'last_action_date');
                    if (la > asOn) asOn = la;
                    const returned = /returned by discom/i.test(str(r, 'installation_status'));
                    sums.add(ctx.tree.place(r, (x) => ({ cccs: [str(x, 'sub_division_name')], divisions: [str(x, 'division_name')], regions: [str(x, 'district')] })),
                        { apps: 1, inst: inst ? 1 : 0, nm: inst && nm ? 1 : 0, returned: returned ? 1 : 0 });
                }
            }
            return { sums: sums.rollup(), asOn, period: 'latest action ' + asOn, unmapped: sums.unmapped };
        },
        value: (s) => Object.assign(ratio(s.nm, s.inst, 100), { inputs: { applications: s.apps, returnedByDiscom: s.returned } }),
        base: (s) => s.inst
    },

    // ---------------------------------------------------------------- Metering, billing & collection
    {
        id: 'defective_meter_share', pillar: 'metering_billing', label: 'Defective meters per live consumer', unit: '%', direction: 'lower', levels: ALL, listType: true,
        datasets: ['defective_summary', 'consumers'], maxAgeDays: 30,
        formula: '100 × defective meters (summary total) ÷ live consumers',
        compute(ctx) {
            const D = defectivePass(ctx);
            const sums = makeSums(ctx.tree);
            for (const [code, s] of D.sums.own) sums.add(code, { def: s.total });
            for (const [code, s] of consumerBase(ctx).sums.own) sums.add(code, { live: s.live || 0 });
            return { sums: sums.rollup(), asOn: D.asOn, period: 'defective as on ' + D.asOn + ', consumers as on ' + consumerBase(ctx).asOn, flags: ['details_mixed_as_on_not_used'] };
        },
        value: (s) => ratio(s.def, s.live, 100)
    },
    {
        id: 'defective_over5y_share', pillar: 'metering_billing', label: 'Defective meters older than 5 years', unit: '%', direction: 'lower', levels: ALL, listType: true,
        datasets: ['defective_summary'], maxAgeDays: 30,
        formula: '100 × defective meters with a defect over 5 years old ÷ defective meters',
        compute(ctx) { const D = defectivePass(ctx); return Object.assign({}, D, { flags: ['details_mixed_as_on_not_used'] }); },
        value: (s) => Object.assign(ratio(s.over5, s.total, 100), { inputs: { over10: s.over10, defectiveThisYear: s.thisYear } })
    },
    {
        id: 'unmetered_share', pillar: 'metering_billing', label: 'Live consumers without a meter', unit: '%', direction: 'lower', levels: ALL,
        datasets: ['consumers'], maxAgeDays: 45,
        formula: '100 × live consumers with TYPE_OF_METER "NO METER" ÷ live consumers',
        compute(ctx) { const C = consumerBase(ctx); return { sums: C.sums, asOn: C.asOn, period: 'as on ' + C.asOn }; },
        value: (s) => Object.assign(ratio(s.live_unmetered || 0, s.live || 0, 100), { inputs: { smart: s.live_smart || 0 } })
    },
    {
        id: 'smart_meter_installed_share', pillar: 'metering_billing', label: 'Supplied smart meters installed', unit: '%', direction: 'higher', levels: ALL, listType: true,
        datasets: ['smart_meter_status', 'smart_meter_work_orders'], maxAgeDays: 30, minBase: 20,
        formula: '100 × meters marked installed (active in HES) ÷ meters supplied',
        compute: (ctx) => smartPass(ctx),
        value: (s) => ratio(s.inst, s.n, 100)
    },
    {
        id: 'smart_meter_ami_push_share', pillar: 'metering_billing', label: 'Installed smart meters submitted to the AMI portal', unit: '%', direction: 'higher', levels: ALL, listType: true,
        datasets: ['smart_meter_status', 'smart_meter_work_orders'], maxAgeDays: 30, minBase: 20,
        formula: '100 × meters submitted in the AMI portal ÷ meters installed',
        compute: (ctx) => smartPass(ctx),
        value: (s) => ratio(s.pushInst, s.inst, 100)
    },
    {
        id: 'meter_utilization_share', pillar: 'metering_billing', label: 'Issued meters put to use', unit: '%', direction: 'higher', levels: ALL, listType: true,
        datasets: ['meter_erp', 'meter_master', 'meter_crm', 'meter_isu'], maxAgeDays: 45, minBase: 50, oneAtATime: true,
        formula: '100 × ERP meters (issued at least 30 days before the latest ERP entry) found as a new connection or a replacement ÷ those meters',
        compute(ctx) {
            // The meter sheets are the biggest inputs: one at a time (with release, each is dropped after use).
            const used = new Set(), repl = new Set();
            for (const r of ctx.rows('meter_master')) { const m = str(r, 'meter_no').trim(); if (m) used.add(m); }
            ctx.drop('meter_master');
            for (const r of ctx.rows('meter_crm')) { const m = str(r, 'meter_number').trim(); if (m) repl.add(m); }
            ctx.drop('meter_crm');
            for (const r of ctx.rows('meter_isu')) { const a = str(r, 'meter_no').trim(), b = str(r, 'replaced_by').trim(); if (a) repl.add(a); if (b) repl.add(b); }
            ctx.drop('meter_isu');
            const rows = ctx.rows('meter_erp');
            const asOn = maxDate(rows.map((r) => dv(r, 'entry_date')));
            const cutoff = addDays(asOn, -30);
            const seen = new Set();
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                const m = str(r, 'serial_number').trim();
                const d = dv(r, 'entry_date');
                if (!m || seen.has(m) || !d || d > cutoff) continue;
                seen.add(m);
                const st = repl.has(m) ? 'rep' : used.has(m) ? 'nsc' : 'hand';
                const age = daysBetween(d, asOn);
                sums.add(ctx.tree.place(r, (x) => ({ codes: [str(x, 'cost_center')] })), { n: 1, nsc: st === 'nsc' ? 1 : 0, rep: st === 'rep' ? 1 : 0, hand90: st === 'hand' && age > 90 ? 1 : 0 });
            }
            return { sums: sums.rollup(), asOn, period: 'meters issued up to ' + cutoff + ' (ERP to ' + asOn + ')', unmapped: sums.unmapped };
        },
        value: (s) => Object.assign(ratio(s.nsc + s.rep, s.n, 100), { inputs: { newConnection: s.nsc, replacement: s.rep, inHandOver90d: s.hand90 } })
    },
    {
        id: 'unbilled_3m_per_10k', pillar: 'metering_billing', label: 'Existing consumers unbilled for 3 months per 10,000 live', unit: 'per 10,000', direction: 'lower', levels: ALL,
        datasets: ['important_unbilled_3_months', 'consumers'], maxAgeDays: 45,
        formula: 'unbilled existing consumers (column Q, the sheet total) ÷ live consumers × 10,000',
        compute(ctx) {
            const R = reportSheet(ctx, 'important_unbilled_3_months', /report generation date:\s*([\d.]+)/i);
            const sums = makeSums(ctx.tree);
            for (const x of R.rows) sums.add(x.code, { u: nz(x.r, 'col_q'), rows: 1 });
            for (const [code, s] of consumerBase(ctx).sums.own) sums.add(code, { live: s.live || 0 });
            return { sums: sums.rollup(), asOn: R.asOn, period: 'report of ' + R.asOn, checks: R.checks };
        },
        value: (s) => (s.rows ? ratio(s.u, s.live, 10000) : NONE)
    },
    {
        id: 'first_bill_pending_per_10k', pillar: 'metering_billing', label: 'Connections without a first bill per 10,000 live', unit: 'per 10,000', direction: 'lower', levels: ALL,
        datasets: ['important_first_bill_pending', 'consumers'], maxAgeDays: 45,
        formula: 'live permanent connections without a first bill (column J, the sheet total) ÷ live consumers × 10,000',
        compute(ctx) {
            const R = reportSheet(ctx, 'important_first_bill_pending', /as on\s*([\d.]+)/i);
            const sums = makeSums(ctx.tree);
            for (const x of R.rows) sums.add(x.code, { u: nz(x.r, 'col_j'), rows: 1 });
            for (const [code, s] of consumerBase(ctx).sums.own) sums.add(code, { live: s.live || 0 });
            return { sums: sums.rollup(), asOn: R.asOn, period: 'as on ' + R.asOn, checks: R.checks };
        },
        value: (s) => (s.rows ? ratio(s.u, s.live, 10000) : NONE)
    },
    {
        id: 'low_unit_bill_share', pillar: 'metering_billing', label: 'Live consumers billed under 10 units a month', unit: '%', direction: 'lower', levels: ALL,
        datasets: ['important_rem_less_unit_billed'], maxAgeDays: 60,
        formula: '100 × bills under 10 units incl. zero (column I) ÷ live consumers in the same sheet (column F)',
        compute(ctx) {
            const R = reportSheet(ctx, 'important_rem_less_unit_billed', /schedule\s*([\d.]+)\s*to\s*([\d.]+)/i, 2);
            const sums = makeSums(ctx.tree);
            for (const x of R.rows) sums.add(x.code, { lt10: nz(x.r, 'col_i'), zero: nz(x.r, 'col_m'), live: nz(x.r, 'col_f') });
            return { sums: sums.rollup(), asOn: R.asOn, period: 'billing schedule to ' + R.asOn, checks: R.checks, flags: ['columns_inferred_from_page_labels'] };
        },
        value: (s) => Object.assign(ratio(s.lt10, s.live, 100), { inputs: { zeroUnit: s.zero } })
    },

    // ---------------------------------------------------------------- Reliability
    {
        id: 'feeder_outage_hours', pillar: 'reliability', label: 'Outage hours per 11 kV feeder per month (SAIDI proxy)', unit: 'hours', direction: 'lower', levels: ABOVE_CCC,
        naReason: 'feeder outage data has no CCC column (division and substation only)',
        datasets: ['feeder_outage'], maxAgeDays: 75,
        formula: 'Σ duration of outages over 5 min (minutes) ÷ 60 ÷ feeder-months, last 12 report months',
        compute: (ctx) => feederPass(ctx),
        value: (s) => Object.assign(ratio(s.min / 60, s.fm), { inputs: { feederMonths: s.fm } })
    },
    {
        id: 'feeder_outage_count', pillar: 'reliability', label: 'Outages per 11 kV feeder per month (SAIFI proxy)', unit: 'count', direction: 'lower', levels: ABOVE_CCC,
        naReason: 'feeder outage data has no CCC column (division and substation only)',
        datasets: ['feeder_outage'], maxAgeDays: 75,
        formula: 'Σ outages over 5 min ÷ feeder-months, last 12 report months',
        compute: (ctx) => feederPass(ctx),
        value: (s) => ratio(s.cnt, s.fm)
    },
    {
        id: 'feeder_concern_share', pillar: 'reliability', label: 'Feeder-months of concern', unit: '%', direction: 'lower', levels: ABOVE_CCC,
        naReason: 'feeder outage data has no CCC column (division and substation only)',
        datasets: ['feeder_outage'], maxAgeDays: 75,
        formula: '100 × feeder-months averaging ≥ 1 h of outage a day or with ≥ 30 outages ÷ feeder-months (the page\'s concern rule without the month-on-month jump)',
        compute: (ctx) => feederPass(ctx),
        value: (s) => ratio(s.concern, s.fm, 100)
    },

    {
        id: 'dtr_weighted_outage_hours', pillar: 'reliability', label: 'Outage hours a distribution transformer saw per month (feeder outages spread over DTRs)', unit: 'hours', direction: 'lower', levels: ALL,
        datasets: ['feeder_outage', 'dtr_records'], maxAgeDays: 75, minBase: 120,
        formula: 'Σ over DTRs of their 11 kV feeder\'s outage hours (outages over 5 min) ÷ DTR-months, last 12 report months; feeders matched to DTRs by division + substation + feeder name (else division + feeder name)',
        compute(ctx) {
            const F = feederPass(ctx);
            const key = (s) => String(s || '').toUpperCase().replace(/\b(11\s*KV|33\s*KV|KV|FEEDER|FDR|S\/S|SS|SUB\s*STATION)\b/g, ' ').replace(/[^A-Z0-9]+/g, '');
            const byFeeder = new Map(), byName = new Map(), dtrs = makeSums(ctx.tree);
            for (const r of ctx.rows('dtr_records')) {
                const code = ctx.tree.place(r, dtrCells);
                dtrs.add(code, { dtr: 1 });
                const d = ctx.O.parseDivision(str(r, 'divn_name'));
                const div = d && d.division || '';
                for (const [map, k] of [[byFeeder, div + '|' + key(str(r, 'ss_name')) + '|' + key(str(r, 'fdr_name'))], [byName, div + '|' + key(str(r, 'fdr_name'))]]) {
                    if (!map.has(k)) map.set(k, new Map());
                    const m = map.get(k);
                    m.set(code, (m.get(code) || 0) + 1);
                }
            }
            const perMonth = new Map(); // month|feeder key → { min, rows, target }
            for (const r of F.rows) {
                const d = ctx.O.parseDivision(str(r, 'division_name'));
                const div = d && d.division || '';
                const k1 = div + '|' + key(str(r, 'substation_name')) + '|' + key(str(r, 'feeder_name')), k2 = div + '|' + key(str(r, 'feeder_name'));
                const target = byFeeder.get(k1) || byName.get(k2);
                if (!target) continue;
                const mk = str(r, 'report_month') + '|' + (byFeeder.has(k1) ? k1 : 'n:' + k2);
                const e = perMonth.get(mk) || { min: 0, rows: 0, target };
                e.min += nz(r, 'total_duration_of_outage_over_5_min'); e.rows++;
                perMonth.set(mk, e);
            }
            const sums = makeSums(ctx.tree);
            const matchedDtr = new Map();
            for (const [mk, e] of perMonth) {
                const hours = e.min / e.rows / 60; // two feeders with one name: their average
                for (const [code, n] of e.target) {
                    sums.add(code, { dm: n, dh: n * hours });
                    matchedDtr.set(mk.split('|').slice(1).join('|') + '|' + code, n);
                }
            }
            const cover = new Map();
            for (const [k, n] of matchedDtr) { const code = k.split('|').pop(); cover.set(code, (cover.get(code) || 0) + n); }
            for (const [code, n] of cover) sums.add(code, { covered: n });
            for (const [code, s] of dtrs.rollup().own) sums.add(code, { dtr: s.dtr });
            return { sums: sums.rollup(), asOn: F.asOn, period: F.period, flags: ['feeder_name_match'], checks: [{ kind: 'feeder_months_matched', value: [...perMonth.values()].reduce((a, e) => a + e.rows, 0), of: F.rows.length }] };
        },
        value: (s) => Object.assign(ratio(s.dh, s.dm), { inputs: { dtrsOnMatchedFeeders: s.covered || 0, dtrs: s.dtr || 0, coverage: s.dtr ? r2(100 * (s.covered || 0) / s.dtr) : null } }),
        base: (s) => s.dm,
        warn: (s) => (s.dtr && (s.covered || 0) / s.dtr < 0.6 ? ['low_match_coverage'] : [])
    },

    // ---------------------------------------------------------------- Grievance & fault redressal
    {
        id: 'docket_open_over_48h_share', pillar: 'grievance', label: 'Open dockets older than 48 hours', unit: '%', direction: 'lower', levels: ALL, listType: true,
        datasets: ['docket_calls'], maxAgeDays: 3, minBase: 10,
        formula: '100 × open dockets created ≥ 48 h before the latest docket ÷ open dockets',
        compute: (ctx) => docketPass(ctx),
        value: (s) => Object.assign(ratio(s.o48, s.n, 100), { inputs: { technical: s.tech, technicalOver24h: s.tech24, over30d: s.o30d } })
    },
    {
        id: 'docket_open_per_10k', pillar: 'grievance', label: 'Open dockets per 10,000 live consumers', unit: 'per 10,000', direction: 'lower', levels: ALL, listType: true,
        datasets: ['docket_calls', 'consumers'], maxAgeDays: 3,
        formula: 'open dockets ÷ live consumers × 10,000',
        compute(ctx) {
            const p = docketPass(ctx);
            const sums = makeSums(ctx.tree);
            for (const [code, s] of p.sums.own) sums.add(code, { n: s.n });
            for (const [code, s] of consumerBase(ctx).sums.own) sums.add(code, { live: s.live || 0 });
            return Object.assign({}, p, { sums: sums.rollup() });
        },
        value: (s) => ratio(s.n, s.live, 10000)
    },
    {
        id: 'fault_dockets_open_over_24h_per_10k', pillar: 'grievance', label: 'Fault (technical) dockets open over 24 hours per 10,000 live consumers', unit: 'per 10,000', direction: 'lower', levels: ALL, listType: true,
        datasets: ['docket_calls', 'consumers'], maxAgeDays: 3,
        formula: 'open dockets of a technical problem type (docket.html\'s list: no power, fuse, DTR, line, meter defective and no power, …) created ≥ 24 h before the latest docket ÷ live consumers × 10,000',
        compute(ctx) {
            const p = docketPass(ctx);
            const sums = makeSums(ctx.tree);
            for (const [code, s] of p.sums.own) sums.add(code, { t24: s.tech24, t: s.tech });
            for (const [code, s] of consumerBase(ctx).sums.own) sums.add(code, { live: s.live || 0 });
            return Object.assign({}, p, { sums: sums.rollup() });
        },
        value: (s) => Object.assign(ratio(s.t24, s.live, 10000), { inputs: { technicalOpen: s.t || 0 } })
    },
    {
        id: 'docket_closure_days_avg', pillar: 'grievance', label: 'Average time to close a docket', unit: 'days', direction: 'lower', levels: ALL, listType: true,
        datasets: ['docket_kpi'], maxAgeDays: 45, minBase: 50,
        formula: 'Σ Sum of Diff (days) ÷ Σ Count of doc_no, closed dockets',
        compute(ctx) {
            const sums = makeSums(ctx.tree);
            for (const r of ctx.rows('docket_kpi')) {
                if (!str(r, 'ccc_code')) continue;
                const tech = str(r, 'description') === 'B';
                const n = nz(r, 'count_of_doc_no'), d = nz(r, 'sum_of_diff');
                sums.add(ctx.tree.place(r, (x) => ({ codes: [str(x, 'ccc_code')] })), { n, d, tn: tech ? n : 0, td: tech ? d : 0 });
            }
            return { sums: sums.rollup(), asOn: '2025-06-30', period: 'closed Jan 2023 to Jun 2025 (docket/kpi.html label; the sheet has no date)', flags: ['no_date_in_sheet'] };
        },
        value: (s) => Object.assign(ratio(s.d, s.n), { inputs: { technicalAvgDays: s.tn ? r2(s.td / s.tn) : null, technicalClosed: s.tn } })
    },
    {
        id: 'cmo_open_share', pillar: 'grievance', label: 'CMO grievances pending with an MZO officer', unit: '%', direction: 'lower', levels: ['region', 'zone'], listType: true,
        naReason: 'CMO grievances carry only the district (region); blocks do not map reliably to CCCs or divisions',
        datasets: ['cmo_grievances'], maxAgeDays: 14, minBase: 10,
        formula: '100 × grievances whose Pending With is an officer (not "Disposed / pending with HQ") ÷ grievances on the report',
        compute(ctx) {
            const rows = ctx.rows('cmo_grievances');
            const asOn = maxDate(rows.map((r) => dv(r, 'report_date')));
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                const open = str(r, 'pending_with').trim() !== 'Disposed / pending with HQ'; // cmo.html's rule
                const code = ctx.tree.place(r, (x) => ({ regions: [str(x, 'district')] })) || ctx.tree.zone; // "Not Known" district → the zone
                sums.add(code, { n: 1, open: open ? 1 : 0, openAge: open ? nz(r, 'grievance_since') : 0 });
            }
            return { sums: sums.rollup(), asOn, period: 'as on ' + asOn };
        },
        value: (s) => Object.assign(ratio(s.open, s.n, 100), { inputs: { openAvgDays: s.open ? r2(s.openAge / s.open) : null } })
    },

    // ---------------------------------------------------------------- Safety & other
    {
        id: 'accidents_fatal_12m', pillar: 'safety', label: 'Fatal electrical accidents (people) in 12 months', unit: 'count', direction: 'lower', levels: ALL, listType: true,
        datasets: ['accident_reports'], maxAgeDays: 60,
        formula: 'count of accidents with Nature of Injury Fatal and Type of Victim Human in the 365 days to the latest accident',
        compute(ctx) {
            const rows = ctx.rows('accident_reports');
            const loc = (r) => ctx.tree.place(r, (x) => ({ codes: [str(x, 'code_of_ccc_substation_re_project')], cccs: [str(x, 'name_of_ccc_substation_re_project')], divisions: [str(x, 'name_of_division_re_project')], regions: [str(x, 'name_of_the_region')] }));
            const mzo = rows.filter((r) => loc(r));
            const last = maxDate(mzo.map((r) => dv(r, 'date_of_accident')));
            const start = addDays(last, -364);
            const sums = makeSums(ctx.tree);
            for (const r of mzo) {
                const d = dv(r, 'date_of_accident');
                if (!d || d < start) continue;
                const fatal = /^fatal$/i.test(str(r, 'nature_of_injury')) && /^human$/i.test(str(r, 'type_of_victim'));
                sums.add(loc(r), { fatal: fatal ? 1 : 0, all: 1, staff: fatal && /outsourced|departmental|employee/i.test(str(r, 'category_of_victim')) ? 1 : 0 });
            }
            return { sums: sums.rollup(), asOn: last, period: start + ' to ' + last, checks: [{ kind: 'rows_outside_zone', value: rows.length - mzo.length }] };
        },
        value: (s) => ({ value: s.fatal || 0, numerator: s.fatal || 0, denominator: null, inputs: { allAccidents: s.all || 0, fatalOutsourcedStaff: s.staff || 0 } })
    },
    {
        id: 'safety_rectification_share', pillar: 'safety', label: 'Unsafe sites found by the safety app that are rectified', unit: '%', direction: 'higher', levels: ALL, listType: true,
        datasets: ['safety_inspection'], maxAgeDays: 45, minBase: 20,
        formula: '100 × sites with a Rectification done on date ÷ inspected sites (first row per Site ID, as safety_inspection.html counts)',
        compute(ctx) {
            const rows = ctx.rows('safety_inspection');
            const seen = new Set();
            const sums = makeSums(ctx.tree);
            let last = '', repeats = 0;
            for (const r of rows) {
                const site = str(r, 'site_id').trim();
                if (seen.has(site)) { repeats++; continue; }
                seen.add(site);
                const d = dv(r, 'entered_on'); if (d > last) last = d;
                const done = dv(r, 'rectification_done_on'); if (done > last) last = done;
                sums.add(ctx.tree.place(r, (x) => ({ cccs: [str(x, 'office')] })), { n: 1, fixed: done ? 1 : 0 });
            }
            return { sums: sums.rollup(), asOn: last, period: 'entries and rectifications up to ' + last, checks: [{ kind: 'repeat_rows_of_a_site_dropped', value: repeats }] };
        },
        value: (s) => ratio(s.fixed, s.n, 100)
    },
    {
        id: 'si_works_completed_share', pillar: 'safety', label: 'Priority system-improvement works completed', unit: '%', direction: 'higher', levels: ABOVE_CCC,
        naReason: 'SI works are listed by division only',
        datasets: ['si_works'], maxAgeDays: 60, minBase: 5, listType: true,
        formula: '100 × works with Status Completed ÷ works listed',
        compute(ctx) {
            const rows = ctx.rows('si_works');
            const sums = makeSums(ctx.tree);
            const asOn = maxDate(rows.map((r) => dv(r, 'updated_at')));
            for (const r of rows) {
                const status = str(r, 'status');
                const done = /^completed$/i.test(status.trim());
                const td = dv(r, 'target_date');
                sums.add(ctx.tree.place(r, (x) => ({ divisions: [str(x, 'division')], regions: [str(x, 'region')] })), { n: 1, done: done ? 1 : 0, overdue: !done && td && td < asOn ? 1 : 0, noStatus: status ? 0 : 1 });
            }
            return { sums: sums.rollup(), asOn, period: 'last update ' + asOn };
        },
        value: (s) => Object.assign(ratio(s.done, s.n, 100), { inputs: { overduePastTarget: s.overdue, noStatus: s.noStatus } })
    },
    {
        id: 'capex_balance_aged_share', pillar: 'safety', label: 'Capex material balance with contractors over 90 days', unit: '%', direction: 'lower', levels: ALL, listType: true,
        datasets: ['capex_details', 'costcenter'], maxAgeDays: 45,
        formula: '100 × Net Balance Value with Ageing in Days > 90 ÷ Net Balance Value, latest Reporting Date only',
        compute(ctx) {
            // Old SAP cost centres are already placed in the rows (lib/uniform.js loads data/costcenter.json).
            const rows = ctx.rows('capex_details');
            const asOn = maxDate(rows.map((r) => dv(r, 'reporting_date')));
            const sums = makeSums(ctx.tree);
            let old = 0;
            for (const r of rows) {
                if (dv(r, 'reporting_date') !== asOn) { old++; continue; }
                const v = nz(r, 'net_balance_value');
                sums.add(ctx.tree.place(r, (x) => ({ codes: [str(x, 'cost_centre')] })), { v, aged: nz(r, 'ageing_in_days') > 90 ? v : 0 });
            }
            return { sums: sums.rollup(), asOn, period: 'as on ' + asOn, checks: [{ kind: 'older_report_rows_dropped', value: old }, { kind: 'rows_not_in_zone', value: sums.unmapped }] };
        },
        value: (s) => Object.assign(ratio(s.aged, s.v, 100), { inputs: { balanceRsLakh: r2(s.v / 1e5) } })
    },
    {
        id: 'onm_advance_aged_share', pillar: 'safety', label: 'O&M material advance over 90 days', unit: '%', direction: 'lower', levels: ABOVE_CCC, listType: true,
        naReason: 'O&M orders are raised by divisions; the few rows on a CCC cost centre are counted in their division',
        datasets: ['onm_advance', 'costcenter'], maxAgeDays: 45,
        formula: '100 × Mat Balance(Value) of orders created > 90 days before the latest order ÷ Mat Balance(Value)',
        compute(ctx) {
            const rows = ctx.rows('onm_advance');
            const asOn = maxDate(rows.map((r) => dv(r, 'creation_date')));
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                const v = nz(r, 'mat_balance_value');
                const age = daysBetween(dv(r, 'creation_date'), asOn);
                sums.add(ctx.tree.place(r, (x) => ({ codes: [str(x, 'resp_cctr')], divisions: [str(x, 'plant')] })), { v, aged: age > 90 ? v : 0 });
            }
            return { sums: sums.rollup(), asOn, period: 'orders to ' + asOn, unmapped: sums.unmapped };
        },
        value: (s) => Object.assign(ratio(s.aged, s.v, 100), { inputs: { balanceRsLakh: r2(s.v / 1e5) } })
    },

    // ---------------------------------------------------------------- Context (scale, not scored)
    {
        id: 'live_consumers', pillar: 'context', label: 'Live consumers', unit: 'count', direction: 'context', levels: ALL,
        datasets: ['consumers'], maxAgeDays: 45,
        formula: 'Σ COUNT where CONN_STAT = LIVE',
        compute(ctx) { const C = consumerBase(ctx); return { sums: C.sums, asOn: C.asOn, period: 'as on ' + C.asOn }; },
        value: (s) => ({ value: s.live || 0, numerator: s.live || 0, denominator: null, inputs: { osdLiveLakh: r2(s.osd_live || 0), osdDeemedDisconnectedLakh: r2(s.osd_deemed || 0) } })
    },
    {
        id: 'dtr_count', pillar: 'context', label: 'Distribution transformers', unit: 'count', direction: 'context', levels: ALL, listType: true,
        datasets: ['dtr_records'], maxAgeDays: 365,
        formula: 'DTR records and Σ CAPA_KV',
        compute(ctx) {
            const sums = makeSums(ctx.tree);
            for (const r of ctx.rows('dtr_records')) sums.add(ctx.tree.place(r, dtrCells), { n: 1, kva: nz(r, 'capa_kv') });
            return { sums: sums.rollup(), asOn: ctx.snapshotAt('dtr_records'), period: 'inventory (no date in the sheet)', flags: ['no_date_in_sheet'] };
        },
        value: (s) => ({ value: s.n || 0, numerator: s.n || 0, denominator: null, inputs: { kva: Math.round(s.kva || 0) } })
    }
];
const METRICS_BY_ID = Object.fromEntries(METRICS.map((m) => [m.id, m]));

const dtrCells = (x) => ({ cccs: [str(x, 'supp_off')], divisions: [str(x, 'divn_name')], regions: [str(x, 'region')] });
/** The PM Surya Ghar export's glossary row under the header ("Logic" in Sl.No, "Value" in the office cells). */
const isGlossary = (r) => /^logic$/i.test(str(r, 'sl_no').trim()) || (str(r, 'sub_division_name') === 'Value' && str(r, 'division_name') === 'Value');

// ---- dataset passes shared by several metrics ---------------------------------------------

function nscPass(ctx) {
    return ctx.memo('nsc', () => {
        const rows = ctx.rows('nsc_pending');
        const sums = makeSums(ctx.tree);
        let asOn = '';
        for (const r of rows) {
            const t = dv(r, 'today'); if (t > asOn) asOn = t;
            const age = nz(r, 'delayinsc'), wo = numv(r, 'delayinwo');
            sums.add(ctx.tree.place(r, (x) => ({ codes: [str(x, 'ccc_code')], cccs: [str(x, 'supp_off')], divisions: [str(x, 'divn_name')], regions: [str(x, 'reg')] })), {
                n: 1, ageSum: age, le7: age <= 7 ? 1 : 0, le15: age <= 15 ? 1 : 0, over30: age > 30 ? 1 : 0, over180: age > 180 ? 1 : 0, over365: age > 365 ? 1 : 0,
                qtnSum: nz(r, 'delayinqtn'), woSum: isFinite(wo) ? wo : 0, woN: isFinite(wo) ? 1 : 0
            });
        }
        return { sums: sums.rollup(), asOn, period: 'as on ' + asOn, unmapped: sums.unmapped };
    });
}

function remWeeks(ctx) {
    return ctx.memo('rem', () => {
        const byDate = new Map();
        for (const r of ctx.rows('rem_osd')) {
            const d = dv(r, 'report_date_email_date');
            if (!d) continue;
            if (!byDate.has(d)) byDate.set(d, []);
            byDate.get(d).push({
                code: ctx.tree.place(r, (x) => ({ codes: [str(x, 'ccc_code')], cccs: [str(x, 'ccc_name')], divisions: [str(x, 'division')], regions: [str(x, 'region_name')] })),
                count: nz(r, 'total_count'), amount: nz(r, 'total_amount_in_lakhs')
            });
        }
        const dates = [...byDate.keys()].sort();
        return { byDate, dates, latest: dates[dates.length - 1] };
    });
}

function defectivePass(ctx) {
    return ctx.memo('defective', () => {
        const rows = ctx.rows('defective_summary');
        const asOn = maxDate(rows.map((r) => dv(r, 'report_as_on')));
        const yr = asOn.slice(0, 4);
        const sums = makeSums(ctx.tree);
        for (const r of rows) {
            sums.add(ctx.tree.place(r, (x) => ({ codes: [str(x, 'ccc_code')] })), { total: nz(r, 'total'), over5: nz(r, 'over5'), over10: nz(r, 'over10'), thisYear: str(r, 'defect_year') === yr ? nz(r, 'total') : 0 });
        }
        return { sums: sums.rollup(), asOn, period: 'as on ' + asOn };
    });
}

function smartPass(ctx) {
    return ctx.memo('smart', () => {
        const sums = makeSums(ctx.tree);
        for (const r of ctx.rows('smart_meter_status')) {
            if (!str(r, 'meter_supply_qty') && !str(r, 'con_id')) continue;
            const inst = !!str(r, 'meter_installed_qty_in_field_active_in_hes'), push = !!str(r, 'total_submit_in_ami_portal');
            sums.add(ctx.tree.place(r, (x) => ({ codes: [str(x, 'ccc_final')] })), { n: 1, inst: inst ? 1 : 0, push: push ? 1 : 0, pushInst: inst && push ? 1 : 0 });
        }
        // The status sheet has no date; the dashboard shows the Date cell of the work-order tab of the same workbook.
        const wo = ctx.has('smart_meter_work_orders') ? ctx.rows('smart_meter_work_orders') : [];
        const asOn = maxDate(wo.map((r) => dv(r, 'date')));
        return { sums: sums.rollup(), asOn, period: 'as on ' + asOn + ' (work-order tab date, as the dashboard shows)', flags: ['as_on_from_work_order_tab'], unmapped: sums.unmapped };
    });
}

function feederPass(ctx) {
    return ctx.memo('feeder', () => {
        const rows = ctx.rows('feeder_outage');
        const months = [...new Set(rows.map((r) => str(r, 'report_month').trim()).filter((m) => /^\d{6}$/.test(m)))].sort();
        const keep = new Set(months.slice(-12));
        const sums = makeSums(ctx.tree);
        const used = [];
        for (const r of rows) {
            const ym = str(r, 'report_month').trim();
            if (!keep.has(ym)) continue;
            used.push(r);
            const days = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(4), 0)).getUTCDate();
            const cnt = nz(r, 'total_count_of_outage_over_5_min'), min = nz(r, 'total_duration_of_outage_over_5_min');
            sums.add(ctx.tree.place(r, (x) => ({ divisions: [str(x, 'division_name')], regions: [str(x, 'circle_name')] })), { fm: 1, cnt, min, concern: min >= days * 60 || cnt >= 30 ? 1 : 0 });
        }
        const last = months[months.length - 1];
        return { sums: sums.rollup(), rows: used, asOn: monthEnd(+last.slice(0, 4), +last.slice(4)), period: months.slice(-12)[0] + ' to ' + last + ' (12 report months)', unmapped: sums.unmapped };
    });
}

// docket.html's technical (fault) problem types.
const DOCKET_TECH = new Set(['Meter defective and No Power', 'Meter (Tampering)', 'Service (main) problem', 'Service (main) problem (UG cable)', 'Service(main) problem(OH Line)', 'Breakage or uprooting of pole', 'Flashing/Glowing', 'No power', 'Dis. transformer problem', 'Voltage fluctuation', 'Insulator break at pole', 'Earthing problem', 'Fuse problem', 'Alteration of Services', 'Load Shedding Problem', 'Bird fault', 'Conductor snap', 'LT wire problem', 'Sagging of wire', 'Single phasing', 'Voltage complaint', 'Cable fault', 'Cable fault where RMU exists', 'Cable fault where no RMU exists', 'Frequent tripping', 'Short circuit', 'Problem in Shifting of Meter']);

/** Docket creation time "dd/mm/yyyy hh.mm" (or a uniform date-time) → ms, the sheet's wall clock read as UTC. */
function docketTime(s) {
    let m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2})[.:](\d{2})/);
    if (m) return Date.UTC(+m[3], m[2] - 1, +m[1], +m[4], +m[5]);
    m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : NaN;
}

function docketPass(ctx) {
    return ctx.memo('docket', () => {
        const rows = ctx.rows('docket_calls');
        const latest = rows.reduce((a, r) => { const t = docketTime(str(r, 'doc_crn_dt')); return t > a ? t : a; }, 0);
        const sums = makeSums(ctx.tree);
        for (const r of rows) {
            if (!str(r, 'doc_no')) continue;
            const h = (latest - docketTime(str(r, 'doc_crn_dt'))) / 36e5;
            const tech = DOCKET_TECH.has(str(r, 'prob_type').trim());
            sums.add(ctx.tree.place(r, (x) => ({ codes: [str(x, 'ccc_code')], cccs: [str(x, 'ccc_name')] })), { n: 1, o48: h >= 48 ? 1 : 0, o30d: h >= 720 ? 1 : 0, tech: tech ? 1 : 0, tech24: tech && h >= 24 ? 1 : 0 });
        }
        const asOn = latest ? new Date(latest).toISOString().slice(0, 10) : '';
        return { sums: sums.rollup(), asOn, period: 'open dockets up to ' + (latest ? new Date(latest).toISOString().slice(0, 16).replace('T', ' ') : '') + ' (sheet time)', unmapped: sums.unmapped };
    });
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
/** Important-data report sheets (schema header: false, columns col_a…): office rows have the CCC code in column D. */
function reportSheet(ctx, key, dateRe, dateGroup) {
    return ctx.memo('report:' + key, () => {
        const rows = ctx.rows(key);
        const t = ctx.table(key);
        // The title cells of the first rows, in sheet column order.
        const names = (t.columns || (rows[0] ? Object.keys(rows[0]) : [])).filter((n) => /^col_[a-z]+$/.test(n))
            .sort((a, b) => colIndex(a) - colIndex(b));
        let asOn = '';
        for (const r of rows.slice(0, 6)) {
            const m = names.map((n) => str(r, n)).join(' ').match(dateRe);
            if (m) { asOn = date(m[dateGroup || 1].replace(/\.$/, '')); break; }
        }
        const out = [];
        let totals = 0;
        for (const r of rows) {
            const code = str(r, 'col_d').trim();
            if (/^66\d{5}$/.test(code)) out.push({ code: ctx.tree.place(r, () => ({ codes: [code] })), r });
            else if (/total|zone|region/i.test(str(r, 'col_a') + str(r, 'col_b')) && !/^zone$/i.test(str(r, 'col_a').trim())) totals++;
        }
        return { rows: out, asOn, checks: [{ kind: 'office_rows', value: out.length }, { kind: 'total_rows_ignored', value: totals }] };
    });
}
function colIndex(name) {
    const s = name.slice(4);
    let n = 0;
    for (let i = 0; i < s.length; i++) n = n * 26 + LETTERS.indexOf(s[i]) + 1;
    return n;
}

const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
function round(s) { const o = {}; for (const k in s) o[k] = r2(s[k]); return o; }

// ---- what each dataset must carry -----------------------------------------------------------
// The uniform fields this module reads, per dataset, with the type they are read as. A schema may
// pin another type (the accessors read typed values and raw text alike). A required field missing
// from a dataset's rows stops the metrics that read it ("field missing" in errors) instead of
// reading zeros; for: [metric ids] limits that to those metrics; soft: [ids] lets them run without
// it (warnings say what was left out: the loss targets); opt: only used to recognise rows booked
// at the zone office itself. docs/rating/schema-needs.md is this table for people.

const T = (o) => Object.assign({ type: 'text' }, o), N = (o) => Object.assign({ type: 'number' }, o), Dt = (o) => Object.assign({ type: 'date', order: 'dmy' }, o);
const OPT = { opt: true };
const TARGETS = { soft: ['atc_loss', 'distribution_loss'] };
const NEEDS = {
    loss_report: { ccc: T(), year: N(), month: N(), update_on: Dt(), cum_input_mu: N(), cum_demand_mu: N(), cum_collec_mu: N() },
    loss_targets: { ccc: T(TARGETS), cum_input_mu: N(TARGETS), cum_demand_mu: N(TARGETS), cum_collec_mu: N(TARGETS) },
    consumers: { ccc_code: T(), date: Dt(), conn_stat: T(), count: N(), osd_lakh: N({ for: ['receivable_days', 'live_consumers'] }), type_of_meter: T({ for: ['unmetered_share'] }) },
    collection_report: { payment_dt: N(), ccc_code: T(), amount_paid: N() },
    rem_osd: { report_date_email_date: Dt(), ccc_code: T(), ccc_name: T(), division: T(), region_name: T(), total_count: N(), total_amount_in_lakhs: N() },
    disconnection: { ccc_code: T(), con_id: T(), notosd: N(), paid_discon_date: T(), final_paid_amount: N(), dom_base_date: T(OPT), ind_com_base_date: T(OPT) },
    theft_assessment: { location_code: T(), ccc_name: T(), inspection_date: Dt(), final_bill_amt: N(), provsnl_bill_amt: N(), payment_amt: N() },
    nsc_pending: { ccc_code: T(), supp_off: T(), divn_name: T(), reg: T(), today: Dt(), delayinsc: N({ for: ['nsc_pending_over_30d_share', 'nsc_pending_avg_days'] }), delayinwo: N({ for: ['nsc_wo_delay_avg'] }), delayinqtn: N({ for: ['nsc_qtn_delay_avg'] }) },
    withheld: { ccc_code: T(), supp_off: T(), divn_name: T(), region: T(), today: Dt(), scn_witheld_date: Dt(), scn_witheld_reason: T() },
    historical_nsc: { ccc_code: T(), meter_install_date: T(), d: N(), c: N(), i: N(), a: N(), o: N() },
    weekly_report: { ccc_code: T(), ccc: T(), date_of_report_in_current_week: Dt(), to_be_disposed_dom: N(), to_be_disposed_com: N(), to_be_disposed_ind: N(), total_disposed_dom: N(), total_disposed_com: N(), total_disposed_ind: N(), conn_eff_dom: N(), conn_eff_com: N(), conn_eff_ind: N() },
    pending_mc: { substr_a_supp_off_7_7: T(), ccc: T(), division: T(), region: T(), supp_off: T(OPT), divn: T(OPT), report_date: Dt(), meter_installation_date: Dt() },
    load_extension: { ccc_code: T(), report_date: Dt(), age_months: N() },
    solar_connections: { ccc_code: T(), supp_off: T(), solar_appl_no: T(), con_id: T(), replace_status: T(), creation_date: Dt(), report_date: Dt() },
    pmsgy_malda: { sl_no: T(), sub_division_name: T(), division_name: T(), district: T(OPT), installation_status: T(), net_metering_date: Dt(), last_action_date: Dt() },
    pmsgy_uttar_dinajpur: null, // same fields as pmsgy_malda (set below)
    pmsgy_dakshin_dinajpur: null,
    defective_summary: { ccc_code: T(), report_as_on: T(), total: N(), over5: N({ for: ['defective_over5y_share'] }), over10: N({ for: ['defective_over5y_share'] }), defect_year: N({ for: ['defective_over5y_share'] }) },
    smart_meter_status: { ccc_final: T(), meter_supply_qty: T(), con_id: T(), meter_installed_qty_in_field_active_in_hes: T(), total_submit_in_ami_portal: T() },
    smart_meter_work_orders: { date: Dt() },
    meter_erp: { serial_number: T(), entry_date: Dt(), cost_center: T() },
    meter_master: { meter_no: T() },
    meter_crm: { meter_number: T() },
    meter_isu: { meter_no: T(), replaced_by: T() },
    important_unbilled_3_months: { col_a: T(), col_b: T(), col_c: T(), col_d: T(), col_q: N() },
    important_first_bill_pending: { col_a: T(), col_b: T(), col_d: T(), col_j: N() },
    important_rem_less_unit_billed: { col_a: T(), col_b: T(), col_d: T(), col_f: N(), col_i: N(), col_m: N() },
    feeder_outage: { report_month: T(), division_name: T(), circle_name: T(), substation_name: T({ for: ['dtr_weighted_outage_hours'] }), feeder_name: T({ for: ['dtr_weighted_outage_hours'] }), total_count_of_outage_over_5_min: N(), total_duration_of_outage_over_5_min: N() },
    dtr_records: { supp_off: T(), divn_name: T(), region: T(), ss_name: T({ for: ['dtr_weighted_outage_hours'] }), fdr_name: T({ for: ['dtr_weighted_outage_hours'] }), capa_kv: N({ for: ['dtr_count'] }) },
    docket_calls: { doc_no: T(), ccc_code: T(), ccc_name: T(), doc_crn_dt: T(), prob_type: T({ for: ['fault_dockets_open_over_24h_per_10k', 'docket_open_over_48h_share'] }) },
    docket_kpi: { ccc_code: T(), description: T(), count_of_doc_no: N(), sum_of_diff: N() },
    cmo_grievances: { district: T(), report_date: Dt(), pending_with: T(), grievance_since: N() },
    accident_reports: { code_of_ccc_substation_re_project: T(OPT), name_of_ccc_substation_re_project: T(), name_of_division_re_project: T(), name_of_the_region: T(), date_of_accident: Dt(), nature_of_injury: T(), type_of_victim: T(), category_of_victim: T() },
    safety_inspection: { site_id: T(), office: T(), entered_on: Dt(), rectification_done_on: Dt() },
    si_works: { region: T(), division: T(), status: T(), target_date: T(), updated_at: T() },
    capex_details: { reporting_date: Dt(), cost_centre: T(), net_balance_value: N(), ageing_in_days: N() },
    onm_advance: { creation_date: T(), resp_cctr: T(), plant: T(), mat_balance_value: N() }
};
NEEDS.pmsgy_uttar_dinajpur = NEEDS.pmsgy_malda;
NEEDS.pmsgy_dakshin_dinajpur = NEEDS.pmsgy_malda;

// Dataset-level schema options for the rating's own rows (schemaFor): the office roles the owners'
// schemas use, so offices agree with the pages, and no office columns where none are read.
const SCHEMA_OPTS = {
    loss_report: { offices: false }, // read by name (lossData)
    loss_targets: { offices: false },
    important_unbilled_3_months: { header: false, offices: { codes: ['col_d'] } },
    important_first_bill_pending: { header: false, offices: { codes: ['col_d'] } },
    important_rem_less_unit_billed: { header: false, offices: { codes: ['col_d'] } },
    meter_erp: { offices: { codes: ['cost_center'] } },
    meter_master: { offices: false },
    meter_crm: { offices: false },
    meter_isu: { offices: false },
    smart_meter_status: { offices: { codes: ['ccc_final'] } },
    smart_meter_work_orders: { offices: false },
    onm_advance: { offices: { codes: ['resp_cctr'], divisions: ['plant'] } }
};
/**
 * The rating's own lean schema for a dataset: only the fields this module reads (keep: pinned),
 * with the office roles above. The VM precompute builds its rows with it, so it never depends on
 * which fields the pages' schema/<key>.json files pin.
 */
function schemaFor(key) {
    const need = NEEDS[key];
    if (!need) return null;
    const fields = {};
    for (const [f, spec] of Object.entries(need)) fields[f] = spec.order ? { type: spec.type, order: spec.order } : { type: spec.type };
    return Object.assign({ key, keep: 'pinned' }, SCHEMA_OPTS[key] || {}, { fields });
}

/** Every dataset key the metrics read (costcenter is not one: offices come placed in the rows). */
const DATASETS = Object.keys(NEEDS);

/** Datasets that the given metrics (default: all) read, in METRICS order. */
function datasetsFor(ids) {
    const want = ids ? new Set(ids) : null;
    const out = [];
    const add = (k) => { if (NEEDS[k] !== undefined && !out.includes(k)) out.push(k); };
    for (const m of METRICS) {
        if (want && !want.has(m.id)) continue;
        m.datasets.forEach(add);
        // passes shared through memos: withheld also counts pending NSC, receivable days the OSD
        if (m.id === 'nsc_withheld_network_share') add('nsc_pending');
    }
    return out;
}

/** Metric ids a rating method (lib/rating.js METHOD) reads: its parameters, its penalties and live consumers. */
function ratedIds(method) {
    const ids = new Set(['live_consumers']);
    for (const p of (method && method.pillars) || []) for (const x of p.params || []) if (x.metric) ids.add(x.metric);
    for (const x of (method && method.penalties) || []) if (x.metric) ids.add(x.metric);
    return METRICS.map((m) => m.id).filter((id) => ids.has(id));
}

// ---- compute ------------------------------------------------------------------------------

const FLAGS = {
    // Per office: how to read an entry.
    stale: 'The data is older than the metric\'s maxAgeDays on the reference date.',
    small_base: 'The denominator (or case count) is below the metric\'s minBase: the value swings with a few cases.',
    no_cases: 'Nothing on the list for this office (zero cases): a share has no value, a count or rate per consumer is 0.',
    no_rows: 'The source has no row for this office.',
    level_not_available: 'The source cannot place rows at this level (see naReason); score the office without this metric.',
    includes_own_level_rows: 'Some inputs sit at this office itself, not in any child (HT / bulk / division-booked rows); ownLevel gives them.',
    base_month_outlier: 'The year-earlier loss row looks misplaced (over 10 pts from its neighbouring months); the median of the three months is the base.',
    low_match_coverage: 'Under 60 % of this office\'s DTRs are on feeders matched to the outage data.',
    // Caveats from docs/data-quality.md that change how a metric should be read.
    details_mixed_as_on_not_used: 'Defective details mix the 16/10 and 23/10 dumps; only the summary (all 16/10) is used.',
    storage_copy_behind_sheet: 'The app reads the Storage copy of pending MC (28/10); the Google sheet is newer (30/10).',
    pending_withheld_overlap_12: '12 applications are in both the pending (30/10) and withheld (29/10) lists.',
    ht_region_collections_excluded: 'Collections booked at region offices (HT) are left out because the consumer OSD sheet has no HT rows.',
    no_date_in_sheet: 'The sheet has no report date; the date shown is the mirror copy date or the page label.',
    feeder_name_match: 'Feeder outage rows have no CCC; feeders are tied to CCCs through the DTR list by substation and feeder name (about 3 in 4 feeders match); unmatched feeders are left out and coverage is in inputs.',
    as_on_from_work_order_tab: 'The smart-meter status tab has no date; the dashboard (and this metric) use the Date cell of the work-order tab of the same workbook (12/11/2025).',
    columns_inferred_from_page_labels: 'Merged headers are lost in the export; columns follow important_sheets.html (I = under 10 units, M = zero units).'
};

function officesModule(opts) {
    if (opts && opts.offices) return opts.offices;
    if (root && root.MzoOffices) return root.MzoOffices;
    if (typeof module === 'object' && module.exports && typeof require === 'function') return require('./offices.js');
    throw new Error('lib/offices.js is not loaded');
}

/** Fields of a dataset that metric `id` needs and its rows do not carry: { hard: [], soft: [] }. */
function lacking(ctx, key, id) {
    const need = NEEDS[key];
    if (!need) return { hard: [], soft: [] };
    const applies = (s) => !s.opt && (!s.for || s.for.includes(id));
    const hard = Object.keys(need).filter((f) => applies(need[f]) && !(need[f].soft && need[f].soft.includes(id)));
    const soft = Object.keys(need).filter((f) => need[f].soft && need[f].soft.includes(id));
    return { hard: ctx.lacks(key, hard), soft: ctx.lacks(key, soft) };
}

/**
 * The metrics document from uniform rows.
 * @param source { key: rows } | (key) => rows   rows: MzoRows t | object[] | build() result | rows document
 * @param opts { offices, asOf, generatedAt, manifest, mode, only, release, loadErrors }
 */
function computeSync(source, opts) {
    opts = opts || {};
    const O = officesModule(opts);
    const tree = officeTree(O);
    const loadErrors = opts.loadErrors || {};
    const load = (key) => {
        if (loadErrors[key]) return null;
        let x;
        try { x = typeof source === 'function' ? source(key) : source && source[key]; } catch (e) { loadErrors[key] = String(e && e.message || e); return null; }
        if (x && typeof x.then === 'function') throw new Error('computeSync: the source returned a promise for ' + key + '; use compute()');
        return asTable(x);
    };
    const only = opts.only ? new Set(opts.only) : null;
    const uses = new Map();
    for (const m of METRICS) if (!only || only.has(m.id)) for (const k of m.datasets) uses.set(k, (uses.get(k) || 0) + 1);
    const ctx = makeContext(load, opts.manifest, tree, O, uses, !!opts.release);
    const manifest = opts.manifest || null;
    const asOf = opts.asOf || (manifest && String(manifest.generatedAt || '').slice(0, 10)) || new Date().toISOString().slice(0, 10);
    const out = {
        generatedAt: opts.generatedAt || new Date().toISOString(),
        logic: LOGIC + '+' + O.VERSION,
        referenceDate: asOf,
        source: { manifestGeneratedAt: (manifest && manifest.generatedAt) || null, mode: opts.mode || 'rows' },
        notes: 'Office aggregates only. Each level is computed from its own summed inputs (own-level rows + all children). value is in the metric unit; numerator and denominator are the summed inputs behind it.',
        metrics: {},
        flags: FLAGS,
        checks: {},
        errors: {},
        offices: {}
    };
    for (const o of tree.list) out.offices[o.code] = { level: o.level, name: o.name, parent: o.parent, region: o.region || undefined, division: o.division || undefined, metrics: {} };

    for (const m of METRICS) {
        if (only && !only.has(m.id)) continue;
        let res;
        try {
            // oneAtATime: each dataset is dropped right after its check, and compute loads them one by one.
            const missing = m.datasets.filter((k) => { const ok = k === 'costcenter' || ctx.has(k); if (m.oneAtATime) ctx.drop(k); return !ok; });
            if (missing.length) throw new Error('dataset missing: ' + missing.map((k) => k + (loadErrors[k] ? ' (' + loadErrors[k] + ')' : '')).join(', '));
            const gaps = m.datasets.filter((k) => k !== 'costcenter').map((k) => [k, lacking(ctx, k, m.id)]);
            const list = (which) => gaps.filter((x) => x[1][which].length).map((x) => x[1][which].map((f) => x[0] + '.' + f).join(', ')).join('; ');
            if (list('hard')) throw new Error('field missing: ' + list('hard') + ' (add to schema/<key>.json)');
            if (list('soft')) (out.warnings = out.warnings || {})[m.id] = 'field missing: ' + list('soft') + ' (add to schema/<key>.json); targets left out';
            res = m.compute(ctx);
        } catch (e) {
            out.errors[m.id] = String(e && e.message || e);
            ctx.done(m);
            continue;
        }
        ctx.done(m);
        const age = res.asOn ? daysBetween(res.asOn, asOf) : NaN;
        const stale = !(age <= m.maxAgeDays);
        const flags = (res.flags || []).slice();
        if (stale) flags.unshift('stale');
        out.metrics[m.id] = {
            pillar: m.pillar, label: m.label, unit: m.unit, direction: m.direction, levels: m.levels, datasets: m.datasets,
            formula: m.formula, period: res.period, asOn: res.asOn || null, ageDays: isFinite(age) ? age : null, maxAgeDays: m.maxAgeDays,
            minBase: m.minBase || 0, flags, naReason: m.naReason || undefined,
            unmapped: res.unmapped || (res.sums && res.sums.unmapped) || 0
        };
        if (res.checks && res.checks.length) out.checks[m.id] = res.checks;
        for (const o of tree.list) {
            const entry = { value: null, numerator: null, denominator: null, asOn: res.asOn || null, quality: { status: 'ok', flags: [] } };
            if (!m.levels.includes(o.level)) {
                entry.quality = { status: 'na', flags: ['level_not_available'], reason: m.naReason || 'not available at this level' };
                out.offices[o.code].metrics[m.id] = entry;
                continue;
            }
            const s = res.sums.total.get(o.code) || {};
            const v = m.value(s);
            entry.value = v.value == null || !isFinite(v.value) ? null : Math.round(v.value * 1000) / 1000;
            entry.numerator = v.numerator == null || !isFinite(v.numerator) ? null : Math.round(v.numerator * 1000) / 1000;
            entry.denominator = v.denominator == null || !isFinite(v.denominator) ? null : Math.round(v.denominator * 1000) / 1000;
            if (v.inputs) entry.inputs = v.inputs;
            if (res.extra) Object.assign(entry, res.extra(o.code));
            const q = entry.quality;
            if (stale) { q.status = 'stale'; q.flags.push('stale'); }
            for (const f of res.flags || []) q.flags.push(f);
            if (entry.value == null) {
                if (m.listType && !(entry.denominator > 0)) q.flags.push('no_cases'); // nothing on the list for this office: zero cases, not missing data
                else { if (q.status === 'ok') q.status = 'no_data'; q.flags.push('no_rows'); }
            }
            const base = m.base ? m.base(s) : entry.denominator;
            if (m.minBase && entry.value != null && base != null && base < m.minBase) { q.flags.push('small_base'); if (q.status === 'ok') q.status = 'warn'; }
            const extra = m.warn ? m.warn(s) : [];
            if (extra.length) { q.flags.push(...extra); if (q.status === 'ok') q.status = 'warn'; }
            const ownS = res.sums.own && res.sums.own.get(o.code);
            const childLevel = { zone: 'region', region: 'division', division: 'ccc' }[o.level];
            if (childLevel && m.levels.includes(childLevel) && ownS && Object.values(ownS).some((x) => Math.abs(x) >= 0.05)) {
                const ov = m.value(Object.assign({}, ownS));
                entry.ownLevel = { numerator: ov.numerator == null || !isFinite(ov.numerator) ? null : r2(ov.numerator), denominator: ov.denominator == null || !isFinite(ov.denominator) ? null : r2(ov.denominator) };
                q.flags.push('includes_own_level_rows');
            }
            if (!q.flags.length) delete q.flags;
            out.offices[o.code].metrics[m.id] = entry;
        }
    }
    return out;
}

// ---- browser ------------------------------------------------------------------------------

const OFFICES_SRC = '/lib/offices.js?v=2';
function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = root.document.createElement('script');
        s.src = src; s.async = true;
        s.onload = () => resolve(); s.onerror = () => reject(new Error('could not load ' + src));
        root.document.head.appendChild(s);
    });
}
async function officesReady(opts) {
    if ((opts && opts.offices) || root.MzoOffices) return officesModule(opts);
    if (root.document) await loadScript(OFFICES_SRC);
    return officesModule(opts);
}
async function fetchManifest() {
    if (typeof root.fetch !== 'function' || !root.location) return null;
    try {
        const res = await root.fetch('/api/data/manifest', { credentials: 'same-origin', cache: 'no-cache' });
        if (res.status !== 200) return null; // 204: no mirror (Vercel)
        const m = await res.json();
        return m && m.datasets ? m : null;
    } catch (e) { return null; }
}

/** MzoRows t of each key, unscoped (every office), in parallel. Failures are left out (→ dataset missing). */
async function loadRows(keys, loadErrors) {
    const R = root.MzoRows;
    if (!R || typeof R.get !== 'function') throw new Error('mzo_rows.js is not loaded');
    const out = {};
    await Promise.all((keys || DATASETS).map((k) => Promise.resolve().then(() => R.get(k, { scope: false })).then(
        (t) => { if (t) out[k] = t; else if (loadErrors) loadErrors[k] = 'no rows'; },
        (e) => { if (loadErrors) loadErrors[k] = String(e && e.message || e); })));
    return out;
}

/**
 * Browser entry: → Promise<metricsDoc>. With no source, the rows of every dataset the metrics need
 * (opts.only narrows them) come from MzoRows.get(key, { scope: false }); a function source may
 * return promises. The manifest (asOf, snapshot dates) is read from /api/data/manifest when on the VM.
 * opts.rated: true narrows to the metrics lib/rating.js scores (MzoRating.METHOD), and so the datasets.
 */
async function compute(source, opts) {
    opts = Object.assign({}, opts);
    if (opts.rated && !opts.only) {
        // rated: true (window.MzoRating.METHOD) or a METHOD: only the metrics the rating scores, and their datasets.
        const method = opts.rated === true ? root.MzoRating && root.MzoRating.METHOD : opts.rated;
        if (!method) throw new Error('compute({ rated: true }) needs lib/rating.js (window.MzoRating)');
        opts.only = ratedIds(method);
    }
    opts.offices = await officesReady(opts);
    const keys = datasetsFor(opts.only || null);
    const loadErrors = opts.loadErrors || (opts.loadErrors = {});
    const t0 = Date.now();
    let tables;
    if (source == null) tables = await loadRows(keys, loadErrors);
    else if (typeof source === 'function') {
        tables = {};
        await Promise.all(keys.map((k) => Promise.resolve().then(() => source(k)).then(
            (t) => { if (t) tables[k] = t; }, (e) => { loadErrors[k] = String(e && e.message || e); })));
    } else tables = source;
    const t1 = Date.now();
    if (opts.manifest === undefined) opts.manifest = await fetchManifest();
    if (!opts.mode) opts.mode = 'browser';
    const doc = computeSync(tables, opts);
    compute.last = { loadMs: t1 - t0, computeMs: Date.now() - t1, datasets: Object.keys(tables).length };
    return doc;
}

return {
    LOGIC,
    METRICS,
    FLAGS,
    NEEDS,
    DATASETS,
    SCHEMA_OPTS,
    schemaFor,
    datasetsFor,
    ratedIds,
    computeSync,
    compute,
    loadRows,
    asTable,
    // the pieces, for tests
    num,
    date,
    officeTree
};
});
