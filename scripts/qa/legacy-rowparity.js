#!/usr/bin/env node
/* Row parity for the legacy pages of batch E (their own CSV parsers, no UI kit): runs the page's old
 * parse code on the raw snapshot (from `git show <rev>:<page>`) and its new code on uniform rows
 * (lib/uniform.js with schema/<key>.json, through MzoRows.fromDoc as the page receives them), and
 * compares every row object the page keeps. Pages are described in PAGES below: the functions and
 * constants to lift out of the old and the new page, how to call them, how to key rows, and the
 * known differences with the reason.
 *
 *   node scripts/qa/legacy-rowparity.js <page|all> --snap <snapshotDir> --old <git rev before the conversion> [--papa <papaparse.min.js>] [--show 5]
 *
 * (--old defaults to HEAD, i.e. the page as committed; pass the revision the pages were converted from.
 * Pages that used PapaParse need its file: --papa, or node_modules/papaparse.)
 *
 * None of these pages applies a login scope, so one run covers every login. Exit 1 on anything
 * unexplained.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }

/* ---------- lifting code out of a page ---------- */
// The source of `function name(…) {…}` or `const NAME = …;` (brace / bracket matched, strings and
// regex literals skipped well enough for these pages).
function lift(src, name) {
  const re = new RegExp('(^|\\n)([ \\t]*)((async\\s+)?function\\s+' + name + '\\s*\\(|(const|let|var)\\s+' + name + '\\s*=)');
  const m = re.exec(src);
  if (!m) throw new Error('not found: ' + name);
  const start = m.index + m[1].length + m[2].length;
  const isFn = /function/.test(m[3]);
  let depth = 0;
  for (let i = start + m[3].length - (isFn ? 1 : 0); i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i, c); continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '/' && /[=(,:;!&|?{}\[\n]\s*$/.test(src.slice(Math.max(0, i - 20), i))) { i = skipRegex(src, i); continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') { depth--; if (isFn && c === '}' && depth === 0) return src.slice(start, i + 1); }
    else if (!isFn && c === ';' && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced: ' + name);
}
function skipString(s, i, q) {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (q === '`' && s[j] === '$' && s[j + 1] === '{') { let d = 1; j += 2; for (; j < s.length && d; j++) { if (s[j] === '{') d++; else if (s[j] === '}') d--; else if (s[j] === '`') j = skipString(s, j, '`'); } j--; continue; }
    if (s[j] === q) return j;
  }
  return s.length;
}
function skipRegex(s, i) {
  let cls = false;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '[') cls = true; else if (s[j] === ']') cls = false;
    else if (s[j] === '/' && !cls) { while (/[a-z]/i.test(s[j + 1])) j++; return j; }
    else if (s[j] === '\n') return i; // not a regex after all
  }
  return i;
}

function context(vendor) {
  const ctx = { console, Intl, Date, Math, JSON, Map, Set, Promise, Array, Object, String, Number, RegExp, isNaN, parseFloat, parseInt, setTimeout, clearTimeout };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'mzo_rows.js'), 'utf8'), ctx, { filename: 'mzo_rows.js' });
  for (const f of vendor || []) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: path.basename(f) });
  return ctx;
}
// PapaParse, which some old pages parsed with: --papa <papaparse.min.js> (the version the page loads).
function papa() {
  const f = arg('papa') || [path.join(REPO, 'node_modules', 'papaparse', 'papaparse.min.js'), path.join(REPO, '.scratch', 'vendor', 'papaparse-5.3.2.min.js')].find((x) => fs.existsSync(x));
  if (!f) throw new Error('this page needs PapaParse: --papa <papaparse.min.js>');
  return f;
}

// A Date as the page reads it (local calendar day), or null.
function ymd(d) { return d && !isNaN(d) ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : null; }
function plain(v) {
  if (v instanceof Date || (v && typeof v.getTime === 'function' && typeof v.toISOString === 'function')) return isNaN(v.getTime()) ? 'Invalid Date' : 'D:' + v.getTime();
  return v;
}

