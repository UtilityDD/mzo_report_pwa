#!/usr/bin/env node
'use strict';
// MZO data mirror: copy every dataset into PocketBase.
//
//   node run.js --due              sources whose schedule says they are due (the systemd timer)
//   node run.js --all              every source now
//   node run.js --only a,b         just these keys, now
//   node run.js --list             print the source inventory and exit
//   options: --dry-run (read and infer only, no PocketBase), --force (rewrite even if unchanged),
//            --strict (exit 1 if any source failed), --batch <n> (rows per batch request),
//            --reason <text> (kept in sys_sync_runs.message, e.g. "write-through: stock publish")
//   --only always downloads (no cheap version shortcut) and waits up to 10 min for a running sync.
//   --now (with --only): rebuild the rating at once instead of at most every 15 minutes (the CMO upload).
//
// Env: PB_URL, PB_SUPERUSER_EMAIL, PB_SUPERUSER_PASSWORD (e.g. node --env-file=/etc/mzo/pocketbase.env run.js --due).
// Optional: MZO_SNAPSHOT_DIR (raw snapshots + manifest.json; default /opt/mzo/data/snapshots if it
// exists), SYNC_TMP_DIR (spool files; default $CACHE_DIRECTORY or vm/sync/.tmp), SYNC_BATCH_SIZE.
// Sources are loaded from every sources/*.js file; one broken file or source never stops the rest.

// Memory: the VM has 1 GB and the sync unit MemoryMax=400M, which counts every process of a run.
// A run is two phases: the sources, in a child process (its memory goes back to the system when it
// exits), then the derived files (uniform rows, page views, data quality, rating), each in a child of
// its own, started by this small parent (about 40 MB). The sources phase alone peaks near 200 MB, the
// largest derived child near 270 MB; in one process the two would add up past the cap.
// Node's default young generation grows to tens of MB under the sync's allocation rate, so the sync
// runs with a small one (measured: ~60 MB less peak RSS, same speed). Started without these flags,
// run.js starts itself again with them (the systemd unit and the app pass them directly).
const HEAP_FLAGS = ['--max-old-space-size=160', '--max-semi-space-size=4'];
if (!process.execArgv.some((a) => a.startsWith('--max-semi-space-size')) && !process.env.MZO_SYNC_CHILD) {
    const { spawnSync } = require('child_process');
    const child = spawnSync(process.execPath, [...HEAP_FLAGS, ...process.execArgv, __filename, ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: Object.assign({}, process.env, { MZO_SYNC_CHILD: '1' })
    });
    process.exit(child.status === null ? 1 : child.status);
}

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { snapshotDir: resolveSnapshotDir } = require('./lib/snapshot');
const { log, fmtMs, errMessage, sleep } = require('./lib/util');
const { takeLock, lockHolder } = require('./lib/lock');

const SCHEDULES = new Set(['frequent', 'hourly', 'daily']);
const PHASE_ENV = 'MZO_SYNC_PHASE'; // set to "sources" in the child that syncs the sources
const NOTHING = 3; // exit code of the sources phase: nothing was run (no known key, or another run holds the lock)
const LOCK_BUSY = 75; // --only gave up waiting for the lock (EX_TEMPFAIL): the app reads those keys live a while

function parseArgs(argv) {
    const a = { mode: null, only: [], dryRun: false, force: false, strict: false, list: false, batch: 0, reason: '', now: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--all') a.mode = 'all';
        else if (arg === '--due') a.mode = 'due';
        else if (arg === '--only') {
            a.mode = 'only';
            a.only.push(...String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean));
        } else if (arg.startsWith('--only=')) {
            a.mode = 'only';
            a.only.push(...arg.slice(7).split(',').map((s) => s.trim()).filter(Boolean));
        } else if (arg === '--dry-run') a.dryRun = true;
        else if (arg === '--force') a.force = true;
        else if (arg === '--strict') a.strict = true;
        else if (arg === '--list') a.list = true;
        else if (arg === '--now') a.now = true;
        else if (arg === '--batch') a.batch = Number(argv[++i]) || 0;
        else if (arg === '--reason') a.reason = String(argv[++i] || '').trim().slice(0, 200);
        else if (arg.startsWith('--reason=')) a.reason = arg.slice(9).trim().slice(0, 200);
        else if (arg === '-h' || arg === '--help') a.help = true;
        else throw new Error('Unknown option: ' + arg);
    }
    return a;
}

