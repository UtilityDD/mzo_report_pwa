#!/usr/bin/env node
/* Parity harness: load every app.html NAV page (plus the shell) and record the numbers it shows.
 *
 *   node scripts/qa/parity.js <baseUrl> <label> [options]
 *
 *   --pages nsc,loss,...   only these NAV keys (shell = the app.html shell itself)
 *   --concurrency 3        pages loaded in parallel (keep it equal between runs you compare)
 *   --no-warm              skip the warm (second) load
 *   --no-phone             skip the 390px pass
 *   --phone-pages a,b      keys for the 390px pass (default: briefing, nsc, loss, stock, disconnection, meter_utilization)
 *   --timeout 150          seconds to wait for one page to settle (pages with skeletons and open requests wait this long)
 *   --out <dir>            output root (default: <repo>/../agent-progress/parity, or env QA_OUT)
 *
 * Session: on localhost the harness forges the dev test cookie (secret: env QA_JWT_SECRET or the
 * development fallback). Elsewhere it uses env QA_COOKIE (`mzo_session=<payload>.<sig>` or just the
 * value) or QA_COOKIE_FILE (a file holding it); without one every page lands on the login page and is
 * marked skipped.
 *
 * Safety: every browser request that is not GET/HEAD/OPTIONS is aborted and listed under `blocked`.
 *
 * Output: <out>/<label>/<key>.json per page and <out>/<label>/_run.json. Compare two runs with
 * scripts/qa/diff.js <labelA> <labelB>.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..', '..');
const DEFAULT_PHONE = ['home', 'nsc', 'loss', 'stock', 'disconnection', 'meter_utilization'];
const SENSITIVE_KEYS = /^(admin_|manpower$)/; // table cells are stored as short hashes
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/* ---------------- args ---------------- */
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

// Nearest agent-progress/parity above the checkout, else <repo>/qa-out (git-ignored only if you add it).
function defaultOut() {
  let d = REPO;
  for (let i = 0; i < 4; i++) {
    d = path.dirname(d);
    if (fs.existsSync(path.join(d, 'agent-progress'))) return path.join(d, 'agent-progress', 'parity');
  }
  return path.join(REPO, 'qa-out');
}

async function alive(base) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(base + '/login.html', { signal: AbortSignal.timeout(8000) });
      if (r.status < 500) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

function loadPlaywright() {
  const tries = ['playwright-core', 'playwright'];
  if (process.env.PLAYWRIGHT_CORE_PATH) tries.unshift(process.env.PLAYWRIGHT_CORE_PATH);
  for (const t of tries) { try { return require(t); } catch (_) {} }
  // npx cache (playwright-core is not a dependency of the app)
  const npx = path.join(os.homedir(), '.npm', '_npx');
  try {
    for (const d of fs.readdirSync(npx)) {
      const p = path.join(npx, d, 'node_modules', 'playwright-core');
      if (fs.existsSync(path.join(p, 'package.json'))) return require(p);
    }
  } catch (_) {}
  throw new Error('playwright-core not found: npm i -g playwright-core, or set PLAYWRIGHT_CORE_PATH');
}

/* ---------------- NAV ---------------- */
function navFromHtml(html) {
  const m = html.match(/var NAV = (\[[\s\S]*?\n\s*\]);\s*\n\s*var HOME = (\{[^\n]*\});\s*\n\s*var ASK = (\{[^\n]*\});/);
  if (!m) throw new Error('NAV block not found in app.html');
  const nav = vm.runInNewContext('(' + m[1] + ')');
  const home = vm.runInNewContext('(' + m[2] + ')');
  const ask = vm.runInNewContext('(' + m[3] + ')');
  const pages = [];
  const byUrl = {};
  const add = (key, name, url, group) => {
    if (byUrl[url]) { byUrl[url].aliases.push(key); return; }
    const p = { key, name, url, group, aliases: [] };
    byUrl[url] = p;
    pages.push(p);
  };
  add(home.k, home.n, home.u, '');
  add(ask.k, ask.n, ask.u, '');
  nav.forEach((g) => g.items.forEach((it) => add(it[0], it[1], it[2], g.label)));
  return pages;
}

/* ---------------- session ---------------- */
function isLocalBase(base) { return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(base); }

