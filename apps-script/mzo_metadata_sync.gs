/**
 * MZO Reports — Central Metadata Sync & Version Feed (Google Apps Script)
 *
 * Deployment Instructions:
 * 1. Create a new Google Apps Script or open an existing master project.
 * 2. Paste this code into your script editor (Code.gs).
 * 3. Deploy as Web App ("Execute as: Me", "Who has access: Anyone").
 * 4. Copy the Web App URL and set the environment variable METADATA_SCRIPT_URL
 *    in Vercel / server environment.
 */

// Registry of source sheets and cell/date targets
const REPORT_SOURCES = {
  'CACHE_BHARATNET': {
    name: 'Bharat Net Connections',
    sheetId: '12nS8GAQ1weIMWoEIeydcdKTKd-XwHNu9W07DKudGuOg',
    cellTarget: 'N2', // Update date cell
    type: 'cell'
  },
  'CACHE_ICDS_APLUS': {
    name: 'ICDS Connections (A+)',
    sheetId: '12nS8GAQ1weIMWoEIeydcdKTKd-XwHNu9W07DKudGuOg',
    gid: '1839469967',
    cellTarget: 'M2',
    type: 'cell'
  },
  'CACHE_LOSS': {
    name: 'Loss Report',
    sheetId: '12nS8GAQ1weIMWoEIeydcdKTKd-XwHNu9W07DKudGuOg',
    cellTarget: 'J2',
    type: 'cell'
  },
  'CACHE_DISCONNECTION': {
    name: 'Disconnection Tracker',
    sheetId: '12nS8GAQ1weIMWoEIeydcdKTKd-XwHNu9W07DKudGuOg',
    dateColumn: 'PAID/DISCON DATE',
    type: 'max_date'
  },
  'CACHE_PMSGY_MALDA': {
    name: 'PM Surya Ghar',
    url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRcFPRu1ywimetADU-XYIZ_x3McWUhR5ZbPUIIySO6_V8VJTyU9Vhw8DD-1RBEPFj0q2pUFMvutYV30/pub?gid=1969412059&single=true&output=csv',
    dateColumn: 'Last Action Date',
    type: 'max_date'
  },
  'METER': {
    name: 'Meter Utilization',
    url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRZPPnIF-T7wgii6J35a-3Wz7RC86Zq-eMSQud795CVJV-92Vy9oJjO6TDpjpgiLNAVPcVn6X_keILV/pub?gid=2125422147&single=true&output=csv',
    dateColumn: 'Posting Date',
    type: 'max_date'
  },
  'CACHE_CAPEX': {
    name: 'Capex Details',
    url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQI2neSVbvMR4fF910Q0AWUcq02leP-sob8q4f9goT46hgLutCpxCjSL6y6X3s2vYBJRNN7WrFCjE0R/pub?gid=439685010&single=true&output=csv',
    dateColumn: 'Reporting Date',
    type: 'max_date'
  },
  'OM_ADVANCE': {
    name: 'O&M Advance',
    url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQPBYq0ZQpaAnu0Mp_qN5oGvklgIpjolyRPf3LfSojRaN-GBBBXKHslR9ue1DOv1432oP2PzYznUUmn/pub?gid=512034300&single=true&output=csv',
    dateColumn: 'Creation Date',
    type: 'max_date'
  }
};

/**
 * Web App entry point — returns all aggregated report update dates as JSON.
 */
