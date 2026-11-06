#!/usr/bin/env node
/* Page speed: cold and warm loads of report pages, desktop and phone, with the numbers each shows.
 *
 *   node scripts/qa/speed.js <baseUrl> <label> [--pages a,b] [--runs 1] [--no-phone] [--net vm|none] [--timeout 150] [--out dir]
 *   node scripts/qa/speed.js <baseA>,<baseB> <labelA>,<labelB> …       both, interleaved page by page and run by run
 *   node scripts/qa/speed.js --compare <labelA> <labelB> [--out dir]      before/after table + number parity
 *
 * Per page and profile (desktop 1440×900; phone 390×844 with the CPU slowed 4×):
 *   cold   a fresh browser profile (empty HTTP cache, IndexedDB and localStorage);
 *   warm   a second visit in the same profile.
 * Recorded: bytes over the network (CDP encodedDataLength: headers + compressed body; cache hits are 0),
 * requests (every request the page started, cache hits included), and the time to settled content
 * (scripts/qa/parity.js timeline: the moment the numbers on screen first reached their final value).
 * With --runs N the times are medians over N runs. --net vm (default) adds the measured link to the VM
 * (50 ms per request, 4 MB/s) on top of a local server, so a local mirror-mode run approximates the VM.
 *
 * The numbers shown (stat cards, id'd counters, facets, tables' first rows, charts) are extracted as
 * parity.js does and stored in <out>/<label>/<key>.json; --compare reports which pages show identical
 * numbers and, for those that do not, only the paths that differ (never the values).
 *
 * Session: the forged development cookie on localhost (parity.js sessionFor). Every non-GET request is aborted.
 * Default out: env QA_OUT, else <repo>/qa-out (git-ignored only if you add it).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./parity');

const REPO = path.resolve(__dirname, '..', '..');
const DEFAULT_PAGES = ['home', 'smart_meter', 'meter_utilization', 'performance_index', 'sheet_links', 'power_map',
  'highway_crossings', 'withheld', 'capex_all', 'loss', 'nsc', 'dtr_load'];
// The link to the VM as measured from the office on 6 Nov 2026 (curl: ~50 ms connect, ~4 MB/s for a 2 MB
// file). --net none measures the bare local server.
const NETS = {
  vm: { latency: 50, downloadThroughput: 4 * 1024 * 1024, uploadThroughput: 1024 * 1024 },
  none: null
};
const PROFILES = {
  desktop: { viewport: { width: 1440, height: 900 }, phone: false, cpu: 1 },
  phone: { viewport: { width: 390, height: 844 }, phone: true, cpu: 4 }
};

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s.startsWith('--')) {
      const k = s.slice(2);
      if (k.startsWith('no-')) a[k.slice(3)] = false;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) a[k] = argv[++i];
      else a[k] = true;
    } else a._.push(s);
  }
  return a;
}

const median = (xs) => {
  const a = xs.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
};

async function loadOnce(ctx, base, p, o) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  if (o.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: o.cpu });
  if (o.net) await cdp.send('Network.emulateNetworkConditions', Object.assign({ offline: false }, o.net));
  // Every request that is not GET/HEAD/OPTIONS is refused here (not with context.route(), which turns
  // the HTTP cache off and would make every warm load a cold one).
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  cdp.on('Fetch.requestPaused', (e) => {
    if (P.SAFE_METHODS.has(e.request.method)) return cdp.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
    o.blocked.push(e.request.method + ' ' + P.redactUrl(e.request.url).slice(0, 160));
    return cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
  });
  const net = { requests: 0, cacheHits: 0, notModified: 0, bytes: 0, byType: {} };
  const reqs = new Map();
  let inflight = 0, lastNet = Date.now();
  cdp.on('Network.requestWillBeSent', (e) => {
    if (/^(data|blob):/.test(e.request.url)) return;
    if (!reqs.has(e.requestId)) { net.requests++; inflight++; }
    reqs.set(e.requestId, { type: e.type || 'Other', done: false });
    lastNet = Date.now();
  });
  cdp.on('Network.responseReceived', (e) => {
    const r = reqs.get(e.requestId);
    if (!r) return;
    r.type = e.type || r.type;
    if (e.response.fromDiskCache || e.response.fromServiceWorker || e.response.fromPrefetchCache) net.cacheHits++;
    if (e.response.status === 304) net.notModified++;
  });
  const finish = (id, bytes) => {
    const r = reqs.get(id);
    if (!r || r.done) return;
    r.done = true;
    inflight = Math.max(0, inflight - 1);
    lastNet = Date.now();
    net.bytes += bytes || 0;
    net.byType[r.type] = (net.byType[r.type] || 0) + (bytes || 0);
  };
  cdp.on('Network.loadingFinished', (e) => finish(e.requestId, e.encodedDataLength));
  cdp.on('Network.loadingFailed', (e) => finish(e.requestId, 0));
  cdp.on('Network.requestServedFromCache', (e) => { const r = reqs.get(e.requestId); if (r) { net.cacheHits++; } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });

  const url = base + '/' + p.url.replace(/^\//, '');
  const t0 = Date.now();
  let navError = null;
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) { navError = String(e.message || e).split('\n')[0]; }
  const deadline = t0 + o.timeoutMs;
  let settledReason = 'timeout';
  while (Date.now() < deadline && !navError) {
    await new Promise((r) => setTimeout(r, 250));
    const st = await P.pageReadyState(page, false);
    const now = Date.now();
    const sinceChange = st.lastChange ? now - st.lastChange : now - t0;
    const quiet = inflight === 0 && now - lastNet > 1500;
    const elapsed = now - t0;
    if (elapsed < 2000) continue;
    if (st.skel === 0 && quiet && sinceChange > 2500) { settledReason = 'stable+idle'; break; }
    if (st.skel === 0 && sinceChange > 8000 && elapsed > 12000) { settledReason = 'stable(busy network)'; break; }
    if (sinceChange > 20000 && elapsed > 30000 && inflight === 0) { settledReason = 'stable(skeletons left)'; break; }
  }
  let data = null;
  try { data = await page.mainFrame().evaluate(P.extractPage, { sensitive: false }); } catch (e) { navError = navError || 'extract: ' + String(e.message || e).split('\n')[0]; }
  const tl = await P.timelineOf(page.mainFrame());
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    return n ? { dclMs: Math.round(n.domContentLoadedEventEnd), loadMs: Math.round(n.loadEventEnd) } : {};
  }).catch(() => ({}));
  const timing = P.timingFrom(tl, tl ? tl.origin : 0, nav);
  if (data) delete data.hubVersions; // versions differ by design
  const res = {
    finalDataMs: timing.finalDataMs, firstDataMs: timing.firstDataMs, settledMs: timing.settledMs, incomplete: !!timing.incomplete,
    dclMs: nav.dclMs, loadMs: nav.loadMs, settledReason, navError, finalUrl: page.url().replace(base, ''),
    bytes: net.bytes, requests: net.requests, cacheHits: net.cacheHits, notModified: net.notModified, byType: net.byType,
    errors: errors.slice(0, 10), data
  };
  await page.close().catch(() => {});
  return res;
}

async function measure(args) {
  // One or more targets, interleaved page by page and run by run, so machine noise hits them alike.
  const bases = String(args._[0] || '').split(',').map((b) => b.replace(/\/+$/, '')).filter(Boolean);
  const labels = String(args._[1] || '').split(',').filter(Boolean);
  if (!bases.length || bases.length !== labels.length) throw new Error('usage: node scripts/qa/speed.js <baseUrl[,baseUrl2]> <label[,label2]> [--pages a,b] [--runs n] [--no-phone]');
  const root = args.out || process.env.QA_OUT || path.join(REPO, 'qa-out');
  const runs = Math.max(1, Number(args.runs || 1));
  const timeoutMs = Number(args.timeout || 150) * 1000;
  const pages = P.navFromHtml(fs.readFileSync(path.join(REPO, 'app.html'), 'utf8'));
  const want = String(args.pages || DEFAULT_PAGES.join(',')).split(',').filter(Boolean);
  const chosen = want.map((k) => pages.find((p) => p.key === k || p.aliases.includes(k))).filter(Boolean);
  const profiles = args.phone === false ? ['desktop'] : ['desktop', 'phone'];
  const netName = String(args.net || 'vm');
  if (!(netName in NETS)) throw new Error('--net must be ' + Object.keys(NETS).join(' or '));
  const net = NETS[netName];

  const targets = [];
  for (let i = 0; i < bases.length; i++) {
    const base = bases[i], label = labels[i];
    const sess = P.sessionFor(base);
    const headers = sess ? { cookie: 'mzo_session=' + sess.value } : {};
    let appVersion = '';
    try { appVersion = (await (await fetch(base + '/version.json', { headers })).json()).version || ''; } catch (_) {}
    const outDir = path.join(root, label);
    fs.mkdirSync(outDir, { recursive: true });
    targets.push({ base, label, sess, appVersion, outDir, blocked: [],
      summary: { label, base, appVersion, startedAt: new Date().toISOString(), runs, net: netName, pages: {} } });
  }

  const pw = P.loadPlaywright();
  const browser = await pw.chromium.launch({ channel: process.env.QA_CHANNEL || 'chrome', headless: true });
  async function newContext(t, prof) {
    const ctx = await browser.newContext({
      viewport: prof.viewport, deviceScaleFactor: prof.phone ? 2 : 1, isMobile: prof.phone, hasTouch: prof.phone, serviceWorkers: 'block',
      userAgent: prof.phone ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' : undefined
    });
    const host = new URL(t.base).hostname;
    if (t.sess) await ctx.addCookies([{ name: 'mzo_session', value: t.sess.value, domain: host, path: '/', httpOnly: true, secure: t.base.startsWith('https'), sameSite: 'Lax' }]);
    await ctx.addInitScript(P.initScript, { profile: t.sess ? t.sess.profile : null, appVersion: t.appVersion, deep: true });
    return ctx;
  }

  console.log(`[speed] ${labels.join(' / ')}: ${chosen.length} pages × ${profiles.join('+')} × ${runs} run(s), link ${netName}, from ${bases.join(' / ')}`);
  const f = (x) => `${x.finalDataMs == null ? '-' : x.finalDataMs + 'ms'} ${(x.bytes / 1048576).toFixed(2)}MB ${x.requests}req`;
  for (const p of chosen) {
    const recs = targets.map(() => ({ key: p.key, url: p.url }));
    for (const pk of profiles) {
      const prof = PROFILES[pk];
      const all = targets.map(() => ({ cold: [], warm: [] }));
      for (let r = 0; r < runs; r++) {
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          const ctx = await newContext(t, prof);
          all[i].cold.push(await loadOnce(ctx, t.base, p, { timeoutMs, cpu: prof.cpu, net, blocked: t.blocked }));
          all[i].warm.push(await loadOnce(ctx, t.base, p, { timeoutMs, cpu: prof.cpu, net, blocked: t.blocked }));
          await ctx.close();
        }
      }
      targets.forEach((t, i) => {
        recs[i][pk] = {};
        for (const ph of ['cold', 'warm']) {
          const list = all[i][ph];
          const last = list[list.length - 1];
          recs[i][pk][ph] = Object.assign({}, last, {
            finalDataMs: median(list.map((x) => x.finalDataMs)), runsMs: list.map((x) => x.finalDataMs),
            bytes: median(list.map((x) => x.bytes)), requests: median(list.map((x) => x.requests))
          });
        }
      });
    }
    targets.forEach((t, i) => {
      const rec = recs[i];
      fs.writeFileSync(path.join(t.outDir, p.key + '.json'), JSON.stringify(rec, null, 1));
      const s = {};
      for (const pk of profiles) for (const ph of ['cold', 'warm']) {
        const x = rec[pk][ph];
        s[pk + '_' + ph] = { ms: x.finalDataMs, bytes: x.bytes, requests: x.requests, reason: x.settledReason, errors: x.errors.length };
      }
      t.summary.pages[p.key] = s;
      console.log(`[speed] ${t.label} ${p.key}: desktop cold ${f(rec.desktop.cold)} | warm ${f(rec.desktop.warm)}` +
        (rec.phone ? ` || phone cold ${f(rec.phone.cold)} | warm ${f(rec.phone.warm)}` : ''));
    });
  }
  await browser.close();
  for (const t of targets) {
    t.summary.finishedAt = new Date().toISOString();
    t.summary.blocked = t.blocked;
    fs.writeFileSync(path.join(t.outDir, '_summary.json'), JSON.stringify(t.summary, null, 1));
    console.log(`[speed] wrote ${t.outDir} (${t.blocked.length} non-GET requests blocked)`);
  }
}

/* ---------------- compare ---------------- */
const PARITY_FIELDS = ['h1', 'asOn', 'stats', 'idNums', 'facets', 'drill', 'rows', 'selects', 'dl', 'hist', 'tables', 'charts', 'messages'];

