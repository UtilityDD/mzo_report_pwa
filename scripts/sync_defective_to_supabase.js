/**
 * sync_defective_to_supabase.js
 * Downloads Defective Meter summary and details CSVs from Google Sheets,
 * computes pre-calculated KPI statistics, and uploads snapshot CSVs + meta.json
 * to Supabase Storage ('reports' bucket).
 */
const fs = require('fs');
const path = require('path');

const SUMMARY_GOOGLE_CSV_URL =
  process.env.DEFECTIVE_SUMMARY_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/1dMLSX2bZBqZMPooh7_CrniCjqgy4MijaFW62GKJJldA/export?format=csv&gid=0';

const DETAILS_GOOGLE_CSV_URL =
  process.env.DEFECTIVE_DETAILS_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/1dMLSX2bZBqZMPooh7_CrniCjqgy4MijaFW62GKJJldA/export?format=csv&gid=1638574999';

const CFG_PATH = path.join(__dirname, '..', 'data', 'supabase_config.json');
let SUPABASE_URL = process.env.INSIGHT_SUPABASE_URL || '';
let SUPABASE_KEY = process.env.INSIGHT_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (fs.existsSync(CFG_PATH)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    if (cfg.insightUrl) SUPABASE_URL = cfg.insightUrl;
    if (cfg.insightKey) SUPABASE_KEY = cfg.insightKey;
  } catch (_) {}
}

const STORAGE_BUCKET = process.env.REPORTS_STORAGE_BUCKET || 'reports';
const SUMMARY_STORAGE_OBJECT = 'defective/summary.csv';
const DETAILS_STORAGE_OBJECT = 'defective/details.csv';
const META_FILE = path.join(__dirname, '..', 'data', 'defective_meta.json');

function formatAsOnDate(raw) {
  const str = String(raw || '').trim();
  if (/^\d{8}$/.test(str)) {
    // YYYYMMDD -> DD/MM/YYYY
    const y = str.slice(0, 4);
    const m = str.slice(4, 6);
    const d = str.slice(6, 8);
    return `${d}/${m}/${y}`;
  }
  return str;
}

