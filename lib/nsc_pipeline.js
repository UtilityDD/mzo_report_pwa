'use strict';
/**
 * lib/nsc_pipeline.js — Pending NSC / Withheld clean + slim + viz (server only; PRIVATE_PATH).
 * Pure helpers shared by lib/nsc_routes.js. Browser twin: nsc/nsc_client_pipeline.js.
 *
 *   transformRows(rawRows, reportDate) -> { published, withheld, stats }
 *   slimWorking(rows) / slimWithheld(rows)
 *   buildViz(rows, kind)               -> office aggregates for KPI / trend
 *   review(payload, currentMeta)       -> { blocks, warnings, notes, summary }
 *   toCsv / readCsvRows
 */
const crypto = require('crypto');
const MzoOffices = require('./offices');

const NSC_PUBLISH_STATUSES = new Set(['working', 'accepted']);

/** When REG is blank, fill region from known division names (same hierarchy as mzo_scope). */
const DIVN_TO_REGION = {
  Malda: 'Malda', Chanchal: 'Malda', Gazole: 'Malda',
  Raiganj: 'Uttar Dinajpur', Islampur: 'Uttar Dinajpur',
  Balurghat: 'Dakshin Dinajpur', Buniadpur: 'Dakshin Dinajpur'
};

function resolveOfficeMeta(code, region, division, supp) {
  let r = String(region || '').trim();
  let d = String(division || '').trim();
  let s = String(supp || '').trim();
  let c = String(code || '').replace(/\D/g, '').slice(-7);
  try {
    const got = MzoOffices.resolve({
      codes: c ? [c] : [],
      cccs: s ? [s] : [],
      divisions: d ? [d] : [],
      regions: r ? [r] : []
    });
    const office = got && got.office;
    if (office && office.region && office.level !== 'outside' && office.level !== 'unknown') {
      r = office.region || r;
      d = office.division || d;
      s = office.ccc || s;
      if (office.ccc_code) c = office.ccc_code;
    }
  } catch (_) { /* keep raw */ }
  if (!r && d && DIVN_TO_REGION[d]) r = DIVN_TO_REGION[d];
  return { code: c || 'unknown', region: r, division: d, supp: s };
}

/** Columns kept on the VM for Pending NSC (drawer + KPIs). Full SAP dump is not stored. */
const SLIM_WORKING_COLUMNS = [
  'REGION', 'DIVN_NAME', 'SUPP_OFF', 'CCC_CODE', 'APPL_NO', 'CON_ID',
  'NAME', 'PHONE_NO', 'ADDRESS', 'APPLICANT_TYPE', 'LOAD_WATTS', 'APPLIED_PHASE',
  'CONN_CLASS', 'CONN_CAT', 'NO_OF_POLES', 'COLL_DATE', 'WO_ISSUED', 'WON',
  'WO_CREATION_DATE', 'AGENCY_NAME', 'METER_NUMBER', 'SCN_STATUS',
  'SCN_WITHELD_DATE', 'SCN_WITHELD_REASON', 'IS_PORTAL_APPL', 'INSPECTION_COMMENT',
  'TODAY', 'DelayInWO', 'DelayInSC', 'DelayInQtn', 'DelayRange', 'DelaySerial', 'PoleNonPole'
];

const WITHHELD_COLUMNS = [
  'REGION', 'DIVN_NAME', 'SUPP_OFF', 'CCC_CODE', 'APPL_NO', 'NAME', 'PHONE_NO',
  'CONN_CLASS', 'APPLIED_PHASE', 'COLL_DATE', 'SCN_WITHELD_DATE', 'SCN_WITHELD_REASON',
  'IS_PORTAL_APPL', 'TODAY'
];

const LIMITS = {
  maxBytes: 50 * 1024 * 1024,
  maxWorkingRows: 30000,
  maxWithheldRows: 150000,
  maxCombinedRows: 200000,
  dropShare: 0.30,
  titleDays: 2
};

