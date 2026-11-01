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
 * A page that reads several datasets lists them in `keys` (RAW / ROWS are then objects by key;
 * `scope` may be an object by key, `json` names the keys the old page got as parsed JSON).
 * `scripts` are extra page scripts loaded into the context, `setup(ctx)` stubs page globals,
 * `id(row)` names a row in the samples, `ignore` lists fields the old rows carried that the page
 * never reads (the old parser kept every column; uniform rows carry only the pinned ones).
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
  // Batch D (wave-d)
  'cmo.html': {
    key: 'cmo_grievances', from: '    var DISTRICTS = ', to: '    function base()',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: false, id: (x) => x.name + ' ' + x.phone,
    setup: (ctx) => { ctx.MzoScope = undefined; }, // the page loads no mzo_scope.js
    known: { applicant: 'kept in the row but never shown: uniform text is trimmed (one cell starts with a space)' }
  },
  'pmsgy.html': {
    keys: ['pmsgy_malda', 'pmsgy_uttar_dinajpur', 'pmsgy_dakshin_dinajpur'], scope: true, scripts: ['lib/offices.js'],
    oldFrom: '    var MON = { jan', from: '    var JOBS = ', to: '    function fillFilters() {', rows: 'all', id: (x, y) => x.appl || y.appl,
    // the old load(): three tabs → ingest → as-on over every row → MzoScope.filterRows; the new paint()
    old: "(function () { var rows = []; [RAW.pmsgy_malda, RAW.pmsgy_uttar_dinajpur, RAW.pmsgy_dakshin_dinajpur].forEach(function (c, i) { rows = rows.concat(ingest(c, JOBS[i][1])); }); var last = rows.reduce(function (a, r) { return r.last && r.last > a ? r.last : a; }, null); rows = MzoScope.filterRows(rows); rows.asOn = last; return (all = rows); })()",
    new: "(function () { var ts = [ROWS.pmsgy_malda, ROWS.pmsgy_uttar_dinajpur, ROWS.pmsgy_dakshin_dinajpur], rows = []; ts.forEach(function (t, i) { rows = rows.concat(ingest(t, JOBS[i][1])); }); rows.asOn = asOnOf(ts); return (all = rows); })()",
    known: {
      last: 'bug fixed: the old date parser read only 3-letter months; "02-October-26" style Last Action Dates were empty',
      net: 'bug fixed: Net Metering Dates written with the full month name ("7-February-25") were not read, so those connections were not counted',
      connected: 'follows net (full month names now read): more applications count as Connected',
      agreement: 'bug fixed: Agreement Upload Dates with the full month name ("2-September-26") were not read'
    }
  },
  'safety_inspection.html': {
    key: 'safety_inspection', from: '    var raw = [], all = []', to: '    function base()', scripts: ['lib/offices.js'],
    old: '(raw = UI.csv(RAW), build(), all)', new: '(raw = ROWS.rows, build(), all)', rows: 'all', scope: false, id: (x) => x.insp
  },
  'capex_all.html': {
    keys: ['vendor_map', 'costcenter', 'capex_details'], json: ['costcenter'], scope: { vendor_map: false, costcenter: false, capex_details: true },
    scripts: ['lib/offices.js'], from: '    var AGE = [', to: '    function base(skipAge)', rows: 'all', id: (x, y) => (x.project || y.project) + ' ' + (x.mcode || y.mcode),
    old: '(maps(RAW.vendor_map, RAW.costcenter), prepare(RAW.capex_details), all.asOn = asOn, all)',
    new: '(maps(ROWS.vendor_map, ROWS.costcenter), prepare(ROWS.capex_details), all.asOn = asOn, all)'
  },
  'advance_onm.html': {
    keys: ['vendor_map', 'costcenter', 'onm_advance'], json: ['costcenter'], scope: { vendor_map: false, costcenter: false, onm_advance: true },
    scripts: ['lib/offices.js'], from: '    var AGE = [', to: '    function base(skipAge)', rows: 'all', id: (x, y) => x.order || y.order,
    old: '(maps(RAW.vendor_map, RAW.costcenter), prepare(RAW.onm_advance), all.asOn = asOn, all)',
    new: '(maps(ROWS.vendor_map, ROWS.costcenter), prepare(ROWS.onm_advance), all.asOn = asOn, all)'
  },
  'consumer/defective_meter.html': {
    keys: ['defective_summary'], scope: true, scripts: ['lib/offices.js', 'lib/defective_meter_pipeline.js'],
    from: '    var P = window.MzoDefectivePipeline;', to: '    function fail(msg) {', rows: 'rows', id: (x, y) => (x.CCC_CODE || y.CCC_CODE) + ' ' + (x.BASE_CLASS || y.BASE_CLASS),
    setup: defectiveStubs,
    old: '(onSummary(RAW.defective_summary), rows.asOn = asOn, rows)', new: '(onSummary(ROWS.defective_summary), rows.asOn = asOn, rows)',
    display: Object.assign({ DEFECT_YEAR: (v) => (v == null ? '' : String(v)) }, ...['total', 'agri', 'over10', 'over5', 'ph3', 'industrial', 'smart', 'load_gt6', 'load_3_6', 'load_1_3', 'load_05_1', 'load_lt_05', 'phase_1', 'phase_3', 'phase_other'].map((k) => ({ [k]: (v) => Number(v) || 0 }))),
    ignore: ['REGION', 'REGION_CODE', 'DIVISION', 'DIVISION_CODE', 'DEFECT_MONTH']
  },
  'consumer/defective_meter.html:details': {
    file: 'consumer/defective_meter.html', keys: ['defective_details'], scope: true, scripts: ['lib/offices.js', 'lib/defective_meter_pipeline.js'],
    from: '    var P = window.MzoDefectivePipeline;', to: '    function fail(msg) {', rows: 'details', id: (x, y) => (x.CON_ID || y.CON_ID) + '|' + (x.METER_NO || y.METER_NO),
    setup: defectiveStubs,
    old: '(details = MzoScope.filterRows(parseRows(RAW.defective_details).map(withOffice)), details)',
    new: '(details = ROWS.defective_details.rows.filter(isRow).map(detailRow), details)',
    display: Object.assign({}, ...['over10', 'ph3', 'industrial', 'smart', 'load_gt6', 'load_3_6', 'load_1_3'].map((k) => ({ [k]: (v) => Number(v) || 0 }))),
    known: {
      ADDRESS: 'uniform text is trimmed: the dump pads addresses with spaces (HTML never showed them; the names CSV export no longer carries them)',
      MOBILE_NO: 'uniform text is trimmed: blank mobiles were runs of spaces',
      NAME: 'uniform text is trimmed (one name ends in a space)'
    }
  },
  'feeder_outage.html': {
    key: 'feeder_outage', from: '    var MON = [', to: '    /* events */', scripts: ['lib/offices.js'],
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true, id: (x) => x.code + ' ' + x.month
  },
  'safety_inspection.html:inspection': {
    file: 'safety_inspection.html', key: 'safety_inspection', from: '    var raw = [], all = []', to: '    function base()', scripts: ['lib/offices.js'],
    old: "(groupBy = 'Inspection ID', raw = UI.csv(RAW), build(), all)", new: "(groupBy = 'Inspection ID', raw = ROWS.rows, build(), all)", rows: 'all', scope: false, id: (x) => x.insp
  }
};
// The defective page wires DOM events and reads location while it builds its rows.
function defectiveStubs(ctx) {
  ctx.document.querySelector = () => ctx.document.createElement();
  ctx.location = { search: '' };
  ctx.URLSearchParams = URLSearchParams;
  ctx.UI.table = ctx.UI.hist = function () {};
}
const PROFILES = [
  { label: 'admin', profile: { Username: 'qa', role: 'admin' } },
  { label: 'region Raiganj', profile: { Username: 'qa', role: 'user', region_code: 'Raiganj' } },
  { label: 'division Gazole', profile: { Username: 'qa', role: 'user', division_code: 'Gazole' } },
  { label: 'ccc 6611108', profile: { Username: 'qa', role: 'user', ccc_code: '6611108' } }
];

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }

function context(profile, page) {
  const store = { mzo_user_profile: JSON.stringify(profile) };
  const el = () => ({ textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
  const document = { readyState: 'complete', body: null, head: el(), documentElement: el(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => el(), createElement: el };
  const ctx = { console, document, localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }, Intl, Date, Math, JSON, Map, Set, Promise, setTimeout, clearTimeout };
  ctx.window = ctx; ctx.self = ctx; ctx.top = ctx;
  vm.createContext(ctx);
  for (const f of ['mzo_scope.js', 'mzo_ui.js', 'mzo_rows.js'].concat((page && page.scripts) || [])) vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), ctx, { filename: f });
  ctx.UI.drill = () => ({ match: () => true }); // DOM-only helpers the parse regions set up
  ctx.UI.sidePanel = () => function () {};
  ctx.UI.lockScope = () => ({}); // pins the office selects (DOM only)
  ctx.__text = {};
  ctx.$ = (id) => { const e = el(); Object.defineProperty(e, 'textContent', { get: () => ctx.__text[id] || '', set: (v) => { ctx.__text[id] = String(v); } }); return e; };
  ctx.render = ctx.clearAll = function () {}; // page functions the region refers to
  if (page && page.setup) page.setup(ctx);
  return ctx;
}

function region(src, page, which) {
  const from = (which === 'old' && page.oldFrom) || page.from, to = (which === 'old' && page.oldTo) || page.to;
  const a = src.indexOf(from), b = src.indexOf(to, a + 1);
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
  const fileOf = (key) => fs.readdirSync(snap).find((f) => f.replace(/\.(csv|tsv|json)$/, '') === key && /\.(csv|tsv|json)$/.test(f));
  const raws = {}, files = {};
  keys.forEach((k) => { files[k] = fileOf(k); raws[k] = fs.readFileSync(path.join(snap, files[k]), 'utf8'); });
  const raw = raws[keys[0]];
  const pageFile = page.file || pageName;
  const oldSrc = execFileSync('git', ['-C', REPO, 'show', oldRev + ':' + pageFile], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const newSrc = fs.readFileSync(path.join(REPO, pageFile), 'utf8');
  const U = require(path.join(REPO, 'lib', 'uniform.js'));
  const offices = require(arg('offices', path.join(REPO, 'lib', 'offices.js')));
  U.useOffices(offices, JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'costcenter.json'), 'utf8')));
  const docs = {};
  keys.forEach((k) => {
    const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schema', k + '.json'), 'utf8'));
    const res = U.build(raws[k], { key: k, format: files[k].split('.').pop(), schema });
    docs[k] = JSON.parse(U.stringify(res)); // what the page receives (cache, mirror or worker)
  });
  const uniformRows = docs[keys[0]];
  const scopeOf = (k) => (page.scope && typeof page.scope === 'object' ? page.scope[k] !== false : page.scope);
  const rawFor = (k) => ((page.json || []).includes(k) ? JSON.parse(raws[k]) : raws[k]);
  let failed = 0;
  for (const p of PROFILES) {
    const ctxOld = context(p.profile, page), ctxNew = context(p.profile, page);
    if (page.keys) {
      ctxOld.RAW = {}; ctxNew.ROWS = {};
      keys.forEach((k) => { ctxOld.RAW[k] = rawFor(k); ctxNew.ROWS[k] = ctxNew.MzoRows.fromDoc(k, docs[k], 'test', { scope: scopeOf(k) }); });
    } else {
      ctxOld.RAW = raw;
      ctxNew.ROWS = ctxNew.MzoRows.fromDoc(page.key, uniformRows, 'test', { scope: page.scope });
    }
    const a = rowsOf(ctxOld, page, region(oldSrc, page, 'old'), page.old);
    const b = rowsOf(ctxNew, page, region(newSrc, page, 'new'), page.new);
    const diffs = {}; let rowsDiff = 0;
    const n = Math.max(a.rows.length, b.rows.length);
    for (let i = 0; i < n; i++) {
      const x = a.rows[i] || {}, y = b.rows[i] || {};
      let any = false;
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (page.ignore && page.ignore.includes(k)) continue; // columns the old rows carried but the page never reads
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
