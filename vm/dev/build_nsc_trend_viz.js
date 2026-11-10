'use strict';
/**
 * Turn data/nsc_snapshot_import_raw.json (from build_nsc_trend_snapshots.py) into
 * a slim POST body for /api/nsc/snapshots/import (viz only — no consumer rows).
 *
 *   node vm/dev/build_nsc_trend_viz.js
 */
const fs = require('fs');
const path = require('path');
const NP = require('../../lib/nsc_pipeline');

const ROOT = path.resolve(__dirname, '..', '..');
const RAW = path.join(ROOT, 'data', 'nsc_snapshot_import_raw.json');
const OUT = path.join(ROOT, 'data', 'nsc_snapshot_import.json');

function withheldViz(slimWh) {
  const viz = NP.buildViz((slimWh || []).map((r) => Object.assign({}, r, {
    DelayInSC: '', DelaySerial: '', PoleNonPole: 'Non Pole Case'
  })), 'withheld');
  viz.total = (slimWh || []).length;
  viz.over30 = 0;
  viz.pole = 0;
  viz.poleOver30 = 0;
  const byClass = {};
  const offices = {};
  (slimWh || []).forEach((r) => {
    const cls = String(r.CONN_CLASS || '').trim().toUpperCase() || '?';
    byClass[cls] = (byClass[cls] || 0) + 1;
    const code = String(r.CCC_CODE || '').replace(/\D/g, '').slice(-7) || 'unknown';
    if (!offices[code]) {
      offices[code] = {
        ccc: code, region: r.REGION || '', division: r.DIVN_NAME || '', supp: r.SUPP_OFF || '',
        total: 0, over30: 0, pole: 0, poleOver30: 0, byClass: {}
      };
    }
    offices[code].total += 1;
    offices[code].byClass[cls] = (offices[code].byClass[cls] || 0) + 1;
  });
  viz.byClass = byClass;
  viz.offices = Object.keys(offices).sort().map((k) => offices[k]);
  return viz;
}

function leanViz(v) {
  if (!v) return null;
  return {
    kind: v.kind || '',
    total: v.total || 0,
    over30: v.over30 || 0,
    pole: v.pole || 0,
    poleOver30: v.poleOver30 || 0,
    byClass: v.byClass || {},
    byDelay: v.byDelay || {},
    offices: (v.offices || []).map((o) => ({
      ccc: o.ccc || '',
      region: o.region || '',
      division: o.division || '',
      supp: o.supp || '',
      total: o.total || 0,
      over30: o.over30 || 0,
      pole: o.pole || 0,
      poleOver30: o.poleOver30 || 0,
      byClass: o.byClass || {}
    }))
  };
}

const pack = JSON.parse(fs.readFileSync(RAW, 'utf8'));
const items = [];
for (const day of pack) {
  const reportDate = day.reportDate;
  const d = NP.parseManualReportDate(reportDate);
  if (!d) throw new Error('Bad reportDate ' + reportDate);
  console.log('transform', reportDate, 'rows', (day.rows || []).length);
  const t = NP.transformRows(day.rows || [], d);
  const slimW = NP.slimWorking(t.published);
  const slimH = NP.slimWithheld(t.withheld);
  const working = leanViz(NP.buildViz(slimW, 'working'));
  const withheld = leanViz(withheldViz(slimH));
  items.push({
    reportDate,
    reportDateKey: day.reportDateKey || NP.reportDateKey(reportDate),
    originalName: day.originalName || '',
    working,
    withheld
  });
  console.log('  working', working.total, 'withheld', withheld.total, 'offices', working.offices.length);
}

const body = { skipExisting: true, items };
fs.writeFileSync(OUT, JSON.stringify(body));
console.log('wrote', OUT, 'items', items.length, 'bytes', fs.statSync(OUT).size);