const REGION_FROM_REG = {
  'MALDA REGION': 'Malda',
  'UTTAR DINAJPUR REGION': 'Uttar Dinajpur',
  'DAKSHIN DINAJPUR REGION': 'Dakshin Dinajpur'
};
const DIVN_ALIASES = {
  'MALDA DIVISIOIN': 'Malda', 'MALDA DIVISION': 'Malda',
  'RAIGANJ (D) DIVISION': 'Raiganj', 'RAIGANJ DIVISION': 'Raiganj',
  'CHANCHAL DIVISION': 'Chanchal', 'GAZOLE DIVISION': 'Gazole',
  'BUNIADPUR DIVISION': 'Buniadpur', 'ISLAMPUR DIVISION': 'Islampur',
  'BALURGHAT DIVISION': 'Balurghat'
};

/** Canonical Malda Zone divisions — used to warn when a dump has none for a division. */
const EXPECTED_DIVISIONS = [
  'Malda', 'Chanchal', 'Gazole', 'Raiganj', 'Islampur', 'Balurghat', 'Buniadpur'
];
const OFFICE_BY_CODE = {
  '6611101': 'Malda', '6611102': 'Malda', '6611103': 'Malda', '6611104': 'Malda',
  '6611105': 'Malda', '6611106': 'Malda', '6611107': 'Malda', '6611108': 'Malda', '6611109': 'Malda',
  '6612101': 'Chanchal', '6612102': 'Chanchal', '6612103': 'Chanchal', '6612104': 'Chanchal',
  '6612105': 'Chanchal', '6612106': 'Chanchal', '6612107': 'Chanchal',
  '6613101': 'Gazole', '6613102': 'Gazole', '6613103': 'Gazole', '6613104': 'Gazole', '6613105': 'Gazole',
  '6621101': 'Raiganj', '6621102': 'Raiganj', '6621103': 'Raiganj', '6621104': 'Raiganj',
  '6621105': 'Raiganj', '6621106': 'Raiganj',
  '6622101': 'Islampur', '6622102': 'Islampur', '6622103': 'Islampur', '6622104': 'Islampur', '6622105': 'Islampur',
  '6631101': 'Balurghat', '6631102': 'Balurghat', '6631103': 'Balurghat', '6631104': 'Balurghat', '6631105': 'Balurghat',
  '6632101': 'Buniadpur', '6632102': 'Buniadpur', '6632103': 'Buniadpur', '6632104': 'Buniadpur'
};
const OFFICE_BY_SUPP = {
  Manikchak: 'Malda', Golapganj: 'Malda', Baishnabnagar: 'Malda', Kaliachak: 'Malda',
  Mothabari: 'Malda', Sujapur: 'Malda', Rathbari: 'Malda', Fulbari: 'Malda', Mokdumpur: 'Malda',
  Bhaluka: 'Chanchal', Samsi: 'Chanchal', Paranpur: 'Chanchal', Chanchal: 'Chanchal',
  Malatipur: 'Chanchal', Harishchandrapur: 'Chanchal', Kushida: 'Chanchal',
  Gazol: 'Gazole', Aiho: 'Gazole', Pandua: 'Gazole', Bamongola: 'Gazole', 'Old Malda': 'Gazole',
  Itahar: 'Raiganj', Hemtabad: 'Raiganj', Kaliyaganj: 'Raiganj', Raiganj: 'Raiganj',
  Birnagar: 'Raiganj', Karandighi: 'Raiganj',
  Islampur: 'Islampur', Chopra: 'Islampur', Dalkhola: 'Islampur', Goalpokher: 'Islampur', Kanki: 'Islampur',
  Balurghat: 'Balurghat', Tapan: 'Balurghat', Kumarganj: 'Balurghat', Hili: 'Balurghat', Patiram: 'Balurghat',
  Buniadpur: 'Buniadpur', Kusmandi: 'Buniadpur', Harirampur: 'Buniadpur', Gangarampur: 'Buniadpur'
};
const HEADER_ALIASES = {
  'DIVN NAME': 'DIVN_NAME', DIVN: 'DIVN_NAME', DIVISION: 'DIVN_NAME', DIV_NAME: 'DIVN_NAME',
  'DIVISION NAME': 'DIVN_NAME', DIVI: 'DIVN_NAME', 'SUPP OFF': 'SUPP_OFF', 'SUPPLY OFFICE': 'SUPP_OFF',
  CCC: 'SUPP_OFF', 'CCC NAME': 'SUPP_OFF', 'CCC CODE': 'CCC_CODE',
  REGION_NAME: 'REG', 'SCN STATUS': 'SCN_STATUS', STATUS: 'SCN_STATUS',
  SCN_WITHHELD_DATE: 'SCN_WITHELD_DATE', 'SCN WITHHELD DATE': 'SCN_WITHELD_DATE',
  SCN_WITHHELD_REASON: 'SCN_WITHELD_REASON', 'SCN WITHHELD REASON': 'SCN_WITHELD_REASON'
};

