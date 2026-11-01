'use strict';
// The streaming checker: one pass over a dataset's rows, constant memory per column, plus a
// few per-row sets (keys, row hashes). Feed it setHeader(names) then row(values) for every
// source row (blank rows included when the input has them), then finish() → issues.
//
// Memory, per column: counters, a 4,096-value numeric reservoir, up to 1,000 distinct values and
// at most 10 samples per finding. Per row: one Map entry per key column and one per row hash
// (~50 bytes each), so the 280k-row meter dump stays under ~40 MB.

const { HashIndex } = require('./hashindex');
const V = require('./values');
const R = require('./rules');
const { maskValue, columnRule, partial, sanitizeSample } = require('./mask');

const DIST_CAP = 1000;
// A cell that labels a row as a total or an aggregate ("Total", "Raiganj Div Total", "MALDA REGION" in a CCC column).
const TOTAL_RE = /^(grand\s+|sub[\s-]*)?total(\s*[:=])?$|\b(div|division|region|zone|circle|ccc|district|dist)\.?\s+total$|^total\s+(of\s+)?(div|division|region|zone|circle|ccc)\b/i;
const AGGREGATE_RE = /\b(region|zone|circle)\b/i;
const OFFICE_DIST_CAP = 20000;
const RES_SIZE = 4096;
const SAMPLE_MAX = 10;
const DAY_MS = 86400000;
const OLD_LIMIT_MS = Date.UTC(1950, 0, 1);

function normHeader(h) {
    return String(h == null ? '' : h).replace(/^﻿/, '').replace(/\s+/g, ' ').trim();
}

function lowKey(h) {
    return normHeader(h).toLowerCase();
}

function pushSample(arr, item) {
    if (arr.length < SAMPLE_MAX) arr.push(item);
}

/** Deterministic PRNG for reservoir sampling (same input → same findings). */
function rng(seed) {
    let x = seed >>> 0 || 2463534242;
    return () => {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        return x / 4294967296;
    };
}

class Col {
    constructor(name, idx, raw) {
        this.name = name;
        this.idx = idx;
        this.raw = raw; // the header cell as the source had it
        this.low = lowKey(name);
        this.mask = columnRule(name);
        this.nonEmpty = 0;
        this.num = 0;
        this.numNeg = 0;
        this.negSamples = [];
        this.textCount = 0; // non-numeric, non-date, non-placeholder values
        this.textDist = new Map(); // value → [count, firstRow] (≤ 200)
        this.placeholders = 0;
        this.placeholderDist = new Map();
        this.errors = 0;
        this.errorSamples = [];
        this.ws = 0;
        this.wsSamples = [];
        this.dateCount = 0;
        this.fam = new Map(); // family → [count, sampleValue, sampleRow]
        this.dmyOnly = 0; this.mdyOnly = 0; this.ambiguous = 0;
        this.dmyOnlySample = null; this.mdyOnlySample = null;
        this.invalidDates = 0; this.invalidSamples = [];
        this.future = { dmy: 0, mdy: 0, sDmy: [], sMdy: [] };
        this.old = { dmy: 0, mdy: 0, sDmy: [], sMdy: [] };
        this.maxDate = { dmy: -Infinity, mdy: -Infinity };
        this.serials = 0; this.serialSamples = [];
        this.monthOnly = 0;
        this.dist = new Map();
        this.distOver = false;
        this.res = null; this.resN = 0;
        this.hi = []; this.lo = []; // extreme values [value, row]
        this.min = Infinity; this.max = -Infinity;
        this.sum = 0;
    }
}

class Checker {
    /**
     * @param {object} o
     *   key, label, schedule, sourceType, primaryKey (source column names), header (false = layout sheet),
     *   resolver (offices.createResolver()), now (ms), rawValues (true when cells are untrimmed source text),
     *   skipOffice: check ids handled elsewhere (dq-offices), facts: [collector], firstRowNo (sheet row of the first data row)
     */
    constructor(o) {
        this.o = o;
        this.key = o.key;
        this.rules = R.datasetRules(o.key, o);
        this.now = o.now || Date.now();
        this.resolver = o.resolver;
        this.rawValues = !!o.rawValues;
        this.firstRowNo = o.firstRowNo === undefined ? 2 : o.firstRowNo;
        this.layout = !!this.rules.layout;
        this.cols = [];
        this.headerNames = [];
        this.headerSeen = false;
        this.rowIndex = 0; // source rows seen (blank included)
        this.dataRows = 0;
        this.blankPending = 0;
        this.blankPendingRows = [];
        this.blankInterior = 0;
        this.blankInteriorRows = [];
        this.blankTrailing = 0;
        this.meaningHist = new Map();
        this.ghost = { 0: 0, 1: 0, samples: [] };
        this.repeatedHeader = { n: 0, samples: [] };
        this.totalRows = { n: 0, samples: [] };
        this.rowHashes = new HashIndex(4096);
        this.dupRows = { n: 0, samples: [] };
        this.keyCols = null;
        this.officeCols = null;
        this.combos = new Map();
        this.combosOver = false;
        this.noOffice = { n: 0, samples: [] };
        this.rand = rng(0x9e3779b9);
        this.facts = o.facts || [];
        this.issues = [];
        this.headerCellsRaw = [];
    }

    // ---- header ----------------------------------------------------------------------------

    setHeader(names) {
        const list = Array.isArray(names) ? names : [];
        if (!this.headerSeen || list.length > this.headerCellsRaw.length) this.headerCellsRaw = list.map((x) => (x == null ? '' : String(x)));
        for (let i = this.cols.length; i < list.length; i++) {
            const raw = list[i] == null ? '' : String(list[i]);
            const name = this.layout ? columnLetter(i) : normHeader(raw);
            this.cols.push(new Col(name, i, raw));
            this.headerNames.push(name);
        }
        this.headerSeen = true;
        if (this.keyCols) this._setupRoles(); // new columns from object rows
        for (const f of this.facts) if (f.header) f.header(this.headerNames);
    }

    _ensureCols(n) {
        if (n > this.cols.length) {
            const names = this.headerCellsRaw.slice();
            while (names.length < n) names.push('');
            for (let i = this.cols.length; i < n; i++) {
                const name = this.layout ? columnLetter(i) : '';
                this.cols.push(new Col(name, i, ''));
                this.headerNames.push(name);
            }
        }
    }

