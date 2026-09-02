/**
 * Browser-side defective-meter dump → summary + details for Google Sheets.
 * Full CSV stays on the admin PC; Vercel never receives the 59 MB file.
 */
(function (root) {
  'use strict';

  var SUMMARY_HEADERS = [
    'REPORT_AS_ON', 'CCC_CODE', 'REGION', 'REGION_CODE', 'DIVISION', 'DIVISION_CODE',
    'BASE_CLASS', 'DEFECT_YEAR', 'DEFECT_MONTH',
    'total', 'agri', 'over10', 'over5', 'ph3', 'industrial', 'smart',
    'load_gt6', 'load_3_6', 'load_1_3', 'load_05_1', 'load_lt_05',
    'phase_1', 'phase_3', 'phase_other'
  ];

  var DETAILS_HEADERS = [
    'CON_ID', 'CCC_CODE', 'NAME', 'ADDRESS', 'METER_NO', 'FIRST_REPORTED_DEF_DT',
    'PHASE', 'CONN_LOAD', 'REPORT_AS_ON', 'BASE_CLASS', 'CONN_STAT', 'MRU', 'MOBILE_NO',
    'over10', 'ph3', 'industrial', 'smart', 'load_gt6', 'load_3_6', 'load_1_3'
  ];

  var OFFICE_BY_PREFIX = {
    '6611': { REGION: 'MALDA REGION', REGION_CODE: '6610000', DIVISION: 'MALDA DIVISION', DIVISION_CODE: '6611000' },
    '6612': { REGION: 'MALDA REGION', REGION_CODE: '6610000', DIVISION: 'CHANCHAL DIVISION', DIVISION_CODE: '6612000' },
    '6613': { REGION: 'MALDA REGION', REGION_CODE: '6610000', DIVISION: 'GAZOLE DIVISION', DIVISION_CODE: '6613000' },
    '6621': { REGION: 'UTTAR DINAJPUR REGION', REGION_CODE: '6620000', DIVISION: 'RAIGANJ DIVISION', DIVISION_CODE: '6621000' },
    '6622': { REGION: 'UTTAR DINAJPUR REGION', REGION_CODE: '6620000', DIVISION: 'ISLAMPUR DIVISION', DIVISION_CODE: '6622000' },
    '6631': { REGION: 'DAKSHIN DINAJPUR REGION', REGION_CODE: '6630000', DIVISION: 'BALURGHAT DIVISION', DIVISION_CODE: '6631000' },
    '6632': { REGION: 'DAKSHIN DINAJPUR REGION', REGION_CODE: '6630000', DIVISION: 'BUNIADPUR DIVISION', DIVISION_CODE: '6632000' }
  };

  var KPI_FIELD = {
    total: 'total',
    agri: 'agri',
    over10years: 'over10',
    over5years: 'over5',
    '3phase': 'ph3',
    industrial: 'industrial',
    smartmeter: 'smart',
    loadAbove6: 'load_gt6',
    load3to6: 'load_3_6',
    load1to3: 'load_1_3',
    load05to1: 'load_05_1',
    loadBelow05: 'load_lt_05'
  };

  var DETAILS_FLAG = {
    over10years: 'over10',
    '3phase': 'ph3',
    industrial: 'industrial',
    smartmeter: 'smart',
    loadAbove6: 'load_gt6',
    load3to6: 'load_3_6',
    load1to3: 'load_1_3'
  };

  function officeFromCcc(ccc) {
    var p = String(ccc || '').trim().slice(0, 4);
    return OFFICE_BY_PREFIX[p] || {
      REGION: '', REGION_CODE: '', DIVISION: '', DIVISION_CODE: ''
    };
  }

  var FIELD_ALIASES = {
    CON_ID: [
      'CON_ID', 'CONS_ID', 'CONSUMER_ID', 'CONSUMER_NO', 'CONSUMER_NUMBER', 'CONSUMER_NUM',
      'CON_NO', 'CONNO', 'CONSUMER', 'CA', 'CA_NO', 'CA_NUMBER', 'BP', 'BP_NO', 'PARTNER',
      'CONTRACT_ACCOUNT', 'KUNNR', 'VKONT', 'BP_NUMBER'
    ],
    CCC_CODE: [
      'CCC_CODE', 'CCC', 'CCC_CD', 'CCCCODE', 'CCC_NO', 'CCC_NUMBER', 'CC_CODE',
      'SUPP_OFF', 'OFFICE_CODE', 'UNIT_CODE', 'COST_CENTER', 'CUST_CARE', 'SECTION_CODE',
      'OFFICE', 'UNIT'
    ],
    NAME: ['NAME', 'CON_NAME', 'CONSUMER_NAME', 'CUST_NAME', 'NAME1'],
    ADDRESS: ['ADDRESS', 'ADDR', 'STREET', 'ADDRESS1'],
    METER_NO: [
      'METER_NO', 'MTR_NO', 'METER', 'METER_NUMBER', 'METERNO', 'METER_SL_NO',
      'METER_SL', 'SERIAL_NO', 'GERNR', 'METER_SERIAL'
    ],
    FIRST_REPORTED_DEF_DT: [
      'FIRST_REPORTED_DEF_DT', 'FIRST_DEF_DT', 'DEF_DT', 'DEFECT_DT', 'DEFECT_DATE',
      'FIRST_REPORTED_DEFECT_DT', 'FRST_DEF_DT', 'DEFECTIVE_DT', 'DEFECTIVE_DATE',
      'FIRST_REPORTED', 'DATE_OF_DEFECT', 'DEF_DATE'
    ],
    PHASE: ['PHASE', 'CONN_PHASE', 'PH', 'NO_OF_PH', 'PHASE_CD', 'CONNPHASE', 'NO_OF_PHASE'],
    CONN_LOAD: [
      'CONN_LOAD', 'CONNECTED_LOAD', 'SANC_LOAD', 'LOAD', 'CONN_LD', 'CONNLOAD',
      'SANCTIONED_LOAD', 'CONTRACT_DEMAND', 'CD'
    ],
    REPORT_AS_ON: [
      'REPORT_AS_ON', 'AS_ON', 'REPORT_DATE', 'RPT_DT', 'REPORTASON', 'AS_ON_DATE', 'TODAY'
    ],
    BASE_CLASS: ['BASE_CLASS', 'BASECLASS'],
    TARIFF_CLASS: [
      'TARIFF_CLASS', 'TARIFF', 'TARIFF_CAT', 'TARIFF_TYPE', 'CONN_CLASS', 'CONS_CLASS',
      'CONS_CATG', 'CATG', 'CON_CAT', 'CONSUMER_CATEGORY', 'CATEGORY'
    ],
    CONN_STAT: ['CONN_STAT', 'STATUS', 'CON_STAT', 'CONNSTAT', 'CONN_STATUS'],
    MRU: ['MRU'],
    MOBILE_NO: ['MOBILE_NO', 'MOBILE', 'PHONE', 'REG_MOB_NO', 'MOBILENO', 'TEL_NUMBER']
  };

  var CANON_BY_ALIAS = (function () {
    var m = Object.create(null);
    Object.keys(FIELD_ALIASES).forEach(function (canon) {
      FIELD_ALIASES[canon].forEach(function (a) { m[a] = canon; });
    });
    return m;
  })();

  function canonHeader(h) {
    return String(h || '')
      .replace(/^\uFEFF/, '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
  }

  var PRESERVE_CANON = {
    TOTAL: true, AGRI: true, OVER10: true, OVER5: true, PH3: true,
    INDUSTRIAL: true, SMART: true,
    LOAD_GT6: true, LOAD_3_6: true, LOAD_1_3: true, LOAD_05_1: true, LOAD_LT_05: true,
    PHASE_1: true, PHASE_3: true, PHASE_OTHER: true,
    REGION: true, REGION_CODE: true, DIVISION: true, DIVISION_CODE: true,
    DEFECT_YEAR: true, DEFECT_MONTH: true
  };

  function mapHeader(h) {
    var raw = String(h || '').replace(/^\uFEFF/, '').trim();
    if (!raw) return '';
    var c = canonHeader(raw);
    if (PRESERVE_CANON[c]) return raw;
    if (CANON_BY_ALIAS[c]) return CANON_BY_ALIAS[c];
    if (/CONSUMER.*NAME|CUST_NAME|CON_NAME/.test(c)) return 'NAME';
    if (/CON(SUMER)?_?(ID|NO|NUM)|BP_NO|CA_NO|CONTRACT_ACC|VKONT|KUNNR/.test(c)) return 'CON_ID';
    if (/CCC.*CODE|CC_CODE|SUPP_OFF|OFFICE_CODE|UNIT_CODE|COST_CENTER|C_C_C/.test(c)) return 'CCC_CODE';
    if (/^CCC$|^CC$|^OFFICE$|^UNIT$/.test(c)) return 'CCC_CODE';
    if (/^METER(_NO|_NUMBER|_SL|_SERIAL|NO)?$/.test(c)) return 'METER_NO';
    if (/^PHASE$|^CONN_PHASE$|^NO_OF_PH/.test(c)) return 'PHASE';
    if (/^(CONN_?)?LOAD$|^SANC.*LOAD$|^CONNECTED_LOAD$|^CONTRACT_DEMAND$/.test(c)) return 'CONN_LOAD';
    if (/^BASE_?CLASS$/.test(c)) return 'BASE_CLASS';
    if (/CONN_CLASS|CONS_CLASS/.test(c)) return 'CONN_CLASS';
    if (/^TARIFF|^CATG$|^CATEGORY$|^CONSUMER_CATEGORY$/.test(c)) return 'TARIFF_CLASS';
    if (/(DEFECT|FIRST_REP|FRST_DEF)/.test(c) && /(DT|DATE)/.test(c)) return 'FIRST_REPORTED_DEF_DT';
    if (/DATE_OF_DEFECT|^DEFECT$/.test(c)) return 'FIRST_REPORTED_DEF_DT';
    if (/REPORT.*AS|AS_ON|RPT_DT|^TODAY$/.test(c)) return 'REPORT_AS_ON';
    if (/MOBILE|PHONE|^TEL/.test(c)) return 'MOBILE_NO';
    if (/ADDR/.test(c)) return 'ADDRESS';
    if (/^NAME$/.test(c)) return 'NAME';
    if (/^MRU$/.test(c)) return 'MRU';
    return raw;
  }

  function stripNulls(text) {
    var s = String(text || '');
    if (s.indexOf('\u0000') !== -1) s = s.replace(/\u0000/g, '');
    return s.replace(/^\uFEFF/, '');
  }

  function firstContentLine(text) {
    var s = stripNulls(text);
    var lines = s.split(/\r\n|\n|\r/);
    for (var i = 0; i < lines.length; i++) {
      if (String(lines[i]).trim()) return lines[i];
    }
    return '';
  }

  function detectDelimiter(text) {
    var line = firstContentLine(text);
    var counts = [
      { d: '\t', n: (line.match(/\t/g) || []).length },
      { d: '|', n: (line.match(/\|/g) || []).length },
      { d: ';', n: (line.match(/;/g) || []).length },
      { d: ',', n: (line.match(/,/g) || []).length }
    ];
    counts.sort(function (a, b) { return b.n - a.n; });
    return counts[0].n > 0 ? counts[0].d : ',';
  }

  function parseYmd(s) {
    var t = String(s == null ? '' : s).trim();
    if (!t || t === '00000000' || t === '0') return null;
    if (/^\d{8}$/.test(t)) {
      var y = +t.slice(0, 4);
      var m = +t.slice(4, 6) - 1;
      var d = +t.slice(6, 8);
      if (!y || m < 0 || m > 11 || !d) return null;
      return new Date(y, m, d);
    }
    var dmY = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (dmY) return new Date(+dmY[3], +dmY[2] - 1, +dmY[1]);
    var yMd = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
    if (yMd) return new Date(+yMd[1], +yMd[2] - 1, +yMd[3]);
    return null;
  }

  function parseDelimited(text, delim) {
    var rows = [];
    var field = '';
    var row = [];
    var q = false;
    var s = stripNulls(text);
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      var n = s[i + 1];
      if (c === '"') {
        if (q && n === '"') { field += '"'; i++; }
        else q = !q;
      } else if (c === delim && !q) {
        row.push(field);
        field = '';
      } else if ((c === '\n' || (c === '\r' && n === '\n')) && !q) {
        row.push(field);
        field = '';
        if (row.some(function (v) { return String(v).trim() !== ''; })) rows.push(row);
        row = [];
        if (c === '\r') i++;
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) {
      row.push(field);
      if (row.some(function (v) { return String(v).trim() !== ''; })) rows.push(row);
    }
    return rows;
  }

  function headerScore(mapped) {
    var keys = ['CCC_CODE', 'CON_ID', 'METER_NO', 'BASE_CLASS', 'PHASE', 'CONN_LOAD', 'FIRST_REPORTED_DEF_DT', 'NAME', 'REPORT_AS_ON'];
    var n = 0;
    for (var i = 0; i < keys.length; i++) {
      if (mapped.indexOf(keys[i]) !== -1) n++;
    }
    return n;
  }

  function findHeaderRow(rows) {
    var max = Math.min(rows.length, 25);
    var best = -1;
    var bestScore = 0;
    for (var i = 0; i < max; i++) {
      var mapped = rows[i].map(mapHeader);
      var score = headerScore(mapped);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return bestScore >= 2 ? best : -1;
  }

  function colRatio(sample, col, pred) {
    var ok = 0;
    var n = 0;
    for (var i = 0; i < sample.length; i++) {
      var v = String(sample[i][col] != null ? sample[i][col] : '').trim();
      if (!v) continue;
      n++;
      if (pred(v)) ok++;
    }
    return n >= 8 ? ok / n : 0;
  }

  function inferHeaders(headers, dataRows) {
    var sample = dataRows.slice(0, 120);
    var colCount = headers.length;
    var i;
    for (i = 0; i < sample.length; i++) {
      if (sample[i].length > colCount) colCount = sample[i].length;
    }
    var taken = Object.create(null);
    for (i = 0; i < headers.length; i++) {
      if (FIELD_ALIASES[headers[i]]) taken[headers[i]] = true;
    }

    function assign(canon, pred, minRatio) {
      if (taken[canon]) return;
      var best = -1;
      var bestR = minRatio || 0.55;
      for (var c = 0; c < colCount; c++) {
        if (headers[c] && taken[headers[c]]) continue;
        var r = colRatio(sample, c, pred);
        if (r > bestR) {
          bestR = r;
          best = c;
        }
      }
      if (best >= 0) {
        headers[best] = canon;
        taken[canon] = true;
      }
    }

    assign('CCC_CODE', function (v) { return /66[123]\d{4}/.test(v); }, 0.45);
    assign('CON_ID', function (v) {
      var d = v.replace(/\.0+$/, '');
      return /^\d{10,13}$/.test(d);
    }, 0.45);
    assign('PHASE', function (v) { return /^(0*[13](\.0+)?|[13]\s*PH)/i.test(v); }, 0.5);
    assign('BASE_CLASS', function (v) { return isTariffClass(v); }, 0.3);
    assign('METER_NO', function (v) { return isSmartMeterNo(v); }, 0.08);
    assign('METER_NO', function (v) {
      return isMeterSerial(v);
    }, 0.35);
    assign('METER_TYPE', function (v) { return isMeterTypeVal(v); }, 0.45);
    assign('CONN_LOAD', function (v) {
      var n = parseFloat(String(v).replace(/,/g, ''));
      return isFinite(n) && n >= 0 && n <= 500 && String(v).indexOf('.') !== -1;
    }, 0.4);
    assign('FIRST_REPORTED_DEF_DT', function (v) { return !!parseYmd(v); }, 0.45);
    assign('REPORT_AS_ON', function (v) { return !!parseYmd(v); }, 0.45);
    return headers;
  }

  function isTariffClass(v) {
    var t = String(v || '').trim().toUpperCase();
    if (t === 'D' || t === 'C' || t === 'A' || t === 'I' || t === 'L' || t === 'B') return true;
    if (t === 'AG' || t === 'AGR' || t === 'IND' || t === 'INDL') return true;
    return /^(AGRI|INDUS|DOMEST|COMMER)/.test(t);
  }

  function isRuArea(v) {
    var t = String(v || '').trim().toUpperCase();
    return t === 'R' || t === 'U' || t === 'RURAL' || t === 'URBAN';
  }

  function isMeterTypeVal(v) {
    return /ELECTR|MECHANIC|STATIC|^DIGITAL$/i.test(String(v || '').trim());
  }

  function isSmartTypeVal(v) {
    var t = String(v || '').trim().toUpperCase();
    return t === 'SMART' || t === 'AMI' || t.indexOf('SMART') === 0;
  }

  function isSmartMeterNo(v) {
    return /^(IJ|IL|IT)/i.test(String(v || '').trim());
  }

  function isMeterSerial(v) {
    var t = String(v || '').trim();
    if (t.length < 6) return false;
    if (isMeterTypeVal(t) || isSmartTypeVal(t)) return false;
    if (/66[123]\d{4}/.test(t) && t.length <= 8) return false;
    return /^[A-Z0-9\-\/]+$/i.test(t);
  }

  function isAgriClass(cls) {
    var t = String(cls || '').trim().toUpperCase();
    return t === 'A' || t === 'AG' || t === 'AGR' || t.indexOf('AGRI') === 0 || t.indexOf('IRRIG') === 0;
  }

  function isIndustrialClass(cls) {
    var t = String(cls || '').trim().toUpperCase();
    return t === 'I' || t === 'IND' || t === 'INDL' || t.indexOf('INDUS') === 0;
  }

  function isSmartMeter(meter, meterType) {
    if (isSmartMeterNo(meter) || isSmartTypeVal(meter)) return true;
    if (isSmartTypeVal(meterType)) return true;
    return false;
  }

  function classFieldValue(item) {
    var keys = Object.keys(item || {});
    var tariff = '';
    var i;
    for (i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!/CLASS|TARIFF|CATG|CATEG/i.test(k)) continue;
      var v = item[k];
      if (isTariffClass(v) && !isRuArea(v)) {
        if (isAgriClass(v) || isIndustrialClass(v)) return String(v).trim();
        if (!tariff) tariff = String(v).trim();
      }
    }
    if (tariff) return tariff;
    return String((item && item.BASE_CLASS) || '').trim();
  }

  function headerTaken(name) {
    return !!(FIELD_ALIASES[name] || name === 'METER_TYPE' || name === 'CONN_CLASS' || PRESERVE_CANON[canonHeader(name)]);
  }

  function refineDumpColumns(headers, dataRows) {
    var sample = dataRows.slice(0, 160);
    var colCount = headers.length;
    var c;
    for (c = 0; c < sample.length; c++) {
      if (sample[c].length > colCount) colCount = sample[c].length;
    }

    var bestTariff = -1;
    var bestT = 0.04;
    for (c = 0; c < colCount; c++) {
      if (headers[c] && headerTaken(headers[c]) && headers[c] !== 'BASE_CLASS' && headers[c] !== 'TARIFF_CLASS' && headers[c] !== 'CONN_CLASS') continue;
      var s = colRatio(sample, c, isTariffClass);
      if (s > bestT) {
        bestT = s;
        bestTariff = c;
      }
    }
    if (bestTariff >= 0) {
      var cur = headers.indexOf('BASE_CLASS');
      if (cur >= 0 && cur !== bestTariff && colRatio(sample, cur, isRuArea) >= 0.5) {
        headers[cur] = 'AREA';
      }
      headers[bestTariff] = 'BASE_CLASS';
    }

    var mIdx = headers.indexOf('METER_NO');
    if (mIdx >= 0 && colRatio(sample, mIdx, isMeterTypeVal) >= 0.45) {
      headers[mIdx] = 'METER_TYPE';
      mIdx = -1;
    }
    var bestM = -1;
    var bestMR = 0.2;
    for (c = 0; c < colCount; c++) {
      if (headers[c] && headerTaken(headers[c]) && headers[c] !== 'METER_NO') continue;
      var sm = colRatio(sample, c, isSmartMeterNo);
      var ser = colRatio(sample, c, isMeterSerial);
      var sc = sm > ser ? sm : ser;
      if (sc > bestMR) {
        bestMR = sc;
        bestM = c;
      }
    }
    if (bestM >= 0) headers[bestM] = 'METER_NO';
  }

  function previewHeaders(row) {
    return (row || []).slice(0, 16).map(function (h) {
      return String(h || '').replace(/^\uFEFF/, '').trim();
    }).filter(Boolean).join(', ');
  }

  function parseCsv(text) {
    var delim = detectDelimiter(text);
    var rows = parseDelimited(text, delim);
    if (!rows.length) return [];
    var headerIdx = findHeaderRow(rows);
    if (headerIdx < 0) headerIdx = 0;
    var headers = rows[headerIdx].map(mapHeader);
    var dataRows = rows.slice(headerIdx + 1);
    var published = headers.indexOf('CCC_CODE') !== -1 && (
      headers.indexOf('total') !== -1 || headers.indexOf('CON_ID') !== -1
    );
    if (!published) {
      headers = inferHeaders(headers, dataRows);
      refineDumpColumns(headers, dataRows);
    }
    if (headers.indexOf('CCC_CODE') === -1 && headers.indexOf('CON_ID') === -1 && headers.indexOf('METER_NO') === -1) {
      throw new Error('CSV columns were not recognised. First row: ' + (previewHeaders(rows[headerIdx]) || '(empty)'));
    }
    var out = [];
    for (var r = 0; r < dataRows.length; r++) {
      var obj = {};
      for (var h = 0; h < headers.length; h++) {
        if (!headers[h]) continue;
        obj[headers[h]] = dataRows[r][h] != null ? dataRows[r][h] : '';
      }
      var id = String(obj.CON_ID || '').trim().toUpperCase();
      var name = String(obj.NAME || '').trim().toUpperCase();
      var ccc = String(obj.CCC_CODE || '').trim().toUpperCase();
      if (id === 'TOTAL' || name === 'TOTAL' || ccc === 'TOTAL' || id === 'GRAND TOTAL') continue;
      if (!id && !ccc && !String(obj.METER_NO || '').trim()) continue;
      out.push(obj);
    }
    return out;
  }

  function cleanCcc(ccc) {
    var s = String(ccc || '').trim();
    if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
    var m = s.match(/66[123]\d{4}/);
    return m ? m[0] : s;
  }

  function normPhase(raw) {
    var p = String(raw == null ? '' : raw).trim();
    if (/^0*1(\.0+)?$/.test(p) || /1\s*ph/i.test(p)) return '1';
    if (/^0*3(\.0+)?$/.test(p) || /3\s*ph/i.test(p)) return '3';
    return p;
  }

  function numLoad(raw) {
    var t = String(raw == null ? '' : raw).trim().replace(/,/g, '');
    var n = parseFloat(t);
    return isFinite(n) ? n : 0;
  }

  function emptyCounts() {
    return {
      total: 0, agri: 0, over10: 0, over5: 0, ph3: 0, industrial: 0, smart: 0,
      load_gt6: 0, load_3_6: 0, load_1_3: 0, load_05_1: 0, load_lt_05: 0,
      phase_1: 0, phase_3: 0, phase_other: 0
    };
  }

  function buildFromRows(rawRows) {
    var summaryMap = Object.create(null);
    var details = [];
    var reportAsOn = null;
    var reportAsOnRaw = '';
    var i;
    for (i = 0; i < rawRows.length; i++) {
      var d = parseYmd(rawRows[i].REPORT_AS_ON);
      if (d) { reportAsOn = d; reportAsOnRaw = String(rawRows[i].REPORT_AS_ON).trim(); break; }
    }

    for (i = 0; i < rawRows.length; i++) {
      var item = rawRows[i];
      var ccc = cleanCcc(item.CCC_CODE);
      var cls = classFieldValue(item);
      var phase = normPhase(item.PHASE);
      var meter = String(item.METER_NO || '').trim();
      var meterType = String(item.METER_TYPE || '').trim();
      if (isMeterTypeVal(meter) && !isSmartMeterNo(meter)) {
        if (!meterType) meterType = meter;
        meter = '';
      }
      var load = numLoad(item.CONN_LOAD);
      var def = parseYmd(item.FIRST_REPORTED_DEF_DT);
      var year = def ? def.getFullYear() : 0;
      var month = def ? def.getMonth() + 1 : 0;
      var years = 0;
      if (def && reportAsOn) {
        years = (reportAsOn.getTime() - def.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
      }
      var over10 = years > 10;
      var over5 = years > 5;
      var ph3 = phase === '3';
      var industrial = isIndustrialClass(cls);
      var smart = isSmartMeter(meter, meterType);
      var agri = isAgriClass(cls);
      var load_gt6 = load > 6;
      var load_3_6 = load >= 3 && load <= 6;
      var load_1_3 = load >= 1 && load < 3;
      var load_05_1 = load >= 0.5 && load < 1;
      var load_lt_05 = load < 0.5;

      var key = ccc + '|' + cls + '|' + year + '|' + month;
      var bucket = summaryMap[key];
      if (!bucket) {
        var off = officeFromCcc(ccc);
        bucket = summaryMap[key] = Object.assign({
          REPORT_AS_ON: reportAsOnRaw || String(item.REPORT_AS_ON || ''),
          CCC_CODE: ccc,
          REGION: off.REGION,
          REGION_CODE: off.REGION_CODE,
          DIVISION: off.DIVISION,
          DIVISION_CODE: off.DIVISION_CODE,
          BASE_CLASS: cls,
          DEFECT_YEAR: year || '',
          DEFECT_MONTH: month || ''
        }, emptyCounts());
      }
      bucket.total++;
      if (agri) bucket.agri++;
      if (over10) bucket.over10++;
      if (over5) bucket.over5++;
      if (ph3) bucket.ph3++;
      if (industrial) bucket.industrial++;
      if (smart) bucket.smart++;
      if (load_gt6) bucket.load_gt6++;
      else if (load_3_6) bucket.load_3_6++;
      else if (load_1_3) bucket.load_1_3++;
      else if (load_05_1) bucket.load_05_1++;
      else bucket.load_lt_05++;
      if (phase === '1') bucket.phase_1++;
      else if (phase === '3') bucket.phase_3++;
      else bucket.phase_other++;

      if (over10 || ph3 || industrial || smart || load_gt6 || load_3_6 || load_1_3) {
        details.push({
          CON_ID: item.CON_ID || '',
          CCC_CODE: ccc,
          NAME: item.NAME || '',
          ADDRESS: item.ADDRESS || '',
          METER_NO: meter,
          FIRST_REPORTED_DEF_DT: item.FIRST_REPORTED_DEF_DT || '',
          PHASE: phase,
          CONN_LOAD: item.CONN_LOAD || '',
          REPORT_AS_ON: item.REPORT_AS_ON || reportAsOnRaw,
          BASE_CLASS: cls,
          CONN_STAT: item.CONN_STAT || '',
          MRU: item.MRU || '',
          MOBILE_NO: item.MOBILE_NO || '',
          over10: over10 ? 1 : 0,
          ph3: ph3 ? 1 : 0,
          industrial: industrial ? 1 : 0,
          smart: smart ? 1 : 0,
          load_gt6: load_gt6 ? 1 : 0,
          load_3_6: load_3_6 ? 1 : 0,
          load_1_3: load_1_3 ? 1 : 0
        });
      }
    }

    var summary = Object.keys(summaryMap).map(function (k) { return summaryMap[k]; });
    summary.sort(function (a, b) {
      if (a.CCC_CODE !== b.CCC_CODE) return String(a.CCC_CODE).localeCompare(String(b.CCC_CODE));
      if (a.BASE_CLASS !== b.BASE_CLASS) return String(a.BASE_CLASS).localeCompare(String(b.BASE_CLASS));
      if (a.DEFECT_YEAR !== b.DEFECT_YEAR) return Number(b.DEFECT_YEAR) - Number(a.DEFECT_YEAR);
      return Number(a.DEFECT_MONTH) - Number(b.DEFECT_MONTH);
    });

    var withOffice = 0;
    for (i = 0; i < summary.length; i++) {
      if (String(summary[i].CCC_CODE || '').trim()) withOffice++;
    }
    if (rawRows.length > 20 && withOffice === 0) {
      throw new Error('CSV columns were not recognised. Office / class / phase / load were empty, so only a total row would be published.');
    }

    return {
      reportAsOn: reportAsOnRaw,
      sourceRows: rawRows.length,
      summaryHeaders: SUMMARY_HEADERS.slice(),
      detailsHeaders: DETAILS_HEADERS.slice(),
      summary: summary,
      details: details
    };
  }

  function parseDump(text) {
    return { rows: parseCsv(text) };
  }

  function buildFromCsvText(text) {
    return buildFromRows(parseCsv(text));
  }

  function kpiField(metricType) {
    return KPI_FIELD[metricType] || 'total';
  }

  function detailsFlag(metricType) {
    return DETAILS_FLAG[metricType] || '';
  }

  function isPriorityMetric(metricType) {
    return !!DETAILS_FLAG[metricType];
  }

  function num(row, field) {
    var n = Number(row && row[field]);
    return Number.isFinite(n) ? n : 0;
  }

  function sumField(rows, field) {
    var s = 0;
    for (var i = 0; i < rows.length; i++) s += num(rows[i], field);
    return s;
  }

  root.MzoDefectivePipeline = {
    SUMMARY_HEADERS: SUMMARY_HEADERS,
    DETAILS_HEADERS: DETAILS_HEADERS,
    parseCsv: parseCsv,
    parseDump: parseDump,
    buildFromRows: buildFromRows,
    buildFromCsvText: buildFromCsvText,
    kpiField: kpiField,
    detailsFlag: detailsFlag,
    isPriorityMetric: isPriorityMetric,
    officeFromCcc: officeFromCcc,
    num: num,
    sumField: sumField
  };
})(typeof window !== 'undefined' ? window : this);
