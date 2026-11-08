'use strict';
/**
 * lib/cmo_upload.js — reads the CM's Office (CMO) grievance register exported from the CMO portal and
 * turns it into the cmo_grievances snapshot (schema/cmo_grievances.json). Server only (in server.js's
 * PRIVATE_PATH). Pure functions, no I/O; the routes and the storage are in lib/cmo_routes.js.
 * Docs: docs/cmo-upload.md.
 *
 *   parseExport(buffer, filename, { now })       -> parsed (rows in the 17-column snapshot order, stats, blocks, warnings)
 *   parseExportIsolated(buffer, filename, opts)  -> Promise of the same, in a worker thread with a heap cap
 *                                                   and a time limit (like lib/safety_parser.js)
 *   review(parsed, currentRows)                  -> { blocks, warnings, notes, diff, summary } against the list now served
 *   readSnapshotRows(csvText)                    -> rows of a stored snapshot as objects by column name
 *   toCsv(header, rows)                          -> RFC 4180 text
 *
 * The export: one sheet, a title row "REGISTERD GRIEVANCE LIST AS ON dd-mm-yyyy", blank rows, then the header
 * (S.No + the 12 portal columns) and the grievances. The 5 columns the old Google sheet computed with
 * formulas are derived here:
 *   Name / Phone      the applicant cell split into the name and its trailing 10-digit mobile
 *   Pending With      the officer (the text before " [" in Assign To) when Assign To is a Malda Zone, WBSEDCL
 *                     post, else exactly 'Disposed / pending with HQ' (cmo.html and the rating read this)
 *   Report Date       the upload date in India (dd/mm/yyyy), the same on every row
 *   Grievance Since   whole days from the received date to the report date
 * Nothing here logs or returns applicant names, mobiles or grievance text except inside the rows.
 */
const crypto = require('crypto');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const SOURCE_COLUMNS = [
    'Applicant Name & Mobile Number', 'Received Date & Time', 'Block/ Municipality', 'GP/ Ward', 'Police Station',
    'District', 'Grievance Category', 'Grievance Description', 'Status', 'Assign To', 'Last ATN', 'Last ATN Remarks'
];
const DERIVED_COLUMNS = ['Name', 'Phone', 'Pending With', 'Report Date', 'Grievance Since'];
const SNAPSHOT_HEADER = SOURCE_COLUMNS.concat(DERIVED_COLUMNS);
const DISPOSED = 'Disposed / pending with HQ';
const MZO_POST = /malda zone,\s*wbsedcl/i;
const KNOWN_DISTRICTS = ['Malda', 'Dakshin Dinajpur', 'Uttar Dinajpur', 'Not Known'];
const SHOWN_DISTRICTS = ['Malda', 'Dakshin Dinajpur', 'Uttar Dinajpur']; // cmo.html shows only these
const KNOWN_STATUSES = ['Disposed', 'ATR Submitted to CMO', 'Assign to SO', 'Forwarded to HoSO', 'ATR Submitted to HoSO', 'ATR Submitted to HoD'];

const LIMITS = {
    maxBytes: 10 * 1024 * 1024, // the uploaded file
    maxRows: 20000,
    badShare: 0.05,             // rows with an unreadable/future received date or no district: above this, blocked
    dropShare: 0.30,            // fewer rows than the list now served by more than this: a warning
    titleDays: 2,               // the title's AS ON date may differ from the upload date by this many days
    headerScan: 30              // rows searched for the header
};
const COL = Object.fromEntries(SNAPSHOT_HEADER.map((h, i) => [h, i]));
const DAY = 86400000;
const IST_MS = 5.5 * 3600000;
const MAX_CELL = 32767;

class CmoBlock extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

/* ---------------- small helpers ---------------- */

const headerKey = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
const collapse = (s) => String(s == null ? '' : s).replace(/_x000D_/gi, ' ').replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');
const fmt = (n) => Number(n).toLocaleString('en-IN');
const quote = (s) => `'${s}'`;
const listRows = (nums) => (nums.length > 1 ? 'rows ' : 'row ') + nums.slice(0, 8).join(', ') + (nums.length > 8 ? ', …' : '');
const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

/** 'yyyy-mm-dd' of a UTC date-only value, or '' when y/m/d is not a real date. */
function ymdOf(y, m, d) {
    if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    const t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return '';
    return `${y}-${pad(m)}-${pad(d)}`;
}
const dayNo = (ymd) => Date.parse(ymd + 'T00:00:00Z') / DAY;
const dmyOfYmd = (ymd) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;

