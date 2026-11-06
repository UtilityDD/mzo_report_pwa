'use strict';
// Locks shared by the sync and the app's data editor (lib/editor):
//   sync.lock      one sync at a time per machine (a file holding the PID of the holder). The editor
//                  takes it too while it makes a dataset native, so no sync writes that dataset
//                  between its last copy and the switch.
//   manifest.lock  manifest.json is rewritten by the sync and by the editor (native datasets); both
//                  read, change and rename it inside this lock so neither loses the other's entries.

const fs = require('fs');
const path = require('path');

function alive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM'; // exists, owned by another user
    }
}

/** Take the sync lock in `dir` now, or return null when a live process holds it. → release() */
function takeLock(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'sync.lock');
    try {
        const pid = Number(fs.readFileSync(file, 'utf8'));
        if (pid && pid !== process.pid && alive(pid)) return null;
    } catch (_) { /* no lock */ }
    fs.writeFileSync(file, String(process.pid));
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        try {
            if (Number(fs.readFileSync(file, 'utf8')) === process.pid) fs.unlinkSync(file);
        } catch (_) { /* gone */ }
        process.removeListener('exit', release);
    };
    process.on('exit', release);
    return release;
}

/** Wait up to `ms` for the sync lock. → release() or null. */
async function waitLock(dir, ms, stepMs = 2000) {
    let release = takeLock(dir);
    for (let waited = 0; !release && waited < ms; waited += stepMs) {
        await new Promise((r) => setTimeout(r, stepMs));
        release = takeLock(dir);
    }
    return release;
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
    Atomics.wait(sleepBuf, 0, 0, ms);
}

/**
 * Run fn() while holding <dir>/.manifest.lock (synchronous: fn should only do quick file work).
 * A lock older than 30 s is a crashed holder's and is taken over.
 */
function withManifestLock(dir, fn) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '.manifest.lock');
    const until = Date.now() + 10000;
    let fd = null;
    while (fd === null) {
        try {
            fd = fs.openSync(file, 'wx');
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
            try {
                if (Date.now() - fs.statSync(file).mtimeMs > 30000) fs.unlinkSync(file);
            } catch (_) { /* raced */ }
            if (Date.now() > until) throw new Error('manifest.json is locked by another writer');
            sleepSync(15);
        }
    }
    try {
        fs.writeSync(fd, String(process.pid));
        return fn();
    } finally {
        try { fs.closeSync(fd); } catch (_) { /* closed */ }
        try { fs.unlinkSync(file); } catch (_) { /* gone */ }
    }
}

module.exports = { takeLock, waitLock, withManifestLock };
