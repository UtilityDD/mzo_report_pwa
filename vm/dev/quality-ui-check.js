#!/usr/bin/env node
/* Browser check of Admin → Data quality (admin_users.html?tab=quality): the Audit findings view (the 6 Nov 2026
 * audit, lib/quality/audit_findings.json) and the Automatic checks view. Against a LOCAL app only
 * (scripts/qa/serve-local.sh <port>, with MZO_QUALITY_FILE pointing at a quality.json for live states). Signs a
 * development admin session (the fallback JWT secret of a local server.js) and blocks every non-GET request.
 *
 *   MZO_QUALITY_FILE=/tmp/quality.json scripts/qa/serve-local.sh 3881
 *   node vm/dev/quality-ui-check.js http://localhost:3881 <screenshot dir>
 *
 * Checks: Audit findings is the default view (?tab=quality → &view=audit); only one .tab-content is visible;
 * one table row per finding of the API; the status, severity, owner and report filters; a row expands to its
 * details; linked findings show their live state; the switch to Automatic checks (and ?view=checks directly);
 * no sideways scroll at 390 px; no console errors. Screenshots: aud-1440-light(.-expanded), aud-1440-dark,
 * aud-1440-ppt, aud-390-light(-expanded), checks-1440-light.
 * Needs playwright-core (node_modules, PLAYWRIGHT_CORE_PATH or the npx cache) and Chrome for Testing.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function playwright() {
    const tries = [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean);
    const npx = path.join(os.homedir(), '.npm', '_npx');
    if (fs.existsSync(npx)) for (const d of fs.readdirSync(npx)) tries.push(path.join(npx, d, 'node_modules', 'playwright-core'));
    for (const t of tries) { try { return require(t); } catch (_) { /* next */ } }
    throw new Error('playwright-core not found');
}
function chrome() {
    const base = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    for (const d of fs.existsSync(base) ? fs.readdirSync(base).filter((x) => x.startsWith('chromium-')).sort().reverse() : []) {
        const p = path.join(base, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

const [baseUrl, outDir] = process.argv.slice(2);
if (!baseUrl || !outDir || !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl)) {
    console.error('usage: node vm/dev/quality-ui-check.js http://localhost:<port> <screenshot dir>');
    process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const SECRET = process.env.JWT_SECRET || 'mzo-portal-super-secret-key-123456';
const PROFILE = { Username: 'uicheck', Name: 'UI check', email: 'ui-check@example.com', role: 'admin' };
function cookieValue(profile) {
    const p = Buffer.from(JSON.stringify({ profile, expiry: Date.now() + 3600000 })).toString('base64');
    return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64');
}
const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'version.json'), 'utf8')).version;

let failures = 0;
function check(ok, what) { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failures++; }

