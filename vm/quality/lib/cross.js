'use strict';
// Cross-dataset checks: compare a dataset with the ones it should agree with.
//
// Each check names the datasets it needs and, per dataset, the small "facts" to collect while
// the rows stream past (key sets, sums, distinct dates). run(facts) returns issues; every issue
// is stored under `primary`. In the sync hook, the other side comes from PocketBase / its
// snapshot, or (for the Google fallbacks of the Storage snapshots, which the mirror does not
// copy) from a GET of the published sheet.

const V = require('./values');
const { maskValue, partial } = require('./mask');

const SAMPLE_MAX = 10;

// Google sheets that the app falls back to when Supabase Storage is down. Not mirrored (the
// Storage copies are); read here only to compare.
const GOOGLE_FALLBACKS = {
    x_disconnection_google: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSkl9m38XuD5aewajE7Fc0hucP9DWz1UwEqJZeu5wELWZivSEEXWrhl7RiHFSezGeGiGdDB53s1bWit/pub?gid=0&single=true&output=csv',
    x_defective_summary_google: 'https://docs.google.com/spreadsheets/d/1dMLSX2bZBqZMPooh7_CrniCjqgy4MijaFW62GKJJldA/export?format=csv&gid=0',
    x_defective_details_google: 'https://docs.google.com/spreadsheets/d/1dMLSX2bZBqZMPooh7_CrniCjqgy4MijaFW62GKJJldA/export?format=csv&gid=1638574999',
    x_stock_google: 'https://docs.google.com/spreadsheets/d/1wDvPuAxNfdO9QzUaIUubg2JnkFM5ZleFNXQdi8s5uh0/gviz/tq?tqx=out:csv&sheet=Sheet1',
    x_pending_mc_google: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQmOUW4jxUtEGWhPHaoNBsvpBcGzhHJZRUx_9mxFBp91sfg4yD8WIqIK_xv0vlFs2yP-Ljz09JW1U2c/pub?gid=0&single=true&output=csv',
    x_load_ext_google: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQP_B-Zl5XhnYkmJiDXKB7B8ksrRRezuLrRqTzEPz4lEw_yDcpGOTnmm0oI8dW9apwuHg9yGqaAqjDS/pub?gid=0&single=true&output=csv'
};
const GOOGLE_EDIT = {
    x_disconnection_google: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSkl9m38XuD5aewajE7Fc0hucP9DWz1UwEqJZeu5wELWZivSEEXWrhl7RiHFSezGeGiGdDB53s1bWit/pubhtml',
    x_defective_summary_google: 'https://docs.google.com/spreadsheets/d/1dMLSX2bZBqZMPooh7_CrniCjqgy4MijaFW62GKJJldA/edit#gid=0',
    x_defective_details_google: 'https://docs.google.com/spreadsheets/d/1dMLSX2bZBqZMPooh7_CrniCjqgy4MijaFW62GKJJldA/edit#gid=1638574999',
    x_stock_google: 'https://docs.google.com/spreadsheets/d/1wDvPuAxNfdO9QzUaIUubg2JnkFM5ZleFNXQdi8s5uh0/edit',
    x_pending_mc_google: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQmOUW4jxUtEGWhPHaoNBsvpBcGzhHJZRUx_9mxFBp91sfg4yD8WIqIK_xv0vlFs2yP-Ljz09JW1U2c/pubhtml',
    x_load_ext_google: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQP_B-Zl5XhnYkmJiDXKB7B8ksrRRezuLrRqTzEPz4lEw_yDcpGOTnmm0oI8dW9apwuHg9yGqaAqjDS/pubhtml'
};
// Storage meta.json folder of each snapshot (stats written by scripts/sync/*).
const STORAGE_META = { disconnection: 'disconnection', defective_summary: 'defective', pending_mc: 'pending_mc', load_extension: 'load_extension' };

// ---- fact collectors ---------------------------------------------------------------------

