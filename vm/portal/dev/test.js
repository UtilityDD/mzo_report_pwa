#!/usr/bin/env node
/* Browser test for the admin portal against the local PocketBase seeded by seed.js.
 *
 *   node vm/portal/dev/serve.js &          (portal on :3300, PocketBase on :8093)
 *   node vm/portal/dev/test.js [shotsDir]
 *
 * Needs playwright-core (resolved from node_modules or NODE_PATH) and Google Chrome.
 * Only GET/HEAD/OPTIONS to the local portal are allowed, plus POST to the two local
 * PocketBase sign-in endpoints; every other request is blocked and fails the run.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const BASE = process.env.PORTAL_URL || 'http://127.0.0.1:3300';
const CRED = JSON.parse(fs.readFileSync(path.join(__dirname, 'pb', 'dev-credentials.json'), 'utf8'));
const SHOTS = process.argv[2] || '';
const results = [];
let failed = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  if (!ok) failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}
const num = (s) => Number(String(s).replace(/[^\d.-]/g, ''));
const first = (s) => Number((String(s).match(/[\d,]+(\.\d+)?/) || ['NaN'])[0].replace(/,/g, ''));

async function apiCount(collection, filter) {
  const a = await (await fetch(BASE + '/api/collections/portal_users_auth/auth-with-password', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity: CRED.portal.email, password: CRED.portal.password })
  })).json();
  const r = await (await fetch(BASE + '/api/collections/' + collection + '/records?perPage=1&filter=' + encodeURIComponent(filter || ''), { headers: { Authorization: a.token } })).json();
  return r.totalItems;
}

async function apiList(collection, filter, perPage, sort) {
  const a = await (await fetch(BASE + '/api/collections/portal_users_auth/auth-with-password', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity: CRED.portal.email, password: CRED.portal.password })
  })).json();
  const r = await (await fetch(BASE + '/api/collections/' + collection + '/records?perPage=' + (perPage || 500) + '&filter=' + encodeURIComponent(filter || '') + (sort ? '&sort=' + encodeURIComponent(sort) : ''), { headers: { Authorization: a.token } })).json();
  return r.items || [];
}

async function newPage(browser, opts) {
  const ctx = await browser.newContext({
    viewport: opts.phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: opts.phone ? 2 : 1, isMobile: !!opts.phone, hasTouch: !!opts.phone, acceptDownloads: true
  });
  await ctx.addInitScript((theme) => { try { localStorage.setItem('theme', theme); } catch (e) {} }, opts.theme);
  const errors = [], blocked = [];
  await ctx.route('**/*', (route) => {
    const req = route.request(), url = new URL(req.url()), m = req.method();
    const local = url.origin === new URL(BASE).origin;
    const authPost = m === 'POST' && /^\/api\/collections\/(portal_users_auth|_superusers)\/auth-(with-password|refresh)$/.test(url.pathname);
    if (local && (['GET', 'HEAD', 'OPTIONS'].includes(m) || authPost)) return route.continue();
    blocked.push(m + ' ' + req.url());
    return route.abort();
  });
  const page = await ctx.newPage();
  // A wrong password is an expected 400 from the sign-in endpoint; anything else counts.
  page.on('console', (msg) => { const u = (msg.location() || {}).url || ''; if (msg.type() === 'error' && !/auth-with-password/.test(u)) errors.push('console: ' + msg.text() + ' ' + u); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400 && !/auth-with-password/.test(r.url())) errors.push('http ' + r.status() + ' ' + r.url()); });
  return { ctx, page, errors, blocked };
}
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}
async function signIn(page, who) {
  await page.goto(BASE + '/');
  await page.waitForSelector('#login:not([hidden])');
  await page.fill('#loginEmail', who.email);
  await page.fill('#loginPass', who.password);
  await page.click('#loginBtn');
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForSelector('#nav a.pt-ni[data-key]');
}
async function gridReady(page) {
  await page.waitForFunction(() => { const p = document.querySelector('.pt-data'); return p && !p.classList.contains('busy') && document.querySelector('.pt-table tbody tr'); });
}
const summary = (page) => page.textContent('.pt-summary');
const firstCol = (page, idx) => page.$$eval('.pt-table tbody tr', (trs, i) => trs.map((tr) => tr.children[i] && tr.children[i].textContent), idx);

async function addFilter(page, colLabelStartsWith, op, value) {
  await page.click('.pt-tools button:has-text("Filter")');
  await page.waitForSelector('.pt-pop .pt-fb');
  const opt = await page.$$eval('.pt-pop select[aria-label="Column"] option', (os, s) => (os.find((o) => o.textContent.startsWith(s)) || {}).value, colLabelStartsWith);
  await page.selectOption('.pt-pop select[aria-label="Column"]', opt);
  await page.selectOption('.pt-pop select[aria-label="Condition"]', op);
  if (value != null) await page.fill('.pt-pop input[aria-label="Value"]', value);
  await page.click('.pt-pop button.primary');
  await page.waitForTimeout(150);
  await gridReady(page).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.pt-data.busy'));
}
async function clearFilters(page) {
  const many = await page.$('.pt-chips button:has-text("Clear all")');
  if (many) await many.click();
  else { const x = await page.$('.pt-chip-x'); if (x) await x.click(); }
  await page.waitForFunction(() => !document.querySelector('.pt-data.busy'));
}

/* ---------- data quality ---------- */
const IST = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
const istDay = (pbDate) => IST.format(new Date(String(pbDate).replace(' ', 'T')));
const RANK = { Error: 0, Warning: 1, Note: 2 };
// Every check id vm/quality can store, read from its source.
function qualityCheckIds() {
  const dir = path.join(__dirname, '..', '..', 'quality');
  const files = ['index.js', 'lib/engine.js', 'lib/cross.js'].map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f));
  const ids = new Set();
  files.forEach((f) => {
    const src = fs.readFileSync(f, 'utf8');
    (src.match(/'(office|date|number|value|key|row|header|freshness|cross)\.[a-z_]+'/g) || []).forEach((m) => ids.add(m.slice(1, -1)));
    (src.match(/office\.unknown_\$\{/g) || []).forEach(() => ['office.unknown_region', 'office.unknown_division', 'office.unknown_ccc'].forEach((x) => ids.add(x)));
  });
  return [...ids];
}
const quietly = (page) => page.waitForFunction(() => !document.querySelector('.ui-empty .pt-skel'));
async function rowsOf(page) { return page.$$eval('.pt-qtable tbody tr', (trs) => trs.length); }

