#!/usr/bin/env node
/* Browser check of Admin → Organisation (admin_users.html?tab=org, admin_org.js). Against a LOCAL app only
 * (scripts/qa/serve-local.sh <port>). Signs a development admin session (the fallback JWT secret of a
 * local server.js) and blocks every non-GET request, so nothing is written anywhere.
 *
 *   node vm/dev/org-ui-check.js http://localhost:3871 <screenshot dir>
 *
 * Steps at 1440 px (light): the chart draws from the root with the live zone badged; a click expands a
 * zone and collapses it again; "Expand zone" opens every office in the zone; search by name and by code
 * highlights the path (connector lines and cards) and opens the detail panel on the office; a crumb in the
 * detail panel moves the selection; "Collapse all". Then 1440 dark, 1920 ppt, and the 390 px list view
 * (expand by tap, search, details). Any console error fails. Screenshots: org-1440-light.png,
 * org-1440-dark.png, org-1920-ppt.png, org-390.png (+ org-390-detail.png).
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
    console.error('usage: node vm/dev/org-ui-check.js http://localhost:<port> <screenshot dir>');
    process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const SECRET = process.env.JWT_SECRET || 'mzo-portal-super-secret-key-123456';
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
    async function open(width, theme) {
        const phone = width < 500;
        const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : (width > 1600 ? 1080 : 900) }, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
        await ctx.addCookies([{ name: 'mzo_session', value: cookieValue({ Username: 'uicheck', Name: 'UI check', email: 'ui-check@example.com', role: 'admin' }), domain: new URL(baseUrl).hostname, path: '/' }]);
        await ctx.addInitScript(([t, v]) => {
            localStorage.setItem('mzo_authenticated', 'true');
            ['theme', 'mzo_theme', 'collectionDashboardTheme', 'mzo_theme_pref'].forEach((k) => localStorage.setItem(k, t));
            localStorage.setItem('mzo_app_version', v);
            localStorage.setItem('mzo_user_profile', JSON.stringify({ Username: 'uicheck', Name: 'UI check', email: 'ui-check@example.com', role: 'admin' }));
        }, [theme, version]);
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
        await page.goto(baseUrl + '/admin_users.html?tab=org', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#orgTab .org-card, #orgTab .org-row', { timeout: 20000 });
        await page.waitForTimeout(400);
        return { ctx, page, errors };
    }
    const shot = (page, name) => page.screenshot({ path: path.join(outDir, name + '.png') });
    const cards = (page) => page.$$eval('#orgCanvas .org-card', (els) => els.map((e) => ({ id: e.dataset.id, name: e.querySelector('.org-c-name').textContent, cls: e.className })));
    const detailName = (page) => page.$eval('#orgDetail h3', (e) => e.textContent);

    // ---- 1440 light: the full flow
    {
        const { ctx, page, errors } = await open(1440, 'light');
        check(await page.$eval('.tab-btn[data-tab="orgTab"]', (b) => b.classList.contains('active')), '?tab=org opens the Organisation tab');
        const api = await page.evaluate(async () => (await fetch('/api/admin/org', { credentials: 'same-origin' })).json());
        // Zones sit under the root or under chief engineers; depth of a CCC = its path length - 1.
        const zones = [];
        (function walk(n, d) { if (n.level === 'zone') { n._depth = d; zones.push(n); return; } (n.children || []).forEach((c) => walk(c, d + 1)); })(api.root, 0);
        const liveZone = zones.find((z) => z.live);
        const cccPath = liveZone._depth + 4; // root … zone, region, division, CCC
        check(!!liveZone, 'the API marks a live zone: ' + (liveZone && liveZone.name));
        let cs = await cards(page);
        check(cs[0] && cs[0].name === api.root.name, 'the chart starts at the root: ' + (cs[0] && cs[0].name));
        check(zones.every((z) => cs.some((c) => c.name === z.name)), `every zone has a card (${zones.length})`);
        const liveCard = await page.$('#orgCanvas .org-card.live');
        check(!!liveCard && /Live in app/.test(await liveCard.textContent()), 'the live zone card has the "Live in app" badge');
        const rootCounts = await page.$eval('#orgCanvas .org-card[data-id="n"] .org-c-counts', (e) => e.textContent);
        check(/zone/.test(rootCounts) && /CCC/.test(rootCounts), 'root card counts: ' + rootCounts);
        check(await page.$$eval('#orgCanvas .org-link', (l) => l.length) >= zones.length, 'connector lines drawn');
        check(await page.$$eval('#orgCanvas .org-card[data-id^="n."]', (els) => els.every((e) => e.offsetWidth === els[0].offsetWidth)), 'cards have one width');

        // Collapse the live zone if it starts open, then open it by a click.
        const zid = await liveCard.getAttribute('data-id');
        if ((await liveCard.getAttribute('aria-expanded')) === 'true') await page.click(`#orgCanvas .org-card[data-id="${zid}"]`);
        let n0 = (await cards(page)).length;
        await page.click(`#orgCanvas .org-card[data-id="${zid}"]`);
        cs = await cards(page);
        check(cs.length === n0 + liveZone.children.length, `click expands the zone (+${liveZone.children.length} regions)`);
        check((await detailName(page)) === liveZone.name, 'the detail panel shows the clicked zone');
        check(await page.$eval(`#orgCanvas .org-card[data-id="${zid}"]`, (e) => e.getAttribute('aria-expanded') === 'true'), 'aria-expanded true');
        await page.click(`#orgCanvas .org-card[data-id="${zid}"]`);
        check((await cards(page)).length === n0, 'a second click collapses it');

        // Expand all in the zone.
        await page.click('#orgExpandZone');
        cs = await cards(page);
        const zoneCccs = (function count(n) { return (n.level === 'ccc' ? 1 : 0) + (n.children || []).reduce((s, c) => s + count(c), 0); })(liveZone);
        check(cs.filter((c) => /\bstack\b/.test(c.cls)).length >= zoneCccs, `"Expand zone" shows every CCC of ${liveZone.name} (${zoneCccs})`);
        const overlaps = await page.$$eval('#orgCanvas .org-card', (els) => {
            const r = els.map((e) => ({ x: e.offsetLeft, y: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight }));
            let bad = 0;
            for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
                const a = r[i], b = r[j];
                if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) bad++;
            }
            return bad;
        });
        check(overlaps === 0, 'no cards overlap with the zone fully open');
        await page.click('#orgFit');
        await page.waitForTimeout(200);
        await shot(page, 'org-1440-expanded');

        // Search by name: a CCC deep in the tree.
        await page.click('#orgCollapse');
        const target = (function first(n) { if (n.level === 'ccc') return n; for (const c of n.children || []) { const f = first(c); if (f) return f; } return null; })(liveZone.children[liveZone.children.length - 1]);
        await page.fill('#orgQ', target.name.slice(0, 5));
        await page.waitForSelector('#orgHits li[data-id]');
        check(await page.$$eval('#orgHits li[data-id]', (l, nm) => l.some((x) => x.textContent.includes(nm)), target.name), 'search suggests ' + target.name);
        // A CCC can share its name with its division (Balurghat): pick it from the suggestions.
        await page.fill('#orgQ', target.name);
        await page.waitForTimeout(250);
        const pickIx = await page.$$eval('#orgHits li[data-id]', (l, nm) => l.findIndex((x) => x.querySelector('b').textContent === nm && /CCC/.test(x.textContent)), target.name);
        await page.click(`#orgHits li[data-id] >> nth=${Math.max(0, pickIx)}`);
        await page.waitForTimeout(500);
        const hit = await page.$('#orgCanvas .org-card.hit');
        check(!!hit && (await hit.$eval('.org-c-name', (e) => e.textContent)) === target.name, 'Enter reveals and highlights ' + target.name);
        const onPath = await page.$$eval('#orgCanvas .org-card.on-path', (els) => els.length);
        check(onPath === cccPath, `its path is highlighted (root to CCC, ${cccPath} cards): ` + onPath);
        check(await page.$$eval('#orgCanvas .org-link.on', (l) => l.length) >= cccPath - 1, 'path connectors highlighted');
        check((await detailName(page)) === target.name, 'detail panel on the found CCC');
        const dl = await page.$eval('#orgDetail .org-dl', (e) => e.textContent);
        check(/Code/.test(dl) && /Parent path/.test(dl) && /Confidence/.test(dl) && /Sources/.test(dl), 'detail panel: code, parent path, confidence, sources');
        check(/In this app/.test(dl), 'detail panel says whether the app has the office');
        const inView = await hit.evaluate((e) => { const c = document.getElementById('orgCanvas').getBoundingClientRect(), r = e.getBoundingClientRect(); return r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1; });
        check(inView, 'the found card is scrolled into view');
        await shot(page, 'org-1440-search');

        // Search by code.
        if (target.code) {
            await page.fill('#orgQ', target.code);
            await page.waitForTimeout(250);
            check(await page.$eval('#orgHits li[data-id]', (l) => l.textContent).then((t) => t.includes(target.code)), 'search by code ' + target.code);
            await page.press('#orgQ', 'Escape');
        }
        // A crumb in the detail panel moves the selection to the division.
        await page.click('#orgDetail .org-crumb:last-of-type');
        await page.waitForTimeout(300);
        const div = await detailName(page);
        check((await page.$eval('#orgDetail .org-c-lv', (e) => e.textContent)) === 'Division', 'parent crumb selects the division: ' + div);

        await page.click('#orgCollapse');
        await page.fill('#orgQ', '');
        await page.waitForTimeout(200);
        // Screenshot state: a search path down to a CCC (by its code).
        await page.fill('#orgQ', target.code || target.name);
        await page.waitForTimeout(250);
        await page.press('#orgQ', 'Enter');
        await page.waitForTimeout(400);
        await page.waitForTimeout(300);
        await shot(page, 'org-1440-light');
        check(errors.length === 0, '1440 light: no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
        await ctx.close();
    }

    // ---- 1440 dark and 1920 ppt: draw, open the live zone, search, screenshot
    for (const [w, theme] of [[1440, 'dark'], [1920, 'ppt']]) {
        const { ctx, page, errors } = await open(w, theme);
        const zid = await page.$eval('#orgCanvas .org-card.live', (e) => e.dataset.id);
        await page.click('#orgExpandZone', { trial: true }).catch(() => {});
        await page.click(`#orgCanvas .org-card[data-id="${zid}"]`); // select (toggles)
        if ((await page.$eval(`#orgCanvas .org-card[data-id="${zid}"]`, (e) => e.getAttribute('aria-expanded'))) !== 'true') await page.click(`#orgCanvas .org-card[data-id="${zid}"]`);
        const regions = await page.$$eval(`#orgCanvas .org-card[data-id^="${zid}."]`, (els) => els.map((e) => e.dataset.id));
        if (regions[0]) await page.click(`#orgCanvas .org-card[data-id="${regions[0]}"]`);
        const divs = await page.$$eval(`#orgCanvas .org-card[data-id^="${regions[0]}."]`, (els) => els.map((e) => e.dataset.id));
        if (divs[0]) await page.click(`#orgCanvas .org-card[data-id="${divs[0]}"]`);
        if (w > 1600) { await page.click('#orgZoomOut'); await page.click('#orgZoomOut'); } // 80 %: more of the chart on the wide screen
        await page.waitForTimeout(300);
        check(await page.$eval('html', (e) => e.getAttribute('data-mzo-theme')) === theme, `${w} ${theme}: theme applied`);
        const bg = await page.$eval('#orgCanvas .org-card', (e) => getComputedStyle(e).backgroundColor);
        if (theme === 'dark') check(/rgb\((\d+), (\d+), (\d+)\)/.exec(bg).slice(1).every((v) => Number(v) < 80), `dark: dark card surface (${bg})`);
        await shot(page, `org-${w}-${theme}`);
        check(errors.length === 0, `${w} ${theme}: no console errors` + (errors.length ? ': ' + errors.join(' | ') : ''));
        await ctx.close();
    }

    // ---- 390 phone: the indented list
    {
        const { ctx, page, errors } = await open(390, 'light');
        check(await page.$eval('#orgCanvas', (e) => e.hidden) && !(await page.$eval('#orgList', (e) => e.hidden)), '390: the list replaces the chart');
        const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
        check(scrollW <= 392, '390: no horizontal page scroll (' + scrollW + ')');
        const rows0 = await page.$$eval('#orgList .org-row', (r) => r.length);
        const liveRow = await page.$('#orgList .org-row .org-badge.live');
        check(!!liveRow, '390: live badge in the list');
        const zid = await page.$eval('#orgList .org-row .org-badge.live', (b) => b.closest('.org-row').dataset.id);
        const wasOpen = (await page.$eval(`#orgList .org-row[data-id="${zid}"]`, (e) => e.getAttribute('aria-expanded'))) === 'true';
        await page.tap(`#orgList .org-row[data-id="${zid}"] .org-row-main`);
        const rows1 = await page.$$eval('#orgList .org-row', (r) => r.length);
        check(wasOpen ? rows1 < rows0 : rows1 > rows0, '390: tap toggles a zone (' + rows0 + ' → ' + rows1 + ')');
        if (wasOpen) await page.tap(`#orgList .org-row[data-id="${zid}"] .org-row-main`);
        const reg = await page.$eval(`#orgList .org-row[data-id^="${zid}."]`, (e) => e.dataset.id);
        await page.tap(`#orgList .org-row[data-id="${reg}"] .org-row-main`);
        const indent = await page.$$eval(`#orgList .org-row[data-id="${zid}"], #orgList .org-row[data-id="${reg}"]`, (els) => els.map((e) => parseFloat(getComputedStyle(e).paddingLeft)));
        check(indent[1] > indent[0], '390: children are indented');
        await page.fill('#orgQ', 'Kaliachak');
        await page.waitForTimeout(250);
        await page.press('#orgQ', 'Enter');
        await page.waitForTimeout(500);
        const hit = await page.$('#orgList .org-row.hit .org-row-name');
        check(!!hit && (await hit.textContent()) === 'Kaliachak', '390: search opens the list to Kaliachak');
        const depth = await page.$eval('#orgList .org-row.hit', (e) => Number(e.getAttribute('aria-level')));
        check(await page.$$eval('#orgList .org-row.on-path', (r) => r.length) === depth, '390: path highlighted in the list (' + depth + ' rows)');
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(200);
        await shot(page, 'org-390');
        await page.tap('#orgList .org-row.hit .org-row-info');
        await page.waitForTimeout(600);
        check((await detailName(page)) === 'Kaliachak', '390: details below the list');
        await shot(page, 'org-390-detail');
        check(errors.length === 0, '390: no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
        await ctx.close();
    }

    await browser.close();
    if (blocked.length) console.log('blocked non-GET requests: ' + blocked.length + ' (' + [...new Set(blocked)].slice(0, 5).join(', ') + ')');
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