function doGet(e) {
  try {
    const metaData = getOrUpdateCachedMetadata();
    const output = JSON.stringify({
      status: 'success',
      timestamp: new Date().toISOString(),
      versions: metaData.versions,
      reports: metaData.reports
    });
    
    return ContentService.createTextOutput(output)
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    const errOutput = JSON.stringify({
      status: 'error',
      message: err.toString()
    });
    return ContentService.createTextOutput(errOutput)
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Time-driven trigger or manual refresh function.
 * Collects update dates from registered Google Sheets and stores them in ScriptProperties.
 */
function refreshReportMetadata() {
  const versions = {};
  const reports = {};

  const propStore = PropertiesService.getScriptProperties();

  Object.keys(REPORT_SOURCES).forEach(function(key) {
    const cfg = REPORT_SOURCES[key];
    let dateVal = '';

    try {
      if (cfg.url) {
        const resp = UrlFetchApp.fetch(cfg.url, { muteHttpExceptions: true });
        if (resp.getResponseCode() === 200) {
          const csvText = resp.getContentText();
          if (cfg.type === 'max_date' && cfg.dateColumn) {
            dateVal = findMaxDateInCsvText_(csvText, cfg.dateColumn);
          }
        }
      } else if (cfg.sheetId) {
        const ss = SpreadsheetApp.openById(cfg.sheetId);
        const sheet = cfg.gid ? getSheetByGid_(ss, cfg.gid) : ss.getSheets()[0];

        if (sheet && cfg.type === 'cell' && cfg.cellTarget) {
          const raw = sheet.getRange(cfg.cellTarget).getValue();
          dateVal = formatDateString_(raw);
        } else if (sheet && cfg.type === 'max_date') {
          dateVal = findMaxDateInSheet_(sheet, cfg.dateColumn);
        }

        if (!dateVal && sheet) {
          // Fallback to sheet last modified time
          dateVal = formatDateString_(ss.getLastUpdated());
        }
      }
    } catch (err) {
      Logger.log('Error reading ' + key + ': ' + err.toString());
      dateVal = propStore.getProperty('date_' + key) || '';
    }

    if (dateVal) {
      versions[key] = dateVal;
      reports[key] = {
        name: cfg.name || key,
        date: dateVal,
        updatedAt: new Date().toISOString()
      };
      propStore.setProperty('date_' + key, dateVal);
    }
  });

  const payload = {
    updatedAt: new Date().toISOString(),
    versions: versions,
    reports: reports
  };

  propStore.setProperty('MZO_METADATA_CACHE', JSON.stringify(payload));
  return payload;
}

/**
 * Reads cache from ScriptProperties or forces a refresh if stale.
 */
function getOrUpdateCachedMetadata() {
  const propStore = PropertiesService.getScriptProperties();
  const raw = propStore.getProperty('MZO_METADATA_CACHE');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const ageMs = Date.now() - new Date(parsed.updatedAt).getTime();
      // If cache is less than 15 minutes old, return it directly
      if (ageMs < 15 * 60 * 1000) {
        return parsed;
      }
    } catch (e) {}
  }
  return refreshReportMetadata();
}

/**
 * Helper to find sheet by GID
 */
function getSheetByGid_(ss, targetGid) {
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (String(sheets[i].getSheetId()) === String(targetGid)) {
      return sheets[i];
    }
  }
  return sheets[0];
}

/**
 * Format date values to dd/mm/yyyy
 */
function formatDateString_(val) {
  if (!val) return '';
  if (val instanceof Date) {
    const day = String(val.getDate()).padStart(2, '0');
    const month = String(val.getMonth() + 1).padStart(2, '0');
    const year = val.getFullYear();
    return day + '/' + month + '/' + year;
  }
  const s = String(val).trim();
  const match = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (match) {
    const d = String(match[1]).padStart(2, '0');
    const m = String(match[2]).padStart(2, '0');
    const y = match[3].length === 2 ? '20' + match[3] : match[3];
    return d + '/' + m + '/' + y;
  }
  return s;
}

/**
 * Find maximum date in a specific column name
 */
function findMaxDateInSheet_(sheet, colName) {
  const data = sheet.getDataRange().getValues();
  if (!data || data.length < 2) return '';
  const headers = data[0].map(function(h) { return String(h).trim().toUpperCase(); });
  const colIdx = headers.indexOf(String(colName).toUpperCase());
  if (colIdx === -1) return '';

  let maxTime = 0;
  let maxStr = '';

  for (let i = 1; i < data.length; i++) {
    const val = data[i][colIdx];
    if (!val) continue;
    if (val instanceof Date) {
      if (val.getTime() > maxTime) {
        maxTime = val.getTime();
        maxStr = formatDateString_(val);
      }
    } else {
      const formatted = formatDateString_(val);
      if (formatted) {
        const parts = formatted.split('/');
        if (parts.length === 3) {
          const t = new Date(parts[2], parts[1] - 1, parts[0]).getTime();
          if (t > maxTime) {
            maxTime = t;
            maxStr = formatted;
          }
        }
      }
    }
  }
  return maxStr;
}

/**
 * Find maximum date in a CSV text payload by column name
 */
function findMaxDateInCsvText_(csvText, colName) {
  if (!csvText) return '';
  const lines = String(csvText).split(/\r?\n/);
  if (lines.length < 2) return '';
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const headers = lines[0].split(',').map(function(h) { return String(h || '').replace(/"/g, '').trim().toUpperCase(); });
  const colIdx = headers.indexOf(String(colName).toUpperCase());
  if (colIdx === -1) return '';

  let maxTime = 0;
  let maxStr = '';

  for (let i = 1; i < lines.length; i++) {
    const raw = String(lines[i].split(',')[colIdx] || '').replace(/"/g, '').trim();
    if (!raw) continue;
    const named = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/);
    const num = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
    let d = 0, m = 0, y = 0;
    if (named && months[named[2].toLowerCase()]) {
      d = +named[1]; m = months[named[2].toLowerCase()]; y = +named[3] < 100 ? 2000 + +named[3] : +named[3];
    } else if (num) {
      d = +num[1]; m = +num[2]; y = +num[3] < 100 ? 2000 + +num[3] : +num[3];
    }
    if (d && m && y) {
      const t = Date.UTC(y, m - 1, d);
      if (t > maxTime) {
        maxTime = t;
        maxStr = String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0') + '/' + y;
      }
    }
  }
  return maxStr;
}
