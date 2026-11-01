'use strict';
// Column type inference and value conversion (contract thresholds):
//   number  ≥ 98 % of non-empty values parse as numbers (Indian grouping commas stripped)
//   date    ≥ 98 % parse as dates (dd/mm/yyyy, dd.mm.yyyy, dd-mm-yyyy, m/d/yyyy, yyyy-mm-dd, ISO, 1-Oct-2026)
//   bool    every non-empty value is Y/N, Yes/No or true/false
//   json    every non-empty value is an object or array (Supabase json columns)
//   text    otherwise
// A typed column whose few remaining values do not parse gets a "<name>_raw" text companion
// that keeps those values word for word, so nothing is ever dropped.

const THRESHOLD = 0.98;
const IST_OFFSET_MS = 330 * 60000;
const BOOL_TRUE = new Set(['y', 'yes', 'true']);
const BOOL_FALSE = new Set(['n', 'no', 'false']);

const MONTHS = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
    jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
    nov: 11, november: 11, dec: 12, december: 12
};

// Plain, Western-grouped (1,234,567) or Indian-grouped (12,34,567) numbers, optional decimals/exponent.
const NUM_RE = /^-?(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3}|\d+)?(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Number from a trimmed string, or null. Codes with leading zeros and >15 significant digits stay text. */
function parseNumber(s) {
    if (!s || !NUM_RE.test(s) || !/\d/.test(s)) return null;
    const mantissa = s.replace(/^-/, '').split(/[eE]/)[0];
    const intPart = mantissa.split('.')[0].replace(/,/g, '');
    if (intPart.length > 1 && intPart[0] === '0') return null;
    if (mantissa.replace(/[^0-9]/g, '').replace(/^0+/, '').length > 15) return null;
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function validDate(y, m, d) {
    return y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

function hour24(h, ampm) {
    if (!ampm) return h;
    const pm = /p/i.test(ampm);
    if (h < 1 || h > 12) return NaN;
    if (h === 12) return pm ? 12 : 0;
    return pm ? h + 12 : h;
}

/** UTC epoch ms: date-only → UTC midnight; local times are India time (UTC+05:30) unless a zone is given ('UTC' = no shift). */
function toMs(y, m, d, time, tz) {
    if (!validDate(y, m, d)) return null;
    if (!time) return Date.UTC(y, m - 1, d);
    const [hh, mi, ss, frac] = time;
    if (!(hh >= 0 && hh <= 23 && mi >= 0 && mi <= 59 && ss >= 0 && ss <= 59)) return null;
    const ms = frac ? Number(String(frac).padEnd(3, '0').slice(0, 3)) : 0; // PocketBase keeps milliseconds: truncate
    const base = Date.UTC(y, m - 1, d, hh, mi, ss, ms);
    if (tz === 'UTC') return base;
    if (tz === undefined || tz === null || tz === '') return base - IST_OFFSET_MS;
    if (tz === 'Z' || tz === 'z') return base;
    const tm = /^([+-])(\d{2}):?(\d{2})$/.exec(tz);
    if (!tm) return null;
    const off = (Number(tm[2]) * 60 + Number(tm[3])) * 60000;
    return tm[1] === '+' ? base - off : base + off;
}

const ISO_RE = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|z|[+-]\d{2}:?\d{2})?)?$/;
const DMY_RE = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?[Mm]\.?)?)?$/;
const DMONY_RE = /^(\d{1,2})[-\s/]([A-Za-z]{3,9})\.?[-\s/,]+(\d{4}|\d{2})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?[Mm]\.?)?)?$/;
const MONDY_RE = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?[Mm]\.?)?)?$/;

function timeParts(h, mi, s, ampm, frac) {
    if (h === undefined) return null;
    return [hour24(Number(h), ampm), Number(mi), Number(s || 0), frac];
}

/**
 * Parse a trimmed string as a date. Returns null, or { dmy, mdy, time } with epoch ms under
 * day-first and month-first readings (equal for unambiguous formats; null where invalid).
 */
function parseDate(s) {
    if (!s || s.length < 6 || s.length > 40) return null;
    let m = ISO_RE.exec(s);
    if (m) {
        // A zone-less ISO "T" timestamp is a database value (Supabase timestamp): UTC.
        // A zone-less "yyyy-mm-dd hh:mm" is a sheet cell: India time.
        const tz = m[9] || (m[5] !== undefined && s.indexOf('T') !== -1 ? 'UTC' : undefined);
        const ms = toMs(+m[1], +m[3], +m[4], timeParts(m[5], m[6], m[7], null, m[8]), tz);
        return ms === null ? null : { dmy: ms, mdy: ms, time: m[5] !== undefined };
    }
    m = DMY_RE.exec(s);
    if (m) {
        const a = +m[1], b = +m[3], y = +m[4];
        const t = timeParts(m[5], m[6], m[7], m[8]);
        const dmy = toMs(y, b, a, t);
        const mdy = m[2] === '/' ? toMs(y, a, b, t) : null; // only slashes are month-first anywhere
        if (dmy === null && mdy === null) return null;
        return { dmy, mdy, time: !!t };
    }
    m = DMONY_RE.exec(s);
    if (m) {
        const mon = MONTHS[m[2].toLowerCase()];
        if (!mon) return null;
        let y = +m[3];
        if (m[3].length === 2) y += 2000;
        const ms = toMs(y, mon, +m[1], timeParts(m[4], m[5], m[6], m[7]));
        return ms === null ? null : { dmy: ms, mdy: ms, time: m[4] !== undefined };
    }
    m = MONDY_RE.exec(s);
    if (m) {
        const mon = MONTHS[m[1].toLowerCase()];
        if (!mon) return null;
        const ms = toMs(+m[3], mon, +m[2], timeParts(m[4], m[5], m[6], m[7]));
        return ms === null ? null : { dmy: ms, mdy: ms, time: m[4] !== undefined };
    }
    return null;
}

