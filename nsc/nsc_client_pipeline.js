/**
 * Browser-side NSC Excel → cleaned publish payload (the only NSC pipeline; the server just stores the CSV).
 * Raw .xlsb is ~20+ MB; Vercel rejects bodies over ~4.5 MB ("Request Entity Too Large").
 * Process in the browser, then POST only Working/Accepted CSV (~2 MB).
 */
(function (global) {
  'use strict';

  const NSC_PUBLISH_STATUSES = new Set(['working', 'accepted']);

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

  /** Withheld dashboard columns only — smaller Sheet / CSV than the full NSC dump. */
  const WITHHELD_COLUMNS = [
    'REGION', 'DIVN_NAME', 'SUPP_OFF', 'CCC_CODE', 'APPL_NO', 'NAME', 'PHONE_NO',
    'CONN_CLASS', 'APPLIED_PHASE', 'COLL_DATE', 'SCN_WITHELD_DATE', 'SCN_WITHELD_REASON',
    'IS_PORTAL_APPL', 'TODAY'
  ];

  /** Slim columns stored on the VM (viz + drawer); full SAP dump is not kept. */
  const SLIM_WORKING_COLUMNS = [
    'REGION', 'DIVN_NAME', 'SUPP_OFF', 'CCC_CODE', 'APPL_NO', 'CON_ID',
    'NAME', 'PHONE_NO', 'ADDRESS', 'APPLICANT_TYPE', 'LOAD_WATTS', 'APPLIED_PHASE',
    'CONN_CLASS', 'CONN_CAT', 'NO_OF_POLES', 'COLL_DATE', 'WO_ISSUED', 'WON',
    'WO_CREATION_DATE', 'AGENCY_NAME', 'METER_NUMBER', 'SCN_STATUS',
    'SCN_WITHELD_DATE', 'SCN_WITHELD_REASON', 'IS_PORTAL_APPL', 'INSPECTION_COMMENT',
    'TODAY', 'DelayInWO', 'DelayInSC', 'DelayInQtn', 'DelayRange', 'DelaySerial', 'PoleNonPole'
  ];

  const REGION_FROM_REG = {
    'MALDA REGION': 'Malda',
    'UTTAR DINAJPUR REGION': 'Uttar Dinajpur',
    'DAKSHIN DINAJPUR REGION': 'Dakshin Dinajpur'
  };

  /** Canonical Malda Zone divisions — warn when a dump has none for a division. */
  const EXPECTED_DIVISIONS = [
    'Malda', 'Chanchal', 'Gazole', 'Raiganj', 'Islampur', 'Balurghat', 'Buniadpur'
  ];

  const DIVN_TO_REGION = {
    Malda: 'Malda', Chanchal: 'Malda', Gazole: 'Malda',
    Raiganj: 'Uttar Dinajpur', Islampur: 'Uttar Dinajpur',
    Balurghat: 'Dakshin Dinajpur', Buniadpur: 'Dakshin Dinajpur'
  };

  function regionFromDivisionOrCode(region, division, cccCode) {
    var r = String(region || '').trim();
    if (r) return r;
    var d = String(division || '').trim();
    if (d && DIVN_TO_REGION[d]) return DIVN_TO_REGION[d];
    var code = String(cccCode || '').replace(/\D/g, '');
    if (code.indexOf('661') === 0) return 'Malda';
    if (code.indexOf('662') === 0) return 'Uttar Dinajpur';
    if (code.indexOf('663') === 0) return 'Dakshin Dinajpur';
    return '';
  }

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

  /** CCC_CODE / SUPP_OFF → Division (Sheet1 office master) */
  const OFFICE_BY_CODE = {
    "6611101": "Malda", "6611102": "Malda", "6611103": "Malda", "6611104": "Malda",
    "6611105": "Malda", "6611106": "Malda", "6611107": "Malda", "6611108": "Malda", "6611109": "Malda",
    "6612101": "Chanchal", "6612102": "Chanchal", "6612103": "Chanchal", "6612104": "Chanchal",
    "6612105": "Chanchal", "6612106": "Chanchal", "6612107": "Chanchal",
    "6613101": "Gazole", "6613102": "Gazole", "6613103": "Gazole", "6613104": "Gazole", "6613105": "Gazole",
    "6621101": "Raiganj", "6621102": "Raiganj", "6621103": "Raiganj", "6621104": "Raiganj",
    "6621105": "Raiganj", "6621106": "Raiganj",
    "6622101": "Islampur", "6622102": "Islampur", "6622103": "Islampur", "6622104": "Islampur", "6622105": "Islampur",
    "6631101": "Balurghat", "6631102": "Balurghat", "6631103": "Balurghat", "6631104": "Balurghat", "6631105": "Balurghat",
    "6632101": "Buniadpur", "6632102": "Buniadpur", "6632103": "Buniadpur", "6632104": "Buniadpur"
  };
  const OFFICE_BY_SUPP = {
    "Manikchak": "Malda", "Golapganj": "Malda", "Baishnabnagar": "Malda", "Kaliachak": "Malda",
    "Mothabari": "Malda", "Sujapur": "Malda", "Rathbari": "Malda", "Fulbari": "Malda", "Mokdumpur": "Malda",
    "Bhaluka": "Chanchal", "Samsi": "Chanchal", "Paranpur": "Chanchal", "Chanchal": "Chanchal",
    "Malatipur": "Chanchal", "Harishchandrapur": "Chanchal", "Kushida": "Chanchal",
    "Gazol": "Gazole", "Aiho": "Gazole", "Pandua": "Gazole", "Bamongola": "Gazole", "Old Malda": "Gazole",
    "Itahar": "Raiganj", "Hemtabad": "Raiganj", "Kaliyaganj": "Raiganj", "Raiganj": "Raiganj",
    "Birnagar": "Raiganj", "Karandighi": "Raiganj",
    "Islampur": "Islampur", "Chopra": "Islampur", "Dalkhola": "Islampur", "Goalpokher": "Islampur", "Kanki": "Islampur",
    "Balurghat": "Balurghat", "Tapan": "Balurghat", "Kumarganj": "Balurghat", "Hili": "Balurghat", "Patiram": "Balurghat",
    "Buniadpur": "Buniadpur", "Kusmandi": "Buniadpur", "Harirampur": "Buniadpur", "Gangarampur": "Buniadpur"
  };

  const HEADER_ALIASES = {
    'DIVN NAME': 'DIVN_NAME', DIVN: 'DIVN_NAME', DIVISION: 'DIVN_NAME', DIV_NAME: 'DIVN_NAME',
    'DIVISION NAME': 'DIVN_NAME', 'SUPP OFF': 'SUPP_OFF', 'SUPPLY OFFICE': 'SUPP_OFF',
    CCC: 'SUPP_OFF', 'CCC NAME': 'SUPP_OFF', 'CCC CODE': 'CCC_CODE',
    REGION_NAME: 'REG', 'SCN STATUS': 'SCN_STATUS', STATUS: 'SCN_STATUS',
    SCN_WITHHELD_DATE: 'SCN_WITHELD_DATE', 'SCN WITHHELD DATE': 'SCN_WITHELD_DATE',
    SCN_WITHHELD_REASON: 'SCN_WITHELD_REASON', 'SCN WITHHELD REASON': 'SCN_WITHELD_REASON'
  };

  function excelSerialToDate(serial) {
    if (serial == null || serial === '') return null;
    if (serial instanceof Date && !isNaN(serial.getTime())) return serial;
    if (typeof serial === 'number' && isFinite(serial)) {
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

  function withheldStatusKey(statusKey) {
    const s = String(statusKey || '').toLowerCase().replace(/[\s_-]+/g, '');
    return s === 'witheld' || s === 'withheld' || s === 'scnwithheld';
  }

  function applKeyOf(row) {
    return cellStr(row && row.APPL_NO).toLowerCase();
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

  function officeMapFromWorkbook(workbook) {
    const byCode = {};
    const bySupp = {};
    const names = workbook.SheetNames || [];
    for (let i = 0; i < names.length; i++) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[names[i]], { defval: '', raw: false });
      if (!rows.length || rows.length > 500) continue;
      const keys = Object.keys(rows[0]).map((k) => String(k).trim().toUpperCase());
      if (!keys.some((k) => k === 'CODE' || k === 'CCC_CODE')) continue;
      if (!keys.some((k) => k === 'DIVISION' || k === 'DIVN_NAME')) continue;
      if (!keys.some((k) => k === 'CCC' || k === 'SUPP_OFF')) continue;
      for (let j = 0; j < rows.length; j++) {
        const r = canonicalizeRow(rows[j]);
        const code = cellStr(r.CODE || r.CCC_CODE);
        const div = normalizeDivn(r.DIVISION || r.DIVN_NAME);
        const supp = normalizeSuppOff(r.CCC || r.SUPP_OFF);
        if (code && div) byCode[code] = div;
        if (supp && div) bySupp[supp] = div;
      }
    }
    return { byCode, bySupp };
  }

  function resolveDivnFromOffice(cccCode, suppOff) {
    const code = String(cccCode == null ? '' : cccCode).trim();
    if (code && OFFICE_BY_CODE[code]) return OFFICE_BY_CODE[code];
    const supp = String(suppOff == null ? '' : suppOff).trim();
    if (supp && OFFICE_BY_SUPP[supp]) return OFFICE_BY_SUPP[supp];
    return '';
  }

  function resolveDivnName(raw, workbookOfficeMap) {
    const direct = normalizeDivn(raw.DIVN_NAME || raw.DIVISION || raw.DIVN || '');
    if (direct) return direct;
    const code = cellStr(raw.CCC_CODE || raw.CODE);
    const supp = normalizeSuppOff(raw.SUPP_OFF || raw.CCC);
    if (workbookOfficeMap) {
      if (code && workbookOfficeMap.byCode[code]) return workbookOfficeMap.byCode[code];
      if (supp && workbookOfficeMap.bySupp[supp]) return workbookOfficeMap.bySupp[supp];
    }
    return resolveDivnFromOffice(code, supp);
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

  function transformRows(rawRows, reportDate, workbookOfficeMap) {
    const today = reportDate || new Date();
    const todayStr = formatDateDMY(today);
    const publishedByAppl = new Map();
    const withheldByAppl = new Map();
    const statusCounts = {};
    const regionCounts = {};
    let skippedDup = 0;
    let skippedBlank = 0;

    for (let i = 0; i < rawRows.length; i++) {
      const raw = canonicalizeRow(rawRows[i]);
      const status = cellStr(raw.SCN_STATUS);
      const statusKey = status.toLowerCase();
      statusCounts[status || '(blank)'] = (statusCounts[status || '(blank)'] || 0) + 1;

      const reg = cellStr(raw.REG);
      const divn = resolveDivnName(raw, workbookOfficeMap);
      const supp = normalizeSuppOff(raw.SUPP_OFF);
      const ccc = cellStr(raw.CCC_CODE);
      const region = regionFromDivisionOrCode(normalizeRegion(reg) || normalizeRegion(raw.REGION), divn, ccc);
      regionCounts[region || '(blank)'] = (regionCounts[region || '(blank)'] || 0) + 1;

      const coll = excelSerialToDate(raw.COLL_DATE);
      const wo = excelSerialToDate(raw.WO_CREATION_DATE);
      const qtn = excelSerialToDate(raw.QUOTATION_ISSUE_DATE);
      const created = excelSerialToDate(raw.CREATION_DATE);
      const insp = excelSerialToDate(raw.INSPECTION_DATE);
      const withheldDate = excelSerialToDate(raw.SCN_WITHELD_DATE || raw.SCN_WITHHELD_DATE);
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
        DIVN_NAME: divn,
        SUPP_OFF: supp,
        CCC_CODE: ccc,
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
        SCN_WITHELD_DATE: formatDateDMY(withheldDate) || cellStr(raw.SCN_WITHELD_DATE) || cellStr(raw.SCN_WITHHELD_DATE),
        SCN_WITHELD_REASON: cellStr(raw.SCN_WITHELD_REASON) || cellStr(raw.SCN_WITHHELD_REASON),
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

      if (NSC_PUBLISH_STATUSES.has(statusKey) || withheldStatusKey(statusKey)) {
        const key = applKeyOf(row);
        if (!key) {
          skippedBlank += 1;
        } else if (NSC_PUBLISH_STATUSES.has(statusKey)) {
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

    return {
      published,
      withheld,
      stats: {
        rawRows: rawRows.length,
        publishedRows: published.length,
        withheldRows: withheld.length,
        skippedDup,
        skippedBlank,
        statusCounts,
        regionCounts,
        today: todayStr
      }
    };
  }

  function toCsv(rows, columns) {
    const cols = Array.isArray(columns) && columns.length ? columns : OUTPUT_COLUMNS;
    const header = cols.join(',');
    const lines = rows.map((row) => cols.map((col) => {
      const val = String(row[col] == null ? '' : row[col]);
      if (/[",\n\r]/.test(val)) return `"${val.replace(/"/g, '""')}"`;
      return val;
    }).join(','));
    return [header, ...lines].join('\n');
  }

  /** Office aggregates for trend snapshots (no PII). Same shape as lib/nsc_pipeline.buildViz. */
  function buildViz(rows, kind) {
    const offices = {};
    let total = 0, over30 = 0, pole = 0, poleOver30 = 0;
    const byClass = {};
    const byDelay = {};
    (rows || []).forEach(function (r) {
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
        offices[code] = {
          ccc: code,
          region: regionFromDivisionOrCode(r.REGION, r.DIVN_NAME, code),
          division: r.DIVN_NAME || '',
          supp: r.SUPP_OFF || '',
          total: 0, over30: 0, pole: 0, poleOver30: 0, byClass: {}
        };
      } else if (!offices[code].region) {
        offices[code].region = regionFromDivisionOrCode(r.REGION, r.DIVN_NAME || offices[code].division, code);
      }
      const o = offices[code];
      o.total += 1;
      if (isFinite(delay) && delay > 30) o.over30 += 1;
      if (poleCase) {
        o.pole += 1;
        if (isFinite(delay) && delay > 30) o.poleOver30 += 1;
      }
      o.byClass[cls] = (o.byClass[cls] || 0) + 1;
    });
    return {
      kind: kind || 'working',
      total: total, over30: over30, pole: pole, poleOver30: poleOver30,
      byClass: byClass, byDelay: byDelay,
      offices: Object.keys(offices).sort().map(function (k) { return offices[k]; })
    };
  }

  function zeroDivisionsFromRows(rows) {
    const counts = {};
    EXPECTED_DIVISIONS.forEach(function (d) { counts[d] = 0; });
    (rows || []).forEach(function (r) {
      const d = String((r && (r.DIVN_NAME || r.division)) || '').trim();
      if (d && Object.prototype.hasOwnProperty.call(counts, d)) counts[d] += 1;
    });
    return EXPECTED_DIVISIONS.filter(function (d) { return !counts[d]; });
  }

  function zeroDivisionsFromViz(viz) {
    const counts = {};
    EXPECTED_DIVISIONS.forEach(function (d) { counts[d] = 0; });
    ((viz && viz.offices) || []).forEach(function (o) {
      const d = String((o && o.division) || '').trim();
      if (d && Object.prototype.hasOwnProperty.call(counts, d)) {
        counts[d] += Number(o.total) || 0;
      }
    });
    return EXPECTED_DIVISIONS.filter(function (d) { return !counts[d]; });
  }

  function buildWithheldViz(rows) {
    const viz = buildViz((rows || []).map(function (r) {
      return Object.assign({}, r, { DelayInSC: '', DelaySerial: '', PoleNonPole: 'Non Pole Case' });
    }), 'withheld');
    viz.total = (rows || []).length;
    viz.over30 = 0;
    viz.pole = 0;
    viz.poleOver30 = 0;
    const byClass = {};
    const offices = {};
    (rows || []).forEach(function (r) {
      const cls = String(r.CONN_CLASS || '').trim().toUpperCase() || '?';
      byClass[cls] = (byClass[cls] || 0) + 1;
      const code = String(r.CCC_CODE || '').replace(/\D/g, '').slice(-7) || 'unknown';
      if (!offices[code]) {
        offices[code] = {
          ccc: code,
          region: regionFromDivisionOrCode(r.REGION, r.DIVN_NAME, code),
          division: r.DIVN_NAME || '',
          supp: r.SUPP_OFF || '',
          total: 0, over30: 0, pole: 0, poleOver30: 0, byClass: {}
        };
      } else if (!offices[code].region) {
        offices[code].region = regionFromDivisionOrCode(r.REGION, r.DIVN_NAME || offices[code].division, code);
      }
      offices[code].total += 1;
      offices[code].byClass[cls] = (offices[code].byClass[cls] || 0) + 1;
    });
    viz.byClass = byClass;
    viz.offices = Object.keys(offices).sort().map(function (k) { return offices[k]; });
    return viz;
  }

  /**
   * @param {ArrayBuffer} arrayBuffer
   * @param {string} reportDateInput YYYY-MM-DD
   * @param {string} [fileName]
   */
  function processNscArrayBuffer(arrayBuffer, reportDateInput, fileName) {
    if (typeof XLSX === 'undefined') {
      throw new Error('SheetJS (XLSX) failed to load. Check network / CDN.');
    }
    const reportDate = parseManualReportDate(reportDateInput);
    if (!reportDate) {
      throw new Error('Invalid report date. Use YYYY-MM-DD.');
    }

    const workbook = XLSX.read(arrayBuffer, {
      type: 'array',
      cellDates: true,
      raw: false
    });
    const sheetName = pickSheetName(workbook);
    if (!sheetName) throw new Error('No worksheet found in workbook.');
    const sheet = workbook.Sheets[sheetName];
    const officeMap = officeMapFromWorkbook(workbook);
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false }).map(canonicalizeRow);
    if (!rows.length) {
      throw new Error('Sheet "' + sheetName + '" has no data rows.');
    }
    var first = rows[0] || {};
    var missing = [];
    if (!Object.prototype.hasOwnProperty.call(first, 'APPL_NO')) missing.push('APPL_NO');
    if (!Object.prototype.hasOwnProperty.call(first, 'SCN_STATUS')) missing.push('SCN_STATUS');
    if (!Object.prototype.hasOwnProperty.call(first, 'CCC_CODE') &&
        !Object.prototype.hasOwnProperty.call(first, 'SUPP_OFF') &&
        !Object.prototype.hasOwnProperty.call(first, 'CCC')) {
      missing.push('CCC_CODE or SUPP_OFF');
    }
    if (missing.length) {
      throw new Error(
        'Sheet "' + sheetName + '" is missing required column' + (missing.length > 1 ? 's' : '') +
          ': ' + missing.join(', ') + '. Upload refused.'
      );
    }

    const result = transformRows(rows, reportDate, officeMap);
    if (!result.published.length && !result.withheld.length) {
      throw new Error('No Working/Accepted or Withheld rows found after processing.');
    }
    return {
      sheetName,
      published: result.published,
      withheld: result.withheld,
      stats: result.stats,
      csv: toCsv(result.published),
      withheldCsv: toCsv(result.withheld, WITHHELD_COLUMNS),
      reportDateUsed: formatDateDMY(reportDate),
      originalName: fileName || ''
    };
  }

  global.NSCClientPipeline = {
    processNscArrayBuffer,
    parseManualReportDate,
    buildViz: buildViz,
    buildWithheldViz: buildWithheldViz,
    EXPECTED_DIVISIONS: EXPECTED_DIVISIONS,
    zeroDivisionsFromRows: zeroDivisionsFromRows,
    zeroDivisionsFromViz: zeroDivisionsFromViz,
    OUTPUT_COLUMNS,
    WITHHELD_COLUMNS,
    SLIM_WORKING_COLUMNS,
    toCsv,
    slimWorkingCsv: function (rows) { return toCsv(rows, SLIM_WORKING_COLUMNS); },
    slimWithheldCsv: function (rows) { return toCsv(rows, WITHHELD_COLUMNS); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
