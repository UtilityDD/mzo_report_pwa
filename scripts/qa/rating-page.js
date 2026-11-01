#!/usr/bin/env node
/* Browser checks for performance_index.html (the office rating page).
 *
 *   node scripts/qa/rating-page.js --base http://127.0.0.1:3960 [--doc docs/rating/sample-rating.json] [--shots <dir>] [--only admin,ccc]
 *
 * The page is served by scripts/qa/serve-local.sh. Its data comes from GET /api/data/rating, answered
 * here with --doc (a ratingDoc; the mirror manifest is stubbed so the page takes its VM path).
 * For each login (admin, a region user, a CCC user) at desktop and phone width, in light and dark:
 * every tab, sorting, search, the scorecard (parents, children), deep links, CSV export, the dev
 * sample flag, and an XSS document whose office names carry markup. Fails on any console error,
 * page error, failed request, non-GET request, or injected markup.
 * Session: the forged local test cookie (secret: env QA_JWT_SECRET or the dev fallback).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; }
const BASE = arg('base', 'http://127.0.0.1:3960');
const ROOT = path.join(__dirname, '..', '..');
const DOC = arg('doc', path.join(ROOT, 'docs/rating/sample-rating.json'));
const SHOTS = arg('shots', '');
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
function loadPlaywright() {
  for (const t of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core', 'playwright']) { if (!t) continue; try { return require(t); } catch (_) {} }
  const npx = path.join(require('os').homedir(), '.npm', '_npx');
  for (const d of fs.existsSync(npx) ? fs.readdirSync(npx) : []) { const p = path.join(npx, d, 'node_modules', 'playwright-core'); if (fs.existsSync(path.join(p, 'package.json'))) return require(p); }
  throw new Error('playwright-core not found');
}
const { chromium } = loadPlaywright();

const PROFILES = {
  admin: { Username: 'local-preview', Name: 'Local Preview', role: 'admin', office_level: 'CE' },
  region: { Username: 'qa-raiganj', Name: 'QA Raiganj', role: 'user', region_code: 'Raiganj' },
  ccc: { Username: 'qa-gazole-ccc', Name: 'QA Gazole CCC', role: 'user', ccc_code: '6613101' }
};
const VIEWPORTS = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } };

function cookie(profile) {
  const secret = process.env.QA_JWT_SECRET || 'mzo-portal-super-secret-key-123456';
  const payload = Buffer.from(JSON.stringify({ profile, expiry: Date.now() + 6 * 3600e3 })).toString('base64');
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64');
}

const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: detail || '' }); if (!ok) console.log('FAIL', name, detail || ''); }

async function context(browser, who, vp, theme, docBody, opts) {
  opts = opts || {};
  const ctx = await browser.newContext(Object.assign({ viewport: { width: VIEWPORTS[vp].width, height: VIEWPORTS[vp].height }, acceptDownloads: true, reducedMotion: 'reduce' }, vp === 'phone' ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}));
  const host = new URL(opts.base || BASE).hostname;
  await ctx.addCookies([{ name: 'mzo_session', value: cookie(PROFILES[who]), domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  const version = await fetch(BASE + '/version.json').then((r) => r.json()).then((j) => j.version).catch(() => '');
  await ctx.addInitScript(({ profile, version, theme }) => {
    try {
      localStorage.setItem('mzo_user_profile', JSON.stringify(profile));
      localStorage.setItem('mzo_authenticated', 'true');
      if (version) localStorage.setItem('mzo_app_version', version);
      localStorage.setItem('theme', theme); localStorage.setItem('mzo_theme', theme);
    } catch (_) {}
  }, { profile: PROFILES[who], version, theme });
  const bad = [];
  await ctx.route('**/*', async (r) => {
    const req = r.request(), url = req.url();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { bad.push(req.method() + ' ' + url); return r.abort('blockedbyclient'); }
    if (/script\.google(usercontent)?\.com/.test(url)) { bad.push('apps-script ' + url); return r.abort('blockedbyclient'); }
    const u = new URL(url);
    if (!opts.base && u.origin === new URL(BASE).origin && u.pathname === '/api/data/manifest') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ generatedAt: '2026-11-01T08:30:00Z', datasets: {} }) });
    if (u.pathname === '/api/data/rating') return docBody == null ? r.fulfill({ status: 204, body: '' }) : r.fulfill({ status: 200, contentType: 'application/json', body: docBody });
    if (opts.noEngine && u.pathname === '/lib/rating_metrics.js') return r.fulfill({ status: 200, contentType: 'text/javascript', body: '/* stub: no metrics layer */' });
    if (opts.base && u.origin === new URL(opts.base).origin) return r.continue();
    if (u.origin !== new URL(BASE).origin) { bad.push('external ' + url); return r.abort('blockedbyclient'); }
    return r.continue();
  });
  ctx.__bad = bad;
  return ctx;
}

