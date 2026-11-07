#!/usr/bin/env node
/* The sync lock (vm/sync/lib/lock.js) is exclusive: of several processes that try at the same moment,
 * exactly one gets it, also when they all find a stale lock left by a crashed run.
 *
 *   node vm/dev/test-sync-lock.js [--rounds 40]
 *
 * Offline, a temp folder only. Each round starts N processes that wait for the same start instant,
 * call takeLock(), hold it 150 ms and report. Exit 1 when any round has more or fewer than one holder.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { spawn } = require('child_process');

const LOCK = path.join(__dirname, '..', 'sync', 'lib', 'lock.js');

if (process.argv[2] === '--child') {
    const [dir, at] = process.argv.slice(3);
    const { takeLock } = require(LOCK);
    const wait = Number(at) - Date.now();
    const go = () => {
        const release = takeLock(dir);
        if (!release) { process.stdout.write('no'); return; }
        process.stdout.write('yes');
        setTimeout(release, 150);
    };
    if (wait > 0) setTimeout(go, wait); else go();
    return;
}

function child(dir, at) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [__filename, '--child', dir, String(at)], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.on('close', () => resolve(out.trim()));
    });
}

async function round(dir, n, stale) {
    const file = path.join(dir, 'sync.lock');
    try { fs.unlinkSync(file); } catch (_) { /* none */ }
    if (stale) fs.writeFileSync(file, '999999'); // a pid that is not running
    const at = Date.now() + 400;
    const res = await Promise.all(Array.from({ length: n }, () => child(dir, at)));
    return res.filter((r) => r === 'yes').length;
}

async function main() {
    const i = process.argv.indexOf('--rounds');
    const rounds = i > 0 ? Number(process.argv[i + 1]) : 20;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-lock-test-'));
    const { takeLock, waitLock } = require(LOCK);
    let failed = 0;
    try {
        // In-process basics (--race: only the races).
        if (!process.argv.includes('--race')) {
            const r1 = takeLock(dir);
            assert.ok(r1, 'first take');
            assert.equal(takeLock(dir), null, 'not re-entrant: a second take in the same process waits');
            assert.equal(fs.readFileSync(path.join(dir, 'sync.lock'), 'utf8'), String(process.pid));
            r1();
            assert.ok(!fs.existsSync(path.join(dir, 'sync.lock')), 'release removes the file');
            fs.writeFileSync(path.join(dir, 'sync.lock'), '');
            fs.utimesSync(path.join(dir, 'sync.lock'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
            const r2 = takeLock(dir);
            assert.ok(r2, 'an empty lock file older than 10 s is stale');
            r2();
            const r3 = takeLock(dir);
            setTimeout(r3, 300);
            const t0 = Date.now();
            const r4 = await waitLock(dir, 5000, 50);
            assert.ok(r4 && Date.now() - t0 >= 250, 'waitLock gets it once the holder releases');
            r4();
            console.log('ok   take, release, not re-entrant, empty stale file, waitLock');
        }

        for (const [label, stale, n] of [['free lock, 2 at once', false, 2], ['free lock, 6 at once', false, 6], ['stale lock, 6 at once', true, 6]]) {
            const bad = [];
            for (let k = 0; k < rounds; k++) {
                const holders = await round(dir, n, stale);
                if (holders !== 1) bad.push(holders);
            }
            if (bad.length) { failed++; console.log(`FAIL ${label}: ${bad.length} of ${rounds} rounds had ${bad.join(',')} holders`); }
            else console.log(`ok   ${label}: exactly one holder in all ${rounds} rounds`);
        }
    } catch (err) {
        failed++;
        console.log('FAIL ' + (err && err.stack || err));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    process.exitCode = failed ? 1 : 0;
}

main();