/** Today's date in India for a time in ms: 'yyyy-mm-dd'. */
function istYmd(ms) {
    const d = new Date(ms + IST_MS);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * The received date: 'yyyy-mm-dd' text (the portal's), an Excel date serial, or dd-mm-yyyy / dd/mm/yyyy /
 * dd.mm.yyyy, each with an optional time. → { ymd, text } (text = the value to store, yyyy-mm-dd first) or null.
 */
function parseReceived(v) {
    if (typeof v === 'number' || (typeof v === 'string' && /^\s*\d{5}(\.\d+)?\s*$/.test(v))) {
        const n = Number(v);
        if (!(n > 36526 && n < 73051)) return null; // 2000-01-01 .. 2100-01-01
        const t = new Date(Math.round((n - 25569) * DAY));
        const ymd = ymdOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
        if (!ymd) return null;
        const hm = t.getUTCHours() || t.getUTCMinutes() ? ` ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}` : '';
        return { ymd, text: ymd + hm };
    }
    const s = collapse(v);
    if (!s) return null;
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](.*))?$/.exec(s);
    if (m) {
        const ymd = ymdOf(+m[1], +m[2], +m[3]);
        return ymd ? { ymd, text: ymd + (m[4] && m[4].trim() ? ' ' + m[4].trim() : '') } : null;
    }
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:$|\s+(.*)$)/.exec(s);
    if (m) {
        const ymd = ymdOf(+m[3], +m[2], +m[1]);
        return ymd ? { ymd, text: ymd + (m[4] ? ' ' + m[4] : '') } : null;
    }
    return null;
}

/** The applicant cell "Name\n9xxxxxxxxx" → { name, phone } (phone '' when there is no trailing 10-digit number). */
function splitApplicant(cell) {
    const s = String(cell == null ? '' : cell).replace(/_x000D_/gi, ' ').trim();
    const m = /^([\s\S]*?)(?:\+?91[\s-]?|0)?(\d{10})$/.exec(s);
    // A digit right before the 10 digits means a longer number, not a mobile.
    if (!m || /\d$/.test(m[1])) return { name: collapse(s), phone: '' };
    return { name: collapse(m[1]).replace(/[\s,:;/-]+$/, ''), phone: m[2] };
}

/** Pending With: the Malda Zone officer the grievance sits with, else 'Disposed / pending with HQ'. */
function pendingWith(assignTo) {
    const s = collapse(assignTo);
    if (!MZO_POST.test(s)) return DISPOSED;
    const at = s.indexOf(' [');
    const name = (at >= 0 ? s.slice(0, at) : s.split('[')[0]).trim();
    return name || s;
}

/** The stable key of a grievance (the portal has no grievance ID): applicant, received date, category, description. */
function grievanceKey(applicant, receivedYmdOrText, category, description) {
    const text = [applicant, receivedYmdOrText, category, description].map(collapse).join('\u001f');
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

function cellText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v).slice(0, MAX_CELL);
}

/* ---------------- reading the file ---------------- */

/** Rows (arrays of cells) of an .xlsx or .csv file; throws CmoBlock with a plain message otherwise. */
function readRows(buf, filename) {
    const name = String(filename || '').toLowerCase();
    const ext = (/\.([a-z0-9]+)$/.exec(name) || [])[1] || '';
    if (!Buffer.isBuffer(buf) || !buf.length) throw new CmoBlock('empty', 'The file is empty.');
    if (buf.length > LIMITS.maxBytes) throw new CmoBlock('too_large', `The file is larger than ${LIMITS.maxBytes / 1024 / 1024} MB.`);
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
    if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
        throw new CmoBlock('type', 'This is the old binary .xls format. Open it in Excel, save it as .xlsx or .csv, and upload that.');
    }
    if (ext === 'xlsx' || (isZip && ext !== 'csv')) {
        if (!isZip) throw new CmoBlock('type', 'This file is named .xlsx but is not an Excel workbook. Upload the export as downloaded from the CMO portal.');
        try {
            return require('./xlsx_lite').firstSheetRows(buf, { maxBytes: 64 * 1024 * 1024 });
        } catch (err) {
            throw new CmoBlock('type', `The Excel file could not be read: ${String(err.message || err).replace(/\.$/, '')}.`);
        }
    }
    if (ext !== 'csv') throw new CmoBlock('type', 'Upload the CMO portal export as an .xlsx or .csv file.');
    if (isZip || buf.indexOf(0) !== -1) throw new CmoBlock('type', 'This file is named .csv but is not a text CSV file.');
    const text = buf.toString('utf8').replace(/^﻿/, '');
    const first = text.slice(0, Math.max(0, text.search(/\r?\n|$/)));
    const delimiter = first.split('\t').length > first.split(',').length ? '\t' : ',';
    return require('./csv').parseRows(text, { delimiter });
}

