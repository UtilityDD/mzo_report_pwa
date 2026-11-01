/**
 * NSC dump mirror + application follow-ups, one web app.
 * Paste over the existing Apps Script on the nsc_working spreadsheet.
 * Deploy → Manage deployments → pencil → New version → Deploy (same /exec URL).
 *
 * begin / chunk / complete still rewrite the dump tab.
 * Follow-up notes go to a separate tab named Followups.
 * Do not paste this over the Withheld or Stock web apps.
 */
var ROLE = 'nsc'; // 'nsc' | 'stock'

var NSC_TAB = 'nsc_working';
var WITHHELD_TAB = 'Sheet1';
var STOCK_TAB = 'Stock';
var FOLLOWUP_TAB = 'Followups';
var FOLLOWUP_HEADERS = ['id', 'appl_no', 'at', 'by', 'note', 'deleted'];

/** Bound spreadsheet ID → existing tab (avoids creating a new "NSC" / "Withheld" sheet). */
var TAB_BY_SPREADSHEET_ID = {
  '1QnmPKSAtwmW-m1-gn4qmZBWanx9_Vwbk63XhwyQBiKU': 'nsc_working',
  '12nS8GAQ1weIMWoEIeydcdKTKd-XwHNu9W07DKudGuOg': 'Sheet1'
};

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
  return tabName_(key);
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

function clip_(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function followupSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(FOLLOWUP_TAB);
  if (!sh) {
    sh = ss.insertSheet(FOLLOWUP_TAB);
    sh.getRange(1, 1, 1, FOLLOWUP_HEADERS.length).setValues([FOLLOWUP_HEADERS]);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, FOLLOWUP_HEADERS.length).setValues([FOLLOWUP_HEADERS]);
  }
  return sh;
}

function listComments_() {
  var sh = followupSheet_();
  var values = sh.getDataRange().getValues();
  var comments = [];
  var deletedIds = [];
  for (var i = 1; i < values.length; i++) {
    var id = clip_(values[i][0], 80);
    if (!id) continue;
    var deleted = clip_(values[i][5], 8);
    if (deleted === '1' || deleted.toLowerCase() === 'true') {
      deletedIds.push(id);
      continue;
    }
    var note = clip_(values[i][4], 500);
    var applNo = clip_(values[i][1], 40);
    if (!note || !applNo) continue;
    comments.push({
      id: id,
      applNo: applNo,
      at: clip_(values[i][2], 40),
      by: clip_(values[i][3], 80),
      note: note
    });
  }
  return { comments: comments, deletedIds: deletedIds };
}

function findFollowupRow_(sh, id) {
  var ids = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues();
  for (var i = 1; i < ids.length; i++) {
    if (clip_(ids[i][0], 80) === id) return i + 1;
  }
  return 0;
}

function addComment_(data) {
  var id = clip_(data.id, 80);
  var applNo = clip_(data.applNo || data.appl_no, 40);
  var note = clip_(data.note, 500);
  if (!id || !applNo || !note) return { status: 'error', message: 'Missing follow-up fields.' };
  var sh = followupSheet_();
  if (findFollowupRow_(sh, id)) return { status: 'success', id: id, duplicate: true };
  sh.appendRow([id, applNo, clip_(data.at, 40), clip_(data.by, 80), note, '']);
  return { status: 'success', id: id };
}

function deleteComment_(data) {
  var id = clip_(data.id, 80);
  if (!id) return { status: 'error', message: 'Missing follow-up id.' };
  var sh = followupSheet_();
  var row = findFollowupRow_(sh, id);
  if (row) sh.getRange(row, 6).setValue('1');
  return { status: 'success', id: id };
}

function handleFollowup_(action, payload) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    if (action === 'add') return addComment_(payload);
    if (action === 'delete') return deleteComment_(payload);
    return { status: 'error', message: 'Unknown follow-up action.' };
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

function doGet(e) {
  if (ROLE === 'nsc' && e && e.parameter && String(e.parameter.list) === '1') {
    var listed = listComments_();
    return jsonOut_({
      status: 'success',
      service: 'nsc-followup',
      comments: listed.comments,
      deletedIds: listed.deletedIds
    });
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return jsonOut_({
    status: 'ok',
    service: 'sheet-mirror',
    role: ROLE,
    spreadsheetId: ss.getId(),
    tab: resolveTabName_(ss, ROLE === 'stock' ? 'stock' : '', {})
  });
}

function doPost(e) {
  try {
    var payload = readPayload_(e);
    var action = String((payload && payload.action) || '').toLowerCase();
    var tab = String((payload && payload.tab) || '').toLowerCase();

    if (ROLE === 'nsc' && (action === 'add' || action === 'delete')) {
      return jsonOut_(handleFollowup_(action, payload));
    }

    if (ROLE === 'nsc' && tab === 'stock') {
      return jsonOut_({ status: 'error', message: 'This web app is NSC-only. Use STOCK_SHEET_SCRIPT_URL.' });
    }
    if (ROLE === 'stock' && tab !== 'stock') {
      return jsonOut_({ status: 'error', message: 'This web app is Stock-only. Use NSC_SHEET_SCRIPT_URL.' });
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
