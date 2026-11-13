/**
 * sync_disconnection_payments.js
 *
 * Automated Payment Reconciliation Pipeline for Disconnection Tracker:
 * 
 * Database: IBM DB2 (db2_mig @ 10.251.64.65:60000, user: report)
 * Table: ISUDATA.WBSEDCL_DAILY_COLLECTIONS
 * Tool: DbVisualizer CLI (dbviscmd.bat) with connection "ibm db2"
 *
 * Direct to Oracle Cloud VM Architecture:
 * 1. Reads the active disconnection list (data/disconnection.csv).
 * 2. Identifies disconnection baseline cutoff date.
 * 3. Chunks queries division-by-division (6611, 6612, 6613, 6621, 6622, 6631, 6632, 6610)
 *    to prevent database gateway timeouts and server strain.
 * 4. Filters ONLY payments for listed consumers (matching CON_ID).
 * 5. Discards any payment prior to the consumer's disconnection cutoff date.
 * 6. Aggregates multiple payment installments per consumer.
 * 7. Updates data/disconnection.csv, saves data/disconnection_payments.json,
 *    recomputes KPI stats in data/disconnection_meta.json, and pushes directly to VM.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseCsvLine, vmUploadHeaders } = require('./common');

const LABEL = 'Disconnection Payment Sync';
const DBVIS_CONNECTION = 'ibm db2';
const DBVIS_CMD_PATH = 'C:\\Program Files\\DbVisualizer\\dbviscmd.bat';
const TEMP_DIR = path.resolve(__dirname, '../../data/temp/disconnection_payments');
const DATA_DIR = process.env.MZO_FILES_DIR ? path.resolve(process.env.MZO_FILES_DIR) : path.resolve(__dirname, '../../data'); // git-ignored; MZO_FILES_DIR on the VM
const VM_BASE_URL = process.env.VM_BASE_URL || 'https://130.210.43.11.sslip.io';
const SYNC_KEY_ENV = 'DISCONNECTION_SYNC_SECRET';

const DIVISIONS = [
  { prefix: '6611', name: 'Malda Division' },
  { prefix: '6612', name: 'Chanchal Division' },
  { prefix: '6613', name: 'Gazole Division' },
  { prefix: '6621', name: 'Raiganj Division' },
  { prefix: '6622', name: 'Islampur Division' },
  { prefix: '6631', name: 'Balurghat Division' },
  { prefix: '6632', name: 'Buniadpur Division' },
  { prefix: '6610', name: 'Zonal / HQ / Bulk' }
];

function isDbvisAvailable() {
  return fs.existsSync(DBVIS_CMD_PATH);
}

function parseAmount(val) {
  if (!val) return 0;
  const cleaned = String(val).replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function normalizeConId(id) {
  return String(id || '').trim().replace(/^0+/, '');
}

function formatDateDb2ToDmy(yyyymmdd) {
  const s = String(yyyymmdd || '').trim();
  if (s.length === 8 && /^\d{8}$/.test(s)) {
    return `${s.slice(6, 8)}.${s.slice(4, 6)}.${s.slice(0, 4)}`;
  }
  return s;
}

function parseDateToYmd(str) {
  if (!str) return '';
  const s = String(str).trim();
  if (/^\d{8}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (m) {
    const d = m[1].padStart(2, '0');
    const mo = m[2].padStart(2, '0');
    let y = m[3];
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
    return `${y}${mo}${d}`;
  }
  return '';
}

/** Run DB2 extraction for a single division chunk */
function runDivisionChunkExtraction(div, cutoffDateDb2) {
  if (!isDbvisAvailable()) {
    throw new Error(`DbVisualizer CLI not found at ${DBVIS_CMD_PATH}`);
  }
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  const chunkFile = path.join(TEMP_DIR, `chunk_${div.prefix}.csv`);
  const chunkFileForward = chunkFile.replace(/\\/g, '/');
  const sqlFile = path.join(TEMP_DIR, `extract_${div.prefix}.sql`);

  const sqlContent = [
    '@export on;',
    `@export set filename="${chunkFileForward}" format="csv" delimiter="," quote="true";`,
    'SELECT CCC_CODE, CON_ID, PAYMENT_DT, ENTRY_DT, AMT, RECEIPT_NO, MODE, COL_TYPE, CLEARING_DOC',
    'FROM ISUDATA.WBSEDCL_DAILY_COLLECTIONS',
    `WHERE PAYMENT_DT >= '${cutoffDateDb2}'`,
    `  AND CCC_CODE LIKE '${div.prefix}%'`,
    'ORDER BY PAYMENT_DT DESC, CON_ID;',
    '@export off;'
  ].join('\n');

  fs.writeFileSync(sqlFile, sqlContent, 'utf8');

  const dbvisHome = path.dirname(DBVIS_CMD_PATH);
  const res = spawnSync('cmd.exe', [
    '/c', 'dbviscmd.bat',
    '-connection', DBVIS_CONNECTION,
    '-sqlfile', sqlFile,
    '-stoponerror'
  ], {
    encoding: 'utf8',
    cwd: dbvisHome,
    timeout: 180000 // 3 minutes timeout per chunk
  });

  if (res.error) throw new Error(`Execution failed for ${div.name}: ${res.error.message}`);
  if (res.status !== 0 || (res.stdout && res.stdout.includes('ERROR:'))) {
    const errSnippet = (res.stderr || res.stdout || 'Unknown error').slice(0, 400);
    throw new Error(`DB2 chunk failed for ${div.name} (code ${res.status}):\n${errSnippet}`);
  }

  return chunkFile;
}

