'use strict';
// Source headers → PocketBase field names (snake_case ASCII). The rules are lib/uniform.js's
// (shared with the pages' uniform rows, docs/uniform-data.md): lowercase; non-alphanumerics → "_";
// collapse repeats; trim "_"; "c_" prefix if it starts with a digit; an empty header is
// col_<letter>; at most 60 characters; dedupe with _2, _3; never collide with PocketBase or sync
// system names.

const U = require('../../../lib/uniform.js');

const SYSTEM_FIELDS = ['_row_key', '_row_no', '_synced_at', '_hash'];
// Names PocketBase reserves on records (plus auth names) and the sync's system fields.
const RESERVED = new Set(U.RESERVED);
const MAX_FIELD_NAME = 60;

/** Spreadsheet column letter for a 0-based index: 0 → a, 25 → z, 26 → aa. */
function columnLetter(index) {
    return U.baseName('', index).slice(4); // "col_<letter>"
}

/** Reserve and return `name`, or name_2, name_3, … if it is already taken (lib/uniform.js's rule for _raw names). */
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

module.exports = {
    SYSTEM_FIELDS,
    RESERVED,
    columnLetter,
    cleanHeader: U.cleanHeader,
    baseName: (sourceName, index) => U.baseName(sourceName, index || 0),
    fieldNames: U.fieldNames,
    uniqueName,
    collectionName,
    validKey
};
