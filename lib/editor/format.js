'use strict';
// Snapshot bytes <-> exact cells, for datasets the VM owns (mode 'native', docs/data-editor.md).
//
// The pages read a native dataset's snapshot exactly as they read the Google copy, so the editor
// writes it back in the source's own format: the same delimiter, quoting, line ending, trailing
// line ending and byte-order mark. detect() learns that format from a snapshot, parse() splits it
// into rows of untouched cells (nothing trimmed), serialize() writes rows back. For every format
// Google produces, serialize(parse(text)) === text; roundTrip() reports where it is not.
//
//   pub / export CSV   minimal quoting (only cells holding , " CR or LF), CRLF, no final line ending
//   gviz CSV           every cell quoted, LF
//   pub TSV            never quoted (Google's TSV output has no quotes), CRLF
//
// Parsing follows csv-parse as vm/sync/sources/google.js configures it (relax_quotes): a quote
// opens a quoted cell only at the start of a cell; a quote inside an unquoted cell is literal.

const FORMAT_VERSION = 1;

/** @returns {{ v, ext, delimiter, quote: 'minimal'|'all'|'none', eol, trailingEol, bom }} */
function detect(text, ext) {
    const s = String(text == null ? '' : text);
    const e = ext === 'tsv' ? 'tsv' : 'csv';
    const bom = s.charCodeAt(0) === 0xfeff;
    const body = bom ? s.slice(1) : s;
    const delimiter = e === 'tsv' ? '\t' : ',';
    let eol = null;
    let quotedCells = 0;
    let plainCells = 0;
    if (e === 'tsv') {
        const i = body.indexOf('\n');
        if (i >= 0) eol = i > 0 && body[i - 1] === '\r' ? '\r\n' : '\n';
    } else {
        // Walk the first rows to learn the line ending and whether every cell is quoted.
        let i = 0;
        let atCellStart = true;
        let rows = 0;
        const n = Math.min(body.length, 256 * 1024);
        while (i < n && rows < 200) {
            const c = body[i];
            if (atCellStart && c === '"') {
                quotedCells++;
                i++;
                for (;;) {
                    const k = body.indexOf('"', i);
                    if (k < 0) { i = body.length; break; }
                    if (body[k + 1] === '"') { i = k + 2; continue; }
                    i = k + 1;
                    break;
                }
                atCellStart = false;
                continue;
            }
            if (atCellStart && c !== ',' && c !== '\r' && c !== '\n') plainCells++;
            if (atCellStart && (c === ',' || c === '\r' || c === '\n')) plainCells++; // an empty unquoted cell
            if (c === ',') { atCellStart = true; i++; continue; }
            if (c === '\r' || c === '\n') {
                if (!eol) eol = c === '\r' && body[i + 1] === '\n' ? '\r\n' : c === '\r' ? '\r' : '\n';
                i += c === '\r' && body[i + 1] === '\n' ? 2 : 1;
                atCellStart = true;
                rows++;
                continue;
            }
            atCellStart = false;
            i++;
        }
    }
    const quote = e === 'tsv' ? 'none' : quotedCells > 0 && plainCells === 0 ? 'all' : 'minimal';
    const used = eol || '\r\n';
    const trailingEol = !!eol && body.length > 0 && body.endsWith(used);
    return { v: FORMAT_VERSION, ext: e, delimiter, quote, eol: used, trailingEol, bom };
}

/**
 * Text → rows of exact cells. Blank lines come back as [''] (the sync skips them; so do the pages).
 * A final line ending does not make an extra row.
 */
