'use strict';
// Hold-back of bad copies (docs/data-quality.md, "Hold-back"): when a source's new copy is critically worse
// than the copy the site serves, the sync keeps the previous snapshot and PocketBase rows, records the
// dataset as held, and reads it again on the next run.
//
// The rule is deliberately narrow, so it only stops copies that are clearly broken:
//   1. rows: the previous copy had at least MIN_PREV_ROWS rows and the new one has less than half of them;
//   2. header lost: none of the previous columns is left, or more than half of them are gone;
//   3. columns lost while rows fell: any previous column is gone and rows fell by more than 20 %
//      (the 6 Nov 2026 withheld copy: 45,600 of 66,833 rows and scn_witheld_date gone, read mid-upload).
// A held copy is accepted anyway once the same bytes (content hash) have come back for MAX_HOLD_HOURS, so a
// real shrink is never blocked for more than a day; `run.js --only <key> --force` accepts it at once.
// State: <snapshotDir>/quality-held.json { <key>: { since, lastTry, attempts, reason, rows, prevRows, lost, hash, hashSince } },
// read by vm/sync/quality.js (Admin → Data quality) and shown on the Sources tab through the registry's
// last_error ("held: …").

const fs = require('fs');
const path = require('path');

const RULE = { minPrevRows: 20, dropShare: 0.5, lostWithDropShare: 0.2, headerLostShare: 0.5, maxHoldHours: 24 };
const FILE = 'quality-held.json';
const PREFIX = 'held: new copy looks incomplete';

/**
 * Is the new copy critically worse than the previous one?
 * @param {{prevRows: number, prevColumns: string[], rows: number, columns: string[]}} c
 * @returns {{hold: boolean, reason: string, lost: string[]}}
 */
function assess(c) {
    const prevRows = Number(c.prevRows) || 0;
    const rows = Number(c.rows) || 0;
    const prevCols = (c.prevColumns || []).filter(Boolean);
    const now = new Set((c.columns || []).filter(Boolean));
    const lost = prevCols.filter((n) => !now.has(n));
    const fmt = (n) => Number(n).toLocaleString('en-IN');
    const out = (reason) => ({ hold: true, reason, lost });
    if (prevRows >= RULE.minPrevRows && rows > 0 && rows < prevRows * RULE.dropShare) {
        return out(`${fmt(rows)} rows against ${fmt(prevRows)} in the copy being served (${Math.round((1 - rows / prevRows) * 100)}% fewer)`);
    }
    if (prevCols.length >= 2 && rows > 0 && (lost.length === prevCols.length || lost.length > prevCols.length * RULE.headerLostShare)) {
        return out(`header lost: ${lost.length} of ${prevCols.length} columns missing`);
    }
    if (lost.length && prevRows >= RULE.minPrevRows && rows < prevRows * (1 - RULE.lostWithDropShare)) {
        return out(`${fmt(rows)} rows against ${fmt(prevRows)} (${Math.round((1 - rows / prevRows) * 100)}% fewer) and column${lost.length > 1 ? 's' : ''} ${lost.slice(0, 3).join(', ')} gone`);
    }
    return { hold: false, reason: '', lost };
}

function read(dir) {
    if (!dir) return {};
    try {
        const v = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (_) {
        return {};
    }
}

function write(dir, state) {
    if (!dir) return;
    const final = path.join(dir, FILE);
    const tmp = path.join(dir, `.${FILE}.${process.pid}.tmp`);
    try {
        fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
        fs.renameSync(tmp, final);
        return true;
    } catch (err) {
        // The hold itself still applies (the sync throws); only its record is missing.
        console.error(`[holdback] could not write ${final}: ${err && err.message}`);
        return false;
    }
}

/**
 * The sync's decision for one new copy (called after the download, before the snapshot or rows change).
 * @param {object} o { dir, key, ds (registry row before this sync), rows, columns (names), hash, force, optOut, now, log }
 * @returns {{hold: boolean, message: string, accepted?: string}}
 */
function decide(o) {
    const now = o.now || Date.now();
    const ds = o.ds;
    if (!o.dir || !ds || o.optOut) return { hold: false, message: '' };
    const prevColumns = Array.isArray(ds.columns) ? ds.columns.filter((c) => c && !c.raw_of).map((c) => c.name) : [];
    const a = assess({ prevRows: ds.row_count, prevColumns, rows: o.rows, columns: o.columns });
    const state = read(o.dir);
    const prev = state[o.key];
    if (!a.hold) {
        if (prev) { delete state[o.key]; write(o.dir, state); }
        return { hold: false, message: '' };
    }
    if (o.force) {
        if (prev) { delete state[o.key]; write(o.dir, state); }
        return { hold: false, message: '', accepted: `accepted by --force although ${a.reason}` };
    }
    const since = prev && prev.since ? Date.parse(prev.since) : now;
    // How long these exact bytes have been coming back (a copy that keeps changing is still being written).
    const sameSince = prev && prev.hash === o.hash && prev.hashSince ? Date.parse(prev.hashSince) : now;
    if (prev && prev.hash === o.hash && now - sameSince >= RULE.maxHoldHours * 3600000) {
        delete state[o.key];
        write(o.dir, state);
        return { hold: false, message: '', accepted: `accepted after ${RULE.maxHoldHours} h of the same copy although ${a.reason}` };
    }
    state[o.key] = {
        since: new Date(since).toISOString(),
        lastTry: new Date(now).toISOString(),
        attempts: (prev ? prev.attempts || 0 : 0) + 1,
        reason: a.reason,
        rows: o.rows,
        prevRows: ds.row_count || 0,
        lost: a.lost.slice(0, 20),
        hash: o.hash || '',
        hashSince: new Date(sameSince).toISOString()
    };
    write(o.dir, state);
    return { hold: true, message: `${PREFIX} (${a.reason}); kept the previous copy, retrying next run` };
}

/** A good copy (ok or unchanged): the dataset is no longer held. */
function clear(dir, key) {
    if (!dir) return;
    const state = read(dir);
    if (!state[key]) return;
    delete state[key];
    write(dir, state);
}

function isHeldMessage(text) {
    return /(^|\] )held: /.test(String(text || ''));
}

module.exports = { assess, decide, clear, read, write, isHeldMessage, RULE, FILE, PREFIX };