/* ---------- the pages ---------- */
const PAGES = {
  'accident/accident.html': {
    key: 'accident_reports',
    old: { lift: ['parseCSV', 'parseCSVLine', 'VALID_REGIONS', 'processData', 'parseDMY'], run: 'processData(parseCSV(RAW))' },
    new: { lift: ['FIELDS', 'toRow', 'VALID_REGIONS', 'processData', 'parseDMY'], run: 'processData(ROWS.rows.map(function (d) { return toRow(d, new Set(ROWS.columns.filter(function (c) { return c.type === "date"; }).map(function (c) { return c.name; }))); }))' },
    id: (r) => r['Accident Id'],
    // What the page derives from a row besides showing it: the parsed accident date (month, year, span).
    derived: { _date: (r, c) => ymd(c.parseDMY(r['Date of Accident'])) },
    // Columns the page never reads (the old parser kept every column; the rows carry only the pinned ones).
    unread: ['Safety Belt', 'Helmet', 'Gum Boot', 'Gloves', 'Ladder', 'Safety Goggles', 'Code of CCC/ Substation/ RE Project', 'Name of the Zone', 'Reason of Delay Submit', 'Incident Accepted on', 'Inquiry Assigned on', 'Enquery On', 'Incident Created on'],
    shown: {
      // Dates are shown as DD/MM/YYYY now; the sheet writes them as 13/7/2018 (accident) or 03.06.2019 (inquiry, payment, …).
      date: (v) => { const m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(String(v || '')); return m ? m[1].padStart(2, '0') + '/' + m[2].padStart(2, '0') + '/' + m[3] : v; }
    },
    dates: ['Date of Accident', 'Inquiry Submitted on', 'Inquiry Accepted on', 'Incident Disposed on', 'Payment Released on'],
    known: {
      'Pending since last status change(days)': 'the sheet writes 2,214 with a grouping comma; uniform rows read it as 2214 (only tested for blank, in a dead code path)',
      'Address of victim/ Owner of Animal': 'a doubled quote inside a quoted cell ("" = one quote mark): the old parser dropped the quote marks'
    }
  },
  'dtr/index.html': {
    key: 'dtr_records',
    old: { slice: ["const lines = csvText.split('\\n')", 'dtrRawData = parsedData;'], pre: 'var csvText = RAW;', ret: 'parsedData' },
    new: { lift: ['toRecords'], run: 'toRecords(ROWS)' },
    id: (r) => r.DTR_CODE,
    match: (r) => r.DTR_CODE + '|' + r.SS_CODE + '|' + r.FDR_CODE,
    known: {
      '*rows': 'the old parser split lines on every comma and newline: every DTR whose LOC_NAME holds a comma or a line break (in quotes) was dropped',
      LOC_NAME: 'a doubled quote inside a quoted cell ("" = one quote mark): the old parser removed every quote mark'
    },
    extraRows: (a, b) => {
      const kva = (rows) => rows.reduce((s, r) => s + (parseFloat(r.CAPA_KV) || 0), 0);
      console.log(`   totals: DTRs ${a.length} → ${b.length}, capacity ${kva(a)} → ${kva(b)} kVA`);
    }
  },
  'dtr/load.html': {
    key: 'dtr_peak_load',
    old: { lift: ['parseCSV', 'parseDateTime'], run: 'parseCSV(RAW)' },
    new: { lift: ['toRecords', 'parseDateTime'], run: 'toRecords(ROWS)' },
    id: (r) => r.DTR_CODE + ' ' + r.DATE_OF_MEASUREMENT,
    // What the page decides from the rows: the latest measurement per DTR (parseDateTime) and the record count.
    derived: { _when: (r, c) => plain(c.parseDateTime(r.DATE_OF_MEASUREMENT)) },
    known: {
      REMARKS: 'a quoted last cell with a comma: the old line splitter stopped at the comma when the line ended in CR LF (e.g. "Village,  DTR load need to reduce " became "Village)'
    }
  },
  'power_map/nh_sh_crossings.html': {
    key: 'highway_crossings',
    papa: true,
    old: { lift: ['escapeHtml', 'selectedFilters', 'FILTER_CATEGORIES', 'num', 'categoryValue', 'getStyleForVoltage', 'getStyleForStatus', 'getStyleForNhSh', 'copyIcon', 'popupProperties'],
      run: 'Papa.parse(RAW, { header: true, dynamicTyping: true, skipEmptyLines: true }).data' },
    new: { lift: ['escapeHtml', 'selectedFilters', 'FILTER_CATEGORIES', 'num', 'categoryValue', 'getStyleForVoltage', 'getStyleForStatus', 'getStyleForNhSh', 'copyIcon', 'popupProperties', 'toEntries'],
      run: 'toEntries(ROWS)' },
    id: (r) => r.ID,
    derivedOnly: true,
    // Everything the page takes from an entry: facet values, report keys, sums, marker position and colours, popup, search.
    derived: {
      facets: (e, c) => c.FILTER_CATEGORIES.map((cat) => c.categoryValue(e, cat)),
      report: (e, c) => c.FILTER_CATEGORIES.map((cat) => (cat === 'UG Cable Required' ? c.categoryValue(e, cat) : String(e[cat] || 'N/A').trim())),
      sums: (e, c) => ['Number of Span (HT)', 'Number of Span (LT)', 'R/L HT-11kV (in m)', 'R/L HT-33kV (in m)', 'R/L LT (in m)', 'Approx. UG Cable required (m)', 'Approx. OH-HT required (m)', 'Approx. OH-LT required (m)'].map((k) => c.num(e[k])),
      dtr: (e) => String(e['DTR Required'] || '').trim().toLowerCase(),
      marker: (e) => [parseFloat(e.Lat), parseFloat(e.Long)].map((v) => (isNaN(v) ? 'NaN' : v)),
      colours: (e, c) => [c.getStyleForVoltage(e['Voltage Level']).fillColor, c.getStyleForStatus(e.Status).fillColor, c.getStyleForNhSh(e['NH/SH']).fillColor],
      popup: (e, c) => c.popupProperties(e),
      search: (e) => [String(e.ID || ''), String(e['e-note no.'] || ''), String(e.ID || 'N/A'), String(e.Division || 'N/A'), String(e.CCC || 'N/A'), String(e['e-note no.'] || 'N/A')]
    },
    known: {
      popup: 'the popup shows Lat/Long as the sheet writes them (25.0105960, not 25.010596) and CG Exists? trimmed'
    }
  },
  'stock/index.html': {
    file: 'stock/script.js',
    key: 'stock_snapshot',
    papa: true,
    vendor: ['stock/stock_material_category.js'],
    also: [{ key: 'stock_materials', oldVar: 'META', newVar: 'METAROWS' }],
    old: { lift: ['PLANT_MAP', 'materialMetadata', 'parseMetadata', 'parseStockNumber', 'formatDate'], slice: ['allData = data.map(item => {', 'const latestDate'],
      pre: 'var data = Papa.parse(RAW, { header: true, skipEmptyLines: true }).data, allData; parseMetadata(META);', ret: 'allData' },
    new: { lift: ['PLANT_MAP', 'materialMetadata', 'parseMetadata', 'parseStockNumber', 'formatDate', 'toItems'], slice: ['allData = data.map(item => {', 'const latestDate'],
      pre: 'var data = toItems(ROWS), allData; parseMetadata(METAROWS);', ret: 'allData' },
    id: (r) => r.Plant + ' ' + r.Material,
    formOnly: ['Unrestricted', 'Date'],
    derived: { _stock: (r, c) => c.parseStockNumber(r.Unrestricted), _day: (r, c) => c.formatDate(r.Date) },
    unread: ['Material Type', 'Storage Location', 'Descr. of Storage Loc.', 'Stock in Transit', 'Transit and Transfer'],
    extra: (a, b, cOld, cNew) => {
      const head = (rows, c) => 'Stock of Major Materials (' + c.formatDate(rows.reduce((max, item) => (item.Date > max ? item.Date : max), '')) + ')';
      const sum = (rows, c) => rows.reduce((s, r) => s + c.parseStockNumber(r.Unrestricted), 0);
      console.log(`   header: ${JSON.stringify(head(a, cOld))} → ${JSON.stringify(head(b, cNew))}; total Unrestricted ${sum(a, cOld)} → ${sum(b, cNew)}; materials with a sheet category ${Object.keys(cOld.materialMetadata).length} → ${Object.keys(cNew.materialMetadata).length}`);
    }
  },
  'power_map/map.html': {
    key: 'power_map_substations', papa: true,
    oldFile: 'power_map_api.csv', newFile: 'power_map_api.csv',
    old: { lift: ['dmsToDecimal'], slice: ['allData = rawData.filter(', 'showStatus(`Loaded'],
      pre: 'var rawData = Papa.parse(RAW.trim(), { header: true, dynamicTyping: false, skipEmptyLines: true }).data, allData;', ret: 'allData' },
    new: { lift: ['dmsToDecimal', 'SUBSTATION_COLUMNS', 'toEntries'], slice: ['allData = rawData.filter(', 'showStatus(`Loaded'],
      pre: 'var rawData = toEntries(ROWS, SUBSTATION_COLUMNS), allData;', ret: 'allData' },
    id: (r) => r.Substation,
    derived: { _at: (r, c) => [c.dmsToDecimal(r.LATITUDE), c.dmsToDecimal(r.LONGITUDE)] }
  },
  // The same page in mirror mode: rows built from the table's JSON snapshot instead of the API's CSV.
  'power_map/map.html#mirror': {
    file: 'power_map/map.html', key: 'power_map_substations', papa: true,
    oldFile: 'power_map_api.csv', newFile: 'power_map_substations.json',
    old: { lift: ['dmsToDecimal'], slice: ['allData = rawData.filter(', 'showStatus(`Loaded'],
      pre: 'var rawData = Papa.parse(RAW.trim(), { header: true, dynamicTyping: false, skipEmptyLines: true }).data, allData;', ret: 'allData' },
    new: { lift: ['dmsToDecimal', 'SUBSTATION_COLUMNS', 'toEntries'], slice: ['allData = rawData.filter(', 'showStatus(`Loaded'],
      pre: 'var rawData = toEntries(ROWS, SUBSTATION_COLUMNS), allData;', ret: 'allData' },
    id: (r) => r.Substation,
    derived: { _at: (r, c) => [c.dmsToDecimal(r.LATITUDE), c.dmsToDecimal(r.LONGITUDE)] }
  },
  'power_map/map.html#taps': {
    file: 'power_map/map.html', key: 'power_map_taps', papa: true,
    old: { lift: ['dmsToDecimal'], run: 'Papa.parse(RAW.trim(), { header: true, dynamicTyping: false, skipEmptyLines: true }).data' },
    new: { lift: ['dmsToDecimal', 'toEntries'], run: 'toEntries(ROWS, null)' },
    id: (r) => r.TappedSubstation,
    derived: { _at: (r, c) => [c.dmsToDecimal(r.TapPointLatitude), c.dmsToDecimal(r.TapPointLongitude)] }
  }
};

