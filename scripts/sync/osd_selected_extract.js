/**
 * Names for the OSD follow-up cuts only. The full zone list is not downloaded.
 *
 * Cuts (a consumer is kept once if any cut matches):
 *   REM: OSD above ₹5,000, except Government and Agriculture
 *   Industrial, any amount
 *   Commercial above ₹1,000
 *   Domestic above ₹50,000
 *
 * One division at a time, then merged to data/osd_selected.csv.
 *   npm run sync:osd:selected
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DBVIS_CMD_PATH = 'C:\\Program Files\\DbVisualizer\\dbviscmd.bat';
const DBVIS_CONNECTION = 'ibm db2';
const DIVISIONS = [
  { prefix: '6611', name: 'Malda' },
  { prefix: '6612', name: 'Chanchal' },
  { prefix: '6613', name: 'Gazole' },
  { prefix: '6621', name: 'Raiganj' },
  { prefix: '6622', name: 'Islampur' },
  { prefix: '6631', name: 'Balurghat' },
  { prefix: '6632', name: 'Buniadpur' }
];
const TEMP_DIR = path.resolve(__dirname, '../../data/temp/osd');
const OUT_FILE = path.resolve(__dirname, '../../data/osd_selected.csv');
const COLUMNS = 'CCC_CODE, CON_ID, NAME, CLASS_DESC, NOTOSD, LAST_PDT, METER_NO';

function isDbvisAvailable() {
  return fs.existsSync(DBVIS_CMD_PATH);
}

function whereCuts() {
  return [
    '(',
    "  (NOTOSD > 5000 AND UPPER(CLASS_DESC) NOT LIKE 'GOV%' AND UPPER(CLASS_DESC) NOT LIKE 'AGR%')",
    "  OR UPPER(CLASS_DESC) LIKE 'IND%'",
    "  OR (UPPER(CLASS_DESC) LIKE 'COM%' AND NOTOSD > 1000)",
    "  OR (UPPER(CLASS_DESC) LIKE 'DOM%' AND NOTOSD > 50000)",
    ')'
  ].join('\n');
}

function runDivision(div) {
  const chunkFile = path.join(TEMP_DIR, `selected_${div.prefix}.csv`);
  const sqlFile = path.join(TEMP_DIR, `selected_${div.prefix}.sql`);
  const sql = [
    '@export on;',
    `@export set filename="${chunkFile.replace(/\\/g, '/')}" format="csv" delimiter="," quote="true";`,
    `SELECT ${COLUMNS}`,
    'FROM ISUDATA.NOTICE_OSD',
    `WHERE CCC_CODE LIKE '${div.prefix}%'`,
    '  AND ' + whereCuts(),
    'ORDER BY NOTOSD DESC;',
    '@export off;'
  ].join('\n');
  fs.writeFileSync(sqlFile, sql, 'utf8');
  const res = spawnSync('cmd.exe', [
    '/c', 'dbviscmd.bat',
    '-connection', DBVIS_CONNECTION,
    '-sqlfile', sqlFile,
    '-stoponerror'
  ], {
    encoding: 'utf8',
    cwd: path.dirname(DBVIS_CMD_PATH),
    timeout: 300000
  });
  if (res.error) throw new Error(`${div.name}: ${res.error.message}`);
  if (res.status !== 0 || (res.stdout && res.stdout.includes('ERROR:'))) {
    const errSnippet = (res.stderr || res.stdout || 'Unknown error').slice(0, 400);
    throw new Error(`${div.name} (code ${res.status}): ${errSnippet}`);
  }
  return chunkFile;
}

function merge(files) {
  const parts = [];
  let header = '';
  files.forEach((file) => {
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!text) return;
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) return;
    if (!header) header = lines[0];
    const body = lines[0] === header ? lines.slice(1) : lines;
    body.forEach((line) => parts.push(line));
  });
  if (!header) throw new Error('The selected extract wrote no rows.');
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, header + '\n' + parts.join('\n') + '\n', 'utf8');
  return parts.length;
}

function main() {
  if (!isDbvisAvailable()) {
    throw new Error(`DbVisualizer CLI not found at ${DBVIS_CMD_PATH}`);
  }
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const chunks = [];
  DIVISIONS.forEach((div, i) => {
    console.log(`[OSD selected] ${div.name} (${i + 1} of ${DIVISIONS.length})`);
    chunks.push(runDivision(div));
  });
  const n = merge(chunks);
  console.log(`[OSD selected] ${n.toLocaleString('en-IN')} consumers → ${OUT_FILE}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[OSD selected]', err.message || err);
    process.exit(1);
  }
}

module.exports = { DIVISIONS, OUT_FILE, whereCuts };