/** The header row: the row among the first LIMITS.headerScan that names the most portal columns. */
function findHeader(rows) {
    const want = SOURCE_COLUMNS.map(headerKey);
    let best = { index: -1, hits: 0 };
    const scan = Math.min(rows.length, LIMITS.headerScan);
    for (let i = 0; i < scan; i++) {
        const cells = (rows[i] || []).map(headerKey);
        const hits = want.filter((w) => cells.includes(w)).length;
        if (hits > best.hits) best = { index: i, hits };
    }
    if (best.hits < 3) {
        throw new CmoBlock('no_header', "This does not look like the CMO grievance register: no header row with the portal's columns " +
            "(for example 'Applicant Name & Mobile Number', 'District' and 'Assign To') was found in the first " + LIMITS.headerScan + ' rows.');
    }
    const cells = (rows[best.index] || []).map(headerKey);
    const pos = {};
    const missing = [];
    SOURCE_COLUMNS.forEach((name, i) => {
        const at = cells.indexOf(want[i]);
        if (at < 0) missing.push(name);
        else pos[name] = at;
    });
    const used = new Set(Object.values(pos));
    const extras = (rows[best.index] || []).map((h, i) => ({ h: collapse(h), i }))
        .filter((c) => c.h && !used.has(c.i) && !['s.no', 'sno', 'slno', 'sl.no', 'sl', 's/no'].includes(headerKey(c.h)))
        .map((c) => c.h);
    return { index: best.index, pos, missing, extras };
}

/** The title's "AS ON dd-mm-yyyy" date (rows above the header): 'yyyy-mm-dd' or ''. */
function titleDate(rows, headerIndex) {
    for (let i = 0; i < headerIndex; i++) {
        const text = (rows[i] || []).map(cellText).join(' ');
        const m = /\bAS\s*ON\s*:?\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/i.exec(text);
        if (m) return ymdOf(+m[3], +m[2], +m[1]);
    }
    return '';
}

/* ---------------- parse ---------------- */

function bump(map, k) { map[k] = (map[k] || 0) + 1; }

/**
 * Parse and derive. Never throws for a file problem: it returns { blocks: [...] } (and rows when it got
 * that far). opts.now: the upload time in ms (default now).
 */