function sessionFor(base) {
  const profileDefault = { Username: 'local-preview', Name: 'Local Preview', role: 'admin', office_level: 'CE' };
  let given = process.env.QA_COOKIE || '';
  if (!given && process.env.QA_COOKIE_FILE) { try { given = fs.readFileSync(process.env.QA_COOKIE_FILE, 'utf8'); } catch (_) {} }
  if (given) {
    let v = given.trim().replace(/^cookie:\s*/i, '').replace(/^mzo_session=/, '').split(';')[0].trim();
    try { v = decodeURIComponent(v); } catch (_) {}
    let profile = profileDefault;
    try { profile = JSON.parse(Buffer.from(v.split('.')[0], 'base64').toString('utf8')).profile || profileDefault; } catch (_) {}
    return { value: v, profile, source: process.env.QA_COOKIE ? 'QA_COOKIE' : 'QA_COOKIE_FILE' };
  }
  if (!isLocalBase(base)) return null;
  const secret = process.env.QA_JWT_SECRET || 'mzo-portal-super-secret-key-123456';
  const payload = Buffer.from(JSON.stringify({ profile: profileDefault, expiry: Date.now() + 6 * 3600e3 })).toString('base64');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64');
  return { value: payload + '.' + sig, profile: profileDefault, source: 'forged' };
}