async function uploadToStorage(objectPath, content, contentType) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const root = SUPABASE_URL.replace(/\/$/, '');
  const url = `${root}/storage/v1/object/${STORAGE_BUCKET}/${objectPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': contentType,
      'x-upsert': 'true'
    },
    body: content
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Upload ${objectPath} failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  return `${root}/storage/v1/object/public/${STORAGE_BUCKET}/${objectPath}`;
}

async function run() {
  console.log('[Defective Sync] Fetching Summary & Details from Google Sheets in parallel...');
  const t0 = Date.now();

  const [sumRes, detRes] = await Promise.all([
    fetch(SUMMARY_GOOGLE_CSV_URL),
    fetch(DETAILS_GOOGLE_CSV_URL)
  ]);

  if (!sumRes.ok) throw new Error(`Summary fetch HTTP ${sumRes.status}`);
  if (!detRes.ok) throw new Error(`Details fetch HTTP ${detRes.status}`);

  const [summaryCsv, detailsCsv] = await Promise.all([
    sumRes.text(),
    detRes.text()
  ]);

  console.log(
    `[Defective Sync] Downloaded in ${Date.now() - t0}ms — Summary: ${(summaryCsv.length / 1024 / 1024).toFixed(2)} MB, Details: ${(detailsCsv.length / 1024 / 1024).toFixed(2)} MB`
  );

  const summaryLines = summaryCsv.split('\n');
  if (summaryLines.length < 2) throw new Error('Summary CSV is empty.');

  const detailsLines = detailsCsv.split('\n');
  if (detailsLines.length < 2) throw new Error('Details CSV is empty.');

  // Parse headers & compute stats from summary
  const sumHeaders = summaryLines[0].split(',').map(h => h.trim());
  const colIdx = {};
  sumHeaders.forEach((h, i) => { if (h) colIdx[h] = i; });

  let rawAsOn = '';
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

  for (let i = 1; i < summaryLines.length; i++) {
    const line = summaryLines[i].trim();
    if (!line) continue;
    const cols = line.split(',');
    if (cols.length < 10) continue;

    if (!rawAsOn && cols[colIdx['REPORT_AS_ON']]) {
      rawAsOn = cols[colIdx['REPORT_AS_ON']].trim();
    }

    const tot = Number(cols[colIdx['total']] || 0);
    const agri = Number(cols[colIdx['agri']] || 0);
    const over10 = Number(cols[colIdx['over10']] || 0);
    const over5 = Number(cols[colIdx['over5']] || 0);
    const ph3 = Number(cols[colIdx['ph3']] || 0);
    const ind = Number(cols[colIdx['industrial']] || 0);
    const smart = Number(cols[colIdx['smart']] || 0);
    const lGt6 = Number(cols[colIdx['load_gt6']] || 0);
    const l3_6 = Number(cols[colIdx['load_3_6']] || 0);
    const l1_3 = Number(cols[colIdx['load_1_3']] || 0);
    const l05_1 = Number(cols[colIdx['load_05_1']] || 0);
    const lLt05 = Number(cols[colIdx['load_lt_05']] || 0);

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

    const divName = (cols[colIdx['DIVISION']] || '').trim();
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
    summaryRows: summaryLines.length - 1,
    detailsRows: detailsLines.length - 1,
    reportDate: reportDateFormatted,
    divisions: divisionStats,
    syncedAt: nowIso
  };

  console.log('[Defective Sync] Stats computed cleanly:', {
    totalDefective,
    over10: totalOver10,
    over5: totalOver5,
    ph3: totalPh3,
    smart: totalSmart,
    reportDate: reportDateFormatted,
    summaryRows: stats.summaryRows,
    detailsRows: stats.detailsRows
  });

  // Upload Summary and Details to Supabase Storage
  let publicSummaryUrl = '';
  let publicDetailsUrl = '';

  if (SUPABASE_URL && SUPABASE_KEY) {
    console.log('[Defective Sync] Uploading Summary & Details to Supabase Storage...');
    const [sumUrl, detUrl] = await Promise.all([
      uploadToStorage(SUMMARY_STORAGE_OBJECT, summaryCsv, 'text/csv'),
      uploadToStorage(DETAILS_STORAGE_OBJECT, detailsCsv, 'text/csv')
    ]);
    publicSummaryUrl = `${sumUrl}?v=${rawAsOn || Date.now()}`;
    publicDetailsUrl = `${detUrl}?v=${rawAsOn || Date.now()}`;
    console.log('[Defective Sync] Storage upload SUCCESSFUL!');
  }

  const meta = {
    version,
    updatedAt: nowIso,
    reportDate: reportDateFormatted,
    stats,
    summaryCsvUrl: publicSummaryUrl || SUMMARY_GOOGLE_CSV_URL,
    detailsCsvUrl: publicDetailsUrl || DETAILS_GOOGLE_CSV_URL,
    source: publicSummaryUrl ? 'supabase_storage' : 'google_sheet'
  };

  // Save local metadata file
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf8');
  console.log(`[Defective Sync] Local metadata saved to ${META_FILE}`);

  // Upload meta.json to Supabase Storage
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      await uploadToStorage('defective/meta.json', JSON.stringify(meta, null, 2), 'application/json');
      console.log('[Defective Sync] Uploaded defective/meta.json to Supabase Storage!');
    } catch (e) {
      console.warn('[Defective Sync] meta.json upload error:', e.message);
    }
  }

  console.log('[Defective Sync] ALL DONE in', Date.now() - t0, 'ms');
  return meta;
}

module.exports = { syncDefectiveToSupabase: run };

if (require.main === module) {
  run().catch(err => {
    console.error('[Defective Sync] Error:', err);
    process.exit(1);
  });
}
