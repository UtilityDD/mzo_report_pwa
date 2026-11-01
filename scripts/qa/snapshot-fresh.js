#!/usr/bin/env node
/* Is each mirror snapshot still identical to its live source?
 *
 *   node scripts/qa/snapshot-fresh.js <snapshotDir> [--out <file.json>]
 *
 * For every manifest entry, GETs its first source URL (published CSV/TSV, export, gviz, public
 * Storage; never Apps Script) and compares the SHA-1 of the bytes with the snapshot file. A parity
 * difference on a page whose dataset is "changed" here is live data moving, not a mirror bug.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function main() {
  const dir = process.argv[2];
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx > 0 ? process.argv[outIdx + 1] : null;
  if (!dir) { console.error('usage: node scripts/qa/snapshot-fresh.js <snapshotDir> [--out file.json]'); process.exit(2); }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const res = { checkedAt: new Date().toISOString(), manifestGeneratedAt: manifest.generatedAt, datasets: {} };
  const entries = Object.entries(manifest.datasets || {});
  let i = 0;
  async function one([key, e]) {
    const r = { file: e.file, fetchedAt: e.fetchedAt || e.snapshotAt || '', dataHubKeys: e.dataHubKeys || [] };
    res.datasets[key] = r;
    let snap;
    try { snap = fs.readFileSync(path.join(dir, e.file)); } catch (err) { r.status = 'no-file'; return; }
    r.snapshotSha1 = crypto.createHash('sha1').update(snap).digest('hex');
    r.snapshotBytes = snap.length;
    const url = (e.urls || []).find((u) => /^https?:\/\//.test(u) && !/script\.google(usercontent)?\.com/.test(u));
    if (!url) { r.status = 'no-public-url'; return; }
    r.url = url.replace(/([?&](apikey|key|token)=)[^&]*/gi, '$1<redacted>');
    try {
      const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
      if (!resp.ok) { r.status = 'http-' + resp.status; return; }
      const live = Buffer.from(await resp.arrayBuffer());
      r.liveSha1 = crypto.createHash('sha1').update(live).digest('hex');
      r.liveBytes = live.length;
      r.status = r.liveSha1 === r.snapshotSha1 ? 'same' : 'changed';
    } catch (err) { r.status = 'error: ' + String(err.message || err).slice(0, 120); }
  }
  const queue = entries.slice();
  await Promise.all(Array.from({ length: 4 }, async () => { for (;;) { const x = queue.shift(); if (!x) return; await one(x); i++; } }));
  const counts = {};
  Object.values(res.datasets).forEach((r) => { const s = String(r.status).split(':')[0]; counts[s] = (counts[s] || 0) + 1; });
  res.counts = counts;
  const text = JSON.stringify(res, null, 1);
  if (out) fs.writeFileSync(out, text);
  console.log(`[snapshot-fresh] ${entries.length} datasets: ${JSON.stringify(counts)}`);
  Object.entries(res.datasets).filter(([, r]) => r.status !== 'same').forEach(([k, r]) => console.log(`  ${k}: ${r.status} (snapshot ${r.snapshotBytes} B${r.liveBytes != null ? ', live ' + r.liveBytes + ' B' : ''})`));
}

main().catch((e) => { console.error(e); process.exit(1); });