    /** Pick key and office columns. Incremental: columns added later (object rows) are appended. */
    _setupRoles() {
        const first = !this.keyCols;
        if (first) {
            this.keyCols = [];
            this.officeList = [];
            this._done = new Set();
            this._extraKeys = 0;
        }
        const fresh = this.cols.filter((c) => !this._done.has(c));
        fresh.forEach((c) => this._done.add(c));
        if (this.layout) return;
        const notKeys = new Set((this.rules.notKeys || []).map(lowKey));
        const declared = new Set((this.o.primaryKey || []).map(lowKey).filter((k) => !notKeys.has(k)));
        const ruleKeys = new Set((this.rules.keys || []).map(lowKey));
        const mk = (o) => Object.assign(o, { seen: new HashIndex(4096), blank: 0, dup: 0, dupSamples: [], blankSamples: [] });
        if (first && declared.size > 1) {
            // Composite declared key (several columns): checked as one value.
            const idx = this.cols.filter((c) => declared.has(c.low)).map((c) => c.idx);
            if (idx.length === declared.size) this.keyCols.push(mk({ col: null, declared: true, composite: idx }));
        }
        for (const c of fresh) {
            if (!c.name) continue;
            if (declared.size === 1 && declared.has(c.low)) this.keyCols.push(mk({ col: c, declared: true }));
            else if (ruleKeys.has(c.low)) this.keyCols.push(mk({ col: c, declared: false, rule: true }));
            else if (notKeys.has(c.low)) this.keyCols.push(mk({ col: c, declared: false, notKey: true }));
            else if (this._extraKeys < 2 && !declared.has(c.low) && R.KEY_HEADER.test(c.name)) {
                this.keyCols.push(mk({ col: c, declared: false }));
                this._extraKeys++;
            }
        }
        const fixed = this.rules.roles || {};
        for (const c of fresh) {
            if (!c.name) continue;
            const f = fixed[c.low];
            let role = null;
            if (f) {
                if (f === 'none') continue;
                role = f.replace(/!$/, '');
                c.noCombo = f.endsWith('!');
            } else {
                role = Object.keys(R.ROLE_HEADERS).find((r) => R.ROLE_HEADERS[r].test(c.name)) || null;
            }
            if (!role) continue;
            c.officeRole = role;
            c.odist = new Map();
            this.officeList.push(c);
        }
        const order = ['region', 'district', 'division', 'ccc', 'code', 'plant'];
        if (first) this.officeList.sort((x, y) => order.indexOf(x.officeRole) - order.indexOf(y.officeRole));
    }

    // ---- rows ------------------------------------------------------------------------------

    /** One source row: an array aligned with the header. */
    row(values) {
        if (!this.headerSeen) {
            this.setHeader(values);
            return;
        }
        if (!this.keyCols) this._setupRoles();
        const rowNo = this.firstRowNo + this.rowIndex;
        this.rowIndex++;
        if (this.rules.skipDataRows && this.rowIndex <= this.rules.skipDataRows) return;
        if (values.length > this.cols.length) {
            this._ensureCols(values.length);
            this._setupRoles();
        }
        let nonEmpty = 0;
        let meaningful = 0;
        let headerEcho = 0;
        let isTotal = false;
        for (let i = 0; i < values.length; i++) {
            const v = values[i];
            if (V.isBlank(v)) continue;
            nonEmpty++;
            const col = this.cols[i];
            const kind = this._cell(col, v, rowNo);
            if (kind === 'value') meaningful++;
            if (!this.layout) {
                const s = typeof v === 'string' ? v.trim() : '';
                if (s && col.low && s.toLowerCase().replace(/\s+/g, ' ') === col.low) headerEcho++;
                if (s && s.length <= 40 && (i < 4 || col.officeRole === 'ccc') && (TOTAL_RE.test(s) || (this.rules.summary && col.officeRole === 'ccc' && AGGREGATE_RE.test(s)))) isTotal = true;
            }
        }
        if (nonEmpty === 0) {
            this.blankPending++;
            if (this.blankPendingRows.length < SAMPLE_MAX) this.blankPendingRows.push(rowNo);
            return;
        }
        if (this.blankPending) {
            this.blankInterior += this.blankPending;
            for (const r of this.blankPendingRows) pushSample(this.blankInteriorRows, r);
            this.blankPending = 0;
            this.blankPendingRows = [];
        }
        this.dataRows++;
        this.meaningHist.set(meaningful, (this.meaningHist.get(meaningful) || 0) + 1);

        if (!this.layout) {
            if (meaningful <= 1) {
                this.ghost[meaningful]++;
                if (this.ghost.samples.length < SAMPLE_MAX) this.ghost.samples.push({ row: rowNo, cells: this._cells(values, 3) });
            }
            if (headerEcho >= 2 && headerEcho >= nonEmpty * 0.5) {
                this.repeatedHeader.n++;
                pushSample(this.repeatedHeader.samples, { row: rowNo, cells: this._cells(values, 4) });
            } else if (isTotal) {
                this.totalRows.n++;
                pushSample(this.totalRows.samples, { row: rowNo, cells: this._cells(values, 4) });
            }
            // Whole-row duplicates.
            const first = this.rowHashes.firstOrAdd(JSON.stringify(values.map((x) => (V.isBlank(x) ? '' : V.asText(x).trim()))), rowNo);
            if (first >= 0) {
                this.dupRows.n++;
                pushSample(this.dupRows.samples, { row: rowNo, same_as_row: first });
            }
            this._keys(values, rowNo);
            this._office(values, rowNo);
        }
        for (const f of this.facts) f.row(values, this.headerNames, rowNo);
    }

    _cells(values, max) {
        const out = {};
        let n = 0;
        for (let i = 0; i < values.length && n < max; i++) {
            if (V.isBlank(values[i])) continue;
            const name = this.headerNames[i] || letter(i);
            out[name] = maskValue(name, values[i]);
            n++;
        }
        return out;
    }

