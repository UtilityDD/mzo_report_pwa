#!/usr/bin/env node
/* Page views (vm/sync/lib/views): every number a view feeds, old page logic vs the view, row by row.
 *
 *   node scripts/qa/view-parity.js --snap <snapshotDir> [--old <git rev>]
 *
 * Build the views first (node vm/sync/views.js --dir <snapshotDir>). For each view, the page functions
 * that use it are taken from the working copy and the old functions from `git show <rev>:<page>`
 * (default HEAD), and both run in one Node context with the real mzo_ui.js, lib/offices.js,
 * mzo_scope.js and mzo_rows.js, as admin, a region login and a CCC login:
 *   meter_utilization  every ERP meter in scope: its row, status (prepare()), drawer ids, and the three dates;
 *   smart_meter        the "As on" date, work orders per office, and the work order of every supplied meter;
 *   sheet_links_dates  each dataset's date against the page's rules on its rows.
 * Prints counts only (never row contents). Exit 1 on any difference.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; }

const PROFILES = [
  { label: 'admin', profile: { Username: 'qa', role: 'admin' } },
  { label: 'region Raiganj', profile: { Username: 'qa', role: 'user', region_code: 'Raiganj' } },
  { label: 'ccc 6611108', profile: { Username: 'qa', role: 'user', ccc_code: '6611108' } }
];

function context(profile) {
  const store = { mzo_user_profile: JSON.stringify(profile) };
  const el = () => ({ textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, insertAdjacentHTML() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
  const document = { readyState: 'complete', body: el(), head: el(), documentElement: el(), addEventListener() {}, querySelector: () => el(), querySelectorAll: () => [], getElementById: () => el(), createElement: el };
  const ctx = { console, document, localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }, setTimeout, clearTimeout };
  ctx.window = ctx; ctx.self = ctx; ctx.top = ctx;
  vm.createContext(ctx);
  for (const f of ['lib/offices.js', 'mzo_scope.js', 'mzo_ui.js', 'mzo_rows.js']) vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), ctx, { filename: f });
  return ctx;
}

/** The text of `    function name(` … its closing `    }` (4-space indented page functions). */
function fn(src, name) {
  const a = src.indexOf('    function ' + name + '(');
  const b = src.indexOf('\n    }\n', a);
  if (a < 0 || b < 0) throw new Error('function not found: ' + name);
  return src.slice(a, b + 6) + '\n';
}
function between(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('block not found: ' + from);
  return src.slice(a, b);
}

const snap = arg('snap');
if (!snap) { console.error('usage: view-parity.js --snap <dir> [--old <rev>]'); process.exit(2); }
const rev = arg('old', 'HEAD');
const oldSrc = (f) => execFileSync('git', ['-C', REPO, 'show', rev + ':' + f], { encoding: 'utf8', maxBuffer: 64 << 20 });
const newSrc = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(snap, f), 'utf8'));
let bad = 0;
const report = (label, diffs, n) => { if (diffs) bad++; console.log(`  ${label.padEnd(16)} ${n} compared, ${diffs ? diffs + ' DIFFER' : 'identical'}`); };

/* ---------- meter utilization ---------- */
function meter() {
  console.log('meter_utilization:');
  const view = readJson('meter_utilization.view.json'), ids = readJson('meter_utilization.ids.view.json');
  const docs = {};
  for (const k of ['meter_erp', 'meter_master', 'meter_crm', 'meter_isu']) docs[k] = readJson(k + '.rows.json');
  const o = oldSrc('meter_utilization.html'), n = newSrc('meter_utilization.html');
  // prepare()'s status line and the drawer's lookup line, as each version writes them
  const statusOld = /var status = (.+);\n/.exec(fn(o, 'prepare'))[1];
  const statusNew = /var status = (.+);\n/.exec(fn(n, 'prepare'))[1];
  for (const p of PROFILES) {
    const ctx = context(p.profile);
    ctx.__docs = docs; ctx.__view = view; ctx.__ids = ids;
    const run = (code) => vm.runInContext(code, ctx);
    const old = run(`(function () {
      var KEYS = ['meter_erp', 'meter_master', 'meter_crm', 'meter_isu'], T = {}, masterLookup = {}, replacementLookup = {}, dates = {};
      KEYS.forEach(function (k) { T[k] = MzoRows.fromDoc(k, __docs[k], 'test'); });
      ${fn(o, 'processData')}
      processData();
      var rows = T.meter_erp.rows.map(function (d) { var meter = d.serial_number; var status = ${statusOld};
        var c = status === 'utilized-nsc' ? masterLookup[meter] || {} : status === 'utilized-replacement' ? replacementLookup[meter] || {} : {};
        return JSON.stringify([d, status, c.conId, c.instNo]); });
      return { rows: rows, dates: JSON.stringify(dates) };
    })()`);
    const neu = run(`(function () {
      var KEYS = ['meter_erp', 'meter_master', 'meter_crm', 'meter_isu'], T = {}, masterLookup = {}, replacementLookup = {}, dates = {}, VIEW = __view, idsP = null, idsReady = false;
      ${between(n, '    var VIEW = null, VIEW_STATUS', '    function processView(')}
      ${fn(n, 'processView')}
      VIEW = __view; T = { meter_erp: fromView(VIEW) };
      processView();
      Object.keys(__ids.nsc).forEach(function (m) { masterLookup[m] = { conId: __ids.nsc[m][0], instNo: __ids.nsc[m][1] }; });
      Object.keys(__ids.rep).forEach(function (m) { replacementLookup[m] = { conId: __ids.rep[m] }; });
      var rows = T.meter_erp.rows.map(function (d) { var meter = d.serial_number; var status = ${statusNew};
        var c = status === 'utilized-nsc' ? masterLookup[meter] || {} : status === 'utilized-replacement' ? replacementLookup[meter] || {} : {};
        var plain = {}; Object.keys(d).forEach(function (k) { if (k !== '_mu_status') plain[k] = d[k]; });
        return JSON.stringify([plain, status, c.conId, c.instNo]); });
      return { rows: rows, dates: JSON.stringify(dates) };
    })()`);
    let diffs = old.rows.length === neu.rows.length ? 0 : 1;
    for (let i = 0; i < Math.min(old.rows.length, neu.rows.length); i++) if (old.rows[i] !== neu.rows[i]) diffs++;
    if (old.dates !== neu.dates) diffs++;
    report(p.label, diffs, `${old.rows.length} meters (+3 dates)`);
  }
}

