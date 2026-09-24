/**
 * Shared Pending NSC follow-ups. One row per note, matched later by application number.
 *
 * Paste into the NSC Google Sheet → Extensions → Apps Script → Save.
 * Deploy → New deployment → Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * Then set Vercel env NSC_FOLLOWUP_SCRIPT_URL to that /exec URL.
 * After code changes: Manage deployments → New version → Deploy.
 *
 * Tab "Followups" is created on first save. Do not put these rows on the working dump tab.
 */
var FOLLOWUP_TAB = 'Followups';
var FOLLOWUP_HEADERS = ['id', 'appl_no', 'at', 'by', 'note', 'deleted'];

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function readPayload_(e) {
  if (e && e.parameter && e.parameter.data) return JSON.parse(e.parameter.data);
  if (e && e.postData && e.postData.contents) {
    var raw = String(e.postData.contents || '');
    if (raw.charAt(0) === '{') return JSON.parse(raw);
    var m = raw.match(/(?:^|&)data=([^&]*)/);
    if (m) return JSON.parse(decodeURIComponent(m[1].replace(/\+/g, ' ')));
  }
  return {};
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

function clip_(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
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

function findRow_(sh, id) {
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
  if (findRow_(sh, id)) return { status: 'success', id: id, duplicate: true };
  sh.appendRow([id, applNo, clip_(data.at, 40), clip_(data.by, 80), note, '']);
  return { status: 'success', id: id };
}

function deleteComment_(data) {
  var id = clip_(data.id, 80);
  if (!id) return { status: 'error', message: 'Missing follow-up id.' };
  var sh = followupSheet_();
  var row = findRow_(sh, id);
  if (row) sh.getRange(row, 6).setValue('1');
  return { status: 'success', id: id };
}

function doGet(e) {
  try {
    var listed = listComments_();
    return jsonOut_({
      status: 'success',
      service: 'nsc-followup',
      comments: listed.comments,
      deletedIds: listed.deletedIds
    });
  } catch (err) {
    return jsonOut_({ status: 'error', message: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var data = readPayload_(e);
    var action = String(data.action || '').toLowerCase();
    if (action === 'ping') return jsonOut_({ status: 'success', service: 'nsc-followup' });
    if (action === 'add') return jsonOut_(addComment_(data));
    if (action === 'delete') return jsonOut_(deleteComment_(data));
    return jsonOut_({ status: 'error', message: 'Unknown action.' });
  } catch (err) {
    return jsonOut_({ status: 'error', message: String(err && err.message ? err.message : err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}