function parseExport(buf, filename, opts) {
    const now = (opts && Number(opts.now)) || Date.now();
    const reportYmd = istYmd(now);
    const out = {
        header: SNAPSHOT_HEADER.slice(), rows: [], keys: [], reportYmd, reportDate: dmyOfYmd(reportYmd), titleYmd: '',
        extras: [], blocks: [], warnings: [], notes: [],
        stats: { total: 0, pendingMzo: 0, disposed: 0, byDistrict: {}, byStatus: {}, byPendingWith: {} },
        issues: { badRows: [], unknownDistricts: {}, unknownStatuses: {}, noMobile: [], duplicates: [] }
    };
    let raw;
    try {
        raw = readRows(buf, filename);
    } catch (err) {
        out.blocks.push({ code: err.code || 'type', message: err.message });
        return out;
    }
    let head;
    try {
        head = findHeader(raw);
    } catch (err) {
        out.blocks.push({ code: err.code || 'no_header', message: err.message });
        return out;
    }
    if (head.missing.length) {
        head.missing.forEach((name) => out.blocks.push({ code: 'missing_column', column: name, message: `The file is missing the column ${quote(name)}.` }));
        return out;
    }
    out.extras = head.extras;
    out.titleYmd = titleDate(raw, head.index);

    const reportDay = dayNo(reportYmd);
    const knownD = new Map(KNOWN_DISTRICTS.map((d) => [d.toLowerCase(), d]));
    const knownS = new Map(KNOWN_STATUSES.map((s) => [s.toLowerCase(), s]));
    const seen = new Map(); // grievance key -> rows so far
    const rowsSeen = new Set(); // every portal cell of a row: exact repeats
    for (let i = head.index + 1; i < raw.length; i++) {
        const r = raw[i] || [];
        const src = SOURCE_COLUMNS.map((name) => r[head.pos[name]]);
        if (src.every((v) => cellText(v).trim() === '')) continue; // blank rows
        const fileRow = i + 1;
        out.stats.total++;
        if (out.stats.total > LIMITS.maxRows) continue; // counted, not kept
        const cells = src.map(cellText);
        const received = parseReceived(src[COL['Received Date & Time']]);
        const district = collapse(cells[COL.District]);
        const future = received && dayNo(received.ymd) > reportDay;
        if (!received || future || !district) out.issues.badRows.push(fileRow);
        if (received) cells[COL['Received Date & Time']] = received.text;
        cells[COL.District] = knownD.get(district.toLowerCase()) || district;
        const status = collapse(cells[COL.Status]);
        cells[COL.Status] = knownS.get(status.toLowerCase()) || status;
        if (district && !knownD.has(district.toLowerCase())) bump(out.issues.unknownDistricts, district);
        if (status && !knownS.has(status.toLowerCase())) bump(out.issues.unknownStatuses, status);
        const who = splitApplicant(src[COL['Applicant Name & Mobile Number']]);
        if (!who.phone) out.issues.noMobile.push(fileRow);
        const owner = pendingWith(cells[COL['Assign To']]);
        const since = received && !future ? String(reportDay - dayNo(received.ymd)) : '';
        const row = cells.concat([who.name, who.phone, owner, out.reportDate, since]);
        // Two grievances can share applicant, date, category and text (filed twice): the nth one is "<key>:n".
        const base = grievanceKey(cells[COL['Applicant Name & Mobile Number']], received ? received.ymd : cells[COL['Received Date & Time']],
            cells[COL['Grievance Category']], cells[COL['Grievance Description']]);
        const nth = seen.get(base) || 0;
        seen.set(base, nth + 1);
        const whole = cells.map(collapse).join('\u001f');
        if (rowsSeen.has(whole)) out.issues.duplicates.push(fileRow);
        else rowsSeen.add(whole);
        out.rows.push(row);
        out.keys.push(nth ? `${base}:${nth}` : base);
        bump(out.stats.byDistrict, cells[COL.District] || '(blank)');
        bump(out.stats.byStatus, cells[COL.Status] || '(blank)');
        if (owner === DISPOSED) out.stats.disposed++;
        else { out.stats.pendingMzo++; bump(out.stats.byPendingWith, owner); }
    }

    const total = out.stats.total;
    if (!total) out.blocks.push({ code: 'no_rows', message: 'The file has the header row but no grievances under it.' });
    if (total > LIMITS.maxRows) {
        out.blocks.push({ code: 'too_many_rows', message: `The file has ${fmt(total)} grievances; the limit is ${fmt(LIMITS.maxRows)}. Check that this is the Malda Zone register from the CMO portal.` });
    }
    const bad = out.issues.badRows;
    if (total && bad.length > total * LIMITS.badShare) {
        out.blocks.push({ code: 'bad_rows', count: bad.length, message: `${fmt(bad.length)} of ${fmt(total)} rows (${pct(bad.length, total)}%) have an unreadable or future 'Received Date & Time' or no 'District' (${listRows(bad)}). At most ${LIMITS.badShare * 100}% may; check that the file is the unchanged CMO portal export.` });
    }
    if (out.blocks.length) { out.rows = []; out.keys = []; return out; }

    // Warnings the uploader must confirm (review() adds the comparison with the list now served).
    if (bad.length) {
        out.warnings.push({ code: 'bad_rows', count: bad.length, message: `${fmt(bad.length)} row${bad.length > 1 ? 's have' : ' has'} an unreadable or future 'Received Date & Time' or no 'District' (${listRows(bad)}). ${bad.length > 1 ? 'Their' : 'Its'} 'Grievance Since' is left blank.` });
    }
    const unkD = Object.entries(out.issues.unknownDistricts);
    if (unkD.length) {
        const n = unkD.reduce((a, [, c]) => a + c, 0);
        out.warnings.push({ code: 'unknown_district', count: n, values: unkD.map(([v, c]) => ({ value: v, count: c })), message: `${fmt(n)} row${n > 1 ? 's have' : ' has'} a district this report does not know: ${unkD.map(([v, c]) => `${quote(v)} (${c})`).join(', ')}. ${n > 1 ? 'They are' : 'It is'} kept, but the page shows only ${SHOWN_DISTRICTS.join(', ')}.` });
    }
    const unkS = Object.entries(out.issues.unknownStatuses);
    if (unkS.length) {
        const n = unkS.reduce((a, [, c]) => a + c, 0);
        out.warnings.push({ code: 'unknown_status', count: n, values: unkS.map(([v, c]) => ({ value: v, count: c })), message: `${fmt(n)} row${n > 1 ? 's have' : ' has'} a status not seen before: ${unkS.map(([v, c]) => `${quote(v)} (${c})`).join(', ')}. Check that the portal has not changed its export.` });
    }
    const dup = out.issues.duplicates;
    if (dup.length) {
        out.warnings.push({ code: 'duplicates', count: dup.length, message: `${fmt(dup.length)} row${dup.length > 1 ? 's repeat' : ' repeats'} an earlier row exactly, cell for cell: ${listRows(dup)}. ${dup.length > 1 ? 'They are' : 'It is'} kept as in the file.` });
    }
    if (!out.titleYmd) {
        out.warnings.push({ code: 'title_date', message: "The file has no 'AS ON dd-mm-yyyy' title, so its date cannot be checked. Make sure it is today's export." });
    } else {
        const gap = Math.round(dayNo(out.reportYmd) - dayNo(out.titleYmd));
        if (Math.abs(gap) > LIMITS.titleDays) {
            out.warnings.push({ code: 'title_date', days: gap, message: `The file's title says AS ON ${dmyOfYmd(out.titleYmd).replace(/\//g, '-')}, ${Math.abs(gap)} days ${gap > 0 ? 'before' : 'after'} today (${out.reportDate}). The report date will still be today; make sure this is the latest export.` });
        }
    }
    const noMob = out.issues.noMobile;
    if (noMob.length) {
        out.warnings.push({ code: 'no_mobile', count: noMob.length, message: `${fmt(noMob.length)} applicant${noMob.length > 1 ? 's have' : ' has'} no 10-digit mobile number in 'Applicant Name & Mobile Number' (${listRows(noMob)}). Phone is left blank for ${noMob.length > 1 ? 'them' : 'it'}.` });
    }
    if (out.extras.length) {
        out.notes.push({ code: 'extra_columns', message: `Ignored ${out.extras.length > 1 ? 'columns' : 'column'} not used by the report: ${out.extras.slice(0, 6).map(quote).join(', ')}${out.extras.length > 6 ? ', …' : ''}.` });
    }
    return out;
}

