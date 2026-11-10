/**
 * sync_revenue_osd_from_crm.js
 *
 * Common Revenue OSD pipeline from IBM DB2:
 *   ISUDATA.CON_WBSEDCL_OSD_CUR  →  osd_master.csv + osd_summary.json
 *                                →  disconnection.csv (tracker-compatible)
 *
 * Tool: DbVisualizer CLI (dbviscmd.bat), connection "ibm db2"
 * Needs office network. Without it, use --fixture --dry-run.
 *
 * DB2 extract is chunked by division CCC prefix (6611…6632, 6610) to avoid
 * gateway / CLI timeouts — same pattern as sync_disconnection_payments.js.
 *
 * Usage:
 *   node scripts/sync/sync_revenue_osd_from_crm.js --fixture --dry-run
 *   node scripts/sync/sync_revenue_osd_from_crm.js --skip-db --dry-run
 *   node scripts/sync/sync_revenue_osd_from_crm.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseCsvLine, storageConfigured, upload, publishMeta, vmUploadHeaders } = require('./common');
const buckets = require('./osd_buckets');

const SYNC_KEY_ENV = 'DISCONNECTION_SYNC_SECRET';
const LABEL = 'CRM Revenue OSD Sync';
const DBVIS_CONNECTION = 'ibm db2';
const DBVIS_CMD_PATH = 'C:\\Program Files\\DbVisualizer\\dbviscmd.bat';
const TEMP_DIR = path.resolve(__dirname, '../../data/temp/osd');
const DATA_DIR = process.env.MZO_FILES_DIR
  ? path.resolve(process.env.MZO_FILES_DIR)
  : path.resolve(__dirname, '../../data');
const SQL_BATCH_FILE = path.resolve(__dirname, '../sql/revenue_osd_crm_batch.sql');
const FIXTURE_FILE = path.resolve(__dirname, '../fixtures/osd_sample.csv');
const VM_BASE_URL = process.env.VM_BASE_URL || 'https://130.210.43.11.sslip.io';
const CHUNK_TIMEOUT_MS = 180000; // 3 minutes per division chunk

/** Same division prefixes as disconnection payment sync. */
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

const MASTER_HEADERS = [
  'CCC_CODE', 'MRU', 'CON_ID', 'NAME', 'ADDRESS', 'NOTOSD', 'CLASS_DESC',
  'METER_NO', 'REG_MOB_NO', 'PAID_DATE', 'PAID_AMOUNT', 'DISCONNECTION_DATE',
  'PAID_DISCON_DATE', 'FINAL_PAID_AMOUNT', 'BILL_DISPUTE', 'GOVT_STAT', 'CON_STATUS',
  '_class', '_supply', '_value_band', '_aging'
];

const DISCON_HEADERS = [
  'CCC_CODE', 'MRU', 'CON_ID', 'NAME', 'ADDRESS', 'NOTOSD', 'CLASS_DESC',
  'METER_NO', 'REG_MOB_NO', 'PAID_DATE', 'PAID_AMOUNT', 'DISCONNECTION_DATE',
  'PAID_DISCON_DATE', 'FINAL_PAID_AMOUNT', 'BILL_DISPUTE', 'GOVT_STAT'
];

function isDbvisAvailable() {
  return fs.existsSync(DBVIS_CMD_PATH);
}

