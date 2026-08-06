/**
 * NSC raw workbook → dashboard CSV pipeline
 * Matches the manual Google Sheet cleanup used by CACHE_NSC.
 */

const XLSX = require('xlsx');
const { resolveDivnFromOffice } = require('./nsc_office_map');

const NSC_PUBLISH_STATUSES = new Set(['working', 'accepted']);

/** Alternate Excel / SheetJS header spellings → canonical OUTPUT column names */
const HEADER_ALIASES = {
    'DIVN NAME': 'DIVN_NAME',
    DIVN: 'DIVN_NAME',
    DIVISION: 'DIVN_NAME',
    DIV_NAME: 'DIVN_NAME',
    'DIVISION NAME': 'DIVN_NAME',
    'SUPP OFF': 'SUPP_OFF',
    'SUPPLY OFFICE': 'SUPP_OFF',
    CCC: 'SUPP_OFF',
    'CCC NAME': 'SUPP_OFF',
    'CCC CODE': 'CCC_CODE',
    REGION_NAME: 'REG',
    'SCN STATUS': 'SCN_STATUS',
    STATUS: 'SCN_STATUS'
};

const OUTPUT_COLUMNS = [
    'REG', 'DIVN_NAME', 'SUPP_OFF', 'CCC_CODE', 'APPL_NO', 'CREATION_DATE', 'CON_ID',
    'NAME', 'PHONE_NO', 'ADDRESS', 'APPLICANT_TYPE', 'LOAD_WATTS', 'APPLIED_PHASE',
    'CONN_CLASS', 'CONN_CAT', 'INSPECTION_DATE', 'NO_OF_POLES', 'CONN_TYPE',
    'INSPECTION_DISPUTE_REASON', 'INSPECTION_COMMENT', 'TURN_KEY', 'QUOTATION_ISSUE_DATE',
    'COLL_DATE', 'WO_ISSUED', 'WON', 'WO_CREATION_DATE', 'AGENCY_NAME', 'METER_NUMBER',
    'SCN_STATUS', 'SCN_WITHELD_DATE', 'SCN_WITHELD_REASON', 'IS_DUARE_SARKAR', 'DS_NUMBER',
    'DS_FORM_DATE', 'IS_PORTAL_APPL', 'REGION', 'TODAY', 'DelayInWO', 'DelayInSC',
    'DelayInQtn', 'DelayRange', 'DelaySerial', 'PoleNonPole'
];

const REGION_FROM_REG = {
    'MALDA REGION': 'Malda',
    'UTTAR DINAJPUR REGION': 'Uttar Dinajpur',
    'DAKSHIN DINAJPUR REGION': 'Dakshin Dinajpur'
};

const DIVN_ALIASES = {
    'MALDA DIVISIOIN': 'Malda',
    'MALDA DIVISION': 'Malda',
    'RAIGANJ (D) DIVISION': 'Raiganj',
    'RAIGANJ DIVISION': 'Raiganj',
    'CHANCHAL DIVISION': 'Chanchal',
    'GAZOLE DIVISION': 'Gazole',
    'BUNIADPUR DIVISION': 'Buniadpur',
    'ISLAMPUR DIVISION': 'Islampur',
    'BALURGHAT DIVISION': 'Balurghat'
};

function excelSerialToDate(serial) {
    if (serial == null || serial === '') return null;
    if (serial instanceof Date && !isNaN(serial.getTime())) return serial;
    if (typeof serial === 'number' && isFinite(serial)) {
        // Excel epoch (with 1900 leap-year bug)
        const utc = Date.UTC(1899, 11, 30) + Math.round(serial * 86400000);
        return new Date(utc);
    }
    const s = String(serial).trim();
    if (!s) return null;
    const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) {
        let dd = parseInt(m[1], 10);
        let mm = parseInt(m[2], 10);
        let yy = parseInt(m[3], 10);
        if (yy < 100) yy += 2000;
        const d = new Date(yy, mm - 1, dd);
        return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

function formatDateDMY(d) {
    if (!d) return '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
}

function dayDiff(a, b) {
    if (!a || !b) return '';
    const ms = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()) -
        Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return String(Math.round(ms / 86400000));
}