const pad = (n) => String(n).padStart(2, '0');
const fmt = (n) => Number(n).toLocaleString('en-IN');

function excelSerialToDate(serial) {
  if (serial == null || serial === '') return null;
  if (serial instanceof Date && !isNaN(serial.getTime())) return serial;
  if (typeof serial === 'number' && isFinite(serial)) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
  }
  const s = String(serial).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let dd = parseInt(m[1], 10), mm = parseInt(m[2], 10), yy = parseInt(m[3], 10);
    if (yy < 100) yy += 2000;
    const d = new Date(yy, mm - 1, dd);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function formatDateDMY(d) {
  if (!d) return '';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
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
  return key.replace(/\s+REGION$/i, '').split(/\s+/)
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
}

function cellStr(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return formatDateDMY(v);
  const s = String(v).trim();
  if (!s || /^\(?null\)?$/i.test(s) || s.toLowerCase() === 'undefined' || s.toLowerCase() === 'nan') return '';
  return s;
}

function withheldStatusKey(statusKey) {
  const s = String(statusKey || '').toLowerCase().replace(/[\s_-]+/g, '');
  return s === 'witheld' || s === 'withheld' || s === 'scnwithheld';
}

function normalizeSuppOff(name) {
  let s = cellStr(name);
  if (!s) return '';
  s = s.replace(/\s+CCC\s*$/i, '').replace(/\s+/g, ' ').trim();
  if (s === s.toUpperCase() && /[A-Z]/.test(s)) {
    s = s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return s;
}

function canonicalizeRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const k of Object.keys(row)) {
    const trimmed = String(k || '').replace(/^\uFEFF/, '').trim();
    const upper = trimmed.replace(/\s+/g, ' ').toUpperCase();
    const canon = HEADER_ALIASES[upper] || trimmed;
    if (!(canon in out) || out[canon] === '' || out[canon] == null) out[canon] = row[k];
  }
  return out;
}

function resolveDivnName(raw) {
  const direct = normalizeDivn(raw.DIVN_NAME || raw.DIVISION || raw.DIVN || raw.DIVI || '');
  if (direct) return direct;
  const code = cellStr(raw.CCC_CODE || raw.CODE);
  const supp = normalizeSuppOff(raw.SUPP_OFF || raw.CCC);
  if (code && OFFICE_BY_CODE[code]) return OFFICE_BY_CODE[code];
  if (supp && OFFICE_BY_SUPP[supp]) return OFFICE_BY_SUPP[supp];
  return '';
}

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

