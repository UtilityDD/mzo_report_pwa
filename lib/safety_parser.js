'use strict';
/**
 * lib/safety_parser.js — parses Safety Inspection Excel (.xlsx / .xls) reports
 * from https://safetyinsp.wbsedcl.in/SafetyReportView/reportPage.jsp
 * and outputs canonical CSV matching schema/safety_inspection.json
 */
const xlsx = require('xlsx');

const EXPECTED_HEADERS = [
  'Inspection ID',
  'Site ID',
  'Inspection By',
  'Office',
  'Location',
  'Description',
  'Inspected on',
  'Entered on',
  'Rectification done by',
  'Rectification done on',
  'Remarks',
  'Status',
  'Image'
];

function formatCell(val, colIdx) {
  if (val === null || val === undefined) return '""';
  // Columns 6 and 9 are "Inspected on" and "Rectification done on"
  // When Excel stores dates as numeric serials (e.g. 45000+), convert to DD-MM-YYYY
  if (typeof val === 'number' && (colIdx === 6 || colIdx === 9)) {
    const d = new Date(Math.round((val - 25569) * 86400 * 1000));
    const day = String(d.getUTCDate()).padStart(2, '0');
    const mon = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yr = d.getUTCFullYear();
    return `"${day}-${mon}-${yr}"`;
  }
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

/**
 * Parses an Excel Buffer or filepath, returns { csv, totalRows, mzoRows, headers }
 */
function parseSafetyExcel(input) {
  const wb = Buffer.isBuffer(input) ? xlsx.read(input, { type: 'buffer' }) : xlsx.readFile(input);
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('No sheet found in workbook');

  const ws = wb.Sheets[sheetName];
  const raw = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (!raw || raw.length === 0) throw new Error('Workbook sheet is empty');

  // Locate the header row (sometimes row 0 has a title like Inspection_detail_report...)
  let headerIdx = 0;
  for (let i = 0; i < Math.min(10, raw.length); i++) {
    const rowStr = (raw[i] || []).join(' ').toLowerCase();
    if (rowStr.includes('inspection id') && rowStr.includes('office')) {
      headerIdx = i;
      break;
    }
  }

  const lines = [];
  const headerCols = raw[headerIdx] || EXPECTED_HEADERS;
  lines.push(EXPECTED_HEADERS.map(h => `"${h}"`).join(','));

  let mzoRows = 0;
  let totalRows = 0;

  for (let i = headerIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row || !row[0]) continue; // skip empty rows

    // Format fields
    const formatted = [];
    for (let c = 0; c < EXPECTED_HEADERS.length; c++) {
      formatted.push(formatCell(row[c], c));
    }
    lines.push(formatted.join(','));
    totalRows++;

    const officeStr = String(row[3] || '');
    // Malda Zone offices start with 66 (Malda, Chanchal, Gazole, Raiganj, Islampur, Balurghat, Buniadpur)
    if (officeStr.includes('(66')) {
      mzoRows++;
    }
  }

  return {
    csv: lines.join('\n'),
    totalRows,
    mzoRows,
    headers: EXPECTED_HEADERS
  };
}

module.exports = {
  parseSafetyExcel,
  EXPECTED_HEADERS
};