    /** Per-cell statistics. Returns 'value' | 'placeholder' | 'error'. */
    _cell(col, v, rowNo) {
        col.nonEmpty++;
        const isStr = typeof v === 'string';
        const s = isStr ? v.trim() : V.asText(v);
        if (col.firstValue === undefined) col.firstValue = [s, rowNo];
        if (this.rawValues && isStr && s !== v && !/^\s*$/.test(v)) {
            col.ws++;
            if (col.wsSamples.length < 3) col.wsSamples.push({ row: rowNo, value: JSON.stringify(maskValue(col.name, v, col.mask === '' ? '' : col.mask)) });
        }
        if (!col.distOver) {
            const k = s.length > 120 ? s.slice(0, 120) : s;
            const e = col.dist.get(k);
            if (e) e[0]++;
            else if (col.dist.size < DIST_CAP) col.dist.set(k, [1, rowNo]);
            else { col.distOver = true; col.dist = null; }
        }
        if (col.odist) {
            const e = col.odist.get(s);
            if (e) e[0]++;
            else if (col.odist.size < OFFICE_DIST_CAP) col.odist.set(s, [1, rowNo]);
        }
        if ((s[0] === '#' || s[0] === 'L' || s[0] === 'l' || s[0] === 'E') && V.SHEET_ERROR_RE.test(s)) {
            col.errors++;
            pushSample(col.errorSamples, { row: rowNo, value: s });
            return 'error';
        }
        if (typeof v === 'object' && v !== null) return 'value';
        if (typeof v === 'boolean') return 'value';
        const n = V.parseNumber(typeof v === 'number' ? v : s);
        if (n !== null) {
            col.num++;
            this._number(col, n, rowNo);
            // yyyymm / yyyymmdd numbers can be dates too.
            if (/^(19|20)\d{4}(\d{2})?$/.test(s)) this._date(col, V.classifyDate(s), s, rowNo);
            else if (n >= 20000 && n <= 73051 && Number.isInteger(n)) {
                col.serials++;
                if (col.serialSamples.length < 3) col.serialSamples.push({ row: rowNo, value: s });
            }
            if (n === 0) return 'placeholder';
            return 'value';
        }
        if (V.PLACEHOLDER_RE.test(s)) {
            col.placeholders++;
            const e = col.placeholderDist.get(s);
            if (e) e[0]++;
            else if (col.placeholderDist.size < 20) col.placeholderDist.set(s, [1, rowNo]);
            return 'placeholder';
        }
        if (/^(false|true)$/i.test(s)) return 'value';
        if (/\d/.test(s) && s.length >= 6 && s.length <= 40) {
            const d = V.classifyDate(s);
            if (d) {
                this._date(col, d, s, rowNo);
                return 'value';
            }
        }
        col.textCount++;
        const k = s.length > 80 ? s.slice(0, 80) : s;
        const e = col.textDist.get(k);
        if (e) e[0]++;
        else if (col.textDist.size < 200) col.textDist.set(k, [1, rowNo]);
        return 'value';
    }

    _number(col, n, rowNo) {
        col.sum += n;
        if (n < col.min) col.min = n;
        if (n > col.max) col.max = n;
        if (n < 0) {
            col.numNeg++;
            if (col.negSamples.length < SAMPLE_MAX) col.negSamples.push({ row: rowNo, value: n });
        }
        if (!col.res) col.res = new Float64Array(RES_SIZE);
        if (col.resN < RES_SIZE) col.res[col.resN] = n;
        else {
            const j = Math.floor(this.rand() * (col.resN + 1));
            if (j < RES_SIZE) col.res[j] = n;
        }
        col.resN++;
        insertExtreme(col.hi, n, rowNo, (a, b) => a > b);
        insertExtreme(col.lo, n, rowNo, (a, b) => a < b);
    }

    _date(col, d, s, rowNo) {
        if (!d) return;
        col.dateCount++;
        const fam = d.family.replace(/ time$/, '');
        const e = col.fam.get(fam);
        if (e) e[0]++;
        else col.fam.set(fam, [1, s, rowNo]);
        if (d.monthOnly) col.monthOnly++;
        if (d.dmy === null && d.mdy === null) {
            col.invalidDates++;
            pushSample(col.invalidSamples, { row: rowNo, value: s });
            return;
        }
        if (d.sep === '/' || d.sep === '-' || d.sep === '.') {
            if (d.dmy !== null && d.mdy === null) {
                col.dmyOnly++;
                if (!col.dmyOnlySample) col.dmyOnlySample = { row: rowNo, value: s };
            } else if (d.mdy !== null && d.dmy === null) {
                col.mdyOnly++;
                if (!col.mdyOnlySample) col.mdyOnlySample = { row: rowNo, value: s };
            } else if (d.dmy !== d.mdy) col.ambiguous++;
        }
        const limit = this.now + DAY_MS * 1.5;
        for (const order of ['dmy', 'mdy']) {
            const t = d[order];
            if (t === null) continue;
            if (t > col.maxDate[order]) col.maxDate[order] = t;
            if (t > limit) {
                col.future[order]++;
                if (col.future['s' + (order === 'dmy' ? 'Dmy' : 'Mdy')].length < SAMPLE_MAX) col.future['s' + (order === 'dmy' ? 'Dmy' : 'Mdy')].push({ row: rowNo, value: s });
            }
            if (t < OLD_LIMIT_MS) {
                col.old[order]++;
                if (col.old['s' + (order === 'dmy' ? 'Dmy' : 'Mdy')].length < SAMPLE_MAX) col.old['s' + (order === 'dmy' ? 'Dmy' : 'Mdy')].push({ row: rowNo, value: s });
            }
        }
    }

    _keys(values, rowNo) {
        for (const k of this.keyCols) {
            let v;
            if (k.composite) v = k.composite.map((i) => V.asText(values[i]).trim()).join('|');
            else v = V.asText(values[k.col.idx]).trim();
            if (!v || (k.composite && /^\|*$/.test(v)) || V.PLACEHOLDER_RE.test(v)) {
                k.blank++;
                if (k.blankSamples.length < SAMPLE_MAX) k.blankSamples.push({ row: rowNo, cells: this._cells(values, 3) });
                continue;
            }
            const first = k.seen.firstOrAdd(v, rowNo);
            if (first >= 0) {
                k.dup++;
                if (k.dupSamples.length < SAMPLE_MAX) {
                    const name = k.col ? k.col.name : (this.o.primaryKey || []).join('+');
                    k.dupSamples.push({ row: rowNo, first_row: first, value: k.col ? maskValue(name, v) : partial(v) });
                }
            }
        }
    }

    _office(values, rowNo) {
        if (!this.officeList.length) return;
        let any = false;
        const parts = [];
        for (const c of this.officeList) {
            const v = values[c.idx];
            const s = V.isBlank(v) ? '' : V.asText(v).trim();
            if (s) any = true;
            parts.push(s);
        }
        if (!any) {
            this.noOffice.n++;
            if (this.noOffice.samples.length < SAMPLE_MAX) this.noOffice.samples.push({ row: rowNo, cells: this._cells(values, 3) });
            return;
        }
        if (this.officeList.length < 2) return;
        const key = parts.join('\u0001');
        const e = this.combos.get(key);
        if (e) e[0]++;
        else if (this.combos.size < OFFICE_DIST_CAP) this.combos.set(key, [1, rowNo]);
        else this.combosOver = true;
    }

    // ---- finish ----------------------------------------------------------------------------

