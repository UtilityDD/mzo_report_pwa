#!/usr/bin/env node
/* scripts/qa/rating-metrics-bench.js: browser timing of the rating's fallback path
 * (MzoRatingMetrics.compute from MzoRows rows, then MzoRating.rate), headless Chrome.
 *
 *   scripts/qa/serve-local.sh 3970 <snapshotDir with rows files>     # vm/sync/rows.js --dir <snapshotDir> first
 *   node scripts/qa/rating-metrics-bench.js [--base http://127.0.0.1:3970] [--runs 5] [--out result.json]
 *
 * For all 46 metrics and for the rated ones (opts.rated), with and without a 4× CPU throttle:
 *   cold   a fresh browser profile: rows come from /api/data/rows (or are built from the raw files)
 *   warm   the page reloaded: rows from MzoRows' IndexedDB cache (the server answers 304)
 *   load   MzoRows.get of every dataset (scope: false); compute first / again: computeSync on the
 *          loaded rows, first call in the page (cold JIT) and a second; rate: MzoRating.rate;
 *   end to end: a second MzoRatingMetrics.compute() call (load + compute) in the same page.
 * Medians of --runs. The page is served by this script (a route on the app's origin), so nothing
 * is added to the app. GET-only: every other request, and every request to another host, is
 * aborted. Session: the forged local test cookie (env QA_JWT_SECRET or the dev fallback).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; }
function loadPlaywright() {
    for (const t of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core', 'playwright']) { if (!t) continue; try { return require(t); } catch (_) { /* next */ } }
    const npx = path.join(os.homedir(), '.npm', '_npx');
    for (const d of fs.existsSync(npx) ? fs.readdirSync(npx) : []) { const p = path.join(npx, d, 'node_modules', 'playwright-core'); if (fs.existsSync(path.join(p, 'package.json'))) return require(p); }
    throw new Error('playwright-core not found');
}
function cookie() {
    const secret = process.env.QA_JWT_SECRET || 'mzo-portal-super-secret-key-123456';
    const payload = Buffer.from(JSON.stringify({ profile: { Username: 'local-preview', Name: 'Local Preview', role: 'admin', office_level: 'CE' }, expiry: Date.now() + 3600e3 })).toString('base64');
    return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64');
}

// The bench page: the scripts a page loads, and the measurement.
function pageHtml(app) {
    const v = (f, re) => { const m = fs.readFileSync(path.join(app, 'nsc.html'), 'utf8').match(re); return m ? m[1] : '1'; };
    const rowsV = v('nsc.html', /mzo_rows\.js\?v=(\d+)/), hubV = v('nsc.html', /mzo_data_hub\.js\?v=(\d+)/), scopeV = v('nsc.html', /mzo_scope\.js\?v=(\d+)/);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>rating bench</title>
<script src="/mzo_data_hub.js?v=${hubV}" defer></script><script src="/lib/offices.js?v=3" defer></script>
<script src="/mzo_scope.js?v=${scopeV}" defer></script><script src="/mzo_rows.js?v=${rowsV}" defer></script>
<script src="/lib/rating_metrics.js?v=1" defer></script><script src="/lib/rating.js?v=1" defer></script></head><body>
<script>
window.runBench = async function (rated) {
  const only = rated ? MzoRatingMetrics.ratedIds(MzoRating.METHOD) : null, o = { only, manifest: null, asOf: '2026-11-01', generatedAt: 'x' };
  const t0 = performance.now(); const tables = await MzoRatingMetrics.loadRows(MzoRatingMetrics.datasetsFor(only));
  const t1 = performance.now(); const doc = MzoRatingMetrics.computeSync(tables, o);
  const t2 = performance.now(); const again = MzoRatingMetrics.computeSync(tables, o);
  const t3 = performance.now(); const rating = MzoRating.rate(doc);
  const t4 = performance.now(); const entry = await MzoRatingMetrics.compute(null, o);
  const t5 = performance.now();
  const strip = (d) => JSON.stringify(Object.assign({}, d, { source: null }));
  return { datasets: Object.keys(tables).length, rows: Object.values(tables).reduce((a, t) => a + t.all.length, 0), load: t1 - t0, first: t2 - t1, again: t3 - t2,
    rate: t4 - t3, entry: t5 - t4, errors: Object.keys(doc.errors), same: strip(doc) === strip(again) && strip(doc) === strip(entry), zone: rating.offices['6600000'].score,
    sources: [...new Set(Object.values(tables).map((t) => t.source))] };
};
</script></body></html>`;
}

async function main() {
    const base = String(arg('base', 'http://127.0.0.1:3970')).replace(/\/+$/, '');
    const runs = +arg('runs', 5);
    const app = path.resolve(__dirname, '..', '..');
    const html = pageHtml(app);
    const { chromium } = loadPlaywright();
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return Math.round(s[Math.floor(s.length / 2)]); };
    const out = {};
    for (const rated of [false, true]) for (const rate of [1, 4]) {
        const res = { cold: [], warm: [] };
        for (let i = 0; i < runs; i++) {
            const ctx = await browser.newContext();
            await ctx.addCookies([{ name: 'mzo_session', value: cookie(), url: base }]);
            await ctx.route('**/*', (route) => {
                const req = route.request();
                if (req.url() === base + '/__rating_bench') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
                if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) || !req.url().startsWith(base + '/')) return route.abort();
                return route.continue();
            });
            const page = await ctx.newPage();
            await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate });
            for (const phase of ['cold', 'warm']) {
                if (phase === 'cold') await page.goto(base + '/__rating_bench'); else await page.reload();
                await page.waitForFunction(() => window.MzoRatingMetrics && window.MzoRating && window.MzoRows && window.runBench);
                res[phase].push(await page.evaluate((r) => window.runBench(r), rated));
            }
            await ctx.close();
        }
        const sum = (l) => ({ load: med(l.map((x) => x.load)), computeFirst: med(l.map((x) => x.first)), computeAgain: med(l.map((x) => x.again)), rate: med(l.map((x) => x.rate)), endToEnd: med(l.map((x) => x.entry)) });
        const tag = (rated ? 'rated' : 'all') + ' x' + rate;
        const c = res.cold[0];
        out[tag] = { cold: sum(res.cold), warm: sum(res.warm), datasets: c.datasets, rows: c.rows, errors: c.errors, sameDocument: res.cold.concat(res.warm).every((x) => x.same), zoneScore: c.zone, sources: { cold: c.sources, warm: res.warm[0].sources } };
        console.log(tag.padEnd(9), JSON.stringify(out[tag]));
    }
    if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(out, null, 1) + '\n');
    await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
