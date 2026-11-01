#!/usr/bin/env node
/* sheet_links.html in the browser: the whole table (sheet, link, "Updated"), old base vs new bases.
 *
 *   node scripts/qa/sheet-links-pages.js --old <baseUrl> --new <baseUrl>[,<baseUrl>…] --snap <dir>
 *        [--profiles admin,region,ccc] [--runs 3] [--jitter 1500] [--out <dir>]
 *
 * Every base is opened --runs times per login in a fresh browser (cold), and once more in the same
 * browser (warm: the device now has stored versions and cached rows). Google and Supabase Storage
 * requests are answered from the snapshot folder; with --jitter every API and data response is
 * delayed by a random 0…jitter ms, so requests finish in a different order on every run. A run is
 * done when the network has been quiet for 2 s. It prints, per base, the distinct "Updated" columns
 * the runs produced (one = deterministic), and the rows that differ from the old base.
 *
 * Safety: every request that is not GET/HEAD is aborted, and Apps Script is never called.
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
// sheet_links is for admins and logins with the sheets-autho flag
const PROFILES = {
  admin: { Username: 'local-preview', Name: 'Local Preview', role: 'admin', office_level: 'CE' },
  region: { Username: 'qa-raiganj', Name: 'QA Raiganj', role: 'user', region_code: 'Raiganj', 'sheets-autho': 'list' },
  ccc: { Username: 'qa-fulbari', Name: 'QA Fulbari', role: 'user', ccc_code: '6611108', 'sheets-autho': 'list' }
};
function cookie(profile) {
  const secret = process.env.QA_JWT_SECRET || 'mzo-portal-super-secret-key-123456';
  const payload = Buffer.from(JSON.stringify({ profile, expiry: Date.now() + 6 * 3600e3 })).toString('base64');
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64');
}
// The data URL a page asks for → the snapshot file with the same bytes (as uniform-pages.js).
function router(snap) {
  const man = JSON.parse(fs.readFileSync(path.join(snap, 'manifest.json'), 'utf8')).datasets;
  const idOf = (u) => { const m = /\/spreadsheets\/d\/(e\/)?([\w-]{20,})/.exec(u); return m ? m[2] : ''; };
  const sheetOf = (u) => { try { const q = new URL(u).searchParams; return q.get('gid') || q.get('sheet') || ''; } catch (_) { return ''; } };
  const table = [];
  Object.keys(man).forEach((k) => (man[k].urls || []).forEach((u) => table.push({ key: k, id: idOf(u), sheet: sheetOf(u), file: man[k].file, type: man[k].contentType })));
  // the DataHub registry URL of a dataset whose snapshot came from elsewhere (Storage): the old page fetched it directly
  const hubSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'mzo_data_hub.js'), 'utf8');
  const reg = require('vm').runInNewContext(hubSrc.slice(hubSrc.indexOf('const DATASETS = ['), hubSrc.indexOf('];', hubSrc.indexOf('const DATASETS = [')) + 2).replace('const DATASETS =', 'DATASETS =') + ';DATASETS', {});
  Object.keys(man).forEach((k) => (man[k].dataHubKeys || []).forEach((h) => { const d = reg.find((x) => x.key === h); if (d && /docs\.google/.test(d.url)) table.push({ key: k, id: idOf(d.url), sheet: sheetOf(d.url), file: man[k].file, type: man[k].contentType }); }));
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

async function open(browser, base, profile, route, jitter) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: 'mzo_session', value: cookie(profile), domain: new URL(base).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  const version = await fetch(base + '/version.json').then((r) => r.json()).then((j) => j.version).catch(() => '');
  await ctx.addInitScript(({ profile, version }) => {
    try { localStorage.setItem('mzo_user_profile', JSON.stringify(profile)); localStorage.setItem('mzo_authenticated', 'true'); if (version) localStorage.setItem('mzo_app_version', version); } catch (_) {}
  }, { profile, version });
  const state = { inflight: 0, last: Date.now(), blocked: [], live: [] };
  ctx.on('request', () => { state.inflight++; state.last = Date.now(); });
  const done = () => { state.inflight--; state.last = Date.now(); };
  ctx.on('requestfinished', done); ctx.on('requestfailed', done);
  await ctx.route('**/*', async (r) => {
    const req = r.request(), url = req.url();
    if (!['GET', 'HEAD'].includes(req.method())) { state.blocked.push(req.method() + ' ' + url.slice(0, 100)); return r.abort('blockedbyclient'); }
    if (/script\.google(usercontent)?\.com/.test(url)) { state.blocked.push('apps-script'); return r.abort('blockedbyclient'); }
    if (jitter && /\/api\/|docs\.google|supabase\.co|\/schema\//.test(url)) await new Promise((res) => setTimeout(res, Math.random() * jitter));
    const hit = route(url);
    if (hit) return r.fulfill({ status: 200, headers: { 'content-type': hit.type, 'access-control-allow-origin': '*' }, body: req.method() === 'HEAD' ? '' : fs.readFileSync(hit.file) });
    if (/docs\.google|supabase\.co/.test(url)) state.live.push(url.slice(0, 110));
    return r.continue();
  });
  return { ctx, state };
}
async function quiet(page, state) {
  for (let i = 0; i < 600; i++) { if (!state.inflight && Date.now() - state.last > 2000) break; await page.waitForTimeout(100); }
  await page.waitForTimeout(300);
}
const table = () => [].map.call(document.querySelectorAll('#rows tr'), (tr) => {
  const a = tr.querySelector('a.name');
  return { name: a.textContent, href: a.getAttribute('href'), updated: tr.querySelector('.when').textContent };
});

