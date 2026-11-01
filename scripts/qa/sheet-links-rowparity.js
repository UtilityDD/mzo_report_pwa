#!/usr/bin/env node
/* sheet_links.html: the "Updated" date each dataset gets from its own rows, old page vs new page.
 *
 *   node scripts/qa/sheet-links-rowparity.js --snap <snapshotDir> [--old <git rev>]
 *
 * Old: the page's own CSV parser and date rules (from `git show <rev>:sheet_links.html`) on the raw
 * snapshot, called exactly as the old page called them. New: the AS_ON rules of the working copy
 * (between "---- as-on rules" and "---- end of as-on rules") on uniform rows from lib/uniform.js, in
 * one Node context with the real mzo_ui.js, mzo_scope.js and mzo_rows.js, as admin and as a region
 * and a CCC login (the rules read t.all / t.first, so the login must not matter).
 * Then crafted sheets for the two parser bugs fixed in the conversion. Exit 1 on anything unexplained.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; }

// registry key → uniform key, and the old page's call for it (checked against the old source)
const CASES = [
  ['CACHE_DISCONNECTION', 'disconnection', "latestDate(csv, /PAID\\/DISCON DATE/i, DOTTED)"],
  ['CACHE_DOCKET', 'docket_calls', "latestDate(csv, /^doc_crn_dt$/i, /^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})/)"],
  ['CACHE_CAPEX', 'capex_details', "latestDate(csv, /^Reporting Date$/i, DOTTED)"],
  ['CACHE_PENDING_MC', 'pending_mc', "latestDate(csv, /^Report Date$/i, /^(\\d{1,2})[-\\/](\\d{1,2})[-\\/](\\d{4})/, true)"],
  ['CACHE_CMO', 'cmo_grievances', 'cmoHeaderDate(csv)'],
  ['CACHE_COLLECTION', 'collection_report', 'collectionToDate(csv)'],
  ['CACHE_BHARATNET', 'bharatnet_connections', 'firstRowHeaderDate(csv, /upadte\\s*date|update\\s*date/i, 13)'],
  ['CACHE_ICDS_APLUS', 'icds_a_plus', 'firstRowHeaderDate(csv, /update\\s*date/i, 12)'],
  ['CACHE_ICDS_A', 'icds_a', 'firstRowHeaderDate(csv, /update\\s*date/i, 12)'],
  ['CACHE_PMSGY_MALDA', 'pmsgy_malda', 'pmsgyAsOn(csv)'],
  ['CACHE_PMSGY_UD', 'pmsgy_uttar_dinajpur', 'pmsgyAsOn(csv)'],
  ['CACHE_PMSGY_DD', 'pmsgy_dakshin_dinajpur', 'pmsgyAsOn(csv)'],
  ['CACHE_LOSS', 'loss_report', 'firstRowHeaderDate(csv, /update\\s*on|update\\s*date/i, 9)'],
  ['CACHE_FEEDER_OUTAGE', 'feeder_outage', 'feederOutageAsOn(csv)'],
  ['OM_ADVANCE', 'onm_advance', 'latestDate(csv, /^Creation Date$/i, DOTTED)']
];
// Differences that are the conversion's fixes, by registry key: { old, new, why } must match exactly.
const KNOWN = {};

// Crafted sheets: the parser bugs the conversion fixes (old and new must give these values).
const PMSGY_HEAD = 'Sl No,Application Number,Consumer Name,Last Action Date\n';
const CRAFTED = [
  {
    name: 'PM Surya Ghar: a Last Action Date with the full month name', hub: 'CACHE_PMSGY_MALDA', key: 'pmsgy_malda', old: 'pmsgyAsOn(csv)',
    csv: PMSGY_HEAD + 'Logic,,,\n1,NP-WBMA25-1,A,28-Oct-26\n2,NP-WBMA25-2,B,02-November-26\n3,NP-WBMA25-3,C,7-February-25\n',
    want: { old: '28/10/2026', new: '02/11/2026' },
    why: 'bug fixed: the old parser read only 3-letter months, so "02-November-26" was skipped (as pmsgy.html had)'
  },
  {
    name: 'CMO: Report Dates across a month end', hub: 'CACHE_CMO', key: 'cmo_grievances', old: 'cmoHeaderDate(csv)',
    csv: 'District,Report Date\nMalda,01/11/2026\nMalda,31/10/2026\n',
    want: { old: '31/10/2026', new: '01/11/2026' },
    why: 'bug fixed: the old page took the largest Report Date as text ("31/10/2026" > "01/11/2026"); the new one reads the date as a date, by the rule of cmo.html (the first row\'s Report Date)'
  }
];

const PROFILES = [
  { label: 'admin', profile: { Username: 'qa', role: 'admin' } },
  { label: 'region Raiganj', profile: { Username: 'qa', role: 'user', region_code: 'Raiganj', 'sheets-autho': 'list' } },
  { label: 'ccc 6611108', profile: { Username: 'qa', role: 'user', ccc_code: '6611108', 'sheets-autho': 'list' } }
];

// Old: the named functions of the old inline script (each from "    function name(" to its closing "    }").
function oldFunctions(src) {
  const names = ['formatWhen', 'csvRows', 'latestDate', 'cmoHeaderDate', 'collectionToDate', 'firstRowHeaderDate', 'pmsgyAsOn', 'feederOutageAsOn'];
  let code = "const pad = function (n) { return String(n).padStart(2, '0'); };\nconst DOTTED = /^(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})$/;\n";
  if (!src.includes("const DOTTED = /^(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})$/;")) throw new Error('old DOTTED changed');
  for (const n of names) {
    const a = src.indexOf('    function ' + n + '(');
    const b = src.indexOf('\n    }\n', a);
    if (a < 0 || b < 0) throw new Error('old function not found: ' + n);
    code += src.slice(a, b + 7);
  }
  return code;
}
function newRules(src) {
  const a = src.indexOf('    // ---- as-on rules'), b = src.indexOf('    // ---- end of as-on rules ----');
  if (a < 0 || b < 0) throw new Error('new as-on rules block not found');
  return src.slice(a, b);
}

function context(profile) {
  const store = { mzo_user_profile: JSON.stringify(profile) };
  const el = () => ({ textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
  const document = { readyState: 'complete', body: null, head: el(), documentElement: el(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => el(), createElement: el };
  const ctx = { console, document, localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }, Intl, Date, Math, JSON, Map, Set, Promise, setTimeout, clearTimeout };
  ctx.window = ctx; ctx.self = ctx; ctx.top = ctx;
  vm.createContext(ctx);
  for (const f of ['lib/offices.js', 'mzo_scope.js', 'mzo_ui.js', 'mzo_rows.js']) vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), ctx, { filename: f });
  return ctx;
}

function main() {
  const snap = arg('snap');
  if (!snap) { console.error('usage: sheet-links-rowparity.js --snap <dir> [--old <rev>]'); process.exit(2); }
  const oldSrc = execFileSync('git', ['-C', REPO, 'show', arg('old', 'HEAD') + ':sheet_links.html'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const newSrc = fs.readFileSync(path.join(REPO, 'sheet_links.html'), 'utf8');
  // each call as the old page wrote it (showLatest(key, …) is latestDate(csv, …) on that key's CSV)
  CASES.forEach(([hub, , call]) => {
    const written = /^latestDate\(csv, /.test(call) && hub !== 'OM_ADVANCE' ? "showLatest('" + hub + "', " + call.slice('latestDate(csv, '.length, -1) + ');' : call;
    if (!oldSrc.includes(written)) throw new Error('old call not found in the old page: ' + written);
  });
  const U = require(path.join(REPO, 'lib', 'uniform.js'));
  U.useOffices(require(path.join(REPO, 'lib', 'offices.js')), JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'costcenter.json'), 'utf8')));
  const man = JSON.parse(fs.readFileSync(path.join(snap, 'manifest.json'), 'utf8')).datasets;
  const docOf = (key, text, format) => JSON.parse(U.stringify(U.build(text, { key, format: format || 'csv', schema: JSON.parse(fs.readFileSync(path.join(REPO, 'schema', key + '.json'), 'utf8')) })));

  const oldCtx = context(PROFILES[0].profile);
  vm.runInContext(oldFunctions(oldSrc), oldCtx);
  const oldRun = (call, csv) => { oldCtx.csv = csv; return vm.runInContext(call, oldCtx); };
  const newCtxs = PROFILES.map((p) => { const c = context(p.profile); vm.runInContext(newRules(newSrc) + '\nthis.AS_ON = AS_ON;', c); return c; });
  const newRun = (ctx, hub, key, doc) => ctx.AS_ON[hub][1](ctx.MzoRows.fromDoc(key, doc, 'test')); // default scope: t.rows scoped, the rules read t.all

  let bad = 0;
  console.log('Real data (' + snap + '):');
  for (const [hub, key, call] of CASES) {
    const e = man[key];
    if (!e) { console.log(`  ${hub.padEnd(20)} ${key}: not in the snapshot`); bad++; continue; }
    const text = fs.readFileSync(path.join(snap, e.file), 'utf8');
    const before = oldRun(call, text);
    const doc = docOf(key, text, e.file.split('.').pop());
    const after = newCtxs.map((c) => newRun(c, hub, key, doc));
    const sameLogins = after.every((x) => x === after[0]);
    const k = KNOWN[hub];
    const ok = sameLogins && (before === after[0] || (k && k.old === before && k.new === after[0]));
    if (!ok) bad++;
    console.log(`  ${hub.padEnd(20)} ${key.padEnd(24)} old ${JSON.stringify(before).padEnd(13)} new ${JSON.stringify(after[0]).padEnd(13)} ${sameLogins ? '(admin = region = CCC)' : 'LOGINS DIFFER ' + JSON.stringify(after)} ${before === after[0] ? 'same' : k ? 'known: ' + k.why : 'UNEXPLAINED'}`);
  }
  console.log('Crafted sheets (the parser bugs fixed):');
  for (const c of CRAFTED) {
    const before = oldRun(c.old, c.csv);
    const after = newRun(newCtxs[0], c.hub, c.key, docOf(c.key, c.csv));
    const ok = before === c.want.old && after === c.want.new;
    if (!ok) bad++;
    console.log(`  ${c.name}: old ${JSON.stringify(before)} new ${JSON.stringify(after)} ${ok ? 'as expected (' + c.why + ')' : 'UNEXPECTED, want ' + JSON.stringify(c.want)}`);
  }
  process.exit(bad ? 1 : 0);
}
main();
