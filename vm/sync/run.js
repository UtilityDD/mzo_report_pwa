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
//
// Env: PB_URL, PB_SUPERUSER_EMAIL, PB_SUPERUSER_PASSWORD (e.g. node --env-file=/etc/mzo/pocketbase.env run.js --due).
// Optional: MZO_SNAPSHOT_DIR (raw snapshots + manifest.json; default /opt/mzo/data/snapshots if it
// exists), SYNC_TMP_DIR (spool files; default $CACHE_DIRECTORY or vm/sync/.tmp), SYNC_BATCH_SIZE.
// Sources are loaded from every sources/*.js file; one broken file or source never stops the rest.

// Memory: the VM has ~500 MB. Node's default young generation grows to tens of MB under the
// sync's allocation rate, so the sync runs with a small one (measured: ~60 MB less peak RSS,
// same speed). Started without these flags, run.js starts itself again with them; the systemd
// unit passes them directly so that only one process runs.
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
const { PocketBase } = require('./lib/pb');
const { Registry } = require('./lib/registry');
const { syncSource } = require('./lib/sync');
const { isDue } = require('./lib/schedule');
const { validKey } = require('./lib/normalise');
const { makeSourceFetch } = require('./lib/http');
const { snapshotDir: resolveSnapshotDir, writeManifest, cleanTemp } = require('./lib/snapshot');
const { cleanSpool } = require('./lib/spool');
const { log, fmtMs, errMessage, sleep } = require('./lib/util');

const SCHEDULES = new Set(['frequent', 'hourly', 'daily']);

function parseArgs(argv) {
    const a = { mode: null, only: [], dryRun: false, force: false, strict: false, list: false, batch: 0, reason: '' };
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
        else if (arg === '--batch') a.batch = Number(argv[++i]) || 0;
        else if (arg === '--reason') a.reason = String(argv[++i] || '').trim().slice(0, 200);
        else if (arg.startsWith('--reason=')) a.reason = arg.slice(9).trim().slice(0, 200);
        else if (arg === '-h' || arg === '--help') a.help = true;
        else throw new Error('Unknown option: ' + arg);
    }
    return a;
}

async function loadSources() {
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

/** One sync at a time per machine: a lock file holding the PID. */
function takeLock(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'sync.lock');
    try {
        const pid = Number(fs.readFileSync(file, 'utf8'));
        if (pid && pid !== process.pid) {
            try {
                process.kill(pid, 0);
                return null; // still running
            } catch (_) { /* stale lock */ }
        }
    } catch (_) { /* no lock */ }
    fs.writeFileSync(file, String(process.pid));
    const release = () => {
        try {
            if (Number(fs.readFileSync(file, 'utf8')) === process.pid) fs.unlinkSync(file);
        } catch (_) { /* gone */ }
    };
    process.on('exit', release);
    return release;
}

function usage() {
    console.log('Usage: node run.js (--due | --all | --only <key[,key]> | --list) [--dry-run] [--force] [--strict] [--batch n] [--reason text]');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) return usage(), 0;
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
            return 0;
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
        log('another sync is still running; nothing to do');
        return 0;
    }
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
            throw new Error('sys_datasets / sys_sync_runs are missing: start PocketBase with --migrationsDir vm/pocketbase/pb_migrations');
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
    for (const src of chosen) {
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
        if (r.status === 'ok' && !args.dryRun) {
            // Data-quality checks (vm/quality, optional): never allowed to fail the sync.
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
        (notDue ? `, ${notDue} not due` : '') + ` in ${fmtMs(Date.now() - runStart)}; peak RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
    for (const r of results.filter((x) => x.status === 'error')) log(`  error ${r.key}: ${r.message}`);
    return args.strict && by('error') ? 1 : 0;
}

main().then((code) => {
    process.exitCode = code;
}).catch((err) => {
    log('FATAL', errMessage(err));
    process.exitCode = 1;
});
