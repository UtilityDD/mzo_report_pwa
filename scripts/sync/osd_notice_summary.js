/**
 * OSD summary from ISUDATA.NOTICE_OSD.
 *
 * Grouped counts only. Does not download the consumer list and does not upload.
 * CON_WBSEDCL_OSD_CUR is empty on this database. NOTICE_OSD is the table the
 * report login can read, and it carries a recent update date.
 *
 * Connection status is not on NOTICE_OSD. CURR_OSD is not granted to this login,
 * so live / deemed / disconnected is left out until that column is readable.
 *
 *   node scripts/sync/osd_notice_summary.js --from-dir data/temp/osd
 */
'use strict';

const fs = require('fs');
const path = require('path');
const buckets = require('./osd_buckets');
const offices = require('../../lib/offices');

const SOURCE = 'CRM DB2 (ISUDATA.NOTICE_OSD)';
const CLASS_ORDER = ['DOMESTIC', 'COMMERCIAL', 'INDUSTRIAL', 'AGRICULTURE', 'GOVERNMENT', 'OTHERS'];
const CLASS_LABEL = {
  DOMESTIC: 'Domestic',
  COMMERCIAL: 'Commercial',
  INDUSTRIAL: 'Industrial',
  AGRICULTURE: 'Agriculture',
  GOVERNMENT: 'Government',
  OTHERS: 'Others'
};

function parseTable(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(delim).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(delim);
    const row = {};
    headers.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    return row;
  });
}

function num(v) {
  const n = parseFloat(String(v || '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function isoFromYmd(ymd) {
  const s = String(ymd || '').trim();
  if (!/^\d{8}$/.test(s)) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function buildFromDir(dir) {
  const totals = parseTable(path.join(dir, 'agg_totals.csv'))[0] || {};
  const classes = parseTable(path.join(dir, 'agg_class.csv'));
  const slabs = parseTable(path.join(dir, 'agg_slab.csv'));
  const aging = parseTable(path.join(dir, 'agg_aging.csv'));
  const divs = parseTable(path.join(dir, 'agg_div.csv'));
  const cccFile = path.join(dir, 'agg_ccc.csv');
  const cccs = fs.existsSync(cccFile) ? parseTable(cccFile) : [];

  const consumers = num(totals.N);
  const osd = num(totals.OSD);
  const remConsumers = num(totals.REM_N);
  const remOsd = num(totals.REM_OSD);
  const asOn = isoFromYmd(totals.MAX_UPD);

  const classMap = {};
  classes.forEach((r) => { classMap[String(r.CLASS_DESC || '').toUpperCase()] = r; });
  const byClass = CLASS_ORDER.filter((key) => classMap[key]).map((key) => {
    const r = classMap[key];
    const row = {
      key,
      label: CLASS_LABEL[key] || key,
      consumers: num(r.N),
      osd: Math.round(num(r.OSD))
    };
    if (r.REM_OSD != null && String(r.REM_OSD).trim() !== '') {
      row.remConsumers = num(r.REM_N);
      row.remOsd = Math.round(num(r.REM_OSD));
    }
    return row;
  });

  const slabMap = {};
  slabs.forEach((r) => { slabMap[r.BAND] = r; });
  const byHighValue = buckets.VALUE_ORDER.filter((key) => slabMap[key]).map((key) => ({
    key,
    label: buckets.LABELS.value[key] || key,
    consumers: num(slabMap[key].N),
    osd: Math.round(num(slabMap[key].OSD))
  }));

  const ageMap = {};
  aging.forEach((r) => { ageMap[r.AGING] = r; });
  const byAging = buckets.AGING_ORDER.filter((key) => ageMap[key]).map((key) => ({
    key,
    label: buckets.LABELS.aging[key] || key,
    consumers: num(ageMap[key].N),
    osd: Math.round(num(ageMap[key].OSD))
  }));

  function named(code, asCcc) {
    const raw = String(code || '').trim();
    const hit = offices.parseCode(raw) || {};
    let ccc = '';
    if (asCcc) {
      ccc = hit.level === 'ccc' ? (hit.ccc || raw) : '';
      if (!ccc && hit.level === 'division') ccc = (hit.division || 'Division') + ' office';
      if (!ccc) ccc = raw;
    }
    return {
      region: hit.region || 'Other',
      division: hit.division || '',
      ccc
    };
  }

  function officeRow(code, r, asCcc) {
    const hit = named(code, asCcc);
    const o = num(r.OSD);
    const rem = num(r.REM_OSD);
    return {
      region: hit.region,
      division: hit.division,
      ccc: hit.ccc,
      cccCode: String(code || '').trim(),
      consumers: num(r.N),
      osd: Math.round(o),
      remOsd: Math.round(rem),
      remConsumers: num(r.REM_N),
      remShare: o > 0 ? +(rem / o).toFixed(4) : 0
    };
  }

  const byOffice = divs.map((r) => officeRow(String(r.PREFIX || '').trim(), r, false))
    .sort((a, b) => b.osd - a.osd);
  const byCcc = cccs.map((r) => officeRow(r.CCC_CODE, r, true))
    .filter((row) => row.cccCode)
    .sort((a, b) => b.osd - a.osd);

  return {
    asOn: asOn || new Date().toISOString().slice(0, 10),
    source: SOURCE,
    fieldNotes: {
      supplyReady: false,
      listsReady: false,
      supplyStatusColumn: '',
      note: 'Summary is grouped from ISUDATA.NOTICE_OSD. Live, deemed, and disconnected are not on this table, and CURR_OSD is not readable with this login, so status is omitted.'
    },
    totals: {
      consumers,
      osd: Math.round(osd),
      remConsumers,
      remOsd: Math.round(remOsd),
      remShare: osd > 0 ? +(remOsd / osd).toFixed(4) : 0,
      remMin: buckets.REM_OSD_MIN
    },
    byClass,
    bySupply: [],
    byHighValue,
    byAging,
    byOffice,
    byCcc,
    links: {
      disconnection: '/disconnection.html',
      remOsd: '/remosd5000.html',
      remDefaulters: '/rem/defaulters.html'
    }
  };
}

function writeSummary(summary, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
  return outPath;
}

module.exports = { buildFromDir, writeSummary, SOURCE };

if (require.main === module) {
  const args = process.argv.slice(2);
  const dirFlag = args.indexOf('--from-dir');
  const dir = dirFlag !== -1 && args[dirFlag + 1]
    ? path.resolve(args[dirFlag + 1])
    : path.resolve(__dirname, '../../data/temp/osd');
  const out = path.resolve(__dirname, '../../data/osd_summary.json');
  const summary = buildFromDir(dir);
  writeSummary(summary, out);
  const { appendSnapshot } = require('./osd_history');
  const historyPath = path.resolve(__dirname, '../../data/osd_summary_history.json');
  appendSnapshot(summary, historyPath);
  const cr = (summary.totals.osd / 1e7).toFixed(2);
  console.log(`[OSD summary] ${summary.totals.consumers.toLocaleString('en-IN')} consumers, ₹${cr} Cr, as on ${summary.asOn}`);
  console.log(`[OSD summary] Wrote ${out}`);
}
