/**
 * Mirror NSC / Withheld / Stock dumps into this Google Spreadsheet.
 * Browser uploads write here; the PWA homepage syncs the published CSV
 * (same pattern as Loss, Collection, etc.) so Vercel never serves the megabytes.
 *
 * Deploy once per workbook (same file, set ROLE or rely on ID map below):
 *   nsc_working  → NSC_SHEET_SCRIPT_URL
 *   NSCWH        → NSC_WITHHELD_SHEET_SCRIPT_URL
 *   Stock dump   → STOCK_SHEET_SCRIPT_URL  (Sheet1 tab)
 *
 * Setup:
 * 1. Open that Google Sheet → Extensions → Apps Script → paste this file → Save.
 * 2. ROLE = 'nsc' for NSC files, ROLE = 'stock' for the Stock workbook
 *    (stock spreadsheet ID is also auto-mapped below).
 * 3. Deploy → New deployment → Web app
 *    Execute as: Me
 *    Who has access: Anyone
 * 4. After code changes: Manage deployments → pencil → New version → Deploy
 * 5. File → Share → Anyone with the link can view (needed for CSV sync).
 */
var ROLE = 'stock'; // 'nsc' | 'stock' — set to match this workbook

var NSC_TAB = 'nsc_working';
var WITHHELD_TAB = 'Sheet1';
/** Live stock dump tab on 1wDvPuAx… workbook */
var STOCK_TAB = 'Sheet1';

/** Bound spreadsheet ID → existing dump tab (avoids creating wrong sheet names). */
var TAB_BY_SPREADSHEET_ID = {
  '1QnmPKSAtwmW-m1-gn4qmZBWanx9_Vwbk63XhwyQBiKU': 'nsc_working',
  '12nS8GAQ1weIMWoEIeydcdKTKd-XwHNu9W07DKudGuOg': 'Sheet1',
  '1wDvPuAxNfdO9QzUaIUubg2JnkFM5ZleFNXQdi8s5uh0': 'Sheet1'
};

var ROLE_BY_SPREADSHEET_ID = {
  '1QnmPKSAtwmW-m1-gn4qmZBWanx9_Vwbk63XhwyQBiKU': 'nsc',
  '12nS8GAQ1weIMWoEIeydcdKTKd-XwHNu9W07DKudGuOg': 'nsc',
  '1wDvPuAxNfdO9QzUaIUubg2JnkFM5ZleFNXQdi8s5uh0': 'stock'
};

function effectiveRole_() {
  try {
    var id = SpreadsheetApp.getActiveSpreadsheet().getId();
    if (ROLE_BY_SPREADSHEET_ID[id]) return ROLE_BY_SPREADSHEET_ID[id];
  } catch (e) {}
  return ROLE;
}

function tabName_(key) {
  var k = String(key || '').toLowerCase();
  if (k === 'nsc' || k === 'pending') return NSC_TAB;
  if (k === 'withheld') return WITHHELD_TAB;
  if (k === 'stock') return STOCK_TAB;
  throw new Error('Unknown tab: ' + key);
}

function resolveTabName_(ss, key, payload) {
  var fromPayload = payload && payload.sheetName ? String(payload.sheetName).trim() : '';
  if (fromPayload) return fromPayload;
  var mapped = TAB_BY_SPREADSHEET_ID[ss.getId()];
  if (mapped) return mapped;
  var k = String(key || '').toLowerCase();
  if (!k) {
    var role = effectiveRole_();
    k = role === 'stock' ? 'stock' : 'nsc';
  }
  return tabName_(k);
}

function sheetFor_(key, payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = resolveTabName_(ss, key, payload);
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

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

function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var role = effectiveRole_();
  if (e && e.parameter && String(e.parameter.meta) === '1') {
    var raw = PropertiesService.getDocumentProperties().getProperty('nscUploadMeta') || '';
    var meta = null;
    try { meta = raw ? JSON.parse(raw) : null; } catch (err) { meta = null; }
    return jsonOut_({ status: 'ok', meta: meta });
  }
  return jsonOut_({
    status: 'ok',
    service: 'sheet-mirror',
    role: role,
    spreadsheetId: ss.getId(),
    tab: resolveTabName_(ss, role === 'stock' ? 'stock' : 'nsc', {})
  });
}

function doPost(e) {
  try {
    var payload = readPayload_(e);
    var action = String((payload && payload.action) || '').toLowerCase();
    var tab = String((payload && payload.tab) || '').toLowerCase();
    var role = effectiveRole_();

    if (role === 'nsc' && tab === 'stock') {
      return jsonOut_({ status: 'error', message: 'This web app is NSC-only. Use STOCK_SHEET_SCRIPT_URL.' });
    }
    if (role === 'stock' && tab !== 'stock' && action !== 'savemeta' && action !== 'setmeta') {
      return jsonOut_({ status: 'error', message: 'This web app is Stock-only. Use NSC_SHEET_SCRIPT_URL.' });
    }

    if (action === 'savemeta' || action === 'setmeta') {
      var meta = payload.meta || {};
      PropertiesService.getDocumentProperties().setProperty('nscUploadMeta', JSON.stringify(meta));
      return jsonOut_({ status: 'success', action: 'savemeta' });
    }

    if (action === 'begin') {
      var sh = sheetFor_(tab, payload);
      sh.clear({ contentsOnly: true });
      var headers = payload.headers || [];
      if (headers.length) {
        sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      }
      SpreadsheetApp.flush();
      return jsonOut_({ status: 'success', tab: tab, sheet: sh.getName(), rows: 0 });
    }

    if (action === 'chunk') {
      var rows = payload.rows || [];
      if (!rows.length) return jsonOut_({ status: 'success', inserted: 0 });
      var sh2 = sheetFor_(tab, payload);
      var start = Math.max(sh2.getLastRow() + 1, 2);
      var cols = rows[0].length;
      sh2.getRange(start, 1, rows.length, cols).setValues(rows);
      return jsonOut_({ status: 'success', inserted: rows.length });
    }

    if (action === 'complete') {
      SpreadsheetApp.flush();
      var sh3 = sheetFor_(tab, payload);
      return jsonOut_({
        status: 'success',
        tab: tab,
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
