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

  function parseYmd(s) {
    var t = String(s == null ? '' : s).trim();
    if (!t || t.length !== 8 || t === '00000000') return null;
    var y = +t.slice(0, 4);
    var m = +t.slice(4, 6) - 1;
    var d = +t.slice(6, 8);
    if (!y || m < 0 || m > 11 || !d) return null;
    return new Date(y, m, d);
  }

  function parseCsv(text) {
    var rows = [];
    var field = '';
    var row = [];
    var q = false;
    var s = String(text || '');
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      var n = s[i + 1];
      if (c === '"') {
        if (q && n === '"') { field += '"'; i++; }
        else q = !q;
      } else if (c === ',' && !q) {
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
    if (!rows.length) return [];
    var headers = rows[0].map(function (h) { return String(h || '').trim(); });
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      var obj = {};
      for (var h = 0; h < headers.length; h++) obj[headers[h]] = rows[r][h] != null ? rows[r][h] : '';
      out.push(obj);
    }
    return out;
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
      var ccc = String(item.CCC_CODE || '').trim();
      var cls = String(item.BASE_CLASS || '').trim();
      var phase = String(item.PHASE || '').trim();
      var meter = String(item.METER_NO || '').trim();
      var load = parseFloat(item.CONN_LOAD || 0);
      if (!isFinite(load)) load = 0;
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
      var industrial = cls === 'I';
      var smart = /^(IJ|IL|IT)/i.test(meter);
      var agri = cls === 'A';
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