function csvEscape(val) {
  const s = val == null ? '' : String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * SELECT list for one chunk. Keep in sync with scripts/sql/revenue_osd_crm_batch.sql.
 * On 13th: if supply status is not CON_STATUS, change the last column and keep AS CON_STATUS.
 */
function osdSelectSql(prefix) {
  return [
    'SELECT',
    '  CCC_CODE, MRU, CON_ID, NAME, ADDRESS, NOTOSD, CLASS_DESC,',
    '  METER_NO, REG_MOB_NO, PAID_DATE, PAID_AMOUNT, DISCONNECTION_DATE,',
    '  PAID_DISCON_DATE, FINAL_PAID_AMOUNT, BILL_DISPUTE, GOVT_STAT,',
    '  CON_STATUS',
    'FROM ISUDATA.CON_WBSEDCL_OSD_CUR',
    `WHERE CCC_CODE LIKE '${prefix}%'`,
    'ORDER BY CCC_CODE, MRU, CON_ID'
  ].join('\n');
}

/** One division chunk → data/temp/osd/chunk_<prefix>.csv */
function runDivisionChunk(div) {
  if (!isDbvisAvailable()) {
    throw new Error(`DbVisualizer CLI not found at ${DBVIS_CMD_PATH}`);
  }
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const chunkFile = path.join(TEMP_DIR, `chunk_${div.prefix}.csv`);
  const chunkFileForward = chunkFile.replace(/\\/g, '/');
  const sqlFile = path.join(TEMP_DIR, `extract_${div.prefix}.sql`);
  const sqlContent = [
    '@export on;',
    `@export set filename="${chunkFileForward}" format="csv" delimiter="," quote="true";`,
    osdSelectSql(div.prefix) + ';',
    '@export off;'
  ].join('\n');
  fs.writeFileSync(sqlFile, sqlContent, 'utf8');

  console.log(`[${LABEL}]   · ${div.name} (${div.prefix}%)…`);
  const t0 = Date.now();
  const dbvisHome = path.dirname(DBVIS_CMD_PATH);
  const res = spawnSync('cmd.exe', [
    '/c', 'dbviscmd.bat',
    '-connection', DBVIS_CONNECTION,
    '-sqlfile', sqlFile,
    '-stoponerror'
  ], {
    encoding: 'utf8',
    cwd: dbvisHome,
    timeout: CHUNK_TIMEOUT_MS
  });

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  if (res.error) throw new Error(`Execution failed for ${div.name}: ${res.error.message}`);
  if (res.status !== 0 || (res.stdout && res.stdout.includes('ERROR:'))) {
    const errSnippet = (res.stderr || res.stdout || 'Unknown error').slice(0, 400);
    throw new Error(`DB2 chunk failed for ${div.name} (code ${res.status}):\n${errSnippet}`);
  }
  if (!fs.existsSync(chunkFile) || fs.statSync(chunkFile).size < 20) {
    console.warn(`[${LABEL}]   · ${div.name}: empty chunk (${sec}s) — continuing`);
  } else {
    console.log(`[${LABEL}]   · ${div.name}: OK in ${sec}s`);
  }
  return chunkFile;
}

/** Merge division CSVs into one osd_raw.csv (header once). */
function mergeChunkFiles(chunkFiles, outPath) {
  let header = '';
  const body = [];
  for (const file of chunkFiles) {
    if (!fs.existsSync(file) || fs.statSync(file).size < 20) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) continue;
    if (!header) header = lines[0];
    for (let i = 1; i < lines.length; i++) body.push(lines[i]);
  }
  if (!header) throw new Error('All division chunks were empty — check DB2 access and CON_STATUS column.');
  fs.writeFileSync(outPath, header + '\n' + body.join('\n') + '\n', 'utf8');
  return body.length;
}

/**
 * Extract OSD by division chunks, then merge.
 * Optional --prefix=6611 to pull one division only (debug / resume).
 */