function delayBucket(delaySc) {
    const n = parseFloat(delaySc);
    if (!isFinite(n) || n < 0) return { DelayRange: '', DelaySerial: '' };
    if (n <= 3) return { DelayRange: '0-3 Day', DelaySerial: '1' };
    if (n <= 7) return { DelayRange: '4-7 Day', DelaySerial: '2' };
    if (n <= 15) return { DelayRange: '8-15 Day', DelaySerial: '3' };
    if (n <= 30) return { DelayRange: '16-30 Day', DelaySerial: '4' };
    if (n <= 60) return { DelayRange: '1-2 Months', DelaySerial: '5' };
    if (n <= 180) return { DelayRange: '2-6 Months', DelaySerial: '6' };
    if (n <= 365) return { DelayRange: '6-12 Months', DelaySerial: '7' };
    return { DelayRange: '>1 Year', DelaySerial: '8' };
}

function normalizeDivn(name) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    const key = raw.replace(/\s+/g, ' ').toUpperCase();
    if (DIVN_ALIASES[key]) return DIVN_ALIASES[key];
    let cleaned = raw.replace(/\s*\(D\)\s*/i, ' ').replace(/\s+DIVISIOIN\s*$/i, '')
        .replace(/\s+DIVISION\s*$/i, '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return raw;
    return cleaned.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeRegion(reg) {
    const key = String(reg || '').trim().toUpperCase();
    if (REGION_FROM_REG[key]) return REGION_FROM_REG[key];
    if (!key) return '';
    return key.replace(/\s+REGION$/i, '')
        .split(/\s+/)
        .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
        .join(' ');
}

function cellStr(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date) return formatDateDMY(v);
    const s = String(v).trim();
    if (!s || /^\(?null\)?$/i.test(s) || s.toLowerCase() === 'undefined' || s.toLowerCase() === 'nan') {
        return '';
    }
    return s;
}

function normalizeSuppOff(name) {
    let s = cellStr(name);
    if (!s) return '';
    s = s.replace(/\s+CCC\s*$/i, '').replace(/\s+/g, ' ').trim();
    // Title-ish case for ALL CAPS office names
    if (s === s.toUpperCase() && /[A-Z]/.test(s)) {
        s = s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return s;
}

function pickSheetName(workbook) {
    const names = workbook.SheetNames || [];
    const preferred = names.find((n) => /malda\s*pnsc/i.test(n));
    if (preferred) return preferred;
    const details = names.find((n) => /^details$/i.test(n));
    if (details) return details;
    const dataLike = names.find((n) => !/^sheet\d+$/i.test(n) && !/summary/i.test(n));
    return dataLike || names[0];
}

function canonicalizeRow(row) {
    if (!row || typeof row !== 'object') return row;
    const out = {};
    for (const [k, v] of Object.entries(row)) {
        const trimmed = String(k || '').replace(/^\uFEFF/, '').trim();
        const upper = trimmed.replace(/\s+/g, ' ').toUpperCase();
        const canon = HEADER_ALIASES[upper] || trimmed;
        if (!(canon in out) || out[canon] === '' || out[canon] == null) {
            out[canon] = v;
        }
    }
    return out;
}

/** Sheet1-style office master: CODE, REGION, DIVISION, CCC */
function officeMapFromWorkbook(workbook) {
    const byCode = {};
    const bySupp = {};
    const names = workbook.SheetNames || [];
    for (const name of names) {
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: '', raw: false });
        if (!rows.length) continue;
        const keys = Object.keys(rows[0]).map((k) => String(k).trim().toUpperCase());
        const hasCode = keys.some((k) => k === 'CODE' || k === 'CCC_CODE');
        const hasDiv = keys.some((k) => k === 'DIVISION' || k === 'DIVN_NAME');
        const hasCcc = keys.some((k) => k === 'CCC' || k === 'SUPP_OFF');
        if (!hasCode || !hasDiv || !hasCcc) continue;
        if (rows.length > 500) continue; // detail dump, not master
        for (const raw of rows) {
            const r = canonicalizeRow(raw);
            const code = cellStr(r.CODE || r.CCC_CODE);
            const div = normalizeDivn(r.DIVISION || r.DIVN_NAME);
            const supp = normalizeSuppOff(r.CCC || r.SUPP_OFF);
            if (code && div) byCode[code] = div;
            if (supp && div) bySupp[supp] = div;
        }
    }
    return { byCode, bySupp };
}

