/**
 * sync_pending_mc_to_supabase.js
 * Fetches Pending Master Card CSV from Google Sheets, generates pre-computed KPIs,
 * and uploads snapshot.csv to Supabase Storage ('reports' bucket).
 */
const { parseCsvLine, fetchCsv, storageConfigured, upload, publishMeta, cli } = require('./common');

const LABEL = 'Pending MC Sync';
const GOOGLE_CSV_URL =
  process.env.PENDING_MC_SHEET_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQmOUW4jxUtEGWhPHaoNBsvpBcGzhHJZRUx_9mxFBp91sfg4yD8WIqIK_xv0vlFs2yP-Ljz09JW1U2c/pub?gid=0&single=true&output=csv';

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
  const t0 = Date.now();
  const csvText = await fetchCsv(GOOGLE_CSV_URL, LABEL);

  const lines = csvText.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new Error('CSV is empty or malformed.');

  const headers = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, '').trim());
  const colIndex = {};
  headers.forEach((h, i) => { if (h) colIndex[h] = i; });

  const regionIdx = colIndex['Region'] ?? -1;
  const divIdx = colIndex['Division'] ?? -1;
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

  console.log(`[${LABEL}] Summary stats:`, stats);

  let publicCsvUrl = '';
  if (storageConfigured()) {
    try {
      publicCsvUrl = `${await upload('pending_mc/snapshot.csv', csvText, 'text/csv')}?v=${encodeURIComponent(version)}`;
    } catch (e) {
      console.warn(`[${LABEL}] Storage upload failed: ${e.message}`);
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
  await publishMeta('pending_mc', 'pending_mc_meta.json', meta, LABEL);

  console.log(`[${LABEL}] Done in ${Date.now() - t0}ms`);
  return meta;
}

module.exports = { syncPendingMcToSupabase: run };

cli(module, run, LABEL);