(async () => {
  const pw = loadPlaywright();
  const oldBase = arg('old'), newBases = String(arg('new')).split(','), route = router(arg('snap'));
  const runs = Number(arg('runs', 3)), jitter = Number(arg('jitter', 0));
  const outDir = arg('out'); if (outDir) fs.mkdirSync(outDir, { recursive: true });
  const browser = await pw.chromium.launch({ channel: process.env.QA_CHANNEL || 'chrome', headless: true });
  let unexplained = 0;
  for (const prof of String(arg('profiles', 'admin,region,ccc')).split(',')) {
    const res = {};
    for (const base of [oldBase].concat(newBases)) {
      res[base] = { cold: [], warm: [], errors: [] };
      for (let i = 0; i < runs; i++) {
        const { ctx, state } = await open(browser, base, PROFILES[prof], route, jitter);
        const page = await ctx.newPage();
        page.on('pageerror', (e) => res[base].errors.push(String(e.message || e).slice(0, 160)));
        page.on('console', (m) => { if (m.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT/.test(m.text())) res[base].errors.push(m.text().slice(0, 160)); });
        await page.goto(base + '/sheet_links.html', { waitUntil: 'domcontentloaded' });
        await quiet(page, state);
        res[base].cold.push(await page.evaluate(table));
        if (state.live.length) res[base].live = [...new Set((res[base].live || []).concat(state.live))];
        if (i === 0) { // warm: the same browser again
          await page.goto(base + '/sheet_links.html', { waitUntil: 'domcontentloaded' });
          await quiet(page, state);
          res[base].warm.push(await page.evaluate(table));
        }
        await ctx.close();
      }
    }
    const key = (t) => JSON.stringify(t);
    for (const base of [oldBase].concat(newBases)) {
      const distinct = [...new Set(res[base].cold.map(key))];
      console.log(`[sheet_links] ${prof} ${new URL(base).port}: ${res[base].cold[0].length} rows; ${runs} cold runs → ${distinct.length} distinct "Updated" column${distinct.length === 1 ? ' (deterministic)' : 's'}; console errors ${res[base].errors.length}; live (unrouted) data requests ${(res[base].live || []).length}`);
      (res[base].live || []).forEach((u) => console.log('    live: ' + u));
      if (distinct.length > 1) {
        const all = res[base].cold;
        all[0].forEach((r, i) => { const vals = [...new Set(all.map((t) => t[i] && t[i].updated))]; if (vals.length > 1) console.log(`    varies: ${r.name}: ${vals.join(' | ')}`); });
      }
    }
    for (const nb of newBases) {
      for (const pass of ['cold', 'warm']) {
        const a = res[oldBase][pass][0], b = res[nb][pass][0];
        const d = [];
        const n = Math.max(a.length, b.length);
        for (let i = 0; i < n; i++) if (key(a[i]) !== key(b[i])) d.push({ old: a[i], new: b[i] });
        // the old page's other runs: a difference that one of them also shows is the old page's race
        const oldVals = (i) => [...new Set(res[oldBase][pass].map((t) => t[i] && t[i].updated))];
        console.log(`  ${prof} ${pass} ${new URL(nb).port} vs ${new URL(oldBase).port}: ${d.length} rows differ`);
        d.forEach((x) => {
          const i = a.indexOf(x.old);
          console.log(`    ${(x.old || x.new).name}: old ${JSON.stringify(x.old && x.old.updated)}${oldVals(i).length > 1 ? ' (old runs: ' + oldVals(i).join(' | ') + ')' : ''} → new ${JSON.stringify(x.new && x.new.updated)}${x.old && x.new && x.old.href !== x.new.href ? ' LINK DIFFERS' : ''}`);
        });
      }
    }
    if (outDir) fs.writeFileSync(path.join(outDir, `sheet_links-${prof}.json`), JSON.stringify(res, null, 1));
  }
  await browser.close();
  process.exit(unexplained ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
