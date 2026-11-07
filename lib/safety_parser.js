'use strict';
/**
 * lib/safety_parser.js — reads a Safety Inspection report (the export of
 * https://safetyinsp.wbsedcl.in/SafetyReportView/reportPage.jsp) and outputs canonical CSV matching
 * schema/safety_inspection.json. Server only (in server.js's PRIVATE_PATH).
 *
 *   parseSafetyReport(buffer, filename) -> { csv, totalRows, mzoRows, headers }   (throws on a bad file)
 *   parseSafetyReportIsolated(buffer, filename, { timeoutMs, maxMemoryMb }) -> Promise of the same,
 *       run in a worker thread with a memory cap and a time limit, so a hostile or huge file cannot
 *       stall or exhaust the server.
 *
 * Accepted: .xlsx (lib/xlsx_lite.js), CSV, and the HTML table some report pages save as ".xls".
 * The old binary .xls format is refused with a message to save the file as .xlsx or .csv.
 */
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

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
const DATE_COLS = new Set([6, 7, 9]); // Inspected on, Entered on, Rectification done on
const MAX_CELL = 32767; // Excel's cell limit

function formatCell(val, colIdx) {
  if (val === null || val === undefined) return '""';
  // Excel stores dates as serial numbers (e.g. 45000+): write them as DD-MM-YYYY.
  if (typeof val === 'number' && DATE_COLS.has(colIdx) && val > 0 && val < 2958466) {
    const d = new Date(Math.round((val - 25569) * 86400 * 1000));
    const day = String(d.getUTCDate()).padStart(2, '0');
    const mon = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yr = d.getUTCFullYear();
    return `"${day}-${mon}-${yr}"`;
  }
  const str = String(val).slice(0, MAX_CELL).replace(/"/g, '""');
  return `"${str}"`;
}

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

function decodeHtml(s) {
  return require('./xlsx_lite').decodeXml(String(s).replace(/&nbsp;/gi, ' '));
}

/** Rows of the first <table> in an HTML "Excel" export. */
function htmlTableRows(text) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/table>|$)/gi;
  const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)(?=<t[dh]\b|<\/tr>|$)/gi;
  let tr;
  while ((tr = trRe.exec(text))) {
    const row = [];
    let td;
    tdRe.lastIndex = 0;
    while ((td = tdRe.exec(tr[1]))) {
      const cell = td[1].replace(/<\/t[dh]>[\s\S]*$/i, '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '');
      row.push(decodeHtml(cell).replace(/\s+/g, ' ').trim());
    }
    rows.push(row);
  }
  return rows;
}

/** The report's rows (arrays of cells) from any accepted file type. */
function readRows(buf, filename) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('The file is empty.');
  if (buf[0] === 0x50 && buf[1] === 0x4b) return require('./xlsx_lite').firstSheetRows(buf);
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    throw new Error('This is the old binary .xls format. Open it in Excel and save it as .xlsx or .csv, then upload that.');
  }
  if (buf.indexOf(0) !== -1) throw new Error('Unsupported file: upload the report as .xlsx or .csv.');
  const text = buf.toString('utf8').replace(/^﻿/, '');
  if (/^\s*</.test(text) && /<table\b/i.test(text)) return htmlTableRows(text);
  const first = text.slice(0, text.search(/\r?\n|$/));
  const delimiter = first.split('\t').length > first.split(',').length ? '\t' : ',';
  return require('./csv').parseRows(text, { delimiter });
}

/**
 * Canonical CSV of a Safety Inspection report. Columns are matched by header name when the report has
 * the expected headers, else taken in the expected order.
 */
function parseSafetyReport(buf, filename) {
  const raw = readRows(buf, filename);
  if (!raw.length) throw new Error('The report is empty.');

  // The header row (row 0 is sometimes a title like Inspection_detail_report...)
  let headerIdx = -1;
  for (let i = 0; i < Math.min(10, raw.length); i++) {
    const cells = (raw[i] || []).map(norm);
    if (cells.includes('inspection id') && cells.some((c) => c === 'office')) { headerIdx = i; break; }
  }
  if (headerIdx < 0) throw new Error('This does not look like the Safety Inspection report: no "Inspection ID" and "Office" header row was found.');

  const header = (raw[headerIdx] || []).map(norm);
  // By name; a header named differently keeps its expected position unless another column took it.
  const found = EXPECTED_HEADERS.map((h) => header.indexOf(norm(h)));
  const claimed = new Set(found.filter((at) => at >= 0));
  const pos = found.map((at, i) => (at >= 0 ? at : (i < header.length && !claimed.has(i) ? i : -1)));

  const lines = [EXPECTED_HEADERS.map((h) => `"${h}"`).join(',')];
  let mzoRows = 0;
  let totalRows = 0;
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row || row[pos[0]] === undefined || row[pos[0]] === '' || row[pos[0]] === null) continue; // empty rows
    lines.push(pos.map((p, c) => formatCell(row[p], c)).join(','));
    totalRows++;
    // Malda Zone offices have codes starting with 66 (Malda, Chanchal, Gazole, Raiganj, Islampur, Balurghat, Buniadpur)
    if (String(row[pos[3]] || '').includes('(66')) mzoRows++;
  }
  if (!totalRows) throw new Error('The report has a header row but no inspections.');
  return { csv: lines.join('\n') + '\n', totalRows, mzoRows, headers: EXPECTED_HEADERS };
}

/** parseSafetyReport in a worker thread with a heap cap and a time limit. */
function parseSafetyReportIsolated(buf, filename, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 60000;
  const maxMemoryMb = (opts && opts.maxMemoryMb) || 384;
  return new Promise((resolve, reject) => {
    let done = false;
    const worker = new Worker(__filename, {
      workerData: { buf, filename: String(filename || '') },
      resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb, maxYoungGenerationSizeMb: 32 }
    });
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error('The file took too long to read.')), timeoutMs);
    worker.on('message', (m) => (m && m.ok ? finish(resolve, m.result) : finish(reject, new Error((m && m.error) || 'The file could not be read.'))));
    worker.on('error', (err) => finish(reject, new Error(err && err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'The file is too large to read.' : 'The file could not be read.')));
    worker.on('exit', (code) => finish(reject, new Error(code ? 'The file is too large to read.' : 'The file could not be read.')));
  });
}

if (!isMainThread && workerData && workerData.buf) {
  try {
    const u8 = workerData.buf;
    const buf = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
    parentPort.postMessage({ ok: true, result: parseSafetyReport(buf, workerData.filename) });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
}

module.exports = {
  parseSafetyReport,
  parseSafetyReportIsolated,
  EXPECTED_HEADERS
};
