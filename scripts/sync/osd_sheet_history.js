/**
 * Fold the REM OSD Google Sheet into the summary history.
 *
 * The sheet is one row per CCC and notice due date. Amounts are lakhs.
 * Each notice date becomes one snapshot: REM by class, division and CCC.
 * It does not include every consumer's outstanding, so total OSD is left
 * empty and the chart draws a gap there. A snapshot that already has a
 * total (the DB2 extract) is kept.
 *
 *   node scripts/sync/osd_sheet_history.js
 *   node scripts/sync/osd_sheet_history.js --file data/temp/osd/rem_sheet.csv
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const offices = require('../../lib/offices');

const SHEET = 'https://docs.google.com/spreadsheets/d/18y_nHZngDDO13nlluN9qba7AfgDe5dKGGHnXRYUU-b8/gviz/tq?tqx=out:csv';
const HISTORY = path.join(__dirname, '..', '..', 'data', 'osd_summary_history.json');
const SOURCE = 'REM OSD sheet (notice due date)';
const CLASSES = [
  ['DOMESTIC', 'Domestic', 7, 8],
  ['COMMERCIAL', 'Commercial', 9, 10],
  ['INDUSTRIAL', 'Industrial', 11, 12],
  ['OTHERS', 'Others', 13, 14]
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function num(v) {
  const n = parseFloat(String(v || '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function rupees(lakhs) {
  return Math.round(num(lakhs) * 1e5);
}

function isoFromDmy(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'MZO-Reports' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(res.headers.location).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error('Sheet HTTP ' + res.statusCode));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
    }).on('error', reject);
  });
}

function snapshotFromRows(asOn, rows) {
  const byCcc = [];
  const classSum = {};
  CLASSES.forEach(([key, label]) => { classSum[key] = { key, label, remConsumers: 0, remOsd: 0 }; });
  let remConsumers = 0;
  let remOsd = 0;
  rows.forEach((r) => {
    const code = String(r[6] || '').trim();
    const hit = offices.parseCode(code) || {};
    const ccc = {
      region: hit.region || offices.canonRegion(r[3]) || 'Other',
      division: hit.division || '',
      ccc: hit.ccc || String(r[5] || '').trim(),
      cccCode: code,
      consumers: null,
      osd: null,
      remConsumers: num(r[15]),
      remOsd: rupees(r[16])
    };
    byCcc.push(ccc);
    remConsumers += ccc.remConsumers;
    remOsd += ccc.remOsd;
    CLASSES.forEach(([key, , nAt, aAt]) => {
      classSum[key].remConsumers += num(r[nAt]);
      classSum[key].remOsd += rupees(r[aAt]);
    });
  });
  const officeMap = {};
  byCcc.forEach((row) => {
    const k = row.region + '\t' + row.division;
    const o = officeMap[k] || (officeMap[k] = {
      region: row.region,
      division: row.division,
      ccc: '',
      cccCode: '',
      consumers: null,
      osd: null,
      remConsumers: 0,
      remOsd: 0
    });
    o.remConsumers += row.remConsumers;
    o.remOsd += row.remOsd;
  });
  const byClass = CLASSES.map(([key]) => classSum[key]).concat([
    { key: 'AGRICULTURE', label: 'Agriculture', remConsumers: 0, remOsd: 0 },
    { key: 'GOVERNMENT', label: 'Government', remConsumers: 0, remOsd: 0 }
  ]);
  return {
    asOn,
    savedAt: new Date().toISOString(),
    source: SOURCE,
    totals: {
      consumers: null,
      osd: null,
      remConsumers,
      remOsd,
      remShare: null,
      remMin: 5000
    },
    byClass,
    bySupply: [],
    byHighValue: [],
    byAging: [],
    byOffice: Object.values(officeMap).sort((a, b) => b.remOsd - a.remOsd),
    byCcc: byCcc.sort((a, b) => b.remOsd - a.remOsd)
  };
}

function readHistory(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && Array.isArray(parsed.snapshots)) return parsed.snapshots;
  } catch (_) { /* first import */ }
  return [];
}

function hasTotal(snap) {
  return !!(snap && snap.totals && snap.totals.osd != null && Number(snap.totals.osd) > 0);
}

async function main() {
  const args = process.argv.slice(2);
  const fileFlag = args.indexOf('--file');
  const text = fileFlag !== -1 && args[fileFlag + 1]
    ? fs.readFileSync(path.resolve(args[fileFlag + 1]), 'utf8')
    : await download(SHEET);
  const table = parseCsv(text.replace(/^\uFEFF/, ''));
  const groups = {};
  table.slice(1).forEach((r) => {
    const asOn = isoFromDmy(r[1]);
    const code = String(r[6] || '').trim();
    if (!asOn || !code) return;
    (groups[asOn] || (groups[asOn] = [])).push(r);
  });
  const incoming = Object.keys(groups).sort().map((asOn) => snapshotFromRows(asOn, groups[asOn]));
  const kept = readHistory(HISTORY);
  const byDate = {};
  kept.forEach((snap) => { if (snap && snap.asOn) byDate[snap.asOn] = snap; });
  let added = 0;
  let skipped = 0;
  incoming.forEach((snap) => {
    if (hasTotal(byDate[snap.asOn])) { skipped++; return; }
    if (!byDate[snap.asOn]) added++;
    byDate[snap.asOn] = snap;
  });
  const snapshots = Object.values(byDate).sort((a, b) => String(a.asOn).localeCompare(String(b.asOn))).slice(-400);
  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
  fs.writeFileSync(HISTORY, JSON.stringify({ snapshots }, null, 2), 'utf8');
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  console.log(JSON.stringify({
    dates: snapshots.length,
    added,
    keptBecauseTotal: skipped,
    from: first && first.asOn,
    to: last && last.asOn,
    latestRemCr: last && last.totals ? +(last.totals.remOsd / 1e7).toFixed(2) : null,
    latestSource: last && last.source
  }));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
