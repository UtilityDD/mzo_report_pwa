#!/usr/bin/env node
// Wave B (revenue pages) variant of uniform-pages.js, kept as merged on 2026-11-01; unify with uniform-pages.js later.
/* Browser parity and timing for pages converted to MzoRows.
 *
 *   node scripts/qa/uniform-pages.js parity --old <baseUrl> --new <baseUrl>[,<baseUrl>…] --snap <dir> [--pages solar,nsc] [--out <dir>]
 *                                           [--profiles admin,division,region,ccc] [--theme light|dark] [--width 390]
 *   node scripts/qa/uniform-pages.js timing --old <baseUrl> --new <baseUrl> [--snap <dir>] [--runs 3] [--cpu 4]
 *
 * parity: every page is opened on each base with the same data (Google and Supabase Storage
 * requests are answered from the snapshot folder), as admin and as a division user. It records
 * what the page shows (stat cards, facet counts, level tabs, table rows and totals, the as-on
 * date) on load, after each stat card, each analysis tab, each drill level (first row opened at
 * every level) and each deep link, and compares the old base with every new base. Every table,
 * histogram, line chart (series sums), select and the page's header texts are recorded too, and a
 * page can add its own steps (selects, segmented controls, drawers).
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

// Page scripts: what to click. Deep links are relative query strings. drillTable: the table opened
// level by level (default #table); fdp: the tables whose first row marks the first data paint.
const PAGES = {
  solar: {
    url: 'solar.html', key: 'solar_connections', stats: '#stats .ui-stat', tabs: '#drill .ui-drill-tab',
    deep: ['?region=Raiganj', '?division=Gazole', '?ccc=Kaliyaganj', '?status=pending', '?status=issue', '?scheme=WBREDA', '?q=3004463846', '?region=Malda&status=done']
  },
  nsc: {
    url: 'nsc.html', key: 'nsc_pending', stats: '#kpis .ui-stat', tabs: '#tabs .ui-drill-tab',
    deep: ['?region=Raiganj', '?division=Gazole', '?ccc=Kaliyaganj', '?q=6000188039', '?kpi=delay30', '?kpi=pole', '?kpi=nonpole', '?kpi=withheld', '?kpi=ind', '?kpi=procb', '?kpi=com3', '?followups=1']
  },
  // Batch B (Revenue). steps(page, shot, h): extra clicks after the generic walk; h has selectAll / clickAll.
  loss: {
    url: 'loss.html', key: 'loss_report', stats: '#stats .ui-stat-none', tabs: '#metric button', drillTable: '#offices',
    texts: ['meta', 'trendTitle', 'tableTitle'],
    steps: async (page, shot, h) => {
      await h.selectAll('period', 6);
      await h.selectAll('regionFilter');
      await page.selectOption('#regionFilter', 'Malda').catch(() => {});
      await h.selectAll('divisionFilter');
      await page.selectOption('#divisionFilter', 'Malda').catch(() => {});
      await h.selectAll('cccFilter');
    },
    deep: ['?region=Raiganj', '?division=Gazole', '?ccc=Manikchak', '?ccc=MATHURAPUR', '?region=U/Dinajpur%20Region', '?division=Islampur%20Division&ccc=Goalpokher']
  },
  collection: {
    url: 'collection.html', key: 'collection_report', stats: '#stats-none', tabs: '#levelTabs .ui-tab', drillTable: '#officeTable',
    texts: ['meta', 'kFy', 'kMonth', 'kDay', 'trendTitle', 'tableTitle'],
    steps: async (page, shot, h) => {
      await h.clickAll('#scale button', 'scale');
      await h.clickAll('#bulk button', 'bulk');
      for (const d of ['1', '15', '31']) await h.pick('upto', d);
      await h.selectAll('regionFilter');
      await h.pick('regionFilter', 'Malda');
      await h.selectAll('divisionFilter');
      await h.pick('divisionFilter', 'Gazole');
      await h.selectAll('cccFilter');
    },
    deep: ['?division=Gazole', '?division=raiganj', '?division=Nowhere']
  },
  theft: {
    url: 'theft_assessment.html', key: 'theft_assessment', stats: '#stats .ui-stat', tabs: '#levelTabs .ui-tab', drillTable: '#officeTable',
    texts: ['meta', 'caseCount'],
    steps: async (page, shot, h) => {
      await h.selectAll('yearFilter', 8);
      await h.selectAll('statusFilter');
      await h.clickAll('#cutHist .row', 'cut');
      await h.clickAll('#yearHist .row', 'years');
      await h.open('#caseTable tbody tr.click', 'case');
      await h.search('q', '850149075');
    },
    deep: []
  },
  remosd: {
    url: 'remosd5000.html', key: 'rem_osd', stats: '#stats .ui-stat', tabs: '#levelTabs .ui-tab', drillTable: '#officeTable',
    texts: ['meta', 'trendTitle', 'tableTitle'],
    steps: async (page, shot, h) => {
      await h.clickAll('#metric button', 'metric');
      await h.selectAll('dateFilter', 8);
      await h.selectAll('regionFilter');
      await h.pick('regionFilter', 'Raiganj');
      await h.selectAll('divisionFilter');
    },
    deep: []
  },
  defaulters: {
    url: 'rem/defaulters.html', key: 'rem_defaulters_dom', stats: '#stats .ui-stat', tabs: '#levelTabs .ui-tab', drillTable: '#officeTable',
    texts: ['meta', 'count'],
    steps: async (page, shot, h) => {
      await h.selectAll('classFilter');
      await h.selectAll('tagFilter');
      await h.clickAll('#payHist .row', 'pay');
      await h.clickAll('#osdHist .row', 'osd');
      await h.open('#table tbody tr.click', 'consumer');
      await h.search('q', 'school');
    },
    deep: []
  },
  disconnection: {
    url: 'disconnection.html', key: 'disconnection', stats: '#stats .ui-stat', tabs: '#drill .ui-drill-tab', fdp: '#table, #followTable',
    texts: ['asOn', 'base'],
    steps: async (page, shot, h) => {
      await h.clickAll('#fOsd .ui-opt', 'osd');
      await h.clickAll('#fClass .ui-opt', 'class');
      await h.search('q', 'KUMAR');
    },
    deep: ['?region=Raiganj', '?division=Gazole', '?ccc=Kaliyaganj', '?status=noAction', '?status=disconnected', '?status=partiallyPaid', '?status=Fully%20Paid', '?followups=1', '?region=Malda&status=disconnected', '?ccc=Fulbari&followups=1']
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
  const ctx = await browser.newContext({ viewport: { width: Number(arg('width', 1280)), height: 900 } });
  await ctx.addCookies([{ name: 'mzo_session', value: cookie(profile), domain: new URL(base).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  const version = await fetch(base + '/version.json').then((r) => r.json()).then((j) => j.version).catch(() => '');
  const theme = arg('theme', '');
  const fdpTable = (opts && opts.table) || '#table';
  await ctx.addInitScript(({ profile, version, theme, fdpTable }) => {
    try { localStorage.setItem('mzo_user_profile', JSON.stringify(profile)); localStorage.setItem('mzo_authenticated', 'true'); if (version) localStorage.setItem('mzo_app_version', version); } catch (_) {}
    try { if (theme) { localStorage.setItem('theme', theme); localStorage.setItem('mzo_theme', theme); } } catch (_) {}
    window.__fdp = null;
    const t = () => {
      if (window.__fdp != null) return;
      const vs = document.querySelectorAll('.ui-stat .v');
      const sels = fdpTable.split(',').map((x) => x.trim());
      const row = sels.map((x) => document.querySelector(x + ' tbody tr td:not([colspan])')).find(Boolean);
      const empty = sels.map((x) => document.querySelector(x + ' tbody .ui-empty')).find(Boolean);
      const shown = row || (empty && !/loading/i.test(empty.textContent)); // a real row, or a real "nothing matches"
      if (vs.length && ![].some.call(vs, (v) => v.querySelector('.ui-skel') || !/\d/.test(v.textContent)) && shown) { window.__fdp = performance.now(); window.__fdpRow = !!row; return; }
      requestAnimationFrame(t);
    };
    requestAnimationFrame(t);
  }, { profile, version, theme, fdpTable });
  const stats = { requests: 0, bytes: {}, blocked: [] };
  await ctx.route('**/*', async (r) => {
    const req = r.request(), url = req.url();
    if (!['GET', 'HEAD'].includes(req.method())) { stats.blocked.push(req.method() + ' ' + url.slice(0, 120)); return r.abort('blockedbyclient'); }
    if (/script\.google(usercontent)?\.com/.test(url)) { stats.blocked.push('apps-script ' + url.slice(0, 60)); return r.abort('blockedbyclient'); }
    const hit = route && route(url);
    if (hit) return r.fulfill({ status: 200, headers: { 'content-type': hit.type, 'access-control-allow-origin': '*' }, body: req.method() === 'HEAD' ? '' : fs.readFileSync(hit.file) });
    return r.continue();
  });
  if (opts && opts.cpu) ctx.__cpu = opts.cpu;
  ctx.__stats = stats;
  return ctx;
}

