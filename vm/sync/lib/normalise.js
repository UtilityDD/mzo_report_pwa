'use strict';
// Source headers → PocketBase field names (snake_case ASCII), following the contract:
// lowercase; non-alphanumerics → "_"; collapse repeats; trim "_"; "c_" prefix if it starts
// with a digit; dedupe with _2, _3; never collide with PocketBase or sync system names.

const SYSTEM_FIELDS = ['_row_key', '_row_no', '_synced_at', '_hash'];
// Names PocketBase reserves on records (plus auth names, to be safe if a collection is ever converted).
const RESERVED = new Set([
    'id', 'created', 'updated', 'collectionid', 'collectionname', 'expand', 'fields',
    'password', 'tokenkey', 'email', 'emailvisibility', 'verified',
    ...SYSTEM_FIELDS
]);
const MAX_FIELD_NAME = 60;

/** Spreadsheet column letter for a 0-based index: 0 → a, 25 → z, 26 → aa. */
function columnLetter(index) {
    let n = index + 1;
    let s = '';
    while (n > 0) {
        const r = (n - 1) % 26;
        s = String.fromCharCode(97 + r) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

/** Clean a raw header cell for display/registry use (keeps the original wording). */
function cleanHeader(raw) {
    return String(raw == null ? '' : raw)
        .replace(/^﻿/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function baseName(sourceName, index) {
    let s = String(sourceName || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!s) s = 'col_' + columnLetter(index);
    if (/^[0-9]/.test(s)) s = 'c_' + s;
    if (s.length > MAX_FIELD_NAME) s = s.slice(0, MAX_FIELD_NAME).replace(/_+$/g, '');
    return s;
}

/**
 * Give every column a unique field name.
 * @param {string[]} sourceNames original header names (may be empty or repeated)
 * @param {number[]} [indexes] spreadsheet column index of each name (for empty headers)
 * @returns {string[]} field names, same order
 */
function fieldNames(sourceNames, indexes) {
    const taken = new Set(RESERVED);
    return sourceNames.map((name, i) => uniqueName(baseName(name, indexes ? indexes[i] : i), taken));
}

/** Reserve and return `name`, or name_2, name_3, … if it is already taken. */
function uniqueName(name, taken) {
    let out = name;
    let n = 2;
    while (taken.has(out)) {
        const suffix = '_' + n++;
        out = name.slice(0, MAX_FIELD_NAME - suffix.length) + suffix;
    }
    taken.add(out);
    return out;
}

/** Dataset key → collection name. Keys are snake_case and under 50 characters. */
function collectionName(key) {
    return 'ds_' + key;
}

function validKey(key) {
    return typeof key === 'string' && /^[a-z][a-z0-9_]*$/.test(key) && key.length < 50;
}

module.exports = { SYSTEM_FIELDS, RESERVED, columnLetter, cleanHeader, baseName, fieldNames, uniqueName, collectionName, validKey };