/** Per-column counters gathered while spooling a source. */
class ColumnStats {
    constructor() {
        this.nonEmpty = 0;
        this.num = 0;
        this.dmy = 0;
        this.mdy = 0;
        this.bool = 0;
        this.json = 0;
        this.maxLen = 0;
    }

    add(v) {
        if (v === '' || v === null || v === undefined) return;
        this.nonEmpty++;
        if (typeof v === 'number') {
            this.num++;
            return;
        }
        if (typeof v === 'boolean') {
            this.bool++;
            return;
        }
        if (typeof v === 'object') {
            this.json++;
            const len = JSON.stringify(v).length;
            if (len > this.maxLen) this.maxLen = len;
            return;
        }
        const s = String(v);
        if (s.length > this.maxLen) this.maxLen = s.length;
        if (parseNumber(s) !== null) {
            this.num++;
            return;
        }
        const d = parseDate(s);
        if (d) {
            if (d.dmy !== null) this.dmy++;
            if (d.mdy !== null) this.mdy++;
            return;
        }
        const low = s.toLowerCase();
        if (BOOL_TRUE.has(low) || BOOL_FALSE.has(low)) this.bool++;
    }
}

/**
 * Choose a column type. `prefer` is the source's date order ('dmy' default, 'mdy' for stock).
 * @returns {{type: string, dateOrder?: string, bad: number}} bad = non-empty values that will not parse
 */
function chooseType(stats, override, prefer) {
    const n = stats.nonEmpty;
    if (override) {
        // Overrides win over inference; values that will not convert still get a _raw companion.
        if (override === 'number') return { type: 'number', bad: n - stats.num };
        if (override === 'bool') return { type: 'bool', bad: n - stats.bool };
        if (override === 'date') {
            const order = prefer === 'mdy' || stats.mdy > stats.dmy ? 'mdy' : 'dmy';
            return { type: 'date', dateOrder: order, bad: n - (order === 'mdy' ? stats.mdy : stats.dmy) };
        }
        if (override === 'json' || override === 'text') return { type: override, bad: 0 };
        throw new Error('Unknown column type override: ' + override);
    }
    if (n === 0) return { type: 'text', bad: 0 };
    if (stats.json === n) return { type: 'json', bad: 0 };
    if (stats.json > 0) return { type: 'text', bad: 0 };
    if (stats.bool === n) return { type: 'bool', bad: 0 };
    const need = THRESHOLD * n;
    if (stats.num >= need) return { type: 'number', bad: n - stats.num };
    const best = Math.max(stats.dmy, stats.mdy);
    if (best >= need) {
        let order;
        if (stats.dmy === stats.mdy) order = prefer === 'mdy' ? 'mdy' : 'dmy';
        else order = stats.dmy > stats.mdy ? 'dmy' : 'mdy';
        return { type: 'date', dateOrder: order, bad: n - (order === 'dmy' ? stats.dmy : stats.mdy) };
    }
    return { type: 'text', bad: 0 };
}

function pbDateString(ms) {
    return new Date(ms).toISOString().replace('T', ' ');
}

/**
 * Converter for one column: raw value → [stored value, raw text kept when it does not parse ('' otherwise)].
 */
function converter(type, dateOrder) {
    switch (type) {
        case 'number':
            return (v) => {
                if (v === '' || v === null || v === undefined) return [0, ''];
                if (typeof v === 'number') return Number.isFinite(v) ? [v, ''] : [0, String(v)];
                const n = parseNumber(String(v));
                return n === null ? [0, String(v)] : [n, ''];
            };
        case 'date':
            return (v) => {
                if (v === '' || v === null || v === undefined) return ['', ''];
                const d = parseDate(String(v));
                const ms = d ? (dateOrder === 'mdy' ? d.mdy : d.dmy) : null;
                return ms === null ? ['', String(v)] : [pbDateString(ms), ''];
            };
        case 'bool':
            return (v) => {
                if (typeof v === 'boolean') return [v, ''];
                const low = String(v == null ? '' : v).toLowerCase();
                if (BOOL_TRUE.has(low)) return [true, ''];
                if (low === '' || BOOL_FALSE.has(low)) return [false, ''];
                return [false, String(v)];
            };
        case 'json':
            return (v) => {
                if (v === '' || v === null || v === undefined) return [null, ''];
                if (typeof v !== 'string') return [v, ''];
                const s = v.trim();
                if (/^[[{]/.test(s)) {
                    try {
                        return [JSON.parse(s), ''];
                    } catch (_) { /* keep the string */ }
                }
                return [v, ''];
            };
        default:
            return (v) => {
                if (v === null || v === undefined) return ['', ''];
                if (typeof v === 'object') return [JSON.stringify(v), ''];
                return [String(v), ''];
            };
    }
}

module.exports = { THRESHOLD, parseNumber, parseDate, ColumnStats, chooseType, converter };
