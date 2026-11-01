#!/usr/bin/env node
/* Row-for-row parity of a page converted to MzoRows: runs the page's old parse code (UI.csv on the
 * raw snapshot) and its new parse code (uniform rows) in one Node context with the real mzo_ui.js,
 * mzo_scope.js and mzo_rows.js, then compares every row object the page builds.
 *
 *   node scripts/qa/uniform-rowparity.js <page> --snap <snapshotDir> [--old <git rev>] [--offices <lib/offices.js>]
 *
 * Pages are described in PAGES below: the dataset key, the code region that parses (from/to
 * markers, the same in the old and the new file), how to call it and where the rows end up.
 * Each page is run as admin and as one region, one division and one CCC user.
 * Exit code 1 when a row differs (beyond the listed known differences).
 *
 * Optional per page: keys (several datasets: RAW and ROWS are then objects by key), prelude (code
 * run before the region, for page functions it calls; oldPrelude: only for the old file), sets ({ name: expression } compared one by
 * one instead of `rows`), ignore (fields not compared), oldFrom/oldTo (markers in the old file when
 * they differ). The clock is fixed (Date.now and new Date()), so ages computed at parse time compare.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const PAGES = {
  'solar.html': {
    key: 'solar_connections', from: '    var SCHEME = {', to: '    // Every panel filter',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true,
    // woDate / quoteDue are kept as text and shown through UI.fmtDate: compare what is shown.
    display: {
      woDate: (v, UI) => (v && !UI.blank(v) ? UI.fmtDate(v) : ''),
      quoteDue: (v, UI) => (v ? UI.fmtDate(v) : '')
    },
    known: {
      quoteDue: 'old page shows "Quotation due —" in the drawer for (null); the new one leaves the line out',
      load: 'one broken sheet row has a date in LOAD_APPL; parseFloat read it as 3 kW, uniform rows keep it in load_appl_raw'
    }
  },
  'nsc.html': {
    key: 'nsc_pending', from: '    var CLASS = {', to: '    var DELAY2 = [',
    old: 'parse(RAW)', new: 'parse(ROWS)', result: true, scope: false
  },
  'consumer/consumer.html': {
    key: 'consumers', from: '    function prepare(', to: '    function fillFilters()',
    prelude: 'var rows = [], asOn = ""; function fillFilters() {}',
    oldPrelude: 'function num(v) { return Number(String(v == null ? "" : v).replace(/,/g, "")) || 0; }',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', scope: true,
    // the old rows were the raw sheet rows (every column); the page reads these keys
    sets: { rows: 'rows.map(function (r) { return { CCC_CODE: r.CCC_CODE, _region: r._region, _divn: r._divn, _supp: r._supp, COUNT: r.COUNT, LOAD: r.LOAD, SD_LAKH: r.SD_LAKH, OSD_LAKH: r.OSD_LAKH, CONN_STAT: r.CONN_STAT, BASE_CLASS: r.BASE_CLASS, CONN_PHASE: r.CONN_PHASE, CATEGORY: r.CATEGORY, GOVT_STAT: r.GOVT_STAT, TYPE_OF_METER: r.TYPE_OF_METER, CONN_BY: r.CONN_BY, TIME_OF_DAY: r.TIME_OF_DAY }; })', asOn: '[{ shown: asOn ? UI.fmtDate(asOn) : "" }]' }
  }
};
const PROFILES = [
  { label: 'admin', profile: { Username: 'qa', role: 'admin' } },
  { label: 'region Raiganj', profile: { Username: 'qa', role: 'user', region_code: 'Raiganj' } },
  { label: 'division Gazole', profile: { Username: 'qa', role: 'user', division_code: 'Gazole' } },
  { label: 'ccc 6611108', profile: { Username: 'qa', role: 'user', ccc_code: '6611108' } }
];

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }

const NOW = Date.UTC(2026, 10, 1, 6, 30, 0); // fixed clock for both runs
class FixedDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}

function context(profile) {
  const store = { mzo_user_profile: JSON.stringify(profile) };
  const el = () => ({ textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
  const document = { readyState: 'complete', body: null, head: el(), documentElement: el(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => el(), createElement: el };
  const ctx = { console, document, localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }, Intl, Date: FixedDate, Math, JSON, Map, Set, Promise, setTimeout, clearTimeout };
  ctx.window = ctx; ctx.self = ctx; ctx.top = ctx;
  vm.createContext(ctx);
  // The pages load lib/offices.js before mzo_scope.js and mzo_ui.js (UI.office and the scope use it).
  for (const f of ['lib/offices.js', 'mzo_scope.js', 'mzo_ui.js', 'mzo_rows.js']) vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), ctx, { filename: f });
  ctx.UI.drill = () => ({ match: () => true }); // DOM-only helpers the parse regions set up
  ctx.UI.sidePanel = () => function () {};
  ctx.__text = {};
  ctx.$ = (id) => { const e = el(); Object.defineProperty(e, 'textContent', { get: () => ctx.__text[id] || '', set: (v) => { ctx.__text[id] = String(v); } }); return e; };
  ctx.render = ctx.clearAll = function () {}; // page functions the region refers to
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
function plainDeep(v) {
  if (v && typeof v === 'object' && !(typeof v.getTime === 'function') && !Array.isArray(v)) { const o = {}; Object.keys(v).forEach((k) => { o[k] = plainDeep(v[k]); }); return o; }
  return plain(v);
}

function main() {
  const pageName = process.argv[2];
  const page = PAGES[pageName];
  if (!page) { console.error('usage: uniform-rowparity.js <' + Object.keys(PAGES).join('|') + '> --snap <dir>'); process.exit(2); }
  const snap = arg('snap');
  const oldRev = arg('old', 'HEAD');
  const keys = page.keys || [page.key];
  const U = require(path.join(REPO, 'lib', 'uniform.js'));
  const offices = require(arg('offices', path.join(REPO, 'lib', 'offices.js')));
  U.useOffices(offices, JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'costcenter.json'), 'utf8')));
  const raws = {}, docs = {};
  keys.forEach((key) => {
    const file = fs.readdirSync(snap).find((f) => f.replace(/\.(csv|tsv|json)$/, '') === key && /\.(csv|tsv|json)$/.test(f));
    raws[key] = fs.readFileSync(path.join(snap, file), 'utf8');
    const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schema', key + '.json'), 'utf8'));
    const res = U.build(raws[key], { key, format: (schema.source && schema.source.format) || file.split('.').pop(), schema });
    docs[key] = JSON.parse(U.stringify(res)); // what the page receives (cache, mirror or worker)
  });
  const oldSrc = execFileSync('git', ['-C', REPO, 'show', oldRev + ':' + pageName], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const newSrc = fs.readFileSync(path.join(REPO, pageName), 'utf8');
  let failed = 0;
  for (const p of PROFILES) {
    const ctxOld = context(p.profile), ctxNew = context(p.profile);
    if (page.keys) {
      ctxOld.RAW = {}; ctxNew.ROWS = {};
      keys.forEach((key) => { ctxOld.RAW[key] = raws[key]; ctxNew.ROWS[key] = ctxNew.MzoRows.fromDoc(key, docs[key], 'test', { scope: page.scope }); });
    } else {
      ctxOld.RAW = raws[page.key];
      ctxNew.ROWS = ctxNew.MzoRows.fromDoc(page.key, docs[page.key], 'test', { scope: page.scope });
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
        if (d.samples.length < 3) d.samples.push({ row: i, id: x.appl || y.appl || x.con || '', old: show ? show(x[k], ctxOld.UI) : x[k], new: show ? show(y[k], ctxNew.UI) : y[k] });
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