function runPage(name, page, opts) {
  const snap = opts.snap;
  // page.oldFile: what the old page parsed when it is not the snapshot itself (Power Map: the CSV that
  // /api/power-map/data builds); page.newFile: the snapshot the new rows are built from (default: same).
  const file = page.oldFile || fs.readdirSync(snap).find((f) => f.replace(/\.(csv|tsv|json)$/, '') === page.key && /\.(csv|tsv|json)$/.test(f));
  const raw = fs.readFileSync(path.join(snap, file), 'utf8');
  const newFile = page.newFile || file;
  const newRaw = fs.readFileSync(path.join(snap, newFile), 'utf8');
  const oldSrc = execFileSync('git', ['-C', REPO, 'show', opts.rev + ':' + (page.file || name.split('#')[0])], { encoding: 'utf8', maxBuffer: 64 << 20 }).replace(/\r\n/g, '\n');
  const newSrc = fs.readFileSync(path.join(REPO, page.file || name), 'utf8').replace(/\r\n/g, '\n');
  const U = require(path.join(REPO, 'lib', 'uniform.js'));
  U.useOffices(require(path.join(REPO, 'lib', 'offices.js')), JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'costcenter.json'), 'utf8')));
  const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schema', page.key + '.json'), 'utf8'));
  const doc = JSON.parse(U.stringify(U.build(newRaw, { key: page.key, format: newFile.split('.').pop(), schema })));

  const vendor = (page.vendor || []).map((f) => path.join(REPO, f));
  const cOld = context((page.papa ? [papa()] : []).concat(vendor)), cNew = context(vendor);
  cOld.RAW = page.oldInput ? page.oldInput(raw) : raw;
  cNew.ROWS = cNew.MzoRows.fromDoc(page.key, doc, 'test', { scope: false });
  // More datasets the page reads: the raw text as old.var, the uniform rows as new.var.
  for (const x of page.also || []) {
    const f2 = fs.readdirSync(snap).find((f) => f.replace(/\.(csv|tsv|json)$/, '') === x.key && /\.(csv|tsv|json)$/.test(f));
    const raw2 = fs.readFileSync(path.join(snap, f2), 'utf8');
    const sc2 = JSON.parse(fs.readFileSync(path.join(REPO, 'schema', x.key + '.json'), 'utf8'));
    cOld[x.oldVar] = raw2;
    cNew[x.newVar] = cNew.MzoRows.fromDoc(x.key, JSON.parse(U.stringify(U.build(raw2, { key: x.key, format: f2.split('.').pop(), schema: sc2 }))), 'test', { scope: false });
  }
  const exec = (ctx, src, side) => {
    let code;
    if (side.slice) {
      const i = src.indexOf(side.slice[0]), j = src.indexOf(side.slice[1], i);
      if (i < 0 || j < 0) throw new Error('slice markers not found: ' + side.slice.join(' … '));
      code = (side.lift || []).map((n) => lift(src, n)).join('\n') + '\n;(function(){ ' + (side.pre || '') + '\n' + src.slice(i, j) + '\nreturn ' + side.ret + '; })()';
    } else code = side.lift.map((n) => lift(src, n)).join('\n') + '\n;(' + 'function(){ return ' + side.run + '; })()';
    return vm.runInContext(code.replace(/^(\s*)const /gm, '$1var ').replace(/^(\s*)let /gm, '$1var '), ctx);
  };
  const a = Array.from(exec(cOld, oldSrc, page.old)), b = Array.from(exec(cNew, newSrc, page.new));
  const show = Number(opts.show || 3);
  const diffs = {}, form = {};
  let rowsDiff = 0;
  // Rows are compared by position, or by key (page.match) when the old parser lost rows.
  let pairs;
  if (page.match) {
    const byKey = new Map();
    a.forEach((r, i) => { const k = page.match(r); if (!byKey.has(k)) byKey.set(k, i); });
    const seen = new Set();
    pairs = [];
    const onlyNew = [];
    b.forEach((r, j) => { const k = page.match(r); if (byKey.has(k) && !seen.has(k)) { seen.add(k); pairs.push([byKey.get(k), j]); } else onlyNew.push(j); });
    const onlyOld = a.map((r, i) => i).filter((i) => !seen.has(page.match(a[i])));
    console.log(`   matched by key: ${pairs.length} rows in both, ${onlyNew.length} only in the new rows, ${onlyOld.length} only in the old rows`);
    if (onlyNew.length) console.log(`   only new, e.g. ${JSON.stringify(onlyNew.slice(0, show).map((j) => b[j]))}`);
    if (onlyOld.length) console.log(`   only old, e.g. ${JSON.stringify(onlyOld.slice(0, show).map((i) => a[i]))}`);
    if (page.extraRows) page.extraRows(a, b, onlyOld, onlyNew);
    if (onlyOld.length && !(page.known && page.known['*onlyOld'])) diffs['*rows only in the old page'] = { count: onlyOld.length, samples: [] };
  } else {
    pairs = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) pairs.push([i, i]);
  }
  const norm = (r, ctx) => {
    const o = {};
    Object.keys(r).forEach((k) => { o[k] = plain(r[k]); });
    Object.keys(page.derived || {}).forEach((k) => { o[k] = page.derived[k](r, ctx); });
    return o;
  };
  for (const [i, j] of pairs) {
    const x = a[i] ? norm(a[i], cOld) : {}, y = b[j] ? norm(b[j], cNew) : {};
    let any = false;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if ((page.unread || []).includes(k) && !(k in y)) continue;
      if ((page.derivedOnly && !(page.derived && k in page.derived)) || (page.formOnly || []).includes(k)) { if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) { const f = form[k] || (form[k] = { count: 0, samples: [] }); f.count++; if (f.samples.length < 2) f.samples.push([x[k], y[k]]); } continue; }
      let xv = x[k], yv = y[k];
      if ((page.dates || []).includes(k) && page.shown && page.shown.date) xv = page.shown.date(xv);
      if (JSON.stringify(xv) === JSON.stringify(yv)) continue;
      any = true;
      const d = diffs[k] || (diffs[k] = { count: 0, samples: [] });
      d.count++;
      if (d.samples.length < show) d.samples.push({ row: i, id: page.id(a[i] || b[j] || {}), old: x[k], new: y[k] });
    }
    if (any) rowsDiff++;
  }
  console.log(`${name}: rows old ${a.length} new ${b.length}; rows differing ${rowsDiff}${page.unread ? '; not compared (never read by the page): ' + page.unread.length + ' columns' : ''}`);
  let unexplained = a.length !== b.length && !(page.known && page.known['*rows']) ? 1 : 0;
  if (a.length !== b.length) console.log(`   row count ${a.length} → ${b.length}: ${page.known && page.known['*rows'] ? '(known: ' + page.known['*rows'] + ')' : 'UNEXPLAINED'}`);
  for (const [k, d] of Object.entries(diffs)) {
    const why = page.known && page.known[k];
    if (!why) unexplained++;
    console.log(`   field ${JSON.stringify(k)}: ${d.count} rows${why ? ' (known: ' + why + ')' : ' UNEXPLAINED'}, e.g. ${JSON.stringify(d.samples)}`);
  }
  for (const [k, f] of Object.entries(form)) console.log(`   value form of ${JSON.stringify(k)} differs in ${f.count} rows (not compared: the page reads it only through the derived values), e.g. ${JSON.stringify(f.samples)}`);
  if (page.extra) page.extra(a, b, cOld, cNew);
  return unexplained;
}

function main() {
  const which = process.argv[2];
  const snap = arg('snap');
  if (!which || !snap) { console.error('usage: legacy-rowparity.js <' + Object.keys(PAGES).join('|') + '|all> --snap <dir>'); process.exit(2); }
  const names = which === 'all' ? Object.keys(PAGES) : [which];
  let bad = 0;
  for (const nm of names) {
    if (!PAGES[nm]) { console.error('unknown page ' + nm); process.exit(2); }
    bad += runPage(nm, PAGES[nm], { snap, rev: arg('old', 'HEAD'), show: arg('show') });
  }
  process.exit(bad ? 1 : 0);
}
if (require.main === module) main();
module.exports = { lift };
