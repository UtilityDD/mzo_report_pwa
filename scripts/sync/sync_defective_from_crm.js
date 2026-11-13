/**
 * sync_defective_from_crm.js
 *
 * 100% Automated Defective Meter Sync Pipeline:
 *
 * Database: IBM DB2 (db2_mig @ 10.251.64.65:60000, user: report)
 * Tool: DbVisualizer CLI (dbviscmd.bat) with connection "ibm db2"
 *
 * Workflow:
 * 1. Executes 7 division-by-division queries sequentially via dbviscmd to eliminate
 *    database gateway timeouts.
 * 2. Division batches:
 *    - 6611%: Malda Division
 *    - 6612%: Chanchal Division
 *    - 6613%: Gazole Division
 *    - 6621%: Raiganj Division
 *    - 6622%: Islampur Division
 *    - 6631%: Balurghat Division
 *    - 6632%: Buniadpur Division
 * 3. Ingests all exported chunk CSVs.
 * 4. Aggregates summary counts and priority consumer details via MzoDefectivePipeline.
 * 5. Computes all KPI metrics (total defective, >10 yrs, >5 yrs, 3-phase, industrial, smart, loads).
 * 6. Uploads snapshot CSVs and meta.json directly to Supabase Storage ('reports' bucket).
 *
 * Usage:
 *   npm run sync:defective:crm                     # 100% automated direct run via dbviscmd
 *   npm run sync:defective:crm -- --dry-run        # preview KPIs locally without uploading to Supabase
 *   npm run sync:defective:crm -- --skip-db        # skip DB extract, use existing local chunks
 *   npm run sync:defective:crm -- --file <file>    # ingest a single combined CSV dump
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { MzoDefectivePipeline: P } = require('../../lib/defective_meter_pipeline');
const { storageConfigured, upload, publishMeta, cli } = require('./common');

const LABEL = 'CRM Defective Sync';
const DBVIS_CONNECTION = 'ibm db2';
const DBVIS_CMD_PATH = 'C:\\Program Files\\DbVisualizer\\dbviscmd.bat';

const DIVISIONS = [
  { prefix: '6611', name: 'Malda Division' },
  { prefix: '6612', name: 'Chanchal Division' },
  { prefix: '6613', name: 'Gazole Division' },
  { prefix: '6621', name: 'Raiganj Division' },
  { prefix: '6622', name: 'Islampur Division' },
  { prefix: '6631', name: 'Balurghat Division' },
  { prefix: '6632', name: 'Buniadpur Division' }
];

async function runDbvisBatchExtraction(chunksDir, resume = true, onProgress) {
  if (!fs.existsSync(DBVIS_CMD_PATH)) {
    throw new Error(`DbVisualizer CLI not found at ${DBVIS_CMD_PATH}`);
  }

  console.log(`[${LABEL}] Extracting defective meters division-by-division using DbVisualizer ("${DBVIS_CONNECTION}")...`);

  const report = async (div, index, state) => {
    if (typeof onProgress === 'function') {
      await onProgress({ phase: 'division', index, total: DIVISIONS.length, name: div.name, prefix: div.prefix, state });
    }
  };

  for (let i = 0; i < DIVISIONS.length; i++) {
    const div = DIVISIONS[i];
    const chunkFile = path.join(chunksDir, `chunk_${div.prefix}.csv`);

    // If resume is enabled and the chunk already has valid data, reuse it
    if (resume && fs.existsSync(chunkFile) && fs.statSync(chunkFile).size > 1000) {
      const stats = fs.statSync(chunkFile);
      console.log(`\n  [${i + 1}/${DIVISIONS.length}] ${div.name} (Prefix: ${div.prefix}%): Already downloaded (${(stats.size / 1024 / 1024).toFixed(2)} MB), skipping extraction.`);
      await report(div, i + 1, 'done');
      continue;
    }

    const tempSqlFile = path.join(chunksDir, `query_${div.prefix}.sql`);

    // Use normalized forward slashes for DbVisualizer @export path
    const normalizedChunkPath = chunkFile.replace(/\\/g, '/');

    const sqlContent = [
      '@export on;',
      `@export set filename="${normalizedChunkPath}" format="csv" delimiter="," quote="true";`,
      `SELECT * FROM isudata.meter_status_report WHERE CCC_code LIKE '${div.prefix}%' AND curr_def_status = 'X';`,
      '@export off;'
    ].join('\n');

    fs.writeFileSync(tempSqlFile, sqlContent, 'utf8');

    const maxAttempts = 3;
    let divisionSuccess = false;

    for (let attempt = 1; attempt <= maxAttempts && !divisionSuccess; attempt++) {
      if (attempt > 1) {
        console.log(`    [Retry ${attempt}/${maxAttempts}] Reconnecting for ${div.name} in 10 seconds...`);
        spawnSync('powershell', ['-Command', 'Start-Sleep -Seconds 10']);
      }

      if (attempt === 1) await report(div, i + 1, 'start');
      console.log(`\n  [${i + 1}/${DIVISIONS.length}] Querying ${div.name} (Prefix: ${div.prefix}%, attempt ${attempt}/${maxAttempts})...`);
      const tStart = Date.now();

      const dbvisHome = path.dirname(DBVIS_CMD_PATH);
      const res = spawnSync('cmd.exe', [
        '/c', 'dbviscmd.bat',
        '-connection', DBVIS_CONNECTION,
        '-sqlfile', tempSqlFile,
        '-stoponerror'
      ], {
        cwd: dbvisHome,
        stdio: 'inherit',
        timeout: 900000 // 15 minutes max per division
      });

      if (res.status === 0 && fs.existsSync(chunkFile) && fs.statSync(chunkFile).size > 100) {
        const stats = fs.statSync(chunkFile);
        console.log(`    Saved ${div.name} -> ${(stats.size / 1024).toFixed(1)} KB in ${Date.now() - tStart}ms`);
        divisionSuccess = true;
      } else {
        const errDetail = res.error && res.error.code === 'ETIMEDOUT' ? 'timed out after 15 min' : `exit code ${res.status}`;
        console.warn(`    Warning: Query attempt ${attempt} for ${div.name} failed (${errDetail}).`);
      }
    }

    try { fs.unlinkSync(tempSqlFile); } catch (_) { }
    await report(div, i + 1, 'done');

    if (!divisionSuccess) {
      throw new Error(`Failed to extract division ${div.prefix} (${div.name}) after ${maxAttempts} attempts.`);
    }
  }

  console.log(`\n[${LABEL}] All 7 divisions extracted successfully!`);
}

function formatAsOnDate(raw) {
  const str = String(raw || '').trim();
  if (/^\d{8}$/.test(str)) {
    const y = str.slice(0, 4);
    const m = str.slice(4, 6);
    const d = str.slice(6, 8);
    return `${d}/${m}/${y}`;
  }
  return str;
}

function escapeCsvField(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const line = headers.map(h => escapeCsvField(r[h])).join(',');
    lines.push(line);
  }
  return lines.join('\n');
}

function isDbvisAvailable() {
  return fs.existsSync(DBVIS_CMD_PATH);
}

async function run(options = {}) {
  const args = process.argv ? process.argv.slice(2) : [];
  const dryRun = options.dryRun !== undefined ? !!options.dryRun : args.includes('--dry-run');
  const skipDb = options.skipDb !== undefined ? !!options.skipDb : args.includes('--skip-db');
  const fresh = options.fresh !== undefined ? !!options.fresh : (args.includes('--fresh') || args.includes('--clean'));
  const fileIdx = args.indexOf('--file');
  const dirIdx = args.indexOf('--dir');

  const defaultDir = path.join(__dirname, '..', '..', 'data', 'temp', 'crm_defective');
  const chunksDir = dirIdx !== -1 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : defaultDir;
  const singleFile = fileIdx !== -1 && args[fileIdx + 1] ? path.resolve(args[fileIdx + 1]) : null;

  console.log(`[${LABEL}] Starting ingestion (${dryRun ? 'DRY-RUN mode' : 'LIVE upload'})...`);
  const t0 = Date.now();

  let allRawRows = [];

  if (singleFile) {
    if (!fs.existsSync(singleFile)) {
      throw new Error(`Specified dump file not found: ${singleFile}`);
    }
    console.log(`[${LABEL}] Reading single file: ${singleFile}`);
    const text = fs.readFileSync(singleFile, 'utf8');
    allRawRows = P.parseCsv(text);
    console.log(`[${LABEL}] Parsed ${allRawRows.length.toLocaleString()} raw rows.`);
  } else {
    if (!fs.existsSync(chunksDir)) {
      fs.mkdirSync(chunksDir, { recursive: true });
    }

    // Automated 1-command extraction via DbVisualizer CLI
    if (!skipDb) {
      try {
        await runDbvisBatchExtraction(chunksDir, !fresh, options.onProgress);
      } catch (err) {
        console.warn(`\n[${LABEL}] Automated database query notice: ${err.message}`);
        console.log(`[${LABEL}] Checking if existing division chunks can be ingested...`);
      }
    }

    const foundDivisions = [];
    const missingDivisions = [];

    for (const div of DIVISIONS) {
      const chunkFile = path.join(chunksDir, `chunk_${div.prefix}.csv`);
      if (fs.existsSync(chunkFile)) {
        const text = fs.readFileSync(chunkFile, 'utf8');
        const rows = P.parseCsv(text);
        console.log(`  ✓ [${div.prefix}] ${div.name.padEnd(20)} : ${rows.length.toLocaleString().padStart(7)} rows (${path.basename(chunkFile)})`);
        allRawRows.push(...rows);
        foundDivisions.push(div);
      } else {
        missingDivisions.push(div);
      }
    }

    if (!foundDivisions.length) {
      throw new Error(
        `No division chunk files found in ${chunksDir}.\n` +
        `Please ensure you are connected to the network/VPN (10.251.64.65) to run automated extraction,\n` +
        `or run scripts/sql/defective_meter_crm_batch.sql in DbVisualizer.`
      );
    }

    if (missingDivisions.length > 0) {
      console.warn(`[${LABEL}] Warning: ${missingDivisions.length} division(s) were missing: ${missingDivisions.map(d => d.prefix).join(', ')}`);
    }

    console.log(`[${LABEL}] Total raw rows collected across ${foundDivisions.length} division(s): ${allRawRows.length.toLocaleString()}`);
  }

  if (!allRawRows.length) {
    throw new Error('No valid rows found in CRM dump.');
  }

  // Aggregate summary and filter priority details via pipeline
  console.log(`[${LABEL}] Processing through MzoDefectivePipeline...`);
  const built = P.buildFromRows(allRawRows);
  console.log(`[${LABEL}] Pipeline generated: ${built.summary.length.toLocaleString()} summary rows, ${built.details.length.toLocaleString()} priority detail rows.`);

  // Parse headers & compute stats from summary
  let rawAsOn = built.reportAsOn || '';
  let totalDefective = 0;
  let totalAgri = 0;
  let totalOver10 = 0;
  let totalOver5 = 0;
  let totalPh3 = 0;
  let totalIndustrial = 0;
  let totalSmart = 0;
  let totalLoadGt6 = 0;
  let totalLoad3_6 = 0;
  let totalLoad1_3 = 0;
  let totalLoad05_1 = 0;
  let totalLoadLt05 = 0;

  const divisionStats = {};

  for (let i = 0; i < built.summary.length; i++) {
    const row = built.summary[i];
    if (!rawAsOn && row.REPORT_AS_ON) rawAsOn = String(row.REPORT_AS_ON).trim();

    const tot = Number(row.total || 0);
    const agri = Number(row.agri || 0);
    const over10 = Number(row.over10 || 0);
    const over5 = Number(row.over5 || 0);
    const ph3 = Number(row.ph3 || 0);
    const ind = Number(row.industrial || 0);
    const smart = Number(row.smart || 0);
    const lGt6 = Number(row.load_gt6 || 0);
    const l3_6 = Number(row.load_3_6 || 0);
    const l1_3 = Number(row.load_1_3 || 0);
    const l05_1 = Number(row.load_05_1 || 0);
    const lLt05 = Number(row.load_lt_05 || 0);

    totalDefective += tot;
    totalAgri += agri;
    totalOver10 += over10;
    totalOver5 += over5;
    totalPh3 += ph3;
    totalIndustrial += ind;
    totalSmart += smart;
    totalLoadGt6 += lGt6;
    totalLoad3_6 += l3_6;
    totalLoad1_3 += l1_3;
    totalLoad05_1 += l05_1;
    totalLoadLt05 += lLt05;

    const divName = (row.DIVISION || '').trim();
    if (divName) {
      if (!divisionStats[divName]) {
        divisionStats[divName] = { total: 0, agri: 0, over10: 0, over5: 0, ph3: 0, smart: 0 };
      }
      divisionStats[divName].total += tot;
      divisionStats[divName].agri += agri;
      divisionStats[divName].over10 += over10;
      divisionStats[divName].over5 += over5;
      divisionStats[divName].ph3 += ph3;
      divisionStats[divName].smart += smart;
    }
  }

  const reportDateFormatted = formatAsOnDate(rawAsOn);
  const nowIso = new Date().toISOString();
  const version = rawAsOn ? `v:${rawAsOn}` : `v:${nowIso.slice(0, 10).replace(/-/g, '')}`;

  const stats = {
    totalDefective,
    agri: totalAgri,
    over10: totalOver10,
    over5: totalOver5,
    ph3: totalPh3,
    industrial: totalIndustrial,
    smart: totalSmart,
    loadGt6: totalLoadGt6,
    load3_6: totalLoad3_6,
    load1_3: totalLoad1_3,
    load05_1: totalLoad05_1,
    loadLt05: totalLoadLt05,
    summaryRows: built.summary.length,
    detailsRows: built.details.length,
    reportDate: reportDateFormatted,
    divisions: divisionStats,
    syncedAt: nowIso
  };

  console.log(`\n=== [${LABEL}] KPI Summary ===`);
  console.log(`  Report As-On Date : ${reportDateFormatted || 'Today'}`);
  console.log(`  Total Defective   : ${totalDefective.toLocaleString()}`);
  console.log(`  Over 10 Years     : ${totalOver10.toLocaleString()}`);
  console.log(`  Over 5 Years      : ${totalOver5.toLocaleString()}`);
  console.log(`  Three Phase       : ${totalPh3.toLocaleString()}`);
  console.log(`  Industrial        : ${totalIndustrial.toLocaleString()}`);
  console.log(`  Smart Meter       : ${totalSmart.toLocaleString()}`);
  console.log(`  Agriculture       : ${totalAgri.toLocaleString()}`);
  console.log(`  Summary Rows      : ${built.summary.length.toLocaleString()}`);
  console.log(`  Priority Details  : ${built.details.length.toLocaleString()}`);
  console.log(`==============================\n`);

  if (dryRun) {
    console.log(`[${LABEL}] Dry run completed successfully in ${Date.now() - t0}ms. No data was written to Supabase.`);
    return { status: 'dry-run', stats };
  }

  if (!storageConfigured()) {
    throw new Error('Supabase Storage is not configured. Missing INSIGHT_SUPABASE_URL / INSIGHT_SUPABASE_KEY.');
  }

  console.log(`[${LABEL}] Serializing CSV snapshots...`);
  const summaryCsv = toCsv(built.summaryHeaders, built.summary);
  const detailsCsv = toCsv(built.detailsHeaders, built.details);

  console.log(
    `[${LABEL}] Uploading to Supabase Storage ('reports' bucket) — Summary: ${(summaryCsv.length / 1024 / 1024).toFixed(2)} MB, Details: ${(detailsCsv.length / 1024 / 1024).toFixed(2)} MB...`
  );

  const [sumUrl, detUrl] = await Promise.all([
    upload('defective/summary.csv', summaryCsv, 'text/csv'),
    upload('defective/details.csv', detailsCsv, 'text/csv')
  ]);

  const publicSummaryUrl = `${sumUrl}?v=${rawAsOn || Date.now()}`;
  const publicDetailsUrl = `${detUrl}?v=${rawAsOn || Date.now()}`;

  const meta = {
    version,
    updatedAt: nowIso,
    reportDate: reportDateFormatted,
    stats,
    summaryCsvUrl: publicSummaryUrl,
    detailsCsvUrl: publicDetailsUrl,
    source: 'supabase_storage'
  };

  await publishMeta('defective', 'defective_meta.json', meta, LABEL);

  console.log(`[${LABEL}] Sync successfully completed in ${Date.now() - t0}ms!`);
  return meta;
}

module.exports = { syncDefectiveFromCrm: run, isDbvisAvailable };

cli(module, run, LABEL);
