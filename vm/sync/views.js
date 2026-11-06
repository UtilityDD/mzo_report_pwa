#!/usr/bin/env node
'use strict';
// Page views next to the snapshots (vm/sync/lib/views.js; docs/uniform-data.md, "Page views"):
//   node vm/sync/views.js [--dir <snapshotDir>] [--only name[,name]] [--force] [--here]
// Rebuilds a view when one of its input rows files or its code changed. Without --only it checks
// which views are stale and builds each in a child process of its own (--here: all in this one).
// Run it after vm/sync/rows.js in each sync run (vm/sync/run.js does), with a capped heap:
//   node --max-old-space-size=160 --max-semi-space-size=4 vm/sync/views.js --dir <snapshotDir>

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
    if (!only.length && !process.argv.includes('--here')) {
        // The sync's call: find the stale views cheaply, then build each in its own child process with
        // the same heap flags, so the peak is the largest view's, not their sum (docs/vm.md, Memory).
        const plan = views.buildAll(dir, { force: process.argv.includes('--force'), planOnly: true });
        let failed = 0;
        for (const { name } of plan.built) {
            const args = process.execArgv.concat([__filename, '--dir', dir, '--only', name]).concat(process.argv.includes('--force') ? ['--force'] : []);
            const r = require('child_process').spawnSync(process.execPath, args, { stdio: 'inherit', timeout: 10 * 60000 });
            if (r.status) failed++;
        }
        console.log(`[views] ${plan.built.length} to build, ${plan.fresh.length} fresh, ${plan.waiting.length} waiting, ${failed + plan.failed.length} failed`);
        if (failed || plan.failed.length) process.exitCode = 1;
        return;
    }
    const out = views.buildAll(dir, { only, force: process.argv.includes('--force'), log: (m) => console.log(new Date().toISOString().slice(11, 19), m) });
    console.log(`[views] built ${out.built.length}, fresh ${out.fresh.length}, waiting ${out.waiting.length}, failed ${out.failed.length}` +
        ` in ${Date.now() - t0} ms; peak RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
    if (out.failed.length) process.exitCode = 1;
}

try { main(); } catch (err) { console.error('[views]', err && err.stack || err); process.exit(1); }
