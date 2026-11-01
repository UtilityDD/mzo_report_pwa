#!/usr/bin/env node
/* Browser parity and timing for pages converted to MzoRows.
 *
 *   node scripts/qa/uniform-pages.js parity --old <baseUrl> --new <baseUrl>[,<baseUrl>…] --snap <dir> [--pages solar,nsc] [--out <dir>]
 *        [--profiles admin,division,region,ccc] [--theme light|dark] [--width 390]
 *   node scripts/qa/uniform-pages.js timing --old <baseUrl> --new <baseUrl> [--snap <dir>] [--runs 3] [--cpu 4]
 *
 * parity: every page is opened on each base with the same data (Google and Supabase Storage
 * requests are answered from the snapshot folder), as admin and as a division user. It records
 * what the page shows (stat cards, facet counts, level tabs, table rows and totals, the as-on
 * date) on load, after each stat card, each analysis tab, each drill level (first row opened at
 * every level) and each deep link, and compares the old base with every new base. A page entry can
 * also name its own selectors (ready, asOn, drill, list), selects to step through, and hist bars
 * are clicked one by one; every table on the page and an open drawer are recorded.
 * timing: first data paint (stat values and a real table row on screen), cold (empty storage)
 * and warm (second load), median of --runs, live sources unless --snap is given.
 *
 * Safety: every request that is not GET/HEAD is aborted, and Apps Script is never called.
 * Session: the forged local test cookie (JWT secret: env QA_JWT_SECRET or the dev fallback).
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
  division: { Username: 'qa-gazole', Name: 'QA Gazole', role: 'user', division_code: 'Gazole' },
  region: { Username: 'qa-raiganj', Name: 'QA Raiganj', role: 'user', region_code: 'Raiganj' },
  ccc: { Username: 'qa-fulbari', Name: 'QA Fulbari', role: 'user', ccc_code: '6611108' }
};
function cookie(profile) {
  const secret = process.env.QA_JWT_SECRET || 'mzo-portal-super-secret-key-123456';
  const payload = Buffer.from(JSON.stringify({ profile, expiry: Date.now() + 6 * 3600e3 })).toString('base64');
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64');
}

// Page scripts: what to click. Deep links are relative query strings.
const PAGES = {
  solar: {
    url: 'solar.html', key: 'solar_connections', stats: '#stats .ui-stat', tabs: '#drill .ui-drill-tab',
    deep: ['?region=Raiganj', '?division=Gazole', '?ccc=Kaliyaganj', '?status=pending', '?status=issue', '?scheme=WBREDA', '?q=3004463846', '?region=Malda&status=done']
  },
  nsc: {
    url: 'nsc.html', key: 'nsc_pending', stats: '#kpis .ui-stat', tabs: '#tabs .ui-drill-tab',
    deep: ['?region=Raiganj', '?division=Gazole', '?ccc=Kaliyaganj', '?q=6000188039', '?kpi=delay30', '?kpi=pole', '?kpi=nonpole', '?kpi=withheld', '?kpi=ind', '?kpi=procb', '?kpi=com3', '?followups=1']
  },
  // Batch C (wave-c): pages with their own table ids; hist bars are clicked too (hists: true)
  consumer: {
    url: 'consumer/consumer.html', key: 'consumers', stats: '.ui-stats .ui-stat', tabs: '#none', asOn: '#meta', ready: '#pivot tbody tr td:not([colspan])',
    drill: '#pivot tbody tr.click', hists: true, deep: [],
    selects: { rowDim: ['_region', '_divn', '_supp', 'CONN_STAT', 'BASE_CLASS', 'CONN_PHASE', 'CATEGORY', 'GOVT_STAT', 'TYPE_OF_METER', 'CONN_BY', 'TIME_OF_DAY'], colDim: ['CONN_STAT', 'BASE_CLASS', 'CONN_PHASE', 'TYPE_OF_METER'], f_CONN_STAT: ['LIVE'], f_BASE_CLASS: ['D', 'A'], f_GOVT_STAT: ['YES'] }
  }
};

// Snapshot routing: the data URL a page asks for → the snapshot file with the same bytes.
function router(snap) {
  if (!snap) return null;
  const man = JSON.parse(fs.readFileSync(path.join(snap, 'manifest.json'), 'utf8')).datasets;
  const idOf = (u) => { const m = /\/spreadsheets\/d\/(e\/)?([\w-]{20,})/.exec(u); return m ? m[2] : ''; };
  const sheetOf = (u) => { try { const q = new URL(u).searchParams; return q.get('gid') || q.get('sheet') || ''; } catch (_) { return ''; } };
  const table = [];
  Object.keys(man).forEach((k) => (man[k].urls || []).forEach((u) => table.push({ key: k, id: idOf(u), sheet: sheetOf(u), file: man[k].file, type: man[k].contentType })));
  const storage = { 'stock/snapshot.csv': 'stock_snapshot', 'reports/defective/summary.csv': 'defective_summary', 'reports/defective/details.csv': 'defective_details', 'reports/disconnection/snapshot.csv': 'disconnection', 'reports/pending_mc/snapshot.csv': 'pending_mc', 'reports/load_extension/snapshot.csv': 'load_extension' };
  return function (url) {
    if (/supabase\.co\/storage\/v1\/object\/public\//.test(url)) {
      const p = url.split('/object/public/')[1].split('?')[0];
      const k = storage[p];
      return k && man[k] ? { file: path.join(snap, man[k].file), type: 'text/csv; charset=utf-8' } : null;
    }
    if (!/docs\.google\.com|googleusercontent\.com/.test(url)) return null;
    if (/[?&]range=/.test(url)) return null; // two-row peeks stay live
    const id = idOf(url), sheet = sheetOf(url);
    const hit = table.find((t) => t.id === id && t.sheet === sheet) || table.find((t) => t.id === id && !t.sheet) || table.find((t) => t.id === id);
    return hit ? { file: path.join(snap, hit.file), type: hit.type || 'text/csv; charset=utf-8' } : null;
  };
}

async function newContext(browser, base, profile, route, opts) {
  opts = opts || {};
  const width = Number(opts.width || 1280);
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 1, isMobile: false });
  await ctx.addCookies([{ name: 'mzo_session', value: cookie(profile), domain: new URL(base).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  const version = await fetch(base + '/version.json').then((r) => r.json()).then((j) => j.version).catch(() => '');
  await ctx.addInitScript(({ profile, version, ready, theme }) => {
    try {
      localStorage.setItem('mzo_user_profile', JSON.stringify(profile)); localStorage.setItem('mzo_authenticated', 'true'); if (version) localStorage.setItem('mzo_app_version', version);
      if (theme) ['theme', 'mzo_theme', 'collectionDashboardTheme'].forEach((k) => localStorage.setItem(k, theme));
    } catch (_) {}
    window.__fdp = null;
    const t = () => {
      if (window.__fdp != null) return;
      const vs = document.querySelectorAll('.ui-stat .v');
      const row = document.querySelector(ready || '#table tbody tr td:not([colspan])');
      const empty = document.querySelector((ready || '#table tbody tr td:not([colspan])').split(' tbody')[0] + ' tbody .ui-empty');
      const shown = row || (empty && !/loading/i.test(empty.textContent)); // a real row, or a real "nothing matches"
      if (vs.length && ![].some.call(vs, (v) => v.querySelector('.ui-skel') || !/\d/.test(v.textContent)) && shown) { window.__fdp = performance.now(); window.__fdpRow = !!row; return; }
      requestAnimationFrame(t);
    };
    requestAnimationFrame(t);
  }, { profile, version, ready: opts.ready || '', theme: opts.theme || '' });
  const stats = { requests: 0, bytes: {}, blocked: [] };
  await ctx.route('**/*', async (r) => {
    const req = r.request(), url = req.url();
    if (!['GET', 'HEAD'].includes(req.method())) { stats.blocked.push(req.method() + ' ' + url.slice(0, 120)); return r.abort('blockedbyclient'); }
    if (/script\.google(usercontent)?\.com/.test(url)) { stats.blocked.push('apps-script ' + url.slice(0, 60)); return r.abort('blockedbyclient'); }
    const hit = route && route(url);
    if (hit) return r.fulfill({ status: 200, headers: { 'content-type': hit.type, 'access-control-allow-origin': '*' }, body: req.method() === 'HEAD' ? '' : fs.readFileSync(hit.file) });
    return r.continue();
  });
  if (opts.cpu) ctx.__cpu = opts.cpu;
  ctx.__stats = stats;
  return ctx;
}