/* ---------- smart meter ---------- */
function smart() {
  console.log('smart_meter:');
  const view = readJson('smart_meter.view.json');
  const docs = { smart_meter_status: readJson('smart_meter_status.rows.json'), smart_meter_work_orders: readJson('smart_meter_work_orders.rows.json') };
  const o = oldSrc('smart_meter/dashboard.html'), n = newSrc('smart_meter/dashboard.html');
  const stub = `var $ = function () { return { style: {}, textContent: '' }; }; function fillOffices() {}`;
  for (const p of PROFILES) {
    const ctx = context(p.profile);
    ctx.__docs = docs; ctx.__view = view;
    const run = (code) => vm.runInContext(code, ctx);
    // prepare() fills meters, wos, woByMeter and asOn; compare what the page reads from them.
    const out = (code) => run(`(function () {
      ${stub}
      var meters = [], wos = [], woByMeter = {}, asOn = null;
      ${fn(code === 'old' ? o : n, 'office')}
      ${fn(code === 'old' ? o : n, 'prepare')}
      ${code === 'new' ? fn(n, 'viewWos') : ''}
      var mt = MzoRows.fromDoc('smart_meter_status', __docs.smart_meter_status, 'test');
      var wt = ${code === 'old' ? "MzoRows.fromDoc('smart_meter_work_orders', __docs.smart_meter_work_orders, 'test')" : '{ view: __view, wos: viewWos(__view) }'};
      prepare(mt, wt);
      var per = {}; wos.forEach(function (r) { var k = JSON.stringify([r._region, r._divn, r._supp, r.CCC_CODE]); per[k] = (per[k] || 0) + 1; });
      var F = ['consumer_id', 'con_name', 'con_addr', 'work_order', 'work_order_date', 'old_meter_no', 'conn_load', 'con_class'];
      var look = meters.map(function (r) { var w = woByMeter[r.meter] || {}; return JSON.stringify(F.map(function (f) { return w[f]; })); });
      return { asOn: asOn ? asOn.getTime() : null, per: JSON.stringify(Object.keys(per).sort().map(function (k) { return [k, per[k]]; })), wos: wos.length, look: look };
    })()`);
    const a = out('old'), b = out('new');
    let diffs = 0;
    if (a.asOn !== b.asOn) diffs++;
    if (a.per !== b.per || a.wos !== b.wos) diffs++;
    for (let i = 0; i < Math.max(a.look.length, b.look.length); i++) if (a.look[i] !== b.look[i]) diffs++;
    report(p.label, diffs, `${a.wos} work orders, ${a.look.length} meter lookups, as-on`);
  }
}

/* ---------- sheet links ---------- */
function sheetLinks() {
  console.log('sheet_links_dates:');
  const view = readJson('sheet_links_dates.view.json');
  const rules = between(newSrc('sheet_links.html'), '    // ---- as-on rules', '    // ---- end of as-on rules ----');
  const ctx = context(PROFILES[0].profile);
  vm.runInContext(rules + '\nthis.AS_ON = AS_ON;', ctx);
  let diffs = 0, n = 0;
  for (const hub of Object.keys(ctx.AS_ON)) {
    const key = ctx.AS_ON[hub][0];
    if (!(hub in view.dates)) { console.log(`  ${hub}: not in the view (rows not fresh)`); continue; }
    const want = ctx.AS_ON[hub][1](ctx.MzoRows.fromDoc(key, readJson(key + '.rows.json'), 'test', { scope: false }));
    n++;
    if (String(want || '') !== view.dates[hub]) { diffs++; console.log(`  ${hub}: DIFFERS`); }
  }
  report('all logins', diffs, `${n} dates`);
}

process.env.TZ = process.env.TZ || 'Asia/Kolkata';
meter();
smart();
sheetLinks();
process.exit(bad ? 1 : 0);
