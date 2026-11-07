'use strict';
// A small RFC 4180 CSV reader for the server (never loaded in the browser; in server.js's PRIVATE_PATH).
//
//   parseRows(text, { delimiter = ',' })  -> [[cell, …], …]   every record, cells exactly as written
//   parseObjects(text, opts)              -> [{ header: cell }]  first record is the header
//
// Quoted fields may hold the delimiter, doubled quotes and line breaks (\n or \r\n). Cells are never
// converted: "000123", "11/7/2026" and "1e3" stay text (SheetJS, used before, rewrote dates to a
// two-digit year). A leading byte-order mark is dropped. parseObjects skips blank records, fills
// missing cells with '', names an empty header __EMPTY (then __EMPTY_1, …) and a repeated header
// name_1, name_2, … (the keys SheetJS's sheet_to_json gave).

function parseRows(text, opts) {
    const delim = (opts && opts.delimiter) || ',';
    const s = String(text == null ? '' : text).replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    let i = 0;
    const n = s.length;
    while (i < n) {
        const ch = s[i];
        if (quoted) {
            if (ch === '"') {
                if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
                quoted = false;
                i++;
                continue;
            }
            cell += ch;
            i++;
            continue;
        }
        if (ch === '"' && cell === '') { quoted = true; i++; continue; }
        if (ch === delim) { row.push(cell); cell = ''; i++; continue; }
        if (ch === '\r' || ch === '\n') {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
            i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
            continue;
        }
        cell += ch;
        i++;
    }
    if (cell !== '' || row.length || quoted) {
        row.push(cell);
        rows.push(row);
    }
    return rows;
}

function headerKeys(header) {
    const seen = new Map();
    return header.map((h) => {
        const base = h === '' ? '__EMPTY' : h;
        const count = seen.get(base) || 0;
        seen.set(base, count + 1);
        return count ? `${base}_${count}` : base;
    });
}

function parseObjects(text, opts) {
    const rows = parseRows(text, opts);
    if (!rows.length) return [];
    const keys = headerKeys(rows[0]);
    const out = [];
    for (let r = 1; r < rows.length; r++) {
        const cells = rows[r];
        if (cells.every((c) => c === '')) continue;
        const obj = {};
        keys.forEach((k, idx) => { obj[k] = cells[idx] != null ? cells[idx] : ''; });
        out.push(obj);
    }
    return out;
}

module.exports = { parseRows, parseObjects };
