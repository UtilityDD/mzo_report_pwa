/**
 * sync_load_ext_to_supabase.js
 * Fetches Pending Load Extension CSV from Google Sheets, generates pre-computed KPIs,
 * and uploads snapshot.csv to Supabase Storage ('reports' bucket).
 */
const { DIV_BY_CODE, parseCsvLine, fetchCsv, storageConfigured, upload, publishMeta, cli } = require('./common');

const LABEL = 'Load Extension Sync';
const GOOGLE_CSV_URL =
  process.env.LOAD_EXT_SHEET_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQP_B-Zl5XhnYkmJiDXKB7B8ksrRRezuLrRqTzEPz4lEw_yDcpGOTnmm0oI8dW9apwuHg9yGqaAqjDS/pub?gid=0&single=true&output=csv';

async function run() {
  const t0 = Date.now();
  const csvText = await fetchCsv(GOOGLE_CSV_URL, LABEL);

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
    if (DIV_BY_CODE[divPrefix]) {
      divisions[DIV_BY_CODE[divPrefix]] = (divisions[DIV_BY_CODE[divPrefix]] || 0) + 1;
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

  console.log(`[${LABEL}] Summary stats:`, stats);

  let publicCsvUrl = '';
  if (storageConfigured()) {
    try {
      publicCsvUrl = `${await upload('load_extension/snapshot.csv', csvText, 'text/csv')}?v=${encodeURIComponent(version)}`;
    } catch (e) {
      console.warn(`[${LABEL}] Storage upload failed: ${e.message}`);
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
  await publishMeta('load_extension', 'load_ext_meta.json', meta, LABEL);

  console.log(`[${LABEL}] Done in ${Date.now() - t0}ms`);
  return meta;
}

module.exports = { syncLoadExtToSupabase: run };

cli(module, run, LABEL);
