#!/usr/bin/env node
/* Ask (assistant.html): the tool results its adapters give, old page vs new page. No model call.
 *
 *   node scripts/qa/assistant-tools.js --old <baseUrl> --new <baseUrl>[,<baseUrl>…] --snap <dir>
 *        [--profiles admin,region,division,ccc] [--out <dir>]
 *
 * Each base serves its own assistant.html. The tool code of that file (from "data for tools" to
 * "conversation": the adapters, queryTable, queryLoss and runTool) is run inside the real page, with
 * the page's own scripts (DataHub, MzoScope, MzoRows, the catalog), for the tool calls in CALLS:
 * what the model asks for representative questions. POST /api/assistant is never sent (every
 * request that is not GET/HEAD is aborted), and Apps Script is blocked. Google and Supabase Storage
 * requests are answered from the snapshot folder, so both pages read the same bytes.
 * Prints each call's result differences, old → new. Exit 1 when a base fails to answer.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; }
function loadPlaywright() {
  for (const t of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core', 'playwright']) { if (!t) continue; try { return require(t); } catch (_) {} }
  const npx = path.join(os.homedir(), '.npm', '_npx');
  for (const d of fs.existsSync(npx) ? fs.readdirSync(npx) : []) { const p = path.join(npx, d, 'node_modules', 'playwright-core'); if (fs.existsSync(path.join(p, 'package.json'))) return require(p); }
  throw new Error('playwright-core not found');
}
const PROFILES = {
  admin: { Username: 'local-preview', Name: 'Local Preview', role: 'admin', office_level: 'CE' },
  region: { Username: 'qa-raiganj', Name: 'QA Raiganj', role: 'user', region_code: 'Raiganj' },
  division: { Username: 'qa-gazole', Name: 'QA Gazole', role: 'user', division_code: 'Gazole' },
  ccc: { Username: 'qa-fulbari', Name: 'QA Fulbari', role: 'user', ccc_code: '6611108' }
};
// [question, tool call]
const CALLS = [
  ['Which division has the most NSC pending?', { name: 'query_report', input: { report: 'nsc', group_by: 'division' } }],
  ['NSC pending over 30 days, by division', { name: 'query_report', input: { report: 'nsc', view: 'over_30_days', group_by: 'division' } }],
  ['NSC over 30 days in Gazole, by CCC', { name: 'query_report', input: { report: 'nsc', view: 'over_30_days', division: 'Gazole', group_by: 'ccc' } }],
  ['Pole cases in Raiganj region', { name: 'query_report', input: { report: 'nsc', view: 'pole_cases', region: 'Raiganj', group_by: 'none' } }],
  ['NSC pending in Fulbari CCC', { name: 'query_report', input: { report: 'nsc', ccc: 'Fulbari', group_by: 'none' } }],
  ['Load extensions waiting over a year, by division', { name: 'query_report', input: { report: 'load_extension', view: 'over_1_year', group_by: 'division' } }],
  ['Show Raiganj load extensions waiting over a year', { name: 'query_report', input: { report: 'load_extension', region: 'Raiganj', view: 'over_1_year', group_by: 'ccc' } }],
  ['Solar applications by region', { name: 'query_report', input: { report: 'solar', group_by: 'region' } }],
  ['PM Surya Ghar solar applications by division', { name: 'query_report', input: { report: 'solar', view: 'pm_surya_ghar', group_by: 'division' } }],
  ['Solar meter issues in Malda division', { name: 'query_report', input: { report: 'solar', view: 'meter_issue', division: 'Malda', group_by: 'ccc' } }],
  ['AT&C loss by office', { name: 'query_report', input: { report: 'loss', group_by: 'region' } }],
  ['How is AT&C loss this year compared with last March?', { name: 'query_report', input: { report: 'loss', group_by: 'none' } }],
  ['AT&C loss in Malda region by division', { name: 'query_report', input: { report: 'loss', region: 'Malda', group_by: 'division' } }],
  ['AT&C loss of the Gazole division CCCs', { name: 'query_report', input: { report: 'loss', division: 'Gazole', group_by: 'ccc' } }],
  ['AT&C loss of the Malda division CCCs', { name: 'query_report', input: { report: 'loss', division: 'Malda', group_by: 'ccc' } }],
  ['AT&C loss of the Buniadpur division CCCs', { name: 'query_report', input: { report: 'loss', division: 'Buniadpur', group_by: 'ccc' } }],
  ['AT&C loss of the Islampur division CCCs', { name: 'query_report', input: { report: 'loss', division: 'Islampur', group_by: 'ccc' } }],
  ['AT&C loss of Manikchak CCC', { name: 'query_report', input: { report: 'loss', division: 'Malda', ccc: 'Manikchak', group_by: 'none' } }],
  ['AT&C loss by region in March 2026', { name: 'query_report', input: { report: 'loss', month: '2026-03', group_by: 'region' } }],
  ['Open NSC over 30 days for Gazole', { name: 'open_report', input: { report: 'nsc', division: 'Gazole', view: 'over_30_days' } }]
];

function cookie(profile) {
  const secret = process.env.QA_JWT_SECRET || 'mzo-portal-super-secret-key-123456';
  const payload = Buffer.from(JSON.stringify({ profile, expiry: Date.now() + 6 * 3600e3 })).toString('base64');
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64');
}
// The data URL a page asks for → the snapshot file with the same bytes (manifest URLs and DataHub registry URLs).
function router(snap) {
  const man = JSON.parse(fs.readFileSync(path.join(snap, 'manifest.json'), 'utf8')).datasets;
  const idOf = (u) => { const m = /\/spreadsheets\/d\/(e\/)?([\w-]{20,})/.exec(u); return m ? m[2] : ''; };
  const sheetOf = (u) => { try { const q = new URL(u).searchParams; return q.get('gid') || q.get('sheet') || ''; } catch (_) { return ''; } };
  const table = [];
  Object.keys(man).forEach((k) => (man[k].urls || []).forEach((u) => table.push({ id: idOf(u), sheet: sheetOf(u), file: man[k].file, type: man[k].contentType })));
  const hubSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'mzo_data_hub.js'), 'utf8');
  const i = hubSrc.indexOf('const DATASETS = [');
  const reg = require('vm').runInNewContext(hubSrc.slice(i, hubSrc.indexOf('];', i) + 2).replace('const DATASETS =', 'DATASETS =') + ';DATASETS', {});
  Object.keys(man).forEach((k) => (man[k].dataHubKeys || []).forEach((h) => { const d = reg.find((x) => x.key === h); if (d && /docs\.google/.test(d.url)) table.push({ id: idOf(d.url), sheet: sheetOf(d.url), file: man[k].file, type: man[k].contentType }); }));
  const storage = { 'stock/snapshot.csv': 'stock_snapshot', 'reports/defective/summary.csv': 'defective_summary', 'reports/defective/details.csv': 'defective_details', 'reports/disconnection/snapshot.csv': 'disconnection', 'reports/pending_mc/snapshot.csv': 'pending_mc', 'reports/load_extension/snapshot.csv': 'load_extension' };
  return function (url) {
    if (/supabase\.co\/storage\/v1\/object\/public\//.test(url)) {
      const k = storage[url.split('/object/public/')[1].split('?')[0]];
      return k && man[k] ? { file: path.join(snap, man[k].file), type: 'text/csv; charset=utf-8' } : null;
    }
    if (!/docs\.google\.com|googleusercontent\.com/.test(url)) return null;
    const id = idOf(url), sheet = sheetOf(url);
    const hit = table.find((t) => t.id === id && t.sheet === sheet) || table.find((t) => t.id === id && !t.sheet) || table.find((t) => t.id === id);
    return hit ? { file: path.join(snap, hit.file), type: hit.type || 'text/csv; charset=utf-8' } : null;
  };
}

async function toolSource(base) {
  // the page as this base serves it (the old base serves the old file)
  const html = await fetch(base + '/assistant.html', { headers: { cookie: 'mzo_session=' + cookie(PROFILES.admin) } }).then((r) => r.text());
  const a = html.indexOf('    /* ---------------- data for tools ---------------- */'), b = html.indexOf('    /* ---------------- conversation ---------------- */');
  if (a < 0 || b < 0) throw new Error('tool code not found in ' + base + '/assistant.html');
  return html.slice(a, b);
}

