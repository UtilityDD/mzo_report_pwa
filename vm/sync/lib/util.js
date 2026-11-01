'use strict';
// Small helpers shared by the sync: hashing, deterministic record ids, timing, logging.

const crypto = require('crypto');

function sha1(text) {
    return crypto.createHash('sha1').update(text).digest('hex');
}

// PocketBase record ids are 15 characters of [a-z0-9]. Deriving the id from the row key
// lets the sync update or delete a row without first looking up its id.
const ID_ALPHABET = Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789', 'latin1');
function recordId(rowKey) {
    const bytes = crypto.createHash('sha1').update(String(rowKey)).digest();
    const out = Buffer.allocUnsafe(15);
    for (let i = 0; i < 15; i++) out[i] = ID_ALPHABET[bytes[i] % 36];
    return out.toString('latin1'); // one flat string (a += loop would keep a 15-node rope per id)
}

/** JSON with object keys sorted at every level, so equal json values always hash the same. */
function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) {
        if (v.every((x) => x === null || typeof x !== 'object')) return JSON.stringify(v); // fast path: no nested objects
        let out = '[';
        for (let i = 0; i < v.length; i++) out += (i ? ',' : '') + stableStringify(v[i]);
        return out + ']';
    }
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    let out = '{';
    for (let i = 0; i < keys.length; i++) out += (i ? ',' : '') + JSON.stringify(keys[i]) + ':' + stableStringify(v[keys[i]]);
    return out + '}';
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
    return new Date().toISOString();
}

// PocketBase date fields take "YYYY-MM-DD HH:MM:SS.sssZ".
function pbDate(d) {
    const date = d instanceof Date ? d : new Date(d);
    return date.toISOString().replace('T', ' ');
}

function fmtMs(ms) {
    if (ms < 1000) return ms + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
    return Math.floor(ms / 60000) + ' min ' + Math.round((ms % 60000) / 1000) + ' s';
}

function log(...parts) {
    const t = new Date().toISOString().slice(11, 19);
    console.log(t, ...parts);
}

function errMessage(err) {
    if (!err) return 'Unknown error';
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'Timed out' + (err.message ? ': ' + err.message : '');
    let msg = err.message || String(err);
    if (err.cause && err.cause.message && !msg.includes(err.cause.message)) msg += ' (' + err.cause.message + ')';
    return msg;
}

/** Thrown by a source when it must be recorded as `skipped` (not an error), e.g. a private sheet. */
class SkipError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SkipError';
    }
}

module.exports = { sha1, recordId, stableStringify, sleep, nowIso, pbDate, fmtMs, log, errMessage, SkipError };
