'use strict';
// Masking for issue samples. Samples are shown in the admin portal and copied into docs, so
// secrets and personal values never appear in them:
//   secret columns (PIN, password, token, …)          → "***"
//   contact / bank / identity columns (phone, email, IFSC, account, PAN, Aadhaar, PF) → "***"
//   person names and addresses                         → first letter + "***"
//   consumer / application / meter / employee ids      → first 2 and last 2 characters kept
// Office names and codes, dates, amounts, materials and statuses stay readable: they are what
// the sheet owner needs to find and fix the row. Values that look like a phone number, an
// e-mail, a JWT or a hash are masked in any column.

const SECRET_COL = /(^|[^a-z])(pin|pins|password|passwd|pwd|passcode|token|secret|apikey|api_key|otp|hash|salt|session)([^a-z]|$)/i;
const CONTACT_COL = /(mobile|mob_no|mob no|phone|telephone|cug|e-?mail|ifsc|bank|account no|acc(oun)?t?_?no|a\/c|pf a\/c|pf trust|pf_|\bpan\b|aadha+r|uid|gender|salary|pay\b|allowance|grade pay|payscale)/i;
const ADDRESS_COL = /(address|addr\d?|street|postl code|pin_code|pin code|mouza|plot no|location \(plot)/i;
const OFFICE_WORDS = /(ccc|office|unit|division|divn|div_|region|circle|zone|substation|ss_|feeder|fdr|loc_|vendor|agency|project|scheme|awc|centre|center|cctr|material|plant|store|block|gp\/|district|police|make|stage|status|category|model|discom|ulb|panchayat|sub-division|org_|voltage|from_|to_|parent_|tapped|equipment|file|sheet|label|description|desc)/i;
const PERSON_COL = /(^|[^a-z])(f|l|first|last|party|con|consumer|applicant|victim|owner|employee|father|husband|inspector|insp)?[ _]?name([^a-z]|$)|name of victim|name of owner|^name$|suggested_by|created_by|cancelled_by|visit by|inspection by|rectification done by|sample collected by|uploaded_by|^username$|^user$|^by$/i;
const ID_COL = /(con_?id|cons_?id|consumer[ _]?(id|no|number)|consumer_id|appl_?no|application[ _]?(no|number|id)|registration number|solar_appl_no|inst_?no|install no|meter[ _]?(no|number|sno)|new_meter_no|old_meter_no|gen_meter|con_meter|serial|employee no|legacy id|cont\.account|victim id|ds_number|provsnl bill no|final print doc no|acc_id|parent_account|gis_id|census_code)/i;

const PHONE_RE = /^(\+?91[-\s]?)?[6-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function partial(s) {
    if (s.length <= 4) return '*'.repeat(s.length);
    return s.slice(0, 2) + '*'.repeat(Math.min(6, s.length - 4)) + s.slice(-2);
}

/** Masking rule for a column name: 'secret' | 'contact' | 'address' | 'person' | 'id' | ''. */
function columnRule(col) {
    const c = String(col || '');
    if (/^name 1$/i.test(c)) return ''; // SAP plant name
    if (SECRET_COL.test(c)) return 'secret';
    if (CONTACT_COL.test(c)) return 'contact';
    if (ADDRESS_COL.test(c)) return 'address';
    if (PERSON_COL.test(c) && !OFFICE_WORDS.test(c.replace(/name/i, ''))) return 'person';
    if (ID_COL.test(c)) return 'id';
    return '';
}

/** Mask one value for a sample. */
function maskValue(col, v, rule) {
    if (v === null || v === undefined || v === '') return v === undefined ? '' : v;
    const r = rule === undefined ? columnRule(col) : rule;
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (r === 'secret' || r === 'contact' || r === 'address') return '***';
    if (r === 'person') return s.trim().slice(0, 1).toUpperCase() + '***';
    if (r === 'id') return partial(s.trim());
    const t = s.trim();
    if (PHONE_RE.test(t.replace(/[\s-]/g, '')) && !/^66[123]\d{4}$/.test(t)) return '***';
    if (EMAIL_RE.test(t)) return '***';
    if (/^\d{4}\s?\d{4}\s?\d{4}$/.test(t)) return '***'; // Aadhaar-shaped
    if (/^[A-Z]{5}\d{4}[A-Z]$/i.test(t)) return '***'; // PAN-shaped
    if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(t)) return '<jwt>';
    if (/^scrypt\$/.test(t)) return '<hash>';
    if (/^[A-Fa-f0-9]{32,}$/.test(t)) return '<hex>';
    if (s.length > 80) s = s.slice(0, 77) + '...';
    return s;
}

/** Mask a few cells of a row: { column: value } for the given columns only. */
function maskCells(header, values, indexes) {
    const out = {};
    for (const i of indexes) {
        const name = header[i] || `#${i + 1}`;
        out[name] = maskValue(name, values[i]);
    }
    return out;
}

// Sample fields that are positions or counts, never data.
const META_KEYS = new Set(['row', 'first_row', 'same_as_row', 'rows', 'count', 'users', 'robust_z', 'age_days', 'expected_within_days',
    'max_age_days', 'values', 'difference', 'diff', 'ambiguous_rows', 'cell_row', 'storage_only', 'google_sheet_only', 'level',
    'format', 'reads_as', 'what', 'metric', 'change', 'from', 'to', 'header', 'columns', 'could_be', 'means', 'code_is',
    'ccc_belongs_to', 'division_belongs_to', 'as_on', 'shown_as_on', 'latest_row_date', 'date', 'summary_total', 'details_rows',
    'summary', 'details', 'storage', 'google_sheet', 'meta_json', 'csv', 'compared_with', 'pending_nsc_as_on', 'withheld_as_on', 'appl_no',
    'name', 'column', 'header', 'at']);

/** Mask every data value in an issue sample (values under "value" use the issue's column rule). */
function sanitizeSample(sample, column) {
    const walk = (x, key) => {
        if (x === null || x === undefined) return x;
        if (Array.isArray(x)) return x.map((y) => walk(y, key));
        if (typeof x === 'object') {
            const out = {};
            for (const k of Object.keys(x)) out[k] = META_KEYS.has(k) ? x[k] : walk(x[k], k === 'value' || k === 'example' ? column : k);
            return out;
        }
        if (typeof x === 'number' && Math.abs(x) < 1e9) return x;
        const m = maskValue(key || '', x);
        return typeof x === 'number' && m === String(x) ? x : m;
    };
    return walk(sample, column);
}

module.exports = { columnRule, maskValue, maskCells, partial, sanitizeSample };
