#!/usr/bin/env node
/* Browser parity and timing for pages converted to MzoRows.
 *
 *   node scripts/qa/uniform-pages.js parity --old <baseUrl> --new <baseUrl>[,<baseUrl>…] --snap <dir> [--pages solar,nsc | --batch b-revenue]
 *        [--out <dir>] [--profiles admin,division,region,ccc] [--theme dark|light] [--width 390] [--quick] [--clock <iso>] [--tag <name>]
 *   node scripts/qa/uniform-pages.js timing --old <baseUrl> --new <baseUrl> [--snap <dir>] [--pages …] [--runs 3] [--cpu 4] [--profile admin]
 *        [--theme dark|light] [--width 390] [--out <file>]
 *
 * parity: every page is opened on each base with the same data (Google and Supabase Storage
 * requests are answered from the snapshot folder), as admin and as a division user (--profiles).
 * It records what the page shows on load, after each stat card, each step the page names, each
 * analysis tab, each drill level (first row opened at every level) and each deep link, and
 * compares the old base with every new base. --quick records the load and the stat cards only.
 * timing: first data paint (stat values and a real table row on screen), cold (empty storage)
 * and warm (second load), median of --runs, old and new runs alternating, live sources unless
 * --snap is given.
 *
 * Pages live in scripts/qa/uniform-pages/<batch>.js (BATCHES below). An entry needs url, stats
 * and tabs; everything else is optional:
 *   key                dataset key (for the reader)
 *   deep               query strings, each opened fresh
 *   asOn               the as-on text (default #asOn)
 *   drillRows          the rows the drill opens level by level (default #table tbody tr.click)
 *   fdp                table panel(s), comma-separated, whose first real row (or a real "nothing
 *                      matches") marks the first data paint (default the first of `tables`, else #table)
 *   readyStats         the stat values that must hold a number first (default .ui-stat .v)
 *   ready: 'badges'    a page of live cells: loaded when every .ui-badge has its value
 *   settle             extra ms to wait after the first load
 *   clock              ISO time: one fixed wall clock (ages computed at load time); --clock for all
 * Steps, in walk order. After the stat cards:
 *   clicks             facet options / hist rows, toggled one by one (up to 8 per selector)
 *   selects            select boxes: their first 4 values, then back to "all"
 *   segments           segmented buttons: each after the first, then the first again
 * After the tabs:
 *   hists: true        every clickable hist bar, found again by hist id and label
 *   selectValues       { selectId: [values] }: each listed value, then back to the first
 *   buttons            buttons pressed in order, then the first again
 *   list               the first 3 rows of a detail list (each opens a drawer)
 * After the drill, each on a fresh load:
 *   freshClicks        the first match of each selector, pressed once
 *   steps(page, shot, h)  the page's own steps; h: selectAll(id, max), pick(id, value),
 *                      open(rowSelector, label), search(id, text), clickAll(selector, label)
 * Every state records the as-on text, stat cards, facets, kit drill tabs, trail, hint, the #table
 * panel and the side-panel selects, plus:
 *   tables             panels recorded instead of #table: { head, rows, first 8 rows, foot, footer }
 *   tableIds           table hosts by id, recorded next to #table as table:<id>: { head, rows, first, foot, more }
 *   texts              header texts by id or selector, as text:<id> ("(hidden) " when hidden, null when missing)
 *   extra              charts, hists, notes: hist rows, [title] tips or the text
 *   segments           the buttons, the pressed one starred
 *   record             whole-page recorders: 'levelTabs' (the `tabs`, selected starred); 'all' (every
 *                      table, hist, line chart (series sums), select and segmented control, and an open
 *                      drawer); 'main' (every select, ui-table, hist, plain value and drawn chart inside
 *                      <main>, the drawer and the Clear button); 'heads' (every hist as text, the panel headings)
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

// Page configs, one module per batch of docs/uniform-data-inventory.md.
const BATCHES = ['prototype', 'a-connections', 'b-revenue', 'c-meters', 'd-offices'];
const PAGES = {}, BATCH_OF = {};
for (const b of BATCHES) {
  for (const [k, v] of Object.entries(require('./uniform-pages/' + b))) {
    if (PAGES[k]) throw new Error(`page ${k} is in ${BATCH_OF[k]} and ${b}`);
    PAGES[k] = v; BATCH_OF[k] = b;
  }
}
function pagesArg() {
  const list = arg('pages') ? String(arg('pages')).split(',') : Object.keys(PAGES).filter((p) => !arg('batch') || BATCH_OF[p] === arg('batch'));
  list.forEach((p) => { if (!PAGES[p]) throw new Error('unknown page ' + p + ' (pages: ' + Object.keys(PAGES).join(', ') + ')'); });
  return list;
}
const fdpOf = (cfg) => cfg.fdp || (cfg.tables || ['#table'])[0];

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

// opts: fdp, readyStats, theme, width, clock (see the header)
async function newContext(browser, base, profile, route, opts) {
  opts = opts || {};
  const width = Number(opts.width || 1280);
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 1, isMobile: false });
  await ctx.addCookies([{ name: 'mzo_session', value: cookie(profile), domain: new URL(base).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  const version = await fetch(base + '/version.json').then((r) => r.json()).then((j) => j.version).catch(() => '');
  await ctx.addInitScript(({ profile, version, theme, fdp, readyStats }) => {
    try {
      localStorage.setItem('mzo_user_profile', JSON.stringify(profile)); localStorage.setItem('mzo_authenticated', 'true'); if (version) localStorage.setItem('mzo_app_version', version);
      if (theme) ['theme', 'mzo_theme', 'collectionDashboardTheme'].forEach((k) => localStorage.setItem(k, theme));
    } catch (_) {}
    window.__fdp = null;
    const sels = fdp.split(',').map((x) => x.trim());
    const t = () => {
      if (window.__fdp != null) return;
      const vs = document.querySelectorAll(readyStats || '.ui-stat .v');
      const row = sels.map((x) => document.querySelector(x + ' tbody tr td:not([colspan])')).find(Boolean);
      const empty = sels.map((x) => document.querySelector(x + ' tbody .ui-empty') || document.querySelector(x + ' > .ui-empty')).find(Boolean);
      const shown = row || (empty && !/loading/i.test(empty.textContent)); // a real row, or a real "nothing matches"
      if (vs.length && ![].some.call(vs, (v) => v.querySelector('.ui-skel') || !/\d/.test(v.textContent)) && shown) { window.__fdp = performance.now(); window.__fdpRow = !!row; return; }
      requestAnimationFrame(t);
    };
    requestAnimationFrame(t);
  }, { profile, version, theme: opts.theme || '', fdp: opts.fdp || '#table', readyStats: opts.readyStats || '' });
  const stats = { requests: 0, bytes: {}, blocked: [] };
  await ctx.route('**/*', async (r) => {
    const req = r.request(), url = req.url();
    if (!['GET', 'HEAD'].includes(req.method())) { stats.blocked.push(req.method() + ' ' + url.slice(0, 120)); return r.abort('blockedbyclient'); }
    if (/script\.google(usercontent)?\.com/.test(url)) { stats.blocked.push('apps-script ' + url.slice(0, 60)); return r.abort('blockedbyclient'); }
    const hit = route && route(url);
    if (hit) return r.fulfill({ status: 200, headers: { 'content-type': hit.type, 'access-control-allow-origin': '*' }, body: req.method() === 'HEAD' ? '' : fs.readFileSync(hit.file) });
    return r.continue();
  });
  // pages that compute ages at load time (docket "open for", DD days to due): one fixed wall clock
  if (opts.clock) await ctx.clock.setFixedTime(new Date(opts.clock));
  ctx.__stats = stats;
  return ctx;
}

