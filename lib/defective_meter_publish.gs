/**
 * Defective Meter → this Google Spreadsheet (tabs: summary, details).
 * Bound to: https://docs.google.com/spreadsheets/d/1dMLSX2bZBqZMPooh7_CrniCjqgy4MijaFW62GKJJldA
 *
 * Setup (once):
 * 1. Open that sheet → Extensions → Apps Script → paste this file → Save.
 * 2. Deploy → New deployment → Web app
 *    Execute as: Me
 *    Who has access: Anyone
 * 3. Copy the /exec URL into defective_meter.html / server.js
 *    Current: https://script.google.com/macros/s/AKfycbzULRzoJRMlt_x3nlEo6RLFVzELgwAD5Z7f8JuvqwxBgC6cpc0BF7dynKwBg0hNIkBn/exec
 * 4. File → Share → Anyone with the link can view (needed for CSV read).
 * 5. After code changes: Manage deployments → pencil → New version → Deploy
 */
var ALLOWED_TABS = { summary: true, details: true };

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function readPayload_(e) {
  if (e && e.parameter && e.parameter.data) {
    return JSON.parse(e.parameter.data);
  }
  if (e && e.postData && e.postData.contents) {
    var raw = e.postData.contents;
    if (raw.charAt(0) === '{') return JSON.parse(raw);
    var m = raw.match(/(?:^|&)data=([^&]*)/);
    if (m) return JSON.parse(decodeURIComponent(m[1].replace(/\+/g, ' ')));
  }
  return {};
}

function sheetFor_(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = payload && payload.sheetName ? String(payload.sheetName).trim() : '';
  if (!name) name = payload && payload.tab ? String(payload.tab).trim() : '';
  if (!ALLOWED_TABS[name]) throw new Error('Unknown tab: ' + name + ' (use summary or details)');
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (e && e.parameter && String(e.parameter.meta) === '1') {
    var raw = PropertiesService.getDocumentProperties().getProperty('defectiveUploadMeta') || '';
    var meta = null;
    try { meta = raw ? JSON.parse(raw) : null; } catch (err) { meta = null; }
    return jsonOut_({ status: 'ok', meta: meta, spreadsheetId: ss.getId() });
  }
  return jsonOut_({
    status: 'ok',
    service: 'defective-meter-mirror',
    spreadsheetId: ss.getId(),
    tabs: ['summary', 'details']
  });
}

function doPost(e) {
  try {
    var payload = readPayload_(e);
    var action = String((payload && payload.action) || '').toLowerCase();

    if (action === 'savemeta' || action === 'setmeta') {
      var meta = payload.meta || {};
      PropertiesService.getDocumentProperties().setProperty('defectiveUploadMeta', JSON.stringify(meta));
      return jsonOut_({ status: 'success', action: 'savemeta' });
    }

    if (action === 'begin') {
      var sh = sheetFor_(payload);
      sh.clear({ contentsOnly: true });
      var headers = payload.headers || [];
      if (headers.length) {
        sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      }
      SpreadsheetApp.flush();
      return jsonOut_({ status: 'success', sheet: sh.getName(), rows: 0 });
    }

    if (action === 'chunk') {
      var rows = payload.rows || [];
      if (!rows.length) return jsonOut_({ status: 'success', inserted: 0 });
      var sh2 = sheetFor_(payload);
      var start = Math.max(sh2.getLastRow() + 1, 2);
      var cols = rows[0].length;
      sh2.getRange(start, 1, rows.length, cols).setValues(rows);
      return jsonOut_({ status: 'success', inserted: rows.length });
    }

    if (action === 'complete') {
      SpreadsheetApp.flush();
      var sh3 = sheetFor_(payload);
      return jsonOut_({
        status: 'success',
        sheet: sh3.getName(),
        rows: Math.max(0, sh3.getLastRow() - 1),
        spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
        gid: sh3.getSheetId()
      });
    }

    return jsonOut_({ status: 'error', message: 'Invalid action: ' + action });
  } catch (err) {
    return jsonOut_({ status: 'error', message: String(err && err.message ? err.message : err) });
  }
}
