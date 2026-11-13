/**
 * One OSD summary snapshot per as-on date.
 * The latest picture stays in osd_summary.json. This file is the trend.
 * A later upload of the same as-on date replaces that point.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_SNAPSHOTS = 400;

function slimOffice(row) {
  return {
    region: row.region || '',
    division: row.division || '',
    ccc: row.ccc || '',
    cccCode: row.cccCode || '',
    consumers: Number(row.consumers) || 0,
    osd: Number(row.osd) || 0,
    remConsumers: Number(row.remConsumers) || 0,
    remOsd: Number(row.remOsd) || 0
  };
}

function slimSlice(row) {
  const out = {
    key: row.key,
    label: row.label,
    consumers: Number(row.consumers) || 0,
    osd: Number(row.osd) || 0
  };
  if (row.remOsd != null) out.remOsd = Number(row.remOsd) || 0;
  if (row.remConsumers != null) out.remConsumers = Number(row.remConsumers) || 0;
  return out;
}

function snapshotOf(summary, savedAt) {
  const totals = summary && summary.totals ? summary.totals : {};
  const list = (name) => (Array.isArray(summary && summary[name]) ? summary[name] : []);
  return {
    asOn: (summary && summary.asOn) || '',
    savedAt: savedAt || new Date().toISOString(),
    source: (summary && summary.source) || '',
    totals: {
      consumers: Number(totals.consumers) || 0,
      osd: Number(totals.osd) || 0,
      remConsumers: Number(totals.remConsumers) || 0,
      remOsd: Number(totals.remOsd) || 0,
      remShare: Number(totals.remShare) || 0,
      remMin: Number(totals.remMin) || 5000
    },
    byClass: list('byClass').map(slimSlice),
    bySupply: list('bySupply').map(slimSlice),
    byHighValue: list('byHighValue').map(slimSlice),
    byAging: list('byAging').map(slimSlice),
    byOffice: list('byOffice').map(slimOffice),
    byCcc: list('byCcc').map(slimOffice)
  };
}

function readHistory(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.snapshots)) return parsed.snapshots;
  } catch (_) { /* missing or unreadable */ }
  return [];
}

function appendSnapshot(summary, file) {
  const snaps = readHistory(file);
  const next = snapshotOf(summary);
  if (!next.asOn) next.asOn = next.savedAt.slice(0, 10);
  const at = snaps.findIndex((row) => row.asOn === next.asOn);
  if (at >= 0) snaps[at] = next;
  else snaps.push(next);
  snaps.sort((a, b) => String(a.asOn).localeCompare(String(b.asOn)));
  const kept = snaps.slice(-MAX_SNAPSHOTS);
  const body = { snapshots: kept };
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');
  return body;
}

module.exports = { appendSnapshot, readHistory, snapshotOf, MAX_SNAPSHOTS };