/* ---------------- in-page code ---------------- */
// Runs at document start in every frame: JS-level write block + a timeline of what the page shows.
function initScript(opts) {
  try {
    if (opts.profile) {
      localStorage.setItem('mzo_user_profile', JSON.stringify(opts.profile));
      localStorage.setItem('mzo_authenticated', 'true');
      if (opts.appVersion) localStorage.setItem('mzo_app_version', opts.appVersion);
    }
  } catch (_) {}
  if (window.__qa) return;
  const qa = window.__qa = { tl: [], last: null, dirty: true, blocked: [] };
  try {
    navigator.sendBeacon = function (u) { qa.blocked.push('beacon ' + String(u).slice(0, 200)); return true; };
  } catch (_) {}

  const txt = (el) => (el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  const LOADING = /^(loading|please wait|fetching|syncing|…|\.\.\.)/i;

  function sig() {
    const parts = [];
    let skel = 0, data = 0;
    document.querySelectorAll('.ui-stat .v, .ui-stat .s').forEach((v) => {
      if (v.querySelector('.ui-skel')) { skel++; parts.push('~'); return; }
      const t = txt(v);
      parts.push(t);
      if (/\d/.test(t)) data++;
    });
    document.querySelectorAll('table').forEach((t) => {
      const b = t.tBodies;
      let n = 0, real = 0;
      for (let i = 0; i < b.length; i++) {
        n += b[i].rows.length;
        if (!real && b[i].rows.length) {
          const r = b[i].rows[0];
          const tt = txt(r);
          if (!r.querySelector('.ui-empty, .ui-skel') && tt && !LOADING.test(tt)) real = 1;
        }
      }
      parts.push('t' + n + (t.tFoot ? ':' + txt(t.tFoot).slice(0, 200) : ''));
      if (real) data++;
    });
    document.querySelectorAll('.ui-panel-f span, .ui-date, #asOn, .ui-hist .row span:last-child').forEach((e) => parts.push(txt(e)));
    // opts.deep (scripts/qa/speed.js): the first rows' text too, so dates or cells filled in after the rows count.
    if (opts.deep) document.querySelectorAll('table').forEach((t) => { for (let b = 0; b < t.tBodies.length; b++) for (let r = 0; r < Math.min(10, t.tBodies[b].rows.length); r++) parts.push(hash(txt(t.tBodies[b].rows[r]))); });
    // Legacy counters: id'd leaf elements showing a number.
    const ids = document.querySelectorAll('[id]');
    for (let i = 0; i < ids.length && i < 3000; i++) {
      const el = ids[i];
      if (el.childElementCount || /^(SCRIPT|STYLE|OPTION|INPUT|TEXTAREA)$/.test(el.tagName) || /^leaflet-|\d{3,}$/.test(el.id)) continue;
      const t = el.textContent;
      if (t && t.length <= 40 && /\d/.test(t)) parts.push(el.id + '=' + t.trim());
    }
    if (window.Chart && window.Chart.instances) {
      try {
        Object.values(window.Chart.instances).forEach((c) => {
          const ds = (c.data && c.data.datasets) || [];
          ds.forEach((d) => { const s = (d.data || []).reduce((a, x) => a + (Number(typeof x === 'object' && x ? x.y : x) || 0), 0); parts.push('c' + s); if (s) data++; });
        });
      } catch (_) {}
    }
    return { s: parts.join('|'), skel, data };
  }
  function tick() {
    if (!qa.dirty) return;
    qa.dirty = false;
    try {
      const r = sig();
      const h = hash(r.s);
      if (h !== qa.last) {
        qa.last = h;
        qa.tl.push([Math.round(performance.now()), h, r.data > 0 && r.skel === 0 ? 1 : 0, r.skel]);
      }
    } catch (_) {}
  }
  qa.tick = function () { qa.dirty = true; tick(); };
  const start = () => {
    try { new MutationObserver(() => { qa.dirty = true; }).observe(document.documentElement, { subtree: true, childList: true, characterData: true }); } catch (_) {}
    setInterval(tick, 100);
  };
  if (document.documentElement) start(); else document.addEventListener('readystatechange', start, { once: true });
}

// Full extraction, run once the page has settled.
function extractPage(opts) {
  const txt = (el) => (el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const h8 = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return 'h:' + (h >>> 0).toString(16); };
  const cell = (s) => (opts.sensitive && s && s !== '—' ? h8(s) : clip(s, 80));
  const visible = (el) => !!(el && (el.offsetParent || el.getClientRects().length));
  const keyOf = (el, i, prefix) => {
    if (el.id) return prefix + '#' + el.id;
    const panel = el.closest('.ui-panel, section, .card, .panel');
    const h = panel && panel.querySelector('.ui-panel-h h2, .ui-panel-h h3, h2, h3, .card-header, .panel-title');
    return prefix + (h ? '[' + clip(txt(h), 40) + ']' : '') + '@' + i;
  };
  const uniqKey = (obj, k) => { let kk = k, n = 2; while (kk in obj) kk = k + ' #' + n++; return kk; };
  const out = { url: location.pathname + location.search, title: document.title, h1: clip(txt(document.querySelector('h1')), 120) };

  // Header dates ("as on")
  const asOn = [];
  document.querySelectorAll('#asOn, .ui-date, [id*="asOn" i], [id*="asof" i], [id*="lastUpdated" i], [id*="updated" i], [class*="as-on"], [class*="asof"]').forEach((e) => { const t = txt(e); if (t && asOn.indexOf(t) < 0) asOn.push(clip(t, 120)); });
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let node, seen = 0;
  while ((node = walker.nextNode()) && seen < 4000) {
    seen++;
    const t = String(node.nodeValue || '').replace(/\s+/g, ' ').trim();
    if (t && t.length < 120 && /\b(as on|as of|data as|updated|up to \d{1,2} [A-Z][a-z]{2} \d{4})/i.test(t) && /\d/.test(t)) {
      const full = clip(txt(node.parentElement), 120);
      if (asOn.indexOf(full) < 0) asOn.push(full);
    }
    if (asOn.length >= 12) break;
  }
  out.asOn = asOn;

  // Kit stat cards
  const stats = {};
  document.querySelectorAll('.ui-stats').forEach((sec, si) => {
    const sk = sec.id || ('stats' + si);
    sec.querySelectorAll('.ui-stat').forEach((st) => {
      const lab = txt(st.querySelector('.k')) || st.getAttribute('data-k') || '?';
      const v = st.querySelector('.v');
      const k = uniqKey(stats, sk + '/' + lab);
      stats[k] = { v: v && v.querySelector('.ui-skel') ? '<skeleton>' : txt(v), s: txt(st.querySelector('.s')) };
    });
  });
  out.stats = stats;

  // Numbers shown in id'd leaf elements (legacy pages without kit stats)
  const idNums = {};
  document.querySelectorAll('[id]').forEach((el) => {
    if (Object.keys(idNums).length >= 200) return;
    const tag = el.tagName;
    if (/^(SCRIPT|STYLE|OPTION|SELECT|INPUT|TEXTAREA|TABLE|TBODY|THEAD|TR|svg|SVG|TEMPLATE|DIALOG)$/.test(tag)) return;
    if (/^leaflet-|\d{3,}$/.test(el.id)) return; // generated ids (map tooltips, counters) differ run to run
    if (el.closest('.ui-stat, table, .ui-side, nav, #nav, #palList, .leaflet-container')) return;
    if (el.querySelector('[id], table, .ui-stat')) return;
    const t = txt(el);
    if (!t || t.length > 60 || !/\d/.test(t)) return;
    if (/^\d{1,2}:\d{2}/.test(t) || /\b(ago|just now)\b/i.test(t)) return; // clocks
    idNums[el.id] = t;
  });
  out.idNums = idNums;

  // Side-panel facets (option → count)
  const facets = {};
  document.querySelectorAll('.ui-opts').forEach((g, gi) => {
    const gk = g.id || ('facet' + gi);
    g.querySelectorAll('.ui-opt').forEach((o) => {
      const labEl = o.querySelector('span[title]') || [].find.call(o.querySelectorAll('span'), (x) => txt(x));
      const lab = txt(labEl) || o.getAttribute('data-v') || '?';
      facets[uniqKey(facets, gk + '/' + lab)] = txt(o.querySelector('small'));
    });
  });
  out.facets = facets;

  // Drill tabs and trail
  out.drill = [].map.call(document.querySelectorAll('.ui-drill-tab, .ui-drill-tabs button, .ui-trail, .ui-crumbs'), txt).filter(Boolean).slice(0, 20);

  // Briefing rows and other kit list rows: title → metric · detail
  const rows = {};
  document.querySelectorAll('.bf-row').forEach((r) => {
    rows[uniqKey(rows, txt(r.querySelector('.t')) || r.getAttribute('data-id') || '?')] = clip(txt(r.querySelector('.m')) + ' · ' + txt(r.querySelector('.d')), 200);
  });
  out.rows = rows;

  // Option counts of id'd selects (filter and form pages list offices, substations, PTRs from the data)
  const selects = {};
  document.querySelectorAll('select[id]').forEach((sel) => { if (sel.closest('#palList')) return; selects[sel.id] = sel.options.length; });
  out.selects = selects;

  // Definition lists (visible key/value pairs)
  const dl = {};
  document.querySelectorAll('.ui-dl, dl').forEach((d, di) => {
    if (!visible(d)) return;
    d.querySelectorAll('dt').forEach((dt) => { const dd = dt.nextElementSibling; dl[uniqKey(dl, (d.id || 'dl' + di) + '/' + clip(txt(dt), 40))] = cell(clip(txt(dd), 120)); });
  });
  out.dl = dl;

  // Histograms
  const hist = {};
  document.querySelectorAll('.ui-hist').forEach((hh, hi) => {
    hh.querySelectorAll('.row').forEach((r) => {
      const sp = r.querySelectorAll('span');
      hist[uniqKey(hist, (hh.id || 'hist' + hi) + '/' + txt(sp[0]))] = txt(sp[sp.length - 1]);
    });
  });
  out.hist = hist;

  // Tables
  const tables = {};
  let main = null, mainRows = -1;
  document.querySelectorAll('table').forEach((t, i) => {
    if (Object.keys(tables).length >= 25) return;
    const head = [].map.call(t.querySelectorAll('thead th'), (th) => clip(txt(th), 40));
    const body = [];
    for (let b = 0; b < t.tBodies.length; b++) for (let r = 0; r < t.tBodies[b].rows.length; r++) body.push(t.tBodies[b].rows[r]);
    const real = body.filter((r) => !r.querySelector('.ui-empty'));
    const first = real.slice(0, 5).map((r) => [].map.call(r.cells, (c) => cell(txt(c))));
    const foot = t.tFoot ? [].map.call(t.tFoot.rows, (r) => [].map.call(r.cells, (c) => clip(txt(c), 60))) : [];
    const panel = t.closest('.ui-panel, .ui-table-host, section, .card') || t.parentElement;
    const pf = panel && panel.querySelector('.ui-panel-f span');
    const k = uniqKey(tables, keyOf(t, i, 'table'));
    const vis = visible(t);
    const empty = body.length && !real.length ? txt(body[0]) : '';
    tables[k] = { visible: vis, rows: real.length, head, first, foot, footer: pf ? txt(pf) : '', empty: clip(empty, 120) };
    const score = (vis ? 1e7 : 0) + (t.closest('.ui-panel') ? 1e6 : 0) + real.length;
    if (score > mainRows) { mainRows = score; main = k; }
  });
  out.tables = tables;
  out.mainTable = main;

  // Charts: Chart.js instances and kit line charts (el.__lineCfg)
  const charts = {};
  if (window.Chart && window.Chart.instances) {
    try {
      Object.values(window.Chart.instances).forEach((c, ci) => {
        const id = (c.canvas && c.canvas.id) || 'chart' + ci;
        const ds = ((c.data && c.data.datasets) || []).map((d) => ({ label: d.label || '', n: (d.data || []).length, sum: Math.round(((d.data || []).reduce((a, x) => a + (Number(x && typeof x === 'object' ? x.y : x) || 0), 0)) * 1000) / 1000 }));
        charts[uniqKey(charts, 'chartjs:' + id)] = { type: (c.config && c.config.type) || '', labels: ((c.data && c.data.labels) || []).length, datasets: ds };
      });
    } catch (e) { charts.error = String(e); }
  }
  document.querySelectorAll('*').forEach((el, i) => {
    if (!el.__lineCfg) return;
    const cfg = el.__lineCfg;
    charts[uniqKey(charts, 'line:' + (el.id || i))] = {
      labels: (cfg.labels || []).length,
      firstLabel: String((cfg.labels || [])[0] || ''), lastLabel: String((cfg.labels || []).slice(-1)[0] || ''),
      datasets: (cfg.series || []).map((s) => ({ label: s.label || s.name || '', n: (s.values || []).length, sum: Math.round((s.values || []).reduce((a, x) => a + (Number(x) || 0), 0) * 1000) / 1000 }))
    };
  });
  out.charts = charts;

  // Visible empty / error messages
  out.messages = [].map.call(document.querySelectorAll('.ui-empty, .ui-error, .error, .alert-danger, [role="alert"]'), (e) => (visible(e) ? clip(txt(e), 160) : '')).filter(Boolean).slice(0, 10);
  out.skeletons = document.querySelectorAll('.ui-skel').length;

  // DataHub versions (not compared: mirror versions differ by design)
  const hub = {};
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^mzo_hub_ver_/.test(k)) hub[k.slice(12)] = clip(String(localStorage.getItem(k)), 80); } } catch (_) {}
  out.hubVersions = hub;
  return out;
}