async function settle(page, cfg) {
  if (cfg.ready === 'badges') // a page of live cells: every badge has its value
    await page.waitForFunction(() => document.querySelectorAll('.ui-badge').length && ![].some.call(document.querySelectorAll('.ui-badge'), (b) => /…/.test(b.textContent)), null, { timeout: 120000 }).catch(() => {});
  else await page.waitForFunction(() => window.__fdp != null, null, { timeout: 120000 }).catch(() => {});
  // Side requests (report-date meta, live version checks) can land after the first paint and change
  // the as-on date: compare the settled page, not whichever was faster.
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
}

// Runs in the page: what one state records (see the header). cfg is the plain part of the entry.
function snapshot(cfg) {
  const txt = (el) => (el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const rec = (n) => (cfg.record || []).indexOf(n) >= 0;
  const out = { asOn: txt(document.querySelector(cfg.asOn || '#asOn')) };
  (cfg.texts || []).forEach((s) => {
    const el = /^[\w-]+$/.test(s) ? document.getElementById(s) : document.querySelector(s);
    out['text:' + s] = el ? (el.hidden ? '(hidden) ' : '') + txt(el) : null;
  });
  if (rec('all')) {
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
  }
  (cfg.tableIds || []).forEach((id) => {
    const host = document.getElementById(id); if (!host) return;
    const tb = host.querySelector('table');
    out['table:' + id] = tb ? { head: [].map.call(tb.querySelectorAll('thead th'), txt), rows: tb.tBodies[0] ? tb.tBodies[0].rows.length : 0,
      first: [].slice.call(tb.tBodies[0] ? tb.tBodies[0].rows : [], 0, 8).map((r) => [].map.call(r.cells, txt).join(' | ')), foot: tb.tFoot ? txt(tb.tFoot) : '', more: txt(host.querySelector('.ui-panel-f, .ui-more')) } : txt(host);
  });
  if (rec('heads')) {
    out.hists = [].map.call(document.querySelectorAll('.ui-hist'), (h) => (h.id || '') + ':' + txt(h));
    out.heads = [].map.call(document.querySelectorAll('.ui-panel-h h2, .ui-panel-h .ui-note, [id$="Count"], [id$="Title"], .dm-names-note:not([hidden])'), txt).filter(Boolean);
  }
  out.stats = [].map.call(document.querySelectorAll('.ui-stat'), (s) => [txt(s.querySelector('.k')), txt(s.querySelector('.v')), txt(s.querySelector('.s')), s.getAttribute('aria-pressed')]);
  out.facets = [].map.call(document.querySelectorAll('.ui-opts'), (g) => (g.id || '') + ':' + [].map.call(g.querySelectorAll('.ui-opt'), (o) => txt(o.querySelector('span')) + '=' + txt(o.querySelector('small')) + (o.getAttribute('aria-checked') === 'true' ? '*' : '')).join('|'));
  out.tabs = [].map.call(document.querySelectorAll('.ui-drill-tab'), (t) => txt(t) + (t.getAttribute('aria-selected') === 'true' ? '*' : ''));
  out.trail = txt(document.querySelector('.ui-trail nav'));
  out.hint = txt(document.getElementById('hint'));
  if (cfg.tables) {
    out.tables = {};
    cfg.tables.forEach((sel) => {
      const t = document.querySelector(sel + ' table');
      if (!t) { out.tables[sel] = { empty: txt(document.querySelector(sel)) }; return; }
      const rows = [].slice.call(t.tBodies[0] ? t.tBodies[0].rows : []);
      out.tables[sel] = { head: [].map.call(t.querySelectorAll('thead th'), txt), rows: rows.length, first: rows.slice(0, 8).map((r) => [].map.call(r.cells, txt).join(' | ')), foot: t.tFoot ? txt(t.tFoot) : '', footer: txt(document.querySelector(sel + ' .ui-panel-f span')) };
    });
  } else {
    const t = document.querySelector('#table table');
    if (t) {
      out.head = [].map.call(t.querySelectorAll('thead th'), txt);
      const rows = [].slice.call(t.tBodies[0] ? t.tBodies[0].rows : []);
      out.rows = rows.length;
      out.first = rows.slice(0, 8).map((r) => [].map.call(r.cells, txt).join(' | '));
      out.foot = t.tFoot ? txt(t.tFoot) : '';
    }
    out.footer = txt(document.querySelector('#table .ui-panel-f span'));
  }
  if (rec('levelTabs')) out.levelTabs = [].map.call(document.querySelectorAll(cfg.tabs), (t) => txt(t) + (t.getAttribute('aria-selected') === 'true' ? '*' : ''));
  (cfg.extra || []).forEach((sel) => {
    const el = document.querySelector(sel);
    if (!el) { out[sel] = null; return; }
    const tips = [].map.call(el.querySelectorAll('[title]'), (x) => x.getAttribute('title') + ([].indexOf.call(x.classList, 'on') >= 0 ? '*' : ''));
    out[sel] = el.classList.contains('ui-hist') ? [].map.call(el.querySelectorAll('.row'), (r) => txt(r) + (r.classList.contains('on') ? '*' : '')) : (tips.length ? tips : txt(el));
  });
  (cfg.segments || []).forEach((sel) => { out[sel] = [].map.call(document.querySelectorAll(sel), (b) => txt(b) + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')); });
  out.selects = [].map.call(document.querySelectorAll('.ui-side select'), (s) => s.id + '=' + s.value + '/' + s.options.length + (s.disabled ? ' locked' : ''));
  if (rec('main')) {
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
    out.values = [].map.call(document.querySelectorAll('main [id]'), (e) => e).filter((e) => !e.children.length && /^(s[A-Z]|c[A-Z]|listCount|appCount|meta|axis|trend|period)/.test(e.id)).map((e) => e.id + '=' + txt(e));
    // charts drawn by the page (historical NSC): the series behind the bars and the bar heights
    out.charts = [].map.call(document.querySelectorAll('main .hs-chart'), (c) => (c.id || '') + ':' + (c.__series ? c.__series.map((x) => x.label + '=' + x.v).join('|') : '') + ' h:' + [].map.call(c.querySelectorAll('.col b'), (b) => b.style.height).join(','));
    const dr = document.querySelector('#ui-drawer:not([hidden])');
    out.drawer = dr ? txt(dr).slice(0, 1500) : '';
    out.clear = !!(document.getElementById('clearBtn') && !document.getElementById('clearBtn').hidden);
  }
  return out;
}

async function walk(page, cfg, base, quick) {
  const states = {};
  const scfg = { asOn: cfg.asOn, tabs: cfg.tabs, tables: cfg.tables, tableIds: cfg.tableIds, texts: cfg.texts, extra: cfg.extra, segments: cfg.segments, record: cfg.record };
  const shot = async (label) => { await page.waitForTimeout(150); states[label] = await page.evaluate(snapshot, scfg); };
  const open = async (q) => { await page.goto(base + '/' + cfg.url + (q || ''), { waitUntil: 'domcontentloaded' }); await settle(page, cfg); };
  // A control the login cannot use (a level tab hidden for a locked scope) is skipped, not waited for.
  const click = async (loc) => { try { await loc.click({ timeout: 4000 }); return true; } catch (_) { return false; } };
  const drawer = () => page.locator('#ui-drawer:not([hidden]), #drawer:not([hidden])').count();
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
  await open();
  if (cfg.settle) await page.waitForTimeout(cfg.settle);
  await shot('load');
  // where the rows came from (not compared): MzoRows timings per dataset (fetch/build/where)
  states.__rows = await page.evaluate(() => (window.MzoRows && window.MzoRows.last ? JSON.parse(JSON.stringify(window.MzoRows.last)) : null));
  // stat cards (each toggles a filter; click again to clear)
  const nStats = await page.locator(cfg.stats).count();
  for (let i = 0; i < nStats; i++) {
    if (!(await click(page.locator(cfg.stats).nth(i)))) { states['stat#' + i] = 'not clickable'; continue; }
    await shot('stat#' + i);
    await click(page.locator(cfg.stats).nth(i));
  }
  if (quick) return states;
  // facet options and histogram rows (each toggles; click again to clear), up to 8 per group
  for (const sel of cfg.clicks || []) {
    const n = Math.min(8, await page.locator(sel).count());
    for (let i = 0; i < n; i++) {
      const el = page.locator(sel).nth(i);
      const label = ((await el.textContent()) || '').replace(/\s+/g, ' ').trim().slice(0, 30);
      await el.dispatchEvent('click'); // also inside a collapsed panel section
      await shot('click:' + sel + '#' + i + ':' + label);
      if (await page.locator(sel).nth(i).count()) await page.locator(sel).nth(i).dispatchEvent('click');
    }
  }
  // select boxes: the first options, then back to "all"
  for (const sel of cfg.selects || []) {
    const vals = await page.$$eval(sel + ' option', (os) => os.map((o) => o.value).filter(Boolean).slice(0, 4)).catch(() => []);
    for (const v of vals) { await page.selectOption(sel, v); await shot('select:' + sel + '=' + v); }
    if (vals.length) await page.selectOption(sel, '');
  }
  // segmented buttons (category, priority): each one, then back to the first
  for (const sel of cfg.segments || []) {
    const n = await page.locator(sel).count();
    for (let i = 1; i < n; i++) { await page.locator(sel).nth(i).click(); await shot('segment:' + sel + '#' + i); }
    if (n) await page.locator(sel).first().click();
  }
  // every analysis / level tab
  const nTabs = await page.locator(cfg.tabs).count();
  for (let i = 0; i < nTabs; i++) {
    const tab = page.locator(cfg.tabs).nth(i);
    const label = (await tab.getAttribute('data-t')) || (await tab.getAttribute('data-k')) || ((await tab.textContent()) + '#' + i);
    if (!(await click(tab))) { states['tab:' + label] = 'not clickable'; continue; }
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
  for (const [id, values] of Object.entries(cfg.selectValues || {})) {
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
  // buttons stepped through in order (segmented controls), then the first one again
  for (const sel of cfg.buttons || []) {
    const n = await page.locator(sel).count();
    for (let i = 0; i < n; i++) { await page.locator(sel).nth(i).click(); await shot('click:' + sel + '#' + i); }
    if (n) await page.locator(sel).first().click();
  }
  // the first rows of the detail list open a drawer
  if (cfg.list) {
    for (let i = 0; i < 3; i++) {
      const row = page.locator(cfg.list).nth(i);
      if (!(await row.count())) break;
      await row.click();
      await shot('list#' + i);
      if (await drawer()) await page.keyboard.press('Escape');
    }
  }
  // drill: back to the first tab, then open the first row at every level down to the list
  if (await page.locator(cfg.tabs).count()) await click(page.locator(cfg.tabs).first());
  for (let level = 0; level < 4; level++) {
    const row = page.locator(cfg.drillRows || '#table tbody tr.click').first();
    if (!(await row.count())) break;
    const name = ((await row.locator('td').first().textContent()) || '').trim();
    if (!(await click(row))) break;
    await shot('drill' + level + ':' + name.slice(0, 30));
    if (await drawer()) { await page.keyboard.press('Escape'); break; }
  }
  for (const sel of cfg.freshClicks || []) {
    await open();
    if (await page.locator(sel).count() && await click(page.locator(sel).first())) await shot('click:' + sel);
  }
  if (cfg.steps) {
    await open();
    await cfg.steps(page, shot, h);
  }
  for (const q of cfg.deep || []) {
    await open(q);
    await shot('deep' + q);
  }
  return states;
}

// States whose name starts with __ are notes, not compared.
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
const stateCount = (states) => Object.keys(states).filter((k) => k.indexOf('__')).length;

async function parity(pw) {
  const oldBase = arg('old'), newBases = String(arg('new')).split(','), snap = arg('snap');
  const pages = pagesArg();
  const profiles = String(arg('profiles', 'admin,division')).split(',');
  const look = { theme: arg('theme', ''), width: Number(arg('width', 1280)) }, quick = process.argv.includes('--quick');
  const tag = (look.theme ? '-' + look.theme : '') + (look.width !== 1280 ? '-' + look.width : '');
  const shown = (look.theme ? ' ' + look.theme : '') + (look.width !== 1280 ? ' ' + look.width + 'px' : '');
  const outDir = arg('out', path.join(process.cwd(), 'uniform-parity'));
  fs.mkdirSync(outDir, { recursive: true });
  const route = router(snap);
  const browser = await pw.chromium.launch({ channel: process.env.QA_CHANNEL || 'chrome', headless: true });
  const summary = [];
  for (const p of pages) {
    const cfg = PAGES[p];
    for (const prof of profiles) {
      const runs = {};
      for (const base of [oldBase].concat(newBases)) {
        const ctx = await newContext(browser, base, PROFILES[prof], route, Object.assign({ fdp: fdpOf(cfg), readyStats: cfg.readyStats, clock: cfg.clock || arg('clock', '') }, look));
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
        runs[base] = { states: await walk(page, cfg, base, quick), errors, blocked: ctx.__stats.blocked };
        await ctx.close();
      }
      const old = runs[oldBase];
      for (const nb of newBases) {
        const d = diffStates(old.states, runs[nb].states);
        summary.push({ page: p, profile: prof, base: nb, theme: look.theme, width: look.width, rows: runs[nb].states.__rows, states: stateCount(old.states), differences: d.length, errors: runs[nb].errors.length, oldErrors: old.errors.length });
        fs.writeFileSync(path.join(outDir, `${p}-${prof}-${new URL(nb).port}${tag}.json`), JSON.stringify({ old: oldBase, new: nb, differences: d, oldStates: old.states, newStates: runs[nb].states, errors: runs[nb].errors, oldErrorsList: old.errors, blocked: runs[nb].blocked }, null, 1));
        console.log(`[parity] ${p} as ${prof}${shown}: ${new URL(nb).port} vs ${new URL(oldBase).port}: ${stateCount(old.states)} states, ${d.length} differences, console errors new ${runs[nb].errors.length} / old ${old.errors.length}`);
        d.slice(0, 12).forEach((x) => console.log(`    ${x.state} · ${x.field}: ${JSON.stringify(x.old).slice(0, 160)}  →  ${JSON.stringify(x.new).slice(0, 160)}`));
        if (runs[nb].states.__rows) console.log('    rows: ' + JSON.stringify(runs[nb].states.__rows).slice(0, 300));
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'summary' + tag + (arg('tag') ? '-' + arg('tag') : '') + '.json'), JSON.stringify(summary, null, 1));
  await browser.close();
}

async function timing(pw) {
  const bases = { old: arg('old'), new: arg('new') };
  const runsN = Number(arg('runs', 3)), cpu = Number(arg('cpu', 1));
  const route = router(arg('snap'));
  const pages = pagesArg();
  const profile = PROFILES[arg('profile', 'admin')], look = { theme: arg('theme', ''), width: Number(arg('width', 1280)) };
  const browser = await pw.chromium.launch({ channel: process.env.QA_CHANNEL || 'chrome', headless: true });
  const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor((s.length - 1) / 2)]) : null; };
  const rows = [];
  // Old and new runs alternate (old, new, old, new, …) so both see the same machine load.
  for (const p of pages) {
    const acc = { old: { cold: [], warm: [], bytes: [] }, new: { cold: [], warm: [], bytes: [] } };
    for (let i = 0; i < runsN; i++) {
      for (const which of ['old', 'new']) {
        const ctx = await newContext(browser, bases[which], profile, route, Object.assign({ fdp: fdpOf(PAGES[p]), readyStats: PAGES[p].readyStats }, look));
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
  else { console.error('usage: uniform-pages.js parity|timing … (pages: ' + Object.keys(PAGES).join(', ') + ')'); process.exit(2); }
})().catch((e) => { console.error(e); process.exit(1); });
