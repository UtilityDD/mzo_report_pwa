'use strict';
// Column types and values for the mirror, by lib/uniform.js's rules (docs/uniform-data.md), so a
// column has the same name and type in PocketBase as in the pages' uniform rows. Nothing here
// re-implements a rule: the statistics, the type choice and the value conversion are
// lib/uniform.js's own stats(), chooseType() and build().
//
//   number  ≥ 98 % of the non-empty values parse as numbers (Indian and Western grouping commas)
//   date    ≥ 98 % parse as dates (dd/mm/yyyy, dd.mm.yyyy, dd-mm-yyyy, m/d/yyyy, yyyy-mm-dd, ISO, 1-Oct-2026)
//   bool    every non-empty value is Y/N, Yes/No or true/false
//   json    every non-empty value is an object or array (Supabase json columns)
//   text    otherwise, and always for identifier names (…_no, …_id, …_code, phone, mobile, …)
//   Placeholders ((null), NA, #N/A, -, NIL, …) do not count against a type and are empty in a
//   typed column. A typed column whose few other values do not parse gets a "<name>_raw" text
//   companion that keeps them word for word.
//
// PocketBase cannot store an empty number or bool (it stores 0 / false), so the values uniform
// leaves null there are listed per row in the _nulls system field (see collections.js). Empty
// dates are '' and empty json is null, as in PocketBase itself.

const U = require('../../../lib/uniform.js');

const THRESHOLD = U.THRESHOLD;
const TYPES = new Set(['text', 'number', 'date', 'bool', 'json']);
const IST_OFFSET_MS = 330 * 60000;
const STATS_BATCH = 512; // values per uniform stats() call (its memo is per call)
const ISO_T = /^\d{4}([-/])\d{1,2}\1\d{1,2}T/;

/**
 * Per-column counters gathered while spooling: lib/uniform.js stats() over batches of values
 * (every counter is a plain count, so the batches add up to stats() over the whole column).
 * `nonEmpty` counts every value that is not '' (placeholders included): the padding rule.
 */
class ColumnStats {
    constructor() {
        this.nonEmpty = 0;
        this.buf = [];
        this.st = null;
    }

    add(v) {
        if (v === '' || v === null || v === undefined) return;
        this.nonEmpty++;
        this.buf.push(v);
        if (this.buf.length >= STATS_BATCH) this.flush();
    }

    flush() {
        if (!this.buf.length) return;
        const s = U.stats(this.buf);
        if (!this.st) this.st = s;
        else for (const k of Object.keys(s)) this.st[k] += s[k];
        this.buf = [];
    }

    /** lib/uniform.js stats() of every value added: { nonEmpty, nulls, num, dmy, mdy, time, bool, json } */
    result() {
        this.flush();
        return this.st || U.stats([]);
    }
}

/**
 * The column type, as lib/uniform.js build() chooses it: an override (the source's columnTypes,
 * or text for a primary key) wins; otherwise inference, where identifier names stay text.
 * @param {ColumnStats} stats
 * @param {string|null} override
 * @param {string|null} prefer the source's date order ('dmy' | 'mdy'), for ties
 * @param {string} base the column's base name (lib/uniform.js baseName, before deduplication)
 * @returns {{type, dateOrder?, hasTime?, bad}} bad = non-empty values that will not convert (→ _raw)
 */
function chooseType(stats, override, prefer, base) {
    if (override && !TYPES.has(override)) throw new Error('Unknown column type override: ' + override);
    const st = stats.result();
    const t = override === 'text' ? { type: 'text' } : U.chooseType(st, override || null, prefer || null, U.isIdName(base));
    const n = st.nonEmpty;
    const out = { type: t.type, bad: 0 };
    if (t.type === 'date') {
        out.dateOrder = t.order;
        if (st.time) out.hasTime = true;
        out.bad = n - (t.order === 'mdy' ? st.mdy : st.dmy);
    } else if (t.type === 'number') out.bad = n - st.num;
    else if (t.type === 'bool') out.bad = n - st.bool;
    return out;
}

/** lib/uniform.js date value → PocketBase date ("YYYY-MM-DD HH:MM:SS.sssZ"). */
function pbDateOf(s, cell) {
    if (s.length === 10) return s + ' 00:00:00.000Z'; // date only: UTC midnight
    if (s.charCodeAt(s.length - 1) === 90) return s.replace('T', ' '); // carried a zone: already UTC
    // The sheet's wall clock: India time, except a zone-less ISO "T" timestamp, which is a
    // database value (Supabase timestamp without time zone) and so UTC.
    const ms = Date.parse(s + 'Z');
    return new Date(typeof cell === 'string' && ISO_T.test(cell) ? ms : ms - IST_OFFSET_MS).toISOString().replace('T', ' ');
}

