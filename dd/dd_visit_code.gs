/**
 * DD Visit & Follow-Up Tracking — Google Apps Script
 *
 * Web App Endpoint to sync and store DD Visit Follow-Up records to a Google Sheet.
 *
 * Setup & Deployment Instructions:
 * 1. Open Google Sheets (or create a new Google Sheet for DD Visit Tracking).
 * 2. Extensions -> Apps Script -> Paste this code into Code.gs.
 * 3. Run setupDDVisitSheet() once in the editor to initialize headers.
 * 4. Click Deploy -> New deployment -> Select type: Web app.
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Copy the Web App URL and set it as SYNC_ENDPOINT in your dashboard configuration.
 */

var SHEET_NAME = 'DD_Visits';
var HEADERS = [
  'CON_ID',
  'INST_NO',
  'CONSUMER_NAME',
  'ADDRESS',
  'CCC_CODE',
  'CATEGORY',
  'TOTAL_OSD',
  'MOBILE',
  'VISIT_DATE',
  'VISIT_BY',
  'STATUS',
  'PAID_AMOUNT',
  'PAID_DATE',
  'REMARKS',
  'UPDATED_AT',
  'REPORT_OSD_DATE'
];

function setupDDVisitSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#f1f5f9');
  }
}

function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet || sheet.getLastRow() <= 1) {
      return responseJSON_({ status: 'success', data: {} });
    }

    var values = sheet.getDataRange().getValues();
    var headers = values[0];
    var map = {};

    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      var conId = String(row[0]).trim();
      if (!conId) continue;

      map[conId] = {
        conId: conId,
        instNo: String(row[1] || ''),
        consumerName: String(row[2] || ''),
        address: String(row[3] || ''),
        cccCode: String(row[4] || ''),
        category: String(row[5] || ''),
        totalOsd: String(row[6] || ''),
        mobile: String(row[7] || ''),
        visitDate: formatDate_(row[8]),
        visitBy: String(row[9] || ''),
        status: String(row[10] || ''),
        paidAmount: String(row[11] || ''),
        paidDate: formatDate_(row[12]),
        remarks: String(row[13] || ''),
        updatedAt: String(row[14] || ''),
        reportOsdDate: String(row[15] || '')
      };
    }

    return responseJSON_({ status: 'success', data: map });
  } catch (err) {
    return responseJSON_({ status: 'error', message: err.toString() });
  }
}

function doPost(e) {
  try {
    var postData = {};
    if (e && e.postData && e.postData.contents) {
      postData = JSON.parse(e.postData.contents);
    }
    
    var record = postData.data || postData;
    var conId = String(record.conId || record.CON_ID || '').trim();
    if (!conId) {
      return responseJSON_({ status: 'error', message: 'Missing CON_ID' });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      setupDDVisitSheet();
      sheet = ss.getSheetByName(SHEET_NAME);
    }

    var values = sheet.getDataRange().getValues();
    var targetRowIndex = -1;

    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]).trim() === conId) {
        targetRowIndex = i + 1; // 1-indexed row number
        break;
      }
    }

    var rowValues = [
      conId,
      record.instNo || record.INST_NO || '',
      record.consumerName || record.NAME || '',
      record.address || record.ADDRESS || '',
      record.cccCode || record.CCC_CODE || '',
      record.category || record.CATEGORY || '',
      record.totalOsd || record.TOTAL_OSD || '0',
      record.mobile || record.REG_MOB_NO || '',
      record.visitDate || '',
      record.visitBy || '',
      record.status || '',
      record.paidAmount || '',
      record.paidDate || '',
      record.remarks || '',
      record.updatedAt || new Date().toISOString(),
      record.reportOsdDate || ''
    ];

    if (targetRowIndex > 0) {
      sheet.getRange(targetRowIndex, 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      sheet.appendRow(rowValues);
    }

    return responseJSON_({ status: 'success', message: 'Record saved for ' + conId, data: record });
  } catch (err) {
    return responseJSON_({ status: 'error', message: err.toString() });
  }
}

function responseJSON_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function formatDate_(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(val);
}