function diffPaths(a, b, pre, out) {
  if (out.length > 40) return out;
  if (a === b) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set(Object.keys(a).concat(Object.keys(b)));
    for (const k of keys) diffPaths(a[k], b[k], pre + '/' + k, out);
    return out;
  }
  out.push(pre);
  return out;
}

function countNumbers(d) {
  let kpis = 0, rows = 0, cells = 0;
  if (!d) return { kpis, rows, cells };
  kpis = Object.keys(d.stats || {}).length + Object.keys(d.idNums || {}).length + Object.keys(d.facets || {}).length + Object.keys(d.rows || {}).length;
  for (const t of Object.values(d.tables || {})) { rows += (t.first || []).length; (t.first || []).forEach((r) => { cells += r.length; }); }
  return { kpis, rows, cells };
}

function compare(args) {
  const [A, B] = args._;
  const root = args.out || process.env.QA_OUT || path.join(REPO, 'qa-out');
  const read = (l, k) => { try { return JSON.parse(fs.readFileSync(path.join(root, l, k + '.json'), 'utf8')); } catch (_) { return null; } };
  const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(root, B, '_summary.json'), 'utf8')).pages);
  const mb = (x) => (x == null ? '–' : (x / 1048576).toFixed(2));
  const s = (x) => (x == null ? '–' : (x / 1000).toFixed(1));
  const L = [`# Page speed: ${A} → ${B}`, '',
    'Bytes over the network (MB) and requests on a cold load; time to settled content in seconds (cold / warm); on a warm load, the bytes and the 304 revalidations. Phone: 390 px, CPU 4× slower.', '',
    '| Page | Desktop MB | Requests | Desktop cold s | Desktop warm s | Phone cold s | Phone warm s | Warm MB | Warm 304s |', '|---|---|---|---|---|---|---|---|---|'];
  const P2 = ['', '## Number parity', '', '| Page | KPIs compared | Table rows compared | Cells | Result |', '|---|---|---|---|---|'];
  for (const k of keys) {
    const a = read(A, k), b = read(B, k);
    if (!a || !b) { L.push(`| ${k} | missing | | | | | | | |`); continue; }
    const v = (r, pk, ph, f) => (r[pk] && r[pk][ph] ? r[pk][ph][f] : null);
    const pair = (fn, pk, ph, f) => `${fn(v(a, pk, ph, f))} → ${fn(v(b, pk, ph, f))}`;
    L.push(`| ${k} | ${pair(mb, 'desktop', 'cold', 'bytes')} | ${pair(String, 'desktop', 'cold', 'requests')} | ${pair(s, 'desktop', 'cold', 'finalDataMs')} | ${pair(s, 'desktop', 'warm', 'finalDataMs')} | ${pair(s, 'phone', 'cold', 'finalDataMs')} | ${pair(s, 'phone', 'warm', 'finalDataMs')} | ${pair(mb, 'desktop', 'warm', 'bytes')} | ${pair(String, 'desktop', 'warm', 'notModified')} |`);
    const results = [];
    for (const pk of ['desktop', 'phone']) for (const ph of ['cold', 'warm']) {
      const da = v(a, pk, ph, 'data'), db = v(b, pk, ph, 'data');
      if (!da || !db) continue;
      const diffs = [];
      for (const f of PARITY_FIELDS) diffPaths(da[f], db[f], f, diffs);
      results.push({ where: pk + ' ' + ph, diffs });
    }
    const n = countNumbers(v(b, 'desktop', 'cold', 'data'));
    const bad = results.filter((r) => r.diffs.length);
    P2.push(`| ${k} | ${n.kpis} | ${n.rows} | ${n.cells} | ${bad.length ? 'DIFFERS: ' + bad.map((r) => r.where + ' ' + r.diffs.slice(0, 6).join(', ')).join('; ') : 'identical (' + results.length + ' loads)'} |`);
  }
  const out = path.join(root, `speed-${A}-vs-${B}.md`);
  fs.writeFileSync(out, L.concat(P2).join('\n') + '\n');
  console.log(L.concat(P2).join('\n'));
  console.log('\n[speed] wrote ' + out);
}

const args = parseArgs(process.argv.slice(2));
(args.compare ? Promise.resolve().then(() => compare({ _: [args.compare].concat(args._), out: args.out })) : measure(args))
  .catch((e) => { console.error(e && e.stack || e); process.exit(1); });
