/**
 * Material Allotment / Diversion — Google Apps Script
 *
 * Supports allotment from Zone OR diversion from one Division to another.
 * Also supports listing / searching saved allotments for the portal viewer.
 *
 * Setup:
 * 1. Open the Stock Google Spreadsheet.
 * 2. Extensions → Apps Script → paste this file.
 * 3. Run setupAllotmentSheet() once.
 * 4. Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone)
 * 5. After code changes: Manage deployments → Edit → New version → Deploy
 */

var ALLOTMENTS_SHEET = 'Allotments';
var META_SHEET = '_AllotMeta';
var HEADERS = [
  'AllotmentNo',
  'Date',
  'MovementType',
  'FromStore',
  'FromPlantCode',
  'Division',
  'PlantCode',
  'MaterialCode',
  'MaterialDescription',
  'Unit',
  'PresentStockDiv',
  'SourceStockAtAllot',
  'ZoneStockAtAllot',
  'AllottedQty',
  'Remarks',
  'CreatedBy',
  'CreatedAt'
];

function setupAllotmentSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var allot = ss.getSheetByName(ALLOTMENTS_SHEET);
  if (!allot) {
    allot = ss.insertSheet(ALLOTMENTS_SHEET);
  }
  ensureHeaders_(allot);
  allot.setFrozenRows(1);

  var meta = ss.getSheetByName(META_SHEET);
  if (!meta) {
    meta = ss.insertSheet(META_SHEET);
    meta.getRange('A1').setValue('NextSeq');
    meta.getRange('B1').setValue(1);
    meta.getRange('A2').setValue('Year');
    meta.getRange('B2').setValue(new Date().getFullYear());
  }
}

function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    return;
  }
  var existing = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
  var map = {};
  existing.forEach(function (h, i) {
    if (h) map[String(h)] = i + 1;
  });
  HEADERS.forEach(function (h) {
    if (!map[h]) {
      var col = sheet.getLastColumn() + 1;
      sheet.getRange(1, col).setValue(h);
      map[h] = col;
    }
  });
}

function ensureSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(ALLOTMENTS_SHEET) || !ss.getSheetByName(META_SHEET)) {
    setupAllotmentSheet();
  } else {
    ensureHeaders_(ss.getSheetByName(ALLOTMENTS_SHEET));
  }
}

function nextAllotmentNo_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureSheets_();
    var meta = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(META_SHEET);
    var year = new Date().getFullYear();
    var storedYear = Number(meta.getRange('B2').getValue()) || year;
    var seq = Number(meta.getRange('B1').getValue()) || 1;
    if (storedYear !== year) {
      storedYear = year;
      seq = 1;
      meta.getRange('B2').setValue(year);
    }
    var padded = ('0000' + seq).slice(-4);
    var allotmentNo = 'MZO/ALT/' + year + '/' + padded;
    meta.getRange('B1').setValue(seq + 1);
    return allotmentNo;
  } finally {
    lock.releaseLock();
  }
}

function headerIndexMap_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), HEADERS.length);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  headers.forEach(function (h, i) {
    if (h) map[String(h)] = i;
  });
  return { map: map, width: lastCol };
}

function formatCellDate_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'Asia/Kolkata', 'yyyy-MM-dd');
  }
  return v == null ? '' : String(v);
}

function rowToObj_(headers, row) {
  var o = {};
  headers.forEach(function (h, i) {
    if (!h) return;
    var key = String(h);
    var v = row[i];
    if (key === 'Date' || key === 'CreatedAt') {
      o[key] = formatCellDate_(v);
    } else if (key === 'AllottedQty' || key === 'PresentStockDiv' || key === 'SourceStockAtAllot' || key === 'ZoneStockAtAllot') {
      o[key] = v === '' || v == null ? '' : Number(v);
      if (isNaN(o[key])) o[key] = v;
    } else {
      o[key] = v == null ? '' : v;
    }
  });
  return o;
}

function readAllotmentRows_() {
  ensureSheets_();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ALLOTMENTS_SHEET);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var obj = rowToObj_(headers, values[i]);
    if (!obj.AllotmentNo) continue;
    rows.push(obj);
  }
  return rows;
}

function norm_(s) {
  return String(s || '').toLowerCase().trim();
}

function filterAllotmentRows_(rows, payload) {
  payload = payload || {};
  var q = norm_(payload.q || payload.query || '');
  var allotmentNo = norm_(payload.allotmentNo || payload.AllotmentNo || '');
  var material = norm_(payload.material || payload.MaterialCode || '');
  var division = norm_(payload.division || payload.Division || '');
  var fromStore = norm_(payload.fromStore || payload.FromStore || '');
  var dateFrom = String(payload.dateFrom || payload.from || '').trim();
  var dateTo = String(payload.dateTo || payload.to || '').trim();

  return rows.filter(function (r) {
    var no = norm_(r.AllotmentNo);
    var code = norm_(r.MaterialCode);
    var desc = norm_(r.MaterialDescription);
    var div = norm_(r.Division);
    var from = norm_(r.FromStore);
    var date = String(r.Date || '').slice(0, 10);
    var remarks = norm_(r.Remarks);
    var createdBy = norm_(r.CreatedBy);

    if (allotmentNo && no.indexOf(allotmentNo) === -1) return false;
    if (material && code.indexOf(material) === -1 && desc.indexOf(material) === -1) return false;
    if (division && div.indexOf(division) === -1) return false;
    if (fromStore && from.indexOf(fromStore) === -1) return false;
    if (dateFrom && date && date < dateFrom) return false;
    if (dateTo && date && date > dateTo) return false;

    if (q) {
      var blob = [no, code, desc, div, from, remarks, createdBy, date].join(' ');
      if (blob.indexOf(q) === -1) return false;
    }
    return true;
  });
}

