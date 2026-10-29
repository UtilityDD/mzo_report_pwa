/**
 * sync_pending_mc_to_supabase.js
 * Fetches Pending Master Card CSV from Google Sheets, generates pre-computed KPIs,
 * and uploads snapshot.csv to Supabase Storage ('reports' bucket).
 */
const fs = require('fs');
const path = require('path');

const GOOGLE_CSV_URL =
  process.env.PENDING_MC_SHEET_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQmOUW4jxUtEGWhPHaoNBsvpBcGzhHJZRUx_9mxFBp91sfg4yD8WIqIK_xv0vlFs2yP-Ljz09JW1U2c/pub?gid=0&single=true&output=csv';

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
const STORAGE_OBJECT = 'pending_mc/snapshot.csv';
const META_FILE = path.join(__dirname, '..', 'data', 'pending_mc_meta.json');

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

function parseDate(d) {
  if (!d || typeof d !== 'string') return null;
  const parts = d.trim().match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})(?:\s+.*)?$/);
  if (parts) {
    const [, day, month, year] = parts;
    return new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
  }
  const parsed = new Date(d);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function getDaysDiff(d1, d2) {
  if (!d1 || !d2) return 0;
  return Math.round((d1.getTime() - d2.getTime()) / (24 * 60 * 60 * 1000));
}

function formatDate(date) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) return '';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

async function run() {
  console.log('[Pending MC Sync] Fetching CSV from Google Sheets...');
  const t0 = Date.now();
  const res = await fetch(GOOGLE_CSV_URL);
  if (!res.ok) throw new Error(`Google Sheets fetch HTTP ${res.status}`);
  const csvText = await res.text();
  console.log(
    `[Pending MC Sync] Downloaded in ${Date.now() - t0}ms (${(csvText.length / 1024).toFixed(1)} KB)`
  );

  const lines = csvText.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new Error('CSV is empty or malformed.');

  const headers = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, '').trim());
  const colIndex = {};
  headers.forEach((h, i) => { if (h) colIndex[h] = i; });

  const regionIdx = colIndex['Region'] ?? -1;
  const divIdx = colIndex['Division'] ?? -1;
  const cccIdx = colIndex['CCC'] ?? -1;
  const classIdx = colIndex['CLASS'] ?? -1;
  const repDateIdx = colIndex['Report Date'] ?? -1;
  const instDateIdx = colIndex['Meter Installation Date'] ?? -1;

  let totalCount = 0;
  let industrialCount = 0;
  let withinMonthCount = 0;
  let delayed90Count = 0;
  let latestReportDateObj = null;
  const divisions = {};
  const regions = {};

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]).map(c => c.replace(/^"|"$/g, '').trim());
    if (!cols || cols.length < 4) continue;

    const reg = regionIdx >= 0 ? cols[regionIdx] : '';
    if (!reg) continue; // Match client filter: only rows with Region

    totalCount++;

    const div = divIdx >= 0 ? cols[divIdx] : '';
    if (div) divisions[div] = (divisions[div] || 0) + 1;
    if (reg) regions[reg] = (regions[reg] || 0) + 1;

    const cls = classIdx >= 0 ? cols[classIdx] : '';
    if (String(cls).toUpperCase() === 'I') industrialCount++;

    const repStr = repDateIdx >= 0 ? cols[repDateIdx] : '';
    const instStr = instDateIdx >= 0 ? cols[instDateIdx] : '';
    const repDate = parseDate(repStr);
    const instDate = parseDate(instStr);

    if (repDate) {
      if (!latestReportDateObj || repDate.getTime() > latestReportDateObj.getTime()) {
        latestReportDateObj = repDate;
      }
    }

    if (repDate && instDate) {
      const diff = getDaysDiff(repDate, instDate);
      if (diff <= 30) withinMonthCount++;
      if (diff >= 90) delayed90Count++;
    }
  }

  const asOnDateStr = latestReportDateObj ? formatDate(latestReportDateObj) : '';
  const nowIso = new Date().toISOString();
  const version = nowIso;

  const stats = {
    totalPending: totalCount,
    industrial: industrialCount,
    withinMonth: withinMonthCount,
    delayed90: delayed90Count,
    asOnDate: asOnDateStr,
    divisions,
    regions,
    syncedAt: nowIso
  };

  console.log('[Pending MC Sync] Summary stats:', stats);

  // Upload snapshot CSV to Supabase Storage
  let publicCsvUrl = '';
  if (SUPABASE_URL && SUPABASE_KEY) {
    console.log(`[Pending MC Sync] Uploading to Supabase Storage (${STORAGE_BUCKET}/${STORAGE_OBJECT})...`);
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
      console.log('[Pending MC Sync] Storage upload SUCCESS!');
      publicCsvUrl = `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/${STORAGE_BUCKET}/${STORAGE_OBJECT}?v=${encodeURIComponent(version)}`;
    } else {
      console.warn('[Pending MC Sync] Storage upload failed:', upRes.status, await upRes.text());
    }
  }

  const meta = {
    version,
    updatedAt: nowIso,
    reportDate: asOnDateStr,
    stats,
    csvUrl: publicCsvUrl || GOOGLE_CSV_URL,
    source: publicCsvUrl ? 'supabase_storage' : 'google_sheet'
  };

  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf8');
  console.log(`[Pending MC Sync] Local meta saved: ${META_FILE}`);

  // Upload meta.json to Supabase Storage
  if (SUPABASE_URL && SUPABASE_KEY) {
    const metaUploadUrl = `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/${STORAGE_BUCKET}/pending_mc/meta.json`;
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
        console.log('[Pending MC Sync] Uploaded pending_mc/meta.json to Supabase Storage!');
      }
    } catch (e) {
      console.warn('[Pending MC Sync] meta.json upload error:', e.message);
    }
  }

  console.log('[Pending MC Sync] ALL DONE in', Date.now() - t0, 'ms');
  return meta;
}

module.exports = { syncPendingMcToSupabase: run };

if (require.main === module) {
  run().catch(err => {
    console.error('[Pending MC Sync] Error:', err);
    process.exit(1);
  });
}
