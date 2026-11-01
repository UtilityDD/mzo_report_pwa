#!/usr/bin/env node
/* scripts/rating/compute-metrics.js: office-level inputs for the performance rating.
 *
 * Reads the mirror's raw snapshots (exact source bytes) and computes, for every MZO office
 * (zone, 3 regions, 7 divisions, 41 CCCs), each candidate rating metric as a value with its
 * numerator and denominator. Every level is computed from its own summed inputs: a division's
 * figure is the sum of its CCCs' inputs plus any rows that sit at the division itself (bulk /
 * HT / division-booked rows), never an average of the CCC values.
 *
 *   node scripts/rating/compute-metrics.js --snapshots <dir> [--manifest <file>] [--out <file>]
 *   node scripts/rating/compute-metrics.js --mirror https://130.210.43.11.sslip.io --cookie-file <file>
 *        [--save <dir>] [--out <file>]
 *
 * Options: --as-of YYYY-MM-DD (reference date for freshness; default: the manifest's date),
 *          --only id,id (metrics), --offices <path to lib/offices.js>, --generated-at <ISO time>.
 * Mirror mode sends GET requests only (/api/data/manifest, /api/data/file/<key>).
 * The output holds office aggregates only: no consumer, applicant or staff data.
 *
 * Library use: require('./compute-metrics.js').compute({ read, manifest, offices, asOf })
 * where read(key) returns { text, format: 'csv'|'tsv'|'json' } or null. The compute part uses
 * no Node APIs. Metric definitions and data caveats: docs/rating/data-map.md.
 */
'use strict';

const LOGIC = 'rating-metrics/1';

// ---- parsing ------------------------------------------------------------------------------

function parseCsv(text) {
    const s = String(text || '').replace(/^﻿/, '');
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) {
            if (c === '"') {
                if (s[i + 1] === '"') { cell += '"'; i++; } else q = false;
            } else cell += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else if (c !== '\r') cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
}

function parseTsv(text) {
    // Google's TSV export does not quote cells.
    return String(text || '').replace(/^﻿/, '').split('\n').map((l) => l.replace(/\r$/, '').split('\t'))
        .filter((r, i, a) => !(i === a.length - 1 && r.length === 1 && r[0] === ''));
}

/** Rows as objects keyed by trimmed header; a repeated header gets "#2", "#3". Blank rows dropped. */
function toObjects(grid, headerRow) {
    const h = grid[headerRow || 0] || [];
    const seen = {};
    const names = h.map((x) => {
        const n = String(x || '').replace(/\s+/g, ' ').trim();
        seen[n] = (seen[n] || 0) + 1;
        return seen[n] > 1 ? n + '#' + seen[n] : n;
    });
    const out = [];
    for (let r = (headerRow || 0) + 1; r < grid.length; r++) {
        const cells = grid[r];
        if (!cells.some((v) => String(v).trim() !== '')) continue;
        const o = {};
        for (let i = 0; i < names.length; i++) o[names[i]] = cells[i] == null ? '' : String(cells[i]).trim();
        out.push(o);
    }
    return out;
}

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
const n0 = (v) => { const n = num(v); return isFinite(n) ? n : 0; };

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function iso(y, m, d) {
    if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    const t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCMonth() !== m - 1) return '';
    return t.toISOString().slice(0, 10);
}
/** Any date the sources use → 'YYYY-MM-DD' ('' when blank or not a date). order: 'dmy' | 'mdy' for slash dates. */
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
    /** Office code of one row from its office cells ({codes, cccs, divisions, regions}), or null. */
    function locate(cells) {
        const k = JSON.stringify(cells);
        if (memo.has(k)) return memo.get(k);
        const code = codeOf(O.resolve(cells).office);
        if (memo.size < 200000) memo.set(k, code);
        return code;
    }
    return { list, byCode, children, codeOf, locate, zone: O.ZONE.code, divCode, regCode };
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

// ---- data access --------------------------------------------------------------------------

