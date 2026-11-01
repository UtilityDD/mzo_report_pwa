#!/usr/bin/env node
'use strict';
// The performance rating next to the snapshots (docs/rating/metrics-layer.md):
//   node vm/sync/rating.js [--dir <snapshotDir>] [--force] [--as-of YYYY-MM-DD] [--min-minutes N]
// Recomputes rating.json / rating-metrics.json (+ .gz, .br) and rating.meta.json only when an input
// snapshot, the reference date or the rating code changed (changed inputs at most every --min-minutes;
// a code change at once). Run it after vm/sync/rows.js in each sync run (vm/sync/run.js), with a
// capped heap (it needs about 128 MB; docs/rating/metrics-layer.md):
//   node --max-old-space-size=160 --max-semi-space-size=4 vm/sync/rating.js --dir <snapshotDir> --min-minutes 15

const path = require('path');
const fs = require('fs');
const rating = require('./lib/rating');

function arg(name) {
    const i = process.argv.indexOf('--' + name);
    return i > 0 ? process.argv[i + 1] : undefined;
}

function main() {
    const dir = path.resolve(arg('dir') || process.env.MZO_SNAPSHOT_DIR || '/opt/mzo/data/snapshots');
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
        console.log(`[rating] no manifest in ${dir}: nothing to do`);
        return;
    }
    const t0 = Date.now();
    const out = rating.precompute(dir, { force: process.argv.includes('--force'), asOf: arg('as-of'), minMinutes: Number(arg('min-minutes') || 0),
        log: (m) => console.log(new Date().toISOString().slice(11, 19), m) });
    if (out.status === 'fresh') console.log(`[rating] unchanged (inputs ${out.meta.inputs}, built ${out.meta.builtAt}) in ${Date.now() - t0} ms`);
    if (out.status === 'recent') console.log(`[rating] inputs changed; last built ${out.meta.builtAt}, next build after ${arg('min-minutes')} min`);
}

try { main(); } catch (err) { console.error('[rating]', err && err.stack || err); process.exit(1); }