function runDbvisExtraction(options = {}) {
  const onlyPrefix = options.prefix ? String(options.prefix).trim() : '';
  const divs = onlyPrefix
    ? DIVISIONS.filter((d) => d.prefix === onlyPrefix)
    : DIVISIONS;
  if (!divs.length) throw new Error(`Unknown division prefix: ${onlyPrefix}`);

  // Keep a rewritten copy of the reference SQL for operators (whole-zone; not executed).
  try {
    const tempDirForward = TEMP_DIR.replace(/\\/g, '/');
    let sqlText = fs.readFileSync(SQL_BATCH_FILE, 'utf8');
    sqlText = sqlText.replace(/e:\/Codes\/MZO\/mzo_report_pwa\/data\/temp\/osd/g, tempDirForward);
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    fs.writeFileSync(path.join(TEMP_DIR, 'batch_reference.sql'), sqlText, 'utf8');
  } catch (_) { /* reference only */ }

  console.log(`[${LABEL}] Extracting OSD master from DB2 in ${divs.length} division chunk(s)…`);
  const t0 = Date.now();
  const chunkFiles = [];
  for (const div of divs) {
    chunkFiles.push(runDivisionChunk(div));
  }
  const outPath = path.join(TEMP_DIR, 'osd_raw.csv');
  const rows = mergeChunkFiles(chunkFiles, outPath);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[${LABEL}] Merged ${rows.toLocaleString()} consumers from ${chunkFiles.length} chunk(s) in ${sec}s → ${outPath}`);
}

function loadRawCsv(filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 20) {
    throw new Error(`OSD CSV missing or empty: ${filePath}`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) throw new Error('OSD CSV has no data rows.');

  const rawHeaders = parseCsvLine(lines[0]).map((h) => h.trim());
  const colIndex = {};
  rawHeaders.forEach((h, i) => { if (h) colIndex[h.toUpperCase()] = i; });

  const pick = (cols, ...names) => {
    for (const name of names) {
      const idx = colIndex[name.toUpperCase()];
      if (idx != null) return (cols[idx] || '').trim();
    }
    return '';
  };

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCsvLine(line);
    const conId = pick(cols, 'CON_ID');
    const ccc = pick(cols, 'CCC_CODE');
    if (!conId && !ccc) continue;
    rows.push({
      CCC_CODE: ccc,
      MRU: pick(cols, 'MRU'),
      CON_ID: conId,
      NAME: pick(cols, 'NAME'),
      ADDRESS: pick(cols, 'ADDRESS'),
      NOTOSD: pick(cols, 'NOTOSD'),
      CLASS_DESC: pick(cols, 'CLASS_DESC'),
      METER_NO: pick(cols, 'METER_NO'),
      REG_MOB_NO: pick(cols, 'REG_MOB_NO'),
      PAID_DATE: pick(cols, 'PAID_DATE'),
      PAID_AMOUNT: pick(cols, 'PAID_AMOUNT'),
      DISCONNECTION_DATE: pick(cols, 'DISCONNECTION_DATE'),
      PAID_DISCON_DATE: pick(cols, 'PAID_DISCON_DATE', 'PAID/DISCON DATE'),
      FINAL_PAID_AMOUNT: pick(cols, 'FINAL_PAID_AMOUNT', 'FINAL PAID AMOUNT'),
      BILL_DISPUTE: pick(cols, 'BILL_DISPUTE'),
      GOVT_STAT: pick(cols, 'GOVT_STAT'),
      CON_STATUS: pick(cols, 'CON_STATUS', 'SUPPLY_STATUS', 'DISCON_STATUS', 'LIVE_STATUS')
    });
  }
  return rows;
}

function buildSummary(masterRows, opts = {}) {
  const asOf = opts.asOf || new Date();
  const byClass = buckets.emptyBucket(buckets.CLASS_ORDER);
  const bySupply = buckets.emptyBucket(buckets.SUPPLY_ORDER);
  const byHighValue = buckets.emptyBucket(buckets.VALUE_ORDER);
  const byAging = buckets.emptyBucket(buckets.AGING_ORDER);
  const officeMap = new Map();

  let consumers = 0;
  let totalOsd = 0;
  let remConsumers = 0;
  let remOsd = 0;
  let statusKnown = 0;

  for (const r of masterRows) {
    const osd = buckets.parseAmount(r.NOTOSD);
    const cls = r._class || buckets.classBucket(r.CLASS_DESC);
    const supply = r._supply || buckets.supplyBucket(r.CON_STATUS);
    const band = r._value_band || buckets.valueBand(osd);
    const aging = r._aging || buckets.agingBucket(r.PAID_DATE, asOf);

    consumers++;
    totalOsd += osd;
    if (r.CON_STATUS) statusKnown++;
    if (osd >= buckets.REM_OSD_MIN) {
      remConsumers++;
      remOsd += osd;
    }

    byClass[cls].consumers++;
    byClass[cls].osd += osd;
    bySupply[supply].consumers++;
    bySupply[supply].osd += osd;
    byHighValue[band].consumers++;
    byHighValue[band].osd += osd;
    byAging[aging].consumers++;
    byAging[aging].osd += osd;

    const off = buckets.officeFromCcc(r.CCC_CODE);
    const okey = off.cccCode || `${off.division}|${consumers}`;
    if (!officeMap.has(okey)) {
      officeMap.set(okey, {
        region: off.region,
        division: off.division,
        cccCode: off.cccCode,
        consumers: 0,
        osd: 0,
        remOsd: 0,
        remConsumers: 0
      });
    }
    const o = officeMap.get(okey);
    o.consumers++;
    o.osd += osd;
    if (osd >= buckets.REM_OSD_MIN) {
      o.remOsd += osd;
      o.remConsumers++;
    }
  }

  const byOffice = Array.from(officeMap.values())
    .map((o) => ({
      ...o,
      osd: Math.round(o.osd),
      remOsd: Math.round(o.remOsd),
      remShare: o.osd > 0 ? +(o.remOsd / o.osd).toFixed(4) : 0
    }))
    .sort((a, b) => b.osd - a.osd);

  return {
    asOn: asOf.toISOString().slice(0, 10),
    source: opts.source || 'CRM DB2 (ISUDATA.CON_WBSEDCL_OSD_CUR)',
    fieldNotes: {
      supplyStatusColumn: 'CON_STATUS',
      confirmedOnOfficeNetwork: false,
      statusFilledShare: consumers ? +(statusKnown / consumers).toFixed(4) : 0,
      note: 'Confirm CON_STATUS name/values on 13th; see docs/osd-revenue.md'
    },
    totals: {
      consumers,
      osd: Math.round(totalOsd),
      remConsumers,
      remOsd: Math.round(remOsd),
      remShare: totalOsd > 0 ? +(remOsd / totalOsd).toFixed(4) : 0,
      remMin: buckets.REM_OSD_MIN
    },
    byClass: buckets.toList(byClass, buckets.CLASS_ORDER, 'class'),
    bySupply: buckets.toList(bySupply, buckets.SUPPLY_ORDER, 'supply'),
    byHighValue: buckets.toList(byHighValue, buckets.VALUE_ORDER, 'value'),
    byAging: buckets.toList(byAging, buckets.AGING_ORDER, 'aging'),
    byOffice,
    links: {
      disconnection: '/disconnection.html',
      remOsd: '/remosd5000.html',
      remDefaulters: '/rem/defaulters.html'
    }
  };
}

function enrichRows(rawRows, asOf) {
  return rawRows.map((r) => {
    const osd = buckets.parseAmount(r.NOTOSD);
    return {
      ...r,
      _class: buckets.classBucket(r.CLASS_DESC),
      _supply: buckets.supplyBucket(r.CON_STATUS),
      _value_band: buckets.valueBand(osd),
      _aging: buckets.agingBucket(r.PAID_DATE, asOf)
    };
  });
}

async function uploadToVm(files, token) {
  const isVmHost = process.env.MZO_DATA_MODE === 'mirror'
    || (process.env.HOSTNAME && process.env.HOSTNAME.includes('oracle'));
  if (isVmHost) {
    console.log(`[${LABEL}] Running on VM host; local copy is already active.`);
    return { status: 'success', message: 'Already on VM host' };
  }

  console.log(`[${LABEL}] Uploading OSD datasets to VM (${VM_BASE_URL})...`);
  const fd = new FormData();
  if (files.master && fs.existsSync(files.master)) {
    fd.append('master', new Blob([fs.readFileSync(files.master)]), 'osd_master.csv');
  }
  if (files.summary && fs.existsSync(files.summary)) {
    fd.append('summary', new Blob([fs.readFileSync(files.summary)]), 'osd_summary.json');
  }
  if (files.disconnection && fs.existsSync(files.disconnection)) {
    fd.append('disconnection', new Blob([fs.readFileSync(files.disconnection)]), 'disconnection.csv');
  }

  const res = await fetch(`${VM_BASE_URL}/api/osd/upload`, {
    method: 'POST',
    headers: vmUploadHeaders(SYNC_KEY_ENV, token),
    body: fd
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || json.status !== 'success') {
    throw new Error(json.message || `VM returned HTTP ${res.status}`);
  }
  console.log(`[${LABEL}] VM upload OK: ${json.message || 'OK'}`);
  return json;
}

async function syncRevenueOsdFromCrm(options = {}) {
  const isCli = options.isCli ?? false;
  const dryRun = options.dryRun ?? false;
  const skipDb = options.skipDb ?? false;
  const useFixture = options.fixture ?? false;
  const fresh = options.fresh ?? true;
  const userToken = options.userToken || '';
  // Fixture runs must not clobber a real disconnection.csv unless explicitly asked.
  const alsoDisconnection = options.alsoDisconnection != null
    ? !!options.alsoDisconnection
    : !useFixture;

  if (!dryRun) vmUploadHeaders(SYNC_KEY_ENV, userToken);

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const tempRaw = path.join(TEMP_DIR, 'osd_raw.csv');

  if (useFixture) {
    fs.copyFileSync(FIXTURE_FILE, tempRaw);
    console.log(`[${LABEL}] Using fixture ${FIXTURE_FILE}`);
  } else {
    const needsDb = fresh || !skipDb || !fs.existsSync(tempRaw);
    if (needsDb) runDbvisExtraction({ prefix: options.prefix || '' });
    else console.log(`[${LABEL}] Skipping DB2; using ${tempRaw}`);
  }

  const asOf = new Date();
  const rawRows = loadRawCsv(tempRaw);
  const masterRows = enrichRows(rawRows, asOf);
  const summary = buildSummary(masterRows, {
    asOf,
    source: useFixture
      ? 'fixture (scripts/fixtures/osd_sample.csv)'
      : 'CRM DB2 (ISUDATA.CON_WBSEDCL_OSD_CUR)'
  });

  const nowIso = new Date().toISOString();
  const version = 'v:' + nowIso.replace(/[-:TZ.]/g, '').slice(0, 14);
  summary.version = version;
  summary.uploadedAt = nowIso;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const masterPath = path.join(DATA_DIR, 'osd_master.csv');
  const summaryPath = path.join(DATA_DIR, 'osd_summary.json');
  const disconPath = path.join(DATA_DIR, 'disconnection.csv');
  const metaPath = path.join(DATA_DIR, 'osd_meta.json');

  const masterCsv = rowsToCsv(MASTER_HEADERS, masterRows);
  fs.writeFileSync(masterPath, masterCsv, 'utf8');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  if (alsoDisconnection) {
    const disconCsv = rowsToCsv(DISCON_HEADERS, masterRows);
    fs.writeFileSync(disconPath, disconCsv, 'utf8');
  }

  const meta = {
    version,
    updatedAt: nowIso,
    asOn: summary.asOn,
    reportDate: summary.asOn,
    source: summary.source,
    stats: summary.totals,
    summaryUrl: '/api/osd/summary',
    csvUrl: '/api/osd/dataset',
    datasetUrl: '/api/osd/dataset',
    fieldNotes: summary.fieldNotes
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  if (storageConfigured() && !dryRun) {
    try {
      await upload('osd/master.csv', masterCsv, 'text/csv');
      await upload('osd/summary.json', JSON.stringify(summary), 'application/json');
      if (alsoDisconnection) {
        await upload('disconnection/snapshot.csv', rowsToCsv(DISCON_HEADERS, masterRows), 'text/csv');
      }
    } catch (e) {
      console.warn(`[${LABEL}] Storage upload failed: ${e.message}`);
    }
  }

  await publishMeta('osd', 'osd_meta.json', meta, LABEL);
  if (alsoDisconnection && !dryRun) {
    await publishMeta('disconnection', 'disconnection_meta.json', {
      version,
      updatedAt: nowIso,
      reportDate: summary.asOn,
      stats: {
        totalConsumers: summary.totals.consumers,
        totalOSD: summary.totals.osd,
        osd5kCount: summary.totals.remConsumers,
        syncedAt: nowIso
      },
      csvUrl: '/api/disconnection/dataset',
      source: summary.source
    }, LABEL);
  }

  if (!dryRun) {
    try {
      await uploadToVm({
        master: masterPath,
        summary: summaryPath,
        disconnection: alsoDisconnection ? disconPath : null
      }, userToken);
    } catch (err) {
      console.warn(`[${LABEL}] VM upload notice: ${err.message}`);
    }
  }

  const cr = (summary.totals.osd / 1e7).toFixed(2);
  const remCr = (summary.totals.remOsd / 1e7).toFixed(2);
  const sharePct = (summary.totals.remShare * 100).toFixed(1);
  console.log(`\n======================================================`);
  console.log(`[${LABEL}] Summary`);
  console.log(`  • As on:           ${summary.asOn}`);
  console.log(`  • Consumers:       ${summary.totals.consumers.toLocaleString()}`);
  console.log(`  • Total OSD:       ₹${cr} Cr`);
  console.log(`  • REM ≥ ₹5,000:    ₹${remCr} Cr (${sharePct}% of total, ${summary.totals.remConsumers} consumers)`);
  console.log(`  • Files:           ${masterPath}`);
  console.log(`                     ${summaryPath}`);
  if (alsoDisconnection) console.log(`                     ${disconPath}`);
  console.log(`======================================================\n`);

  return {
    status: 'success',
    message: `OSD master ${summary.totals.consumers} consumers, ₹${cr} Cr (REM share ${sharePct}%)`,
    summary,
    meta
  };
}

module.exports = {
  syncRevenueOsdFromCrm,
  isDbvisAvailable,
  buildSummary,
  enrichRows,
  DIVISIONS,
  runDbvisExtraction
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const prefixArg = args.find((a) => a.startsWith('--prefix='));
  syncRevenueOsdFromCrm({
    isCli: true,
    dryRun: args.includes('--dry-run'),
    skipDb: args.includes('--skip-db'),
    fixture: args.includes('--fixture'),
    fresh: !args.includes('--skip-db'),
    prefix: prefixArg ? prefixArg.slice('--prefix='.length) : ''
  }).catch((err) => {
    console.error(`[${LABEL}] Error:`, err);
    process.exit(1);
  });
}