    finish() {
        if (!this.keyCols) this._setupRoles();
        this.blankTrailing = this.blankPending;
        const out = [];
        const add = (issue) => {
            if (!issue || !(issue.count > 0)) return;
            issue.sample = sanitizeSample((issue.sample || []).slice(0, SAMPLE_MAX), issue.column);
            out.push(issue);
        };
        const rows = this.dataRows;
        this._decideColumns();
        if (!this.layout) {
            this._headerIssues(add);
            this._rowIssues(add, rows);
            this._keyIssues(add, rows);
            this._officeIssues(add, rows);
        }
        for (const c of this.cols) this._columnIssues(c, add, rows);
        this._freshness(add);
        const facts = {};
        for (const f of this.facts) facts[f.id] = f.done();
        return {
            rows,
            sourceRows: this.rowIndex,
            columns: this.cols.length,
            issues: out,
            facts,
            asOn: this.asOn || null,
            stats: this._stats()
        };
    }

    _stats() {
        return this.cols.map((c) => ({
            name: c.name, nonEmpty: c.nonEmpty, kind: c.kind, num: c.num, dates: c.dateCount, text: c.textCount,
            order: c.order || null, role: c.officeRole || null
        }));
    }

    _decideColumns() {
        for (const c of this.cols) {
            const ne = c.nonEmpty - c.placeholders - c.errors;
            c.kind = 'text';
            if (ne <= 0) { c.kind = 'empty'; continue; }
            const dateHeader = R.DATE_HEADER.test(c.name) && !R.NOT_DATE_HEADER.test(c.name);
            const dateShare = c.dateCount / ne;
            const numShare = c.num / ne;
            if ((dateShare >= 0.5 && c.dateCount >= 1) || (dateHeader && dateShare >= 0.2) || (dateHeader && c.serials >= ne * 0.5)) {
                c.kind = 'date';
                const pref = this.rules.dateOrder || this.o.dateOrder;
                if (pref === 'mdy') c.order = c.dmyOnly > c.mdyOnly * 4 && c.dmyOnly > 5 ? 'dmy' : 'mdy';
                else c.order = c.mdyOnly > c.dmyOnly ? 'mdy' : 'dmy';
            } else if (numShare >= 0.8 && c.num >= 3) {
                c.kind = 'number';
            }
            if (R.LAT_HEADER.test(c.name)) c.geo = 'lat';
            else if (R.LNG_HEADER.test(c.name)) c.geo = 'lng';
        }
    }

    _headerIssues(add) {
        if (this.o.objectRows) return; // object sources (Supabase) name every column
        const blank = [];
        const seen = new Map();
        const dups = [];
        const spaced = [];
        this.headerCellsRaw.forEach((raw, i) => {
            const name = normHeader(raw);
            const col = this.cols[i];
            if (!name) {
                if (col && col.nonEmpty > 0) blank.push({ column: letter(i), values: col.nonEmpty });
                return;
            }
            const k = name.toLowerCase();
            if (seen.has(k)) dups.push({ name, columns: [seen.get(k), letter(i)] });
            else seen.set(k, letter(i));
            if (raw !== name) spaced.push({ column: letter(i), header: JSON.stringify(raw) });
        });
        // Header cells beyond the data width that are blank and empty are spreadsheet padding.
        for (const c of this.cols.slice(this.headerCellsRaw.length)) {
            if (c.nonEmpty > 0) blank.push({ column: letter(c.idx), values: c.nonEmpty });
        }
        add({ check: 'header.blank', severity: 'warn', column: '', count: blank.length, sample: blank, source_fix: true,
            hint: 'Some columns have values but no header. Type a header in row 1 of those columns (the mirror names them col_<letter>, and pages cannot find them by name).' });
        add({ check: 'header.duplicate', severity: 'warn', column: '', count: dups.length, sample: dups, source_fix: true,
            hint: 'Two or more columns share one header. Rename them so each header is unique: a page that reads the sheet by header name gets only one of them (the mirror adds _2, _3).' });
        add({ check: 'header.whitespace', severity: 'info', column: '', count: spaced.length, sample: spaced, source_fix: true,
            hint: 'Header cells with extra spaces or line breaks. The mirror trims them; pages that look up the exact header text may miss the column. Remove the extra spaces in row 1.' });
    }

    _rowIssues(add, rows) {
        add({ check: 'row.blank', severity: 'info', column: '', count: this.blankInterior, sample: this.blankInteriorRows.map((r) => ({ row: r })), source_fix: true,
            hint: 'Empty rows inside the data. The mirror skips them, but they break "select to the end" in the sheet and some page counts. Delete the empty rows.' });
        // Ghost rows: rows with at most one real value where a normal row has several.
        const median = histMedian(this.meaningHist);
        const ghosts = this.ghost[0] + this.ghost[1];
        if (median >= 4 && ghosts > 0) {
            add({ check: 'row.ghost', severity: ghosts > rows * 0.01 ? 'warn' : 'info', column: '', count: ghosts, sample: this.ghost.samples, source_fix: true,
                hint: `Rows with only one real value (a serial number, a 0, a dash or a formula left over) where a normal row has ${median}. Pages count them as records. Delete those rows or clear the leftover cells.` });
        }
        add({ check: 'row.repeated_header', severity: 'warn', column: '', count: this.repeatedHeader.n, sample: this.repeatedHeader.samples, source_fix: true,
            hint: 'The header row appears again inside the data (usually from pasting a second export below the first). Delete the repeated header rows.' });
        add({ check: 'row.total_row', severity: 'warn', column: '', count: this.totalRows.n, sample: this.totalRows.samples, source_fix: true,
            hint: 'A "Total" row sits inside the data. Pages add up every row, so the total is counted twice. Move totals to a separate tab or delete the row.' });
        add({ check: 'key.duplicate_row', severity: this.dupRows.n > rows * 0.01 ? 'warn' : 'info', column: '', count: this.dupRows.n, sample: this.dupRows.samples, source_fix: true,
            hint: 'Rows that are exact copies of an earlier row (every cell the same). Usually a double paste: delete the copies, or the page counts them twice.' });
    }