async function run(browser, base, profile, route, src) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: 'mzo_session', value: cookie(profile), domain: new URL(base).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  const version = await fetch(base + '/version.json').then((r) => r.json()).then((j) => j.version).catch(() => '');
  await ctx.addInitScript(({ profile, version }) => {
    try { localStorage.setItem('mzo_user_profile', JSON.stringify(profile)); localStorage.setItem('mzo_authenticated', 'true'); if (version) localStorage.setItem('mzo_app_version', version); sessionStorage.removeItem('mzo_assistant_v1'); } catch (_) {}
  }, { profile, version });
  const blocked = [];
  await ctx.route('**/*', (r) => {
    const req = r.request(), url = req.url();
    if (!['GET', 'HEAD'].includes(req.method())) { blocked.push(req.method() + ' ' + url.slice(0, 80)); return r.abort('blockedbyclient'); }
    if (/script\.google(usercontent)?\.com/.test(url)) { blocked.push('apps-script'); return r.abort('blockedbyclient'); }
    const hit = route(url);
    if (hit) return r.fulfill({ status: 200, headers: { 'content-type': hit.type, 'access-control-allow-origin': '*' }, body: req.method() === 'HEAD' ? '' : fs.readFileSync(hit.file) });
    return r.continue();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  await page.goto(base + '/assistant.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.MZO_ASSISTANT_CATALOG && window.UI && document.readyState === 'complete', null, { timeout: 60000 });
  const out = await page.evaluate(async ({ src, calls }) => {
    const C = window.MZO_ASSISTANT_CATALOG, scope = window.MzoScope ? window.MzoScope.getScope() : null;
    const scopeLabel = scope && !scope.unscoped ? scope.label : '';
    const shown = [];
    const add = (v) => shown.push(v);
    // eslint-disable-next-line no-new-func
    const runTool = new Function('C', 'scope', 'scopeLabel', 'add', src + '\nreturn runTool;')(C, scope, scopeLabel, add);
    const res = [];
    for (let i = 0; i < calls.length; i++) {
      const t0 = performance.now();
      const r = await runTool(Object.assign({ id: 'qa_' + i }, calls[i]));
      let content = r.content; try { content = JSON.parse(r.content); } catch (_) {}
      res.push({ result: content, is_error: !!r.is_error, ms: Math.round(performance.now() - t0) });
    }
    return { scopeLabel, res, shown };
  }, { src, calls: CALLS.map((c) => c[1]) });
  await ctx.close();
  return Object.assign(out, { errors, blocked });
}

// Leaf differences between two JSON values: [{ path, old, new }]
function diff(a, b, p, out) {
  out = out || []; p = p || '';
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a) && a.every((x) => x && x.office) && b.every((x) => x && x.office)) { // by_office lists: match by office
      const ka = a.map((x) => x.office), kb = b.map((x) => x.office);
      if (JSON.stringify(ka) !== JSON.stringify(kb)) out.push({ path: p + '[order]', old: ka.join(', '), new: kb.join(', ') });
      new Set(ka.concat(kb)).forEach((o) => diff(a.find((x) => x.office === o), b.find((x) => x.office === o), p + '[' + o + ']', out));
      return out;
    }
    new Set(Object.keys(a).concat(Object.keys(b))).forEach((k) => diff(a[k], b[k], p + '.' + k, out));
    return out;
  }
  out.push({ path: p, old: a, new: b });
  return out;
}

