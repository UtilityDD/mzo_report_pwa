'use strict';
// Data quality engine: one dataset's snapshot bytes → findings (docs/data-quality.md, "Admin → Data quality").
//
//   checkDataset({ key, text, format, schema, prev, now, offices }) → { rows, columns, asOn, personal, baseline, findings, ms }
//
// Two streaming passes over the text, never a row array or a full column in memory:
//   1. column statistics in chunks (lib/uniform.js stats(), summed), so each column gets exactly the type
//      the uniform rows and the PocketBase mirror give it (chooseType with the schema's pins);
//   2. every row once through the checks in checks.js (typed values, office of the row, row number).
// Memory: the text, a few counters per column, and a 53-bit hash per row for the duplicate checks.

const U = require('../../../../lib/uniform.js');
const { GENERIC, COLUMN, datasetRules } = require('./rules');
const checks = require('./checks');

const NULL_RE = /^(\(null\)|null|#n\/a|n\/a|na|nil|none|-+|\.)$/i; // lib/uniform.js placeholders
const CHUNK = 4096;
const MEMO = 4096;

/** Rows of a CSV / TSV text or a JSON array, after the header row (and skip_rows): cb(cells, rowNo). */
function eachDataRow(input, opts, cb) {
    const header = opts.header !== false;
    const headerRow = opts.headerRow || 0;
    const skip = opts.skipRows && opts.skipRows.length ? new Set(opts.skipRows) : null;
    let at = -1;
    let seen = 0;
    const buf = [];
    const onRow = (cells, rowNo) => {
        at++;
        if (header && at < headerRow) return;
        if (header && at === headerRow) { if (opts.onHeader) opts.onHeader(cells.slice()); return; }
        if (skip && skip.has(seen++)) return;
        if (!skip) seen++;
        let any = false;
        for (let c = 0; c < cells.length; c++) {
            const v = cells[c];
            const s = v === null || v === undefined ? '' : typeof v === 'string' ? v.trim() : typeof v === 'object' ? JSON.stringify(v) : String(v);
            buf[c] = s;
            if (s !== '') any = true;
        }
        buf.length = cells.length;
        if (any) cb(buf, rowNo);
    };
    if (Array.isArray(input)) {
        // JSON objects: the keys (first-seen order) are the header; "row" numbers are record numbers
        const keys = [];
        const pos = new Map();
        for (const o of input) if (o && typeof o === 'object') for (const k of Object.keys(o)) if (!pos.has(k)) { pos.set(k, keys.length); keys.push(k); }
        onRow(keys, 0);
        const row = new Array(keys.length);
        input.forEach((o, i) => {
            if (!o || typeof o !== 'object') return;
            for (let k = 0; k < keys.length; k++) row[k] = Object.prototype.hasOwnProperty.call(o, keys[k]) ? o[keys[k]] : '';
            onRow(row, i + 1);
        });
        return;
    }
    let line = 0;
    U.eachRow(input, opts.format === 'tsv' ? '\t' : ',', opts.format !== 'tsv', (cells) => { line++; onRow(cells, line); });
}

/** '19120227' → '1912-02-27' (any year, so placeholder and impossible years stay visible), else null. */
function ymd8(s) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (!m) return null;
    const mo = +m[2];
    const d = +m[3];
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// rules.js dateFormats → parser ('YYYY-MM-DD' or null).
const SPECIAL_DATES = {
    yyyymm(s) { // a report month: its last day
        const m = /^(\d{4})(\d{2})$/.exec(s);
        if (!m || +m[2] < 1 || +m[2] > 12) return null;
        return new Date(Date.UTC(+m[1], +m[2], 0)).toISOString().slice(0, 10);
    },
    'm/d/yy'(s) { // 1/23/26 0:00
        const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})(?:\s|$)/.exec(s);
        if (!m || +m[1] < 1 || +m[1] > 12 || +m[2] < 1 || +m[2] > 31) return null;
        return `20${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    }
};

/** Two 32-bit FNV variants → one number below 2^53 (collisions negligible for a million rows). */
function hash53(s) {
    let a = 0x811c9dc5;
    let b = 0x1b873593;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        a ^= c; a = Math.imul(a, 0x01000193) >>> 0;
        b ^= c; b = Math.imul(b ^ (b >>> 15), 0x2c1b3c6d) >>> 0;
    }
    return a * 2097152 + (b >>> 11);
}

function columnRoles(name) {
    const id = COLUMN.id.test(name) || U.isIdName(name);
    const amount = !id && COLUMN.amount.test(name);
    const count = !id && !amount && COLUMN.count.test(name) && !COLUMN.notMeasure.test(name);
    return {
        id,
        amount,
        count,
        lat: COLUMN.lat.test(name),
        lng: COLUMN.lng.test(name),
        date: COLUMN.date.test(name),
        futureOk: COLUMN.futureOk.test(name),
        personal: COLUMN.personal.test(name)
    };
}

/**
 * @param {object} o
 *   key      dataset key
 *   text     snapshot text (csv / tsv / json)
 *   format   'csv' | 'tsv' | 'json'
 *   schema   parsed schema/<key>.json or null (pins, aliases, header_row, skip_rows, header)
 *   prev     the dataset's baseline from the last good check ({ rows, columns, filled, nonZero }) or null
 *   now      ms (tests pin it)
 *   offices  lib/offices.js (null: no office checks)
 */
function checkDataset(o) {
    const t0 = Date.now();
    const key = o.key;
    const schema = o.schema || null;
    const fields = (schema && schema.fields) || {};
    const rules = datasetRules(key);
    const now = o.now || Date.now();
    let input = o.text;
    if (o.format === 'json') {
        input = JSON.parse(String(o.text || '[]'));
        if (!Array.isArray(input)) input = input && Array.isArray(input.items) ? input.items : [];
    }
    const header = !(schema && schema.header === false) && o.header !== false;
    const rowOpts = { format: o.format, header, headerRow: (schema && schema.header_row) || 0, skipRows: schema && schema.skip_rows };

    // ---- pass 1: header and column statistics -----------------------------------------------------
    let head = [];
    const chunks = [];
    const totals = [];
    let nRows = 0;
    const flush = (c) => {
        const st = U.stats(chunks[c]);
        const tt = totals[c] || (totals[c] = { nonEmpty: 0, nulls: 0, num: 0, dmy: 0, mdy: 0, time: 0, bool: 0, json: 0 });
        for (const k of Object.keys(tt)) tt[k] += st[k];
        chunks[c].length = 0;
    };
    eachDataRow(input, Object.assign({}, rowOpts, { onHeader: (h) => { head = h; } }), (cells) => {
        for (let c = 0; c < cells.length; c++) {
            if (!chunks[c]) {
                chunks[c] = [];
                // a column that starts late: the rows before it were blank in it
            }
            chunks[c].push(cells[c]);
            if (chunks[c].length >= CHUNK) flush(c);
        }
        nRows++;
    });
    for (let c = 0; c < chunks.length; c++) if (chunks[c] && chunks[c].length) flush(c);
    const width = Math.max(head.length, totals.length);

    // ---- columns: names (the mirror's), types (uniform's), roles ------------------------------------
    let cols = [];
    for (let c = 0; c < width; c++) {
        const sname = header ? U.cleanHeader(head[c]) : '';
        const st = totals[c] || { nonEmpty: 0, nulls: 0, num: 0, dmy: 0, mdy: 0, time: 0, bool: 0, json: 0 };
        if (header && sname === '' && st.nonEmpty === 0 && st.nulls === 0) continue; // padding
        cols.push({ source_name: sname, index: c, stats: st });
    }
    const names = U.fieldNames(cols.map((c) => c.source_name), cols.map((c) => c.index));
    cols.forEach((c, i) => { c.name = names[i]; c.base = U.baseName(c.source_name, c.index); });
    // schema aliases: a renamed header keeps its field name (as lib/uniform.js build does)
    const byName = new Map(cols.map((c) => [c.name, c]));
    for (const f of Object.keys(fields)) {
        if (byName.has(f)) continue;
        for (const al of (fields[f] && fields[f].aliases) || []) {
            const want = U.baseName(al, 0);
            const hit = cols.find((c) => (c.name === want || c.base === want || c.source_name === al) && !fields[c.name]);
            if (hit) { byName.delete(hit.name); hit.name = f; byName.set(f, hit); break; }
        }
    }
    const prefer = (schema && schema.date_order) || null;
    cols = cols.map((c, i) => {
        const pin = fields[c.name] && fields[c.name].type;
        const order = (fields[c.name] && fields[c.name].order) || prefer;
        const t = U.chooseType(c.stats, pin, order, U.isIdName(c.base));
        const roles = columnRoles(c.name);
        // A text column named like a date whose values are mostly dates is checked as one.
        let dateOrder = t.type === 'date' ? t.order : null;
        if (t.type === 'text' && roles.date && c.stats.nonEmpty > 0 && Math.max(c.stats.dmy, c.stats.mdy) >= 0.6 * c.stats.nonEmpty) {
            dateOrder = c.stats.mdy > c.stats.dmy ? 'mdy' : 'dmy';
        }
        // A number column named like a date holds yyyymmdd dates (the REM dumps: DATE_OF_CO 19120227).
        if (t.type === 'number' && roles.date && !roles.amount) dateOrder = 'ymd8';
        // Formats the uniform layer does not read as dates, named per dataset in rules.js (dateFormats).
        if (rules.dateFormats && rules.dateFormats[c.name]) dateOrder = rules.dateFormats[c.name];
        return { i, name: c.name, source_name: c.source_name, index: c.index, type: t.type, dateOrder, pinned: !!fields[c.name], roles,
            nonEmpty: c.stats.nonEmpty };
    });
    const personal = cols.some((c) => c.roles.personal);

    // ---- offices of each row (lib/offices.js), memoised by the row's office cells ---------------------
    let roles = null;
    if (o.offices && typeof o.offices.officeColumns === 'function' && !rules.layout) {
        roles = o.offices.officeColumns(key, cols.map((c) => ({ source_name: c.source_name, name: c.name, index: c.index, col: c })));
        if (roles && !['codes', 'cccs', 'divisions', 'regions'].some((r) => roles[r] && roles[r].length)) roles = null;
    }
    const officeMemo = new Map();
    const officeOf = (cells) => {
        const parts = {};
        let sig = '';
        let blank = true;
        for (const r of ['codes', 'cccs', 'divisions', 'regions']) {
            parts[r] = (roles[r] || []).map((x) => { const v = cells[x.index] || ''; if (v !== '') blank = false; return v; });
            sig += parts[r].join('\u0001') + '\u0002';
        }
        if (blank) return { blank: true, level: '', office: {}, problems: [] };
        let res = officeMemo.get(sig);
        if (!res) {
            const r = o.offices.resolve(parts);
            res = { blank: false, level: (r.office && r.office.level) || '', office: r.office || {}, problems: r.problems || [], cells: parts };
            if (officeMemo.size < 20000) officeMemo.set(sig, res);
        }
        return res;
    };

    // ---- pass 2: every row through the checks -------------------------------------------------------
    const ctx = {
        key, cols, rules, schema, now, prev: o.prev || null, personal, layout: !!rules.layout,
        hasOffices: !!roles, officeRoles: roles, generic: GENERIC, json: o.format === 'json', rows: nRows, hash53
    };
    const active = checks.create(ctx);
    const typed = new Array(cols.length);
    const memos = cols.map(() => new Map());
    const row = { n: 0, cells: null, typed, office: null };
    eachDataRow(input, rowOpts, (cells, rowNo) => {
        for (let k = 0; k < cols.length; k++) {
            const c = cols[k];
            const s = cells[c.index] || '';
            if (s === '' || (c.type !== 'number' && !c.dateOrder)) { typed[k] = null; continue; }
            const memo = memos[k];
            let v = memo.get(s);
            if (v === undefined) {
                if (NULL_RE.test(s)) v = null;
                else if (c.dateOrder === 'ymd8') v = ymd8(s);
                else if (SPECIAL_DATES[c.dateOrder]) v = SPECIAL_DATES[c.dateOrder](s);
                else if (c.type === 'number') v = U.parseNumber(s);
                else { const d = U.parseDate(s); v = d ? (c.dateOrder === 'mdy' ? d.mdy : d.dmy) : null; }
                if (memo.size < MEMO) memo.set(s, v);
            }
            typed[k] = v;
        }
        row.n = rowNo;
        row.cells = cells;
        row.office = roles ? officeOf(cells) : null;
        for (const ch of active) ch.row(row);
    });
    const findings = [];
    for (const ch of active) {
        const out = ch.finish() || [];
        for (const f of out) findings.push(f);
    }
    const asOn = ctx.asOn || null;
    const baseline = {
        rows: nRows,
        columns: cols.map((c) => c.name),
        filled: ctx.filled || [],
        nonZero: ctx.nonZero || []
    };
    return {
        rows: nRows,
        columns: cols.map((c) => ({ name: c.name, type: c.dateOrder && c.type !== 'date' ? 'date-like' : c.type })),
        asOn,
        personal,
        layout: !!rules.layout,
        baseline,
        findings: findings.map((f) => Object.assign({ dataset: key }, f)),
        ms: Date.now() - t0
    };
}

module.exports = { checkDataset, eachDataRow, hash53, columnRoles, NULL_RE };