function makeContext(read, manifest, tree, O) {
    const cache = new Map();
    const ctx = {
        tree, O, manifest: manifest || null,
        has(key) { return !!read(key); },
        grid(key) {
            const k = 'grid:' + key;
            if (!cache.has(k)) {
                const src = read(key);
                if (!src) throw new Error('missing dataset ' + key);
                cache.set(k, src.format === 'tsv' ? parseTsv(src.text) : src.format === 'json' ? JSON.parse(src.text) : parseCsv(src.text));
            }
            return cache.get(k);
        },
        rows(key, headerRow) {
            const k = 'rows:' + key + ':' + (headerRow || 0);
            if (!cache.has(k)) {
                const g = ctx.grid(key);
                cache.set(k, Array.isArray(g) && Array.isArray(g[0]) ? toObjects(g, headerRow) : g);
            }
            return cache.get(k);
        },
        memo(name, fn) {
            const k = 'memo:' + name;
            if (!cache.has(k)) cache.set(k, fn());
            return cache.get(k);
        },
        snapshotAt(key) {
            const d = manifest && manifest.datasets && manifest.datasets[key];
            return d ? String(d.snapshotAt || d.fetchedAt || '').slice(0, 10) : '';
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
            asOn = asOn || date(r.Date);
            const code = ctx.tree.locate({ codes: [r.CCC_CODE] });
            const live = r.CONN_STAT === 'LIVE';
            const count = n0(r.COUNT);
            sums.add(code, {
                live: live ? count : 0,
                live_unmetered: live && /no meter/i.test(r.TYPE_OF_METER) ? count : 0,
                live_smart: live && /smart/i.test(r.TYPE_OF_METER) ? count : 0,
                osd_live: live ? n0(r.OSD_LAKH) : 0,
                osd_deemed: /deemed/i.test(r.CONN_STAT) ? n0(r.OSD_LAKH) : 0,
                all: count
            });
        }
        return { sums: sums.rollup(), asOn, unmapped: sums.unmapped };
    });
}
const liveOf = (ctx, code) => (consumerBase(ctx).sums.total.get(code) || {}).live || 0;