    _keyIssues(add, rows) {
        for (const k of this.keyCols) {
            const name = k.col ? k.col.name : (this.o.primaryKey || []).join(' + ');
            const filled = rows - k.blank;
            const unique = k.seen ? k.seen.size : 0;
            if (k.declared || k.rule) {
                add({ check: 'key.duplicate', severity: k.declared ? 'error' : 'warn', column: name, count: k.dup, sample: k.dupSamples, source_fix: true,
                    hint: `"${name}" should identify one row, but some values appear more than once. Keep one row per ${name} (the pages and the mirror keep only one of them).` });
                add({ check: 'key.blank', severity: k.declared ? 'error' : 'warn', column: name, count: k.blank, sample: k.blankSamples, source_fix: true,
                    hint: `Rows without a ${name}. Fill it in, or delete the row if it is not a real record.` });
            } else if (k.notKey) {
                add({ check: 'key.not_unique', severity: 'info', column: name, count: k.dup, sample: k.dupSamples.slice(0, 3), source_fix: false,
                    hint: `"${name}" repeats on ${k.dup} rows by design (several rows per ${name}), so it cannot be used as the row key.` });
            } else if (filled > 20 && k.dup > 0 && k.dup <= filled * 0.01 && unique > 20) {
                // A column that is unique in 99 %+ of rows is a key with a few accidental repeats.
                add({ check: 'key.duplicate', severity: 'info', column: name, count: k.dup, sample: k.dupSamples, source_fix: true,
                    hint: `"${name}" is unique in almost every row, but ${k.dup} value(s) repeat. Check whether those rows were entered twice.` });
            }
            k.seen = null; // free memory
        }
        this.rowHashes = null;
    }

    _officeIssues(add, rows) {
        const res = this.resolver;
        if (!res || !this.officeList.length) return;
        const skip = new Set(this.o.skipOffice || []);
        const checks = {};
        const put = (check, severity, col, value, n, firstRow, extra, hint) => {
            if (skip.has(check)) return;
            const id = check + '|' + col.name;
            let e = checks[id];
            if (!e) e = checks[id] = { check, severity, column: col.name, count: 0, sample: [], source_fix: true, hint };
            e.count += n;
            if (e.sample.length < SAMPLE_MAX) e.sample.push(Object.assign({ value, rows: n, first_row: firstRow }, extra || {}));
        };
        const usable = [];
        for (const c of this.officeList) {
            if (!c.odist) continue;
            let known = 0;
            let total = 0;
            const results = [];
            for (const [value, [n, firstRow]] of c.odist) {
                const r = c.officeRole === 'region' || c.officeRole === 'district' ? res.region(value)
                    : c.officeRole === 'division' ? res.division(value)
                        : c.officeRole === 'ccc' ? res.ccc(value)
                            : c.officeRole === 'plant' ? res.plant(value) : res.code(value);
                total += n;
                if (r.status === 'ok' || r.status === 'variant' || r.status === 'ambiguous' || r.status === 'code_name_mismatch' || r.status === 'legacy' || r.status === 'non_ccc_unit') known += n;
                results.push([value, n, firstRow, r]);
            }
            // A column that mostly does not hold offices of this kind is not an office column.
            const scopeCol = R.SCOPE_HEADERS.has(c.low);
            if (total === 0 || (known / total < 0.3 && !scopeCol)) continue;
            usable.push(c);
            c.resolved = new Map(results.map(([v, , , r]) => [v, r]));
            const label = c.officeRole === 'code' ? 'office code' : c.officeRole === 'plant' ? 'stock plant (see PLANT_MAP in stock/script.js)' : c.officeRole;
            for (const [value, n, firstRow, r] of results) {
                const shown = value;
                if (r.status === 'unknown') {
                    put(`office.unknown_${c.officeRole === 'district' ? 'region' : c.officeRole}`, 'warn', c, shown, n, firstRow, null,
                        `Values in "${c.name}" that are not a known ${label} of Malda zone. Correct the spelling to the standard name (see the office list in mzo_scope.js), or the rows drop out of office filters and scoped views.`);
                } else if (r.status === 'unknown_code') {
                    put('office.unknown_code', 'warn', c, shown, n, firstRow, null,
                        `Office codes in "${c.name}" that are not in the office code table. Check the code (a typo, or a new office that must be added to mzo_scope.js).`);
                } else if (r.status === 'outside_zone') {
                    put('office.outside_zone', 'warn', c, shown, n, firstRow, null,
                        `Codes in "${c.name}" belong to an office outside Malda zone (66[123]…). Remove those rows or check the code.`);
                } else if (r.status === 'ambiguous') {
                    put('office.ambiguous_name', 'warn', c, shown, n, firstRow, { could_be: r.candidates },
                        `Values in "${c.name}" that match more than one office (the app picks the first match, which can be wrong). Use the full standard name, e.g. "Old Malda" for the CCC, not "Malda".`);
                } else if (r.status === 'code_name_mismatch') {
                    put('office.code_name_mismatch', 'warn', c, shown, n, firstRow, { code_is: r.canonical },
                        `A cell in "${c.name}" holds a code and a name that are different offices. Fix whichever is wrong.`);
                } else if (r.status === 'legacy') {
                    put('office.legacy_division', 'info', c, shown, n, firstRow, null,
                        `"${c.name}" uses division names from before the re-organisation (North / South Malda). They do not map onto today's divisions, so division totals cannot use this column. Use today's division names (Malda, Chanchal, Gazole, …).`);
                } else if (r.status === 'non_ccc_unit') {
                    put('office.non_ccc_unit', 'info', c, shown, n, firstRow, { level: r.level, division: r.division || undefined },
                        `Codes in "${c.name}" that belong to a ${r.level === 'unit' ? 'substation, store or other non-CCC unit' : r.level + ' office'}, not to a CCC. Pages that count by CCC leave these rows out (or under "unassigned"); that is expected only if the work really sits at that office.`);
                } else if (r.status === 'variant') {
                    put('office.variant_spelling', 'info', c, shown, n, firstRow, { means: r.canonical },
                        `"${c.name}" spells some offices differently from the standard name. The app still places them, but searches and exports show two spellings. Use the standard name.`);
                }
            }
        }
        // Rows with no office at all: unassigned in charts, and visible to every scoped user.
        if (usable.length && this.noOffice.n > 0 && !skip.has('office.blank') && !this.rules.officeBlankOk) {
            const scoped = usable.some((c) => R.SCOPE_HEADERS.has(c.low));
            checks['office.blank'] = {
                check: 'office.blank', severity: this.noOffice.n > rows * 0.02 ? 'warn' : 'info', column: usable.map((c) => c.name).join(', '),
                count: this.noOffice.n, sample: this.noOffice.samples, source_fix: true,
                hint: 'Rows with every office column empty. They count as "unassigned" in office charts' + (scoped ? ', and the login office filter shows them to every office' : '') + '. Fill in the office.'
            };
        }
        // Row-level consistency: code vs name, CCC vs division, division vs region.
        if (usable.length >= 2) this._officeCombos(usable, put);
        for (const id of Object.keys(checks)) add(checks[id]);
    }

