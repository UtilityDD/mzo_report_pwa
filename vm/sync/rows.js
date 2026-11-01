#!/usr/bin/env node
'use strict';
// Build uniform rows next to the snapshots (docs/uniform-data.md):
//   node vm/sync/rows.js [--dir <snapshotDir>] [--only key[,key]] [--force] [--prune]
// Default: every dataset with a schema/<key>.json whose rows are stale (new snapshot, new
// lib/uniform.js / lib/offices.js / data/costcenter.json, or a changed schema). One dataset at a
// time; run it after each sync run (vm/sync/run.js does) with a capped heap, e.g.
//   node --max-old-space-size=256 --max-semi-space-size=4 vm/sync/rows.js

const path = require('path');
const fs = require('fs');
const rows = require('./lib/rows');

function arg(name) {
    const i = process.argv.indexOf('--' + name);
    return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
    const dir = path.resolve(arg('dir') || process.env.MZO_SNAPSHOT_DIR || '/opt/mzo/data/snapshots');
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
        console.log(`[rows] no manifest in ${dir}: nothing to do`);
        return;
    }
    const only = (arg('only') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const t0 = Date.now();
    const out = await rows.buildAll(dir, { only, force: process.argv.includes('--force'), log: (m) => console.log(new Date().toISOString().slice(11, 19), m) });
    const gone = process.argv.includes('--prune') ? rows.prune(dir) : [];
    console.log(`[rows] built ${out.built.length}, fresh ${out.fresh.length}, failed ${out.failed.length}` +
        (gone.length ? `, removed ${gone.join(',')}` : '') + ` in ${Date.now() - t0} ms`);
    if (out.failed.length) process.exitCode = 1;
}

main().catch((err) => { console.error('[rows]', err.message); process.exit(1); });
