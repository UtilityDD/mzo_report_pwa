#!/usr/bin/env node
/* Row-for-row parity of a page converted to MzoRows: runs the page's old parse code (UI.csv on the
 * raw snapshot) and its new parse code (uniform rows) in one Node context with the real mzo_ui.js,
 * mzo_scope.js and mzo_rows.js, then compares every row object the page builds.
 *
 *   node scripts/qa/uniform-rowparity.js <page> --snap <snapshotDir> [--old <git rev>] [--offices <lib/offices.js>] [--clock <iso>]
 *
 * Pages live in scripts/qa/uniform-rowparity/<batch>.js (BATCHES below), keyed by page file. An
 * entry names the dataset (`key`), the code region that parses (from/to markers, the same in the
 * old and the new file), how to call it (`old`, `new`) and where the rows end up (`rows`: an
 * expression; `result: true`: what the call returns). Optional:
 *   keys               several datasets: an array of keys (RAW and ROWS are then objects by key) or
 *                      { name: key } (objects by name)
 *   scope              MzoRows scope for the new rows; an object by key/name when it differs per dataset
 *   json               keys the old page got as parsed JSON
 *   file               the page file, when the entry name is not (two entries for one page)
 *   oldFrom / oldTo    markers in the old file when they differ
 *   offices: false     the page loads no lib/offices.js (every other page gets it first, as in the browser)
 *   scripts            extra page scripts loaded into the context after the shared ones
 *   stubs              page functions outside the region that it calls (replaced by no-ops)
 *   prelude            code run before the region (page functions and variables it needs); oldPrelude: old file only
 *   setup(ctx)         stubs page globals
 *   sets               { name: expression } compared one by one instead of `rows`
 *   display            { field: (value, UI) => shown }: compare what the page shows, not the value
 *   ignore             fields not compared (read but never shown)
 *   known              { field: reason }: differences that are explained
 *   id(x, y)           names a row in the samples (default appl / con)
 *   clock              ISO time: Date.now() and new Date() fixed for both runs (ages computed at parse time); --clock for all
 * Each page is run as admin and as one region, one division and one CCC user.
 * Exit code 1 when a row differs (beyond the listed known differences).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
// Page configs, one module per batch of docs/uniform-data-inventory.md.
const BATCHES = ['prototype', 'a-connections', 'b-revenue', 'c-meters', 'd-offices'];
const PAGES = {};
for (const b of BATCHES) {
  for (const [k, v] of Object.entries(require('./uniform-rowparity/' + b))) {
    if (PAGES[k]) throw new Error('page ' + k + ' is listed twice (' + b + ')');
    PAGES[k] = v;
  }
}
const PROFILES = [
  { label: 'admin', profile: { Username: 'qa', role: 'admin' } },
  { label: 'region Raiganj', profile: { Username: 'qa', role: 'user', region_code: 'Raiganj' } },
  { label: 'division Gazole', profile: { Username: 'qa', role: 'user', division_code: 'Gazole' } },
  { label: 'ccc 6611108', profile: { Username: 'qa', role: 'user', ccc_code: '6611108' } }
];

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }

// One fixed clock for both runs: new Date() and Date.now() give `iso`, every other Date call is the real one.
function fixedDate(iso) {
  const NOW = new Date(iso).getTime();
  return class FixedDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(NOW); }
    static now() { return NOW; }
  };
}

function context(profile, page, clock) {
  const store = { mzo_user_profile: JSON.stringify(profile) };
  const el = () => ({ textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
  const document = { readyState: 'complete', body: null, head: el(), documentElement: el(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => el(), createElement: el };
  const ctx = { console, document, localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }, Intl, Date: clock ? fixedDate(clock) : Date, Math, JSON, Map, Set, Promise, setTimeout, clearTimeout };
  ctx.window = ctx; ctx.self = ctx; ctx.top = ctx;
  vm.createContext(ctx);
  // as the pages load them: lib/offices.js first, so UI.office and MzoScope use the canonical list as in the browser
  const files = (page.offices === false ? [] : ['lib/offices.js']).concat(['mzo_scope.js', 'mzo_ui.js', 'mzo_rows.js'], page.scripts || []);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), ctx, { filename: f });
  ctx.UI.drill = () => ({ match: () => true }); // DOM-only helpers the parse regions set up
  ctx.UI.sidePanel = () => function () {};
  ctx.UI.lockScope = () => ({}); // pins the office selects (DOM only)
  ctx.__text = {};
  ctx.$ = (id) => { const e = el(); Object.defineProperty(e, 'textContent', { get: () => ctx.__text[id] || '', set: (v) => { ctx.__text[id] = String(v); } }); return e; };
  ctx.render = ctx.clearAll = function () {}; // page functions the region refers to
  (page.stubs || []).forEach((n) => { ctx[n] = function () {}; });
  if (page.setup) page.setup(ctx);
  return ctx;
}

function region(src, page, old) {
  const from = (old && page.oldFrom) || page.from, to = (old && page.oldTo) || page.to;
  const a = src.indexOf(from), b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error('markers not found');
  return src.slice(a, b);
}

function plain(v) {
  if (v instanceof Date || (v && typeof v.getTime === 'function' && typeof v.toISOString === 'function')) return isNaN(v.getTime()) ? 'Invalid Date' : 'D:' + v.getTime();
  return v;
}
function plainDeep(v) {
  if (v && typeof v === 'object' && !(typeof v.getTime === 'function') && !Array.isArray(v)) { const o = {}; Object.keys(v).forEach((k) => { o[k] = plainDeep(v[k]); }); return o; }
  return plain(v);
}
// Runs the region and the call; returns { set: { rows, asOn } } for every compared set.
function rowsOf(ctx, page, code, call, old) {
  const sets = page.sets || { rows: page.result ? '__r' : page.rows };
  const ret = '{' + Object.keys(sets).map((k) => JSON.stringify(k) + ': (' + sets[k] + ')').join(', ') + '}';
  const fn = new vm.Script('(function(){\n' + (page.prelude || '') + '\n' + ((old && page.oldPrelude) || '') + '\n' + code + '\nvar __r = ' + call + ';\nreturn ' + ret + ';\n})()');
  const got = fn.runInContext(ctx), out = {};
  const ignore = new Set(page.ignore || []);
  Object.keys(got).forEach((name) => {
    let rows = got[name];
    if (rows && !Array.isArray(rows) && typeof rows === 'object' && typeof rows.length !== 'number') rows = Object.keys(rows).sort().map((k) => Object.assign({ __key: k }, rows[k]));
    out[name] = { rows: Array.from(rows || []).map((r) => { const o = {}; Object.keys(r).forEach((k) => { if (!ignore.has(k)) o[k] = plainDeep(r[k]); }); return o; }), asOn: plain(rows && rows.asOn) };
  });
  return out;
}

function main() {
  const pageName = process.argv[2];
  const page = PAGES[pageName];
  if (!page) { console.error('usage: uniform-rowparity.js <' + Object.keys(PAGES).join('|') + '> --snap <dir>'); process.exit(2); }
  const snap = arg('snap');
  const oldRev = arg('old', 'HEAD');
  const clock = page.clock || arg('clock', '');
  // [name, dataset key] for every dataset; RAW and ROWS are objects by name when the page lists keys
  const named = page.keys ? (Array.isArray(page.keys) ? page.keys.map((k) => [k, k]) : Object.entries(page.keys)) : [['_', page.key]];
  const pageFile = page.file || pageName;
  const oldSrc = execFileSync('git', ['-C', REPO, 'show', oldRev + ':' + pageFile], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const newSrc = fs.readFileSync(path.join(REPO, pageFile), 'utf8');
  const U = require(path.join(REPO, 'lib', 'uniform.js'));
  const offices = require(arg('offices', path.join(REPO, 'lib', 'offices.js')));
  U.useOffices(offices, JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'costcenter.json'), 'utf8')));
  const raws = {}, docs = {};
  for (const [n, key] of named) {
    const file = fs.readdirSync(snap).find((f) => f.replace(/\.(csv|tsv|json)$/, '') === key && /\.(csv|tsv|json)$/.test(f));
    raws[n] = fs.readFileSync(path.join(snap, file), 'utf8');
    const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schema', key + '.json'), 'utf8'));
    const res = U.build(raws[n], { key, format: (schema.source && schema.source.format) || file.split('.').pop(), schema });
    docs[n] = JSON.parse(U.stringify(res)); // what the page receives (cache, mirror or worker)
  }
  const scopeOf = (n) => (page.scope && typeof page.scope === 'object' ? page.scope[n] !== false : page.scope);
  const rawFor = (n) => ((page.json || []).includes(n) ? JSON.parse(raws[n]) : raws[n]);
  let failed = 0;
  for (const p of PROFILES) {
    const ctxOld = context(p.profile, page, clock), ctxNew = context(p.profile, page, clock);
    if (page.keys) {
      ctxOld.RAW = {}; ctxNew.ROWS = {};
      for (const [n, key] of named) { ctxOld.RAW[n] = rawFor(n); ctxNew.ROWS[n] = ctxNew.MzoRows.fromDoc(key, docs[n], 'test', { scope: scopeOf(n) }); }
    } else {
      ctxOld.RAW = raws._;
      ctxNew.ROWS = ctxNew.MzoRows.fromDoc(page.key, docs._, 'test', { scope: page.scope });
    }
    const A = rowsOf(ctxOld, page, region(oldSrc, page, true), page.old, true);
    const B = rowsOf(ctxNew, page, region(newSrc, page), page.new);
    for (const set of Object.keys(A)) {
      const a = A[set], b = B[set];
      const diffs = {}; let rowsDiff = 0;
      const n = Math.max(a.rows.length, b.rows.length);
      for (let i = 0; i < n; i++) {
        const x = a.rows[i] || {}, y = b.rows[i] || {};
        let any = false;
        for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
          if (JSON.stringify(x[k]) === JSON.stringify(y[k])) continue;
          const show = page.display && page.display[k];
          if (show && show(x[k], ctxOld.UI) === show(y[k], ctxNew.UI)) continue;
          any = true;
          const d = diffs[k] || (diffs[k] = { count: 0, samples: [] });
          d.count++;
          if (d.samples.length < 3) d.samples.push({ row: i, id: page.id ? page.id(x, y) : x.appl || y.appl || x.con || '', old: show ? show(x[k], ctxOld.UI) : x[k], new: show ? show(y[k], ctxNew.UI) : y[k] });
        }
        if (any) rowsDiff++;
      }
      const asOnSame = JSON.stringify(a.asOn) === JSON.stringify(b.asOn) && JSON.stringify(ctxOld.__text) === JSON.stringify(ctxNew.__text);
      const name = set === 'rows' ? '' : ' ' + set;
      console.log(`${pageName} [${p.label}]${name} rows old ${a.rows.length} new ${b.rows.length}; rows differing ${rowsDiff}; as-on / header text ${asOnSame ? 'same ' + JSON.stringify(ctxNew.__text) : 'DIFF ' + JSON.stringify([a.asOn, ctxOld.__text]) + ' / ' + JSON.stringify([b.asOn, ctxNew.__text])}`);
      let unexplained = 0;
      for (const [k, d] of Object.entries(diffs)) {
        const why = page.known && page.known[k];
        if (!why) unexplained++;
        console.log(`   field ${k}: ${d.count} rows${why ? ' (known: ' + why + ')' : ' UNEXPLAINED'}, e.g. ${JSON.stringify(d.samples)}`);
      }
      if (unexplained || a.rows.length !== b.rows.length || !asOnSame) failed++;
    }
  }
  process.exit(failed ? 1 : 0);
}
main();