function resolveDivnName(raw, workbookOfficeMap) {
    const direct = normalizeDivn(
        raw.DIVN_NAME || raw.DIVISION || raw.DIVN || raw['DIVN NAME'] || ''
    );
    if (direct) return direct;
    const code = cellStr(raw.CCC_CODE || raw.CODE);
    const supp = normalizeSuppOff(raw.SUPP_OFF || raw.CCC);
    if (workbookOfficeMap) {
        if (code && workbookOfficeMap.byCode[code]) return workbookOfficeMap.byCode[code];
        if (supp && workbookOfficeMap.bySupp[supp]) return workbookOfficeMap.bySupp[supp];
    }
    return resolveDivnFromOffice(code, supp);
}

function parseReportDateFromName(filename) {
    const m = String(filename || '').match(/(\d{2})[-_.](\d{2})[-_.](\d{4})/);
    if (!m) return null;
    const d = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
    return isNaN(d.getTime()) ? null : d;
}

function rowsFromWorkbook(buffer, originalName) {
    const workbook = XLSX.read(buffer, {
        type: 'buffer',
        cellDates: true,
        raw: false
    });
    const sheetName = pickSheetName(workbook);
    if (!sheetName) throw new Error('No worksheet found in workbook.');
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false }).map(canonicalizeRow);
    const officeMap = officeMapFromWorkbook(workbook);
    return { sheetName, rows, officeMap, reportDate: parseReportDateFromName(originalName) };
}