    _officeCombos(usable, put) {
        const res = this.resolver;
        const idx = this.officeList.map((c) => usable.includes(c));
        const byRole = (role) => usable.filter((c) => c.officeRole === role);
        const pos = new Map(this.officeList.map((c, i) => [c, i]));
        for (const [key, [n, firstRow]] of this.combos) {
            const parts = key.split('\u0001');
            const get = (c) => parts[pos.get(c)] || '';
            const facts = { region: new Set(), division: new Set(), ccc: new Set() };
            const fromCode = [];
            for (const c of usable) {
                if (c.noCombo) continue;
                const v = get(c);
                if (!v) continue;
                const r = c.resolved.get(v);
                if (!r || !(r.status === 'ok' || r.status === 'variant')) continue;
                if (c.officeRole === 'plant') {
                    if (r.division) fromCode.push({ col: c, division: r.division, v });
                } else if (c.officeRole === 'code') {
                    if (r.level === 'ccc') fromCode.push({ col: c, ccc: r.ccc, division: r.division, region: r.region, v });
                    else if (r.level === 'division') fromCode.push({ col: c, division: r.division, region: r.region, v });
                } else if (c.officeRole === 'ccc') facts.ccc.add(JSON.stringify([c.name, r.canonical, v]));
                else if (c.officeRole === 'division') facts.division.add(JSON.stringify([c.name, r.canonical, v]));
                else facts.region.add(JSON.stringify([c.name, r.canonical, v]));
            }
            const ccc = [...facts.ccc].map((x) => JSON.parse(x));
            const div = [...facts.division].map((x) => JSON.parse(x));
            const reg = [...facts.region].map((x) => JSON.parse(x));
            // Code vs names.
            for (const fc of fromCode) {
                for (const [col, canon, v] of ccc) {
                    if (fc.ccc && canon !== fc.ccc) {
                        put('office.code_name_mismatch', 'warn', fc.col, fc.v, n, firstRow, { [col]: v, code_is: fc.ccc },
                            'The office code and the office name in the same row are different offices. Fix whichever is wrong; pages that filter by code and pages that filter by name count these rows in different offices.');
                    }
                }
                for (const [col, canon, v] of div) {
                    if (fc.division && canon !== fc.division) {
                        put('office.code_name_mismatch', 'warn', fc.col, fc.v, n, firstRow, { [col]: v, code_is: fc.division + ' division' },
                            'The office code and the office name in the same row are different offices. Fix whichever is wrong; pages that filter by code and pages that filter by name count these rows in different offices.');
                    }
                }
            }
            // CCC vs division, division vs region.
            for (const [ccol, canon, cv] of ccc) {
                const d = res.divOf[canon];
                for (const [dcol, dcanon, dv] of div) {
                    if (d && dcanon !== d) {
                        put('office.parent_mismatch', 'warn', { name: dcol }, dv, n, firstRow, { [ccol]: cv, ccc_belongs_to: d },
                            'A CCC sits under the wrong division (or region) in the same row. Fix the division or the CCC; the row is counted under different parents on different pages.');
                    }
                }
            }
            for (const [dcol, dcanon, dv] of div) {
                const r = res.regionOfDiv[dcanon];
                for (const [rcol, rcanon, rv] of reg) {
                    if (r && rcanon !== r) {
                        put('office.parent_mismatch', 'warn', { name: rcol }, rv, n, firstRow, { [dcol]: dv, division_belongs_to: r },
                            'A CCC sits under the wrong division (or region) in the same row. Fix the division or the CCC; the row is counted under different parents on different pages.');
                    }
                }
            }
            void idx;
            void byRole;
        }
    }

