/**
 * Browser-side NSC Excel → cleaned publish payload (mirrors lib/nsc_pipeline.js).
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
    if (s === s.toUpperCase() && /[A-Z]/.test(s)) {
      s = s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return s;
  }

  function pickSheetName(workbook) {
    const names = workbook.SheetNames || [];
    const preferred = names.find((n) => /malda\s*pnsc/i.test(n));
    if (preferred) return preferred;
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

  function transformRows(rawRows, reportDate) {
    const today = reportDate || new Date();
    const todayStr = formatDateDMY(today);
    const published = [];
    const withheld = [];
    const statusCounts = {};
    const regionCounts = {};

    for (const raw of rawRows) {
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
        DIVN_NAME: normalizeDivn(raw.DIVN_NAME),
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
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    if (!rows.length) {
      throw new Error('Sheet "' + sheetName + '" has no data rows.');
    }
    if (!Object.prototype.hasOwnProperty.call(rows[0], 'SCN_STATUS') &&
        !Object.prototype.hasOwnProperty.call(rows[0], 'APPL_NO')) {
      throw new Error('Sheet "' + sheetName + '" does not look like an NSC dump (missing APPL_NO / SCN_STATUS).');
    }

    const result = transformRows(rows, reportDate);
    if (!result.published.length) {
      throw new Error('No Working/Accepted rows found after processing.');
    }
    return {
      sheetName,
      published: result.published,
      withheld: result.withheld,
      stats: result.stats,
      csv: toCsv(result.published),
      reportDateUsed: formatDateDMY(reportDate),
      originalName: fileName || ''
    };
  }

  global.NSCClientPipeline = {
    processNscArrayBuffer,
    parseManualReportDate,
    OUTPUT_COLUMNS,
    toCsv
  };
})(typeof window !== 'undefined' ? window : globalThis);