/** Upload files directly to the Oracle Cloud VM */
async function uploadDirectToVm(csvFilePath, paymentsJsonPath, metaPath, token) {
  const isVmHost = process.env.MZO_DATA_MODE === 'mirror' || (process.env.HOSTNAME && process.env.HOSTNAME.includes('oracle'));
  if (isVmHost) {
    console.log(`[${LABEL}] Running directly on VM host. Local disk update is already active.`);
    return { status: 'success', message: 'Already running on VM host' };
  }

  const results = {};

  if (fs.existsSync(csvFilePath)) {
    console.log(`[${LABEL}] Uploading updated CSV directly to VM (${VM_BASE_URL})...`);
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(csvFilePath)]), 'disconnection.csv');

    const res = await fetch(`${VM_BASE_URL}/api/disconnection/upload`, {
      method: 'POST',
      headers: vmUploadHeaders(SYNC_KEY_ENV, token),
      body: fd
    });
    results.csv = await res.json().catch(() => ({ status: res.status }));
  }

  if (fs.existsSync(paymentsJsonPath)) {
    console.log(`[${LABEL}] Uploading payment history JSON directly to VM (${VM_BASE_URL})...`);
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(paymentsJsonPath)]), 'disconnection_payments.json');
    if (metaPath && fs.existsSync(metaPath)) fd.append('meta', new Blob([fs.readFileSync(metaPath)]), 'disconnection_meta.json');

    const res = await fetch(`${VM_BASE_URL}/api/disconnection/payments-upload`, {
      method: 'POST',
      headers: vmUploadHeaders(SYNC_KEY_ENV, token),
      body: fd
    });
    results.payments = await res.json().catch(() => ({ status: res.status }));
  }

  return results;
}