/** Column letter name lib/uniform.js gives column `index` of a header-less input. */
function letterName(index) {
    return U.baseName('', index);
}

const NULLABLE = new Set(['number', 'bool']); // the types PocketBase cannot leave empty

/**
 * Converts spool rows to PocketBase values through lib/uniform.js build(): each chunk of rows is
 * built header-less with every column's type pinned, so the values are exactly uniform's.
 * @param {{name, index, type, date_order?, raw_name?}[]} columns from buildColumns()
 * @param {object} [oldTypes] column name → type of the field the portal still shows while the
 *   column's type changes (collections.js staging). When that old field is a number or bool, the
 *   row's _nulls describes it, as stored, until the swap; such rows are counted in `provisional`.
 */
class Converter {
    constructor(columns, oldTypes) {
        this.columns = columns;
        const pin = (c, type) => (type === 'date' ? { type: 'date', order: c.date_order || 'dmy' } : { type });
        const fields = {};
        for (const c of columns) fields[letterName(c.index)] = pin(c, c.type);
        this.opts = { offices: null, schema: { header: false, keep: 'pinned', offices: false, fields } };
        this.shadow = null; // staged columns whose shown (old) field is a number or bool
        const old = {};
        for (const c of columns) {
            const t = oldTypes && oldTypes[c.name];
            if (t && t !== c.type && NULLABLE.has(t)) old[letterName(c.index)] = pin(c, t);
        }
        if (Object.keys(old).length) this.shadow = { offices: null, schema: { header: false, keep: 'pinned', offices: false, fields: old } };
    }

    /**
     * @param {any[][]} rows spool rows (raw cell values by source column index)
     * @returns {{ values: any[][], raw: string[][], nulls: (string[]|null)[], provisional: Uint8Array }}
     *   per column: PocketBase values and _raw texts ('' where the value parsed); per row: the
     *   number/bool fields that are empty, and whether that list is the staged one (old fields)
     */
    convert(rows) {
        const res = U.build(rows, this.opts);
        if (res.stats.rows !== rows.length) throw new Error(`converter: ${rows.length} rows in, ${res.stats.rows} out`);
        const at = new Map();
        res.columns.forEach((c, i) => at.set(c.raw_of ? '\u0000' + c.raw_of : c.name, i));
        const n = rows.length;
        const nulls = new Array(n).fill(null);
        const values = [];
        const raw = [];
        let shadow = null;
        if (this.shadow) {
            const sres = U.build(rows, this.shadow);
            shadow = new Map();
            sres.columns.forEach((c, i) => { if (!c.raw_of) shadow.set(c.name, sres.data[i]); });
        }
        const provisional = new Uint8Array(n); // rows whose _nulls differs from the new types' _nulls
        for (const c of this.columns) {
            const name = letterName(c.index);
            const old = shadow && shadow.get(name);
            if (old) {
                // The portal still shows the old field: list the column when its old value is empty.
                const isNew = NULLABLE.has(c.type) ? (r) => res.data[at.get(name)][r] === null : () => false;
                for (let r = 0; r < n; r++) {
                    const was = old[r] === null;
                    if (was) (nulls[r] || (nulls[r] = [])).push(c.name);
                    if (was !== isNew(r)) provisional[r] = 1;
                }
            }
            const data = res.data[at.get(name)];
            const ri = at.get('\u0000' + name);
            if (ri !== undefined && !c.raw_name) {
                throw new Error(`converter: column ${c.name} has values that do not parse but no _raw field`);
            }
            const out = new Array(n);
            if (c.type === 'number' || c.type === 'bool') {
                const zero = c.type === 'number' ? 0 : false;
                for (let r = 0; r < n; r++) {
                    const v = data[r];
                    if (v === null) {
                        out[r] = zero;
                        if (!old) (nulls[r] || (nulls[r] = [])).push(c.name);
                    } else out[r] = v;
                }
            } else if (c.type === 'date') {
                for (let r = 0; r < n; r++) out[r] = data[r] === null ? '' : pbDateOf(data[r], rows[r][c.index]);
            } else {
                for (let r = 0; r < n; r++) out[r] = data[r];
            }
            values.push(out);
            if (c.raw_name) raw.push(ri === undefined ? null : res.data[ri]);
        }
        return { values, raw, nulls, provisional };
    }
}

/** A trimmed string as a date: { dmy, mdy, time } in epoch ms (PocketBase's instant), or null. */
function parseDate(s) {
    const d = U.parseDate(s);
    if (!d) return null;
    const ms = (v) => (v === null ? null : Date.parse(pbDateOf(v, s).replace(' ', 'T')));
    return { dmy: ms(d.dmy), mdy: ms(d.mdy), time: d.time };
}

module.exports = { THRESHOLD, TYPES, parseNumber: U.parseNumber, parseDate, pbDateOf, ColumnStats, chooseType, Converter };