async function settle(page, ms) {
  await page.waitForFunction(() => window.__fdp != null, null, { timeout: ms || 120000 }).catch(() => {});
  await page.waitForTimeout(600);
}

function snapshot(cfg) {
  const txt = (el) => (el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const out = { asOn: txt(document.getElementById('asOn')) };
  // Extra recorders: header texts named by the page, every table / histogram / line chart / select.
  ((cfg && cfg.texts) || []).forEach((id) => { const el = document.getElementById(id); out['text:' + id] = el ? (el.hidden ? '(hidden) ' : '') + txt(el) : null; });
  const tables = {};
  document.querySelectorAll('table').forEach((tb, i) => {
    const host = tb.closest('[id]'), k = (host ? host.id : 'table') + (tables[host ? host.id : 'table'] ? '#' + i : '');
    const rows = [].slice.call(tb.tBodies[0] ? tb.tBodies[0].rows : []);
    const hidden = !!(tb.closest('[hidden]'));
    tables[k] = { hidden, head: [].map.call(tb.querySelectorAll('thead th'), txt).join(' | '), rows: rows.length, first: rows.slice(0, 8).map((r) => [].map.call(r.cells, txt).join(' | ')), foot: tb.tFoot ? txt(tb.tFoot) : '' };
    const pf = tb.closest('.ui-panel') && tb.closest('.ui-panel').querySelector('.ui-panel-f span');
    if (pf) tables[k].footer = txt(pf);
  });
  out.tablesAll = tables;
  out.hist = [].map.call(document.querySelectorAll('.ui-hist'), (hh) => (hh.id || '') + ':' + [].map.call(hh.querySelectorAll('.row'), (r) => { const sp = r.querySelectorAll('span'); return txt(sp[0]) + '=' + txt(sp[sp.length - 1]) + (r.classList.contains('on') ? '*' : ''); }).join('|'));
  out.charts = [].filter.call(document.querySelectorAll('*'), (el) => el.__lineCfg).map((el) => {
    const c = el.__lineCfg;
    return (el.id || '') + ':' + (c.labels || []).length + ' ' + String((c.labels || [])[0] || '') + '…' + String((c.labels || []).slice(-1)[0] || '') + ' ' +
      (c.series || []).map((x) => (x.label || '') + '=' + (x.values || []).length + '/' + Math.round((x.values || []).reduce((a, v) => a + (Number(v) || 0), 0) * 1000) / 1000).join(',');
  });
  out.selectsAll = [].map.call(document.querySelectorAll('select[id]'), (x) => x.id + '=' + ((x.options[x.selectedIndex] || {}).text || '') + '/' + x.options.length + (x.disabled ? ' locked' : '') + (x.closest('[hidden]') ? ' hidden' : ''));
  out.segs = [].map.call(document.querySelectorAll('.ui-seg button[aria-pressed="true"], .ui-tab[aria-selected="true"]'), txt);
  const dw = document.querySelector('#ui-drawer:not([hidden]), #drawer:not([hidden])');
  if (dw) out.drawer = txt(dw).slice(0, 1500);
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
  return out;
}

async function walk(page, cfg, base) {
  const states = {};
  const shot = async (label) => { await page.waitForTimeout(150); states[label] = await page.evaluate(snapshot, { texts: cfg.texts || [] }); };
  const h = {
    // every option of a select (up to `max`), one state each; the first option is put back at the end
    selectAll: async (id, max) => {
      const sel = page.locator('#' + id);
      if (!(await sel.count()) || await sel.isDisabled() || !(await sel.isVisible())) return;
      const vals = await sel.evaluate((x) => [].map.call(x.options, (o) => o.value));
      const back = await sel.inputValue();
      for (let i = 0; i < Math.min(vals.length, max || vals.length); i++) { await sel.selectOption(vals[i]); await shot('select:' + id + '#' + i + '=' + (await sel.evaluate((x) => (x.options[x.selectedIndex] || {}).text || ''))); }
      await sel.selectOption(back);
    },
    // one option (by value), if the select is there, enabled and has it
    pick: async (id, value) => {
      const sel = page.locator('#' + id);
      if (!(await sel.count()) || await sel.isDisabled() || !(await sel.isVisible())) return;
      if (!(await sel.evaluate((x, v) => [].some.call(x.options, (o) => o.value === v), value))) return;
      await sel.selectOption(value); await shot('pick:' + id + '=' + value);
    },
    // open the first row of a table (a drawer), record it, close it
    open: async (selector, label) => {
      const row = page.locator(selector).first();
      if (!(await row.count())) return;
      await row.click(); await shot('open:' + label);
      await page.keyboard.press('Escape');
    },
    search: async (id, text) => { if (!(await page.locator('#' + id).isVisible())) return; await page.fill('#' + id, text); await page.waitForTimeout(400); await shot('search:' + text); await page.fill('#' + id, ''); await page.waitForTimeout(400); },
    // click every element matching the selector, one state each
    clickAll: async (selector, label) => {
      const n = await page.locator(selector).count();
      for (let i = 0; i < n; i++) { const el = page.locator(selector).nth(i); if (!(await el.isVisible())) continue; const t = ((await el.textContent()) || '').trim().slice(0, 30); await el.click(); await shot((label || selector) + ':' + t + '#' + i); }
    }
  };
  await page.goto(base + '/' + cfg.url, { waitUntil: 'domcontentloaded' });
  await settle(page);
  await shot('load');
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
  // drill: back to the first tab, then open the first row at every level down to the list
  if (nTabs) await page.locator(cfg.tabs).first().click();
  for (let level = 0; level < 4; level++) {
    const row = page.locator((cfg.drillTable || '#table') + ' tbody tr.click').first();
    if (!(await row.count())) break;
    const name = ((await row.locator('td').first().textContent()) || '').trim();
    await row.click();
    await shot('drill' + level + ':' + name.slice(0, 30));
    if (await page.locator('#ui-drawer:not([hidden]), #drawer:not([hidden])').count()) { await page.keyboard.press('Escape'); break; }
  }
  if (cfg.steps) {
    await page.goto(base + '/' + cfg.url, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await cfg.steps(page, shot, h);
  }
  for (const q of cfg.deep) {
    await page.goto(base + '/' + cfg.url + q, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await shot('deep' + q);
  }
  return states;
}

function diffStates(a, b) {
  const out = [];
  Object.keys(Object.assign({}, a, b)).forEach((k) => {
    const x = a[k], y = b[k];
    if (!x || !y) { out.push({ state: k, field: '*', old: !!x, new: !!y }); return; }
    Object.keys(Object.assign({}, x, y)).forEach((f) => { if (JSON.stringify(x[f]) !== JSON.stringify(y[f])) out.push({ state: k, field: f, old: x[f], new: y[f] }); });
  });
  return out;
}

async function parity(pw) {
  const oldBase = arg('old'), newBases = String(arg('new')).split(','), snap = arg('snap');
  const pages = String(arg('pages', Object.keys(PAGES).join(','))).split(',');
  const profiles = String(arg('profiles', 'admin,division')).split(',');
  const outDir = arg('out', path.join(process.cwd(), 'uniform-parity'));
  fs.mkdirSync(outDir, { recursive: true });
  const route = router(snap);
  const browser = await pw.chromium.launch({ channel: process.env.QA_CHANNEL || 'chrome', headless: true });
  const summary = [];
  for (const p of pages) {
    for (const prof of profiles) {
      const runs = {};
      for (const base of [oldBase].concat(newBases)) {
        const ctx = await newContext(browser, base, PROFILES[prof], route, { table: PAGES[p].fdp || PAGES[p].drillTable });
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
        summary.push({ page: p, profile: prof, base: nb, states: Object.keys(old.states).length, differences: d.length, errors: runs[nb].errors.length, oldErrors: old.errors.length });
        fs.writeFileSync(path.join(outDir, `${p}-${prof}-${new URL(nb).port}.json`), JSON.stringify({ old: oldBase, new: nb, differences: d, oldStates: old.states, newStates: runs[nb].states, errors: runs[nb].errors, oldErrorsList: old.errors, blocked: runs[nb].blocked }, null, 1));
        console.log(`[parity] ${p} as ${prof}: ${new URL(nb).port} vs ${new URL(oldBase).port}: ${Object.keys(old.states).length} states, ${d.length} differences, console errors new ${runs[nb].errors.length} / old ${old.errors.length}`);
        d.slice(0, 12).forEach((x) => console.log(`    ${x.state} · ${x.field}: ${JSON.stringify(x.old).slice(0, 160)}  →  ${JSON.stringify(x.new).slice(0, 160)}`));
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
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
  // Old and new runs alternate (old, new, old, new, …) so both see the same machine load.
  for (const p of pages) {
    const acc = { old: { cold: [], warm: [], bytes: [] }, new: { cold: [], warm: [], bytes: [] } };
    for (let i = 0; i < runsN; i++) {
      for (const which of ['old', 'new']) {
        const ctx = await newContext(browser, bases[which], PROFILES.admin, route, { cpu, table: PAGES[p].fdp || PAGES[p].drillTable });
        const page = await ctx.newPage();
        if (cpu > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu }); }
        let got = 0;
        page.on('response', async (res) => { try { const u = res.url(); if (/docs\.google|supabase\.co|\/api\/data\/|\/api\/nsc\//.test(u)) { const s = await res.request().sizes(); got += s.responseBodySize || 0; } } catch (_) {} });
        for (const pass of ['cold', 'warm']) {
          await page.goto(bases[which] + '/' + PAGES[p].url, { waitUntil: 'domcontentloaded' });
          await page.waitForFunction(() => window.__fdp != null, null, { timeout: 180000 }).catch(() => {});
          const ms = await page.evaluate(() => window.__fdp);
          acc[which][pass].push(ms);
          if (pass === 'cold') { acc[which].bytes.push(got); await page.waitForTimeout(2500); } // let background checks finish
        }
        await ctx.close();
      }
    }
    for (const which of ['old', 'new']) {
      const { cold, warm, bytes } = acc[which];
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
