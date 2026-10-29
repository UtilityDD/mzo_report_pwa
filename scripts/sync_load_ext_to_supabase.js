/**
 * sync_load_ext_to_supabase.js
 * Fetches Pending Load Extension CSV from Google Sheets, generates pre-computed KPIs,
 * and uploads snapshot.csv to Supabase Storage ('reports' bucket).
 */
const fs = require('fs');
const path = require('path');

const GOOGLE_CSV_URL =
  process.env.LOAD_EXT_SHEET_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQP_B-Zl5XhnYkmJiDXKB7B8ksrRRezuLrRqTzEPz4lEw_yDcpGOTnmm0oI8dW9apwuHg9yGqaAqjDS/pub?gid=0&single=true&output=csv';

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
const STORAGE_OBJECT = 'load_extension/snapshot.csv';
const META_FILE = path.join(__dirname, '..', 'data', 'load_ext_meta.json');

function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

const DIV_MAP = {
  '6611': 'Malda',
  '6612': 'Chanchal',
  '6613': 'Gazole',
  '6621': 'Raiganj',
  '6622': 'Islampur',
  '6631': 'Balurghat',
  '6632': 'Buniadpur'
};

async function run() {
  console.log('[Load Extension Sync] Fetching CSV from Google Sheets...');
  const t0 = Date.now();
  const res = await fetch(GOOGLE_CSV_URL);
  if (!res.ok) throw new Error(`Google Sheets fetch HTTP ${res.status}`);
  const csvText = await res.text();
  console.log(
    `[Load Extension Sync] Downloaded in ${Date.now() - t0}ms (${(csvText.length / 1024).toFixed(1)} KB)`
  );

  const lines = csvText.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new Error('CSV is empty or malformed.');

  const headers = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, '').trim());
  const colIndex = {};
  headers.forEach((h, i) => { if (h) colIndex[h] = i; });

  const cccIdx = colIndex['CCC CODE'] ?? -1;
  const classIdx = colIndex['CONN_CLASS'] ?? -1;
  const phaseIdx = colIndex['CONN_PHASE'] ?? -1;
  const loadIdx = colIndex['LOAD_APPLIED'] ?? -1;
  const ageIdx = colIndex['AGE_MONTHS'] ?? -1;
  const repDateIdx = colIndex['report_date'] ?? colIndex['REPORT_DATE'] ?? -1;

  let totalCount = 0;
  let industrialCount = 0;
  let commercialCount = 0;
  let threePhaseCount = 0;
  let highLoadCount = 0;
  let ageing6mCount = 0;
  let ageing1yCount = 0;
  let reportDateRaw = '';
  const divisions = {
    Malda: 0,
    Chanchal: 0,
    Gazole: 0,
    Raiganj: 0,
    Islampur: 0,
    Balurghat: 0,
    Buniadpur: 0
  };

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]).map(c => c.replace(/^"|"$/g, '').trim());
    if (!cols || cols.length < 4) continue;

    totalCount++;

    const ccc = cccIdx >= 0 ? cols[cccIdx] : '';
    const divPrefix = ccc.slice(0, 4);
    if (DIV_MAP[divPrefix]) {
      divisions[DIV_MAP[divPrefix]] = (divisions[DIV_MAP[divPrefix]] || 0) + 1;
    }

    const cls = classIdx >= 0 ? cols[classIdx] : '';
    if (cls === 'I') industrialCount++;
    if (cls === 'C') commercialCount++;

    const phase = phaseIdx >= 0 ? cols[phaseIdx] : '';
    if (phase === 'III') threePhaseCount++;

    const loadVal = loadIdx >= 0 ? parseFloat(cols[loadIdx]) : 0;
    if (!isNaN(loadVal) && loadVal > 10000) highLoadCount++;

    const ageVal = ageIdx >= 0 ? parseInt(cols[ageIdx], 10) : 0;
    if (!isNaN(ageVal)) {
      if (ageVal > 6) ageing6mCount++;
      if (ageVal > 12) ageing1yCount++;
    }

    if (!reportDateRaw && repDateIdx >= 0 && cols[repDateIdx]) {
      reportDateRaw = cols[repDateIdx];
    }
  }

  const nowIso = new Date().toISOString();
  const version = nowIso;

  const stats = {
    totalPending: totalCount,
    industrial: industrialCount,
    commercial: commercialCount,
    threePhase: threePhaseCount,
    highLoad: highLoadCount,
    ageing6m: ageing6mCount,
    ageing1y: ageing1yCount,
    reportDate: reportDateRaw,
    divisions,
    syncedAt: nowIso
  };

  console.log('[Load Extension Sync] Summary stats:', stats);

  // Upload snapshot CSV to Supabase Storage
  let publicCsvUrl = '';
  if (SUPABASE_URL && SUPABASE_KEY) {
    console.log(`[Load Extension Sync] Uploading to Supabase Storage (${STORAGE_BUCKET}/${STORAGE_OBJECT})...`);
    const uploadUrl = `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/${STORAGE_BUCKET}/${STORAGE_OBJECT}`;
    const upRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'text/csv',
        'x-upsert': 'true'
      },
      body: csvText
    });

    if (upRes.ok) {
      console.log('[Load Extension Sync] Storage upload SUCCESS!');
      publicCsvUrl = `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/${STORAGE_BUCKET}/${STORAGE_OBJECT}?v=${encodeURIComponent(version)}`;
    } else {
      console.warn('[Load Extension Sync] Storage upload failed:', upRes.status, await upRes.text());
    }
  }

  const meta = {
    version,
    updatedAt: nowIso,
    reportDate: reportDateRaw,
    stats,
    csvUrl: publicCsvUrl || GOOGLE_CSV_URL,
    source: publicCsvUrl ? 'supabase_storage' : 'google_sheet'
  };

  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf8');
  console.log(`[Load Extension Sync] Local meta saved: ${META_FILE}`);

  // Upload meta.json to Supabase Storage
  if (SUPABASE_URL && SUPABASE_KEY) {
    const metaUploadUrl = `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/${STORAGE_BUCKET}/load_extension/meta.json`;
    try {
      const mUp = await fetch(metaUploadUrl, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'x-upsert': 'true'
        },
        body: JSON.stringify(meta, null, 2)
      });
      if (mUp.ok) {
        console.log('[Load Extension Sync] Uploaded load_extension/meta.json to Supabase Storage!');
      }
    } catch (e) {
      console.warn('[Load Extension Sync] meta.json upload error:', e.message);
    }
  }

  console.log('[Load Extension Sync] ALL DONE in', Date.now() - t0, 'ms');
  return meta;
}

module.exports = { syncLoadExtToSupabase: run };

if (require.main === module) {
  run().catch(err => {
    console.error('[Load Extension Sync] Error:', err);
    process.exit(1);
  });
}
