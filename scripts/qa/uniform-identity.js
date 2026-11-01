#!/usr/bin/env node
/* Node and the browser must turn the same bytes into the same rows. For every snapshot in a
 * folder this builds the uniform rows three ways and compares the sha1 of the JSON text:
 *   node     lib/uniform.js required in Node (what vm/sync/rows.js writes on the VM)
 *   page     lib/uniform.js on a page's main thread in headless Chrome
 *   worker   mzo_rows.js as a Web Worker (the path big datasets take in the browser)
 * Each dataset runs with its schema/<key>.json when one exists, and also without a schema.
 *
 *   node scripts/qa/uniform-identity.js --snap <snapshotDir> --base http://127.0.0.1:3800 [--only a,b]
 *
 * --base is any running copy of this app (only /lib/*.js, /mzo_rows.js and /data/costcenter.json
 * are fetched from it; snapshot bytes are handed to the page by Playwright). Exit 1 on a mismatch.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; }

function loadPlaywright() {
  for (const t of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core', 'playwright', path.join(REPO, 'node_modules', 'playwright-core')]) {
    if (!t) continue;
    try { return require(t); } catch (_) { /* next */ }
  }
  // npx cache (playwright-core is not a dependency of the app)
  const npx = path.join(require('os').homedir(), '.npm', '_npx');
  try {
    for (const d of fs.readdirSync(npx)) {
      const p = path.join(npx, d, 'node_modules', 'playwright-core');
      if (fs.existsSync(path.join(p, 'package.json'))) return require(p);
    }
  } catch (_) { /* none */ }
  throw new Error('playwright-core not found (set PLAYWRIGHT_CORE_PATH)');
}

async function main() {
  const snap = path.resolve(arg('snap'));
  const base = String(arg('base', 'http://127.0.0.1:3800')).replace(/\/+$/, '');
  const only = arg('only') ? new Set(arg('only').split(',')) : null;
  const U = require(path.join(REPO, 'lib', 'uniform.js'));
  U.useOffices(require(path.join(REPO, 'lib', 'offices.js')), JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'costcenter.json'), 'utf8')));
  const files = fs.readdirSync(snap).filter((f) => /^[a-z0-9_]+\.(csv|tsv|json)$/.test(f) && f !== 'manifest.json' && !/\.rows\./.test(f)).sort()
    .filter((f) => !only || only.has(f.replace(/\.\w+$/, '')));
  const jobs = [];
  for (const f of files) {
    const key = f.replace(/\.\w+$/, '');
    let schema = null;
    try { schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schema', key + '.json'), 'utf8')); } catch (_) { /* none */ }
    for (const sc of schema ? [schema, null] : [null]) jobs.push({ key, file: f, format: f.split('.').pop(), schema: sc });
  }
  const t0 = Date.now();
  for (const j of jobs) {
    const text = fs.readFileSync(path.join(snap, j.file), 'utf8');
    const s = Date.now();
    const json = U.stringify(U.build(text, { key: j.key, version: 'identity', format: j.format, schema: j.schema }));
    j.node = { sha1: crypto.createHash('sha1').update(json, 'utf8').digest('hex'), bytes: Buffer.byteLength(json), ms: Date.now() - s };
  }
  console.log(`[identity] node: ${jobs.length} builds in ${Date.now() - t0} ms; logic ${U.VERSION}+${U.officesTag()}`);

  const pw = loadPlaywright();
  const browser = await pw.chromium.launch({ channel: process.env.QA_CHANNEL || 'chrome', headless: true });
  const ctx = await browser.newContext();
  await ctx.route('**/*', (route) => {
    const req = route.request();
    if (!['GET', 'HEAD'].includes(req.method())) return route.abort('blockedbyclient');
    const u = new URL(req.url());
    const m = /^\/__snap\/([a-z0-9_]+\.(csv|tsv|json))$/.exec(u.pathname);
    if (m) return route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: fs.readFileSync(path.join(snap, m[1])) });
    return route.continue();
  });
  const page = await ctx.newPage();
  await page.goto(base + '/offline.html');
  await page.addScriptTag({ url: '/lib/offices.js?v=1' });
  await page.addScriptTag({ url: '/lib/uniform.js?v=1' });
  await page.evaluate(async () => {
    const cc = await (await fetch('/data/costcenter.json')).json();
    window.MzoUniform.useOffices(window.MzoOffices, cc);
    window.__cc = cc;
    window.__w = new Worker('/mzo_rows.js?v=1&worker=1');
    window.__wq = {};
    window.__w.onmessage = (e) => { const r = window.__wq[e.data.id]; delete window.__wq[e.data.id]; r(e.data); };
  });
  let bad = 0;
  const tB = Date.now();
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const r = await page.evaluate(async ({ j, id }) => {
      const text = await (await fetch('/__snap/' + j.file)).text();
      const hex = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, '0')).join('');
      const opts = { key: j.key, version: 'identity', format: j.format, schema: j.schema };
      let s = performance.now();
      const json = window.MzoUniform.stringify(window.MzoUniform.build(text, opts));
      const page = { sha1: await hex(json), ms: Math.round(performance.now() - s) };
      s = performance.now();
      const out = await new Promise((resolve) => { window.__wq[id] = resolve; window.__w.postMessage({ id, input: text, opts, costCentres: window.__cc }); });
      const worker = out.error ? { error: out.error } : { sha1: await hex(out.json), ms: Math.round(performance.now() - s), logic: JSON.parse(out.json.slice(0, out.json.indexOf(',"columns"')) + '}').logic };
      return { page, worker, logic: window.MzoUniform.VERSION };
    }, { j: { key: j.key, file: j.file, format: j.format, schema: j.schema }, id: i + 1 });
    const same = r.page.sha1 === j.node.sha1 && r.worker.sha1 === j.node.sha1;
    if (!same) bad++;
    console.log(`${same ? 'same' : 'DIFF'}  ${(j.key + (j.schema ? ' (schema)' : '')).padEnd(40)} ${String(j.node.bytes).padStart(9)} B  node ${String(j.node.ms).padStart(4)} ms  page ${String(r.page.ms).padStart(4)} ms  worker ${String(r.worker.ms).padStart(4)} ms  ${same ? j.node.sha1.slice(0, 12) : JSON.stringify({ node: j.node.sha1, page: r.page.sha1, worker: r.worker.sha1 || r.worker.error })}`);
  }
  await browser.close();
  console.log(`[identity] ${jobs.length - bad}/${jobs.length} identical (browser pass ${Date.now() - tB} ms)`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