async function open(ctx, query) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => { const f = r.failure(); if (!/blockedbyclient|ERR_ABORTED/.test(f && f.errorText || '')) errors.push('requestfailed: ' + r.url() + ' ' + (f && f.errorText)); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push('http ' + r.status() + ' ' + r.url()); });
  await page.goto(BASE + '/performance_index.html' + (query || ''), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#view table, #view .pi-method, #view .ui-empty:not(:empty)') && !/Loading/.test(document.getElementById('meta').textContent), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(250);
  page.__errors = errors;
  return page;
}
async function shot(page, name, full) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: !!full });
}
const txt = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');

async function run() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const docText = fs.readFileSync(DOC, 'utf8');
  const doc = JSON.parse(docText);
  const zone = doc.offices[doc.zone];
  const nOf = (lv) => doc.levels[lv].order.length;
  const firstCcc = doc.levels.ccc.order[0];

  for (const who of Object.keys(PROFILES)) {
    if (ONLY.length && !ONLY.includes(who)) continue;
    for (const vp of Object.keys(VIEWPORTS)) {
      for (const theme of ['light', 'dark']) {
        const tag = who + '-' + vp + '-' + theme;
        const ctx = await context(browser, who, vp, theme, docText);
        const page = await open(ctx, '');
        check(tag + ' theme', (await page.getAttribute('html', 'data-mzo-theme')) === theme);
        const tabs = await page.$$eval('#tabs [data-k]', (b) => b.map((x) => x.textContent.trim()));
        check(tag + ' level tabs', tabs.join('|') === ['Regions' + nOf('region'), 'Divisions' + nOf('division'), 'CCCs' + nOf('ccc'), 'Methodology'].join('|'), tabs.join('|'));
        const zoneTxt = await txt(page, '#strip .ui-stat');
        check(tag + ' zone grade', zoneTxt.indexOf(zone.grade) >= 0 && zoneTxt.indexOf((Math.round(zone.score * 10) / 10).toFixed(1)) >= 0, zoneTxt);
        const meta = await txt(page, '#meta');
        check(tag + ' as-on line', /Inputs as on/.test(meta) && /How is this calculated|How it is scored/.test(meta + (await txt(page, '.ui-head'))), meta);
        // Default level: the login's own level (admin: regions).
        const startLevel = who === 'ccc' ? 'ccc' : 'region';
        const sel = await page.$eval('#tabs [aria-selected="true"]', (b) => b.getAttribute('data-k')).catch(() => '');
        check(tag + ' start level', sel === startLevel, sel);
        const rowsN = await page.$$eval('#view tbody tr[data-code]', (r) => r.length);
        check(tag + ' rows at start', rowsN === nOf(startLevel), String(rowsN));
        if (who !== 'admin') {
          const mineRow = await page.$eval('#view tbody tr.mine', (r) => r.getAttribute('data-code')).catch(() => '');
          const want = who === 'ccc' ? '6613101' : '6620000';
          check(tag + ' own office highlighted', mineRow === want, mineRow);
          check(tag + ' own office note', /Your office/.test(await txt(page, '#mzo-scope-banner')));
          check(tag + ' no "set by admin" banner', !/set by admin/.test(await page.textContent('body')));
        }
        await shot(page, tag + '-1-start', vp === 'desktop');

        // Every level, sorting and search.
        for (const lv of ['region', 'division', 'ccc']) {
          await page.click('#tabs [data-k="' + lv + '"]');
          await page.waitForTimeout(80);
          const n = await page.$$eval('#view tbody tr[data-code]', (r) => r.length);
          check(tag + ' ' + lv + ' rows', n === nOf(lv), String(n));
          const firstRank = await txt(page, '#view tbody tr[data-code] .pi-rank');
          check(tag + ' ' + lv + ' rank n/N', new RegExp('^1/' + doc.levels[lv].of + '$').test(firstRank), firstRank);
          const firstGrade = await txt(page, '#view tbody tr[data-code] .pi-grade');
          check(tag + ' ' + lv + ' grade text', /^Grade (A\+|A|B\+|B|C\+|C|D)$/.test(firstGrade), firstGrade);
        }
        if (vp === 'desktop') {
          await page.click('#view th[data-sort="score"]');
          let s = await page.$$eval('#view tbody tr[data-code] .pi-score b', (b) => b.map((x) => +x.textContent));
          check(tag + ' sort score descending', s.length > 2 && s.every((v, i) => !i || s[i - 1] >= v), s.slice(0, 3).join(','));
          await page.click('#view th[data-sort="score"]');
          s = await page.$$eval('#view tbody tr[data-code] .pi-score b', (b) => b.map((x) => +x.textContent));
          check(tag + ' sort score toggles to ascending', s.length > 2 && s.every((v, i) => !i || s[i - 1] <= v), s.slice(0, 3).join(','));
          await page.click('#view th[data-sort="name"]');
          s = await page.$$eval('#view tbody tr[data-code] .pi-off', (b) => b.map((x) => x.firstChild.textContent));
          check(tag + ' sort by name', s.join() === s.slice().sort((a, b) => a.localeCompare(b, 'en')).join(), s.slice(0, 3).join(','));
          await page.click('#strip button.ui-stat:nth-child(2)');
          const pressed = await page.$eval('#strip button.ui-stat:nth-child(2)', (b) => b.getAttribute('aria-pressed'));
          check(tag + ' pillar stat sorts', pressed === 'true');
          await page.click('#strip button.ui-stat:nth-child(2)');
        }
        await page.fill('#q', 'gaz');
        await page.waitForTimeout(250);
        const qn = await page.$$eval('#view tbody tr[data-code]', (r) => r.map((x) => x.getAttribute('data-code')));
        check(tag + ' search', qn.length >= 1 && qn.every((c) => /gaz/i.test(doc.offices[c].name + doc.offices[c].division)), qn.join(','));
        check(tag + ' search in url', /[?&]q=gaz/.test(page.url()));
        await page.fill('#q', '');
        await page.waitForTimeout(250);
        await page.selectOption('#within', '6620000');
        await page.waitForTimeout(80);
        const wn = await page.$$eval('#view tbody tr[data-code]', (r) => r.map((x) => x.getAttribute('data-code')));
        check(tag + ' within region', wn.length > 0 && wn.every((c) => doc.offices[c].path.region === '6620000'), wn.join(','));
        await page.selectOption('#within', '');
        await shot(page, tag + '-2-ccc', vp === 'desktop');

        // CSV export of the current level.
        if (vp === 'desktop' && theme === 'light') {
          const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
          const p = await dl.path();
          const csv = fs.readFileSync(p, 'utf8').replace(/^﻿/, '').trim().split('\n');
          check(tag + ' csv rows', csv.length === nOf('ccc') + 1 && /^Rank,Of,Office,Code/.test(csv[0]), csv.length + ' ' + csv[0].slice(0, 40));
        }

        // Scorecard: open the first CCC, parents and children.
        await page.click('#view tbody tr[data-code="' + firstCcc + '"]');
        await page.waitForSelector('#scorecard:not([hidden])');
        check(tag + ' scorecard title', (await txt(page, '#scTitle')).indexOf(doc.offices[firstCcc].name) === 0);
        check(tag + ' scorecard url', new URL(page.url()).searchParams.get('office') === firstCcc);
        const sec = await page.$$eval('#scBody h4', (h) => h.map((x) => x.firstChild.textContent));
        check(tag + ' scorecard sections', ['Why this grade', 'What would move it up', 'Pillar breakdown'].every((s) => sec.includes(s)), sec.join('|'));
        const params = await page.$$eval('#scBody .pi-param', (p) => p.length);
        const want = doc.offices[firstCcc].pillars.reduce((s, p) => s + p.params.length, 0);
        check(tag + ' every parameter shown', params === want, params + ' of ' + want);
        const methodLinks = await page.$$eval('#scBody .pi-param a[href*="param="]', (a) => a.length);
        check(tag + ' parameter links to methodology', methodLinks === want, String(methodLinks));
        if (vp === 'phone') {
          const w = await page.$eval('#scorecard > section', (s) => s.getBoundingClientRect().width);
          check(tag + ' scorecard full width', Math.abs(w - 390) < 2, String(w));
        }
        await shot(page, tag + '-3-scorecard', false);
        if (vp === 'desktop' && theme === 'light') {
          const tall = await page.$eval('#scorecard > section', (s) => s.scrollHeight);
          await page.setViewportSize({ width: 1280, height: Math.min(tall + 10, 9000) });
          await shot(page, tag + '-3b-scorecard-full', false);
          await page.setViewportSize({ width: 1280, height: 900 });
        }
        // Parent (division) from the trail, then its children and contributions.
        await page.click('#scBody .pi-trail button >> nth=2');
        await page.waitForTimeout(80);
        const divCode = doc.offices[firstCcc].path.division;
        check(tag + ' parent link', new URL(page.url()).searchParams.get('office') === divCode, page.url());
        const kids = await page.$$eval('#scBody .pi-kids tbody tr', (r) => r.length);
        check(tag + ' children listed', kids === doc.offices[divCode].children.length, String(kids));
        await shot(page, tag + '-4-division', false);
        await page.keyboard.press('Escape');
        check(tag + ' escape closes', await page.$eval('#scorecard', (d) => d.hidden));
        check(tag + ' office cleared from url', !new URL(page.url()).searchParams.get('office'));

        // Methodology tab.
        await page.click('#tabs [data-k="methodology"]');
        await page.waitForSelector('#view .pi-method');
        const mt = await page.textContent('#view .pi-method');
        check(tag + ' methodology bands', doc.bands.every((b) => mt.indexOf(b.label) >= 0));
        check(tag + ' methodology parameters', doc.methodology.every((m) => mt.indexOf(m.label) >= 0));
        check(tag + ' methodology no .md link', !(await page.$('a[href$=".md"]')));
        await shot(page, tag + '-5-method', vp === 'desktop' && theme === 'light');
        check(tag + ' no bad requests', !ctx.__bad.length, ctx.__bad.join(' | '));
        check(tag + ' no console errors', !page.__errors.length, page.__errors.join(' | '));
        await page.close();

        // Deep links.
        if (theme === 'light') {
          const links = [
            ['?level=ccc&office=6613101', async (p) => (await txt(p, '#scTitle')).indexOf('Gazole') === 0 && (await p.$eval('#tabs [aria-selected="true"]', (b) => b.getAttribute('data-k'))) === 'ccc'],
            ['?level=division&within=6610000', async (p) => (await p.$$eval('#view tbody tr[data-code]', (r) => r.map((x) => x.getAttribute('data-code')))).every((c) => doc.offices[c].path.region === '6610000')],
            ['?tab=methodology', async (p) => !!(await p.$('#view .pi-method'))],
            ['?office=' + doc.zone, async (p) => (await txt(p, '#scTitle')) === zone.name],
            ['#tab=method&param=atc_loss', async (p) => !!(await p.$('#view .pi-method')) && (await p.$eval('[data-param="atc_loss"]', (e) => e.classList.contains('hit')).catch(() => false))],
            ['?tab=method&param=atc_loss', async (p) => !!(await p.$('#view .pi-method')) && (await p.$eval('[data-param="atc_loss"]', (e) => e.classList.contains('hit')).catch(() => false))]
          ];
          for (const [q, test] of links) {
            const p = await open(ctx, q);
            check(tag + ' deep link ' + q, await test(p));
            check(tag + ' deep link ' + q + ' no console errors', !p.__errors.length, p.__errors.join(' | '));
            if (q.indexOf('param') > 0) await shot(p, tag + '-6-param-link', false);
            await p.close();
          }
        }
        await ctx.close();
      }
    }
  }

  // Inside the workstation shell (app.html): the page loads in its frame, with no errors from that frame.
  if (!ONLY.length || ONLY.includes('shell')) {
    for (const vp of ['desktop', 'phone']) {
      const ctx = await context(browser, 'ccc', vp, 'dark', docText);
      const page = await ctx.newPage();
      const errs = [];
      page.on('console', (m) => { if (m.type() === 'error' && /performance_index/.test((m.location() || {}).url || '')) errs.push(m.text()); });
      page.on('pageerror', (e) => { if (/performance_index/.test(e.stack || '')) errs.push(e.message); });
      await page.goto(BASE + '/app.html#performance_index', { waitUntil: 'domcontentloaded' });
      let frame = null;
      for (let i = 0; i < 100 && !frame; i++) { frame = page.frames().find((f) => /performance_index\.html/.test(f.url())); if (!frame) await page.waitForTimeout(200); }
      check('shell ' + vp + ' frame', !!frame);
      if (frame) {
        await frame.waitForSelector('#view tbody tr[data-code]', { timeout: 30000 }).catch(() => {});
        const n = await frame.$$eval('#view tbody tr[data-code]', (r) => r.length).catch(() => 0);
        check('shell ' + vp + ' ranking', n === nOf('ccc'), String(n));
        const mineRow = await frame.$eval('#view tbody tr.mine', (r) => r.getAttribute('data-code')).catch(() => '');
        check('shell ' + vp + ' own office', mineRow === '6613101', mineRow);
        const inShell = await frame.evaluate(() => document.documentElement.classList.contains('mzo-in-shell'));
        check('shell ' + vp + ' in shell', inShell);
        await frame.click('#view tbody tr[data-code="6613101"]');
        await frame.waitForSelector('#scorecard:not([hidden])').catch(() => {});
        await page.waitForTimeout(200);
        await shot(page, 'shell-' + vp + '-dark-scorecard', false);
      }
      check('shell ' + vp + ' no errors from the page', !errs.length, errs.join(' | '));
      await ctx.close();
    }
  }

  // Dev sample flag (localhost only) and the no-data state.
  {
    const ctx = await context(browser, 'admin', 'desktop', 'light', null);
    let p = await open(ctx, '?sample=1');
    check('sample flag on localhost', /Sample data/.test(await txt(p, '.ui-head')) && (await p.$$eval('#view tbody tr[data-code]', (r) => r.length)) > 0);
    check('sample no console errors', !p.__errors.length, p.__errors.join(' | '));
    await shot(p, 'admin-desktop-light-7-sample', false);
    await p.close();
    await p.close();
    await ctx.close();
  }
  // No precompute and no metrics layer: a plain message, never the sample, no console errors.
  {
    const ctx = await context(browser, 'admin', 'desktop', 'light', null, { noEngine: true });
    const p = await open(ctx, '');
    const empty = await txt(p, '#view .ui-empty');
    check('no rating: a plain message, no sample', empty.length > 0 && !/Sample/.test(await txt(p, '.ui-head')) && !(await p.$('#view tbody tr[data-code]')), empty);
    check('no rating: no console errors', !p.__errors.length, p.__errors.join(' | '));
    await p.close();
    await ctx.close();
  }
  // Computed in the browser (--compute <mirror-mode base>): no precompute, so the page rates the offices itself.
  const COMPUTE = arg('compute', '');
  if (COMPUTE) {
    const ctx = await context(browser, 'ccc', 'desktop', 'light', null, { base: COMPUTE });
    const page = await ctx.newPage();
    const errors = [], dataLayer = [], http = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('response', (r) => { if (r.status() >= 400) (/\/(schema\/|api\/data\/rows\/)/.test(r.url()) ? dataLayer : http).push(r.status() + ' ' + r.url()); });
    const t0 = Date.now();
    await page.goto(COMPUTE + '/performance_index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#view tbody tr[data-code]', { timeout: 180000 }).catch(() => {});
    const ms = Date.now() - t0;
    const n = await page.$$eval('#view tbody tr[data-code]', (r) => r.length).catch(() => 0);
    check('browser-computed: ranking (' + ms + ' ms)', n === 41, String(n));
    check('browser-computed: says so', /computed in this browser/.test(await txt(page, '#meta')), await txt(page, '#meta'));
    check('browser-computed: own office highlighted', (await page.$eval('#view tbody tr.mine', (r) => r.getAttribute('data-code')).catch(() => '')) === '6613101');
    // 404s for schemas or rows files missing from this build belong to the data layer (MzoRows), not the page.
    const own = errors.filter((e) => !/status of 404/.test(e));
    const n404 = errors.length - own.length;
    check('browser-computed: no errors outside the data layer', !own.length && !http.length && n404 <= dataLayer.length, own.concat(http).slice(0, 5).join(' | '));
    if (dataLayer.length) console.log('INFO browser path: ' + dataLayer.length + ' data-layer 404s (schemas or rows not in this build): ' + dataLayer.slice(0, 6).join(', '));
    await shot(page, 'ccc-desktop-light-9-browser-computed', false);
    await ctx.close();
  }

  // XSS: office names, reasons and texts carrying markup must stay text.
  {
    const evil = JSON.parse(docText);
    const bad = '<img src=x onerror="window.__xss=1">"\'><script>window.__xss=2</script>';
    Object.values(evil.offices).forEach((o) => {
      o.name = o.name + bad; o.division = (o.division || '') + bad; o.why = (o.why || []).concat([bad]);
      o.pillars.forEach((pl) => pl.params.forEach((x) => { x.display = bad; x.detail = bad; x.naReason = x.naReason && x.naReason + bad; (x.notes || []).push({ flag: 'x', text: bad }); }));
      (o.improve || []).forEach((i) => { i.label = bad; i.fromDisplay = bad; });
      Object.values(o.contributions || {}).forEach((c) => { c.label = bad; c.rows.forEach((r) => { r.name = bad; }); });
    });
    evil.methodology.forEach((m) => { m.label += bad; m.formula = bad; m.ref = bad; });
    if (evil.method) {
      const M = evil.method;
      M.intro = (M.intro || []).concat([bad]); M.title = bad; M.formula = bad;
      (M.pillars || []).forEach((p) => { p.label += bad; p.basis = bad; (p.params || []).forEach((x) => { x.label += bad; x.formula = bad; x.source = { key: 'X', label: bad, url: 'javascript:window.__xss=3' }; x.datasets = [{ key: 'k', label: bad, page: 'javascript:window.__xss=4' }]; x.notes = [bad]; }); });
      (M.caveats || []).forEach((c) => { c.text = bad; });
      (M.excluded || []).forEach((c) => { c.item = bad; c.reason = bad; });
      (M.sources || []).forEach((s) => { s.label = bad; s.url = 'javascript:window.__xss=5'; });
      if (M.example) { M.example.name = bad; (M.example.pillars || []).forEach((p) => (p.params || []).forEach((x) => { x.label = bad; x.display = bad; })); }
    }
    Object.keys(evil.rules).forEach((k) => { evil.rules[k] += bad; });
    const ctx = await context(browser, 'admin', 'desktop', 'dark', JSON.stringify(evil));
    const p = await open(ctx, '?level=ccc&office=' + firstCcc);
    await p.click('#scBody .pi-trail button >> nth=1').catch(() => {});
    await p.waitForTimeout(100);
    await p.keyboard.press('Escape');
    await p.click('#tabs [data-k="methodology"]');
    await p.waitForTimeout(150);
    const injected = await p.evaluate(() => ({ xss: window.__xss || 0, imgs: document.querySelectorAll('img').length, scripts: [].filter.call(document.scripts, (s) => /__xss/.test(s.textContent)).length, jsLinks: [].filter.call(document.querySelectorAll('a[href]'), (a) => /^\s*javascript:/i.test(a.getAttribute('href'))).length }));
    check('xss: markup stays text', !injected.xss && !injected.imgs && !injected.scripts && !injected.jsLinks, JSON.stringify(injected));
    check('xss: names shown as text', /<img src=x/.test(await p.textContent('body')));
    await shot(p, 'admin-desktop-dark-8-xss', false);
    await p.close();
    await ctx.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(results.length - failed.length + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(2); });