/** Loss report (and targets): per-month component sums with region/zone-level residuals. */
function lossData(ctx, key) {
    return ctx.memo('loss:' + key, () => {
        const { O, tree } = ctx;
        const rows = ctx.rows(key);
        const months = new Map(); // yyyymm → { ccc: Map, div: Map, reg: Map, zone }
        const seen = new Set();
        let updateOn = '';
        for (const r of rows) {
            updateOn = updateOn || date(r['Update On']);
            const name = String(r.CCC || '').trim();
            if (!name) continue;
            const ym = key === 'loss_targets' ? 0 : +r.YEAR * 100 + +r.MONTH;
            const dk = ym + '|' + name.toLowerCase();
            if (seen.has(dk)) continue; // the pasted duplicate block repeats month and name
            seen.add(dk);
            const v = { input: n0(r['CUM. INPUT (MU)']), demand: n0(r['CUM. DEMAND(MU)']), coll: n0(r['CUM. COLLEC. (MU)']) };
            let m = months.get(ym);
            if (!m) months.set(ym, (m = { ccc: new Map(), div: new Map(), reg: new Map(), zone: null }));
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
                const d = date(r.PAYMENT_DT);
                lastPay = d > lastPay ? d : lastPay;
                if (!d || d < start || d > end) continue;
                const code = ctx.tree.locate({ codes: [r.CCC_CODE] });
                // Region-office rows (HT, billed at the region) have no OSD in the consumer sheet: left out at every level.
                if (code && ctx.tree.byCode.get(code).level !== 'ccc') { regionRows += n0(r['AMOUNT PAID']); continue; }
                sums.add(code, { coll: n0(r['AMOUNT PAID']) });
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
            const g = ctx.grid('disconnection');
            const rows = toObjects(g);
            let last = '', domBase = '', icBase = '';
            const h = (g[0] || []).map((x) => String(x).trim());
            const iDom = h.indexOf('DOM BASE DATE'), iIc = h.findIndex((x) => /^IND&COM BASE DATE/.test(x));
            if (g[1]) { domBase = date(g[1][iDom]); icBase = date(g[1][iIc]); }
            for (const r of rows) {
                if (!r.CCC_CODE && !r.CON_ID) continue;
                const ds = String(r['PAID/DISCON DATE'] || '').trim();
                const d = /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(ds) ? date(ds) : '';
                if (d > last) last = d;
                const paidStr = String(r['FINAL PAID AMOUNT'] || '').trim();
                const hasPaid = paidStr !== '' && !/^#n\/a$/i.test(paidStr) && paidStr !== '0';
                const osd = isFinite(num(r.NOTOSD)) ? num(r.NOTOSD) : n0(r.NOTOSD_UPD);
                const st = !d ? 'none' : !hasPaid ? 'disconnected' : n0(paidStr) >= osd ? 'paid' : 'part';
                sums.add(ctx.tree.locate({ codes: [r.CCC_CODE] }), { n: 1, acted: st === 'none' ? 0 : 1, paid: st === 'paid' ? 1 : 0, part: st === 'part' ? 1 : 0, disc: st === 'disconnected' ? 1 : 0, osd });
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
            const last = maxDate(rows.map((r) => date(r['Inspection Date'])));
            const start = addDays(last, -364);
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                const d = date(r['Inspection Date']);
                if (!d || d < start) continue;
                const fin = n0(r['Final Bill Amt']), prov = n0(r['Provsnl Bill Amt']);
                sums.add(ctx.tree.locate({ codes: [r['Location Code']], cccs: [r['CCC Name']] }), { cases: 1, assessed: fin > 0 ? fin : prov, paid: n0(r['PAYMENT AMT']) });
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
            const today = date(rows[0] && rows[0].TODAY);
            const start = addDays(today, -364);
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                const d = date(r.SCN_WITHELD_DATE);
                if (!d || d < start || d > today) continue;
                const net = /LT Infrastructure|unable to provide|Techno Economically|installation of Transformer/i.test(r.SCN_WITHELD_REASON);
                sums.add(ctx.tree.locate({ codes: [r.CCC_CODE], cccs: [r.SUPP_OFF], divisions: [r.DIVN_NAME], regions: [r.REGION] }), { w: 1, net: net ? 1 : 0 });
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
            const last = maxDate(rows.map((r) => date(r.METER_INSTALL_DATE, 'mdy')));
            const start = addDays(last, -364);
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                const d = date(r.METER_INSTALL_DATE, 'mdy');
                if (!d || d < start) continue;
                sums.add(ctx.tree.locate({ codes: [r['CCC CODE']] }), { n: n0(r.D) + n0(r.C) + n0(r.I) + n0(r.A) + n0(r.O) });
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
            const dates = [...new Set(rows.map((r) => date(r['Date of report in Current Week'])).filter(Boolean))].sort();
            const keep = new Set(dates.slice(-4));
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                if (!keep.has(date(r['Date of report in Current Week']))) continue;
                let td = 0, dis = 0, eff = 0;
                for (const c of ['DOM', 'COM', 'IND']) { td += n0(r['To be disposed (' + c + ')']); dis += n0(r['Total disposed (' + c + ')']); eff += n0(r['Conn. Eff. (' + c + ')']); }
                sums.add(ctx.tree.locate({ codes: [r['CCC Code']], cccs: [r.CCC] }), { td, dis, eff });
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
                const rep = date(r['Report Date']); asOn = rep > asOn ? rep : asOn;
                const age = daysBetween(date(r['Meter Installation Date']), rep);
                if (!isFinite(age)) noDate++;
                sums.add(ctx.tree.locate({ codes: [r['SUBSTR(A.SUPP_OFF,-7,7)']], cccs: [r.CCC || r.SUPP_OFF], divisions: [r.Division || r.DIVN], regions: [r.Region] }),
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
            const asOn = maxDate(rows.map((r) => date(r.report_date)));
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                const a = parseInt(r.AGE_MONTHS, 10) || 0; // whole months, as the page reads it
                sums.add(ctx.tree.locate({ codes: [r['CCC CODE']] }), { n: 1, over3: a >= 3 ? 1 : 0, over12: a >= 12 ? 1 : 0 });
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
            const asOn = maxDate(rows.map((r) => date(r['Report Date'])));
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                if (!r.SOLAR_APPL_NO && !r.CON_ID) continue;
                const s = String(r.REPLACE_STATUS || '').trim().toUpperCase();
                const st = ['SUCCESS', 'EFFECTED', 'DONE'].includes(s) ? 'done' : (!s || s === '(NULL)' || s === 'NOT YET' || s === 'PENDING') ? 'pending' : 'issue';
                const age = daysBetween(date(r.CREATION_DATE), asOn);
                const old = age > 30;
                sums.add(ctx.tree.locate({ codes: [r['CCC CODE']], cccs: [r.SUPP_OFF] }), { n: 1, done: st === 'done' ? 1 : 0, old: old ? 1 : 0, oldOpen: old && st !== 'done' ? 1 : 0, issue: st === 'issue' ? 1 : 0, recent: age <= 30 ? 1 : 0 });
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
                const rows = ctx.rows(key).slice(1); // row 2 is the column glossary
                for (const r of rows) {
                    const inst = /installation completed/i.test(r['Installation Status']);
                    const nm = date(r['Net Metering Date']);
                    const la = date(r['Last Action Date']);
                    if (la > asOn) asOn = la;
                    const returned = /returned by discom/i.test(r['Installation Status']);
                    sums.add(ctx.tree.locate({ cccs: [r['Sub-Division Name']], divisions: [r['Division Name']], regions: [r.District] }),
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
        datasets: ['meter_erp', 'meter_master', 'meter_crm', 'meter_isu'], maxAgeDays: 45, minBase: 50,
        formula: '100 × ERP meters (issued at least 30 days before the latest ERP entry) found as a new connection or a replacement ÷ those meters',
        compute(ctx) {
            const used = new Set(), repl = new Set();
            for (const r of ctx.rows('meter_master')) { const m = String(r.METER_NO || '').trim(); if (m) used.add(m); }
            for (const r of ctx.rows('meter_crm')) { const m = String(r.METER_NUMBER || '').trim(); if (m) repl.add(m); }
            for (const r of ctx.rows('meter_isu')) { const a = String(r.METER_NO || '').trim(), b = String(r.REPLACED_BY || '').trim(); if (a) repl.add(a); if (b) repl.add(b); }
            const rows = ctx.rows('meter_erp');
            const asOn = maxDate(rows.map((r) => date(r['Entry Date'])));
            const cutoff = addDays(asOn, -30);
            const seen = new Set();
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                const m = String(r['Serial Number'] || '').trim();
                const d = date(r['Entry Date']);
                if (!m || seen.has(m) || !d || d > cutoff) continue;
                seen.add(m);
                const st = repl.has(m) ? 'rep' : used.has(m) ? 'nsc' : 'hand';
                const age = daysBetween(d, asOn);
                sums.add(ctx.tree.locate({ codes: [r['Cost Center']] }), { n: 1, nsc: st === 'nsc' ? 1 : 0, rep: st === 'rep' ? 1 : 0, hand90: st === 'hand' && age > 90 ? 1 : 0 });
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
            for (const r of R.rows) sums.add(r.code, { u: n0(r.cells[16]), rows: 1 });
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
            for (const r of R.rows) sums.add(r.code, { u: n0(r.cells[9]), rows: 1 });
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
            for (const r of R.rows) sums.add(r.code, { lt10: n0(r.cells[8]), zero: n0(r.cells[12]), live: n0(r.cells[5]) });
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
                const code = ctx.tree.locate({ cccs: [r.SUPP_OFF], divisions: [r['DIVN NAME']], regions: [r.REGION] });
                dtrs.add(code, { dtr: 1 });
                const d = ctx.O.parseDivision(r['DIVN NAME']);
                const div = d && d.division || '';
                for (const [map, k] of [[byFeeder, div + '|' + key(r.SS_NAME) + '|' + key(r.FDR_NAME)], [byName, div + '|' + key(r.FDR_NAME)]]) {
                    if (!map.has(k)) map.set(k, new Map());
                    const m = map.get(k);
                    m.set(code, (m.get(code) || 0) + 1);
                }
            }
            const perMonth = new Map(); // month|feeder key → { min, rows, dtrs }
            for (const r of F.rows) {
                const d = ctx.O.parseDivision(r['DIVISION NAME']);
                const div = d && d.division || '';
                const k1 = div + '|' + key(r['SUBSTATION NAME']) + '|' + key(r['FEEDER NAME']), k2 = div + '|' + key(r['FEEDER NAME']);
                const target = byFeeder.get(k1) || byName.get(k2);
                if (!target) continue;
                const mk = r['REPORT MONTH'] + '|' + (byFeeder.has(k1) ? k1 : 'n:' + k2);
                const e = perMonth.get(mk) || { min: 0, rows: 0, target };
                e.min += n0(r['TOTAL DURATION OF OUTAGE OVER 5 MIN']); e.rows++;
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
                if (!r.ccc_code) continue;
                const tech = r.DESCRIPTION === 'B';
                const n = n0(r['Count of doc_no']), d = n0(r['Sum of Diff']);
                sums.add(ctx.tree.locate({ codes: [r.ccc_code] }), { n, d, tn: tech ? n : 0, td: tech ? d : 0 });
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
            const asOn = maxDate(rows.map((r) => date(r['Report Date'])));
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                const open = String(r['Pending With'] || '').trim() !== 'Disposed / pending with HQ'; // cmo.html's rule
                const code = ctx.tree.locate({ regions: [r.District] }) || ctx.tree.zone; // "Not Known" district → the zone
                sums.add(code, { n: 1, open: open ? 1 : 0, openAge: open ? n0(r['Grievance Since']) : 0 });
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
            const loc = (r) => ctx.tree.locate({ codes: [r['Code of CCC/ Substation/ RE Project']], cccs: [r['Name of CCC/ Substation/ RE Project']], divisions: [r['Name of Division / RE Project']], regions: [r['Name of the Region']] });
            const mzo = rows.filter((r) => loc(r));
            const last = maxDate(mzo.map((r) => date(r['Date of Accident'])));
            const start = addDays(last, -364);
            const sums = makeSums(ctx.tree);
            for (const r of mzo) {
                const d = date(r['Date of Accident']);
                if (!d || d < start) continue;
                const fatal = /^fatal$/i.test(r['Nature of Injury']) && /^human$/i.test(r['Type of Victim']);
                sums.add(loc(r), { fatal: fatal ? 1 : 0, all: 1, staff: fatal && /outsourced|departmental|employee/i.test(r['Category of Victim']) ? 1 : 0 });
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
                const site = String(r['Site ID'] || '').trim();
                if (seen.has(site)) { repeats++; continue; }
                seen.add(site);
                const d = date(r['Entered on']); if (d > last) last = d;
                const done = date(r['Rectification done on']); if (done > last) last = done;
                sums.add(ctx.tree.locate({ cccs: [r.Office] }), { n: 1, fixed: done ? 1 : 0 });
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
            const asOn = maxDate(rows.map((r) => date(r.updated_at)));
            for (const r of rows) {
                const done = /^completed$/i.test(String(r.Status || '').trim());
                const td = date(r['Target Date']);
                sums.add(ctx.tree.locate({ divisions: [r.Division], regions: [r.Region] }), { n: 1, done: done ? 1 : 0, overdue: !done && td && td < asOn ? 1 : 0, noStatus: r.Status ? 0 : 1 });
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
            loadCostCentres(ctx);
            const rows = ctx.rows('capex_details');
            const asOn = maxDate(rows.map((r) => date(r['Reporting Date'])));
            const sums = makeSums(ctx.tree);
            let old = 0;
            for (const r of rows) {
                if (date(r['Reporting Date']) !== asOn) { old++; continue; }
                const v = n0(r['Net Balance Value']);
                sums.add(ctx.tree.locate({ codes: [r['Cost Centre']] }), { v, aged: n0(r['Ageing in Days']) > 90 ? v : 0 });
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
            loadCostCentres(ctx);
            const rows = ctx.rows('onm_advance');
            const asOn = maxDate(rows.map((r) => date(r['Creation Date'])));
            const sums = makeSums(ctx.tree);
            for (const r of rows) {
                const v = n0(r['Mat Balance(Value)']);
                const age = daysBetween(date(r['Creation Date']), asOn);
                sums.add(ctx.tree.locate({ codes: [r['Resp. CCtr']], divisions: [r.Plant] }), { v, aged: age > 90 ? v : 0 });
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
            for (const r of ctx.rows('dtr_records')) sums.add(ctx.tree.locate({ cccs: [r.SUPP_OFF], divisions: [r['DIVN NAME']], regions: [r.REGION] }), { n: 1, kva: n0(r.CAPA_KV) });
            return { sums: sums.rollup(), asOn: ctx.snapshotAt('dtr_records'), period: 'inventory (no date in the sheet)', flags: ['no_date_in_sheet'] };
        },
        value: (s) => ({ value: s.n || 0, numerator: s.n || 0, denominator: null, inputs: { kva: Math.round(s.kva || 0) } })
    }
];
const METRICS_BY_ID = Object.fromEntries(METRICS.map((m) => [m.id, m]));

// ---- dataset passes shared by several metrics ---------------------------------------------

function nscPass(ctx) {
    return ctx.memo('nsc', () => {
        const rows = ctx.rows('nsc_pending');
        const sums = makeSums(ctx.tree);
        let asOn = '';
        for (const r of rows) {
            const t = date(r.TODAY); if (t > asOn) asOn = t;
            const age = n0(r.DelayInSC), wo = num(r.DelayInWO);
            sums.add(ctx.tree.locate({ codes: [r.CCC_CODE], cccs: [r.SUPP_OFF], divisions: [r.DIVN_NAME], regions: [r.REG] }), {
                n: 1, ageSum: age, le7: age <= 7 ? 1 : 0, le15: age <= 15 ? 1 : 0, over30: age > 30 ? 1 : 0, over180: age > 180 ? 1 : 0, over365: age > 365 ? 1 : 0,
                qtnSum: n0(r.DelayInQtn), woSum: isFinite(wo) ? wo : 0, woN: isFinite(wo) ? 1 : 0
            });
        }
        return { sums: sums.rollup(), asOn, period: 'as on ' + asOn, unmapped: sums.unmapped };
    });
}

function remWeeks(ctx) {
    return ctx.memo('rem', () => {
        const byDate = new Map();
        for (const r of ctx.rows('rem_osd')) {
            const d = date(r['Report Date/Email Date']);
            if (!d) continue;
            if (!byDate.has(d)) byDate.set(d, []);
            byDate.get(d).push({
                code: ctx.tree.locate({ codes: [r['CCC Code']], cccs: [r['CCC name']], divisions: [r.Division], regions: [r['Region Name']] }),
                count: n0(r['Total-Count']), amount: n0(r['Total-Amount in Lakhs'])
            });
        }
        const dates = [...byDate.keys()].sort();
        return { byDate, dates, latest: dates[dates.length - 1] };
    });
}

function defectivePass(ctx) {
    return ctx.memo('defective', () => {
        const rows = ctx.rows('defective_summary');
        const asOn = maxDate(rows.map((r) => date(r.REPORT_AS_ON)));
        const yr = asOn.slice(0, 4);
        const sums = makeSums(ctx.tree);
        for (const r of rows) {
            sums.add(ctx.tree.locate({ codes: [r.CCC_CODE] }), { total: n0(r.total), over5: n0(r.over5), over10: n0(r.over10), thisYear: String(r.DEFECT_YEAR) === yr ? n0(r.total) : 0 });
        }
        return { sums: sums.rollup(), asOn, period: 'as on ' + asOn };
    });
}

function smartPass(ctx) {
    return ctx.memo('smart', () => {
        const sums = makeSums(ctx.tree);
        for (const r of ctx.rows('smart_meter_status')) {
            if (!r['Meter Supply Qty.'] && !r.con_id) continue;
            const inst = !!r['Meter Installed Qty. In Field_Active In Hes_'], push = !!r['Total Submit In Ami Portal'];
            sums.add(ctx.tree.locate({ codes: [r.ccc_final] }), { n: 1, inst: inst ? 1 : 0, push: push ? 1 : 0, pushInst: inst && push ? 1 : 0 });
        }
        // The status sheet has no date; the dashboard shows the Date cell of the work-order tab of the same workbook.
        const wo = ctx.has('smart_meter_work_orders') ? ctx.rows('smart_meter_work_orders') : [];
        const asOn = maxDate(wo.map((r) => date(r.Date)));
        return { sums: sums.rollup(), asOn, period: 'as on ' + asOn + ' (work-order tab date, as the dashboard shows)', flags: ['as_on_from_work_order_tab'], unmapped: sums.unmapped };
    });
}

function feederPass(ctx) {
    return ctx.memo('feeder', () => {
        const rows = ctx.rows('feeder_outage');
        const months = [...new Set(rows.map((r) => String(r['REPORT MONTH']).trim()).filter((m) => /^\d{6}$/.test(m)))].sort();
        const keep = new Set(months.slice(-12));
        const sums = makeSums(ctx.tree);
        const used = [];
        for (const r of rows) {
            const ym = String(r['REPORT MONTH']).trim();
            if (!keep.has(ym)) continue;
            used.push(r);
            const days = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(4), 0)).getUTCDate();
            const cnt = n0(r['TOTAL COUNT OF OUTAGE OVER 5 MIN']), min = n0(r['TOTAL DURATION OF OUTAGE OVER 5 MIN']);
            sums.add(ctx.tree.locate({ divisions: [r['DIVISION NAME']], regions: [r['CIRCLE NAME']] }), { fm: 1, cnt, min, concern: min >= days * 60 || cnt >= 30 ? 1 : 0 });
        }
        const last = months[months.length - 1];
        return { sums: sums.rollup(), rows: used, asOn: monthEnd(+last.slice(0, 4), +last.slice(4)), period: months.slice(-12)[0] + ' to ' + last + ' (12 report months)', unmapped: sums.unmapped };
    });
}

// docket.html's technical (fault) problem types.
const DOCKET_TECH = new Set(['Meter defective and No Power', 'Meter (Tampering)', 'Service (main) problem', 'Service (main) problem (UG cable)', 'Service(main) problem(OH Line)', 'Breakage or uprooting of pole', 'Flashing/Glowing', 'No power', 'Dis. transformer problem', 'Voltage fluctuation', 'Insulator break at pole', 'Earthing problem', 'Fuse problem', 'Alteration of Services', 'Load Shedding Problem', 'Bird fault', 'Conductor snap', 'LT wire problem', 'Sagging of wire', 'Single phasing', 'Voltage complaint', 'Cable fault', 'Cable fault where RMU exists', 'Cable fault where no RMU exists', 'Frequent tripping', 'Short circuit', 'Problem in Shifting of Meter']);

function docketPass(ctx) {
    return ctx.memo('docket', () => {
        const rows = ctx.rows('docket_calls');
        const when = (s) => { const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2})[.:](\d{2})/); return m ? Date.UTC(+m[3], m[2] - 1, +m[1], +m[4], +m[5]) : NaN; };
        const latest = rows.reduce((a, r) => { const t = when(r.doc_crn_dt); return t > a ? t : a; }, 0);
        const sums = makeSums(ctx.tree);
        for (const r of rows) {
            if (!r.doc_no) continue;
            const h = (latest - when(r.doc_crn_dt)) / 36e5;
            const tech = DOCKET_TECH.has(String(r.prob_type || '').trim());
            sums.add(ctx.tree.locate({ codes: [r.ccc_code], cccs: [r.ccc_name] }), { n: 1, o48: h >= 48 ? 1 : 0, o30d: h >= 720 ? 1 : 0, tech: tech ? 1 : 0, tech24: tech && h >= 24 ? 1 : 0 });
        }
        const asOn = latest ? new Date(latest).toISOString().slice(0, 10) : '';
        return { sums: sums.rollup(), asOn, period: 'open dockets up to ' + (latest ? new Date(latest).toISOString().slice(0, 16).replace('T', ' ') : '') + ' (sheet time)', unmapped: sums.unmapped };
    });
}

/** Important-data report sheets: office rows have the CCC code in column D; total rows have none. */
function reportSheet(ctx, key, dateRe, dateGroup) {
    return ctx.memo('report:' + key, () => {
        const g = ctx.grid(key);
        let asOn = '';
        for (const row of g.slice(0, 6)) {
            const m = row.join(' ').match(dateRe);
            if (m) { asOn = date(m[dateGroup || 1].replace(/\.$/, '')); break; }
        }
        const rows = [];
        const totals = [];
        for (const cells of g) {
            const code = String(cells[3] || '').trim();
            if (/^66\d{5}$/.test(code)) rows.push({ code: ctx.tree.locate({ codes: [code] }), cells });
            else if (/total|zone|region/i.test(String(cells[0] || '') + String(cells[1] || '')) && !/^zone$/i.test(String(cells[0]).trim())) totals.push(cells);
        }
        return { rows, asOn, checks: [{ kind: 'office_rows', value: rows.length }, { kind: 'total_rows_ignored', value: totals.length }] };
    });
}

function loadCostCentres(ctx) {
    ctx.memo('costcentres', () => {
        const list = ctx.has('costcenter') ? ctx.grid('costcenter') : [];
        return ctx.O.addCostCentres(Array.isArray(list) ? list : []);
    });
}

const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
function round(s) { const o = {}; for (const k in s) o[k] = r2(s[k]); return o; }

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

function compute(opts) {
    const O = opts.offices;
    const tree = officeTree(O);
    const ctx = makeContext(opts.read, opts.manifest, tree, O);
    loadCostCentres(ctx); // before every metric: old SAP cost centres (e.g. accidents on C333430000) resolve to their division
    const asOf = opts.asOf || (opts.manifest && String(opts.manifest.generatedAt || '').slice(0, 10)) || new Date().toISOString().slice(0, 10);
    const only = opts.only ? new Set(opts.only) : null;
    const out = {
        generatedAt: opts.generatedAt || new Date().toISOString(),
        logic: LOGIC + '+' + O.VERSION,
        referenceDate: asOf,
        source: { manifestGeneratedAt: (opts.manifest && opts.manifest.generatedAt) || null, mode: opts.mode || 'snapshots' },
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
            if (m.datasets.some((k) => k !== 'costcenter' && !ctx.has(k))) throw new Error('dataset missing: ' + m.datasets.filter((k) => !ctx.has(k)).join(', '));
            res = m.compute(ctx);
        } catch (e) {
            out.errors[m.id] = String(e && e.message || e);
            continue;
        }
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

// ---- CLI ----------------------------------------------------------------------------------

async function main(argv) {
    const fs = require('fs');
    const path = require('path');
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; args[k] = v; }
    }
    if (args.help || (!args.snapshots && !args.mirror)) {
        process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 22).join('\n') + '\n');
        return;
    }
    const offices = require(path.resolve(args.offices || path.join(__dirname, '..', '..', 'lib', 'offices.js')));
    let manifest = null, read, mode;
    if (args.mirror) {
        mode = 'mirror';
        const base = String(args.mirror).replace(/\/+$/, '');
        const cookie = fs.readFileSync(args['cookie-file'], 'utf8').trim();
        const get = async (p) => {
            const res = await fetch(base + p, { method: 'GET', headers: { Cookie: cookie, Accept: '*/*' } });
            if (!res.ok) throw new Error('GET ' + p + ' → ' + res.status);
            return res.text();
        };
        manifest = JSON.parse(await get('/api/data/manifest'));
        const want = new Set();
        for (const m of METRICS) for (const k of m.datasets) want.add(k);
        const files = {};
        for (const k of want) {
            const d = manifest.datasets[k];
            if (!d) continue;
            files[k] = { text: await get('/api/data/file/' + encodeURIComponent(k)), format: d.file.split('.').pop() };
            if (args.save) { fs.mkdirSync(args.save, { recursive: true }); fs.writeFileSync(path.join(args.save, d.file), files[k].text); }
        }
        if (args.save) fs.writeFileSync(path.join(args.save, 'manifest.json'), JSON.stringify(manifest));
        read = (k) => files[k] || null;
    } else {
        mode = 'snapshots';
        const dir = path.resolve(args.snapshots);
        const mf = args.manifest || path.join(dir, 'manifest.json');
        if (fs.existsSync(mf)) manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
        const cache = {};
        read = (k) => {
            if (k in cache) return cache[k];
            const d = manifest && manifest.datasets && manifest.datasets[k];
            const names = d ? [d.file] : [k + '.csv', k + '.tsv', k + '.json'];
            for (const n of names) {
                const p = path.join(dir, n);
                if (fs.existsSync(p)) return (cache[k] = { text: fs.readFileSync(p, 'utf8'), format: n.split('.').pop() });
            }
            return (cache[k] = null);
        };
    }
    const out = compute({ read, manifest, offices, asOf: args['as-of'], only: args.only ? String(args.only).split(',') : null, mode, generatedAt: args['generated-at'] });
    const text = JSON.stringify(out, null, 1) + '\n';
    if (args.out) fs.writeFileSync(args.out, text);
    else process.stdout.write(text);
    const errs = Object.keys(out.errors);
    process.stderr.write(Object.keys(out.metrics).length + ' metrics, ' + Object.keys(out.offices).length + ' offices' + (errs.length ? '; errors: ' + errs.map((k) => k + ' (' + out.errors[k] + ')').join('; ') : '') + '\n');
}

module.exports = { compute, METRICS, parseCsv, parseTsv, toObjects, num, date, LOGIC };
if (require.main === module) main(process.argv.slice(2)).catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