function lk(s) {
    return String(s == null ? '' : s).replace(/^﻿/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * spec: {
 *   keys:     { name: [header, …] }            Set of trimmed values of the first header found
 *   distinct: { name: [header, …] }            Map value → count
 *   sums:     { name: { col: [header…], by: [header…]? } }   numeric sum (per group when `by`)
 *   counts:   { name: { col: [header…], by: [header…]? } }   rows where col is truthy (1 / Y / TRUE / non-zero)
 *   rows:     true                              number of non-blank rows
 *   samples:  { name: { key: [header…], show: [header…] } } first value seen per key (for samples)
 * }
 */
function collector(id, spec) {
    let idx = null;
    const find = (names, header) => {
        for (const n of names || []) {
            const i = header.findIndex((h) => lk(h) === lk(n));
            if (i >= 0) return i;
        }
        return -1;
    };
    const st = { rows: 0, keys: {}, distinct: {}, sums: {}, counts: {}, samples: {}, missing: [] };
    for (const k of Object.keys(spec.keys || {})) st.keys[k] = new Set();
    for (const k of Object.keys(spec.distinct || {})) st.distinct[k] = new Map();
    for (const k of Object.keys(spec.sums || {})) st.sums[k] = { total: 0, by: new Map() };
    for (const k of Object.keys(spec.counts || {})) st.counts[k] = { total: 0, by: new Map() };
    for (const k of Object.keys(spec.samples || {})) st.samples[k] = new Map();
    return {
        id,
        header(names) {
            idx = { keys: {}, distinct: {}, sums: {}, counts: {}, samples: {} };
            st.missing = [];
            for (const [k, cols] of Object.entries(spec.keys || {})) { idx.keys[k] = find(cols, names); if (idx.keys[k] < 0) st.missing.push(cols[0]); }
            for (const [k, cols] of Object.entries(spec.distinct || {})) { idx.distinct[k] = find(cols, names); if (idx.distinct[k] < 0) st.missing.push(cols[0]); }
            for (const [k, d] of Object.entries(spec.sums || {})) { idx.sums[k] = [find(d.col, names), d.by ? find(d.by, names) : -1]; if (idx.sums[k][0] < 0) st.missing.push(d.col[0]); }
            for (const [k, d] of Object.entries(spec.counts || {})) { idx.counts[k] = [find(d.col, names), d.by ? find(d.by, names) : -1]; if (idx.counts[k][0] < 0) st.missing.push(d.col[0]); }
            for (const [k, d] of Object.entries(spec.samples || {})) idx.samples[k] = [find(d.key, names), (d.show || []).map((c) => [c, find([c], names)])];
        },
        row(values) {
            if (!idx) return;
            st.rows++;
            const get = (i) => (i < 0 || values[i] === undefined || values[i] === null ? '' : V.asText(values[i]).trim());
            for (const [k, i] of Object.entries(idx.keys)) { const v = get(i); if (v && !V.PLACEHOLDER_RE.test(v)) st.keys[k].add(v); }
            for (const [k, i] of Object.entries(idx.distinct)) {
                const v = get(i);
                const m = st.distinct[k];
                if (m.size < 5000 || m.has(v)) m.set(v, (m.get(v) || 0) + 1);
            }
            for (const [k, [i, b]] of Object.entries(idx.sums)) {
                const n = V.parseNumber(get(i));
                if (n === null) continue;
                st.sums[k].total += n;
                if (b >= 0) { const g = get(b); st.sums[k].by.set(g, (st.sums[k].by.get(g) || 0) + n); }
            }
            for (const [k, [i, b]] of Object.entries(idx.counts)) {
                const v = get(i);
                const on = v && !/^(0|n|no|false|0\.0+)$/i.test(v);
                if (!on) continue;
                const n = V.parseNumber(v);
                const add = n !== null ? n : 1;
                st.counts[k].total += add;
                if (b >= 0) { const g = get(b); st.counts[k].by.set(g, (st.counts[k].by.get(g) || 0) + add); }
            }
            for (const [k, [ki, show]] of Object.entries(idx.samples)) {
                const key = get(ki);
                const m = st.samples[k];
                if (key && !m.has(key) && m.size < 50000) m.set(key, show.map(([c, i]) => [c, get(i)]));
            }
        },
        done() {
            return st;
        }
    };
}

// ---- checks ----------------------------------------------------------------------------

function normCode(v) {
    return String(v || '').trim().replace(/\.0+$/, '').replace(/^0+/, '');
}

function setDiff(a, b, norm = (x) => x) {
    const nb = new Set([...b].map(norm));
    const out = [];
    for (const v of a) if (!nb.has(norm(v))) out.push(v);
    return out;
}

function pct(a, b) {
    if (!b) return a ? 100 : 0;
    return Math.round((Math.abs(a - b) / Math.abs(b)) * 1000) / 10;
}

function maxDate(distinct, order) {
    let best = null;
    for (const v of distinct.keys()) {
        const d = V.classifyDate(v);
        const t = d ? (order === 'mdy' ? d.mdy : d.dmy) : null;
        if (t !== null && (best === null || t > best)) best = t;
    }
    return best;
}

function datesOf(distinct, order) {
    const out = [];
    for (const [v, n] of distinct) {
        const d = V.classifyDate(v);
        const t = d ? (order === 'mdy' ? d.mdy : d.dmy) : null;
        if (t !== null) out.push({ date: V.isoDay(t), rows: n });
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** A Storage snapshot against the Google sheet it was copied from. */
function snapshotVsGoogle(id, primary, google, label, spec) {
    return {
        id,
        primary,
        needs: [primary, google],
        facts: { [primary]: spec, [google]: spec },
        run(f) {
            const a = f[primary];
            const b = f[google];
            if (!a || !b) return [];
            const issues = [];
            const diffs = [];
            if (a.rows !== b.rows) diffs.push({ what: 'rows', storage: a.rows, google_sheet: b.rows });
            for (const k of Object.keys(a.sums)) {
                const x = Math.round(a.sums[k].total * 100) / 100;
                const y = Math.round(b.sums[k].total * 100) / 100;
                if (Math.abs(x - y) > Math.max(0.5, Math.abs(y) * 0.0001)) diffs.push({ what: 'sum of ' + k, storage: x, google_sheet: y });
            }
            let onlyA = [];
            let onlyB = [];
            for (const k of Object.keys(a.keys)) {
                onlyA = setDiff(a.keys[k], b.keys[k]);
                onlyB = setDiff(b.keys[k], a.keys[k]);
                if (onlyA.length || onlyB.length) diffs.push({ what: k + ' only in one copy', storage_only: onlyA.length, google_sheet_only: onlyB.length });
            }
            const dateA = a.distinct.asOn ? datesOf(a.distinct.asOn, spec.order) : [];
            const dateB = b.distinct.asOn ? datesOf(b.distinct.asOn, spec.order) : [];
            if (dateA.length && dateB.length && dateA[0].date !== dateB[0].date) diffs.push({ what: 'report date', storage: dateA[0].date, google_sheet: dateB[0].date });
            if (diffs.length) {
                const newerSheet = dateA.length && dateB.length && dateB[0].date > dateA[0].date;
                const newerStorage = dateA.length && dateB.length && dateA[0].date > dateB[0].date;
                issues.push({
                    check: 'cross.snapshot_mismatch', severity: newerSheet ? 'warn' : newerStorage ? 'info' : pct(a.rows, b.rows) > 5 ? 'warn' : 'info', column: '',
                    count: Math.max(Math.abs(a.rows - b.rows), onlyA.length + onlyB.length, 1),
                    sample: diffs.concat(onlyA.slice(0, 3).map((v) => ({ storage_only: partial(v) })), onlyB.slice(0, 3).map((v) => ({ google_sheet_only: partial(v) }))).slice(0, SAMPLE_MAX),
                    source_fix: true, other_dataset: google, other_url: GOOGLE_EDIT[google],
                    hint: `The ${label} copy in Supabase Storage (what the app reads) differs from its Google Sheet.` +
                        (newerSheet ? ' The sheet is newer: press "Sync sheet" on the page (or run the sync job) so the app shows the latest report.'
                            : newerStorage ? ' Storage is newer; the sheet is an old fallback that the app reads only when Storage is down. Refresh or retire the sheet so a fallback never shows old figures.'
                                : ' If the sheet is the one being updated, sync it to Storage; if it is an old fallback, it is only read when Storage is down.')
                });
            }
            return issues;
        }
    };
}

const CHECKS = [
    {
        id: 'cross.nsc_withheld',
        primary: 'withheld',
        needs: ['nsc_pending', 'withheld'],
        facts: {
            nsc_pending: { keys: { appl: ['APPL_NO'] }, distinct: { asOn: ['TODAY'] } },
            withheld: { keys: { appl: ['APPL_NO'] }, distinct: { asOn: ['TODAY'] } }
        },
        run(f) {
            const a = f.nsc_pending;
            const b = f.withheld;
            if (!a || !b) return [];
            const out = [];
            const both = [...b.keys.appl].filter((x) => a.keys.appl.has(x));
            if (both.length) {
                out.push({ check: 'cross.overlap', severity: 'warn', column: 'APPL_NO', count: both.length, sample: both.slice(0, SAMPLE_MAX).map((v) => ({ appl_no: partial(v) })),
                    source_fix: true, other_dataset: 'nsc_pending',
                    hint: 'These applications are in both the Pending NSC list and the Withheld list. One upload puts each application in exactly one of them, so one copy is from an older upload. Re-upload the latest SAP file on NSC upload.' });
            }
            const da = datesOf(a.distinct.asOn);
            const db = datesOf(b.distinct.asOn);
            if (da.length && db.length && da[0].date !== db[0].date) {
                out.push({ check: 'cross.report_date', severity: 'info', column: 'TODAY', count: 1,
                    sample: [{ pending_nsc_as_on: da[0].date, withheld_as_on: db[0].date }], source_fix: false, other_dataset: 'nsc_pending',
                    hint: 'Pending NSC and Withheld show different "as on" dates. That is expected when the last upload had no Withheld rows (the Withheld sheet is then kept); otherwise upload again so both lists come from the same SAP file.' });
            }
            return out;
        }
    },
    {
        id: 'cross.stock_materials',
        primary: 'stock_snapshot',
        needs: ['stock_snapshot', 'stock_materials'],
        facts: {
            stock_snapshot: { keys: { mat: ['Material'] }, samples: { mat: { key: ['Material'], show: ['Material Description', 'Plant'] } } },
            stock_materials: { keys: { mat: ['Mat Code'] } }
        },
        run(f) {
            const a = f.stock_snapshot;
            const b = f.stock_materials;
            if (!a || !b) return [];
            const unknown = setDiff(a.keys.mat, b.keys.mat, normCode);
            if (!unknown.length) return [];
            return [{ check: 'cross.unknown_material', severity: 'warn', column: 'Material', count: unknown.length,
                sample: unknown.slice(0, SAMPLE_MAX).map((m) => Object.assign({ material: m }, Object.fromEntries(a.samples.mat.get(m) || []))),
                source_fix: true, other_dataset: 'stock_materials',
                hint: 'Materials in the stock dump that are missing from the materials list (Stock Metadata sheet), so the stock page shows them without a category or price. Add them to the materials list.' }];
        }
    },
    {
        id: 'cross.allotment_materials',
        primary: 'stock_allotments',
        needs: ['stock_allotments', 'stock_materials'],
        facts: {
            stock_allotments: { keys: { mat: ['material_code'] }, samples: { mat: { key: ['material_code'], show: ['material_description', 'allotment_no'] } } },
            stock_materials: { keys: { mat: ['Mat Code'] } }
        },
        run(f) {
            const a = f.stock_allotments;
            const b = f.stock_materials;
            if (!a || !b) return [];
            const unknown = setDiff(a.keys.mat, b.keys.mat, normCode);
            if (!unknown.length) return [];
            return [{ check: 'cross.unknown_material', severity: 'warn', column: 'material_code', count: unknown.length,
                sample: unknown.slice(0, SAMPLE_MAX).map((m) => Object.assign({ material: m }, Object.fromEntries(a.samples.mat.get(m) || []))),
                source_fix: false, other_dataset: 'stock_materials',
                hint: 'Allotments that name a material missing from the materials list. Add the material to the Stock Metadata sheet, or correct the allotment.' }];
        }
    },
    {
        id: 'cross.defective_totals',
        primary: 'defective_details',
        needs: ['defective_summary', 'defective_details'],
        facts: {
            defective_summary: {
                sums: Object.fromEntries(['over10', 'ph3', 'industrial', 'smart', 'load_gt6', 'load_3_6', 'load_1_3'].map((k) => [k, { col: [k], by: ['CCC_CODE'] }])),
                distinct: { asOn: ['REPORT_AS_ON'] }
            },
            defective_details: {
                counts: Object.fromEntries(['over10', 'ph3', 'industrial', 'smart', 'load_gt6', 'load_3_6', 'load_1_3'].map((k) => [k, { col: [k], by: ['CCC_CODE'] }])),
                distinct: { asOn: ['REPORT_AS_ON'] }
            }
        },
        run(f) {
            const s = f.defective_summary;
            const d = f.defective_details;
            if (!s || !d) return [];
            const out = [];
            const diffs = [];
            let worstCcc = [];
            for (const k of Object.keys(s.sums)) {
                const a = s.sums[k].total;
                const b = d.counts[k] ? d.counts[k].total : 0;
                if (Math.round(a) !== Math.round(b)) diffs.push({ metric: k, summary_total: Math.round(a), details_rows: Math.round(b), difference: Math.round(b - a) });
                for (const [ccc, v] of s.sums[k].by) {
                    const w = (d.counts[k] && d.counts[k].by.get(ccc)) || 0;
                    if (Math.round(v) !== Math.round(w)) worstCcc.push({ metric: k, ccc_code: ccc, summary: Math.round(v), details: Math.round(w), diff: Math.round(w - v) });
                }
            }
            worstCcc = worstCcc.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
            if (diffs.length) {
                out.push({ check: 'cross.total_mismatch', severity: 'warn', column: '', count: diffs.reduce((n, x) => n + Math.abs(x.difference), 0),
                    sample: diffs.concat(worstCcc.slice(0, Math.max(0, SAMPLE_MAX - diffs.length))), source_fix: true, other_dataset: 'defective_summary',
                    hint: 'The defective-meter summary (counts) and the details list (names) do not add up to the same totals, so the count cards and the name lists on Defective Meter disagree. Publish the summary and the details from the same consumer dump.' });
            }
            const ds = datesOf(d.distinct.asOn);
            const ss = datesOf(s.distinct.asOn);
            if (ds.length > 1 || (ds.length && ss.length && ds[0].date !== ss[0].date)) {
                out.push({ check: 'cross.report_date', severity: 'warn', column: 'REPORT_AS_ON', count: ds.filter((x) => !ss.length || x.date !== ss[0].date).reduce((n, x) => n + x.rows, 0),
                    sample: ds.map((x) => Object.assign({ details: true }, x)).concat(ss.map((x) => Object.assign({ summary: true }, x))).slice(0, SAMPLE_MAX), source_fix: true, other_dataset: 'defective_summary',
                    hint: 'The details list holds rows from more than one report date, or a different date from the summary. Part of an older dump was left in place: publish the details again from one dump.' });
            }
            return out;
        }
    },
    snapshotVsGoogle('cross.disconnection_google', 'disconnection', 'x_disconnection_google', 'disconnection tracker',
        { rows: true, keys: { con_id: ['CON_ID'] }, sums: { NOTOSD: { col: ['NOTOSD'] } }, distinct: { asOn: ['PAID/DISCON DATE'] } }),
    snapshotVsGoogle('cross.defective_summary_google', 'defective_summary', 'x_defective_summary_google', 'defective-meter summary',
        { rows: true, sums: { total: { col: ['total'] } }, distinct: { asOn: ['REPORT_AS_ON'] } }),
    snapshotVsGoogle('cross.defective_details_google', 'defective_details', 'x_defective_details_google', 'defective-meter details',
        { rows: true, distinct: { asOn: ['REPORT_AS_ON'] } }),
    snapshotVsGoogle('cross.pending_mc_google', 'pending_mc', 'x_pending_mc_google', 'pending master card',
        { rows: true, keys: { appl: ['APPL_NO'] }, distinct: { asOn: ['Report Date'] } }),
    snapshotVsGoogle('cross.load_ext_google', 'load_extension', 'x_load_ext_google', 'pending load extension',
        { rows: true, keys: { appl: ['APPL_NO'] }, distinct: { asOn: ['report_date'] } }),
    snapshotVsGoogle('cross.stock_google', 'stock_snapshot', 'x_stock_google', 'stock',
        { rows: true, sums: { Unrestricted: { col: ['Unrestricted'] } }, distinct: { asOn: ['Date'] }, order: 'mdy' }),
    {
        // Portal users: the module grants that name offices (nsc-autho codes, SI divisions) must name real offices.
        id: 'cross.portal_user_offices',
        primary: 'portal_users',
        needs: ['portal_users'],
        facts: { portal_users: { distinct: { nsc: ['nsc_autho'], si: ['si_divisions'], ccc: ['ccc_code'], div: ['division_code'], reg: ['region_code'] }, samples: { users: { key: ['username'], show: ['ccc_code', 'division_code', 'region_code'] } } } },
        run(f, ctx) {
            const p = f.portal_users;
            const R = ctx && ctx.resolver;
            if (!p || !R) return [];
            const bad = [];
            const tokens = (v) => String(v).split(/[;,]/).map((x) => x.trim()).filter((x) => x && !/^(all|y|yes|n|no|none|na)$/i.test(x));
            for (const [v, n] of p.distinct.nsc) {
                for (const t of tokens(v)) {
                    const r = /^\d+$/.test(t) ? R.code(t) : R.ccc(t);
                    if (!(r.status === 'ok' || r.status === 'variant')) bad.push({ column: 'nsc_autho', value: t, users: n });
                }
            }
            for (const [v, n] of p.distinct.si) {
                for (const t of tokens(v)) {
                    const r = R.division(t);
                    if (!(r.status === 'ok' || r.status === 'variant')) bad.push({ column: 'si_divisions', value: t, users: n });
                }
            }
            if (!bad.length) return [];
            return [{ check: 'cross.portal_unknown_office', severity: 'warn', column: 'nsc_autho, si_divisions', count: bad.reduce((n, b) => n + b.users, 0),
                sample: bad.slice(0, SAMPLE_MAX), source_fix: true,
                hint: 'Some portal users have module grants that name an office the app does not know, so those grants give no rows. Fix them in Admin → User Management.' }];
        }
    }
];

/** Storage meta.json stats (what the page's cards show first) against the snapshot rows. */
function metaChecks(key, meta, facts) {
    if (!meta || !meta.stats || !facts) return [];
    const s = meta.stats;
    const diffs = [];
    const cmp = (what, metaVal, rowsVal) => {
        if (metaVal === undefined || metaVal === null || rowsVal === undefined) return;
        if (Math.round(Number(metaVal)) !== Math.round(Number(rowsVal))) diffs.push({ what, meta_json: Math.round(Number(metaVal)), csv: Math.round(Number(rowsVal)) });
    };
    if (key === 'disconnection') {
        cmp('consumers', s.totalConsumers, facts.rows);
        if (facts.sums.NOTOSD) cmp('total OSD', s.totalOSD, facts.sums.NOTOSD.total);
    } else if (key === 'defective_summary') {
        if (facts.sums.total) cmp('total defective', s.totalDefective, facts.sums.total.total);
        cmp('summary rows', s.summaryRows, facts.rows);
    } else if (key === 'pending_mc' || key === 'load_extension') {
        cmp('pending', s.totalPending, facts.rows);
    }
    if (!diffs.length) return [];
    return [{ check: 'cross.meta_mismatch', severity: 'warn', column: '', count: diffs.length, sample: diffs, source_fix: false,
        hint: 'The totals stored with the snapshot (meta.json, used for the first paint) differ from the snapshot rows. Run "Sync sheet" again so both are written from the same copy.' }];
}

/** Facts the per-dataset checker should also collect for `key` (merged across checks). */
function factSpecsFor(key) {
    const specs = [];
    for (const c of CHECKS) if (c.facts[key]) specs.push({ check: c.id, spec: c.facts[key] });
    if (STORAGE_META[key]) {
        specs.push({ check: 'meta', spec: key === 'disconnection' ? { rows: true, sums: { NOTOSD: { col: ['NOTOSD'] } } }
            : key === 'defective_summary' ? { rows: true, sums: { total: { col: ['total'] } } } : { rows: true } });
    }
    return specs;
}

function checksInvolving(key) {
    // (portal_users runs its own office-grant check)
    return CHECKS.filter((c) => c.needs.includes(key));
}

module.exports = { CHECKS, GOOGLE_FALLBACKS, GOOGLE_EDIT, STORAGE_META, collector, factSpecsFor, checksInvolving, metaChecks, maskValue };