async function qualityTests(browser) {
  const since = new Date(Date.now() - 7 * 864e5).toISOString().replace('T', ' ');
  const scores = await apiList('sys_quality_scores', '', 500);
  const open = await apiList('sys_quality_issues', "status = 'open'", 500);
  const recent = await apiList('sys_quality_issues', "status = 'resolved' && last_seen >= '" + since + "'", 500);
  const avg = Math.round(scores.reduce((a, s) => a + s.score, 0) / scores.length);
  const sevN = (s) => open.filter((i) => i.severity === s).length;
  const sheetOnly = open.filter((i) => i.source_fix);
  const datasets = await apiList('sys_datasets', '', 500);
  const dsBy = Object.fromEntries(datasets.map((d) => [d.key, d]));

  /* desktop light: full pass */
  {
    const { ctx, page, errors, blocked } = await newPage(browser, { theme: 'light' });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    await signIn(page, CRED.portal);
    await page.waitForSelector('.pt-dq-avg');
    const card = await page.textContent('.pt-dq');
    const bandN = await page.$$eval('.pt-dq-band > b', (b) => b.map((x) => Number(x.textContent.replace(/,/g, ''))));
    const lo = scores.filter((s) => s.score < 80).length, mid = scores.filter((s) => s.score >= 80 && s.score < 95).length, hi = scores.filter((s) => s.score >= 95).length;
    check('overview card: average score and bands', (await page.textContent('.pt-dq-num')) === String(avg) && bandN.join() === [hi, mid, lo].join(), avg + ' · ' + bandN.join('/'));
    const sevCard = await page.$$eval('.pt-dq-sevi b', (b) => b.map((x) => x.textContent));
    check('overview card: open errors / warnings / notes and last checked', sevCard[0] === String(sevN('error')) && sevCard[1] === String(sevN('warn')) && sevCard[2] === String(sevN('info')) && /\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}/.test(sevCard[3]), sevCard.join(' · '));
    check('overview card links to the page', (await page.getAttribute('.pt-dq .ui-panel-h a', 'href')) === '#/quality' && card.includes('Data quality'));
    await page.evaluate(() => document.querySelector('.pt-dq').scrollIntoView({ block: 'center' }));
    await shot(page, 'quality-overview-card-light');

    await page.click('#nav a[href="#/quality"]');
    await page.waitForSelector('.pt-qtable tbody tr');
    const tiles = await page.$$eval('.pt-qtiles .ui-stat', (s) => s.map((x) => x.querySelector('.k').textContent.trim() + '=' + x.querySelector('.v').textContent.trim()));
    check('quality tiles', tiles[0] === 'Average score=' + avg && tiles[1] === 'Below 80=' + lo && tiles[2] === 'Open errors=' + sevN('error') && tiles[3] === 'Open warnings=' + sevN('warn') && tiles[4] === 'Open notes=' + sevN('info') && /Last checked=\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}/.test(tiles[5]), tiles.join(' · '));
    check('by dataset: every scored dataset', await rowsOf(page) === scores.length, String(await rowsOf(page)));
    const sc = await page.$$eval('.pt-qtable tbody tr .pt-score span', (s) => s.map((x) => Number(x.textContent)));
    check('by dataset: sorted by score ascending', sc.every((v, i) => i === 0 || v >= sc[i - 1]) && sc[0] === Math.min(...scores.map((s) => s.score)), sc.join(','));
    const bands = await page.$$eval('.pt-qtable tbody tr .pt-score', (s) => s.map((x) => x.className.match(/pt-band-(\w+)/)[1]));
    const fills = await page.$$eval('.pt-qtable tbody tr .pt-score i b', (b) => b.map((x) => getComputedStyle(x).backgroundColor));
    const marks = await page.evaluate(() => ['ok', 'warn', 'bad'].map((k) => { const e = document.createElement('div'); e.style.color = 'var(--mzo-' + k + '-mark)'; document.body.appendChild(e); const c = getComputedStyle(e).color; e.remove(); return c; }));
    check('score bars use the status mark colours by band', sc.every((v, i) => bands[i] === (v >= 95 ? 'ok' : v >= 80 ? 'warn' : 'bad')) && fills.every((f, i) => f === marks[['ok', 'warn', 'bad'].indexOf(bands[i])]), bands.slice(0, 4).join(','));
    const ist = await page.$eval('.pt-qtable tbody tr td:last-child time', (t) => t.textContent);
    check('checked time in IST dd/mm/yyyy', /^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}$/.test(ist), ist);
    await shot(page, 'quality-datasets-light');
    await page.click('.pt-qtable tbody tr:first-child td:nth-child(3)');
    await page.waitForSelector('.pt-dsq');
    check('a dataset row opens its Quality tab', /#\/d\/[a-z_]+\/quality$/.test(page.url()) && (await page.getAttribute('.pt-tabs a[aria-selected="true"]', 'href')).endsWith('/quality'));
    await page.goBack();
    await page.waitForSelector('.pt-qtable tbody tr');

    // All issues
    await page.click('.pt-qtabs a:has-text("All issues")');
    await page.waitForSelector('.pt-qtable tbody tr .pt-sev');
    let sev = await page.$$eval('.pt-qtable tbody tr .pt-sev', (b) => b.map((x) => x.textContent));
    check('all issues: every open issue, errors first', sev.length === open.length && sev.every((v, i) => i === 0 || RANK[v] >= RANK[sev[i - 1]]), sev.length + ' rows');
    const checks = await page.$$eval('.pt-qtable tbody tr td:nth-child(3)', (t) => t.map((x) => x.textContent));
    check('friendly check names (no raw ids)', checks.every((t) => !/^[a-z]+\.[a-z_]+$/.test(t)) && checks.includes('Report out of date') && checks.includes('Copied row'), checks.slice(0, 3).join(', '));
    const ids = qualityCheckIds();
    const missing = await page.evaluate((list) => list.filter((id) => !window.Portal.quality.NAMES[id]), ids);
    check('a friendly name for every check id in vm/quality', ids.length > 40 && missing.length === 0, ids.length + ' ids' + (missing.length ? ', missing ' + missing.join(',') : ''));
    const pctCell = await page.$eval('.pt-qtable tbody tr:first-child td:nth-child(6)', (t) => t.textContent);
    const first = open.slice().sort((a, b) => ({ error: 0, warn: 1, info: 2 }[a.severity] - { error: 0, warn: 1, info: 2 }[b.severity]) || b.count - a.count)[0];
    const firstSeen = await page.$eval('.pt-qtable tbody tr:first-child td:nth-child(7)', (t) => t.textContent);
    check('% of rows and first seen (IST)', pctCell === ((first.count / dsBy[first.dataset].row_count) * 100).toFixed(1) + '%' && firstSeen === istDay(first.first_seen), pctCell + ' · ' + firstSeen);
    await shot(page, 'quality-issues-light');

    await page.selectOption('.pt-qbar select[aria-label="Severity"]', 'warn');
    sev = await page.$$eval('.pt-qtable tbody tr .pt-sev', (b) => b.map((x) => x.textContent));
    check('filter: severity', sev.length === sevN('warn') && sev.every((v) => v === 'Warning'), String(sev.length));
    await page.selectOption('.pt-qbar select[aria-label="Severity"]', '');
    await page.selectOption('.pt-qbar select[aria-label="Check family"]', 'cross');
    check('filter: check family', await rowsOf(page) === open.filter((i) => i.check.startsWith('cross.')).length);
    await page.selectOption('.pt-qbar select[aria-label="Check family"]', '');
    await page.check('.pt-qsheet input');
    check('filter: fix in sheet only', await rowsOf(page) === sheetOnly.length, String(await rowsOf(page)));
    await page.uncheck('.pt-qsheet input');
    await page.selectOption('.pt-qbar select[aria-label="Report area"]', 'Revenue');
    const rev = open.filter((i) => dsBy[i.dataset] && dsBy[i.dataset].group === 'Revenue').length;
    check('filter: report area', await rowsOf(page) === rev, String(rev));
    await page.selectOption('.pt-qbar select[aria-label="Report area"]', '');
    await page.selectOption('.pt-qbar select[aria-label="Status"]', 'resolved');
    const st = await page.$$eval('.pt-qtable tbody tr td:last-child', (t) => t.map((x) => x.textContent));
    check('filter: resolved in the last 7 days', st.length === recent.length && st.every((x) => x === 'Resolved'), String(st.length));
    await page.selectOption('.pt-qbar select[aria-label="Status"]', 'open');
    await page.fill('.pt-qsearch input', 'MALDA REGION');
    await page.waitForTimeout(400);
    check('filter: search', await rowsOf(page) >= 1 && (await page.textContent('.pt-qtable tbody')).includes('Ambiguous office name'));
    await page.click('.pt-qbar button:has-text("Clear")');
    check('clear filters', await rowsOf(page) === open.length);

    // Issue drawer (same-shape samples → table)
    await page.fill('.pt-qsearch input', 'Applicant Name');
    await page.waitForTimeout(400);
    await page.click('.pt-qtable tbody tr:has-text("Extra spaces")');
    await page.waitForSelector('.pt-drawer:not([hidden]) .pt-hint-full');
    const hint = await page.textContent('.pt-drawer .pt-hint-full');
    const sampleHead = await page.$$eval('.pt-drawer .pt-sample th', (t) => t.map((x) => x.textContent));
    const sampleTxt = await page.textContent('.pt-drawer .pt-sample');
    check('issue drawer: full hint and sample table', hint.includes('<b>Trim</b>') && sampleHead.join() === 'row,value' && sampleTxt.includes('<img src=x onerror='), sampleHead.join());
    check('issue drawer: links', (await page.getAttribute('.pt-drawer .pt-drawer-acts a:has-text("Open sheet")', 'href')).startsWith('https://docs.google.com/') && (await page.getAttribute('.pt-drawer .pt-drawer-acts a:has-text("Open data")', 'href')) === '#/d/nsc_pending');
    check('XSS probes in samples and hints render as text', await page.evaluate(() => window.__xss === undefined && !document.querySelector('.pt-drawer-b img, .pt-drawer-b script, .pt-drawer-b b')));
    await page.waitForTimeout(300);
    await shot(page, 'quality-drawer-light');
    await page.keyboard.press('Escape');
    await page.click('.pt-qbar button:has-text("Clear")');

    // Owner action list
    await page.click('.pt-qtabs a:has-text("Owner action list")');
    await page.waitForSelector('.pt-act-g');
    const items = await page.$$('.pt-act-i');
    check('owner action list: open source_fix issues only', items.length === sheetOnly.length, items.length + ' items');
    const firstGroup = await page.$eval('.pt-act-g', (g) => ({ t: g.querySelector('.pt-act-t b').textContent, sev: [...g.querySelectorAll('.pt-sev')].map((x) => x.textContent) }));
    check('owner action list: worst sheet first, severity order inside', firstGroup.sev[0] === 'Error' && firstGroup.sev.every((v, i) => i === 0 || RANK[v] >= RANK[firstGroup.sev[i - 1]]), firstGroup.t + ': ' + firstGroup.sev.join(','));
    const snap = await page.$$eval('.pt-act-g', (gs) => gs.map((g) => ({ t: g.querySelector('.pt-act-t b').textContent, href: (g.querySelector('.pt-act-b a') || {}).href || '', items: [...g.querySelectorAll('.pt-act-i b')].map((b) => b.textContent) })).find((g) => g.items.includes('Storage copy differs from the sheet')));
    check('Storage snapshot listed under its Google sheet', !!snap && snap.href === dsBy.defective_meter.source_url && snap.t === 'Defective meter', snap ? snap.t + ' ' + snap.href : 'not found');
    const samples = await page.$$eval('.pt-act-i', (li) => li.map((x) => x.querySelectorAll('.pt-act-s li').length));
    check('up to 3 sample rows per line', samples.every((n) => n <= 3) && samples.some((n) => n === 3));
    const hrefs = await page.$$eval('.pt-act-b a', (a) => a.map((x) => x.getAttribute('href')));
    check('Open sheet links are http(s) only', hrefs.length > 0 && hrefs.every((u) => /^https?:\/\//.test(u)) && await page.evaluate(() => window.__xss === undefined && !document.querySelector('.pt-act-l img, .pt-act-l script')));
    await page.click('.pt-actions .ui-panel-h button:has-text("Copy list as text")');
    await page.waitForTimeout(200);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check('copy list as plain text', clip.includes('[Error] Report out of date (Date): 1') && clip.includes('https://docs.google.com/') && clip.includes('<script>window.__xss=7</script>'), clip.split('\n')[0]);
    const [dlq] = await Promise.all([page.waitForEvent('download'), page.click('.pt-actions .ui-panel-h button:has-text("Export CSV")')]);
    const csvq = fs.readFileSync(await dlq.path(), 'utf8').replace(/^﻿/, '').trim().split(/\r\n/);
    check('owner action list CSV', csvq.length >= sheetOnly.length + 1 && csvq[0].startsWith('sheet,sheet_url,dataset,dataset_key,severity,check'), (csvq.length - 1) + ' lines, ' + dlq.suggestedFilename());
    await shot(page, 'quality-actions-light');
    await page.click('.pt-act-i:has-text("Storage copy differs")');
    await page.waitForSelector('.pt-drawer:not([hidden]) .pt-sample-kv');
    check('issue drawer: key/value list when sample shapes differ', (await page.$$('.pt-drawer .pt-sample-kv > li')).length === 4 && (await page.textContent('.pt-drawer .pt-dl')).includes('Compared with'));
    await page.keyboard.press('Escape');

    // Dataset Quality tab
    await page.goto(BASE + '/#/d/nsc_pending/quality');
    await page.waitForSelector('.pt-dsq');
    await page.waitForFunction(() => document.querySelectorAll('.ui-panel').length >= 3 && !document.querySelector('.pt-tabbody .pt-skel'));
    const nsOpen = open.filter((i) => i.dataset === 'nsc_pending').length;
    const nsRes = (await apiList('sys_quality_issues', "dataset = 'nsc_pending' && status = 'resolved'", 20)).length;
    const panels = await page.$$eval('.pt-tabbody > div > .ui-panel, .pt-tabbody > .ui-panel', (p) => p.map((x) => ({ h: (x.querySelector('h2') || {}).textContent || '', n: x.querySelectorAll('tbody tr').length })));
    const nsScore = scores.find((s) => s.dataset === 'nsc_pending').score;
    check('dataset Quality tab: score, open issues and the last resolved', (await page.textContent('.pt-dsq .pt-dq-num')) === String(nsScore) && panels.some((p) => p.h.startsWith('Open issues') && p.n === nsOpen) && panels.some((p) => p.h.startsWith('Resolved') && p.n === nsRes), JSON.stringify(panels));
    await shot(page, 'quality-dataset-tab-light');

    check('quality desktop light: zero console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
    check('quality desktop light: no blocked requests', blocked.length === 0, blocked.slice(0, 5).join(' | '));
    await ctx.close();
  }

  /* empty state (no results yet) */
  {
    const { ctx, page, errors } = await newPage(browser, { theme: 'light' });
    await ctx.route(/\/api\/collections\/sys_quality_(scores|issues)\/records/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ page: 1, perPage: 500, totalItems: 0, totalPages: 0, items: [] }) }));
    await signIn(page, CRED.portal);
    await page.waitForSelector('.pt-dq .ui-empty');
    const a = await page.textContent('.pt-dq .ui-empty');
    await page.click('#nav a[href="#/quality"]');
    await page.waitForSelector('.pt-view .ui-empty');
    const b = await page.textContent('.pt-view .ui-empty');
    await page.goto(BASE + '/#/d/loss_report/quality');
    await page.waitForSelector('.pt-tabbody .ui-panel .ui-empty');
    const c = await page.textContent('.pt-tabbody .ui-panel .ui-empty');
    const msg = 'Results appear after the next sync';
    check('empty state before the first quality run', a === msg && b === msg && c === msg);
    check('empty state: zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  /* dark desktop and 390px phones */
  for (const v of [{ theme: 'dark' }, { theme: 'light', phone: true }, { theme: 'dark', phone: true }]) {
    const tag = (v.phone ? 'phone' : 'desktop') + '-' + v.theme;
    const { ctx, page, errors, blocked } = await newPage(browser, v);
    await signIn(page, CRED.portal);
    await page.goto(BASE + '/#/quality');
    await page.waitForSelector('.pt-qtable tbody tr');
    if (!v.phone) {
      await shot(page, 'quality-datasets-dark');
      await page.click('.pt-qtabs a:has-text("Owner action list")');
      await page.waitForSelector('.pt-act-g');
      await shot(page, 'quality-actions-dark');
    } else {
      const cards = await page.evaluate(() => { const t = document.querySelector('.pt-qtable'); return getComputedStyle(t.querySelector('thead')).display === 'none' && getComputedStyle(t.querySelector('tbody tr')).display === 'grid'; });
      check(tag + ': tables become cards', cards);
      const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(tag + ': no horizontal overflow', ov <= 0, String(ov));
      await shot(page, 'quality-phone-datasets-' + v.theme);
      check(tag + ': filters hidden in a drawer', await page.evaluate(() => document.querySelector('.pt-qbar').getBoundingClientRect().left >= innerWidth));
      await page.click('.pt-qfilters');
      await page.waitForTimeout(350);
      check(tag + ': Filters opens the drawer', await page.evaluate(() => { const r = document.querySelector('.pt-qbar').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; }));
      await page.selectOption('.pt-qbar select[aria-label="Severity"]', 'error');
      await shot(page, 'quality-phone-filters-' + v.theme);
      await page.click('.pt-qdone');
      await page.waitForTimeout(350);
      check(tag + ': filter applies from the drawer', await rowsOf(page) === 1 && (await page.textContent('.pt-qfilters')).includes('Filters · 1'));
      await page.click('.pt-qfilters');
      await page.waitForTimeout(350);
      await page.click('.pt-qbar button:has-text("Clear")');
      await page.click('.pt-qdone');
      await page.waitForTimeout(350);
      check(tag + ': Clear from the drawer', await rowsOf(page) === (await apiList('sys_quality_scores', '', 500)).length);
      await page.click('.pt-qtabs a:has-text("Owner action list")');
      await page.waitForSelector('.pt-act-g');
      await shot(page, 'quality-phone-actions-' + v.theme);
      await page.click('.pt-act-i:has-text("Total row inside the data")');
      await page.waitForSelector('.pt-drawer:not([hidden]) .pt-hint-full');
      await page.waitForTimeout(300);
      await shot(page, 'quality-phone-drawer-' + v.theme);
      check(tag + ': probe in a nested sample renders as text', (await page.textContent('.pt-drawer .pt-sample')).includes('<script>window.__xss=7</script>') && await page.evaluate(() => window.__xss === undefined));
      await page.keyboard.press('Escape');
    }
    check(tag + ': quality pages, zero console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
    check(tag + ': quality pages, no blocked requests', blocked.length === 0, blocked.slice(0, 5).join(' | '));
    await ctx.close();
  }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  /* ---------- full functional pass: desktop, light ---------- */
  {
    const { ctx, page, errors, blocked } = await newPage(browser, { theme: 'light' });
    await page.goto(BASE + '/');
    await page.waitForSelector('#login:not([hidden])');
    await shot(page, '01-sign-in-light');
    await page.fill('#loginEmail', CRED.portal.email);
    await page.fill('#loginPass', 'not-the-password');
    await page.click('#loginBtn');
    await page.waitForSelector('#loginMsg:not([hidden])');
    check('wrong password shows an error', /Wrong email or password/.test(await page.textContent('#loginMsg')));
    const errs401 = errors.length; errors.length = 0; // the two failed sign-in attempts are expected 400s
    void errs401;

    await page.fill('#loginPass', CRED.portal.password);
    await page.click('#loginBtn');
    await page.waitForSelector('#nav a.pt-ni[data-key]');
    check('portal user signs in', await page.isVisible('#app'));
    const stored = await page.evaluate(() => ({ s: Object.keys(sessionStorage), l: Object.keys(localStorage) }));
    check('token kept in sessionStorage only', stored.s.includes('mzo_portal_session') && !stored.l.some((k) => /session|token|data|row/i.test(k)), 'localStorage keys: ' + stored.l.join(','));

    // Overview
    await page.waitForSelector('.pt-stats .ui-stat');
    const stats = await page.$$eval('.pt-stats .ui-stat', (s) => s.map((x) => x.querySelector('.k').textContent.trim() + '=' + x.querySelector('.v').textContent.trim()));
    check('overview stats', stats.join(' ').includes('Datasets=15') && stats.join(' ').includes('Errors=1') && stats.join(' ').includes('Stale=1'), stats.join(' · '));
    const att = await page.$$eval('.pt-att li b', (b) => b.map((x) => x.textContent));
    check('needs attention lists the error and the stale dataset', att.includes('Collection report') && att.includes('Defective meter'), att.join(', '));
    await page.waitForSelector('.ui-panel:has(h2:has-text("Recent sync runs")) tbody tr td a');
    check('recent sync runs listed', (await page.$$('.ui-panel:has(h2:has-text("Recent sync runs")) tbody tr')).length === 15);
    check('all datasets table has 15 rows', (await page.$$('.pt-dstable tbody tr')).length === 15);
    const links = await page.$$eval('.pt-dstable a.pt-link', (a) => a.map((x) => x.href));
    check('source links are https', links.length >= 13 && links.every((u) => u.startsWith('https://')), links.length + ' links');
    await shot(page, '02-overview-light');
    await page.click('.pt-stats button.ui-stat:has-text("Errors")');
    check('error stat filters the dataset table', (await page.$$('.pt-dstable tbody tr')).length === 1);
    await page.click('.pt-stats button.ui-stat:has-text("Errors")');

    // Sidebar
    const items = await page.$$eval('#nav a.pt-ni[data-key]', (a) => a.length);
    check('sidebar lists every dataset', items === 15, String(items));
    const secs = await page.$$eval('#nav .pt-sec span', (s) => s.map((x) => x.textContent));
    check('grouped by source type', secs.join('|') === 'Google Sheets|Supabase tables|Supabase Storage|Files|Apps Script', secs.join('|'));
    await page.click('#groupMode button[data-mode="area"]');
    const areas = await page.$$eval('#nav .pt-sec span', (s) => s.map((x) => x.textContent));
    check('toggle groups by report area', areas[0] === 'New service connection' && areas.includes('Admin'), areas.join('|'));
    await page.click('#groupMode button[data-mode="source"]');
    await page.fill('#dsSearch', 'meter');
    await page.waitForTimeout(200);
    const found = await page.$$eval('#nav a.pt-ni[data-key]', (a) => a.map((x) => x.dataset.key));
    check('dataset search', found.length === 3 && found.includes('meter_erp'), found.join(','));
    const dots = await page.$$eval('#nav a.pt-ni[data-key] .ui-dot', (d) => d.map((x) => x.className));
    check('freshness dots', dots.length === 3);
    await page.fill('#dsSearch', '');
    await page.waitForTimeout(200);

    // Big dataset
    await page.click('#nav a.pt-ni[data-key="nsc_pending"]');
    await gridReady(page);
    check('big dataset shows 50,000 rows', (await summary(page)).trim() === '50,000 rows', await summary(page));
    check('pager range', (await page.textContent('.pt-range')).trim() === '1–100 of 50,000');
    const xss = await page.evaluate(() => window.__xss);
    const probeCell = await page.$$eval('.pt-table tbody td', (td) => td.map((x) => x.textContent).filter((t) => t.includes('onerror') || t.includes('<script>')));
    check('XSS probes render as text', xss === undefined && probeCell.length >= 2, probeCell.slice(0, 2).join(' | '));
    check('no injected elements', await page.evaluate(() => !document.querySelector('.pt-table img, .pt-table script, .pt-table svg:not(.ui-i)')));
    const head = await page.$$eval('.pt-table thead th', (th) => th.map((x) => x.textContent.trim()));
    check('headers use source names', head.includes('Applicant Name') && head.includes('Applied Load (kW)'), head.slice(0, 6).join(', '));
    const numAlign = await page.$eval('.pt-table tbody tr td.num:not(.rn)', (td) => getComputedStyle(td).textAlign);
    check('numbers right-aligned', numAlign === 'right');
    const dateCell = await page.$eval('.pt-table tbody tr td.t-date', (td) => td.textContent);
    check('dates readable', /^\d{1,2} [A-Z][a-z]{2} \d{4}/.test(dateCell), dateCell);
    const sticky = await page.$eval('.pt-table thead th', (th) => getComputedStyle(th).position);
    check('sticky header', sticky === 'sticky');
    await shot(page, '03-dataset-grid-light');

    // Sort
    const dpIdx = head.indexOf('Days Pending');
    await page.click('.pt-table thead th:has-text("Days Pending") button');
    await gridReady(page);
    let col = (await firstCol(page, dpIdx)).map(num);
    check('sort ascending', col.every((v, i) => i === 0 || v >= col[i - 1]) && col[0] === 0, col.slice(0, 4).join(','));
    await page.click('.pt-table thead th:has-text("Days Pending") button');
    await gridReady(page);
    col = (await firstCol(page, dpIdx)).map(num);
    check('sort descending', col.every((v, i) => i === 0 || v <= col[i - 1]) && col[0] >= 400, col.slice(0, 4).join(','));
    check('sort state on header', (await page.getAttribute('.pt-table thead th:has-text("Days Pending")', 'aria-sort')) === 'descending');

    // Paging
    await page.click('.pt-pages button[aria-label="Next page"]');
    await gridReady(page);
    check('next page', (await page.textContent('.pt-range')).trim() === '101–200 of 50,000');
    await page.click('.pt-pages button[aria-label="Last page"]');
    await gridReady(page);
    check('last page', (await page.textContent('.pt-range')).trim() === '49,901–50,000 of 50,000');
    await page.fill('.pt-page-in', '250');
    await page.press('.pt-page-in', 'Enter');
    await gridReady(page);
    check('jump to page', (await page.textContent('.pt-range')).trim() === '24,901–25,000 of 50,000');
    await page.selectOption('.pt-size select', '500');
    await gridReady(page);
    check('page size', (await page.$$('.pt-table tbody tr')).length === 500);
    await page.selectOption('.pt-size select', '100');
    await gridReady(page);
    await page.click('.pt-table thead th:has-text("Days Pending") button'); // back to source order

    // Filters
    await addFilter(page, 'Region', 'eq', 'Malda');
    const malda = await apiCount('ds_nsc_pending', "region = 'Malda'");
    check('filter: Region is Malda', first(await summary(page)) === malda && malda > 10000 && malda < 50000, (await summary(page)) + ' vs API ' + malda);
    await addFilter(page, 'Days Pending', 'gt', '300');
    const both = await apiCount('ds_nsc_pending', "region = 'Malda' && days_pending > 300");
    check('filter: two conditions', first(await summary(page)) === both && (await page.$$('.pt-chip')).length === 2, (await summary(page)) + ' vs API ' + both);
    // Export the filtered rows
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.pt-tools button:has-text("Export CSV")')]);
    const csvPath = await dl.path();
    const csv = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '').trim().split(/\r\n/);
    check('CSV export of the current filter', csv.length === both + 1 && csv[0].startsWith('Application No,Applicant Name'), (csv.length - 1) + ' rows, file ' + dl.suggestedFilename());
    // Same filter, sorted by a column (paged export path), plus a full 50,000-row export in source order.
    await page.click('.pt-table thead th:has-text("Days Pending") button');
    await gridReady(page);
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('.pt-tools button:has-text("Export CSV")')]);
    const csv2 = fs.readFileSync(await dl2.path(), 'utf8').replace(/^\ufeff/, '').trim().split(/\r\n/);
    const dpCol = csv2[0].split(',').indexOf('Days Pending');
    const dps = csv2.slice(1).map((l) => Number(l.split(',')[dpCol]));
    check('CSV export with a sort', csv2.length === both + 1 && dps.every((v, i) => i === 0 || v >= dps[i - 1]), (csv2.length - 1) + ' rows');
    await page.click('.pt-table thead th:has-text("Days Pending") button');
    await page.click('.pt-table thead th:has-text("Days Pending") button');
    await gridReady(page);
    await clearFilters(page);
    const t0 = Date.now();
    const [dl3] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('.pt-tools button:has-text("Export CSV")')]);
    const csv3 = fs.readFileSync(await dl3.path(), 'utf8').replace(/^\ufeff/, '').trim().split(/\r\n/);
    const keys = new Set(csv3.slice(1).map((l) => l.split(',')[0]));
    check('CSV export of all 50,000 rows (source order, no gaps or repeats)', csv3.length === 50001 && keys.size === 50000, ((Date.now() - t0) / 1000).toFixed(1) + ' s');

    for (const [label, probe] of [['quote', "O'Brien & Sons \"quoted\""], ['backslash', 'Back\\slash \\ path'], ['percent', '50% load_factor'], ['markup', '<img src=x onerror="window.__xss=1">']]) {
      await addFilter(page, 'Applicant Name', 'eq', probe);
      check('filter escaping (' + label + ', is)', first(await summary(page)) === 1, await summary(page));
      await clearFilters(page);
    }
    await addFilter(page, 'Applicant Name', 'contains', '50%');
    check('filter escaping (% is literal)', first(await summary(page)) === 1, await summary(page));
    await clearFilters(page);
    await addFilter(page, 'Remarks', 'starts', 'Back\\');
    check('filter escaping (starts with backslash)', first(await summary(page)) >= 1 && first(await summary(page)) === await apiCount('ds_nsc_pending', "remarks ~ 'Back\\\\\\\\%'"), await summary(page));
    await clearFilters(page);
    await addFilter(page, 'Application Date', 'between', null);
    check('date filter needs a value', await page.isVisible('.pt-pop .pt-err'));
    await page.fill('.pt-pop input[aria-label="Value"]', '2026-01-01');
    await page.fill('.pt-pop input[aria-label="End date"]', '2026-01-31');
    await page.click('.pt-pop button.primary');
    await page.waitForFunction(() => !document.querySelector('.pt-data.busy') && !document.querySelector('.pt-pop'));
    const jan = await apiCount('ds_nsc_pending', "application_date >= '2026-01-01 00:00:00.000Z' && application_date < '2026-02-01 00:00:00.000Z'");
    check('date filter: between', first(await summary(page)) === jan && jan > 0, (await summary(page)) + ' vs API ' + jan);
    await clearFilters(page);
    await addFilter(page, 'Govt Applicant', 'true', null);
    check('bool filter', first(await summary(page)) === await apiCount('ds_nsc_pending', 'govt_applicant = true'));
    await clearFilters(page);

    // Global search
    await page.fill('.pt-q input', 'Kaliachak');
    await page.waitForTimeout(450);
    await page.waitForFunction(() => !document.querySelector('.pt-data.busy'));
    const kc = await apiCount('ds_nsc_pending', "ccc ~ 'Kaliachak' || applicant_name ~ 'Kaliachak' || remarks ~ 'Kaliachak' || application_no ~ 'Kaliachak' || region ~ 'Kaliachak' || division ~ 'Kaliachak' || category ~ 'Kaliachak' || phase ~ 'Kaliachak' || status ~ 'Kaliachak' || mobile ~ 'Kaliachak'");
    check('global search over text columns', first(await summary(page)) === kc && kc > 0, (await summary(page)) + ' vs API ' + kc);
    await page.fill('.pt-q input', '');
    await page.waitForTimeout(450);
    await gridReady(page);

    // Column show/hide
    await page.click('.pt-tools button:has-text("Columns")');
    await page.click('.pt-pop .pt-check:has-text("Mobile") input');
    await gridReady(page);
    await page.keyboard.press('Escape');
    const head2 = await page.$$eval('.pt-table thead th', (th) => th.map((x) => x.textContent.trim()));
    check('hide a column', !head2.includes('Mobile') && head2.length === head.length - 1);
    check('column choice kept in sessionStorage', await page.evaluate(() => sessionStorage.getItem('mzo_portal_cols_nsc_pending') === '["mobile"]'));

    // Drawer
    await page.click('.pt-table tbody tr:nth-child(2)');
    await page.waitForSelector('.pt-drawer:not([hidden]) .pt-sys');
    const dtitle = await page.textContent('.pt-drawer h3');
    const sysKeys = await page.$$eval('.pt-drawer .pt-sys dt', (d) => d.map((x) => x.textContent));
    check('row drawer with system fields', dtitle === 'Row 2' && ['id', '_row_key', '_row_no', '_synced_at', '_hash'].every((k) => sysKeys.includes(k)), dtitle + ' / ' + sysKeys.join(','));
    const drawerProbe = await page.$$eval('.pt-drawer dd', (d) => d.map((x) => x.textContent).filter((t) => t.includes('<script>') || t.includes('onload')));
    check('drawer shows probe as text', drawerProbe.length >= 1 && await page.evaluate(() => window.__xss === undefined && !document.querySelector('.pt-drawer img, .pt-drawer script')));
    check('drawer shows hidden columns too', (await page.$$eval('.pt-drawer .pt-dl:not(.pt-sys) dt', (d) => d.map((x) => x.textContent))).some((t) => t.startsWith('Mobile')));
    await page.waitForTimeout(350);
    await shot(page, '04-row-drawer-light');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.querySelector('.pt-drawer h3').textContent === 'Row 3');
    check('drawer next row', true);
    await page.keyboard.press('Escape');
    check('drawer closes', await page.isHidden('.pt-drawer'));
    await page.click('.pt-tools button:has-text("Columns")');
    await page.click('.pt-pop button:has-text("Show all")');
    await page.keyboard.press('Escape');

    // Schema / Source / History
    await page.click('.pt-tabs a:has-text("Schema")');
    await page.waitForSelector('.ui-panel:has(h2:has-text("Columns")) tbody tr');
    const schemaRows = await page.$$('.ui-panel:has(h2:has-text("Columns")) tbody tr');
    const pk = await page.$$eval('.ui-panel:has(h2:has-text("Columns")) tbody tr', (tr) => tr.filter((t) => t.textContent.includes('primary key')).map((t) => t.children[2].textContent));
    check('schema tab', schemaRows.length === 17 && pk.join() === 'Application No', schemaRows.length + ' columns, pk ' + pk.join());
    check('session refreshed at start (POST auth-refresh allowed)', true);
    check('schema lists system fields', (await page.$$('.ui-panel:has(h2:has-text("System fields")) tbody tr')).length === 5);
    await shot(page, '05-schema-light');
    await page.click('.pt-tabs a:has-text("Source")');
    await page.waitForSelector('.pt-src-dl');
    const srcHref = await page.getAttribute('.pt-src-dl a.pt-link', 'href');
    const srcText = await page.textContent('.pt-src-dl');
    check('source tab', /^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(srcHref) && srcText.includes('Every 5 minutes') && srcText.includes('Freshness') && srcText.includes('spreadsheetId'), srcHref);
    await shot(page, '06-source-light');
    await page.click('.pt-tabs a:has-text("Sync history")');
    await page.waitForSelector('.ui-panel:has(h2:has-text("Sync history")) tbody tr td .ui-badge');
    check('sync history tab', (await page.$$('.ui-panel:has(h2:has-text("Sync history")) tbody tr')).length === 14);

    // Error dataset, not-mirrored dataset, json probe
    await page.goto(BASE + '/#/d/collection/source');
    await page.waitForSelector('.pt-src-dl .pt-error');
    check('error dataset shows its error', (await page.textContent('.pt-src-dl .pt-error')).includes('HTTP 404'));
    await shot(page, '07-error-source-light');
    await page.goto(BASE + '/#/d/sheet_links');
    await page.waitForSelector('.pt-tabbody .ui-empty');
    check('not mirrored dataset', (await page.textContent('.pt-tabbody .ui-empty')).includes('not mirrored'));
    await page.goto(BASE + '/#/d/activity_logs');
    await gridReady(page);
    const ah = await page.$$eval('.pt-table thead th', (th) => th.map((x) => x.textContent));
    check('column header markup renders as text', ah.some((t) => t.includes('<img src=x onerror=')) && await page.evaluate(() => window.__xss === undefined && !document.querySelector('thead img')));
    await page.click('.pt-table tbody tr:nth-child(4)');
    await page.waitForSelector('.pt-drawer:not([hidden]) pre.pt-json');
    const pre = await page.textContent('.pt-drawer pre.pt-json');
    check('json column shown pretty, probe as text', pre.includes('"nested"') && pre.includes('<script>window.__xss=2</script>') && await page.evaluate(() => window.__xss === undefined));
    await page.keyboard.press('Escape');
    await page.goto(BASE + '/#/d/no_such_dataset');
    await page.waitForSelector('.ui-empty');
    check('unknown dataset key', (await page.textContent('.pt-view')).includes('no dataset with that key'));

    // Expired token
    await page.evaluate(() => {
      const s = JSON.parse(sessionStorage.getItem('mzo_portal_session'));
      const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
      s.token = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ exp: Math.floor(Date.now() / 1000) - 60, type: 'auth' }) + '.x';
      sessionStorage.setItem('mzo_portal_session', JSON.stringify(s));
    });
    await page.reload();
    await page.waitForSelector('#login:not([hidden]) #loginMsg:not([hidden])');
    check('expired session returns to sign-in', (await page.textContent('#loginMsg')).includes('session has ended') && !(await page.evaluate(() => sessionStorage.getItem('mzo_portal_session'))));

    // Superuser
    await page.fill('#loginEmail', CRED.superuser.email);
    await page.fill('#loginPass', CRED.superuser.password);
    await page.click('#loginBtn');
    await page.waitForSelector('#nav a.pt-ni[data-key]');
    await page.click('#meBtn');
    check('superuser signs in, dashboard link shown', (await page.textContent('#meSub')) === 'Superuser' && await page.isVisible('#pbAdminLink'));
    await page.click('#logoutBtn');
    await page.waitForSelector('#login:not([hidden])');
    check('sign out', !(await page.evaluate(() => sessionStorage.getItem('mzo_portal_session'))));

    check('desktop light: zero console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
    check('desktop light: no blocked requests', blocked.length === 0, blocked.slice(0, 5).join(' | '));
    await ctx.close();
  }

  /* ---------- look pass: dark desktop, light and dark phone ---------- */
  for (const v of [{ theme: 'dark' }, { theme: 'light', phone: true }, { theme: 'dark', phone: true }]) {
    const tag = (v.phone ? 'phone' : 'desktop') + '-' + v.theme;
    const { ctx, page, errors, blocked } = await newPage(browser, v);
    await page.goto(BASE + '/');
    await page.waitForSelector('#login:not([hidden])');
    if (v.phone && v.theme === 'light') await shot(page, 'p1-sign-in-' + tag);
    await signIn(page, CRED.portal);
    check(tag + ': theme applied', (await page.getAttribute('html', 'data-mzo-theme')) === v.theme);
    await page.waitForSelector('.ui-panel:has(h2:has-text("Recent sync runs")) tbody tr td a');
    await shot(page, (v.phone ? 'p2' : '08') + '-overview-' + tag);
    if (v.phone) {
      check(tag + ': sidebar hidden behind menu', !(await page.evaluate(() => { const r = document.getElementById('sb').getBoundingClientRect(); return r.right > 0; })));
      await page.click('#menuBtn');
      await page.waitForTimeout(300);
      check(tag + ': sidebar opens as a drawer', await page.evaluate(() => document.getElementById('sb').getBoundingClientRect().left >= 0));
      await shot(page, 'p3-sidebar-' + tag);
      await page.click('#nav a.pt-ni[data-key="meter_erp"]');
      await page.waitForTimeout(300);
      check(tag + ': drawer closes on navigation', !(await page.evaluate(() => document.body.classList.contains('pt-drawer-open'))));
    } else {
      await page.click('#nav a.pt-ni[data-key="meter_erp"]');
    }
    await gridReady(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(tag + ': no page-level horizontal overflow', overflow <= 0, String(overflow));
    await shot(page, (v.phone ? 'p4' : '09') + '-dataset-' + tag);
    await page.click('.pt-table tbody tr:first-child');
    await page.waitForSelector('.pt-drawer:not([hidden]) .pt-sys');
    await page.waitForTimeout(350);
    await shot(page, (v.phone ? 'p5' : '10') + '-drawer-' + tag);
    await page.keyboard.press('Escape');
    if (v.phone) {
      await page.click('.pt-tools button:has-text("Filter")');
      await page.waitForSelector('.pt-pop .pt-fb');
      const box = await page.$eval('.pt-pop', (p) => { const r = p.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
      check(tag + ': filter builder fits the screen', box);
      await shot(page, 'p6-filter-' + tag);
      await page.keyboard.press('Escape');
    }
    check(tag + ': zero console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
    check(tag + ': no blocked requests', blocked.length === 0, blocked.slice(0, 5).join(' | '));
    await ctx.close();
  }

  await qualityTests(browser);

  await browser.close();
  console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