function transformRows(rawRows, reportDate, workbookOfficeMap) {
    const today = reportDate || new Date();
    const todayStr = formatDateDMY(today);
    const published = [];
    const withheld = [];
    const statusCounts = {};
    const regionCounts = {};

    for (const rawIn of rawRows) {
        const raw = canonicalizeRow(rawIn);
        const status = cellStr(raw.SCN_STATUS);
        const statusKey = status.toLowerCase();
        statusCounts[status || '(blank)'] = (statusCounts[status || '(blank)'] || 0) + 1;

        const reg = cellStr(raw.REG);
        const region = normalizeRegion(reg);
        regionCounts[region || '(blank)'] = (regionCounts[region || '(blank)'] || 0) + 1;

        const coll = excelSerialToDate(raw.COLL_DATE);
        const wo = excelSerialToDate(raw.WO_CREATION_DATE);
        const qtn = excelSerialToDate(raw.QUOTATION_ISSUE_DATE);
        const created = excelSerialToDate(raw.CREATION_DATE);
        const insp = excelSerialToDate(raw.INSPECTION_DATE);
        const withheldDate = excelSerialToDate(raw.SCN_WITHELD_DATE);
        const dsForm = excelSerialToDate(raw.DS_FORM_DATE);

        const delaySc = coll ? dayDiff(today, coll) : '';
        const delayWo = (wo && coll) ? dayDiff(wo, coll) : '';
        const delayQtn = (qtn && created) ? dayDiff(qtn, created) : '';
        const bucket = delayBucket(delaySc);
        const poles = cellStr(raw.NO_OF_POLES);
        const poleNum = parseInt(poles, 10);
        const poleNonPole = (poles !== '' && !isNaN(poleNum) && poleNum > 0)
            ? 'Pole Case'
            : 'Non Pole Case';

        const row = {
            REG: reg,
            DIVN_NAME: resolveDivnName(raw, workbookOfficeMap),
            SUPP_OFF: normalizeSuppOff(raw.SUPP_OFF),
            CCC_CODE: cellStr(raw.CCC_CODE),
            APPL_NO: cellStr(raw.APPL_NO),
            CREATION_DATE: formatDateDMY(created) || cellStr(raw.CREATION_DATE),
            CON_ID: cellStr(raw.CON_ID),
            NAME: cellStr(raw.NAME),
            PHONE_NO: cellStr(raw.PHONE_NO),
            ADDRESS: cellStr(raw.ADDRESS),
            APPLICANT_TYPE: cellStr(raw.APPLICANT_TYPE),
            LOAD_WATTS: cellStr(raw.LOAD_WATTS),
            APPLIED_PHASE: cellStr(raw.APPLIED_PHASE),
            CONN_CLASS: cellStr(raw.CONN_CLASS),
            CONN_CAT: cellStr(raw.CONN_CAT),
            INSPECTION_DATE: formatDateDMY(insp) || cellStr(raw.INSPECTION_DATE),
            NO_OF_POLES: poles,
            CONN_TYPE: cellStr(raw.CONN_TYPE),
            INSPECTION_DISPUTE_REASON: cellStr(raw.INSPECTION_DISPUTE_REASON),
            INSPECTION_COMMENT: cellStr(raw.INSPECTION_COMMENT),
            TURN_KEY: cellStr(raw.TURN_KEY),
            QUOTATION_ISSUE_DATE: formatDateDMY(qtn) || cellStr(raw.QUOTATION_ISSUE_DATE),
            COLL_DATE: formatDateDMY(coll) || cellStr(raw.COLL_DATE),
            WO_ISSUED: cellStr(raw.WO_ISSUED),
            WON: cellStr(raw.WON),
            WO_CREATION_DATE: formatDateDMY(wo) || cellStr(raw.WO_CREATION_DATE),
            AGENCY_NAME: cellStr(raw.AGENCY_NAME),
            METER_NUMBER: cellStr(raw.METER_NUMBER),
            SCN_STATUS: status,
            SCN_WITHELD_DATE: formatDateDMY(withheldDate) || cellStr(raw.SCN_WITHELD_DATE),
            SCN_WITHELD_REASON: cellStr(raw.SCN_WITHELD_REASON),
            IS_DUARE_SARKAR: cellStr(raw.IS_DUARE_SARKAR),
            DS_NUMBER: cellStr(raw.DS_NUMBER),
            DS_FORM_DATE: formatDateDMY(dsForm) || cellStr(raw.DS_FORM_DATE),
            IS_PORTAL_APPL: cellStr(raw.IS_PORTAL_APPL),
            REGION: region,
            TODAY: todayStr,
            DelayInWO: delayWo,
            DelayInSC: delaySc,
            DelayInQtn: delayQtn,
            DelayRange: bucket.DelayRange,
            DelaySerial: bucket.DelaySerial,
            PoleNonPole: poleNonPole
        };

        if (NSC_PUBLISH_STATUSES.has(statusKey)) {
            published.push(row);
        } else if (statusKey === 'witheld' || statusKey === 'withheld') {
            withheld.push(row);
        }
    }

    return {
        published,
        withheld,
        stats: {
            rawRows: rawRows.length,
            publishedRows: published.length,
            withheldRows: withheld.length,
            statusCounts,
            regionCounts,
            today: todayStr
        }
    };
}