/* ---------------- the list now served ---------------- */

/** Rows of a stored snapshot (CSV text) as { key, status, pendingWith, district } plus the row count. */
function readSnapshotRows(csvText) {
    const rows = require('./csv').parseRows(String(csvText || ''));
    if (!rows.length) return [];
    const head = rows[0].map(headerKey);
    const at = (name) => head.indexOf(headerKey(name));
    const iA = at('Applicant Name & Mobile Number'), iR = at('Received Date & Time'), iC = at('Grievance Category'),
        iD = at('Grievance Description'), iS = at('Status'), iP = at('Pending With'), iDi = at('District'), iAs = at('Assign To');
    const out = [];
    const seen = new Map();
    for (let r = 1; r < rows.length; r++) {
        const c = rows[r];
        if (!c || c.every((v) => String(v).trim() === '')) continue;
        const g = (i) => (i >= 0 && c[i] != null ? c[i] : '');
        const rec = parseReceived(g(iR));
        const base = grievanceKey(g(iA), rec ? rec.ymd : g(iR), g(iC), g(iD));
        const nth = seen.get(base) || 0;
        seen.set(base, nth + 1);
        out.push({
            key: nth ? `${base}:${nth}` : base,
            status: collapse(g(iS)),
            pendingWith: iP >= 0 ? collapse(g(iP)) : pendingWith(g(iAs)),
            district: collapse(g(iDi))
        });
    }
    return out;
}

/**
 * Compare a parsed export with the list now served (readSnapshotRows, or null when there is none) and
 * finish the checks: { blocks, warnings, notes, diff, summary }.
 */