async function main() {
    const pw = playwright();
    const browser = await pw.chromium.launch({ executablePath: chrome() });
    const blocked = [];
    async function open(width, theme, query) {
        const phone = width < 500;
        const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
        await ctx.addCookies([{ name: 'mzo_session', value: cookieValue(PROFILE), domain: new URL(baseUrl).hostname, path: '/' }]);
        await ctx.addInitScript(([t, v, prof]) => {
            if (location.protocol === 'about:') return;
            window.name = 'mzo-admin';
            localStorage.setItem('mzo_authenticated', 'true');
            ['theme', 'mzo_theme', 'collectionDashboardTheme', 'mzo_theme_pref'].forEach((k) => localStorage.setItem(k, t));
            localStorage.setItem('mzo_app_version', v);
            localStorage.setItem('mzo_user_profile', JSON.stringify(prof));
        }, [theme, version, PROFILE]);
        await ctx.route('**/*', (route) => {
            const r = route.request();
            if (r.method() !== 'GET' && r.method() !== 'HEAD') { blocked.push(r.method() + ' ' + r.url()); return route.abort(); }
            return route.continue();
        });
        const page = await ctx.newPage();
        const errors = [];
        page.on('console', (m) => {
            if (m.type() !== 'error') return;
            const t = m.text();
            if (/net::ERR_FAILED|ERR_BLOCKED/.test(t) && blocked.length) return; // our own non-GET block
            errors.push(t);
        });
        page.on('pageerror', (e) => errors.push('page error: ' + e.message));
        await page.goto(baseUrl + '/admin_users.html?tab=quality' + (query || ''), { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(query && /checks/.test(query) ? '#dqTable table, #dqTable .ui-empty:not(:empty)' : '#afTable table', { timeout: 20000 });
        await page.waitForTimeout(400);
        return { ctx, page, errors };
    }
    const shot = (page, name) => page.screenshot({ path: path.join(outDir, name + '.png'), fullPage: false });
    const visibleTabs = (page) => page.$$eval('.tab-content', (els) => els.filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.id));
    const rowCount = (page) => page.$$eval('#afTable tr.af-row', (r) => r.length);
    const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

    // ---- 1440 light: the full flow
    {
        const { ctx, page, errors } = await open(1440, 'light');
        const api = await page.evaluate(async () => (await fetch('/api/admin/data-quality/audit', { credentials: 'same-origin' })).json());
        check(api.status === 'success' && api.findings.length > 0, `audit API answers (${api.findings && api.findings.length} findings)`);
        check(JSON.stringify(await visibleTabs(page)) === '["qualityTab"]', 'only the Data quality .tab-content is visible');
        check(await page.$eval('#dqAuditView', (e) => !e.hidden) && await page.$eval('#dqChecksView', (e) => e.hidden), 'Audit findings is the default view');
        check(/[?&]tab=quality&view=audit/.test(page.url()), 'the URL keeps ?tab=quality&view=audit: ' + page.url().replace(baseUrl, ''));
        check((await rowCount(page)) === api.findings.length, `one row per finding (${await rowCount(page)})`);
        const tiles = await page.$$eval('#afStats .ui-stat .k', (els) => els.map((e) => e.textContent.trim()));
        check(['Open', 'Mitigated', 'Monitoring', 'Fixed', 'Still detected', 'Fix in source sheet'].every((t) => tiles.includes(t)), 'summary tiles: ' + tiles.join(', '));
        const detected = api.findings.filter((f) => f.live && f.live.state === 'detected').length;
        check(await page.$$eval('#afTable td.af-live .ui-badge.bad', (b) => b.length) === detected, `"Still detected" on ${detected} linked findings`);
        check(/Fix in source sheet/.test(await page.$eval('#afTable', (e) => e.textContent)) && /App bug/.test(await page.$eval('#afTable', (e) => e.textContent)), 'owners shown (source sheet / app)');
        await shot(page, 'aud-1440-light');

        // Filters
        await page.click('#afStatus button[data-status="fixed"]');
        check((await rowCount(page)) === api.findings.filter((f) => f.status === 'fixed').length, 'status filter: Fixed');
        await page.click('#afStatus button[data-status=""]');
        await page.selectOption('#afSev', 'critical');
        check((await rowCount(page)) === api.findings.filter((f) => f.severity === 'critical').length, 'severity filter: Critical');
        await page.selectOption('#afSev', '');
        await page.selectOption('#afOwner', 'source sheet');
        check((await rowCount(page)) === api.findings.filter((f) => f.owner === 'source sheet').length, 'owner filter: source sheet');
        await page.selectOption('#afOwner', '');
        await page.selectOption('#afReport', 'rem/defaulters.html');
        check((await rowCount(page)) === api.findings.filter((f) => f.reports.some((r) => r.page === 'rem/defaulters.html')).length, 'report filter: REM defaulters');
        await page.selectOption('#afReport', '');
        await page.click('#afStats .ui-stat[data-af="status:open"]');
        check((await rowCount(page)) === api.findings.filter((f) => f.status === 'open').length, 'Open tile filters to open findings');
        await page.click('#afStats .ui-stat[data-af="status:open"]');
        check((await rowCount(page)) === api.findings.length, 'clicking the tile again clears it');

        // Expand the REM ₹0 finding (linked, detected)
        const rem = api.findings.find((f) => f.autoCheck.includes('rem.osd_all_zero'));
        await page.click(`#afTable tr.af-row[data-id="${rem.id}"]`);
        const detail = await page.$eval('#afTable tr.dq-detail', (e) => e.textContent);
        check(['Evidence', 'What users see', 'Cause', 'Who fixes it', 'Status', 'Live now'].every((t) => detail.includes(t)), 'the expanded row shows evidence, impact, cause, owner, status, live');
        await page.$eval('#afTable tr.dq-detail', (e) => e.scrollIntoView({ block: 'center' }));
        await shot(page, 'aud-1440-light-expanded');
        await page.click(`#afTable tr.af-row[data-id="${rem.id}"]`);
        check(!(await page.$('#afTable tr.dq-detail')), 'a second click closes it');

        // Switch to Automatic checks
        await page.click('#dqView button[data-view="checks"]');
        check(await page.$eval('#dqChecksView', (e) => !e.hidden) && await page.$eval('#dqAuditView', (e) => e.hidden), 'the switch shows Automatic checks');
        check(/view=checks/.test(page.url()), 'the URL follows: view=checks');
        check(JSON.stringify(await visibleTabs(page)) === '["qualityTab"]', 'still one .tab-content visible');
        await page.waitForSelector('#dqTable table, #dqTable .ui-empty', { timeout: 10000 });
        await shot(page, 'checks-1440-light');
        check(errors.length === 0, 'no console errors (1440 light)' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
        await ctx.close();
    }
    // ---- ?view=checks opens the checks directly
    {
        const { ctx, page, errors } = await open(1440, 'light', '&view=checks');
        check(await page.$eval('#dqChecksView', (e) => !e.hidden), '?tab=quality&view=checks opens Automatic checks');
        check(errors.length === 0, 'no console errors (view=checks)' + (errors.length ? ': ' + errors.join(' | ') : ''));
        await ctx.close();
    }
    // ---- dark, ppt
    for (const theme of ['dark', 'ppt']) {
        const { ctx, page, errors } = await open(1440, theme);
        check((await page.evaluate(() => document.documentElement.getAttribute('data-mzo-theme'))) === theme, `theme ${theme} applied`);
        await shot(page, 'aud-1440-' + theme);
        check(errors.length === 0, `no console errors (1440 ${theme})` + (errors.length ? ': ' + errors.join(' | ') : ''));
        await ctx.close();
    }
    // ---- 390 px
    for (const theme of ['light', 'dark']) {
        const { ctx, page, errors } = await open(390, theme);
        check(await noHScroll(page), `no sideways scroll at 390 px (${theme})`);
        check(await page.$eval('#afTable tr.af-row .dq-sm-only', (e) => getComputedStyle(e).display !== 'none'), `chips under the title at 390 px (${theme})`);
        await shot(page, 'aud-390-' + theme);
        if (theme === 'light') {
            await page.click('#afTable tr.af-row');
            check(await noHScroll(page), 'no sideways scroll with a row open at 390 px');
            await page.$eval('#afTable tr.dq-detail', (e) => e.scrollIntoView({ block: 'start' }));
            await shot(page, 'aud-390-light-expanded');
        }
        check(errors.length === 0, `no console errors (390 ${theme})` + (errors.length ? ': ' + errors.join(' | ') : ''));
        await ctx.close();
    }
    await browser.close();
    check(true, `${blocked.length} non-GET request(s) blocked`);
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