/** dd/mm/yyyy or yyyy-mm-dd → yyyy-mm-dd */
function reportDateKey(label) {
  const s = String(label || '').trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (dmy) return `${dmy[3]}-${pad(dmy[2])}-${pad(dmy[1])}`;
  const d = parseManualReportDate(s);
  if (!d) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function transformRows(rawRows, reportDate) {
  const today = reportDate || new Date();
  const todayStr = formatDateDMY(today);
  const publishedByAppl = new Map();
  const withheldByAppl = new Map();
  const statusCounts = {};
  const regionCounts = {};
  let skippedDup = 0;
  let skippedBlank = 0;
  let unmappedDiv = 0;

  for (let i = 0; i < rawRows.length; i++) {
    const raw = canonicalizeRow(rawRows[i]);
    const status = cellStr(raw.SCN_STATUS);
    const statusKey = status.toLowerCase();
    statusCounts[status || '(blank)'] = (statusCounts[status || '(blank)'] || 0) + 1;

    const reg = cellStr(raw.REG);
    const divn = resolveDivnName(raw);
    if (!divn) unmappedDiv += 1;
    const supp = normalizeSuppOff(raw.SUPP_OFF);
    const ccc = cellStr(raw.CCC_CODE);
    let region = normalizeRegion(reg) || normalizeRegion(raw.REGION);
    if (!region) {
      region = resolveOfficeMeta(ccc, '', divn, supp).region || '';
    }
    regionCounts[region || '(blank)'] = (regionCounts[region || '(blank)'] || 0) + 1;

    const coll = excelSerialToDate(raw.COLL_DATE);
    const wo = excelSerialToDate(raw.WO_CREATION_DATE);
    const qtn = excelSerialToDate(raw.QUOTATION_ISSUE_DATE);
    const created = excelSerialToDate(raw.CREATION_DATE);
    const withheldDate = excelSerialToDate(raw.SCN_WITHELD_DATE || raw.SCN_WITHHELD_DATE);

    const delaySc = coll ? dayDiff(today, coll) : '';
    const delayWo = (wo && coll) ? dayDiff(wo, coll) : '';
    const delayQtn = (qtn && created) ? dayDiff(qtn, created) : '';
    const bucket = delayBucket(delaySc);
    const poles = cellStr(raw.NO_OF_POLES);
    const poleNum = parseInt(poles, 10);
    const poleNonPole = (poles !== '' && !isNaN(poleNum) && poleNum > 0) ? 'Pole Case' : 'Non Pole Case';

    const row = {
      REG: reg,
      DIVN_NAME: divn,
      SUPP_OFF: supp,
      CCC_CODE: ccc,
      APPL_NO: cellStr(raw.APPL_NO),
      CON_ID: cellStr(raw.CON_ID),
      NAME: cellStr(raw.NAME),
      PHONE_NO: cellStr(raw.PHONE_NO),
      ADDRESS: cellStr(raw.ADDRESS),
      APPLICANT_TYPE: cellStr(raw.APPLICANT_TYPE),
      LOAD_WATTS: cellStr(raw.LOAD_WATTS),
      APPLIED_PHASE: cellStr(raw.APPLIED_PHASE),
      CONN_CLASS: cellStr(raw.CONN_CLASS),
      CONN_CAT: cellStr(raw.CONN_CAT),
      NO_OF_POLES: poles,
      COLL_DATE: formatDateDMY(coll) || cellStr(raw.COLL_DATE),
      WO_ISSUED: cellStr(raw.WO_ISSUED),
      WON: cellStr(raw.WON),
      WO_CREATION_DATE: formatDateDMY(wo) || cellStr(raw.WO_CREATION_DATE),
      AGENCY_NAME: cellStr(raw.AGENCY_NAME),
      METER_NUMBER: cellStr(raw.METER_NUMBER),
      SCN_STATUS: status,
      SCN_WITHELD_DATE: formatDateDMY(withheldDate) || cellStr(raw.SCN_WITHELD_DATE) || cellStr(raw.SCN_WITHHELD_DATE),
      SCN_WITHELD_REASON: cellStr(raw.SCN_WITHELD_REASON) || cellStr(raw.SCN_WITHHELD_REASON),
      IS_PORTAL_APPL: cellStr(raw.IS_PORTAL_APPL),
      INSPECTION_COMMENT: cellStr(raw.INSPECTION_COMMENT),
      REGION: region,
      TODAY: todayStr,
      DelayInWO: delayWo,
      DelayInSC: delaySc,
      DelayInQtn: delayQtn,
      DelayRange: bucket.DelayRange,
      DelaySerial: bucket.DelaySerial,
      PoleNonPole: poleNonPole
    };

    if (NSC_PUBLISH_STATUSES.has(statusKey) || withheldStatusKey(statusKey)) {
      const key = cellStr(row.APPL_NO).toLowerCase();
      if (!key) skippedBlank += 1;
      else if (NSC_PUBLISH_STATUSES.has(statusKey)) {
        if (publishedByAppl.has(key)) skippedDup += 1;
        publishedByAppl.set(key, row);
      } else {
        if (withheldByAppl.has(key)) skippedDup += 1;
        withheldByAppl.set(key, row);
      }
    }
  }

  const published = Array.from(publishedByAppl.values());
  const withheld = Array.from(withheldByAppl.values());
  const divisionCounts = {};
  EXPECTED_DIVISIONS.forEach((d) => { divisionCounts[d] = 0; });
  published.concat(withheld).forEach((r) => {
    const d = String(r.DIVN_NAME || '').trim() || '(unmapped)';
    divisionCounts[d] = (divisionCounts[d] || 0) + 1;
  });
  return {
    published,
    withheld,
    stats: {
      rawRows: rawRows.length,
      publishedRows: published.length,
      withheldRows: withheld.length,
      skippedDup,
      skippedBlank,
      unmappedDiv,
      statusCounts,
      regionCounts,
      divisionCounts,
      today: todayStr
    }
  };
}

function projectRows(rows, columns) {
  return (rows || []).map((row) => {
    const o = {};
    for (const c of columns) o[c] = row[c] == null ? '' : row[c];
    return o;
  });
}

function slimWorking(rows) { return projectRows(rows, SLIM_WORKING_COLUMNS); }
function slimWithheld(rows) { return projectRows(rows, WITHHELD_COLUMNS); }

function toCsv(rows, columns) {
  const cols = Array.isArray(columns) && columns.length ? columns : SLIM_WORKING_COLUMNS;
  const header = cols.join(',');
  const lines = (rows || []).map((row) => cols.map((col) => {
    const val = String(row[col] == null ? '' : row[col]);
    if (/[",\n\r]/.test(val)) return `"${val.replace(/"/g, '""')}"`;
    return val;
  }).join(','));
  return [header, ...lines].join('\n');
}

function readCsvRows(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = lines[0].indexOf('\t') !== -1 ? '\t' : ',';
  function split(line) {
    if (sep === '\t') return line.split('\t').map((s) => s.replace(/^"|"$/g, '').trim());
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i++; }
        else q = !q;
      } else if (ch === ',' && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }
  const header = split(lines[0]).map((h) => h.replace(/^\uFEFF/, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = split(lines[i]);
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = parts[j] !== undefined ? parts[j] : '';
    rows.push(row);
  }
  return rows;
}

/** Office-level aggregates for trend / KPI (no PII). */
function buildViz(rows, kind) {
  const offices = {};
  let total = 0;
  let over30 = 0;
  let pole = 0;
  let poleOver30 = 0;
  const byClass = {};
  const byDelay = {};
  for (const r of rows || []) {
    total += 1;
    const code = String(r.CCC_CODE || '').replace(/\D/g, '').slice(-7) || 'unknown';
    const cls = String(r.CONN_CLASS || '').trim().toUpperCase() || '?';
    const delay = parseFloat(r.DelayInSC);
    const serial = parseInt(r.DelaySerial, 10) || 0;
    const poleCase = /^pole case$/i.test(String(r.PoleNonPole || '').trim());
    if (poleCase) pole += 1;
    if (isFinite(delay) && delay > 30) {
      over30 += 1;
      if (poleCase) poleOver30 += 1;
    }
    byClass[cls] = (byClass[cls] || 0) + 1;
    const bucket = r.DelayRange || (serial ? String(serial) : 'unknown');
    byDelay[bucket] = (byDelay[bucket] || 0) + 1;
    if (!offices[code]) {
      const meta = resolveOfficeMeta(code, r.REGION, r.DIVN_NAME, r.SUPP_OFF);
      offices[code] = {
        ccc: meta.code || code,
        region: meta.region || '',
        division: meta.division || '',
        supp: meta.supp || '',
        total: 0, over30: 0, pole: 0, poleOver30: 0, byClass: {}
      };
    } else {
      // Backfill blank geography from later rows / CCC resolve (first row sometimes lacks REG).
      const o0 = offices[code];
      if (!o0.region || !o0.division || !o0.supp) {
        const meta = resolveOfficeMeta(code, r.REGION || o0.region, r.DIVN_NAME || o0.division, r.SUPP_OFF || o0.supp);
        if (!o0.region && meta.region) o0.region = meta.region;
        if (!o0.division && meta.division) o0.division = meta.division;
        if (!o0.supp && meta.supp) o0.supp = meta.supp;
      }
    }
    const o = offices[code];
    o.total += 1;
    if (isFinite(delay) && delay > 30) o.over30 += 1;
    if (poleCase) {
      o.pole += 1;
      if (isFinite(delay) && delay > 30) o.poleOver30 += 1;
    }
    o.byClass[cls] = (o.byClass[cls] || 0) + 1;
  }
  return {
    kind: kind || 'working',
    total, over30, pole, poleOver30, byClass, byDelay,
    offices: Object.keys(offices).sort().map((k) => offices[k])
  };
}

function guessTitleDate(fileName, reportDateUsed) {
  const fromName = String(fileName || '').match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})/);
  if (fromName) {
    let yy = parseInt(fromName[3], 10);
    if (yy < 100) yy += 2000;
    return reportDateKey(`${pad(fromName[1])}/${pad(fromName[2])}/${yy}`);
  }
  return reportDateKey(reportDateUsed);
}

/** Header keys present on a sample row (after canonicalize). */
function headerKeys(row) {
  const r = canonicalizeRow(row || {});
  return new Set(Object.keys(r).map((k) => String(k).toUpperCase()));
}

function hasAny(keys, names) {
  return names.some((n) => keys.has(String(n).toUpperCase()));
}

/**
 * Required columns for the SAP dump / slim lists.
 * side: 'raw' | 'working' | 'withheld'
 * Returns human labels of missing columns (empty = ok).
 */
function missingRequiredColumns(sampleRow, side) {
  const keys = headerKeys(sampleRow);
  const missing = [];
  if (!keys.has('APPL_NO')) missing.push('APPL_NO');
  if (side === 'raw' || side === 'working') {
    if (!keys.has('SCN_STATUS')) missing.push('SCN_STATUS');
  }
  if (!hasAny(keys, ['CCC_CODE', 'SUPP_OFF', 'CCC'])) {
    missing.push('CCC_CODE or SUPP_OFF');
  }
  if (side === 'withheld') {
    // Withheld list needs a withheld date (or status already filtered to withheld)
    if (!hasAny(keys, ['SCN_WITHELD_DATE', 'SCN_WITHHELD_DATE']) && !keys.has('SCN_STATUS')) {
      missing.push('SCN_WITHELD_DATE');
    }
  }
  return missing;
}

function requiredColumnsBlock(sampleRow, side, label) {
  const missing = missingRequiredColumns(sampleRow, side);
  if (!missing.length) return null;
  return {
    code: 'missing_columns',
    message: `${label} is missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Upload refused.`
  };
}

/**
 * Review a processed payload against current meta.
 * payload: { published, withheld, stats, reportDateUsed, originalName, sourceRow? }
 * current: { workingRows, withheldRows, reportDate } | null
 */
function review(payload, current) {
  const blocks = [];
  const warnings = [];
  const notes = [];
  const pub = payload.published || [];
  const wh = payload.withheld || [];
  const stats = payload.stats || {};
  const reportLabel = payload.reportDateUsed || stats.today || '';
  const reportKey = reportDateKey(reportLabel);

  // Refuse when required columns are missing (Working and/or Withheld sides).
  if (payload.sourceRow) {
    const blk = requiredColumnsBlock(payload.sourceRow, 'raw', 'This Excel');
    if (blk) blocks.push(blk);
  }
  if (pub.length) {
    const blk = requiredColumnsBlock(pub[0], 'working', 'Pending NSC (Working)');
    if (blk) blocks.push(blk);
  }
  if (wh.length) {
    const blk = requiredColumnsBlock(wh[0], 'withheld', 'Withheld');
    if (blk) blocks.push(blk);
  }

  if (!pub.length && !wh.length) {
    blocks.push({ code: 'empty', message: 'No Working/Accepted or Withheld rows found after processing.' });
  }
  if (pub.length > LIMITS.maxWorkingRows) {
    blocks.push({ code: 'too_many_working', message: `Working rows (${fmt(pub.length)}) exceed the limit of ${fmt(LIMITS.maxWorkingRows)}.` });
  }
  if (wh.length > LIMITS.maxWithheldRows) {
    blocks.push({ code: 'too_many_withheld', message: `Withheld rows (${fmt(wh.length)}) exceed the limit of ${fmt(LIMITS.maxWithheldRows)}.` });
  }
  if (pub.length + wh.length > LIMITS.maxCombinedRows) {
    blocks.push({ code: 'too_many', message: `Combined rows (${fmt(pub.length + wh.length)}) exceed the limit of ${fmt(LIMITS.maxCombinedRows)}.` });
  }

  const curW = current && current.workingRows != null ? Number(current.workingRows) : null;
  const curH = current && current.withheldRows != null ? Number(current.withheldRows) : null;
  const curDate = current && current.reportDate ? reportDateKey(current.reportDate) : '';

  if (reportKey && curDate && reportKey === curDate) {
    warnings.push({
      code: 'same_report_date',
      message: `This file’s report date (${reportLabel}) matches the list now on DISHA. Confirming will replace today’s upload again.`
    });
  }

  const titleKey = guessTitleDate(payload.originalName, reportLabel);
  if (!titleKey) {
    warnings.push({ code: 'title_date', message: 'Could not read a date from the file name. Make sure the report date is correct.' });
  } else if (reportKey) {
    const a = Date.parse(titleKey + 'T00:00:00Z');
    const b = Date.parse(reportKey + 'T00:00:00Z');
    if (isFinite(a) && isFinite(b)) {
      const gap = Math.round((b - a) / 86400000);
      if (Math.abs(gap) > LIMITS.titleDays) {
        warnings.push({
          code: 'title_date',
          days: gap,
          message: `The file name date and the report date differ by ${Math.abs(gap)} days. Check that this is the right export.`
        });
      }
    }
  }

  if (pub.length && curW != null && curW > 0 && pub.length < curW * (1 - LIMITS.dropShare)) {
    const drop = Math.round((1 - pub.length / curW) * 100);
    warnings.push({
      code: 'row_drop',
      message: `Working has ${fmt(pub.length)} rows, ${drop}% fewer than the ${fmt(curW)} now shown. Make sure the export is complete.`
    });
  }
  if (wh.length && curH != null && curH > 0 && wh.length < curH * (1 - LIMITS.dropShare)) {
    const drop = Math.round((1 - wh.length / curH) * 100);
    warnings.push({
      code: 'row_drop_withheld',
      message: `Withheld has ${fmt(wh.length)} rows, ${drop}% fewer than the ${fmt(curH)} now shown.`
    });
  }

  if (pub.length && !wh.length) {
    warnings.push({
      code: 'working_only',
      message: `This file has only Working/Accepted rows (${fmt(pub.length)}). The previous Withheld list will be kept.`
    });
  }
  if (wh.length && !pub.length) {
    warnings.push({
      code: 'withheld_only',
      message: `This file has only Withheld rows (${fmt(wh.length)}). The previous Working list will be kept.`
    });
  }

  const unknown = Object.keys(stats.statusCounts || {}).filter((s) => {
    if (s === '(blank)') return true;
    const k = s.toLowerCase();
    return !NSC_PUBLISH_STATUSES.has(k) && !withheldStatusKey(k);
  });
  if (unknown.length) {
    warnings.push({
      code: 'status_unknown',
      message: `Statuses not used for Working/Withheld: ${unknown.slice(0, 8).join(', ')}${unknown.length > 8 ? ', …' : ''}.`
    });
  }
  if ((stats.skippedDup || 0) > 0) {
    notes.push(`${fmt(stats.skippedDup)} duplicate application number${stats.skippedDup > 1 ? 's' : ''} (last row kept).`);
  }
  if ((stats.unmappedDiv || 0) > Math.max(20, (stats.rawRows || 0) * 0.05)) {
    warnings.push({
      code: 'div_unmapped',
      message: `${fmt(stats.unmappedDiv)} rows have no mapped division. Check SUPP_OFF / CCC_CODE.`
    });
  }

  // Zero rows for a known Malda Zone division usually means a bad/partial dump.
  const zeroDivs = zeroDivisionsFromRows(pub.concat(wh));
  if (zeroDivs.length && (pub.length || wh.length)) {
    warnings.push({
      code: 'div_zero',
      divisions: zeroDivs,
      message: `No applications for division${zeroDivs.length > 1 ? 's' : ''}: ${zeroDivs.join(', ')}. Check the export before saving — trend and office totals will show zero for ${zeroDivs.length > 1 ? 'them' : 'it'}.`
    });
  }

  const summary = {
    reportDate: reportLabel,
    reportDateKey: reportKey,
    workingRows: pub.length,
    withheldRows: wh.length,
    replaceWorking: pub.length > 0,
    replaceWithheld: wh.length > 0,
    statusCounts: stats.statusCounts || {},
    regionCounts: stats.regionCounts || {},
    divisionCounts: stats.divisionCounts || {},
    currentWorking: curW,
    currentWithheld: curH,
    currentReportDate: current && current.reportDate || ''
  };

  return { blocks, warnings, notes, summary };
}

/** Divisions from EXPECTED_DIVISIONS that have no rows in `rows`. */
function zeroDivisionsFromRows(rows) {
  const counts = {};
  EXPECTED_DIVISIONS.forEach((d) => { counts[d] = 0; });
  (rows || []).forEach((r) => {
    const d = String((r && (r.DIVN_NAME || r.division)) || '').trim();
    if (d && Object.prototype.hasOwnProperty.call(counts, d)) counts[d] += 1;
  });
  return EXPECTED_DIVISIONS.filter((d) => !counts[d]);
}

/** Same check from a viz.offices[] aggregate (trend snapshot import). */
function zeroDivisionsFromViz(viz) {
  const counts = {};
  EXPECTED_DIVISIONS.forEach((d) => { counts[d] = 0; });
  ((viz && viz.offices) || []).forEach((o) => {
    const d = String((o && o.division) || '').trim();
    if (d && Object.prototype.hasOwnProperty.call(counts, d)) {
      counts[d] += Number(o.total) || 0;
    }
  });
  return EXPECTED_DIVISIONS.filter((d) => !counts[d]);
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

module.exports = {
  LIMITS,
  EXPECTED_DIVISIONS,
  SLIM_WORKING_COLUMNS,
  WITHHELD_COLUMNS,
  transformRows,
  slimWorking,
  slimWithheld,
  buildViz,
  review,
  zeroDivisionsFromRows,
  zeroDivisionsFromViz,
  missingRequiredColumns,
  requiredColumnsBlock,
  toCsv,
  readCsvRows,
  parseManualReportDate,
  reportDateKey,
  formatDateDMY,
  canonicalizeRow,
  sha1
};