async function loadSources() {
    const { validKey } = require('./lib/normalise');
    const { makeSourceFetch } = require('./lib/http');
    const dir = path.join(__dirname, 'sources');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
    const ctx = { fetch: makeSourceFetch(), log: (m) => log('[sources]', m), env: process.env, limits: { maxRowsPerBatch: 500 } };
    const all = [];
    const seen = new Set();
    const problems = [];
    for (const file of files) {
        let list;
        try {
            const mod = require(path.join(dir, file));
            const fn = typeof mod === 'function' ? mod : mod.sources;
            if (typeof fn !== 'function') throw new Error('does not export sources(ctx)');
            list = await fn(ctx);
            if (!Array.isArray(list)) throw new Error('sources(ctx) did not return an array');
        } catch (err) {
            problems.push(`${file}: ${errMessage(err)}`);
            continue;
        }
        for (const src of list) {
            const where = `${file}: ${src && src.key}`;
            if (!src || !validKey(src.key)) problems.push(`${where}: invalid key (snake_case, under 50 characters)`);
            else if (seen.has(src.key)) problems.push(`${where}: duplicate key, ignored`);
            else if (typeof src.rows !== 'function' && !src.skip) problems.push(`${where}: no rows() function`);
            else {
                if (!SCHEDULES.has(src.schedule)) src.schedule = 'hourly';
                seen.add(src.key);
                src._file = file;
                all.push(src);
            }
        }
    }
    return { sources: all, problems };
}

function usage() {
    console.log('Usage: node run.js (--due | --all | --only <key[,key]> | --list) [--dry-run] [--force] [--strict] [--batch n] [--reason text] [--now]');
}

let stopping = false; // SIGTERM/SIGINT arrived: finish the running child, start no other

/** Run a child process; SIGTERM/SIGINT to this one reach it too, and it is stopped after timeoutMs. → exit code */
function runChild(args, { env, timeoutMs } = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, args, { stdio: 'inherit', env: env || process.env });
        const kill = (sig) => { try { child.kill(sig); } catch (_) { /* gone */ } };
        const forward = (sig) => { stopping = true; kill(sig); };
        process.on('SIGTERM', forward);
        process.on('SIGINT', forward);
        const timer = timeoutMs ? setTimeout(() => kill('SIGKILL'), timeoutMs) : null;
        const done = (code) => {
            if (timer) clearTimeout(timer);
            process.removeListener('SIGTERM', forward);
            process.removeListener('SIGINT', forward);
            resolve(code);
        };
        child.on('error', (err) => { log('could not start ' + path.basename(args[args.length - 1] || '') + ': ' + errMessage(err)); done(1); });
        child.on('exit', (code, sig) => done(code === null ? (sig === 'SIGKILL' && timeoutMs ? 124 : 1) : code));
    });
}

/** Derived files next to the snapshots, each step in a child with its own capped heap; never fails the sync.
 *  now: the rating is rebuilt even when the last build is under 15 minutes old (a write asked for it). */
