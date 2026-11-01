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
  'nsc/kpi.html': {
    key: 'nsc_pending', from: '    var LABEL = {', to: '    function avg(rows, k)',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: false,
    known: {
      REGION: 'raw office cells were copied onto the row only for MzoScope; the login scope now runs on the uniform rows',
      DIVN_NAME: 'as REGION', SUPP_OFF: 'as REGION', CCC_CODE: 'as REGION'
    }
  },
  'withheld.html': {
    key: 'withheld', from: '    var CLASS = {', to: '    var STAT = {',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: false,
    known: {
      withheld: 'application 4001062497 has SCN_WITHELD_DATE "26/07/0201" (a typo in the sheet): UI.date read it as the year 201, uniform rows leave it empty and keep the text in scn_witheld_date_raw',
      year: 'as withheld (the "… and earlier" year facet counts one application less)', ago: 'as withheld (it was 666,663 days, in no stat card)'
    }
  },
  'pending_load_extension.html': {
    key: 'load_extension', from: '    var CLASS = {', to: '    var STAT = {',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true,
    // COLLECTION_DATE is kept as text and shown through UI.fmtDate: compare what is shown.
    display: { collected: (v, UI) => UI.fmtDate(v) }
  },
  'pending_mc.html': {
    key: 'pending_mc', from: '    var CLASS = {', to: '    // Every panel filter;',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true,
    display: { collected: (v, UI) => (UI.blank(v) ? '' : UI.fmtDate(v)) },
    known: { docs: 'DOCS_SUNMITTED was read into the row but never shown; it is no longer loaded' }
  },
  'weekly.html': {
    key: 'weekly_report', from: '    var METRIC = {', to: '    function fillOffices() {',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true, stubs: ['fillOffices'],
    // r.raw is the sheet row (old: UI.csv object, new: uniform row): compare the 18 metric values the page reads from it.
    display: {
      raw: (v) => {
        if (!v || typeof v !== 'object') return v;
        const out = [];
        for (const b of [['Pending as on Monday of Last Week', 'pending_as_on_monday_of_last_week'], ['Deposited in last week', 'deposited_in_last_week'], ['Conn. Eff.', 'conn_eff'], ['Withheld', 'withheld'], ['Total disposed', 'total_disposed'], ['Pending as on Monday of Current Week', 'pending_as_on_monday_of_current_week']]) {
          for (const c of ['DOM', 'COM', 'IND']) out.push(b[1] + '_dom' in v ? Math.trunc(v[b[1] + '_' + c.toLowerCase()]) || 0 : parseInt(v[b[0] + ' (' + c + ')'], 10) || 0);
        }
        return JSON.stringify(out);
      }
    }
  },
  'jjm.html': {
    key: 'jjm_connections', from: '    // Sheet columns', to: '    function fillFilters() {',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true, stubs: ['fillFilters'],
    known: { sheetDivision: 'computed from DIVISION but never used; dropped' }
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
  // as the pages load them: lib/offices.js first, so UI.office and MzoScope use the canonical list as in the browser
  for (const f of ['lib/offices.js', 'mzo_scope.js', 'mzo_ui.js', 'mzo_rows.js']) vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), ctx, { filename: f });
  ctx.UI.drill = () => ({ match: () => true }); // DOM-only helpers the parse regions set up
  ctx.UI.sidePanel = () => function () {};
  ctx.__text = {};
  ctx.$ = (id) => { const e = el(); Object.defineProperty(e, 'textContent', { get: () => ctx.__text[id] || '', set: (v) => { ctx.__text[id] = String(v); } }); return e; };
  ctx.render = ctx.clearAll = function () {}; // page functions the region refers to
  return ctx;
}
function stub(ctx, page) { (page.stubs || []).forEach((n) => { ctx[n] = function () {}; }); return ctx; }

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
  // page.keys ({ name: datasetKey }) for pages that combine datasets: RAW and ROWS are then objects by name.
  const keys = page.keys || { _: page.key }, raws = {}, docs = {};
  const oldSrc = execFileSync('git', ['-C', REPO, 'show', oldRev + ':' + pageName], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const newSrc = fs.readFileSync(path.join(REPO, pageName), 'utf8');
  const U = require(path.join(REPO, 'lib', 'uniform.js'));
  const offices = require(arg('offices', path.join(REPO, 'lib', 'offices.js')));
  U.useOffices(offices, JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'costcenter.json'), 'utf8')));
  for (const [n, key] of Object.entries(keys)) {
    const file = fs.readdirSync(snap).find((f) => f.replace(/\.(csv|tsv|json)$/, '') === key && /\.(csv|tsv|json)$/.test(f));
    raws[n] = fs.readFileSync(path.join(snap, file), 'utf8');
    const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schema', key + '.json'), 'utf8'));
    docs[n] = JSON.parse(U.stringify(U.build(raws[n], { key, format: file.split('.').pop(), schema }))); // what the page receives (cache, mirror or worker)
  }
  let failed = 0;
  for (const p of PROFILES) {
    const ctxOld = stub(context(p.profile), page), ctxNew = stub(context(p.profile), page);
    const t = (n) => ctxNew.MzoRows.fromDoc(keys[n], docs[n], 'test', { scope: page.scope });
    ctxOld.RAW = page.keys ? raws : raws._;
    ctxNew.ROWS = page.keys ? Object.keys(keys).reduce((o, n) => { o[n] = t(n); return o; }, {}) : t('_');
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
