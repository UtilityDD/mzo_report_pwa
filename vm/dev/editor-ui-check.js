#!/usr/bin/env node
/* Browser check of the data editor (editor/): a real paste flow through the page, at 1440 px and
 * 390 px, light and dark. Against a LOCAL app only (scripts/qa/serve-local.sh) whose PocketBase has
 * a native dataset (take one over first, e.g. loss_targets, in the editor or with vm/dev/test-editor.js
 * style fixtures). Signs a development session (the fallback JWT secret of a local server.js).
 *
 *   node vm/dev/editor-ui-check.js http://localhost:3633 <native dataset key> <screenshot dir>
 *
 * Steps: home; open the dataset; a synthetic Ctrl+V paste event carrying Sheets-style text/plain
 * (2 x 2 cells) on the first data cells; the review screen opens with the diff; save; the values are
 * read back through the API; the save is undone from the page. Then the HTML-only clipboard fallback,
 * an invalid value held in review, the phone cell editor, and dark mode. Any console error fails.
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

const [baseUrl, key, outDir] = process.argv.slice(2);
if (!baseUrl || !key || !outDir || !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl)) {
    console.error('usage: node vm/dev/editor-ui-check.js http://localhost:<port> <native key> <screenshot dir>');
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
    const cookie = cookieValue({ Username: 'uicheck', Name: 'UI check', email: 'ui-check@example.com', role: 'admin' });
    async function context(width, theme) {
        const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, deviceScaleFactor: width < 500 ? 2 : 1, isMobile: width < 500, hasTouch: width < 500 });
        await ctx.addCookies([{ name: 'mzo_session', value: cookieValue({ Username: 'uicheck', Name: 'UI check', email: 'ui-check@example.com', role: 'admin' }), domain: new URL(baseUrl).hostname, path: '/' }]);
        await ctx.addInitScript(([t, v]) => {
            localStorage.setItem('mzo_authenticated', 'true');
            ['theme', 'mzo_theme', 'collectionDashboardTheme', 'mzo_theme_pref'].forEach((k) => localStorage.setItem(k, t));
            localStorage.setItem('mzo_app_version', v);
        }, [theme, version]);
        const page = await ctx.newPage();
        const errors = [];
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', (e) => errors.push('page error: ' + e.message));
        return { ctx, page, errors };
    }
    const api = async (page, p) => page.evaluate(async (u) => (await fetch(u, { credentials: 'same-origin' })).json(), '/api/editor' + p);
    const paste = (page, data) => page.evaluate((d) => {
        const dt = new DataTransfer();
        Object.keys(d).forEach((k) => dt.setData(k, d[k]));
        const sink = document.querySelector('.ed-sink');
        sink.focus();
        sink.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, data);
    const shot = (page, name) => page.screenshot({ path: path.join(outDir, name + '.png') });

    for (const theme of ['light', 'dark']) {
        // ---- Desktop ----
        const { ctx, page, errors } = await context(1440, theme);
        await page.goto(baseUrl + '/editor/#/');
        await page.waitForSelector('.ed-item');
        await shot(page, `home-1440-${theme}`);
        await page.goto(baseUrl + '/editor/#/d/' + key);
        await page.waitForSelector('.ed-row .ed-c[data-r="1"]');
        const before = await api(page, `/datasets/${key}/rows?limit=2`);
        const ds = (await api(page, `/datasets/${key}`)).dataset;
        // Select row 1, column 2 (the first column after the key column) and paste 2 x 2 cells.
        await page.click('.ed-row .ed-c[data-r="0"][data-c="1"]');
        const n1 = theme === 'light' ? '111.25' : '111.5';
        await paste(page, { 'text/plain': `${n1}\t95\r\n222.5\t96\r\n`, 'text/html': '<table><tr><td>ignored</td></tr></table>' });
        await page.waitForSelector('.ed-dlg .ed-t');
        await page.waitForFunction(() => !document.querySelector('.ed-dlg footer button.primary').disabled);
        const counts = await page.textContent('.ed-counts');
        check(/0 added/.test(counts) && /2 changed/.test(counts), `${theme}: paste of 2 x 2 cells → review shows 2 changed (${counts.replace(/\s+/g, ' ')})`);
        await shot(page, `review-1440-${theme}`);
        await page.click('.ed-dlg footer button.primary');
        await page.waitForSelector('.ed-dlg', { state: 'detached' });
        await page.waitForTimeout(400);
        const after = await api(page, `/datasets/${key}/rows?limit=2`);
        check(after.rows[0].cells[1] === n1 && after.rows[0].cells[2] === '95' && after.rows[1].cells[1] === '222.5' && after.rows[1].cells[2] === '96',
            `${theme}: saved values read back through the API (${after.rows[0].cells.slice(1, 3).join(', ')}; ${after.rows[1].cells.slice(1, 3).join(', ')})`);
        await shot(page, `saved-1440-${theme}`);
        // Undo the save from the page.
        await page.click('text=Undo this save');
        await page.click('.ed-dlg footer button.primary');
        await page.waitForTimeout(800);
        const undone = await api(page, `/datasets/${key}/rows?limit=2`);
        check(undone.rows[0].cells.join('|') === before.rows[0].cells.join('|') && undone.rows[1].cells.join('|') === before.rows[1].cells.join('|'), `${theme}: undo restored the rows`);

        if (theme === 'light') {
            // HTML-only clipboard (no text/plain) and a value that does not fit a number column.
            await page.click('.ed-row .ed-c[data-r="2"][data-c="1"]');
            await paste(page, { 'text/html': '<meta charset="utf-8"><table><tr><td>abc</td><td>7</td></tr></table>' });
            await page.waitForSelector('.ed-dlg .ed-note.bad');
            const note = await page.textContent('.ed-dlg .b');
            check(/do not fit/.test(note) && /Not a number/.test(note), 'light: an HTML-only paste is read; the invalid number is flagged in review');
            check(await page.$eval('.ed-dlg footer button.primary', (b) => b.disabled), 'light: save is blocked until the row is held back');
            await shot(page, 'review-invalid-1440-light');
            await page.click('.ed-dlg footer button:not(.primary) >> text=Back to editing');
            await page.click('text=Discard');
            await page.click('.ed-dlg footer button.primary');
            // Header paste into new rows past the end: columns matched by name.
            const total = before.total;
            await page.evaluate(() => { const g = document.querySelector('.ed-grid'); g.scrollTop = g.scrollHeight; });
            await page.waitForTimeout(300);
            await page.click(`.ed-row .ed-c[data-r="${total - 1}"][data-c="0"]`);
            await page.click('text=Add row');
            await page.keyboard.press('Escape');
            const hdr = [ds.columns[1].label, ds.columns[0].label].join('\t');
            await page.click(`.ed-row .ed-c[data-r="${total}"][data-c="0"]`);
            await paste(page, { 'text/plain': `${hdr}\r\n12.5\tZZ UI CHECK\r\n` });
            await page.waitForSelector('.ed-dlg .ed-t');
            const c2 = await page.textContent('.ed-counts');
            check(/1 added/.test(c2), `light: a pasted header row maps columns by name into a new row (${c2.replace(/\s+/g, ' ')})`);
            await page.click('.ed-dlg footer button:not(.primary) >> text=Back to editing');
            await page.click('text=Discard');
            await page.click('.ed-dlg footer button.primary');
        }
        await page.click('text=History');
        await page.waitForSelector('.ed-dlg .ed-t');
        await shot(page, `history-1440-${theme}`);
        await page.keyboard.press('Escape');
        await page.goto(baseUrl + '/editor/#/permissions?email=someone%40example.com');
        await page.waitForSelector('.ed-perm-grid .ed-t');
        check((await page.$$('.ed-perm-grid tbody tr')).length > 1, `${theme}: permissions page lists datasets for a typed email`);
        await shot(page, `permissions-1440-${theme}`);
        if (theme === 'light') {
            await page.goto(baseUrl + '/editor/#/new');
            await page.fill('textarea', 'Code\tQty\tOn\nA1\t3\t01/11/2026');
            await page.waitForSelector('.ed-t select');
            await shot(page, 'new-dataset-1440-light');
        }
        check(!errors.length, `${theme} desktop: no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
        await ctx.close();

        // ---- Phone ----
        const ph = await context(390, theme);
        await ph.page.goto(baseUrl + '/editor/#/');
        await ph.page.waitForSelector('.ed-item');
        await shot(ph.page, `home-390-${theme}`);
        await ph.page.goto(baseUrl + '/editor/#/d/' + key);
        await ph.page.waitForSelector('.ed-row .ed-c[data-r="0"]');
        await shot(ph.page, `dataset-390-${theme}`);
        await ph.page.tap('.ed-row .ed-c[data-r="0"][data-c="0"]');
        await ph.page.tap('.ed-row .ed-c[data-r="0"][data-c="0"]');
        await ph.page.waitForSelector('.ed-sheet textarea');
        await ph.page.fill('.ed-sheet textarea', 'PHONE EDIT');
        await shot(ph.page, `cell-editor-390-${theme}`);
        await ph.page.click('.ed-sheet >> text=Done');
        const pend = await ph.page.textContent('.ed-foot');
        check(/1 unsaved change/.test(pend), `${theme} phone: one cell edited in the bottom sheet (${pend.replace(/\s+/g, ' ').trim().slice(0, 60)})`);
        await ph.page.click('text=Discard');
        await ph.page.click('.ed-dlg footer button.primary');
        check(!ph.errors.length, `${theme} phone: no console errors${ph.errors.length ? ': ' + ph.errors.join(' | ') : ''}`);
        await ph.ctx.close();
    }
    await browser.close();
    void cookie;
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exitCode = failures ? 1 : 0;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