function review(parsed, current) {
    const warnings = parsed.warnings.slice();
    const total = parsed.stats.total;
    let diff = null;
    if (Array.isArray(current)) {
        const before = new Map();
        current.forEach((r) => { if (!before.has(r.key)) before.set(r.key, r); });
        const now = new Map();
        parsed.keys.forEach((k, i) => {
            if (!now.has(k)) now.set(k, { status: parsed.rows[i][COL.Status], pendingWith: parsed.rows[i][COL['Pending With']], district: parsed.rows[i][COL.District] });
        });
        let added = 0, removed = 0, changed = 0, nowPendingMzo = 0, wasPendingMzo = 0;
        const addedBy = {}, removedBy = {}, moves = {};
        for (const [k, r] of now) {
            const b = before.get(k);
            if (!b) { added++; bump(addedBy, r.district || '(blank)'); continue; }
            if (b.status !== r.status) { changed++; bump(moves, `${b.status || '(blank)'}\u0000${r.status || '(blank)'}`); }
        }
        for (const [k, b] of before) if (!now.has(k)) { removed++; bump(removedBy, b.district || '(blank)'); }
        current.forEach((r) => { if (r.pendingWith && r.pendingWith !== DISPOSED) wasPendingMzo++; });
        nowPendingMzo = parsed.stats.pendingMzo;
        diff = {
            currentRows: current.length, added, removed, statusChanged: changed, unchanged: now.size - added - changed,
            pendingMzoBefore: wasPendingMzo, pendingMzoAfter: nowPendingMzo,
            addedByDistrict: addedBy, removedByDistrict: removedBy,
            statusMoves: Object.entries(moves).map(([k, n]) => ({ from: k.split('\u0000')[0], to: k.split('\u0000')[1], count: n })).sort((a, b) => b.count - a.count)
        };
        if (current.length && total < current.length * (1 - LIMITS.dropShare)) {
            const drop = Math.round((1 - total / current.length) * 100);
            warnings.unshift({ code: 'row_drop', count: current.length - total, message: `This file has ${fmt(total)} grievances, ${drop}% fewer than the ${fmt(current.length)} now shown. Every upload replaces the whole list, so make sure the export is complete.` });
        }
    }
    return {
        blocks: parsed.blocks.slice(),
        warnings,
        notes: parsed.notes.slice(),
        diff,
        summary: {
            total, pendingMzo: parsed.stats.pendingMzo, disposed: parsed.stats.disposed,
            byDistrict: parsed.stats.byDistrict, byStatus: parsed.stats.byStatus, byPendingWith: parsed.stats.byPendingWith,
            reportDate: parsed.reportDate, titleDate: parsed.titleYmd ? dmyOfYmd(parsed.titleYmd) : ''
        }
    };
}

/* ---------------- CSV ---------------- */

function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(header, rows) {
    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) lines.push(r.map(csvCell).join(','));
    return lines.join('\r\n') + '\r\n';
}

/* ---------------- worker ---------------- */

/** parseExport in a worker thread with a heap cap and a time limit. */
function parseExportIsolated(buf, filename, opts) {
    const o = opts || {};
    const timeoutMs = o.timeoutMs || 60000;
    const maxMemoryMb = o.maxMemoryMb || 256;
    return new Promise((resolve, reject) => {
        let done = false;
        const worker = new Worker(__filename, {
            workerData: { cmoBuf: buf, filename: String(filename || ''), now: o.now || Date.now() },
            resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb, maxYoungGenerationSizeMb: 32 }
        });
        const finish = (fn, v) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            worker.terminate().catch(() => {});
            fn(v);
        };
        const timer = setTimeout(() => finish(reject, new Error('The file took too long to read.')), timeoutMs);
        worker.on('message', (m) => (m && m.ok ? finish(resolve, m.result) : finish(reject, new Error((m && m.error) || 'The file could not be read.'))));
        worker.on('error', (err) => finish(reject, new Error(err && err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'The file is too large to read.' : 'The file could not be read.')));
        worker.on('exit', (code) => finish(reject, new Error(code ? 'The file is too large to read.' : 'The file could not be read.')));
    });
}

if (!isMainThread && workerData && workerData.cmoBuf) {
    try {
        const u8 = workerData.cmoBuf;
        const buf = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
        parentPort.postMessage({ ok: true, result: parseExport(buf, workerData.filename, { now: workerData.now }) });
    } catch (err) {
        parentPort.postMessage({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
    }
}

module.exports = {
    parseExport, parseExportIsolated, review, readSnapshotRows, toCsv,
    parseReceived, splitApplicant, pendingWith, grievanceKey, istYmd, findHeader, titleDate,
    SOURCE_COLUMNS, DERIVED_COLUMNS, SNAPSHOT_HEADER, DISPOSED, KNOWN_DISTRICTS, KNOWN_STATUSES, LIMITS, CmoBlock
};