    _columnIssues(c, add, rows) {
        if (!c.nonEmpty) return;
        const name = c.name || letter(c.idx);
        if (c.errors) {
            const lookupOnly = c.errorSamples.every((x) => /^#n\/a$/i.test(x.value)) && c.errors > c.nonEmpty * 0.3;
            add({ check: 'value.sheet_error', severity: lookupOnly ? 'info' : 'warn', column: name, count: c.errors, sample: c.errorSamples, source_fix: true,
                hint: `Formula errors (#N/A, #REF!, …) or "Loading..." in "${name}". The page reads them as text or zero. Fix the formula or paste values.` });
        }
        if (this.rawValues && c.ws && (c.officeRole || c.kind !== 'text' || (this.keyCols || []).some((k) => k.col === c))) {
            add({ check: 'value.whitespace', severity: 'info', column: name, count: c.ws, sample: c.wsSamples, source_fix: true,
                hint: `Leading or trailing spaces in "${name}". The mirror trims them, but a page comparing exact text can miss these rows. Trim the cells (Data → Data cleanup → Trim whitespace).` });
        }
        if (c.kind === 'number') this._numberIssues(c, name, add);
        if (c.kind === 'date') this._dateIssues(c, name, add);
        if (c.geo) this._geoIssues(c, name, add);
        void rows;
    }

    _numberIssues(c, name, add) {
        const ne = c.nonEmpty - c.errors;
        if (c.textCount > 0 && !this.layout && !R.NOT_MEASURE_HEADER.test(name) && !R.NOT_NUMERIC_TEXT_HEADER.test(name)) {
            const sample = [...c.textDist].sort((a, b) => b[1][0] - a[1][0]).slice(0, SAMPLE_MAX)
                .map(([v, [n, row]]) => ({ value: maskValue(name, v), rows: n, first_row: row }));
            const share = c.num / ne;
            add({ check: 'number.text_in_numeric', severity: share < 0.98 ? 'warn' : 'info', column: name, count: c.textCount, sample, source_fix: true,
                hint: `"${name}" is a number column, but ${c.textCount} cell(s) hold text.` + (share < 0.98 ? ' Because of them the whole column is stored as text in the mirror.' : ' The mirror keeps those cells word for word in a _raw column.') + ' Put plain numbers (no units, no words) in the cells.' });
        }
        if (c.placeholders > 0 && !this.layout && c.placeholders < c.nonEmpty * 0.5) {
            const sample = [...c.placeholderDist].map(([v, [n, row]]) => ({ value: v, rows: n, first_row: row }));
            add({ check: 'number.placeholder', severity: 'info', column: name, count: c.placeholders, sample, source_fix: false,
                hint: `"${name}" uses "-", "NA" or similar for "no value". The mirror treats them as empty; leave the cell blank instead if you edit the sheet.` });
        }
        if (c.numNeg > 0 && R.NONNEG_HEADER.test(name) && !R.SIGNED_HEADER.test(name)) {
            add({ check: 'number.negative', severity: 'warn', column: name, count: c.numNeg, sample: c.negSamples, source_fix: true,
                hint: `"${name}" holds a quantity, count, load or age, but some values are below zero. Check those rows.` });
        }
        // Outliers only for physical measures (counts, loads, capacities, lengths, days); money columns hold real big accounts.
        if (this.layout || this.rules.noOutliers || R.NOT_MEASURE_HEADER.test(name) || c.geo || !R.NONNEG_HEADER.test(name) || R.SIGNED_HEADER.test(name)) return;
        const o = outliers(c);
        if (o && o.count > 0) {
            add({ check: 'value.outlier', severity: 'info', column: name, count: o.count, sample: o.sample, source_fix: true,
                hint: `Values in "${name}" far outside the usual range (median ${fmtNum(o.median)}). Usually a typo (extra zeros, a code typed into the wrong column, a unit mix-up). Check those rows.` + (o.approx ? ' The count is estimated from a sample.' : '') });
        }
    }

    _dateIssues(c, name, add) {
        const ne = c.nonEmpty - c.placeholders - c.errors;
        const families = [...c.fam].filter(([f]) => !(f === 'iso_time' && c.fam.has('iso')));
        // Unparseable: text cells in a date column, and impossible dates such as 31/02/2026.
        const bad = c.textCount + c.invalidDates;
        if (bad > 0) {
            const sample = c.invalidSamples.slice(0, 5).concat([...c.textDist].sort((a, b) => b[1][0] - a[1][0]).slice(0, SAMPLE_MAX)
                .map(([v, [n, row]]) => ({ value: maskValue(name, v), rows: n, first_row: row })));
            add({ check: 'date.unparseable', severity: bad > Math.max(5, ne * 0.02) ? 'warn' : 'info', column: name, count: bad, sample, source_fix: true,
                hint: `Cells in date column "${name}" that are not a valid date (text, or a day that does not exist such as 31/02). Type them as dd/mm/yyyy.` });
        }
        if (c.serials > 0 && c.dateCount > 0) {
            add({ check: 'date.excel_serial', severity: 'warn', column: name, count: c.serials, sample: c.serialSamples, source_fix: true,
                hint: `Some dates in "${name}" show as a plain number (a spreadsheet day number such as 45930). Format those cells as dates.` });
        }
        if (families.length >= 2) {
            const total = families.reduce((s, [, [n]]) => s + n, 0);
            const sorted = families.sort((a, b) => b[1][0] - a[1][0]);
            const minority = total - sorted[0][1][0];
            add({ check: 'date.mixed_formats', severity: minority >= Math.max(3, total * 0.01) ? 'warn' : 'info', column: name, count: minority,
                sample: sorted.map(([f, [n, v, row]]) => ({ format: f, rows: n, example: v, first_row: row })), source_fix: true,
                hint: `"${name}" mixes date formats (${sorted.map(([f]) => f).join(', ')}). Use one format for the whole column (dd/mm/yyyy).` });
        }
        if (c.dmyOnly > 0 && c.mdyOnly > 0) {
            const minority = Math.min(c.dmyOnly, c.mdyOnly);
            add({ check: 'date.mixed_order', severity: 'error', column: name, count: minority + c.ambiguous,
                sample: [Object.assign({ reads_as: 'day first' }, c.dmyOnlySample), Object.assign({ reads_as: 'month first' }, c.mdyOnlySample), { ambiguous_rows: c.ambiguous }], source_fix: true,
                hint: `"${name}" has some dates written day-first (31/10/2026) and some month-first (10/31/2026). For days 1–12 nobody can tell which is meant (${c.ambiguous} such cells). Use one order (dd/mm/yyyy) for the whole column.` });
        }
        const order = c.order || 'dmy';
        const fut = c.future[order];
        if (fut > 0 && !R.FUTURE_OK_HEADER.test(name)) {
            const okFuture = false;
            add({ check: 'date.future', severity: okFuture ? 'info' : 'warn', column: name, count: fut, sample: c.future[order === 'dmy' ? 'sDmy' : 'sMdy'], source_fix: true,
                hint: `Dates in "${name}" that lie in the future.` + (okFuture ? ' This column may hold planned dates; check that they are meant.' : ' Usually a wrong year or day and month swapped. Correct them.') });
        }
        const old = c.old[order];
        if (old > 0) {
            add({ check: 'date.too_old', severity: 'warn', column: name, count: old, sample: c.old[order === 'dmy' ? 'sDmy' : 'sMdy'], source_fix: true,
                hint: `Dates in "${name}" before 1950 (often 01/01/1900 or 30/12/1899, a blank date turned into a number). Clear or correct them; age and delay figures computed from them are wrong.` });
        }
    }

    _geoIssues(c, name, add) {
        if (!c.res || !c.resN) return;
        const b = R.ZONE_BBOX;
        const [min, max] = c.geo === 'lat' ? [b.latMin, b.latMax] : [b.lngMin, b.lngMax];
        const other = c.geo === 'lat' ? [b.lngMin, b.lngMax] : [b.latMin, b.latMax];
        let out = 0; let zero = 0; let swapped = 0;
        const sample = [];
        const n = Math.min(c.resN, RES_SIZE);
        for (let i = 0; i < n; i++) {
            const v = c.res[i];
            if (v === 0) zero++;
            else if (v >= other[0] && v <= other[1]) swapped++;
            else if (v < min || v > max) out++;
        }
        const scale = c.resN > RES_SIZE ? c.resN / RES_SIZE : 1;
        for (const [v, row] of c.hi.concat(c.lo)) if ((v < min || v > max) && sample.length < SAMPLE_MAX && !sample.some((s) => s.row === row)) sample.push({ row, value: v });
        if (out + swapped > 0) {
            add({ check: 'value.geo_out_of_area', severity: 'warn', column: name, count: Math.round((out + swapped) * scale), sample, source_fix: true,
                hint: `Coordinates in "${name}" outside Malda zone` + (swapped ? ` (${Math.round(swapped * scale)} look like latitude and longitude swapped)` : '') + '. The map draws these points in the wrong place. Correct them (latitude ≈ 24.5–26.5, longitude ≈ 87.5–89.2).' + (scale > 1 ? ' The count is estimated from a sample.' : '') });
        }
        if (zero > 0) {
            add({ check: 'value.geo_zero', severity: 'info', column: name, count: Math.round(zero * scale), sample: [], source_fix: true,
                hint: `"${name}" is 0 in some rows (no location). Leave it blank or fill in the real coordinates.` });
        }
    }

    _freshness(add) {
        const rules = this.rules;
        if (rules.maxAgeDays === null) return;
        let col = null;
        const wanted = rules.asOn || [];
        for (const w of wanted) {
            col = this.cols.find((c) => (w instanceof RegExp ? w.test(c.name) : c.low === lowKey(w)));
            if (col) break;
        }
        let maxAge = rules.maxAgeDays;
        if (!col) {
            if (wanted.length && this.dataRows > 0) {
                add({ check: 'freshness.missing', severity: 'info', column: String(wanted[0]), count: 1, sample: [], source_fix: true,
                    hint: `The report date column "${wanted[0]}" was not found, so the page cannot show "as on". Restore the column.` });
                return;
            }
            col = this.cols.find((c) => R.AS_ON_HEADER.test(c.name) && c.kind === 'date');
            if (!col) return;
            maxAge = maxAge || R.defaultMaxAge(this.o.schedule);
        }
        if (col.kind !== 'date' && !col.dateCount) return;
        const order = col.order || 'dmy';
        if (rules.asOnSingle && col.dist && col.dist.size > 1) {
            const dates = [...col.dist].filter(([v]) => v).sort((a, b) => b[1][0] - a[1][0]);
            if (dates.length > 1) {
                const minority = dates.slice(1).reduce((n, [, [k]]) => n + k, 0);
                add({ check: 'freshness.mixed_as_on', severity: 'warn', column: col.name, count: minority,
                    sample: dates.slice(0, SAMPLE_MAX).map(([v, [k, row]]) => ({ as_on: v, rows: k, first_row: row })), source_fix: true,
                    hint: `"${col.name}" should hold one report date for the whole sheet, but rows carry ${dates.length} different dates: part of an older report was left in place. Paste the full new report (clear the old rows first).` });
            }
        }
        let t = col.maxDate[order];
        if (!Number.isFinite(t)) return;
        if (rules.monthEnd || col.monthOnly === col.dateCount) {
            const d = new Date(t);
            t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
        }
        // "now" in India: a date-only value is midnight IST.
        const todayIst = Math.floor((this.now + 330 * 60000) / DAY_MS) * DAY_MS;
        const age = Math.round((todayIst - t) / DAY_MS);
        this.asOn = { column: col.name, date: V.isoDay(t), age_days: age, max_age_days: maxAge };
        if (age < -1) {
            add({ check: 'freshness.future', severity: 'warn', column: col.name, count: 1, sample: [{ as_on: V.isoDay(t), age_days: age }], source_fix: true,
                hint: `The report date in "${col.name}" is in the future (${V.isoDay(t)}). Check the date typed in the sheet.` });
        } else if (maxAge && age > maxAge) {
            add({ check: 'freshness.stale', severity: age > maxAge * 3 ? 'error' : 'warn', column: col.name, count: 1, sample: [{ as_on: V.isoDay(t), age_days: age, expected_within_days: maxAge }], source_fix: true,
                hint: `The data is ${age} days old (as on ${V.isoDay(t)}); this report is normally refreshed within ${maxAge} days. Paste or upload the latest report.` });
        }
    }
}

function insertExtreme(arr, v, row, better) {
    if (arr.length < SAMPLE_MAX) {
        arr.push([v, row]);
        arr.sort((a, b) => (better(a[0], b[0]) ? -1 : 1));
        return;
    }
    if (!better(v, arr[arr.length - 1][0])) return;
    arr[arr.length - 1] = [v, row];
    arr.sort((a, b) => (better(a[0], b[0]) ? -1 : 1));
}

function median(sorted) {
    const n = sorted.length;
    if (!n) return NaN;
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * Robust outliers: modified z = 0.6745·|x − median| / MAD (Iglewicz–Hoaglin). Skewed positive
 * columns (amounts, loads) are measured on a log scale, and a value must also be more than 20×
 * the 95th percentile, so only "extra zeros"-type typos stand out, not big but real accounts.
 * Columns where most values are equal (MAD = 0) are not judged.
 */
function outliers(c) {
    const n = Math.min(c.resN, RES_SIZE);
    if (n < 30) return null;
    const vals = Array.from(c.res.subarray(0, n));
    if (new Set(vals).size < 10) return null;
    vals.sort((a, b) => a - b);
    const med = median(vals);
    const p95 = vals[Math.floor(n * 0.95)];
    const nonNeg = vals[0] >= 0;
    const skewed = nonNeg && p95 > 0 && (med <= 0 || p95 / med > 4);
    const shift = skewed ? Math.max(med, p95 / 100, 1e-9) : 0;
    const tf = skewed ? (x) => Math.log(Math.max(0, x) + shift) : (x) => x;
    const t = skewed ? vals.map(tf) : vals;
    const tm = median(t);
    const mad = median(t.map((x) => Math.abs(x - tm)).sort((a, b) => a - b));
    if (!(mad > 0)) return null;
    const LIMIT = skewed ? 7 : 10;
    const q1 = vals[Math.floor(n * 0.25)];
    const q3 = vals[Math.floor(n * 0.75)];
    const iqr = q3 - q1;
    if (!skewed && !(iqr > 0)) return null;
    const isOut = (x) => {
        if ((0.6745 * Math.abs(tf(x) - tm)) / mad <= LIMIT) return false;
        if (skewed) return x > 20 * p95;
        return x > q3 + 10 * iqr || x < q1 - 10 * iqr;
    };
    const z = (x) => Math.round(((0.6745 * Math.abs(tf(x) - tm)) / mad) * 10) / 10;
    let count = 0;
    for (const x of vals) if (isOut(x)) count++;
    const sample = [];
    for (const [v, row] of c.hi.concat(c.lo)) {
        if (isOut(v) && sample.length < SAMPLE_MAX && !sample.some((s2) => s2.row === row)) sample.push({ row, value: v, robust_z: z(v) });
    }
    const scale = c.resN > RES_SIZE ? c.resN / RES_SIZE : 1;
    // Extremes are exact even when the count is estimated.
    count = Math.max(Math.round(count * scale), sample.length);
    return { count, sample, median: med, approx: scale > 1 };
}

function histMedian(hist) {
    const entries = [...hist].sort((a, b) => a[0] - b[0]);
    const total = entries.reduce((s, [, n]) => s + n, 0);
    let acc = 0;
    for (const [k, n] of entries) {
        acc += n;
        if (acc >= total / 2) return k;
    }
    return 0;
}

function fmtNum(x) {
    if (!Number.isFinite(x)) return String(x);
    return Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-IN') : String(Math.round(x * 100) / 100);
}

function columnLetter(index) {
    return 'col_' + letter(index).toLowerCase();
}

/** Spreadsheet column letter for a 0-based index: 0 → A, 26 → AA. */
function letter(index) {
    let n = index + 1;
    let s = '';
    while (n > 0) {
        const r = (n - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

module.exports = { Checker, columnLetter, letter, normHeader, outliers };
