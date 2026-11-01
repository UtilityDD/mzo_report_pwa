#!/usr/bin/env node
/* Ask (assistant.html) against the report pages: the rows Ask counts vs the rows each page builds,
 * from the same uniform rows, so Ask's numbers cannot disagree with the pages.
 *
 *   node scripts/qa/assistant-rowparity.js --snap <snapshotDir>
 *
 * In one Node context per login (admin, a region, a division and a CCC user) with the real
 * lib/offices.js, mzo_scope.js, mzo_ui.js and mzo_rows.js, it runs the page code (nsc.html parse(),
 * pending_load_extension.html and solar.html prepare(), loss.html prepare(), from the working copy)
 * and Ask's adapters (assistant.html, "data for tools") on the same t, and compares every row value
 * Ask reads: offices, flags, delays, ages, loads, statuses, and every loss figure per office and month.
 * Exit 1 on any difference.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..', '..');
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; }
const PROFILES = [
  { label: 'admin', profile: { Username: 'qa', role: 'admin' } },
  { label: 'region Raiganj', profile: { Username: 'qa', role: 'user', region_code: 'Raiganj' } },
  { label: 'division Gazole', profile: { Username: 'qa', role: 'user', division_code: 'Gazole' } },
  { label: 'ccc 6611108', profile: { Username: 'qa', role: 'user', ccc_code: '6611108' } }
];
const SOLAR_ST = { done: 'connected', pending: 'pending', issue: 'meter_issue' };
// page region markers and calls; `pick` maps a page row to the values Ask keeps
const PAGES = {
  nsc: {
    file: 'nsc.html', key: 'nsc_pending', scope: false, from: '    var CLASS = {', to: '    var DELAY2 = [', call: 'parse(T)',
    pick: (r) => ({ delay: r.delay, poles: r.poles, pole: r.pole, withheld: r.withheld, cls: r.cls, phase: r.phase, _region: r._region, _divn: r._divn, _supp: r._supp, CCC_CODE: r.CCC_CODE })
  },
  load_extension: {
    file: 'pending_load_extension.html', key: 'load_extension', scope: true, from: '    var CLASS = {', to: '    var STAT = {', call: '(prepare(T), all)',
    pick: (r) => ({ age: r.age, cls: r.cls, phase: r.phase, applied: r.applied, curr: r.curr, loss: r.loss, _region: r._region, _divn: r._divn, _supp: r._supp, CCC_CODE: r.CCC_CODE })
  },
  solar: {
    file: 'solar.html', key: 'solar_connections', scope: true, from: '    var SCHEME = {', to: '    // Every panel filter', call: '(prepare(T), all)',
    pick: (r) => ({ st: SOLAR_ST[r.st], scheme: r.scheme, days: r.wait, _region: r._region, _divn: r._divn, _supp: r._supp, CCC_CODE: r.CCC_CODE })
  }
};

function context(profile) {
  const store = { mzo_user_profile: JSON.stringify(profile) };
  const el = () => ({ textContent: '', innerHTML: '', value: '', disabled: false, options: [], hidden: false, parentNode: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, addEventListener() {}, insertAdjacentHTML() {}, querySelector: () => null, querySelectorAll: () => [] });
  const document = { readyState: 'complete', body: null, head: el(), documentElement: el(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => el(), createElement: el };
  const ctx = { console, document, localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }, Intl, Date, Math, JSON, Map, Set, Promise, setTimeout, clearTimeout, URLSearchParams, location: { search: '' } };
  ctx.window = ctx; ctx.self = ctx; ctx.top = ctx;
  vm.createContext(ctx);
  for (const f of ['lib/offices.js', 'mzo_scope.js', 'mzo_ui.js', 'mzo_rows.js']) vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), ctx, { filename: f });
  ctx.UI.drill = () => ({ match: () => true });
  ctx.UI.sidePanel = () => function () {};
  ctx.$ = () => el();
  ctx.render = ctx.clearAll = ctx.fillOffices = function () {};
  return ctx;
}
function region(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error('markers not found: ' + from);
  return src.slice(a, b);
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function main() {
  const snap = arg('snap');
  if (!snap) { console.error('usage: assistant-rowparity.js --snap <dir>'); process.exit(2); }
  const U = require(path.join(REPO, 'lib', 'uniform.js'));
  U.useOffices(require(path.join(REPO, 'lib', 'offices.js')), JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'costcenter.json'), 'utf8')));
  const man = JSON.parse(fs.readFileSync(path.join(snap, 'manifest.json'), 'utf8')).datasets;
  const docs = {};
  for (const key of ['nsc_pending', 'load_extension', 'solar_connections', 'loss_report', 'loss_targets']) {
    const text = fs.readFileSync(path.join(snap, man[key].file), 'utf8');
    docs[key] = JSON.parse(U.stringify(U.build(text, { key, format: man[key].file.split('.').pop(), schema: JSON.parse(fs.readFileSync(path.join(REPO, 'schema', key + '.json'), 'utf8')) })));
  }
  const askSrc = region(fs.readFileSync(path.join(REPO, 'assistant.html'), 'utf8'), '    /* ---------------- data for tools ---------------- */', '    /* ---------------- conversation ---------------- */');
  let bad = 0;
  for (const p of PROFILES) {
    const line = [];
    for (const [name, pg] of Object.entries(PAGES)) {
      const ctx = context(p.profile);
      const t = ctx.MzoRows.fromDoc(pg.key, docs[pg.key], 'test', { scope: pg.scope });
      ctx.T = t;
      const pageRows = vm.runInContext('(function(){\n' + region(fs.readFileSync(path.join(REPO, pg.file), 'utf8'), pg.from, pg.to) + '\nreturn ' + pg.call + ';\n})()', ctx);
      const ask = vm.runInContext('(function(){ var C = {}, scope = null, scopeLabel = "", add = function () {};\n' + askSrc + '\nreturn { ADAPTERS: ADAPTERS, LOSS: LOSS };\n})()', ctx);
      const askRows = ask.ADAPTERS[name].build(t);
      let diff = 0, sample = null;
      const n = Math.max(pageRows.length, askRows.length);
      for (let i = 0; i < n; i++) {
        const a = pageRows[i] ? pg.pick(pageRows[i]) : null, b = askRows[i] ? Object.keys(pg.pick(pageRows[i] || askRows[i])).reduce((o, k) => { o[k] = askRows[i][k]; return o; }, {}) : null;
        if (!same(a, b)) { diff++; if (!sample) sample = { row: i, page: a, ask: b }; }
      }
      if (diff || pageRows.length !== askRows.length) bad++;
      line.push(`${name} page ${pageRows.length} / Ask ${askRows.length} rows, ${diff} differ${sample ? ' e.g. ' + JSON.stringify(sample) : ''}`);
    }
    // loss: every figure Ask reads, per sheet row and month, and the targets
    {
      const ctx = context(p.profile);
      const main = ctx.MzoRows.fromDoc('loss_report', docs.loss_report, 'test', { scope: false });
      const target = ctx.MzoRows.fromDoc('loss_targets', docs.loss_targets, 'test', { scope: false });
      ctx.M = main; ctx.TG = target;
      const page = vm.runInContext('(function(){\n' + region(fs.readFileSync(path.join(REPO, 'loss.html'), 'utf8'), '    var MON = [', '    function fillOffices() {') + '\nprepare(M, TG); return { data: data, targets: targets, periods: periods };\n})()', ctx);
      const ask = vm.runInContext('(function(){ var C = {}, scope = null, scopeLabel = "", add = function () {};\n' + askSrc + '\nreturn { ADAPTERS: ADAPTERS, LOSS: LOSS };\n})()', ctx);
      const m = ask.LOSS.main.build(main), tg = ask.LOSS.targets.build(target);
      let cells = 0, diff = 0, sample = null;
      Object.keys(page.data).forEach((row) => Object.keys(page.data[row]).forEach((k) => {
        const a = page.data[row][k], b = (m.by[row] || {})[k] || {};
        cells++;
        const x = [a.atc, a.dist, a.ce, a.input, a.coll], y = [b.atc_loss_pct, b.dist_loss_pct, b.collection_eff_pct, b.input_mu, b.collected_mu];
        if (!same(x, y)) { diff++; if (!sample) sample = { row, k, page: x, ask: y }; }
      }));
      if (Object.keys(m.by).length !== Object.keys(page.data).length) diff++;
      const tSame = same(Object.keys(page.targets).map((r) => [r, page.targets[r].atc, page.targets[r].dist]), Object.keys(tg).map((r) => [r, tg[r].atc_target_pct, tg[r].dist_target_pct]));
      const pSame = same(page.periods, m.periods);
      if (diff || !tSame || !pSame) bad++;
      line.push(`loss ${cells} office-months, ${diff} differ${sample ? ' e.g. ' + JSON.stringify(sample) : ''}; targets ${tSame ? 'same' : 'DIFFER'}; months ${pSame ? 'same' : 'DIFFER'}`);
    }
    console.log(`[${p.label}]\n  ` + line.join('\n  '));
  }
  process.exit(bad ? 1 : 0);
}
main();