function parse(text, fmt) {
    let s = String(text == null ? '' : text);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    const d = fmt.delimiter || ',';
    const rows = [];
    if (!s.length) return rows;
    if (fmt.quote === 'none') {
        const lines = s.split(/\r\n|\n|\r/);
        if (lines.length && lines[lines.length - 1] === '' && /(\r\n|\n|\r)$/.test(s)) lines.pop();
        for (const line of lines) rows.push(line.split(d));
        return rows;
    }
    let row = [];
    let cell = '';
    let i = 0;
    const n = s.length;
    let atStart = true;
    while (i < n) {
        const c = s[i];
        if (atStart && c === '"') {
            i++;
            for (;;) {
                const k = s.indexOf('"', i);
                if (k < 0) { cell += s.slice(i); i = n; break; }
                if (s[k + 1] === '"') { cell += s.slice(i, k + 1); i = k + 2; continue; }
                cell += s.slice(i, k);
                i = k + 1;
                break;
            }
            atStart = false;
            continue;
        }
        if (c === d) {
            row.push(cell);
            cell = '';
            atStart = true;
            i++;
            continue;
        }
        if (c === '\r' || c === '\n') {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
            atStart = true;
            i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
            continue;
        }
        cell += c;
        atStart = false;
        i++;
    }
    if (cell !== '' || row.length || !atStart) {
        row.push(cell);
        rows.push(row);
    }
    return rows;
}

function needsQuote(cell, d) {
    for (let i = 0; i < cell.length; i++) {
        const c = cell[i];
        if (c === d || c === '"' || c === '\n' || c === '\r') return true;
    }
    return false;
}

function cellText(v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'string' ? v : String(v);
}

/** One row → a line, without its line ending. */
function line(row, fmt) {
    const d = fmt.delimiter || ',';
    const out = new Array(row.length);
    for (let i = 0; i < row.length; i++) {
        let c = cellText(row[i]);
        if (fmt.quote === 'none') {
            // TSV cannot hold a tab or a line break in a cell: Google writes them as spaces.
            out[i] = /[\t\r\n]/.test(c) ? c.replace(/[\t\r\n]+/g, ' ') : c;
        } else if (fmt.quote === 'all' || needsQuote(c, d)) {
            out[i] = '"' + c.replace(/"/g, '""') + '"';
        } else {
            out[i] = c;
        }
    }
    return out.join(d);
}

/** Rows → text in this format. */
function serialize(rows, fmt) {
    const eol = fmt.eol || '\r\n';
    let s = rows.map((r) => line(r, fmt)).join(eol);
    if (fmt.trailingEol && rows.length) s += eol;
    return (fmt.bom ? '﻿' : '') + s;
}

/** Streams the same text as serialize() through write(chunk) (for big datasets). */
async function serializeTo(rowsIterable, fmt, write) {
    const eol = fmt.eol || '\r\n';
    let first = true;
    let buf = fmt.bom ? '﻿' : '';
    let any = false;
    for await (const r of rowsIterable) {
        buf += (first ? '' : eol) + line(r, fmt);
        first = false;
        any = true;
        if (buf.length > 256 * 1024) {
            await write(buf);
            buf = '';
        }
    }
    if (fmt.trailingEol && any) buf += eol;
    if (buf) await write(buf);
}

function isBlankRow(r) {
    for (let i = 0; i < r.length; i++) if (String(r[i]).trim() !== '') return false;
    return true;
}

/**
 * Does this snapshot survive snapshot → cells → snapshot?
 * @returns {{ ok, identical, blankRowsDropped, fmt, rows, firstDiff?: {offset, want, got} }}
 *   identical: byte-identical with every row kept; ok: identical once rows with no value are left
 *   out (the mirror never stores those, and the pages skip them).
 */
function roundTrip(text, ext) {
    const fmt = detect(text, ext);
    const rows = parse(text, fmt);
    const again = serialize(rows, fmt);
    const kept = rows.filter((r, i) => i === 0 || !isBlankRow(r));
    const dropped = rows.length - kept.length;
    const out = { ok: false, identical: again === text, blankRowsDropped: dropped, fmt, rows: rows.length };
    if (!out.identical) {
        out.firstDiff = firstDiff(text, again);
        return out;
    }
    out.ok = true;
    return out;
}

function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return { offset: i, want: JSON.stringify(a.slice(Math.max(0, i - 20), i + 30)), got: JSON.stringify(b.slice(Math.max(0, i - 20), i + 30)) };
}

module.exports = { FORMAT_VERSION, detect, parse, serialize, serializeTo, line, isBlankRow, roundTrip };
