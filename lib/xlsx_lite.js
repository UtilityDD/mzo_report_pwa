'use strict';
// A small reader for the first worksheet of an .xlsx file (server only; in server.js's PRIVATE_PATH).
//
//   firstSheetRows(buffer, { maxBytes }) -> [[cell, …], …]
//
// An .xlsx file is a zip of XML parts. This reads the zip's central directory, inflates only the parts
// it needs (the workbook, its relationships, the shared strings and the first sheet) with Node's zlib,
// and pulls the cell values out of the sheet XML. Cells are strings, numbers (as written; date cells
// stay Excel serial numbers) or booleans; formulas give their cached value. No styles, no formulas,
// no zip64, no encryption: anything it cannot read throws an Error with a plain message.
// maxBytes caps each inflated part (and the sum of all of them), so a small "zip bomb" cannot use up
// memory. It replaces the xlsx package (SheetJS 0.18.5 on npm), which has unfixed advisories.

const zlib = require('zlib');

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

function fail(msg) {
    throw new Error(msg);
}

/** The zip's entries by name: { method, compSize, size, offset }. */
function zipEntries(buf) {
    const min = Math.max(0, buf.length - 22 - 0xffff);
    let eocd = -1;
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) fail('Not an .xlsx file (no zip directory).');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || p === 0xffffffff) fail('This .xlsx file is too large to read (zip64).');
    const entries = new Map();
    for (let n = 0; n < count; n++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail('The .xlsx file is damaged (zip directory).');
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const offset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        if (flags & 1) fail('The .xlsx file is password protected.');
        entries.set(name, { method, compSize, size, offset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

function reader(buf, maxBytes) {
    const entries = zipEntries(buf);
    let total = 0;
    return function part(name) {
        const e = entries.get(name);
        if (!e) return null;
        const h = e.offset;
        if (h + 30 > buf.length || buf.readUInt32LE(h) !== 0x04034b50) fail('The .xlsx file is damaged (zip entry).');
        const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
        const end = start + e.compSize;
        if (end > buf.length) fail('The .xlsx file is damaged (zip entry size).');
        const data = buf.subarray(start, end);
        const left = maxBytes - total;
        if (left <= 0) fail('The .xlsx file is too large once unpacked.');
        let out;
        if (e.method === 0) out = data;
        else if (e.method === 8) {
            try {
                out = zlib.inflateRawSync(data, { maxOutputLength: left });
            } catch (err) {
                if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || /larger than|too large/i.test(err.message))) fail('The .xlsx file is too large once unpacked.');
                fail('The .xlsx file is damaged (compressed data).');
            }
        } else fail('The .xlsx file uses an unsupported compression method.');
        if (out.length > left) fail('The .xlsx file is too large once unpacked.');
        total += out.length;
        return out.toString('utf8');
    };
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decodeXml(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
        }
        const v = ENTITIES[e.toLowerCase()];
        return v === undefined ? m : v;
    });
}

/** Text of an <si> or <is> element: its <t> runs, without phonetic (<rPh>) runs. */
function richText(xml) {
    const s = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let out = '';
    const re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
    let m;
    while ((m = re.exec(s))) out += m[1] ? decodeXml(m[1]) : '';
    return out;
}

function attr(attrs, name) {
    const m = new RegExp('\\b' + name + '="([^"]*)"').exec(attrs);
    return m ? decodeXml(m[1]) : null;
}

function colIndex(ref) {
    const m = /^([A-Z]+)/i.exec(ref || '');
    if (!m) return -1;
    let n = 0;
    for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

const MAX_COLS = 16384; // Excel's limit (XFD)

/** The first worksheet's rows as arrays of cell values ('' for empty cells). */
function firstSheetRows(buf, opts) {
    if (!Buffer.isBuffer(buf)) fail('No file data.');
    const maxBytes = (opts && opts.maxBytes) || DEFAULT_MAX_BYTES;
    const part = reader(buf, maxBytes);

    // The first sheet in the workbook, through its relationship; sheet1.xml when that is missing.
    let sheetPath = 'xl/worksheets/sheet1.xml';
    const wb = part('xl/workbook.xml');
    if (!wb) fail('Not an Excel workbook (no xl/workbook.xml).');
    const sheet = /<sheet\b([^>]*)\/?>/.exec(wb);
    const rid = sheet ? attr(sheet[1], 'r:id') : null;
    const rels = part('xl/_rels/workbook.xml.rels');
    if (rid && rels) {
        const re = /<Relationship\b([^>]*)\/?>/g;
        let m;
        while ((m = re.exec(rels))) {
            if (attr(m[1], 'Id') !== rid) continue;
            const target = attr(m[1], 'Target') || '';
            const p = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
            const parts = [];
            for (const seg of p.split('/')) {
                if (seg === '..') parts.pop();
                else if (seg && seg !== '.') parts.push(seg);
            }
            sheetPath = parts.join('/');
            break;
        }
    }

    const strings = [];
    const sst = part('xl/sharedStrings.xml');
    if (sst) {
        const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
        let m;
        while ((m = re.exec(sst))) strings.push(m[1] ? richText(m[1]) : '');
    }

    const xml = part(sheetPath);
    if (xml == null) fail('The workbook has no readable first sheet.');
    const rows = [];
    const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
        const rAttr = attr(rm[1], 'r');
        const rowNo = rAttr ? parseInt(rAttr, 10) - 1 : rows.length;
        if (!Number.isFinite(rowNo) || rowNo < rows.length) continue; // repeated or out of order: skip
        while (rows.length < rowNo) rows.push([]);
        const row = [];
        const body = rm[2] || '';
        cellRe.lastIndex = 0;
        let cm;
        while ((cm = cellRe.exec(body))) {
            const a = cm[1];
            const inner = cm[2] || '';
            let ci = colIndex(attr(a, 'r'));
            if (ci < 0) ci = row.length;
            if (ci >= MAX_COLS) continue;
            const t = attr(a, 't') || 'n';
            let v = '';
            if (t === 'inlineStr') {
                const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner);
                v = is ? richText(is[1]) : '';
            } else {
                const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
                const raw = vm ? decodeXml(vm[1]) : '';
                if (t === 's') v = strings[parseInt(raw, 10)] || '';
                else if (t === 'b') v = raw === '1';
                else if (t === 'n' && raw !== '') {
                    const num = Number(raw);
                    v = Number.isFinite(num) ? num : raw;
                } else v = raw; // str, e, d
            }
            while (row.length < ci) row.push('');
            row[ci] = v;
        }
        rows.push(row);
    }
    return rows;
}

module.exports = { firstSheetRows, decodeXml };
