/**
 * sync_unbilled_from_crm.js
 *
 * Automated Unbilled Consumers & Billing Exceptions Sync Pipeline:
 *
 * Database: IBM DB2 (db2_mig @ 10.251.64.65:60000, user: report)
 * Tool: DbVisualizer CLI (dbviscmd.bat) with connection "ibm db2"
 *
 * Extracts:
 * 1. ISUDATA.OUTSORT_CURR_MON_UNBIL_REPORT  -> data/unbilled_outsort.csv (Billing Exceptions)
 * 2. ISUDATA.CURR_3MON_UNBIL_REPORT          -> data/unbilled_chronic.csv (Chronic Unbilled >= 3 Months)
 * 3. ISUDATA.CURR_MON_UNBIL_REPORT (agg)     -> data/unbilled_summary.csv (CCC x Class x MRU counts)
 * 4. Metadata (date, counts)                 -> data/unbilled_meta.json
 *
 * Usage:
 *   node scripts/sync/sync_unbilled_from_crm.js            # Run extraction and publish
 *   node scripts/sync/sync_unbilled_from_crm.js --dry-run  # Run locally without Supabase upload
 *   node scripts/sync/sync_unbilled_from_crm.js --skip-db  # Use existing local temp CSVs
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { storageConfigured, upload, publishMeta, cli } = require('./common');

const LABEL = 'CRM Unbilled Sync';
const DBVIS_CONNECTION = 'ibm db2';
const DBVIS_CMD_PATH = 'C:\\Program Files\\DbVisualizer\\dbviscmd.bat';
const TEMP_DIR = path.resolve(__dirname, '../../data/temp/unbilled');
const DATA_DIR = path.resolve(__dirname, '../../data');
const SQL_BATCH_FILE = path.resolve(__dirname, '../sql/unbilled_crm_batch.sql');

function isDbvisAvailable() {
  return fs.existsSync(DBVIS_CMD_PATH);
}

function runDbvisExtraction() {
  if (!isDbvisAvailable()) {
    throw new Error(`DbVisualizer CLI not found at ${DBVIS_CMD_PATH}`);
  }

  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  console.log(`[${LABEL}] Extracting unbilled and billing exceptions from DB2 ("${DBVIS_CONNECTION}")...`);
  const t0 = Date.now();

  const dbvisHome = path.dirname(DBVIS_CMD_PATH);
  const res = spawnSync('cmd.exe', [
    '/c',
    'dbviscmd.bat',
    '-connection', DBVIS_CONNECTION,
    '-sqlfile', SQL_BATCH_FILE,
    '-stoponerror'
  ], {
    encoding: 'utf8',
    cwd: dbvisHome,
    timeout: 180000 // 3 minutes timeout
  });

  const durationSec = ((Date.now() - t0) / 1000).toFixed(1);

  if (res.error) {
    throw new Error(`Failed to execute dbviscmd: ${res.error.message}`);
  }

  if (res.status !== 0 || (res.stdout && res.stdout.includes('ERROR:'))) {
    const errorSnippet = (res.stderr || res.stdout || 'Unknown error').slice(0, 500);
    throw new Error(`DbVisualizer extraction failed (status ${res.status}):\n${errorSnippet}`);
  }

  console.log(`[${LABEL}] DB2 extraction finished successfully in ${durationSec}s.`);
}

function parseCsvCountsAndDate(filePath) {
  if (!fs.existsSync(filePath)) return { count: 0, baselineDate: '' };
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  if (lines.length <= 1) return { count: 0, baselineDate: '' };
  
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const header = lines[0].split(sep).map(s => s.replace(/"/g, '').trim());
  const dateIdx = header.indexOf('BASE_LINE_DATE');
  let baselineDate = '';

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(sep).map(s => s.replace(/"/g, '').trim());
    if (dateIdx !== -1 && row[dateIdx] && /^\d{8}$/.test(row[dateIdx])) {
      baselineDate = row[dateIdx];
      break;
    }
  }

  return { count: lines.length - 1, baselineDate };
}

function parseSummaryTotal(filePath) {
  if (!fs.existsSync(filePath)) return { totalConsumers: 0, baselineDate: '', groupCount: 0 };
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  if (lines.length <= 1) return { totalConsumers: 0, baselineDate: '', groupCount: 0 };

  const sep = lines[0].includes('\t') ? '\t' : ',';
  const header = lines[0].split(sep).map(s => s.replace(/"/g, '').trim());
  const dateIdx = header.indexOf('BASE_LINE_DATE');
  const countIdx = header.indexOf('UNBILLED_COUNT');
  let totalConsumers = 0;
  let baselineDate = '';

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(sep).map(s => s.replace(/"/g, '').trim());
    if (!baselineDate && dateIdx !== -1 && row[dateIdx] && /^\d{8}$/.test(row[dateIdx])) {
      baselineDate = row[dateIdx];
    }
    if (countIdx !== -1) {
      const val = parseInt(row[countIdx], 10);
      if (!isNaN(val)) totalConsumers += val;
    }
  }

  return { totalConsumers, baselineDate, groupCount: lines.length - 1 };
}

async function syncUnbilledFromCrm(options = {}) {
  const isCli = options.isCli ?? false;
  const dryRun = options.dryRun ?? false;
  const skipDb = options.skipDb ?? false;
  const fresh = options.fresh ?? true;

  const tempOutsort = path.join(TEMP_DIR, 'outsort.csv');
  const tempChronic = path.join(TEMP_DIR, 'chronic.csv');
  const tempSummary = path.join(TEMP_DIR, 'summary.csv');

  // 1. Run extraction if requested or if files are missing
  const needsDb = fresh || !skipDb || !fs.existsSync(tempOutsort) || !fs.existsSync(tempChronic) || !fs.existsSync(tempSummary);
  if (needsDb) {
    runDbvisExtraction();
  } else {
    console.log(`[${LABEL}] Skipping DB2 extraction, using existing temp files in ${TEMP_DIR}`);
  }

  // 2. Parse counts and baseline dates
  const outsortInfo = parseCsvCountsAndDate(tempOutsort);
  const chronicInfo = parseCsvCountsAndDate(tempChronic);
  const summaryInfo = parseSummaryTotal(tempSummary);

  const rawDate = outsortInfo.baselineDate || chronicInfo.baselineDate || summaryInfo.baselineDate;
  let fmtDate = '';
  if (/^\d{8}$/.test(rawDate)) {
    fmtDate = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
  }

  const metaPayload = {
    asOn: fmtDate || rawDate || new Date().toISOString().split('T')[0],
    baselineDate: rawDate,
    outsortCount: outsortInfo.count,
    chronicCount: chronicInfo.count,
    currentMonCount: summaryInfo.totalConsumers,
    summaryGroups: summaryInfo.groupCount,
    source: 'CRM DB2 (ISUDATA)',
    uploadedAt: new Date().toISOString()
  };

  console.log(`\n======================================================`);
  console.log(`[${LABEL}] Extraction Summary:`);
  console.log(`  • Baseline Date:             ${metaPayload.asOn} (${rawDate})`);
  console.log(`  • Billing Outsorts:          ${outsortInfo.count}`);
  console.log(`  • Chronic (>= 3 Mon):        ${chronicInfo.count}`);
  console.log(`  • Current Month Unbilled:    ${summaryInfo.totalConsumers} (in ${summaryInfo.groupCount} MRU groups)`);
  console.log(`======================================================\n`);

  // 3. Save local copies in data/
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const localOutsort = path.join(DATA_DIR, 'unbilled_outsort.csv');
  const localChronic = path.join(DATA_DIR, 'unbilled_chronic.csv');
  const localSummary = path.join(DATA_DIR, 'unbilled_summary.csv');
  const localMeta = path.join(DATA_DIR, 'unbilled_meta.json');

  fs.copyFileSync(tempOutsort, localOutsort);
  fs.copyFileSync(tempChronic, localChronic);
  fs.copyFileSync(tempSummary, localSummary);
  fs.writeFileSync(localMeta, JSON.stringify(metaPayload, null, 2), 'utf8');

  console.log(`[${LABEL}] Saved local files in ${DATA_DIR}`);

  // 4. Upload to Supabase Storage if configured and not dry-run
  if (!dryRun && storageConfigured()) {
    console.log(`[${LABEL}] Publishing snapshot to Supabase Storage ('reports' bucket)...`);
    await upload('reports/unbilled/outsort.csv', fs.readFileSync(localOutsort), 'text/csv');
    await upload('reports/unbilled/chronic.csv', fs.readFileSync(localChronic), 'text/csv');
    await upload('reports/unbilled/summary.csv', fs.readFileSync(localSummary), 'text/csv');
    await upload('reports/unbilled/meta.json', Buffer.from(JSON.stringify(metaPayload, null, 2)), 'application/json');
    console.log(`[${LABEL}] Successfully uploaded to Supabase Storage.`);
  } else if (dryRun) {
    console.log(`[${LABEL}] Dry run enabled. Skipped Supabase upload.`);
  } else {
    console.log(`[${LABEL}] Supabase Storage not configured. Data is available locally.`);
  }

  return metaPayload;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const skipDb = args.includes('--skip-db');
  const fresh = !skipDb && !args.includes('--no-fresh');

  syncUnbilledFromCrm({
    isCli: true,
    dryRun,
    skipDb,
    fresh
  }).catch(err => {
    console.error(`[${LABEL}] Error:`, err.message);
    process.exit(1);
  });
}

module.exports = {
  syncUnbilledFromCrm,
  isDbvisAvailable
};