async function settle(page, ms) {
  await page.waitForFunction(() => window.__fdp != null, null, { timeout: ms || 120000 }).catch(() => {});
  await page.waitForTimeout(600);
}

function snapshot(cfg) {
  cfg = cfg || {};
  const txt = (el) => (el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const out = { asOn: txt(document.querySelector(cfg.asOn || '#asOn')) };
  out.stats = [].map.call(document.querySelectorAll('.ui-stat'), (s) => [txt(s.querySelector('.k')), txt(s.querySelector('.v')), txt(s.querySelector('.s')), s.getAttribute('aria-pressed')]);
  out.facets = [].map.call(document.querySelectorAll('.ui-opts'), (g) => (g.id || '') + ':' + [].map.call(g.querySelectorAll('.ui-opt'), (o) => txt(o.querySelector('span')) + '=' + txt(o.querySelector('small')) + (o.getAttribute('aria-checked') === 'true' ? '*' : '')).join('|'));
  out.tabs = [].map.call(document.querySelectorAll('.ui-drill-tab'), (t) => txt(t) + (t.getAttribute('aria-selected') === 'true' ? '*' : ''));
  out.trail = txt(document.querySelector('.ui-trail nav'));
  out.hint = txt(document.getElementById('hint'));
  const t = document.querySelector('#table table');
  if (t) {
    out.head = [].map.call(t.querySelectorAll('thead th'), txt);
    const rows = [].slice.call(t.tBodies[0] ? t.tBodies[0].rows : []);
    out.rows = rows.length;
    out.first = rows.slice(0, 8).map((r) => [].map.call(r.cells, txt).join(' | '));
    out.foot = t.tFoot ? txt(t.tFoot) : '';
  }
  out.footer = txt(document.querySelector('#table .ui-panel-f span'));
  out.selects = [].map.call(document.querySelectorAll('.ui-side select'), (s) => s.id + '=' + s.value + '/' + s.options.length + (s.disabled ? ' locked' : ''));
  if (cfg.generic) {
    // every select, every table (by its container id), every hist, every plain stat value, an open drawer
    out.selects = [].map.call(document.querySelectorAll('select'), (s) => s.id + '=' + s.value + '/' + [].map.call(s.options, (o) => o.value).join(',') + (s.disabled ? ' locked' : ''));
    out.tables = {};
    [].forEach.call(document.querySelectorAll('main table.ui-table'), (tb) => {
      const host = tb.closest('[id]'), id = host ? host.id : '?';
      const rows = [].slice.call(tb.tBodies[0] ? tb.tBodies[0].rows : []);
      const pf = host && host.querySelector('.ui-panel-f span');
      out.tables[id] = { head: [].map.call(tb.querySelectorAll('thead th'), txt), rows: rows.length, first: rows.slice(0, 8).map((r) => [].map.call(r.cells, txt).join(' | ')), foot: tb.tFoot ? txt(tb.tFoot) : '', more: txt(pf) };
    });
    out.hists = [].map.call(document.querySelectorAll('main .ui-hist'), (h) => (h.id || '') + ':' + [].map.call(h.querySelectorAll('.row'), (r) => [].map.call(r.querySelectorAll('span'), txt).join('=') + (r.classList.contains('on') ? '*' : '')).join('|'));
    out.values = [].map.call(document.querySelectorAll('main [id]'), (e) => e).filter((e) => !e.children.length && /^(s[A-Z]|c[A-Z]|listCount|appCount|meta)/.test(e.id)).map((e) => e.id + '=' + txt(e));
    const dr = document.querySelector('#ui-drawer:not([hidden])');
    out.drawer = dr ? txt(dr).slice(0, 1500) : '';
    out.clear = !!(document.getElementById('clearBtn') && !document.getElementById('clearBtn').hidden);
  }
  return out;
}

async function walk(page, cfg, base) {
  const states = {};
  const scfg = { asOn: cfg.asOn, generic: !!cfg.ready };
  const shot = async (label) => { await page.waitForTimeout(150); states[label] = await page.evaluate(snapshot, scfg); };
  await page.goto(base + '/' + cfg.url, { waitUntil: 'domcontentloaded' });
  await settle(page);
  if (cfg.settle) await page.waitForTimeout(cfg.settle);
  await shot('load');
  // where the rows came from (not compared): MzoRows timings per dataset (fetch/build/where)
  states.__rows = await page.evaluate(() => (window.MzoRows ? JSON.parse(JSON.stringify(window.MzoRows.last)) : null));
  // stat cards (each toggles a filter; click again to clear)
  const nStats = await page.locator(cfg.stats).count();
  for (let i = 0; i < nStats; i++) {
    await page.locator(cfg.stats).nth(i).click();
    await shot('stat#' + i);
    await page.locator(cfg.stats).nth(i).click();
  }
  // every analysis / level tab
  const nTabs = await page.locator(cfg.tabs).count();
  for (let i = 0; i < nTabs; i++) {
    const tab = page.locator(cfg.tabs).nth(i);
    const label = (await tab.getAttribute('data-t')) || (await tab.getAttribute('data-k')) || ((await tab.textContent()) + '#' + i);
    await tab.click();
    await shot('tab:' + label);
  }
  // hist bars (each toggles a filter; click again to clear)
  if (cfg.hists) {
    // bars by (hist id, label): a click re-renders the other hists, so indexes move
    const bars = await page.evaluate(() => [].map.call(document.querySelectorAll('main .ui-hist .row.click'), (r) => ({ host: (r.closest('.ui-hist') || {}).id || '', label: (r.querySelector('span') || {}).textContent || '' })));
    const find = (b) => page.locator('#' + b.host + ' .row.click').filter({ has: page.locator('span:first-child', { hasText: b.label }) }).first();
    for (const b of bars) {
      if (!b.host || !(await find(b).count())) continue;
      await find(b).click();
      await shot('hist:' + b.host + ':' + b.label.slice(0, 30));
      if (await find(b).count()) await find(b).click();
    }
  }
  // selects: each listed value, then back to the first
  for (const [id, values] of Object.entries(cfg.selects || {})) {
    const sel = page.locator('#' + id);
    if (!(await sel.count()) || await sel.isDisabled()) continue;
    const first = await sel.inputValue();
    for (const v of values) {
      const has = await sel.evaluate((s, v) => [].some.call(s.options, (o) => o.value === v), v);
      if (!has) continue;
      await sel.selectOption(v);
      await shot('select:' + id + '=' + v);
    }
    await sel.selectOption(first);
  }
  // the first rows of the detail list open a drawer
  if (cfg.list) {
    for (let i = 0; i < 3; i++) {
      const row = page.locator(cfg.list).nth(i);
      if (!(await row.count())) break;
      await row.click();
      await shot('list#' + i);
      if (await page.locator('#ui-drawer:not([hidden])').count()) await page.keyboard.press('Escape');
    }
  }
  // drill: back to the first tab, then open the first row at every level down to the list
  if (await page.locator(cfg.tabs).count()) await page.locator(cfg.tabs).first().click();
  for (let level = 0; level < 4; level++) {
    const row = page.locator(cfg.drill || '#table tbody tr.click').first();
    if (!(await row.count())) break;
    const name = ((await row.locator('td').first().textContent()) || '').trim();
    await row.click();
    await shot('drill' + level + ':' + name.slice(0, 30));
    if (await page.locator('#ui-drawer:not([hidden])').count()) { await page.keyboard.press('Escape'); break; }
  }
  for (const q of cfg.deep || []) {
    await page.goto(base + '/' + cfg.url + q, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await shot('deep' + q);
  }
  return states;
}

function diffStates(a, b) {
  const out = [];
  Object.keys(Object.assign({}, a, b)).forEach((k) => {
    if (k.indexOf('__') === 0) return;
    const x = a[k], y = b[k];
    if (!x || !y) { out.push({ state: k, field: '*', old: !!x, new: !!y }); return; }
    Object.keys(Object.assign({}, x, y)).forEach((f) => { if (JSON.stringify(x[f]) !== JSON.stringify(y[f])) out.push({ state: k, field: f, old: x[f], new: y[f] }); });
  });
  return out;
}

async function parity(pw) {
  const oldBase = arg('old'), newBases = String(arg('new')).split(','), snap = arg('snap');
  const pages = String(arg('pages', Object.keys(PAGES).join(','))).split(',');
  const outDir = arg('out', path.join(process.cwd(), 'uniform-parity'));
  fs.mkdirSync(outDir, { recursive: true });
  const route = router(snap);
  const profiles = String(arg('profiles', 'admin,division')).split(',');
  const look = { theme: arg('theme', ''), width: arg('width', '') };
  const tag = (look.theme ? '-' + look.theme : '') + (look.width ? '-w' + look.width : '');
  const browser = await pw.chromium.launch({ channel: process.env.QA_CHANNEL || 'chrome', headless: true });
  const summary = [];
  for (const p of pages) {
    for (const prof of profiles) {
      const runs = {};
      for (const base of [oldBase].concat(newBases)) {
        const ctx = await newContext(browser, base, PROFILES[prof], route, Object.assign({ ready: PAGES[p].ready }, look));
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
        runs[base] = { states: await walk(page, PAGES[p], base), errors, blocked: ctx.__stats.blocked };
        await ctx.close();
      }
      const old = runs[oldBase];
      for (const nb of newBases) {
        const d = diffStates(old.states, runs[nb].states);
        summary.push({ page: p, profile: prof, base: nb, theme: look.theme, width: look.width, rows: runs[nb].states.__rows, states: Object.keys(old.states).filter((k) => k.indexOf('__')).length, differences: d.length, errors: runs[nb].errors.length, oldErrors: old.errors.length });
        fs.writeFileSync(path.join(outDir, `${p}-${prof}-${new URL(nb).port}${tag}.json`), JSON.stringify({ old: oldBase, new: nb, differences: d, oldStates: old.states, newStates: runs[nb].states, errors: runs[nb].errors, oldErrorsList: old.errors, blocked: runs[nb].blocked }, null, 1));
        console.log(`[parity] ${p} as ${prof}${tag}: ${new URL(nb).port} vs ${new URL(oldBase).port}: ${Object.keys(old.states).filter((k) => k.indexOf('__')).length} states, ${d.length} differences, console errors new ${runs[nb].errors.length} / old ${old.errors.length}`);
        d.slice(0, 12).forEach((x) => console.log(`    ${x.state} · ${x.field}: ${JSON.stringify(x.old).slice(0, 160)}  →  ${JSON.stringify(x.new).slice(0, 160)}`));
        if (runs[nb].states.__rows) console.log('    rows: ' + JSON.stringify(runs[nb].states.__rows).slice(0, 300));
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'summary' + tag + '.json'), JSON.stringify(summary, null, 1));
  await browser.close();
}

async function timing(pw) {
  const bases = { old: arg('old'), new: arg('new') };
  const runsN = Number(arg('runs', 3)), cpu = Number(arg('cpu', 1));
  const route = router(arg('snap'));
  const pages = String(arg('pages', Object.keys(PAGES).join(','))).split(',');
  const browser = await pw.chromium.launch({ channel: process.env.QA_CHANNEL || 'chrome', headless: true });
  const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor((s.length - 1) / 2)]) : null; };
  const rows = [];
  for (const p of pages) {
    for (const which of ['old', 'new']) {
      const cold = [], warm = [], bytes = [];
      for (let i = 0; i < runsN; i++) {
        const ctx = await newContext(browser, bases[which], PROFILES.admin, route, { ready: PAGES[p].ready });
        const page = await ctx.newPage();
        if (cpu > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu }); }
        let got = 0;
        page.on('response', async (res) => { try { const u = res.url(); if (/docs\.google|supabase\.co|\/api\/data\/|\/api\/nsc\//.test(u)) { const s = await res.request().sizes(); got += s.responseBodySize || 0; } } catch (_) {} });
        for (const pass of ['cold', 'warm']) {
          await page.goto(bases[which] + '/' + PAGES[p].url, { waitUntil: 'domcontentloaded' });
          await page.waitForFunction(() => window.__fdp != null, null, { timeout: 180000 }).catch(() => {});
          const ms = await page.evaluate(() => window.__fdp);
          (pass === 'cold' ? cold : warm).push(ms);
          if (pass === 'cold') { bytes.push(got); await page.waitForTimeout(2500); } // let background checks finish
        }
        await ctx.close();
      }
      rows.push({ page: p, which, base: bases[which], cold: med(cold), warm: med(warm), coldAll: cold.map(Math.round), warmAll: warm.map(Math.round), dataBytes: med(bytes) });
      console.log(`[timing] ${p} ${which}: first data paint cold ${med(cold)} ms, warm ${med(warm)} ms (runs ${cold.map(Math.round).join('/')} · ${warm.map(Math.round).join('/')}), data bytes ${med(bytes)}${cpu > 1 ? ', cpu x' + cpu : ''}`);
    }
  }
  await browser.close();
  const out = arg('out');
  if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 1));
}

(async () => {
  const pw = loadPlaywright();
  if (process.argv[2] === 'parity') await parity(pw);
  else if (process.argv[2] === 'timing') await timing(pw);
  else { console.error('usage: uniform-pages.js parity|timing …'); process.exit(2); }
})().catch((e) => { console.error(e); process.exit(1); });