async function derivedSteps(snapshotDir, now) {
    const steps = [
        // Uniform rows (docs/uniform-data.md): the stale ones, one dataset at a time.
        ['uniform rows', ['--max-old-space-size=256', '--max-semi-space-size=4', path.join(__dirname, 'rows.js'), '--dir', snapshotDir, '--prune'], 10],
        // Page views from those rows (lib/views.js): one child per stale view, so the peak is the largest view's (~220 MB).
        ['page views', ['--max-old-space-size=160', '--max-semi-space-size=4', path.join(__dirname, 'views.js'), '--dir', snapshotDir], 15],
        // Data quality (quality.js, Admin → Data quality): the datasets whose snapshot changed, one child each.
        ['data quality', ['--max-old-space-size=64', '--max-semi-space-size=4', path.join(__dirname, 'quality.js'), '--dir', snapshotDir], 10],
        // Performance rating (docs/rating/metrics-layer.md).
        ['performance rating', ['--max-old-space-size=160', '--max-semi-space-size=4', path.join(__dirname, 'rating.js'), '--dir', snapshotDir, '--min-minutes', now ? '0' : '15'], 10]
    ];
    for (const [name, args, minutes] of steps) {
        if (stopping) return;
        const code = await runChild(args, { timeoutMs: minutes * 60000 });
        if (code) log(`${name}: ${code === 124 ? `stopped after ${minutes} min` : 'exit ' + code} (see above)`);
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) return usage(), 0;
    if (args.list || args.dryRun || !args.mode || process.env[PHASE_ENV] === 'sources') return syncSources(args);

    // The sources in a child process, then the derived files from this (small) one.
    const t0 = Date.now();
    const code = await runChild([...process.execArgv, __filename, ...process.argv.slice(2)],
        { env: Object.assign({}, process.env, { [PHASE_ENV]: 'sources' }) });
    if (code === NOTHING) return 0;
    if (code === LOCK_BUSY || stopping) return code;
    const snapshotDir = resolveSnapshotDir(process.env);
    if (!snapshotDir) return code;
    const tmpDir = process.env.SYNC_TMP_DIR || process.env.CACHE_DIRECTORY || path.join(__dirname, '.tmp');
    const release = takeLock(tmpDir);
    if (!release) {
        // Another run took the lock between the two phases; it builds the derived files itself.
        log(`derived files left to the run that holds the lock now (${lockHolder(tmpDir)})`);
        return code;
    }
    try {
        const t1 = Date.now();
        await derivedSteps(snapshotDir, args.now && args.mode === 'only');
        log(`derived files checked in ${fmtMs(Date.now() - t1)}; whole run ${fmtMs(Date.now() - t0)}; this process peak RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
    } finally {
        release();
    }
    return code;
}

/** The sources phase (also --list and --dry-run): sync the chosen sources into PocketBase and the snapshots. */
async function syncSources(args) {
    const { PocketBase } = require('./lib/pb');
    const { Registry } = require('./lib/registry');
    const { syncSource } = require('./lib/sync');
    const { isDue } = require('./lib/schedule');
    const { writeManifest, cleanTemp } = require('./lib/snapshot');
    const { cleanSpool } = require('./lib/spool');
    const inPhase = process.env[PHASE_ENV] === 'sources';
    const { sources, problems } = await loadSources();
    for (const p of problems) log('SOURCE PROBLEM', p);

    if (args.list) {
        for (const s of sources) {
            console.log([s.key, s.schedule, s.sourceType, s.group, s.sensitive ? 'sensitive' : '', s.skip ? 'SKIP: ' + s.skip : '', s._file].join('\t'));
        }
        console.log(`${sources.length} sources`);
        return 0;
    }
    if (!args.mode) {
        usage();
        return 2;
    }

    let chosen = sources;
    if (args.mode === 'only') {
        // A stale key (e.g. in the app's write-through list) is skipped, never blocks the others.
        const unknown = args.only.filter((k) => !sources.some((s) => s.key === k));
        if (unknown.length) log('WARNING unknown source key(s), skipped: ' + unknown.join(', '));
        chosen = sources.filter((s) => args.only.includes(s.key));
        if (!chosen.length) {
            log('no known source keys given; nothing to do');
            return inPhase ? NOTHING : 0;
        }
    }

    const tmpDir = process.env.SYNC_TMP_DIR || process.env.CACHE_DIRECTORY || path.join(__dirname, '.tmp');
    let release = takeLock(tmpDir);
    // A targeted run (write-through after an edit in the app) waits for the running sync instead of being lost.
    for (let waited = 0; !release && args.mode === 'only' && waited < 600000; waited += 2000) {
        await sleep(2000);
        release = takeLock(tmpDir);
    }
    if (!release) {
        log(`another sync is still running (${lockHolder(tmpDir) || 'lock just released'}); nothing to do`);
        // A write-through that waited 10 min in vain is a failure: the app then reads those keys live a while.
        if (args.mode === 'only') return LOCK_BUSY;
        return inPhase ? NOTHING : 0;
    }
    // Stopped (systemd, the app's time limit, the parent passing it on): free the lock on the way out.
    for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { release(); process.exit(128 + (sig === 'SIGTERM' ? 15 : 2)); });
    cleanSpool(tmpDir);
    const snapshotDir = args.dryRun ? null : resolveSnapshotDir(process.env);
    if (snapshotDir) cleanTemp(snapshotDir);

    let pb = null;
    let registry = null;
    if (!args.dryRun) {
        pb = new PocketBase({
            url: process.env.PB_URL || 'http://127.0.0.1:8090',
            email: process.env.PB_SUPERUSER_EMAIL,
            password: process.env.PB_SUPERUSER_PASSWORD
        });
        await pb.auth();
        if (!(await pb.getCollection('sys_datasets')) || !(await pb.getCollection('sys_sync_runs'))) {
            throw new Error('sys_datasets / sys_sync_runs are missing: start PocketBase with --migrationsDir <a copy of vm/pocketbase/pb_migrations> --automigrate=false');
        }
        registry = new Registry(pb);
        await registry.load();
        await require('./lib/office_enrich').syncDim(pb); // dim_offices from lib/offices.js, when it changed
    }

    const batchSize = Math.max(1, Math.min(1000, args.batch || Number(process.env.SYNC_BATCH_SIZE) || 500));
    const runStart = Date.now();
    const results = [];
    let notDue = 0;
    const manifest = () => {
        if (!snapshotDir || !registry) return;
        try {
            writeManifest(snapshotDir, sources, registry);
        } catch (err) {
            log('could not write manifest.json: ' + errMessage(err));
        }
    };
    let native = 0;
    for (const src of chosen) {
        // A native dataset is edited on the VM (lib/editor, docs/data-editor.md): the VM is its source,
        // so the sync never reads the original again, nor touches its rows, snapshot or registry row.
        const reg = registry && registry.get(src.key);
        if (reg && reg.mode === 'native') {
            native++;
            if (args.mode !== 'due') log(`native    ${src.key.padEnd(30)} skipped: edited in the data editor, the VM is its source`);
            continue;
        }
        if (args.mode === 'due') {
            const d = isDue(registry && registry.get(src.key), src.schedule);
            if (!d.due) {
                notDue++;
                continue;
            }
        }
        // One source at a time: the previous one's rows are already out of memory.
        const before = registry ? registry.get(src.key) : null; // the registry row as it was before this sync
        const r = await syncSource(src, {
            pb, registry, tmpDir, batchSize, snapshotDir,
            dryRun: args.dryRun,
            force: args.force,
            fullCheck: args.mode === 'only',
            reason: args.reason,
            onSnapshot: manifest
        });
        results.push(r);
        if ((r.status === 'ok' || r.status === 'unchanged') && !args.dryRun) {
            // Data-quality checks (vm/quality, optional): never allowed to fail the sync. On an unchanged
            // source the check only re-ages its report date, once a day, without reading any data.
            try { await require('../quality').check(src.key, `ds_${src.key}`, { pb, registry, source: src, summary: r, before, snapshotDir, log }); } catch (e) { if (!(e.code === 'MODULE_NOT_FOUND' && String(e.message).includes("'../quality'"))) log(`[${src.key}] quality check failed: ${errMessage(e)}`); }
        }
        const counts = r.status === 'ok' && !args.dryRun ? ` +${r.inserted} ~${r.updated} -${r.deleted}` : '';
        log(`${r.status.padEnd(9)} ${r.key.padEnd(30)} ${String(r.rows).padStart(7)} rows ${String(r.columns).padStart(3)} cols${counts}  ${fmtMs(r.ms)}  ${r.status === 'ok' && !args.dryRun ? '' : r.message}`);
        if (args.dryRun && r.types) log('          ' + r.types.join(', '));
    }

    manifest();
    if (registry && results.length) {
        try {
            await registry.prune();
        } catch (err) {
            log('could not prune sys_sync_runs: ' + errMessage(err));
        }
    }

    const by = (st) => results.filter((r) => r.status === st).length;
    log(`done: ${results.length} checked (${by('ok')} ok, ${by('unchanged')} unchanged, ${by('skipped')} skipped, ${by('error')} error)` +
        (notDue ? `, ${notDue} not due` : '') + (native ? `, ${native} native (skipped)` : '') + ` in ${fmtMs(Date.now() - runStart)}; peak RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
    for (const r of results.filter((x) => x.status === 'error')) log(`  error ${r.key}: ${r.message}`);
    return args.strict && by('error') ? 1 : 0;
}

main().then((code) => {
    process.exitCode = code;
}).catch((err) => {
    log('FATAL', errMessage(err));
    process.exitCode = 1;
});