/* ---------------- runner ---------------- */
function redactUrl(u) {
  return String(u).replace(/([?&](apikey|key|token|access_token|sig|signature)=)[^&#]*/gi, '$1<redacted>');
}

async function pageReadyState(page, isShell) {
  const frames = isShell ? page.frames() : [page.mainFrame()];
  let lastChange = 0, skel = 0, hasData = 0, tlLen = 0;
  for (const f of frames) {
    try {
      const r = await f.evaluate(() => {
        if (!window.__qa) return null;
        window.__qa.tick();
        const tl = window.__qa.tl;
        const last = tl[tl.length - 1] || [0, '', 0, 0];
        return { t: performance.timeOrigin + last[0], skel: last[3], data: last[2], n: tl.length };
      });
      if (!r) continue;
      lastChange = Math.max(lastChange, r.t); skel += r.skel; hasData = hasData || r.data; tlLen += r.n;
    } catch (_) {}
  }
  return { lastChange, skel, hasData, tlLen };
}

async function timelineOf(frame) {
  try {
    return await frame.evaluate(() => (window.__qa ? { origin: performance.timeOrigin, tl: window.__qa.tl, blocked: window.__qa.blocked } : null));
  } catch (_) { return null; }
}

function timingFrom(tlInfo, topOrigin, nav) {
  if (!tlInfo || !tlInfo.tl.length) return { firstDataMs: null, finalDataMs: null, settledMs: null, ...nav };
  const off = tlInfo.origin - topOrigin;
  const tl = tlInfo.tl;
  const last = tl[tl.length - 1];
  if (last[3] > 0) return { firstDataMs: null, finalDataMs: null, settledMs: Math.round(last[0] + off), changes: tl.length, incomplete: true, ...nav };
  const final = last[1];
  const firstData = tl.find((e) => e[2]);
  let firstFinal = null;
  for (const e of tl) if (e[1] === final) { firstFinal = e; break; }
  return {
    firstDataMs: firstData ? Math.round(firstData[0] + off) : null,
    finalDataMs: firstFinal ? Math.round(firstFinal[0] + off) : null,
    settledMs: Math.round(tl[tl.length - 1][0] + off),
    changes: tl.length,
    ...nav
  };
}

async function loadOnce(ctx, base, p, o) {
  const page = await ctx.newPage();
  const isShell = p.key === 'shell';
  const errors = { console: [], pageErrors: [], failed: [], aborted: [], http: [], blocked: [] };
  const net = { total: 0, byHost: {}, bytesByHost: {} };
  let inflight = 0, lastNet = Date.now();
  const onReq = (req) => {
    inflight++; lastNet = Date.now();
    net.total++;
    let host = '';
    try { host = new URL(req.url()).host; } catch (_) {}
    net.byHost[host] = (net.byHost[host] || 0) + 1;
  };
  const onDone = async (req) => {
    inflight = Math.max(0, inflight - 1); lastNet = Date.now();
    try {
      const s = await req.sizes();
      const host = new URL(req.url()).host;
      net.bytesByHost[host] = (net.bytesByHost[host] || 0) + (s.responseBodySize || 0);
    } catch (_) {}
  };
  const onFail = (req) => {
    inflight = Math.max(0, inflight - 1); lastNet = Date.now();
    const f = req.failure();
    const txt = f ? f.errorText : '';
    if (req.__qaBlocked) return;
    const item = { url: redactUrl(req.url()).slice(0, 300), method: req.method(), error: txt };
    // ERR_ABORTED is the page cancelling its own request (DataHub probes, superseded fetches).
    if (/ERR_ABORTED/.test(txt)) errors.aborted.push(item); else errors.failed.push(item);
  };
  page.on('request', onReq);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onFail);
  page.on('response', (res) => { if (res.status() >= 400) errors.http.push({ url: redactUrl(res.url()).slice(0, 300), status: res.status() }); });
  page.on('console', (m) => { if (m.type() === 'error') errors.console.push({ text: m.text().slice(0, 400), at: redactUrl((m.location() || {}).url || '').slice(0, 200) }); });
  page.on('pageerror', (e) => errors.pageErrors.push(String(e && e.message || e).slice(0, 400)));

  const url = base + '/' + p.url.replace(/^\//, '');
  const t0 = Date.now();
  let navError = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) { navError = String(e.message || e).split('\n')[0]; }

  // Settle: the shown numbers are stable, no skeletons, and the network is quiet.
  const deadline = t0 + o.timeoutMs;
  let state = null, settledReason = 'timeout';
  while (Date.now() < deadline && !navError) {
    await new Promise((r) => setTimeout(r, 300));
    state = await pageReadyState(page, isShell);
    const now = Date.now();
    const sinceChange = state.lastChange ? now - state.lastChange : now - t0;
    const quiet = inflight === 0 && now - lastNet > 1500;
    const elapsed = now - t0;
    if (elapsed < 2500) continue;
    if (state.skel === 0 && quiet && sinceChange > 2500) { settledReason = 'stable+idle'; break; }
    if (state.skel === 0 && sinceChange > 8000 && elapsed > 12000) { settledReason = 'stable(busy network)'; break; }
    // Skeletons left: keep waiting while the page still has requests open (some sheets take over a minute).
    if (sinceChange > 20000 && elapsed > 30000 && inflight === 0) { settledReason = 'stable(skeletons left)'; break; }
  }
  const settleMs = Date.now() - t0;

  let data = null, frameData = null, shell = null;
  try {
    data = await page.mainFrame().evaluate(extractPage, { sensitive: SENSITIVE_KEYS.test(p.key) });
  } catch (e) { navError = navError || 'extract: ' + String(e.message || e).split('\n')[0]; }
  const topTl = await timelineOf(page.mainFrame());
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    return n ? { dclMs: Math.round(n.domContentLoadedEventEnd), loadMs: Math.round(n.loadEventEnd), ttfbMs: Math.round(n.responseStart) } : {};
  }).catch(() => ({}));
  let timing = timingFrom(topTl, topTl ? topTl.origin : 0, nav);
  if (topTl) errors.blocked.push(...topTl.blocked);

  if (isShell) {
    shell = await page.evaluate(() => ({
      navItems: document.querySelectorAll('#nav .ni').length,
      groups: [].map.call(document.querySelectorAll('#nav .grp .ng .lbl'), (e) => e.textContent.trim()),
      frames: [].map.call(document.querySelectorAll('#stage iframe'), (f) => f.getAttribute('src')),
      title: document.title
    })).catch(() => null);
    const fr = page.frames().find((f) => f !== page.mainFrame() && /executive_briefing/.test(f.url()));
    if (fr) {
      frameData = await fr.evaluate(extractPage, { sensitive: false }).catch(() => null);
      const ftl = await timelineOf(fr);
      if (ftl && topTl) timing = { ...timingFrom(ftl, topTl.origin, nav), frame: 'executive_briefing.html' };
    }
  }

  const result = {
    url: redactUrl(url), startedAt: new Date(t0).toISOString(), settleMs, settledReason, navError,
    finalUrl: redactUrl(page.url()), timing, data, frameData, shell, errors, net
  };
  await page.close().catch(() => {});
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = String(args._[0] || '').replace(/\/+$/, '');
  const label = args._[1];
  if (!base || !label) {
    console.error('usage: node scripts/qa/parity.js <baseUrl> <label> [--pages a,b] [--concurrency 3] [--no-warm] [--no-phone]');
    process.exit(2);
  }
  const outRoot = args.out || process.env.QA_OUT || defaultOut();
  const outDir = path.join(outRoot, label);
  fs.mkdirSync(outDir, { recursive: true });
  const conc = Math.max(1, Number(args.concurrency || 3));
  const timeoutMs = Number(args.timeout || 150) * 1000;
  const doWarm = args.warm !== false;
  const doPhone = args.phone !== false;
  const phoneKeys = String(args['phone-pages'] || DEFAULT_PHONE.join(',')).split(',').filter(Boolean);

  const sess = sessionFor(base);
  const headers = sess ? { cookie: 'mzo_session=' + sess.value } : {};
  let appVersion = '';
  let mode = null;
  try { appVersion = (await (await fetch(base + '/version.json', { headers })).json()).version || ''; } catch (_) {}
  try { const r = await fetch(base + '/api/data/status', { headers }); mode = { status: r.status, body: r.ok ? await r.json() : (await r.text()).slice(0, 200) }; } catch (e) { mode = { error: String(e.message || e) }; }

  // Where each server meta endpoint points the pages (host + path only), so a diff can tell a
  // source switch (Google fallback vs Supabase Storage vs mirror) from a parity failure.
  const sources = {};
  if (sess) {
    for (const ep of ['nsc', 'stock', 'defective', 'disconnection', 'pending-mc', 'load-extension', 'power-map']) {
      try {
        const r = await fetch(base + '/api/' + ep + '/meta', { headers, signal: AbortSignal.timeout(30000) });
        const j = r.ok ? await r.json() : null;
        const urls = {};
        const walk = (o, pre) => { if (!o || typeof o !== 'object') return; for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && /^(https?:\/\/|\/api\/)/.test(v) && /url/i.test(k)) urls[pre + k] = v.replace(/\?.*$/, ''); else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, pre + k + '.'); } };
        walk(j, '');
        sources[ep] = { status: r.status, version: j && (j.version || j.withheldVersion || '') ? String(j.version || '').slice(0, 80) : '', urls };
      } catch (e) { sources[ep] = { error: String(e.message || e).slice(0, 120) }; }
    }
  }

  let appHtml = '';
  if (sess) { try { const r = await fetch(base + '/app.html', { headers }); if (r.ok) appHtml = await r.text(); } catch (_) {} }
  let navSource = 'served app.html';
  if (!/var NAV = /.test(appHtml)) { appHtml = fs.readFileSync(path.join(REPO, 'app.html'), 'utf8'); navSource = 'local app.html'; }
  let pages = navFromHtml(appHtml);
  pages.unshift({ key: 'shell', name: 'Workstation shell', url: 'app.html', group: '', aliases: [] });
  if (args.pages) {
    const want = new Set(String(args.pages).split(','));
    pages = pages.filter((p) => want.has(p.key) || p.aliases.some((a) => want.has(a)));
  }
  if (!sess) console.warn('No session (set QA_COOKIE for non-local bases): pages will land on the login page and be marked skipped.');

  const pw = loadPlaywright();
  const browser = await pw.chromium.launch({ channel: process.env.QA_CHANNEL || 'chrome', headless: true });

  async function newContext(viewport, phone) {
    const ctx = await browser.newContext({
      viewport, deviceScaleFactor: phone ? 2 : 1, isMobile: !!phone, hasTouch: !!phone,
      userAgent: phone ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' : undefined,
      ignoreHTTPSErrors: false
    });
    const host = new URL(base).hostname;
    if (sess) await ctx.addCookies([{ name: 'mzo_session', value: sess.value, domain: host, path: '/', httpOnly: true, secure: base.startsWith('https'), sameSite: 'Lax' }]);
    await ctx.addInitScript(initScript, { profile: sess ? sess.profile : null, appVersion });
    await ctx.route('**/*', (route) => {
      const req = route.request();
      if (SAFE_METHODS.has(req.method())) return route.continue();
      req.__qaBlocked = true;
      blockedAll.push({ method: req.method(), url: redactUrl(req.url()).slice(0, 200) });
      return route.abort('blockedbyclient');
    });
    return ctx;
  }
  const blockedAll = [];

  const runInfo = {
    label, base, startedAt: new Date().toISOString(), host: os.hostname(), appVersion, navSource, mode,
    session: sess ? sess.source : 'none', sources, concurrency: conc, warm: doWarm, phone: doPhone ? phoneKeys : [],
    pages: pages.map((p) => ({ key: p.key, url: p.url, aliases: p.aliases }))
  };
  console.log(`[parity] ${label}: ${pages.length} pages from ${base} (app ${appVersion || '?'}, ${navSource}, session ${runInfo.session}, concurrency ${conc})`);

  const queue = pages.slice();
  let done = 0, aborted = '';
  if (!(await alive(base))) { console.error('[parity] ' + base + ' is not answering'); process.exit(1); }
  async function worker() {
    for (;;) {
      const p = queue.shift();
      if (!p) return;
      if (aborted) return;
      if (!(await alive(base))) {
        aborted = 'server at ' + base + ' stopped answering before ' + p.key;
        console.error('[parity] ABORT: ' + aborted);
        return;
      }
      const rec = { key: p.key, name: p.name, url: p.url, group: p.group, aliases: p.aliases, label, base };
      try {
        const ctx = await newContext({ width: 1280, height: 800 }, false);
        rec.desktop = { cold: await loadOnce(ctx, base, p, { timeoutMs }) };
        if (doWarm) rec.desktop.warm = await loadOnce(ctx, base, p, { timeoutMs });
        await ctx.close();
        if (doPhone && (phoneKeys.includes(p.key) || p.aliases.some((a) => phoneKeys.includes(a)))) {
          const pctx = await newContext({ width: 390, height: 844 }, true);
          rec.phone = { cold: await loadOnce(pctx, base, p, { timeoutMs }) };
          await pctx.close();
        }
        if (/\/login\.html/.test((rec.desktop.cold || {}).finalUrl || '') && p.url !== 'login.html') rec.skipped = 'redirected to login (no valid session)';
      } catch (e) {
        rec.error = String(e && e.stack || e).slice(0, 800);
      }
      fs.writeFileSync(path.join(outDir, p.key + '.json'), JSON.stringify(rec, null, 1));
      done++;
      const c = rec.desktop && rec.desktop.cold, w = rec.desktop && rec.desktop.warm;
      const fmt = (x) => (x && x.timing && x.timing.finalDataMs != null ? x.timing.finalDataMs + 'ms' : '-');
      console.log(`[parity] ${done}/${pages.length} ${p.key}: cold ${fmt(c)} warm ${fmt(w)} ${c ? c.settledReason : ''}${rec.skipped ? ' SKIPPED' : ''}${rec.error ? ' ERROR' : ''}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, pages.length) }, worker));
  await browser.close();
  runInfo.finishedAt = new Date().toISOString();
  if (aborted) runInfo.aborted = aborted;
  runInfo.blockedRequests = blockedAll;
  fs.writeFileSync(path.join(outDir, '_run.json'), JSON.stringify(runInfo, null, 1));
  console.log(`[parity] wrote ${outDir} (${blockedAll.length} non-GET requests blocked)`);
  if (aborted) process.exit(3);
}

// Required by scripts/qa/speed.js for the same session, timeline and extraction code.
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { initScript, extractPage, timingFrom, timelineOf, pageReadyState, sessionFor, loadPlaywright, navFromHtml, redactUrl, SAFE_METHODS };