/** Main Payment Sync Pipeline */
async function syncDisconnectionPayments(options = {}) {
  const { fresh = true, skipDb = false, userToken = null, overrideCutoff = '', skipUpload = false, baselineCsv = '' } = options;
  const t0 = Date.now();
  console.log(`[${LABEL}] Starting Disconnection Payment Sync from DB2 (ISUDATA.WBSEDCL_DAILY_COLLECTIONS)...`);

  // 1. Locate active disconnection dataset. baselineCsv is the list the live page just downloaded
  // (the office helper has no VM sync key). Otherwise use data/disconnection.csv, then the VM.
  let localCsv;
  if (baselineCsv) {
    localCsv = path.resolve(baselineCsv);
    if (!fs.existsSync(localCsv)) throw new Error('Baseline disconnection list was not found.');
  } else {
    localCsv = path.join(DATA_DIR, 'disconnection.csv');
  }
  if (!fs.existsSync(localCsv)) {
    console.log(`[${LABEL}] Local data/disconnection.csv missing, fetching current baseline from VM...`);
    const r = await fetch(`${VM_BASE_URL}/api/disconnection/dataset`, { headers: vmUploadHeaders(SYNC_KEY_ENV, userToken) });
    if (!r.ok) throw new Error(`Could not fetch baseline disconnection list from VM: HTTP ${r.status}`);
    const text = await r.text();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(localCsv, text, 'utf8');
  }

  const rawCsv = fs.readFileSync(localCsv, 'utf8');
  const lines = rawCsv.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new Error('Disconnection dataset is empty or invalid.');

  const headers = parseCsvLine(lines[0]).map(h => h.trim());
  const colIndex = {};
  headers.forEach((h, i) => { if (h) colIndex[h] = i; });

  const conIdIdx = colIndex['CON_ID'] ?? 2;
  const cccIdx = colIndex['CCC_CODE'] ?? 0;
  const notosdIdx = colIndex['NOTOSD'] ?? 5;
  const paidDisconDateIdx = colIndex['PAID/DISCON DATE'] ?? 12;
  const finalPaidIdx = colIndex['FINAL PAID AMOUNT'] ?? 13;
  const domBaseIdx = colIndex['DOM BASE DATE'] ?? colIndex['DOM&COM BASE DATE'] ?? colIndex['DOM COM BASE DATE'];
  const indBaseIdx = colIndex['IND&COM BASE DATE'] ?? colIndex['IND BASE DATE'] ?? colIndex['IND & COM BASE DATE'];

  // Determine cutoff date (YYYYMMDD)
  let cutoffDateDb2 = overrideCutoff || '';
  if (!cutoffDateDb2 && lines.length > 1) {
    const firstRowCols = parseCsvLine(lines[1]);
    const dom = domBaseIdx != null ? parseDateToYmd(firstRowCols[domBaseIdx]) : '';
    const ind = indBaseIdx != null ? parseDateToYmd(firstRowCols[indBaseIdx]) : '';
    cutoffDateDb2 = dom || ind;
  }
  if (!cutoffDateDb2) {
    // Default fallback: 1st day of previous month to cover full active cycle
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    cutoffDateDb2 = `${prevMonth.getFullYear()}${String(prevMonth.getMonth() + 1).padStart(2, '0')}01`;
  }
  console.log(`[${LABEL}] Disconnection Baseline Cutoff Date for Payments: ${cutoffDateDb2}`);

  // Build lookup index of listed consumers: Map<normalizedConId, rowMeta>
  const targetConsumers = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const rawConId = (cols[conIdIdx] || '').trim();
    if (!rawConId) continue;
    const norm = normalizeConId(rawConId);
    targetConsumers.set(norm, {
      lineIndex: i,
      rawConId: rawConId,
      ccc: (cols[cccIdx] || '').trim(),
      osd: parseAmount(cols[notosdIdx]),
      existingPaid: parseAmount(cols[finalPaidIdx]),
      existingDate: (cols[paidDisconDateIdx] || '').trim()
    });
  }
  console.log(`[${LABEL}] Indexed ${targetConsumers.size} listed defaulter consumers.`);

  // 2. Query DB2 division-by-division or ingest provided file
  const matchedPayments = new Map(); // normId -> { totalPaid, lastDate, lastDateDb2, items: [] }

  const filesToProcess = [];
  if (options.file && fs.existsSync(options.file)) {
    console.log(`[${LABEL}] Ingesting payments directly from file: ${options.file}`);
    filesToProcess.push(options.file);
  } else {
    const report = async (ev) => {
      if (typeof options.onProgress === 'function') await options.onProgress(ev);
    };
    for (let d = 0; d < DIVISIONS.length; d++) {
      const div = DIVISIONS[d];
      const step = { phase: 'division', index: d + 1, total: DIVISIONS.length, name: div.name, prefix: div.prefix };
      console.log(`[${LABEL}] [${step.index}/${step.total}] Extracting payments for ${div.name} (${div.prefix}%)...`);
      await report(Object.assign({ state: 'start' }, step));
      const chunkFile = path.join(TEMP_DIR, `chunk_${div.prefix}.csv`);

      if (fresh || !skipDb || !fs.existsSync(chunkFile)) {
        runDivisionChunkExtraction(div, cutoffDateDb2);
      } else {
        console.log(`[${LABEL}] Using cached chunk ${chunkFile}`);
      }
      if (fs.existsSync(chunkFile)) filesToProcess.push(chunkFile);
      await report(Object.assign({ state: 'done' }, step));
    }
  }

  for (const chunkFile of filesToProcess) {
    if (!fs.existsSync(chunkFile)) continue;
    const chunkContent = fs.readFileSync(chunkFile, 'utf8');
    const chunkLines = chunkContent.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (chunkLines.length < 2) continue;

    const isTab = chunkLines[0].includes('\t');
    const parseLine = isTab ? (l => l.split('\t')) : parseCsvLine;
    const chunkHeaders = parseLine(chunkLines[0]).map(h => h.trim().toUpperCase());
    const cConIdx = chunkHeaders.indexOf('CON_ID');
    const cDtIdx = chunkHeaders.indexOf('PAYMENT_DT');
    const cAmtIdx = chunkHeaders.indexOf('AMT');
    const cRcptIdx = chunkHeaders.indexOf('RECEIPT_NO');
    const cModeIdx = chunkHeaders.indexOf('MODE');
    const cColTypeIdx = chunkHeaders.indexOf('COL_TYPE');
    const cClrIdx = chunkHeaders.indexOf('CLEARING_DOC');

    for (let j = 1; j < chunkLines.length; j++) {
      const pCols = parseLine(chunkLines[j]);
      const conIdRaw = pCols[cConIdx];
      const payDt = (pCols[cDtIdx] || '').trim();
      const amt = parseAmount(pCols[cAmtIdx]);
      if (!conIdRaw || amt <= 0) continue;

      // Filter: ONLY listed consumers
      const normId = normalizeConId(conIdRaw);
      const target = targetConsumers.get(normId);
      if (!target) continue;

      // Filter: ONLY on or after cutoff date
      if (payDt && payDt < cutoffDateDb2) continue;

      if (!matchedPayments.has(normId)) {
        matchedPayments.set(normId, {
          totalPaid: 0,
          lastDateDb2: '',
          lastDateFormatted: '',
          items: []
        });
      }

      const rec = matchedPayments.get(normId);
      rec.totalPaid += amt;
      if (!rec.lastDateDb2 || payDt > rec.lastDateDb2) {
        rec.lastDateDb2 = payDt;
        rec.lastDateFormatted = formatDateDb2ToDmy(payDt);
      }
      rec.items.push({
        date: formatDateDb2ToDmy(payDt),
        dateRaw: payDt,
        amount: amt,
        receipt: (pCols[cRcptIdx] || '').trim(),
        mode: (pCols[cModeIdx] || '').trim(),
        colType: cColTypeIdx !== -1 ? (pCols[cColTypeIdx] || '').trim() : '',
        clearingDoc: cClrIdx !== -1 ? (pCols[cClrIdx] || '').trim() : ''
      });
    }
  }

  const totalMatchedCount = matchedPayments.size;
  let totalCollectionAmount = 0;
  matchedPayments.forEach(p => { totalCollectionAmount += p.totalPaid; });

  console.log(`[${LABEL}] Matched ${totalMatchedCount} listed consumers with new payments totaling ₹${totalCollectionAmount.toLocaleString('en-IN')}.`);

  // 3. Update data/disconnection.csv in place
  const updatedLines = [lines[0]]; // preserve original header
  let fullyPaidCount = 0, fullyPaidAmount = 0;
  let partiallyPaidCount = 0, partiallyPaidAmount = 0;
  let disconnectedCount = 0, disconnectedOSD = 0;
  let noActionCount = 0, noActionOSD = 0;
  let totalOSD = 0, osd3kCount = 0, osd5kCount = 0;

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
    const cols = parseCsvLine(lines[i]);
    const rawConId = (cols[conIdIdx] || '').trim();
    const norm = normalizeConId(rawConId);
    const osd = parseAmount(cols[notosdIdx]);
    totalOSD += osd;
    if (osd > 3000) osd3kCount++;
    if (osd > 5000) osd5kCount++;

    const ccc = (cols[cccIdx] || '').trim();
    const pfx = ccc.slice(0, 4);
    const divName = divMap[pfx];

    let paid = parseAmount(cols[finalPaidIdx]);
    let dateStr = (cols[paidDisconDateIdx] || '').trim();

    // Apply matched DB2 payments
    if (matchedPayments.has(norm)) {
      const match = matchedPayments.get(norm);
      paid = match.totalPaid;
      dateStr = match.lastDateFormatted || dateStr;
      cols[finalPaidIdx] = String(paid);
      cols[paidDisconDateIdx] = dateStr;
    }

    const hasDate = dateStr && dateStr !== '0' && dateStr.toLowerCase() !== '#n/a';
    const hasPaid = paid > 0;

    let status = 'No Action';
    if (!hasDate) {
      status = 'No Action';
      noActionCount++;
      noActionOSD += osd;
      if (divName && divStats[divName]) divStats[divName].noAction++;
    } else if (!hasPaid) {
      status = 'Disconnected';
      disconnectedCount++;
      disconnectedOSD += osd;
      if (divName && divStats[divName]) divStats[divName].disconnected++;
    } else if (paid >= osd) {
      status = 'Fully Paid';
      fullyPaidCount++;
      fullyPaidAmount += paid;
      if (divName && divStats[divName]) divStats[divName].fullyPaid++;
    } else {
      status = 'Partially Paid';
      partiallyPaidCount++;
      partiallyPaidAmount += paid;
      if (divName && divStats[divName]) divStats[divName].fullyPaid++; // accounted in paid
    }

    if (divName && divStats[divName]) {
      divStats[divName].total++;
      divStats[divName].osd += osd;
    }

    // Reconstruct CSV line
    updatedLines.push(cols.map(c => `"${String(c || '').replace(/"/g, '""')}"`).join(','));
  }

  // 4. Save updated disconnection.csv
  fs.writeFileSync(localCsv, updatedLines.join('\n'), 'utf8');
  console.log(`[${LABEL}] Updated ${localCsv} with latest payment statuses.`);

  // 5. Save detailed payment history to data/disconnection_payments.json
  let latestPaymentDateDb2 = '';
  let latestPaymentDateFormatted = '';
  matchedPayments.forEach(p => {
    if (p.lastDateDb2 && p.lastDateDb2 > latestPaymentDateDb2) {
      latestPaymentDateDb2 = p.lastDateDb2;
      latestPaymentDateFormatted = p.lastDateFormatted;
    }
  });

  const paymentsJsonPath = path.join(DATA_DIR, 'disconnection_payments.json');
  const paymentsObj = {
    generatedAt: new Date().toISOString(),
    cutoffDate: cutoffDateDb2,
    cutoffDateFormatted: formatDateDb2ToDmy(cutoffDateDb2),
    latestPaymentDate: latestPaymentDateFormatted,
    latestPaymentDateDb2: latestPaymentDateDb2,
    totalMatched: totalMatchedCount,
    totalCollected: totalCollectionAmount,
    consumers: Object.fromEntries(matchedPayments)
  };
  fs.writeFileSync(paymentsJsonPath, JSON.stringify(paymentsObj, null, 2), 'utf8');
  console.log(`[${LABEL}] Saved payment history details to ${paymentsJsonPath}.`);

  // 6. Save updated metadata to data/disconnection_meta.json
  const metaPath = path.join(DATA_DIR, 'disconnection_meta.json');
  const metaObj = {
    version: `v:${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
    updatedAt: new Date().toISOString(),
    reportDate: new Date().toLocaleDateString('en-GB'),
    stats: {
      totalConsumers: lines.length - 1,
      totalOSD: Math.round(totalOSD),
      baseDate: formatDateDb2ToDmy(cutoffDateDb2),
      lastPaymentDate: latestPaymentDateFormatted,
      fullyPaid: { count: fullyPaidCount, amount: Math.round(fullyPaidAmount) },
      partiallyPaid: { count: partiallyPaidCount, amount: Math.round(partiallyPaidAmount) },
      disconnected: { count: disconnectedCount, amount: Math.round(disconnectedOSD) },
      noAction: { count: noActionCount, amount: Math.round(noActionOSD) },
      osd3kCount,
      osd5kCount,
      divisions: divStats,
      syncedAt: new Date().toISOString()
    },
    csvUrl: '/api/disconnection/dataset',
    datasetUrl: '/api/disconnection/dataset',
    source: 'oracle_vm_disk'
  };
  fs.writeFileSync(metaPath, JSON.stringify(metaObj, null, 2), 'utf8');
  console.log(`[${LABEL}] Updated metadata saved to ${metaPath}.`);

  // 7. Direct VM Upload if run remotely. The office helper skips this and lets the signed-in
  // page upload, because this PC does not keep the VM sync key.
  let uploadResult = null;
  if (!skipUpload) {
    try {
      uploadResult = await uploadDirectToVm(localCsv, paymentsJsonPath, metaPath, userToken);
    } catch (err) {
      console.warn(`[${LABEL}] VM Direct Upload warning: ${err.message}`);
    }
  }

  const durationSec = ((Date.now() - t0) / 1000).toFixed(1);
  const message = `Payment sync complete in ${durationSec}s! Matched ${totalMatchedCount} consumers with payments totaling ₹${Math.round(totalCollectionAmount).toLocaleString('en-IN')}.`;
  console.log(`[${LABEL}] ${message}`);

  return {
    status: 'success',
    message,
    matchedCount: totalMatchedCount,
    totalCollected: totalCollectionAmount,
    fullyPaidCount,
    partiallyPaidCount,
    durationSec,
    stats: metaObj.stats,
    uploadResult,
    csvPath: localCsv,
    paymentsPath: paymentsJsonPath,
    metaPath
  };
}

module.exports = {
  syncDisconnectionPayments,
  isDbvisAvailable
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const file = fileIdx !== -1 ? args[fileIdx + 1] : null;
  syncDisconnectionPayments({
    fresh: args.includes('--fresh'),
    skipDb: args.includes('--skip-db'),
    file: file
  }).catch(err => {
    console.error(`[${LABEL}] FATAL: ${err.message}`);
    process.exit(1);
  });
}

