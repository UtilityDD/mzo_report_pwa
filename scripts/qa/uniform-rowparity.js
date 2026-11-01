#!/usr/bin/env node
/* Row-for-row parity of a page converted to MzoRows: runs the page's old parse code (UI.csv on the
 * raw snapshot) and its new parse code (uniform rows) in one Node context with the real mzo_ui.js,
 * mzo_scope.js and mzo_rows.js, then compares every row object the page builds.
 *
 *   node scripts/qa/uniform-rowparity.js <page> --snap <snapshotDir> [--old <git rev>] [--offices <lib/offices.js>]
 *
 * Pages are described in PAGES below: the dataset key (or `keys` for several: RAW and ROWS are then
 * arrays in that order), the code region that parses (from/to markers, the same in the old and the
 * new file), how to call it and where the rows end up (`rows`: an expression), and `stubs`: page
 * functions outside the region that the region calls (DOM work, replaced by no-ops).
 * Each page is run as admin and as one region, one division and one CCC user.
 * Exit code 1 when a row differs (beyond the listed known differences).
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
  // Batch B (Revenue)
  'loss.html': {
    keys: ['loss_report', 'loss_targets'], from: '    var MON = [', to: '    function fillOffices() {',
    old: 'prepare(RAW[0], RAW[1])', new: 'prepare(ROWS[0], ROWS[1])', scope: false, stubs: ['fillOffices'],
    // every office x month the page keeps, the targets and the month list (the header text is compared too)
    rows: "Object.keys(data).sort().reduce(function (a, n) { Object.keys(data[n]).forEach(function (k) { a.push(Object.assign({ name: n, k: k }, data[n][k])); }); return a; }, [])" +
      ".concat(Object.keys(targets).sort().map(function (n) { return Object.assign({ target: n }, targets[n]); })).concat([{ periods: periods.join(',') }])"
  },
  'collection.html': {
    key: 'collection_report', from: '    function ymd(s) {', to: '    function fillFilters() {',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true, stubs: ['fillFilters']
  },
  'theft_assessment.html': {
    key: 'theft_assessment', from: '    var KEY = ', to: '    function fillFilters() {',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true, stubs: ['fillFilters'],
    known: {
      id: 'the row index was never read; removed',
      pay: 'PAYMENT AMT cells in scientific notation (7.51E+04): the old clean-up read 7.51, uniform rows read 75,100',
      balance: 'follows pay (scientific-notation PAYMENT AMT)',
      status: 'follows pay (scientific-notation PAYMENT AMT)'
    }
  },
  'remosd5000.html': {
    key: 'rem_osd', from: '    var CLASSES = [', to: '    function fillFilters() {',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', scope: true, stubs: ['fillFilters'],
    // the old page kept the raw sheet objects, the new one its own: compare what the page reads
    rows: "all.map(function (r) { var o = { due: UI.fmtDate(dmy(r._due)), dueT: r._dueD ? r._dueD.getTime() : null, region: r._region, divn: r._divn, supp: r._supp, code: r.CCC_CODE }; ['Total'].concat(CLASSES).forEach(function (c) { o['n' + c] = cnt(r, c); o['a' + c] = amt(r, c); }); o.email = UI.fmtDate(dmy(r.email || r['Report Date/Email Date'])); o.remarks = r.remarks != null ? r.remarks : r.Remarks; return o; })" +
      ".concat([{ dates: dates.map(function (d) { return UI.fmtDate(dmy(d)); }).join(',') }])",
    // UI.csv kept trailing spaces ('NIL '); uniform values are trimmed. The drawer shows the same text.
    display: { remarks: (v) => (v == null ? v : String(v).trim()) }
  },
  'rem/defaulters.html': {
    keys: ['rem_defaulters_dom', 'rem_defaulters_agri', 'rem_defaulters_ind_com'], from: '    var TYPE = {', to: '    function fillFilters() {',
    old: "(parts.DOM = enrich(tsv(RAW[0]), 'DOM'), parts.AGRI = enrich(tsv(RAW[1]), 'AGRI'), parts.IC = enrich(tsv(RAW[2]), 'IC'), rebuild())",
    new: "(parts.DOM = enrich(ROWS[0], 'DOM'), parts.AGRI = enrich(ROWS[1], 'AGRI'), parts.IC = enrich(ROWS[2], 'IC'), rebuild())",
    scope: true, stubs: ['fillFilters'],
    // raw: the old page kept the sheet's text cells; the new one exports the same text through cells()
    rows: "all.map(function (r) { var o = Object.assign({}, r); o.raw = typeof cells === 'function' ? cells(r) : r.raw; return o; })"
  },
  'disconnection.html': {
    key: 'disconnection', from: '    /* ------------------------------------------------------------------ parsing */', to: '    /* ------------------------------------------------------------------ filters */',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true
  }
};
const PROFILES = [
  { label: 'admin', profile: { Username: 'qa', role: 'admin' } },
  { label: 'region Raiganj', profile: { Username: 'qa', role: 'user', region_code: 'Raiganj' } },
  { label: 'division Gazole', profile: { Username: 'qa', role: 'user', division_code: 'Gazole' } },
  { label: 'ccc 6611108', profile: { Username: 'qa', role: 'user', ccc_code: '6611108' } }
];

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }

function context(profile) {
  const store = { mzo_user_profile: JSON.stringify(profile) };
  const el = () => ({ textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
  const document = { readyState: 'complete', body: null, head: el(), documentElement: el(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => el(), createElement: el };
  const ctx = { console, document, localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }, Intl, Date, Math, JSON, Map, Set, Promise, setTimeout, clearTimeout };
  ctx.window = ctx; ctx.self = ctx; ctx.top = ctx;
  vm.createContext(ctx);
  for (const f of ['mzo_scope.js', 'mzo_ui.js', 'mzo_rows.js']) vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), ctx, { filename: f });
  ctx.UI.drill = () => ({ match: () => true }); // DOM-only helpers the parse regions set up
  ctx.UI.sidePanel = () => function () {};
  ctx.__text = {};
  ctx.$ = (id) => { const e = el(); Object.defineProperty(e, 'textContent', { get: () => ctx.__text[id] || '', set: (v) => { ctx.__text[id] = String(v); } }); return e; };
  ctx.render = ctx.clearAll = function () {}; // page functions the region refers to
  return ctx;
}
function stub(ctx, page) { (page.stubs || []).forEach((n) => { ctx[n] = function () {}; }); return ctx;
}

function region(src, page) {
  const a = src.indexOf(page.from), b = src.indexOf(page.to, a + 1);
  if (a < 0 || b < 0) throw new Error('markers not found');
  return src.slice(a, b);
}

function plain(v) {
  if (v instanceof Date || (v && typeof v.getTime === 'function' && typeof v.toISOString === 'function')) return isNaN(v.getTime()) ? 'Invalid Date' : 'D:' + v.getTime();
  return v;
}
function rowsOf(ctx, page, code, call) {
  const fn = new vm.Script('(function(){\n' + code + '\nvar __r = ' + call + ';\nreturn ' + (page.result ? '__r' : page.rows) + ';\n})()');
  const rows = fn.runInContext(ctx);
  return { rows: Array.from(rows).map((r) => { const o = {}; Object.keys(r).forEach((k) => { o[k] = plain(r[k]); }); return o; }), asOn: plain(rows.asOn) };
}

function main() {
  const pageName = process.argv[2];
  const page = PAGES[pageName];
  if (!page) { console.error('usage: uniform-rowparity.js <' + Object.keys(PAGES).join('|') + '> --snap <dir>'); process.exit(2); }
  const snap = arg('snap');
  const oldRev = arg('old', 'HEAD');
  const keys = page.keys || [page.key];
  const files = keys.map((key) => fs.readdirSync(snap).find((f) => f.replace(/\.(csv|tsv|json)$/, '') === key && /\.(csv|tsv|json)$/.test(f)));
  const raws = files.map((file) => fs.readFileSync(path.join(snap, file), 'utf8'));
  const oldSrc = execFileSync('git', ['-C', REPO, 'show', oldRev + ':' + pageName], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const newSrc = fs.readFileSync(path.join(REPO, pageName), 'utf8');
  const U = require(path.join(REPO, 'lib', 'uniform.js'));
  const offices = require(arg('offices', path.join(REPO, 'lib', 'offices.js')));
  U.useOffices(offices, JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'costcenter.json'), 'utf8')));
  // what the page receives (cache, mirror or worker)
  const docs = keys.map((key, i) => {
    const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schema', key + '.json'), 'utf8'));
    return JSON.parse(U.stringify(U.build(raws[i], { key, format: files[i].split('.').pop(), schema })));
  });
  let failed = 0;
  for (const p of PROFILES) {
    const ctxOld = stub(context(p.profile), page), ctxNew = stub(context(p.profile), page);
    ctxOld.RAW = page.keys ? raws : raws[0];
    const rowsOfDoc = (doc, i) => ctxNew.MzoRows.fromDoc(keys[i], doc, 'test', { scope: page.scope });
    ctxNew.ROWS = page.keys ? docs.map(rowsOfDoc) : rowsOfDoc(docs[0], 0);
    const a = rowsOf(ctxOld, page, region(oldSrc, page), page.old);
    const b = rowsOf(ctxNew, page, region(newSrc, page), page.new);
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
    console.log(`${pageName} [${p.label}] rows old ${a.rows.length} new ${b.rows.length}; rows differing ${rowsDiff}; as-on / header text ${asOnSame ? 'same ' + JSON.stringify(ctxNew.__text) : 'DIFF ' + JSON.stringify([a.asOn, ctxOld.__text]) + ' / ' + JSON.stringify([b.asOn, ctxNew.__text])}`);
    let unexplained = 0;
    for (const [k, d] of Object.entries(diffs)) {
      const why = page.known && page.known[k];
      if (!why) unexplained++;
      console.log(`   field ${k}: ${d.count} rows${why ? ' (known: ' + why + ')' : ' UNEXPLAINED'}, e.g. ${JSON.stringify(d.samples)}`);
    }
    if (unexplained || a.rows.length !== b.rows.length || !asOnSame) failed++;
  }
  process.exit(failed ? 1 : 0);
}
main();
