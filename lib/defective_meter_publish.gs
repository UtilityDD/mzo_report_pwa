/**
 * Defective Meter → this Google Spreadsheet (tabs: summary, details).
 * Bound to: https://docs.google.com/spreadsheets/d/1dMLSX2bZBqZMPooh7_CrniCjqgy4MijaFW62GKJJldA
 *
 * Same pattern as NSC (lib/sheet_mirror_publish.gs): JSON only, no HtmlService.
 *
 * Setup:
 * 1. Open that sheet → Extensions → Apps Script → paste this file → Save.
 * 2. Deploy → New deployment → Web app
 *    Execute as: Me
 *    Who has access: Anyone
 * 3. After code changes: Manage deployments → pencil → New version → Deploy
 *    Keep the same /exec URL.
 * 4. File → Share → Anyone with the link can view (needed for CSV read).
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

function exportCsvUrl_(ss, gid) {
  return 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=csv&gid=' + gid;
}

function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var summary = ss.getSheetByName('summary');
  var details = ss.getSheetByName('details');
  var summaryGid = summary ? summary.getSheetId() : 0;
  var detailsGid = details ? details.getSheetId() : 0;
  if (e && e.parameter && String(e.parameter.meta) === '1') {
    var raw = PropertiesService.getDocumentProperties().getProperty('defectiveUploadMeta') || '';
    var meta = null;
    try { meta = raw ? JSON.parse(raw) : null; } catch (err) { meta = null; }
    return jsonOut_({
      status: 'ok',
      meta: meta,
      spreadsheetId: ss.getId(),
      summaryGid: summaryGid,
      detailsGid: detailsGid,
      summaryCsvUrl: exportCsvUrl_(ss, summaryGid),
      detailsCsvUrl: exportCsvUrl_(ss, detailsGid)
    });
  }
  return jsonOut_({
    status: 'ok',
    service: 'defective-meter-mirror',
    spreadsheetId: ss.getId(),
    tabs: ['summary', 'details'],
    summaryGid: summaryGid,
    detailsGid: detailsGid
  });
}

function seqKey_(payload) {
  var name = payload && payload.sheetName ? String(payload.sheetName).trim() : '';
  if (!name) name = payload && payload.tab ? String(payload.tab).trim() : 'tab';
  return 'defectiveChunkSeq_' + name;
}

function doPost(e) {
  try {
    var payload = readPayload_(e);
    var action = String((payload && payload.action) || '').toLowerCase();
    var props = PropertiesService.getDocumentProperties();

    if (action === 'savemeta' || action === 'setmeta') {
      var meta = payload.meta || {};
      props.setProperty('defectiveUploadMeta', JSON.stringify(meta));
      return jsonOut_({ status: 'success', action: 'savemeta' });
    }

    if (action === 'begin') {
      var sh = sheetFor_(payload);
      sh.clear({ contentsOnly: true });
      var headers = payload.headers || [];
      if (headers.length) {
        sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      }
      props.setProperty(seqKey_(payload), '-1');
      SpreadsheetApp.flush();
      return jsonOut_({ status: 'success', sheet: sh.getName(), rows: 0 });
    }

    if (action === 'chunk') {
      var rows = payload.rows || [];
      if (!rows.length) return jsonOut_({ status: 'success', inserted: 0 });
      var seq = Number(payload.chunkSeq);
      var last = Number(props.getProperty(seqKey_(payload)) || '-1');
      if (Number.isFinite(seq) && seq <= last) {
        return jsonOut_({ status: 'success', inserted: 0, skipped: true });
      }
      var sh2 = sheetFor_(payload);
      var start = Math.max(sh2.getLastRow() + 1, 2);
      var cols = rows[0].length;
      sh2.getRange(start, 1, rows.length, cols).setValues(rows);
      if (Number.isFinite(seq)) props.setProperty(seqKey_(payload), String(seq));
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