function toCsv(rows) {
    const header = OUTPUT_COLUMNS.join(',');
    const lines = rows.map((row) => OUTPUT_COLUMNS.map((col) => {
        const val = String(row[col] == null ? '' : row[col]);
        if (/[",\n\r]/.test(val)) return `"${val.replace(/"/g, '""')}"`;
        return val;
    }).join(','));
    return [header, ...lines].join('\n');
}

function outputColToDbKey(col) {
    return String(col)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/__/g, '_')
        .toLowerCase();
}

const DB_KEYS = OUTPUT_COLUMNS.map(outputColToDbKey);

function dashboardRowToDb(row, uploadId) {
    const out = { upload_id: uploadId };
    for (let i = 0; i < OUTPUT_COLUMNS.length; i++) {
        const v = row[OUTPUT_COLUMNS[i]];
        out[DB_KEYS[i]] = v == null ? '' : String(v);
    }
    return out;
}

function dbRowToDashboard(row) {
    const out = {};
    for (let i = 0; i < OUTPUT_COLUMNS.length; i++) {
        const v = row[DB_KEYS[i]];
        out[OUTPUT_COLUMNS[i]] = v == null ? '' : String(v);
    }
    // Live uploads sometimes store blank divn_name; recover from CCC office master.
    if (!String(out.DIVN_NAME || '').trim()) {
        out.DIVN_NAME = resolveDivnFromOffice(out.CCC_CODE, out.SUPP_OFF);
    }
    return out;
}

function dbRowsToCsv(dbRows) {
    return toCsv((dbRows || []).map(dbRowToDashboard));
}

function processNscWorkbook(buffer, originalName, options = {}) {
    const { sheetName, rows, officeMap, reportDate: nameDate } = rowsFromWorkbook(buffer, originalName);
    if (!rows.length) {
        throw new Error(`Sheet "${sheetName}" has no data rows.`);
    }
    if (!Object.prototype.hasOwnProperty.call(rows[0], 'SCN_STATUS') &&
        !Object.prototype.hasOwnProperty.call(rows[0], 'APPL_NO')) {
        throw new Error(`Sheet "${sheetName}" does not look like an NSC dump (missing APPL_NO / SCN_STATUS).`);
    }

    let reportDate = null;
    if (options.reportDate) {
        reportDate = parseManualReportDate(options.reportDate);
        if (!reportDate) {
            throw new Error('Invalid report date. Use YYYY-MM-DD or DD/MM/YYYY.');
        }
    } else {
        reportDate = nameDate || new Date();
    }

    const result = transformRows(rows, reportDate, officeMap);
    return {
        sheetName,
        ...result,
        csv: toCsv(result.published),
        reportDateUsed: formatDateDMY(reportDate)
    };
}

/** Accept YYYY-MM-DD (HTML date) or DD/MM/YYYY */
function parseManualReportDate(raw) {
    if (raw instanceof Date && !isNaN(raw.getTime())) return raw;
    const s = String(raw || '').trim();
    if (!s) return null;
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) {
        const d = new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
        return isNaN(d.getTime()) ? null : d;
    }
    return excelSerialToDate(s);
}

/** Parse cleaned dashboard CSV (from browser publish) back into row objects. */
function publishedFromCsv(csvText) {
    const text = String(csvText || '').trim();
    if (!text) return [];
    const workbook = XLSX.read(text, { type: 'string', raw: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];
    return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: false }).map((raw) => {
        const row = canonicalizeRow(raw);
        if (!String(row.DIVN_NAME || '').trim()) {
            row.DIVN_NAME = resolveDivnFromOffice(row.CCC_CODE, row.SUPP_OFF);
        } else {
            row.DIVN_NAME = normalizeDivn(row.DIVN_NAME);
        }
        if (row.SUPP_OFF) row.SUPP_OFF = normalizeSuppOff(row.SUPP_OFF);
        if (row.REG && !row.REGION) row.REGION = normalizeRegion(row.REG);
        return row;
    });
}

module.exports = {
    processNscWorkbook,
    parseManualReportDate,
    OUTPUT_COLUMNS,
    NSC_PUBLISH_STATUSES,
    toCsv,
    publishedFromCsv,
    dashboardRowToDb,
    dbRowToDashboard,
    dbRowsToCsv,
    DB_KEYS
};