function createAllotment(payload) {
  ensureSheets_();
  var rows = payload.rows || payload.Rows;
  if (!rows || !rows.length) {
    throw new Error('No allotment rows provided');
  }

  var allotmentNo = nextAllotmentNo_();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ALLOTMENTS_SHEET);
  var createdBy = payload.createdBy || payload.CreatedBy || '';
  var createdAt = new Date().toISOString();
  var dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Kolkata', 'yyyy-MM-dd');
  var meta = headerIndexMap_(sheet);
  var matrix = [];

  rows.forEach(function (r) {
    var rowArr = [];
    for (var i = 0; i < meta.width; i++) rowArr.push('');
    function put(header, value) {
      if (meta.map[header] != null) rowArr[meta.map[header]] = value != null ? value : '';
    }
    put('AllotmentNo', allotmentNo);
    put('Date', dateStr);
    put('MovementType', r.MovementType || '');
    put('FromStore', r.FromStore || '');
    put('FromPlantCode', r.FromPlantCode || '');
    put('Division', r.Division || '');
    put('PlantCode', r.PlantCode || '');
    put('MaterialCode', r.MaterialCode || '');
    put('MaterialDescription', r.MaterialDescription || '');
    put('Unit', r.Unit || '');
    put('PresentStockDiv', r.PresentStockDiv != null ? r.PresentStockDiv : '');
    put('SourceStockAtAllot', r.SourceStockAtAllot != null ? r.SourceStockAtAllot : (r.ZoneStockAtAllot != null ? r.ZoneStockAtAllot : ''));
    put('ZoneStockAtAllot', r.ZoneStockAtAllot != null ? r.ZoneStockAtAllot : (r.SourceStockAtAllot != null ? r.SourceStockAtAllot : ''));
    put('AllottedQty', r.AllottedQty != null ? r.AllottedQty : '');
    put('Remarks', r.Remarks || '');
    put('CreatedBy', createdBy);
    put('CreatedAt', createdAt);
    matrix.push(rowArr);
  });

  // One batch write (much faster than appendRow per line)
  var startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, matrix.length, meta.width).setValues(matrix);

  return {
    status: 'success',
    allotmentNo: allotmentNo,
    rowsWritten: rows.length
  };
}

function listAllotments(payload) {
  var all = readAllotmentRows_();
  var rows = filterAllotmentRows_(all, payload || {});
  // Newest first
  rows.sort(function (a, b) {
    var da = String(a.Date || '');
    var db = String(b.Date || '');
    if (da !== db) return db.localeCompare(da);
    return String(b.AllotmentNo || '').localeCompare(String(a.AllotmentNo || ''));
  });
  return {
    status: 'success',
    rows: rows,
    count: rows.length
  };
}

function getAllotment(payload) {
  var no = String((payload && (payload.allotmentNo || payload.AllotmentNo)) || '').trim();
  if (!no) throw new Error('allotmentNo is required');
  var rows = readAllotmentRows_().filter(function (r) {
    return String(r.AllotmentNo || '') === no;
  });
  if (!rows.length) {
    return { status: 'error', error: 'Allotment not found: ' + no };
  }
  return {
    status: 'success',
    allotmentNo: no,
    rows: rows,
    count: rows.length
  };
}

function csvEscape_(v) {
  var s = v == null ? '' : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function allotmentsToCsv_() {
  var rows = readAllotmentRows_();
  var lines = [HEADERS.join(',')];
  rows.forEach(function (r) {
    lines.push(HEADERS.map(function (h) { return csvEscape_(r[h]); }).join(','));
  });
  return lines.join('\n');
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    var action = params.action || '';
    if (params.format === 'csv' || action === 'exportCsv') {
      return ContentService
        .createTextOutput(allotmentsToCsv_())
        .setMimeType(ContentService.MimeType.CSV);
    }
    if (action === 'listAllotments') {
      return jsonOut_(listAllotments(params));
    }
    if (action === 'getAllotment') {
      return jsonOut_(getAllotment(params));
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var allot = ss.getSheetByName(ALLOTMENTS_SHEET);
    return jsonOut_({
      status: 'ok',
      service: 'stock-allotment',
      spreadsheetId: ss.getId(),
      allotmentsSheetId: allot ? allot.getSheetId() : null
    });
  } catch (err) {
    return jsonOut_({ error: err.message, status: 'error' });
  }
}

function doPost(e) {
  try {
    var payload = {};
    if (e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    } else if (e.parameter && e.parameter.data) {
      payload = JSON.parse(e.parameter.data);
    }

    var action = (payload && payload.action) || (e.parameter && e.parameter.action) || '';
    if (action === 'createAllotment') {
      return jsonOut_(createAllotment(payload));
    }
    if (action === 'listAllotments') {
      return jsonOut_(listAllotments(payload));
    }
    if (action === 'getAllotment') {
      return jsonOut_(getAllotment(payload));
    }
    return jsonOut_({ error: 'Invalid action: ' + action });
  } catch (err) {
    return jsonOut_({ error: err.message, status: 'error' });
  }
}
