'use strict';
// Value parsing for the quality checks. Numbers follow the sync's rule (vm/sync/lib/infer.js):
// plain, Western-grouped or Indian-grouped digits, optional decimals or exponent; codes with a
// leading zero or more than 15 significant digits are not numbers. Dates are classified by
// format family as well as parsed, because "mixed formats in one column" is itself a finding.

const NUM_RE = /^-?(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3}|\d+)?(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Number from a trimmed string (or a number), else null. */
function parseNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s || !NUM_RE.test(s) || !/\d/.test(s)) return null;
    const mantissa = s.replace(/^-/, '').split(/[eE]/)[0];
    const intPart = mantissa.split('.')[0].replace(/,/g, '');
    if (intPart.length > 1 && intPart[0] === '0') return null;
    if (mantissa.replace(/[^0-9]/g, '').replace(/^0+/, '').length > 15) return null;
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

/** Looser reading used only to say "this text is almost a number" (₹, %, spaces, trailing dot). */
function looseNumber(s) {
    const t = String(s).replace(/[₹%\s]|rs\.?|inr/gi, '').replace(/\.$/, '');
    return parseNumber(t);
}

// Spreadsheet placeholders that mean "nothing here" in a numeric or date column.
const PLACEHOLDER_RE = /^(-+|—|–|na|n\/a|n\.a\.?|nil|null|\(null\)|<null>|none|not available|not applicable|nan|undefined|\?+|x+|\.|0?0\/0?0\/0{2,4})$/i;
// Formula errors and loading placeholders that a sheet exports instead of a value.
const SHEET_ERROR_RE = /^(#n\/a|#ref!|#value!|#div\/0!|#name\?|#num!|#null!|#error!?|#spill!|#calc!|loading\.\.\.|error: .*|#n\/a .*)$/i;

const MONTHS = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
    jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
    nov: 11, november: 11, dec: 12, december: 12
};

function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function ymd(y, m, d) {
    if (!(y >= 1800 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m))) return null;
    return Date.UTC(y, m - 1, d);
}

const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?\s*(?:Z|z|[+-]\d{2}:?\d{2})?)?$/;
const YMD_SLASH_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ T].*)?$/;
const NUMERIC_DATE_RE = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*[AaPp]\.?[Mm]\.?)?)?$/;
const DMONY_RE = /^(\d{1,2})[-\s/]([A-Za-z]{3,9})\.?[-\s/,]+(\d{4}|\d{2})(?:[ T,]+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp]\.?[Mm]\.?)?)?$/;
const MONDY_RE = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:[ T,]+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp]\.?[Mm]\.?)?)?$/;
const MONY_RE = /^([A-Za-z]{3,9})[-\s/']+(\d{4}|\d{2})$/;
const YYYYMM_RE = /^(20\d{2})(0[1-9]|1[0-2])$/;
const YYYYMMDD_RE = /^(19|20)(\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;

/**
 * Classify a date-like string. Returns null when it does not look like a date at all, else
 * { family, dmy, mdy } where dmy/mdy are epoch ms under day-first and month-first readings
 * (equal for unambiguous families, null where that reading is invalid).
 * Families: iso, iso_time, ymd_slash, d/m/y (slash), d.m.y, d-m-y, d-mon-y, mon-d-y, mon-y,
 * yyyymm, yyyymmdd, 2digit_year.
 */
function classifyDate(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (s.length < 6 || s.length > 40) {
        if (!(s.length === 6 && YYYYMM_RE.test(s))) return null;
    }
    let m = ISO_RE.exec(s);
    if (m) {
        const t = ymd(+m[1], +m[2], +m[3]);
        return t === null ? { family: 'iso', dmy: null, mdy: null } : { family: m[4] !== undefined ? 'iso_time' : 'iso', dmy: t, mdy: t };
    }
    m = YMD_SLASH_RE.exec(s);
    if (m) {
        const t = ymd(+m[1], +m[2], +m[3]);
        return { family: 'yyyy/mm/dd', dmy: t, mdy: t };
    }
    m = NUMERIC_DATE_RE.exec(s);
    if (m) {
        const a = +m[1], b = +m[3];
        let y = +m[4];
        const twoDigit = m[4].length === 2;
        if (twoDigit) y += 2000;
        const sep = m[2];
        const family = (sep === '/' ? 'dd/mm/yyyy' : sep === '.' ? 'dd.mm.yyyy' : 'dd-mm-yyyy') + (twoDigit ? ' (2-digit year)' : '') + (m[5] !== undefined ? ' time' : '');
        return { family, dmy: ymd(y, b, a), mdy: ymd(y, a, b), sep };
    }
    m = DMONY_RE.exec(s);
    if (m) {
        const mon = MONTHS[m[2].toLowerCase()];
        if (!mon) return null;
        let y = +m[3];
        if (m[3].length === 2) y += 2000;
        const t = ymd(y, mon, +m[1]);
        return { family: 'd-Mon-yyyy', dmy: t, mdy: t };
    }
    m = MONDY_RE.exec(s);
    if (m) {
        const mon = MONTHS[m[1].toLowerCase()];
        if (!mon) return null;
        const t = ymd(+m[3], mon, +m[2]);
        return { family: 'Mon d, yyyy', dmy: t, mdy: t };
    }
    m = MONY_RE.exec(s);
    if (m) {
        const mon = MONTHS[m[1].toLowerCase()];
        if (!mon) return null;
        let y = +m[2];
        if (m[2].length === 2) y += 2000;
        const t = ymd(y, mon, 1);
        return { family: 'Mon-yyyy', dmy: t, mdy: t };
    }
    m = YYYYMM_RE.exec(s);
    if (m) {
        const t = ymd(+m[1], +m[2], 1);
        return { family: 'yyyymm', dmy: t, mdy: t, monthOnly: true };
    }
    m = YYYYMMDD_RE.exec(s);
    if (m) {
        const t = ymd(+(m[1] + m[2]), +m[3], +m[4]);
        return { family: 'yyyymmdd', dmy: t, mdy: t };
    }
    return null;
}

/** Excel / Sheets serial day number (1955..2100) as epoch ms, else null. */
function excelSerial(v) {
    const n = typeof v === 'number' ? v : parseNumber(String(v));
    if (n === null || n < 20000 || n > 73051) return null;
    return Math.round((n - 25569) * 86400000);
}

function isoDay(ms) {
    return ms === null || ms === undefined || !Number.isFinite(ms) ? '' : new Date(ms).toISOString().slice(0, 10);
}

function isBlank(v) {
    return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function asText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

module.exports = {
    NUM_RE, PLACEHOLDER_RE, SHEET_ERROR_RE, parseNumber, looseNumber, classifyDate, excelSerial, isoDay, isBlank, asText
};
