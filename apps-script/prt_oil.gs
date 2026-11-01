/**
 * PTR / transformer oil-test records — Google Apps Script web app.
 *
 * Bound to the spreadsheet with tabs "Map", "ptrs" and "testingrecords" (its published CSVs
 * are read by prt-oil/index.html). Deployed as a web app (Execute as: Me, Who has access: Anyone);
 * prt-oil/index.html calls it: GET ?action=getInitialData, POST action=addPTR | submitTestRecord.
 * After code changes: Manage deployments → New version → Deploy (keep the same /exec URL).
 */

// Rows of a tab as objects keyed by the header row
function getSheetData(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  return data.slice(1).map(row => Object.fromEntries(headers.map((h, i) => [h, row[i]])));
}

// Append `data` to a tab, one value per header (missing → '')
function appendByHeaders_(tabName, data) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName);
  const headers = sheet.getDataRange().getValues()[0];
  sheet.appendRow(headers.map(header => data[header] || ''));
}

// New PTR in the "ptrs" tab
function addPTR(data) {
  try {
    appendByHeaders_("ptrs", data);
    return { status: "PTR added successfully", data: data };
  } catch (error) {
    console.error('Error in addPTR:', error);
    throw error;
  }
}

// New oil-test record in the "testingrecords" tab
function submitTestRecord(data) {
  try {
    appendByHeaders_("testingrecords", data);
    return { status: "Test record submitted successfully", data: data };
  } catch (error) {
    console.error('Error in submitTestRecord:', error);
    throw error;
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// GET ?action=getInitialData → { map, ptrs }
function doGet(e) {
  try {
    if (e.parameter.action === 'getInitialData') {
      return json_({ map: getSheetData("Map"), ptrs: getSheetData("ptrs") });
    }
    return json_({ error: "Invalid request" });
  } catch (err) {
    return json_({ error: err.message });
  }
}

// POST action=addPTR | submitTestRecord with data=<JSON> (form field) or a JSON body
function doPost(e) {
  try {
    const action = e.parameter.action;
    if (!action) return json_({ error: "No action specified" });

    let payload;
    if (e.parameter.data) {
      payload = JSON.parse(e.parameter.data);
    } else if (e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    } else {
      return json_({ error: "No data provided" });
    }

    let result;
    if (action === 'submitTestRecord') {
      result = submitTestRecord(payload);
    } else if (action === 'addPTR') {
      result = addPTR(payload);
    } else {
      return json_({ error: "Invalid action: " + action });
    }
    return json_(result);
  } catch (err) {
    return json_({ error: err.message, stack: err.stack });
  }
}