(async () => {
  const pw = loadPlaywright();
  const oldBase = arg('old'), newBases = String(arg('new')).split(','), route = router(arg('snap'));
  const outDir = arg('out'); if (outDir) fs.mkdirSync(outDir, { recursive: true });
  const browser = await pw.chromium.launch({ channel: process.env.QA_CHANNEL || 'chrome', headless: true });
  const src = {};
  for (const b of [oldBase].concat(newBases)) src[b] = await toolSource(b);
  let bad = 0;
  for (const prof of String(arg('profiles', 'admin,region,ccc')).split(',')) {
    const r = {};
    for (const b of [oldBase].concat(newBases)) r[b] = await run(browser, b, PROFILES[prof], route, src[b]);
    for (const nb of newBases) {
      let calls = 0, same = 0;
      console.log(`[ask] ${prof} (${r[nb].scopeLabel || 'all offices'}): ${new URL(nb).port} vs ${new URL(oldBase).port}; console errors new ${r[nb].errors.length} / old ${r[oldBase].errors.length}; blocked ${[...new Set(r[nb].blocked)].join(', ') || 'none'}`);
      CALLS.forEach((c, i) => {
        calls++;
        const o = r[oldBase].res[i], n = r[nb].res[i];
        if (n.is_error && !o.is_error) bad++;
        const d = diff(o.result, n.result);
        if (!d.length && o.is_error === n.is_error) { same++; return; }
        console.log(`  Q${i + 1} ${c[0]} ${JSON.stringify(c[1].input)}: ${d.length} values differ${n.is_error ? ' (new is an error: ' + JSON.stringify(n.result) + ')' : ''}`);
        d.slice(0, 14).forEach((x) => console.log(`      ${x.path}: ${JSON.stringify(x.old)} → ${JSON.stringify(x.new)}`));
        if (d.length > 14) console.log(`      … ${d.length - 14} more`);
      });
      console.log(`  ${same} of ${calls} tool results identical`);
    }
    if (outDir) fs.writeFileSync(path.join(outDir, `ask-${prof}.json`), JSON.stringify({ calls: CALLS, runs: r }, null, 1));
  }
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
