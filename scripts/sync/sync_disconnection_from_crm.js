/**
 * sync_disconnection_from_crm.js
 *
 * Automated Disconnection Tracker Sync Pipeline from IBM DB2:
 *
 * Database: IBM DB2 (db2_mig @ 10.251.64.65:60000, user: report)
 * Tool: DbVisualizer CLI (dbviscmd.bat) with connection "ibm db2"
 *
 * Extracts OSD defaulters & disconnection list, updates data/disconnection.csv,
 * computes KPI metrics, updates data/disconnection_meta.json, and pushes to VM.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseCsvLine, fetchCsv, storageConfigured, upload, publishMeta, cli, vmUploadHeaders } = require('./common');

const SYNC_KEY_ENV = 'DISCONNECTION_SYNC_SECRET';

const LABEL = 'CRM Disconnection Sync';
const DBVIS_CONNECTION = 'ibm db2';
const DBVIS_CMD_PATH = 'C:\\Program Files\\DbVisualizer\\dbviscmd.bat';
const TEMP_DIR = path.resolve(__dirname, '../../data/temp/disconnection');
const DATA_DIR = path.resolve(__dirname, '../../data');
const SQL_BATCH_FILE = path.resolve(__dirname, '../sql/disconnection_crm_batch.sql');
const VM_BASE_URL = process.env.VM_BASE_URL || 'https://130.210.43.11.sslip.io';

function isDbvisAvailable() {
  return fs.existsSync(DBVIS_CMD_PATH);
}

function parseAmount(val) {
  if (!val) return 0;
  const cleaned = String(val).replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

async function uploadToVm(csvFilePath, token) {
  const isVmHost = process.env.MZO_DATA_MODE === 'mirror' || (process.env.HOSTNAME && process.env.HOSTNAME.includes('oracle'));
  if (isVmHost) {
    console.log(`[${LABEL}] Running directly on VM host. Local copy is already active.`);
    return { status: 'success', message: 'Already on VM host' };
  }

  if (!fs.existsSync(csvFilePath)) return null;

  console.log(`[${LABEL}] Uploading disconnection dataset directly to VM (${VM_BASE_URL})...`);
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(csvFilePath)]), 'disconnection.csv');

  const res = await fetch(`${VM_BASE_URL}/api/disconnection/upload`, {
    method: 'POST',
    headers: vmUploadHeaders(SYNC_KEY_ENV, token),
    body: fd
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok || json.status !== 'success') {
    throw new Error(json.message || `VM returned HTTP ${res.status}`);
  }
  console.log(`[${LABEL}] Successfully uploaded disconnection dataset to VM! (${json.message || 'OK'})`);
  return json;
}

function runDbvisExtraction() {
  if (!isDbvisAvailable()) {
    throw new Error(`DbVisualizer CLI not found at ${DBVIS_CMD_PATH}`);
  }

  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  const tempDirForward = TEMP_DIR.replace(/\\/g, '/');
  let sqlText = fs.readFileSync(SQL_BATCH_FILE, 'utf8');
  sqlText = sqlText.replace(/e:\/Codes\/MZO\/mzo_report_pwa\/data\/temp\/disconnection/g, tempDirForward);
  const runtimeSqlFile = path.join(TEMP_DIR, 'batch_run.sql');
  fs.writeFileSync(runtimeSqlFile, sqlText, 'utf8');

  console.log(`[${LABEL}] Extracting disconnection list from DB2 ("${DBVIS_CONNECTION}")...`);
  const t0 = Date.now();

  const dbvisHome = path.dirname(DBVIS_CMD_PATH);
  const res = spawnSync('cmd.exe', [
    '/c',
    'dbviscmd.bat',
    '-connection', DBVIS_CONNECTION,
    '-sqlfile', runtimeSqlFile,
    '-stoponerror'
  ], {
    encoding: 'utf8',
    cwd: dbvisHome,
    timeout: 300000 // 5 minutes timeout
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

async function syncDisconnectionFromCrm(options = {}) {
  const isCli = options.isCli ?? false;
  const dryRun = options.dryRun ?? false;
  const skipDb = options.skipDb ?? false;
  const fresh = options.fresh ?? true;
  const userToken = options.userToken || '';

  // Check the upload credentials before the extraction, so a missing key fails at once.
  if (!dryRun) vmUploadHeaders(SYNC_KEY_ENV, userToken);

  const tempFile = path.join(TEMP_DIR, 'discon_raw.csv');

  // 1. Run extraction if requested
  const needsDb = fresh || !skipDb || !fs.existsSync(tempFile);
  if (needsDb) {
    runDbvisExtraction();
  } else {
    console.log(`[${LABEL}] Using existing temp file in ${tempFile}`);
  }

  if (!fs.existsSync(tempFile) || fs.statSync(tempFile).size < 50) {
    throw new Error('Extracted disconnection CSV is missing or empty.');
  }

  const csvText = fs.readFileSync(tempFile, 'utf8');
  const lines = csvText.split('\n');
  if (lines.length < 2) throw new Error('Extracted CSV has no data rows.');

  const headerLine = lines[0];
  const rawHeaders = parseCsvLine(headerLine).map(h => h.trim());
  const colIndex = {};
  rawHeaders.forEach((h, i) => { if (h) colIndex[h] = i; });

  const cccIdx = colIndex['CCC_CODE'] ?? 0;
  const conIdIdx = colIndex['CON_ID'] ?? 2;
  const notosdIdx = colIndex['NOTOSD'] ?? 5;
  const paidDisconIdx = colIndex['PAID/DISCON DATE'] ?? colIndex['PAID_DISCON_DATE'] ?? 12;
  const finalPaidIdx = colIndex['FINAL PAID AMOUNT'] ?? colIndex['FINAL_PAID_AMOUNT'] ?? 13;

  let totalConsumers = 0;
  let totalOSD = 0;
  let fullyPaidCount = 0, fullyPaidAmount = 0;
  let partiallyPaidCount = 0, partiallyPaidAmount = 0;
  let disconnectedCount = 0, disconnectedOSD = 0;
  let noActionCount = 0, noActionOSD = 0;
  let osd3kCount = 0;
  let osd5kCount = 0;
  let latestDateObj = null;
  let latestDateFormatted = '';

  const divMap = {
    '6611': 'Malda',
    '6612': 'Chanchal',
    '6613': 'Gazole',
    '6621': 'Raiganj',
    '6622': 'Islampur',
    '6631': 'Balurghat',
    '6632': 'Buniadpur'
  };

  const divStats = {};
  Object.values(divMap).forEach(d => {
    divStats[d] = { total: 0, fullyPaid: 0, disconnected: 0, noAction: 0, osd: 0 };
  });

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCsvLine(line);
    const ccc = (cols[cccIdx] || '').trim();
    const conId = (cols[conIdIdx] || '').trim();
    if (!conId && !ccc) continue;

    totalConsumers++;
    const osd = parseAmount(cols[notosdIdx]);
    const paid = parseAmount(cols[finalPaidIdx]);
    const dateStr = (cols[paidDisconIdx] || '').trim();
    const dateMatch = (dateStr !== '0' && dateStr.toLowerCase() !== '#n/a') ? dateStr.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/) : null;
    const hasDate = !!dateMatch;
    const hasPaid = paid > 0;

    totalOSD += osd;
    if (osd > 3000) osd3kCount++;
    if (osd > 5000) osd5kCount++;

    let status = 'No Action';
    if (!hasDate) {
      status = 'No Action';
      noActionCount++;
      noActionOSD += osd;
    } else if (!hasPaid) {
      status = 'Disconnected';
      disconnectedCount++;
      disconnectedOSD += osd;
    } else if (paid >= osd) {
      status = 'Fully Paid';
      fullyPaidCount++;
      fullyPaidAmount += paid;
    } else {
      status = 'Partially Paid';
      partiallyPaidCount++;
      partiallyPaidAmount += paid;
    }

    if (hasDate && dateMatch) {
      const d = parseInt(dateMatch[1], 10);
      const m = parseInt(dateMatch[2], 10);
      let y = parseInt(dateMatch[3], 10);
      if (dateMatch[3].length === 2) y = (y > 50 ? 1900 : 2000) + y;
      if (y >= 2020 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        const dt = new Date(y, m - 1, d);
        if (!latestDateObj || dt > latestDateObj) {
          latestDateObj = dt;
          latestDateFormatted = `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
        }
      }
    }

    const prefix4 = ccc.slice(0, 4);
    const divName = divMap[prefix4] || 'Other';
    if (divStats[divName]) {
      divStats[divName].total++;
      divStats[divName].osd += osd;
      if (status === 'Fully Paid') divStats[divName].fullyPaid++;
      else if (status === 'Disconnected') divStats[divName].disconnected++;
      else if (status === 'No Action') divStats[divName].noAction++;
    }
  }

  // Save to data/disconnection.csv
  const finalCsvFile = path.join(DATA_DIR, 'disconnection.csv');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(finalCsvFile, csvText, 'utf8');

  const nowIso = new Date().toISOString();
  const version = 'v:' + nowIso.replace(/[-:TZ.]/g, '').slice(0, 14);

  const stats = {
    totalConsumers,
    totalOSD: Math.round(totalOSD),
    fullyPaid: { count: fullyPaidCount, amount: Math.round(fullyPaidAmount) },
    partiallyPaid: { count: partiallyPaidCount, amount: Math.round(partiallyPaidAmount) },
    disconnected: { count: disconnectedCount, amount: Math.round(disconnectedOSD) },
    noAction: { count: noActionCount, amount: Math.round(noActionOSD) },
    osd3kCount,
    osd5kCount,
    domBaseDate: '',
    indBaseDate: '',
    latestPaidDisconDate: latestDateFormatted,
    divisions: divStats,
    syncedAt: nowIso
  };

  let publicCsvUrl = '';
  if (storageConfigured() && !dryRun) {
    try {
      publicCsvUrl = `${await upload('disconnection/snapshot.csv', csvText, 'text/csv')}?v=${version}`;
    } catch (e) {
      console.warn(`[${LABEL}] Storage upload failed: ${e.message}`);
    }
  }

  const meta = {
    version,
    updatedAt: nowIso,
    reportDate: latestDateFormatted || new Date().toLocaleDateString('en-IN'),
    stats,
    csvUrl: publicCsvUrl || '/api/disconnection/dataset',
    source: 'CRM DB2 (ISUDATA)'
  };

  await publishMeta('disconnection', 'disconnection_meta.json', meta, LABEL);

  // Upload to VM if running on workstation
  if (!dryRun) {
    try {
      await uploadToVm(finalCsvFile, userToken);
    } catch (err) {
      console.warn(`[${LABEL}] Direct VM upload notice: ${err.message}`);
    }
  }

  console.log(`[${LABEL}] Sync complete. Total consumers: ${totalConsumers}, OSD: ${(totalOSD / 10000000).toFixed(2)} Cr.`);
  return {
    status: 'success',
    message: `Extracted ${totalConsumers.toLocaleString()} consumers with ₹${(totalOSD / 10000000).toFixed(2)} Cr OSD from IBM DB2!`,
    stats
  };
}

module.exports = {
  syncDisconnectionFromCrm,
  isDbvisAvailable
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const skipDb = args.includes('--skip-db');
  syncDisconnectionFromCrm({ isCli: true, dryRun, skipDb })
    .then((res) => {
      console.log('Finished:', res.message);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Failed:', err.message);
      process.exit(1);
    });
}
