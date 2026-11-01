#!/usr/bin/env node
/* Compare two parity runs (scripts/qa/parity.js) and write a readable report.
 *
 *   node scripts/qa/diff.js <labelA> <labelB> [--volatile <labelC>[,<labelD>]] [--out <dir>]
 *
 *   --volatile  runs of the same mode as A taken at another time: any field that differs between A
 *               and those runs is tagged "moves by itself" (live sheets changing), not a parity failure.
 *
 * Writes <out>/diff-<A>-<B>.md and <out>/diff-<A>-<B>.json.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const KEY_PAGES = ['home', 'nsc', 'loss', 'stock', 'meter_utilization', 'defective_meter', 'disconnection', 'performance_index'];
const GOOGLE = /(^|\.)(google\.com|googleusercontent\.com|gstatic\.com)$/i;
const PHASES = [['desktop', 'cold'], ['desktop', 'warm'], ['phone', 'cold']];

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s.startsWith('--')) { const k = s.slice(2); if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) a[k] = argv[++i]; else a[k] = true; } else a._.push(s);
  }
  return a;
}

function loadRun(root, label) {
  const dir = path.join(root, label);
  if (!fs.existsSync(dir)) throw new Error('no run at ' + dir);
  const pages = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try { const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); pages[r.key] = r; } catch (e) { console.warn('skip ' + f + ': ' + e.message); }
  }
  let run = {};
  try { run = JSON.parse(fs.readFileSync(path.join(dir, '_run.json'), 'utf8')); } catch (_) {}
  return { label, run, pages };
}

// path → string for every compared value.
function flatten(load) {
  const out = {};
  if (!load) return out;
  const put = (k, v) => { out[k] = v == null ? '' : String(v); };
  const walkData = (d, pre) => {
    if (!d) return;
    put(pre + 'title', d.title);
    put(pre + 'h1', d.h1);
    put(pre + 'asOn', (d.asOn || []).join(' ¦ '));
    for (const [k, v] of Object.entries(d.stats || {})) { put(pre + 'stat[' + k + ']', v.v); put(pre + 'stat[' + k + '].sub', v.s); }
    for (const [k, v] of Object.entries(d.idNums || {})) put(pre + 'id[' + k + ']', v);
    for (const [k, v] of Object.entries(d.facets || {})) put(pre + 'facet[' + k + ']', v);
    for (const [k, v] of Object.entries(d.hist || {})) put(pre + 'hist[' + k + ']', v);
    for (const [k, v] of Object.entries(d.rows || {})) put(pre + 'row[' + k + ']', v);
    for (const [k, v] of Object.entries(d.dl || {})) put(pre + 'dl[' + k + ']', v);
    for (const [k, v] of Object.entries(d.selects || {})) put(pre + 'select[' + k + '].options', v);
    put(pre + 'drill', (d.drill || []).join(' ¦ '));
    for (const [k, t] of Object.entries(d.tables || {})) {
      const tp = pre + k;
      put(tp + '.rows', t.rows);
      put(tp + '.head', (t.head || []).join(' | '));
      (t.first || []).forEach((r, i) => put(tp + '.row' + (i + 1), r.join(' | ')));
      (t.foot || []).forEach((r, i) => put(tp + '.foot' + (i + 1), r.join(' | ')));
      put(tp + '.footer', t.footer);
      if (t.empty) put(tp + '.empty', t.empty);
    }
    for (const [k, c] of Object.entries(d.charts || {})) {
      if (typeof c !== 'object') continue;
      put(pre + k + '.labels', c.labels);
      if (c.firstLabel != null) put(pre + k + '.range', c.firstLabel + ' → ' + c.lastLabel);
      (c.datasets || []).forEach((s, i) => put(pre + k + '.ds' + i + '[' + s.label + ']', s.n + ' pts, sum ' + s.sum));
    }
    put(pre + 'messages', (d.messages || []).join(' ¦ '));
  };
  walkData(load.data, '');
  if (load.frameData) walkData(load.frameData, 'frame:');
  if (load.shell) { put('shell.navItems', load.shell.navItems); put('shell.groups', (load.shell.groups || []).join(' ¦ ')); }
  if (load.navError) put('navError', load.navError);
  if (load.finalUrl) put('finalPath', String(load.finalUrl).replace(/^https?:\/\/[^/]+/, ''));
  return out;
}

function getLoad(rec, vp, ph) { return rec && rec[vp] && rec[vp][ph]; }

function diffMaps(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const res = [];
  for (const k of keys) {
    const va = k in a ? a[k] : '(absent)', vb = k in b ? b[k] : '(absent)';
    if (va !== vb) res.push({ field: k, a: va, b: vb });
  }
  return res.sort((x, y) => x.field.localeCompare(y.field));
}

const md = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 220);
const ms = (x) => (x == null ? '–' : x >= 10000 ? (x / 1000).toFixed(1) + ' s' : x + ' ms');
const ratio = (a, b) => (a && b ? (a / b).toFixed(1) + '×' : '–');
const median = (xs) => { const v = xs.filter((x) => x != null).sort((p, q) => p - q); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2); };
function googleReqs(load) { if (!load || !load.net) return null; let n = 0; for (const [h, c] of Object.entries(load.net.byHost || {})) if (GOOGLE.test(h.replace(/:\d+$/, ''))) n += c; return n; }
function bytesKB(load, onlyGoogle) { if (!load || !load.net) return null; let n = 0; for (const [h, c] of Object.entries(load.net.bytesByHost || {})) if (!onlyGoogle || GOOGLE.test(h.replace(/:\d+$/, ''))) n += c; return Math.round(n / 1024); }
function errList(load) {
  if (!load) return [];
  const e = load.errors || {};
  const out = [];
  (e.pageErrors || []).forEach((x) => out.push('pageerror: ' + x));
  (e.console || []).forEach((x) => out.push('console: ' + x.text));
  (e.failed || []).forEach((x) => out.push('failed ' + x.method + ' ' + x.url.replace(/\?.*$/, '') + ' (' + x.error + ')'));
  (e.http || []).forEach((x) => out.push('http ' + x.status + ' ' + x.url.replace(/\?.*$/, '')));
  if (load.navError) out.push('nav: ' + load.navError);
  return out;
}
const errNorm = (s) => s.replace(/\d+/g, '#').replace(/https?:\/\/[^/\s]+/g, '');

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [la, lb] = args._;
  if (!la || !lb) { console.error('usage: node scripts/qa/diff.js <labelA> <labelB> [--volatile <labelC>]'); process.exit(2); }
  const root = args.out || process.env.QA_OUT || path.resolve(REPO, '..', '..', 'agent-progress', 'parity');
  const A = loadRun(root, la), B = loadRun(root, lb);
  const vols = args.volatile ? String(args.volatile).split(',').map((l) => loadRun(root, l)) : [];

  const keys = [...new Set([...Object.keys(A.pages), ...Object.keys(B.pages)])];
  const order = (A.run.pages || B.run.pages || []).map((p) => p.key);
  keys.sort((x, y) => (order.indexOf(x) + 1 || 999) - (order.indexOf(y) + 1 || 999));

  const mismatches = [], volatileHits = [], status = [], timing = [], errors = [], coldWarm = [];
  for (const k of keys) {
    const ra = A.pages[k], rb = B.pages[k];
    const name = (ra || rb).name || k, url = (ra || rb).url;
    if (!ra || !rb) { status.push({ key: k, url, note: !ra ? 'missing in ' + la : 'missing in ' + lb }); continue; }
    if (ra.skipped || rb.skipped || ra.error || rb.error) status.push({ key: k, url, note: [ra.skipped && la + ': ' + ra.skipped, rb.skipped && lb + ': ' + rb.skipped, ra.error && la + ' error: ' + ra.error.split('\n')[0], rb.error && lb + ' error: ' + rb.error.split('\n')[0]].filter(Boolean).join('; ') });
    let pageMis = 0, pageVol = 0;
    for (const [vp, ph] of PHASES) {
      const a = getLoad(ra, vp, ph), b = getLoad(rb, vp, ph);
      if (!a || !b) continue;
      const fa = flatten(a), fb = flatten(b);
      // fields that move by themselves: differ between A and a later run of the same mode, or between A's cold and warm loads
      const moving = new Set();
      for (const v of vols) { const lv = getLoad(v.pages[k], vp, ph) || getLoad(v.pages[k], 'desktop', 'cold'); if (lv) diffMaps(fa, flatten(lv)).forEach((d) => moving.add(d.field)); }
      // A's own cold vs warm loads (minutes apart) also show what moves.
      if (ph === 'warm' || vp === 'phone') { const lc = getLoad(ra, 'desktop', 'cold'); if (lc && lc !== a) diffMaps(flatten(lc), fa).forEach((d) => moving.add(d.field)); }
      for (const d of diffMaps(fa, fb)) {
        const item = { page: k, name, url, phase: vp + '/' + ph, field: d.field, a: d.a, b: d.b };
        if (moving.has(d.field)) { item.volatile = true; volatileHits.push(item); pageVol++; } else { mismatches.push(item); pageMis++; }
      }
    }
    for (const [lab, r] of [[la, ra], [lb, rb]]) {
      const c = getLoad(r, 'desktop', 'cold'), w = getLoad(r, 'desktop', 'warm');
      if (c && w) { const d = diffMaps(flatten(c), flatten(w)); if (d.length) coldWarm.push({ label: lab, page: k, n: d.length, sample: d.slice(0, 3) }); }
    }
    const ac = getLoad(ra, 'desktop', 'cold'), bc = getLoad(rb, 'desktop', 'cold'), aw = getLoad(ra, 'desktop', 'warm'), bw = getLoad(rb, 'desktop', 'warm');
    const ap = getLoad(ra, 'phone', 'cold'), bp = getLoad(rb, 'phone', 'cold');
    const t = (l) => (l && l.timing ? l.timing.finalDataMs : null);
    timing.push({ key: k, name, aCold: t(ac), bCold: t(bc), aWarm: t(aw), bWarm: t(bw), aPhone: t(ap), bPhone: t(bp), aG: googleReqs(ac), bG: googleReqs(bc), aKB: bytesKB(ac), bKB: bytesKB(bc), aGKB: bytesKB(ac, true), bGKB: bytesKB(bc, true), aReq: ac && ac.net ? ac.net.total : null, bReq: bc && bc.net ? bc.net.total : null, mis: pageMis, vol: pageVol });
    for (const [vp, ph] of PHASES) {
      const a = getLoad(ra, vp, ph), b = getLoad(rb, vp, ph);
      const ea = errList(a), eb = errList(b);
      if (!ea.length && !eb.length) continue;
      const na = new Set(ea.map(errNorm));
      errors.push({ page: k, phase: vp + '/' + ph, a: ea, b: eb, newInB: eb.filter((x) => !na.has(errNorm(x))) });
    }
  }

  // ---- report ----
  const L = [];
  const runLine = (R) => `- **${R.label}**: ${R.run.base || '?'} · app ${R.run.appVersion || '?'} · ${R.run.startedAt || '?'} → ${R.run.finishedAt || '?'} · mode ${R.run.mode && R.run.mode.status === 200 ? JSON.stringify(R.run.mode.body).slice(0, 160) : 'original (no /api/data/status)'} · concurrency ${R.run.concurrency || '?'}`;
  L.push(`# Parity: ${la} vs ${lb}`, '');
  L.push(runLine(A), runLine(B));
  vols.forEach((v) => L.push(runLine(v) + ' (stability reference for ' + la + ')'));
  L.push('');
  const pagesWithMis = new Set(mismatches.map((m) => m.page));
  L.push('## Summary', '');
  L.push(`- Pages compared: ${keys.length}. Pages identical on every compared field: ${keys.length - pagesWithMis.size - status.filter((s) => /missing/.test(s.note)).length}.`);
  L.push(`- **Mismatches: ${mismatches.length}** on ${pagesWithMis.size} page(s)` + (vols.length ? `; plus ${volatileHits.length} difference(s) on fields that also moved between ${la} and ${vols.map((v) => v.label).join(', ')} (live data changing, not parity failures).` : '.'));
  const med = (f) => median(timing.map(f));
  L.push(`- Median time to final data paint, desktop cold: ${la} ${ms(med((t) => t.aCold))}, ${lb} ${ms(med((t) => t.bCold))}; warm: ${la} ${ms(med((t) => t.aWarm))}, ${lb} ${ms(med((t) => t.bWarm))}.`);
  const sumG = (f) => timing.reduce((s, t) => s + (f(t) || 0), 0);
  L.push(`- Requests to Google hosts on cold loads (all pages): ${la} ${sumG((t) => t.aG)}, ${lb} ${sumG((t) => t.bG)}. Bytes from Google: ${la} ${Math.round(sumG((t) => t.aGKB) / 1024)} MB, ${lb} ${Math.round(sumG((t) => t.bGKB) / 1024)} MB.`);
  const newErr = errors.filter((e) => e.newInB.length);
  L.push(`- Pages with errors new in ${lb}: ${new Set(newErr.map((e) => e.page)).size}.`);
  if (status.length) { L.push('', '### Page status', ''); status.forEach((s) => L.push(`- \`${s.key}\` (${s.url}): ${md(s.note)}`)); }
  L.push('');

  L.push('## Mismatches', '');
  if (!mismatches.length) L.push('None.');
  else {
    L.push(`| Page | Phase | Field | ${la} | ${lb} |`, '|---|---|---|---|---|');
    mismatches.forEach((m) => L.push(`| ${md(m.page)} (${md(m.url)}) | ${m.phase} | ${md(m.field)} | ${md(m.a)} | ${md(m.b)} |`));
  }
  L.push('');
  if (vols.length) {
    L.push(`## Differences on fields that move by themselves`, '', `These fields also differ between ${la} and ${vols.map((v) => v.label).join(', ')} (same mode, different time), so they are expected to drift.`, '');
    if (!volatileHits.length) L.push('None.');
    else { L.push(`| Page | Phase | Field | ${la} | ${lb} |`, '|---|---|---|---|---|'); volatileHits.forEach((m) => L.push(`| ${md(m.page)} | ${m.phase} | ${md(m.field)} | ${md(m.a)} | ${md(m.b)} |`)); }
    L.push('');
  }

  L.push('## Timing', '', 'Time from navigation start to the moment the page first shows its final numbers (stat cards, table counts, totals). Cold = fresh browser profile; warm = same profile, page opened again (IndexedDB and HTTP cache filled). Google = requests to Google hosts on the cold load.', '');
  const tableRows = (list) => {
    L.push(`| Page | Cold ${la} | Cold ${lb} | Speed-up | Warm ${la} | Warm ${lb} | Speed-up | Phone ${la} | Phone ${lb} | Google req ${la}/${lb} | KB ${la}/${lb} |`, '|---|---|---|---|---|---|---|---|---|---|---|');
    list.forEach((t) => L.push(`| ${md(t.key)} | ${ms(t.aCold)} | ${ms(t.bCold)} | ${ratio(t.aCold, t.bCold)} | ${ms(t.aWarm)} | ${ms(t.bWarm)} | ${ratio(t.aWarm, t.bWarm)} | ${ms(t.aPhone)} | ${ms(t.bPhone)} | ${t.aG == null ? '–' : t.aG}/${t.bG == null ? '–' : t.bG} | ${t.aKB == null ? '–' : t.aKB}/${t.bKB == null ? '–' : t.bKB} |`));
  };
  L.push('### Key pages', '');
  tableRows(timing.filter((t) => KEY_PAGES.includes(t.key)).sort((x, y) => KEY_PAGES.indexOf(x.key) - KEY_PAGES.indexOf(y.key)));
  L.push('', '### All pages', '');
  tableRows(timing);
  L.push('');

  L.push('## Errors', '', `Console errors, page errors, failed requests (excluding the page's own aborted requests and the harness's blocked writes) and HTTP ≥ 400. "New in ${lb}" ignores digits and hosts.`, '');
  if (!errors.length) L.push('None.');
  errors.forEach((e) => {
    L.push(`- **${e.page}** ${e.phase}: ${la} ${e.a.length}, ${lb} ${e.b.length}${e.newInB.length ? ', new in ' + lb + ': ' + e.newInB.length : ''}`);
    e.newInB.slice(0, 6).forEach((x) => L.push(`  - new: ${md(x)}`));
    e.a.filter((x) => !e.newInB.includes(x)).slice(0, 3).forEach((x) => L.push(`  - ${la}: ${md(x)}`));
    if (!e.newInB.length) e.b.slice(0, 3).forEach((x) => L.push(`  - ${lb}: ${md(x)}`));
  });
  L.push('');
  if (coldWarm.length) {
    L.push('## Cold vs warm inside one run', '', 'The same page showed different numbers on its warm reload (data changed mid-run, or the cached copy differs from the fresh one).', '');
    coldWarm.forEach((c) => L.push(`- ${c.label} \`${c.page}\`: ${c.n} field(s), e.g. ${c.sample.map((d) => md(d.field) + ': ' + md(d.a) + ' → ' + md(d.b)).join('; ')}`));
    L.push('');
  }

  const base = path.join(root, `diff-${la}-${lb}`);
  fs.writeFileSync(base + '.md', L.join('\n'));
  fs.writeFileSync(base + '.json', JSON.stringify({ a: la, b: lb, volatile: vols.map((v) => v.label), mismatches, volatileHits, status, timing, errors, coldWarm }, null, 1));
  console.log(`[diff] ${mismatches.length} mismatches on ${pagesWithMis.size} pages (${volatileHits.length} on moving fields) → ${base}.md`);
}

main();
