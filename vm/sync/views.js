#!/usr/bin/env node
'use strict';
// Page views next to the snapshots (vm/sync/lib/views.js; docs/uniform-data.md, "Page views"):
//   node vm/sync/views.js [--dir <snapshotDir>] [--only name[,name]] [--force]
// Rebuilds a view when one of its input rows files or its code changed. Run it after vm/sync/rows.js
// in each sync run (vm/sync/run.js does), with a capped heap, e.g.
//   node --max-old-space-size=200 --max-semi-space-size=4 vm/sync/views.js --dir <snapshotDir>

// The views run the pages' own date rules, which read calendar dates in the users' time zone.
process.env.TZ = 'Asia/Kolkata';

const path = require('path');
const fs = require('fs');
const views = require('./lib/views');

function arg(name) {
    const i = process.argv.indexOf('--' + name);
    return i > 0 ? process.argv[i + 1] : undefined;
}

function main() {
    const dir = path.resolve(arg('dir') || process.env.MZO_SNAPSHOT_DIR || '/opt/mzo/data/snapshots');
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
        console.log(`[views] no manifest in ${dir}: nothing to do`);
        return;
    }
    const only = (arg('only') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const t0 = Date.now();
    const out = views.buildAll(dir, { only, force: process.argv.includes('--force'), log: (m) => console.log(new Date().toISOString().slice(11, 19), m) });
    console.log(`[views] built ${out.built.length}, fresh ${out.fresh.length}, waiting ${out.waiting.length}, failed ${out.failed.length}` +
        ` in ${Date.now() - t0} ms; peak RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
    if (out.failed.length) process.exitCode = 1;
}

try { main(); } catch (err) { console.error('[views]', err && err.stack || err); process.exit(1); }
