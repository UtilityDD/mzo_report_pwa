/**
 * sync_disconnection_to_supabase.js
 * Fetches Disconnection CSV from Google Sheets, generates pre-computed KPIs,
 * and uploads snapshot.csv to Supabase Storage ('reports' bucket).
 */
const { parseCsvLine, fetchCsv, storageConfigured, upload, publishMeta, cli } = require('./common');

const LABEL = 'Disconnection Sync';
const GOOGLE_CSV_URL =
  process.env.DISCONNECTION_SHEET_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vSkl9m38XuD5aewajE7Fc0hucP9DWz1UwEqJZeu5wELWZivSEEXWrhl7RiHFSezGeGiGdDB53s1bWit/pub?gid=0&single=true&output=csv';

function parseAmount(val) {
  if (!val) return 0;
  const cleaned = String(val).replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function extractBaseDates(headerRow) {
  let domCom = '';
  let ind = '';
  const parts = headerRow.split(',');
  for (let i = 0; i < parts.length; i++) {
    const text = parts[i].trim();
    if (text.startsWith('DOM BASE DATE')) {
      const segs = text.split(':');
      if (segs.length > 1) domCom = segs[1].trim();
    } else if (text.startsWith('IND&COM BASE DATE')) {
      const segs = text.split(':');
      if (segs.length > 1) ind = segs[1].trim();
    }
  }
  return { domCom, ind };
}

async function run() {
  const t0 = Date.now();
  const csvText = await fetchCsv(GOOGLE_CSV_URL, LABEL);

  const lines = csvText.split('\n');
  if (lines.length < 2) throw new Error('CSV is empty or malformed.');

  const headerLine = lines[0];
  const baseDates = extractBaseDates(headerLine);

  const rawHeaders = parseCsvLine(headerLine).map(h => h.trim());
  const colIndex = {};
  rawHeaders.forEach((h, i) => { if (h) colIndex[h] = i; });

  const cccIdx = colIndex['CCC_CODE'] ?? 0;
  const conIdIdx = colIndex['CON_ID'] ?? 2;
  const notosdIdx = colIndex['NOTOSD'] ?? 5;
  const paidDisconIdx = colIndex['PAID/DISCON DATE'] ?? 12;
  const finalPaidIdx = colIndex['FINAL PAID AMOUNT'] ?? 13;

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
    const hasDate = dateStr !== '' && dateStr.toLowerCase() !== '#n/a' && dateStr !== '0';
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

    if (hasDate) {
      const dateParts = dateStr.split('.');
      if (dateParts.length === 3) {
        const d = parseInt(dateParts[0], 10);
        const m = parseInt(dateParts[1], 10);
        const y = parseInt(dateParts[2], 10);
        if (y >= 2020 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
          const dt = new Date(y, m - 1, d);
          if (!latestDateObj || dt > latestDateObj) {
            latestDateObj = dt;
            latestDateFormatted = `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
          }
        }
      }
    }

    // Division breakdown
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
    domBaseDate: baseDates.domCom,
    indBaseDate: baseDates.ind,
    latestPaidDisconDate: latestDateFormatted || baseDates.domCom,
    divisions: divStats,
    syncedAt: nowIso
  };

  console.log('[Disconnection Sync] Summary computed cleanly:', {
    total: totalConsumers,
    totalOSD: (totalOSD / 10000000).toFixed(2) + ' Cr',
    paid: fullyPaidCount,
    disconnected: disconnectedCount,
    noAction: noActionCount,
    latestDate: latestDateFormatted
  });

  let publicCsvUrl = '';
  if (storageConfigured()) {
    try {
      publicCsvUrl = `${await upload('disconnection/snapshot.csv', csvText, 'text/csv')}?v=${version}`;
    } catch (e) {
      console.warn(`[${LABEL}] Storage upload failed: ${e.message}`);
    }
  }

  const meta = {
    version,
    updatedAt: nowIso,
    reportDate: latestDateFormatted || baseDates.domCom,
    stats,
    csvUrl: publicCsvUrl || GOOGLE_CSV_URL,
    source: publicCsvUrl ? 'supabase_storage' : 'google_sheet'
  };
  await publishMeta('disconnection', 'disconnection_meta.json', meta, LABEL);

  console.log(`[${LABEL}] Done in ${Date.now() - t0}ms`);
  return meta;
}

module.exports = { syncDisconnectionToSupabase: run };

cli(module, run, LABEL);
