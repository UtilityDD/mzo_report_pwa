'use strict';
// Locks shared by the sync and the app's data editor (lib/editor):
//   sync.lock      one sync at a time per machine (created exclusively, holds the PID). The editor
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

const EMPTY_GRACE_MS = 10000; // a lock file still without a PID (its creator is writing it) is held this long
const MAX_AGE_MS = 3 * 3600000; // older than this it is stale even if its PID is alive (PID reused)

/** Is the lock file stale: its holder gone, or the file far older than any run? */
function stale(file) {
    let text;
    let st;
    try {
        st = fs.statSync(file);
        text = fs.readFileSync(file, 'utf8');
    } catch (err) {
        return err.code === 'ENOENT' ? 'gone' : false;
    }
    const age = Date.now() - st.mtimeMs;
    const pid = Number(text.trim());
    if (!pid) return age > EMPTY_GRACE_MS;
    if (pid === process.pid) return false; // ours: not re-entrant, the caller waits like anyone else
    return !alive(pid) || age > MAX_AGE_MS;
}

/** Remove a stale lock. Only one process at a time may decide (sync.lock.takeover, created exclusively). */
function clearStale(file) {
    const mutex = file + '.takeover';
    let fd;
    try {
        fd = fs.openSync(mutex, 'wx');
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // A taker that crashed inside the few lines below leaves the mutex behind.
        try { if (Date.now() - fs.statSync(mutex).mtimeMs > 30000) fs.unlinkSync(mutex); } catch (_) { /* raced */ }
        return;
    }
    try {
        // Checked again under the mutex: nobody can create the lock while this file exists, and only
        // the mutex holder deletes a lock it did not create, so this never removes a live one.
        if (stale(file) === true) fs.unlinkSync(file);
    } catch (_) { /* gone already */ } finally {
        fs.closeSync(fd);
        try { fs.unlinkSync(mutex); } catch (_) { /* gone */ }
    }
}

/**
 * Take the sync lock in `dir` now, or return null when another live run holds it. → release()
 * The lock file is created exclusively (O_EXCL) and holds the holder's PID; a lock whose process is
 * gone (or that is over 3 h old) is taken over. Not re-entrant: a second take in one process is null.
 */
function takeLock(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'sync.lock');
    let fd = null;
    for (let attempt = 0; fd === null && attempt < 3; attempt++) {
        try {
            fd = fs.openSync(file, 'wx', 0o644);
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
            const s = stale(file);
            if (s === false) return null;
            if (s === true) clearStale(file);
        }
    }
    if (fd === null) return null;
    try {
        fs.writeSync(fd, String(process.pid));
    } finally {
        fs.closeSync(fd);
    }
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

/** Who holds the sync lock, for log lines: "pid 123 for 4 min", or "" when it is free. */
function lockHolder(dir) {
    try {
        const file = path.join(dir, 'sync.lock');
        const pid = Number(fs.readFileSync(file, 'utf8').trim());
        const min = Math.round((Date.now() - fs.statSync(file).mtimeMs) / 60000);
        return `pid ${pid || '?'} for ${min} min`;
    } catch (_) {
        return '';
    }
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

module.exports = { takeLock, waitLock, withManifestLock, lockHolder };
