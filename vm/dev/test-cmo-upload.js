#!/usr/bin/env node
'use strict';
// Test of the CMO grievance upload (lib/cmo_upload.js, lib/cmo_routes.js; docs/cmo-upload.md), with no network
// and SYNTHETIC data only (fake names, fake numbers 90000000xx): upstream GETs get an empty JSON list, other
// upstream requests are refused and recorded, and the mirror's write-through sync is recorded instead of started.
//
//   node vm/dev/test-cmo-upload.js
//
// Checks: header detection under the title and blank rows; the derived columns (Name/Phone, Pending With incl.
// "Forwarded to HoSO" to the Zonal Manager, Report Date in India, Grievance Since); every block and warning; the
// comparison with the list now served; the worker; the two-step token flow; who may (viewer 403, admin, the
// cmo-upload-autho flag); the Origin check; the lock; undo and the 5 kept versions; the no-data-gap fallback
// (the sync source skips without a file and the manifest keeps the Google copy; /api/cmo/dataset serves the
// snapshot); no names or mobiles in logs, the audit trail or the activity log.
// Also, only on a machine that has it, the real export at CMO_REAL_SAMPLE (default ~/Desktop/cbse-thingy/
// GRIEVANCE_REGISTER_08_11_2026.xlsx): aggregates only (304 rows, 19 pending with MZO, district counts).

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const assert = require('assert');
const { EventEmitter } = require('events');
const childProcess = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SECRET = 'test-secret-for-cmo-upload';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-cmo-'));
const FILES = path.join(TMP, 'files');
const SNAPS = path.join(TMP, 'snapshots');
fs.mkdirSync(FILES);
fs.mkdirSync(SNAPS);
const REAL = process.env.CMO_REAL_SAMPLE || path.join(os.homedir(), 'Desktop', 'cbse-thingy', 'GRIEVANCE_REGISTER_08_11_2026.xlsx');

process.env.JWT_SECRET = SECRET;
process.env.MZO_FILES_DIR = FILES;
process.env.MZO_DATA_MODE = 'mirror';
process.env.MZO_SNAPSHOT_DIR = SNAPS;
delete process.env.MZO_USER_STORE;
delete process.env.VERCEL;
delete process.env.PB_URL;

let passed = 0;
function ok(cond, label) { assert.ok(cond, label); passed++; console.log('  ok  ' + label); }
function eq(a, b, label) { assert.deepStrictEqual(a, b, label); passed++; console.log('  ok  ' + label); }

// ---- Fixtures (synthetic) --------------------------------------------------------------------------
const PORTAL = ['Applicant Name & Mobile Number', 'Received Date & Time', 'Block/ Municipality', 'GP/ Ward', 'Police Station',
    'District', 'Grievance Category', 'Grievance Description', 'Status', 'Assign To', 'Last ATN', 'Last ATN Remarks'];
const ZM = 'Officer Zed [Zonal Manager (Power Department) - Head of Sub-Office (HoSO) - Malda Zone, WBSEDCL) ]';
const AM = 'Officer Am [Assistant Manager (Power Department) - Sub-Office User (SOU) - Malda Zone, WBSEDCL) ]';
const SDO = 'Officer Sdo [Sub Divisional Officer (DM, Test District) - Head of Sub-Office (HoSO) - S.D.O., TEST SADAR) ]';
const CAT = 'Power-Electricity Connection/ Transmission Line & Service related Issues';
const DISTRICTS = ['Malda', 'Uttar Dinajpur', 'Dakshin Dinajpur'];
const fakePhone = (i) => String(9000000000 + i);
const fakeName = (i) => `Test Person ${i}`;

/** One portal row (12 cells) for grievance i; o overrides cells by column name. */
function portalRow(i, o) {
    const status = ['Disposed', 'ATR Submitted to CMO', 'Assign to SO', 'Forwarded to HoSO'][i % 4];
    const assign = { Disposed: 'N/A', 'ATR Submitted to CMO': 'Pending At CMO', 'Assign to SO': AM, 'Forwarded to HoSO': ZM }[status];
    const r = {
        'Applicant Name & Mobile Number': `${fakeName(i)}\n${fakePhone(i)}`,
        'Received Date & Time': `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`,
        'Block/ Municipality': `Block ${i % 5}`, 'GP/ Ward': `Ward ${i % 7}`, 'Police Station': `PS ${i % 3}`,
        District: DISTRICTS[i % 3], 'Grievance Category': CAT, 'Grievance Description': `Synthetic grievance text number ${i}`,
        Status: status, 'Assign To': assign, 'Last ATN': 'ATR Submitted', 'Last ATN Remarks': `Synthetic remark ${i}`
    };
    Object.assign(r, o || {});
    return PORTAL.map((h) => r[h]);
}
/** The export's layout: title, blank, header (S.No + 12), blank, rows with S.No. */
function exportRows(n, { title = 'REGISTERD GRIEVANCE LIST AS ON 08-11-2026', over = {}, header = PORTAL, sno = true } = {}) {
    const rows = [];
    if (title !== null) rows.push([title], []);
    rows.push(sno ? ['S.No'].concat(header) : header.slice());
    rows.push([]);
    for (let i = 1; i <= n; i++) {
        const cells = portalRow(i, over[i]);
        rows.push(sno ? [i].concat(cells) : cells);
    }
    return rows;
}

/** A minimal .xlsx (deflated zip parts, inline strings and numbers), like vm/dev/test-safety-upload.js. */
function makeXlsx(rows) {
    const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const col = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
    const sheet = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => {
            const ref = col(ci) + (ri + 1);
            if (v === '' || v == null) return '';
            return typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
        }).join('') + '</row>').join('') + '</sheetData></worksheet>';
    const parts = {
        '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
        'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': sheet
    };
    const locals = [], central = [];
    let offset = 0;
    for (const [name, content] of Object.entries(parts)) {
        const raw = Buffer.from(content, 'utf8');
        const data = zlib.deflateRawSync(raw);
        const nameBuf = Buffer.from(name, 'utf8');
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
        lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
        ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
        locals.push(lh, nameBuf, data);
        central.push(ch, nameBuf);
        offset += 30 + nameBuf.length + data.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(parts).length, 8); end.writeUInt16LE(Object.keys(parts).length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}
const csvOf = (rows) => rows.map((r) => r.map((v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',')).join('\n') + '\n';

// The upload day: 8 Nov 2026 in India (02:00 IST = 7 Nov 20:30 UTC, so the India date is the one used).
const NOW = Date.parse('2026-11-07T20:30:00Z');

// ---- Unit ------------------------------------------------------------------------------------------
async function unit() {
    const CU = require(path.join(ROOT, 'lib', 'cmo_upload.js'));
    const P = (rows, name = 'GRIEVANCE_REGISTER.xlsx', now = NOW) => CU.parseExport(name.endsWith('.csv') ? Buffer.from(csvOf(rows)) : makeXlsx(rows), name, { now });

    // Header detection and the snapshot layout.
    const base = P(exportRows(12));
    eq(base.blocks, [], 'parse: the usual export is accepted');
    eq(base.header, PORTAL.concat(['Name', 'Phone', 'Pending With', 'Report Date', 'Grievance Since']), 'parse: the 17 snapshot columns in the exact order');
    eq([base.stats.total, base.rows.length], [12, 12], 'parse: title, blank rows and S.No skipped; 12 grievances');
    eq(base.titleYmd, '2026-11-08', "parse: the title's AS ON date is read");
    eq(base.warnings, [], 'parse: no warnings for the usual export');
    const noSno = P(exportRows(3, { title: null, sno: false }), 'x.csv');
    ok(noSno.blocks.length === 0 && noSno.rows.length === 3, 'parse: CSV without a title or S.No column');
    const fuzzyHead = PORTAL.map((h, i) => (i % 2 ? h.toUpperCase() : h.replace(/ /g, '  ')));
    fuzzyHead[2] = 'block /municipality';
    const fuzzy = P(exportRows(2, { header: fuzzyHead }));
    ok(fuzzy.blocks.length === 0 && fuzzy.rows[0][2] === 'Block 1', 'parse: header names matched case- and space-insensitively');
    const extra = P(exportRows(2, { header: PORTAL.concat(['Remarks by DM']) }));
    ok(extra.blocks.length === 0 && extra.notes.some((n) => n.code === 'extra_columns' && /Remarks by DM/.test(n.message)) && extra.warnings.length === 0, 'parse: an extra column is ignored with a note');
    const reordered = P(exportRows(2, { sno: false }).map((r, i) => (i < 2 ? r : r.slice().reverse())), 'r.xlsx');
    eq(reordered.rows[0].slice(0, 12), base.rows[0].slice(0, 12), 'parse: columns matched by name, in any order');

    // Derived columns.
    const r1 = base.rows[0]; // i = 1: ATR Submitted to CMO, Pending At CMO
    const r3 = base.rows[2]; // i = 3: Forwarded to HoSO, the Zonal Manager
    const r2 = base.rows[1]; // i = 2: Assign to SO, an Assistant Manager
    const r4 = base.rows[3]; // i = 4: Disposed, N/A
    eq([r1[12], r1[13]], [fakeName(1), fakePhone(1)], 'derive: Name and Phone split from "Name\\n90000000xx"');
    eq(r3[14], 'Officer Zed', 'derive: Forwarded to HoSO with the Zonal Manager of Malda Zone, WBSEDCL -> his name');
    eq(r2[14], 'Officer Am', 'derive: Assign to SO with a Malda Zone officer -> the officer');
    eq([r1[14], r4[14]], ['Disposed / pending with HQ', 'Disposed / pending with HQ'], 'derive: Pending At CMO and N/A -> exactly "Disposed / pending with HQ"');
    eq(CU.pendingWith(SDO), 'Disposed / pending with HQ', 'derive: a HoSO outside Malda Zone, WBSEDCL -> "Disposed / pending with HQ"');
    eq(CU.pendingWith('Officer Odd[Manager - Malda Zone, WBSEDCL) ]'), 'Officer Odd', 'derive: officer name without a space before "["');
    ok(base.rows.every((r) => r[15] === '08/11/2026'), 'derive: Report Date = the upload date in India (dd/mm/yyyy), same on every row');
    eq([r1[1], r1[16]], ['2026-10-02', '37'], 'derive: Grievance Since = whole days from the received date to the report date');
    eq(base.stats.pendingMzo, 6, 'derive: 6 of 12 pending with an MZO officer');
    eq(CU.splitApplicant('Some One, +91 9000000099'), { name: 'Some One', phone: '9000000099' }, 'derive: +91 prefix and separators');
    eq(CU.splitApplicant('Some One 900000009'), { name: 'Some One 900000009', phone: '' }, 'derive: no 10-digit mobile -> Phone blank');
    eq(CU.parseReceived(46310), { ymd: '2026-10-15', text: '2026-10-15' }, 'dates: an Excel date serial');
    eq(CU.parseReceived(46310.5), { ymd: '2026-10-15', text: '2026-10-15 12:00' }, 'dates: an Excel date-time serial');
    eq(CU.parseReceived('15-10-2026'), { ymd: '2026-10-15', text: '2026-10-15' }, 'dates: dd-mm-yyyy');
    eq(CU.parseReceived('2026-10-15 14:05'), { ymd: '2026-10-15', text: '2026-10-15 14:05' }, 'dates: yyyy-mm-dd with a time kept');
    eq([CU.parseReceived('31-02-2026'), CU.parseReceived('soon'), CU.parseReceived('')], [null, null, null], 'dates: impossible or unreadable -> null');
    const mixed = P(exportRows(3, { over: { 1: { 'Received Date & Time': 46310 }, 2: { 'Received Date & Time': '15/10/2026' } } }));
    eq(mixed.rows.map((r) => [r[1], r[16]]), [['2026-10-15', '24'], ['2026-10-15', '24'], ['2026-10-04', '35']], 'derive: serial and dd/mm/yyyy received dates normalised to yyyy-mm-dd');

    // Blocks.
    const codes = (p) => p.blocks.map((b) => b.code);
    eq(codes(CU.parseExport(Buffer.from('%PDF-1.4'), 'register.pdf', { now: NOW })), ['type'], 'block: a .pdf is the wrong type');
    const xls = CU.parseExport(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]), 'register.xls', { now: NOW });
    ok(codes(xls)[0] === 'type' && /save it as \.xlsx or \.csv/.test(xls.blocks[0].message), 'block: the old binary .xls, with what to do');
    const big = CU.parseExport(Buffer.alloc(CU.LIMITS.maxBytes + 1, 0x41), 'big.csv', { now: NOW });
    ok(codes(big)[0] === 'too_large' && /10 MB/.test(big.blocks[0].message), 'block: larger than 10 MB');
    const noAssign = P(exportRows(3, { header: PORTAL.map((h) => (h === 'Assign To' ? 'Assigned' : h)) }));
    eq(noAssign.blocks.map((b) => b.message), ["The file is missing the column 'Assign To'."], "block: missing column, in plain words (\"The file is missing the column 'Assign To'.\")");
    const notIt = CU.parseExport(Buffer.from('a,b,c\n1,2,3\n'), 'other.csv', { now: NOW });
    ok(codes(notIt)[0] === 'no_header' && /does not look like the CMO grievance register/.test(notIt.blocks[0].message), 'block: a file without the portal header');
    eq(codes(P(exportRows(0))), ['no_rows'], 'block: header but 0 grievances');
    const badDates = {};
    for (let i = 1; i <= 2; i++) badDates[i] = { 'Received Date & Time': 'not a date' };
    badDates[3] = { 'Received Date & Time': '2026-12-25' }; // future
    const bad = P(exportRows(40, { over: badDates }));
    ok(codes(bad)[0] === 'bad_rows' && /3 of 40 rows \(7.5%\)/.test(bad.blocks[0].message), 'block: over 5% unreadable or future received dates');
    const noDist = {};
    for (let i = 1; i <= 3; i++) noDist[i] = { District: '' };
    eq(codes(P(exportRows(40, { over: noDist }))), ['bad_rows'], 'block: over 5% without a district');
    const oneBad = P(exportRows(40, { over: { 7: { 'Received Date & Time': '2026-12-25' } } }));
    ok(oneBad.blocks.length === 0 && oneBad.warnings.some((w) => w.code === 'bad_rows' && /\(row 11\)/.test(w.message)) && oneBad.rows[6][16] === '', 'warn: under 5% bad rows is a warning; their Grievance Since is blank');
    const many = [PORTAL];
    const one = portalRow(1).map((v) => String(v).replace(/\n/g, ' '));
    for (let i = 0; i <= CU.LIMITS.maxRows; i++) many.push(one);
    const tooMany = CU.parseExport(Buffer.from(csvOf(many)), 'huge.csv', { now: NOW });
    ok(codes(tooMany).includes('too_many_rows') && tooMany.rows.length === 0, 'block: more than 20,000 rows');

    // Warnings.
    const wcodes = (p) => p.warnings.map((w) => w.code);
    const unk = P(exportRows(6, { over: { 1: { District: 'Elsewhere' }, 2: { Status: 'Reopened' } } }));
    ok(wcodes(unk).includes('unknown_district') && /'Elsewhere' \(1\)/.test(unk.warnings.find((w) => w.code === 'unknown_district').message), 'warn: unknown district, named with its count');
    ok(wcodes(unk).includes('unknown_status') && /'Reopened' \(1\)/.test(unk.warnings.find((w) => w.code === 'unknown_status').message), 'warn: unknown status');
    const dupRows = exportRows(5);
    dupRows.push([6].concat(portalRow(2)));
    const dup = P(dupRows);
    ok(wcodes(dup).includes('duplicates') && /: row 10\./.test(dup.warnings.find((w) => w.code === 'duplicates').message), 'warn: an exact repeat of an earlier row');
    eq(new Set(dup.keys).size, 6, 'diff keys: a repeated grievance gets its own key (":1")');
    const sameText = P(exportRows(3, { over: { 3: { 'Grievance Description': 'Synthetic grievance text number 1', 'Applicant Name & Mobile Number': `${fakeName(1)}\n${fakePhone(1)}`, 'Received Date & Time': '2026-10-02', 'Last ATN': 'Other' } } }));
    ok(!wcodes(sameText).includes('duplicates'), 'warn: same applicant/date/text but other cells differ is not an exact duplicate');
    const oldTitle = P(exportRows(3, { title: 'REGISTERD GRIEVANCE LIST AS ON 03-11-2026' }));
    ok(wcodes(oldTitle).includes('title_date') && /5 days before today/.test(oldTitle.warnings[0].message), 'warn: the title date is more than 2 days from the upload date');
    ok(!wcodes(P(exportRows(3, { title: 'REGISTERD GRIEVANCE LIST AS ON 06-11-2026' }))).includes('title_date'), 'warn: a title date 2 days old is fine');
    ok(wcodes(P(exportRows(3, { title: null }))).includes('title_date'), 'warn: no AS ON title');
    const noMob = P(exportRows(3, { over: { 2: { 'Applicant Name & Mobile Number': 'Test Person Without Number' } } }));
    ok(wcodes(noMob).includes('no_mobile') && noMob.rows[1][13] === '' && noMob.rows[1][12] === 'Test Person Without Number', 'warn: an applicant without a mobile; Phone blank');

    // The comparison with the list now served.
    const prev = P(exportRows(10));
    const current = CU.readSnapshotRows(CU.toCsv(prev.header, prev.rows));
    eq(current.length, 10, 'csv: the snapshot CSV reads back');
    const next = P(exportRows(5, { over: { 1: { Status: 'Disposed', 'Assign To': 'N/A' } } }).concat([[6].concat(portalRow(77))]));
    const rv = CU.review(next, current);
    eq([rv.diff.added, rv.diff.removed, rv.diff.statusChanged], [1, 5, 1], 'diff: new, no longer listed and status changes by grievance key');
    eq(rv.diff.statusMoves, [{ from: 'ATR Submitted to CMO', to: 'Disposed', count: 1 }], 'diff: status moves counted');
    ok(rv.warnings[0].code === 'row_drop' && /30%|fewer than the 10 now shown/.test(rv.warnings[0].message), 'warn: more than 30% fewer rows than the list now served');
    ok(!CU.review(P(exportRows(8)), current).warnings.some((w) => w.code === 'row_drop'), 'warn: 20% fewer rows is fine');
    eq(CU.review(prev, null).diff, null, 'diff: none when there is no list yet');
    const csv = CU.toCsv(prev.header, prev.rows);
    ok(csv.startsWith('Applicant Name & Mobile Number,Received Date & Time,Block/ Municipality,') && csv.includes(`"${fakeName(1)}\n${fakePhone(1)}"`), 'csv: header as the snapshot, line breaks quoted');
    const uniform = require(path.join(ROOT, 'lib', 'uniform.js'));
    const built = uniform.build(csv, { key: 'cmo_grievances', format: 'csv', schema: JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'cmo_grievances.json'), 'utf8')) });
    const col = (name) => built.columns.findIndex((c) => c.name === name);
    const urow = built.rows[2];
    ok(built.issues.every((i) => i.check !== 'header.missing') && built.columns.slice(0, 17).every((c) => c.source_name) &&
        urow[col('pending_with')] === 'Officer Zed' && urow[col('grievance_since')] === 35 && urow[col('district')] === 'Malda' && urow[col('report_date')] === '2026-11-08',
        'uniform: the schema reads every column (pending_with, grievance_since, district)');

    // The worker.
    const iso = await CU.parseExportIsolated(makeXlsx(exportRows(12)), 'r.xlsx', { now: NOW });
    eq(iso.rows, base.rows, 'worker: the same result in a worker thread');
    await assert.rejects(CU.parseExportIsolated(makeXlsx(exportRows(12)), 'r.xlsx', { now: NOW, timeoutMs: 1 }), /took too long/);
    passed++; console.log('  ok  worker: time limit');

    // The real export, aggregates only, when this machine has it (never in CI, never committed).
    if (fs.existsSync(REAL)) {
        const real = CU.parseExport(fs.readFileSync(REAL), path.basename(REAL), { now: Date.parse('2026-11-08T06:00:00Z') });
        eq(real.blocks.map((b) => b.code), [], 'real sample: accepted');
        eq([real.stats.total, real.stats.pendingMzo], [304, 19], 'real sample: 304 grievances, 19 pending with an MZO officer');
        eq(real.stats.byDistrict, { 'Dakshin Dinajpur': 84, 'Uttar Dinajpur': 84, Malda: 134, 'Not Known': 2 }, 'real sample: district counts');
    } else {
        console.log('  --  real sample not on this machine: skipped');
    }
}

// ---- Server ----------------------------------------------------------------------------------------
async function server() {
    const forgeSession = (profile, expiry) => {
        const payload = Buffer.from(JSON.stringify({ profile, expiry })).toString('base64');
        return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64');
    };
    const cookieOf = (v) => `mzo_session=${encodeURIComponent(v)}`;
    const HOUR = 3600e3;
    const admin = cookieOf(forgeSession({ Username: 'boss', Name: 'Boss Admin', email: 'boss@example.com', role: 'admin' }, Date.now() + HOUR));
    const admin2 = cookieOf(forgeSession({ Username: 'chief', Name: 'Chief Admin', role: 'admin' }, Date.now() + HOUR));
    const flagged = cookieOf(forgeSession({ Username: 'clerk1', Name: 'Clerk One', role: 'viewer', 'cmo-upload-autho': 'Y' }, Date.now() + HOUR));
    const viewer = cookieOf(forgeSession({ Username: 'viewer1', Name: 'Viewer', role: 'viewer', 'nsc-upload-autho': 'Y' }, Date.now() + HOUR));
    const dm1 = cookieOf(forgeSession({ Username: 'dm1', Name: 'Legacy', role: 'viewer' }, Date.now() + HOUR));

    // The Google copy the mirror serves before the first upload (no-data-gap): 9 synthetic rows.
    const CU = require(path.join(ROOT, 'lib', 'cmo_upload.js'));
    const seed = CU.parseExport(makeXlsx(exportRows(9)), 'seed.xlsx', { now: Date.parse('2026-11-01T06:00:00Z') });
    const seedCsv = CU.toCsv(seed.header, seed.rows);
    fs.writeFileSync(path.join(SNAPS, 'cmo_grievances.csv'), seedCsv);

    // The sync source: skipped (not wiped) until the first upload; the manifest keeps the Google copy.
    const filesSrc = require(path.join(ROOT, 'vm', 'sync', 'sources', 'files.js'));
    const before = (await filesSrc.sources()).find((s) => s.key === 'cmo_grievances');
    ok(before && /no CMO export uploaded yet/.test(before.skip || '') && before.holdBack === false && before.dataHubKeys[0] === 'CACHE_CMO', 'sync: the cmo_grievances file source skips while nothing was uploaded');
    const google = require(path.join(ROOT, 'vm', 'sync', 'sources', 'google.js'));
    ok(!(await google.sources()).some((s) => s.key === 'cmo_grievances'), 'sync: no Google source for cmo_grievances any more');
    const { syncSource } = require(path.join(ROOT, 'vm', 'sync', 'lib', 'sync.js'));
    const ds = { key: 'cmo_grievances', snapshot_file: 'cmo_grievances.csv', snapshot_sha1: crypto.createHash('sha1').update(seedCsv).digest('hex'), snapshot_bytes: seedCsv.length, row_count: 9, last_status: 'unchanged' };
    const saved = [];
    const registry = { get: () => ds, save: async (k, v) => { saved.push(v); Object.assign(ds, v); }, logRun: async () => {}, byKey: new Map([['cmo_grievances', ds]]) };
    const res = await syncSource(before, { pb: null, registry, tmpDir: TMP, batchSize: 10, snapshotDir: SNAPS, dryRun: false });
    ok(res.status === 'skipped' && saved.length === 1 && !('snapshot_file' in saved[0]) && fs.readFileSync(path.join(SNAPS, 'cmo_grievances.csv'), 'utf8') === seedCsv, 'sync: a skip keeps the snapshot and its registry fields');
    const { writeManifest } = require(path.join(ROOT, 'vm', 'sync', 'lib', 'snapshot.js'));
    const man = writeManifest(SNAPS, [before], registry);
    const entry = man.datasets.cmo_grievances;
    ok(entry && entry.file === 'cmo_grievances.csv' && entry.rows === 9 && entry.urls[0] === '/api/cmo/dataset' && entry.dataHubKeys[0] === 'CACHE_CMO', 'sync: the manifest still lists the Google copy, now under /api/cmo/dataset');

    // Upstream: GETs answer [], writes are refused and recorded. The mirror's write-through sync is recorded.
    const realFetch = global.fetch;
    const writes = [];
    global.fetch = async (input, opts) => {
        const url = String(input && input.url ? input.url : input);
        const method = String((opts && opts.method) || 'GET').toUpperCase();
        if (url.startsWith('http://127.0.0.1:')) return realFetch(input, opts);
        if (method !== 'GET' && method !== 'HEAD') { writes.push({ url, body: opts && opts.body ? String(opts.body) : '' }); return new Response('{"message":"write refused by the test"}', { status: 599 }); }
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const spawned = [];
    const realSpawn = childProcess.spawn;
    childProcess.spawn = (cmd, args) => {
        spawned.push(args.join(' '));
        const child = new EventEmitter();
        child.pid = 0; child.unref = () => {}; child.kill = () => {};
        setTimeout(() => child.emit('exit', 0, null), 5);
        return child;
    };
    const logs = [];
    const keep = { log: console.log, warn: console.warn, error: console.error };
    const tap = (k) => (...a) => { logs.push(a.map(String).join(' ')); keep[k](...a); };
    const app = require(path.join(ROOT, 'server.js'));
    childProcess.spawn = realSpawn;
    const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    console.error = tap('error'); console.warn = tap('warn'); console.log = tap('log');
    const call = async (method, p, { cookie, origin, body, json } = {}) => {
        const headers = { Accept: 'application/json' };
        if (origin === undefined && method !== 'GET') headers.Origin = base;
        else if (origin) headers.Origin = origin;
        if (cookie) headers.Cookie = cookie;
        let payload = body;
        if (json !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
        const r = await realFetch(base + p, { method, headers, body: payload, redirect: 'manual' });
        const text = await r.text();
        let data = null;
        try { data = JSON.parse(text); } catch (_) { /* not JSON */ }
        return { status: r.status, text, data, h: (n) => r.headers.get(n) };
    };
    const form = (buf, name) => { const fd = new FormData(); fd.append('file', new Blob([buf]), name); return fd; };
    const xlsxForm = (rows, name = 'GRIEVANCE_REGISTER.xlsx') => form(makeXlsx(rows), name);
    const preview = (cookie, rows, opts) => call('POST', '/api/cmo/upload/preview', Object.assign({ cookie, body: xlsxForm(rows) }, opts || {}));
    const commit = (cookie, token, confirmWarnings) => call('POST', '/api/cmo/upload/commit', { cookie, json: { token, confirmWarnings } });
    const versions = () => { try { return fs.readdirSync(path.join(FILES, 'cmo_versions')).filter((f) => f.endsWith('.csv')).length; } catch (_) { return 0; } };
    const stored = () => fs.readFileSync(path.join(FILES, 'cmo_grievances.csv'), 'utf8');

    try {
        // Before the first upload: the page keeps the Google copy (no data gap).
        const ds0 = await call('GET', '/api/cmo/dataset', { cookie: viewer });
        ok(ds0.status === 200 && ds0.text === seedCsv && /private/.test(ds0.h('cache-control') || ''), 'no gap: /api/cmo/dataset serves the mirror snapshot before any upload');
        eq((await call('GET', '/api/cmo/dataset')).status, 401, 'dataset: 401 without a session');
        fs.renameSync(path.join(SNAPS, 'cmo_grievances.csv'), path.join(SNAPS, 'held.csv'));
        const ds302 = await call('GET', '/api/cmo/dataset', { cookie: viewer });
        ok(ds302.status === 302 && /docs\.google\.com/.test(ds302.h('location') || ''), 'dataset: no upload and no snapshot (Vercel, local) -> the old published sheet');
        fs.renameSync(path.join(SNAPS, 'held.csv'), path.join(SNAPS, 'cmo_grievances.csv'));

        // Meta and who may.
        eq((await call('GET', '/api/cmo/upload/meta')).status, 401, 'meta: 401 without a session');
        const mV = await call('GET', '/api/cmo/upload/meta', { cookie: viewer });
        ok(mV.status === 200 && mV.data.canUpload === false && mV.data.canUndo === false && mV.data.source === 'snapshot' && mV.data.last === null, 'meta: a viewer (even with other upload flags) may not upload');
        ok((await call('GET', '/api/cmo/upload/meta', { cookie: dm1 })).data.canUpload === false, 'meta: the legacy dm1 account gets no CMO upload');
        ok((await call('GET', '/api/cmo/upload/meta', { cookie: admin })).data.canUpload === true, 'meta: an admin may upload');
        ok((await call('GET', '/api/cmo/upload/meta', { cookie: flagged })).data.canUpload === true, 'meta: a user with cmo-upload-autho may upload');
        ok(/no-store/.test(mV.h('cache-control') || ''), 'meta: no-store');

        // Preview: permissions, Origin, blocks.
        eq((await preview(viewer, exportRows(10))).status, 403, 'preview: a viewer gets 403');
        eq((await preview(null, exportRows(10))).status, 401, 'preview: 401 without a session');
        eq((await preview(admin, exportRows(10), { origin: null })).status, 403, 'preview: a POST without Origin is refused (global Origin check)');
        eq((await preview(admin, exportRows(10), { origin: 'https://evil.example' })).status, 403, 'preview: a POST from another site is refused');
        const pXls = await call('POST', '/api/cmo/upload/preview', { cookie: admin, body: form(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2]), 'old.xls') });
        ok(pXls.status === 422 && pXls.data.status === 'blocked' && /\.xlsx or \.csv/.test(pXls.data.blocks[0].message), 'preview: the old .xls is blocked with a message');
        const pBig = await call('POST', '/api/cmo/upload/preview', { cookie: admin, body: form(Buffer.alloc(10 * 1024 * 1024 + 10, 0x41), 'big.csv') });
        ok(pBig.status === 413 && /10 MB/.test(pBig.data.blocks[0].message), 'preview: over 10 MB is blocked (413)');
        const pMiss = await preview(admin, exportRows(5, { header: PORTAL.filter((h) => h !== 'District') }));
        eq(pMiss.data.blocks.map((b) => b.message), ["The file is missing the column 'District'."], 'preview: a missing column is blocked in plain words');
        ok(!fs.existsSync(path.join(FILES, 'cmo_grievances.csv')), 'preview: nothing written by previews');

        // Preview against the Google copy, then commit (flag user).
        const p1 = await preview(flagged, exportRows(12));
        ok(p1.status === 200 && p1.data.token && p1.data.summary.total === 12 && p1.data.summary.pendingMzo === 6, 'preview: a flag user gets a summary and a token');
        eq([p1.data.diff.currentRows, p1.data.diff.added, p1.data.diff.removed], [9, 3, 0], 'preview: compared with the Google copy (9 now, 3 new)');
        eq(p1.data.summary.byDistrict, { 'Uttar Dinajpur': 4, 'Dakshin Dinajpur': 4, Malda: 4 }, 'preview: counts by district');
        ok(p1.data.diff.statusChanged === 0 && p1.data.warnings.length === 0, 'preview: no status changes and no warnings');
        eq((await commit(admin, p1.data.token, [])).status, 403, 'commit: a token made by another user is refused');
        eq((await commit(viewer, p1.data.token, [])).status, 403, 'commit: a viewer is refused');
        eq((await commit(flagged, 'made-up-token', [])).status, 410, 'commit: an unknown token is refused (410)');
        eq((await call('POST', '/api/cmo/upload/commit', { cookie: flagged, origin: null, json: { token: p1.data.token } })).status, 403, 'commit: without Origin refused');
        const c1 = await commit(flagged, p1.data.token, []);
        ok(c1.status === 200 && c1.data.status === 'success' && c1.data.last.rows === 12 && c1.data.last.by === 'Clerk One', 'commit: the list is replaced');
        eq((await commit(flagged, p1.data.token, [])).status, 410, 'commit: a token works once');
        const csv1 = stored();
        ok(csv1.split('\r\n')[0] === CU.SNAPSHOT_HEADER.join(','), 'storage: the CSV has the 17-column header');
        eq((fs.statSync(path.join(FILES, 'cmo_grievances.csv')).mode & 0o777).toString(8), '600', 'storage: written atomically, mode 600');
        ok(fs.readdirSync(FILES).every((f) => !f.endsWith('.tmp')), 'storage: no temp files left, no raw upload kept');
        ok(!fs.readdirSync(FILES).some((f) => /\.xlsx$/i.test(f)), 'storage: the uploaded file itself is not kept');
        eq(versions(), 1, 'storage: the Google copy kept as the first version (undo goes back to it)');
        const meta1 = JSON.parse(fs.readFileSync(path.join(FILES, 'cmo_grievances_meta.json'), 'utf8'));
        ok(/^[0-9a-f]{64}$/.test(meta1.fileSha256) && meta1.rows === 12 && meta1.by === 'clerk1', 'storage: meta with uploader, rows and file sha256');
        await new Promise((r) => setTimeout(r, 2300)); // the write-through is debounced 2 s
        ok(spawned.some((a) => /run\.js --only cmo_grievances --reason .*cmo upload by clerk1.* --now$/.test(a)), 'mirror: commit starts the write-through sync of cmo_grievances with --now (rating at once)');
        const filesAfter = (await filesSrc.sources()).find((s) => s.key === 'cmo_grievances');
        ok(!filesAfter.skip && /^sha1:/.test(await filesAfter.version()), 'sync: after the first upload the file source reads the uploaded file');
        const srcRows = [];
        for await (const r of filesAfter.rows({ input: fs.createReadStream(path.join(FILES, 'cmo_grievances.csv')) })) srcRows.push(r);
        ok(srcRows.length === 13 && srcRows[0][16] === 'Grievance Since', 'sync: the file source yields the header and 12 rows');
        const ds1 = await call('GET', '/api/cmo/dataset', { cookie: viewer });
        ok(ds1.status === 200 && ds1.text === csv1, 'dataset: serves the uploaded list');
        const m1 = await call('GET', '/api/cmo/upload/meta', { cookie: viewer });
        ok(m1.data.source === 'upload' && m1.data.last.rows === 12 && m1.data.last.by === 'Clerk One' && m1.data.canUndo === false, 'meta: last upload shown; no undo for a viewer');
        ok((await call('GET', '/api/cmo/upload/meta', { cookie: flagged })).data.canUndo === false, 'meta: no undo for a flag user (admins only)');
        ok((await call('GET', '/api/cmo/upload/meta', { cookie: admin })).data.canUndo === true, 'meta: undo offered to an admin');

        // Warnings must be confirmed.
        const p2 = await preview(admin, exportRows(7, { title: 'REGISTERD GRIEVANCE LIST AS ON 01-11-2026', over: { 1: { Status: 'Disposed', 'Assign To': 'N/A' }, 2: { District: 'Elsewhere' } } }));
        eq(p2.data.warnings.map((w) => w.code).sort(), ['row_drop', 'title_date', 'unknown_district'], 'preview: warnings for 42% fewer rows, an old title date, an unknown district');
        eq([p2.data.diff.added, p2.data.diff.removed, p2.data.diff.statusChanged], [0, 5, 1], 'preview: 5 no longer listed, 1 status change');
        const c2a = await commit(admin, p2.data.token, ['row_drop']);
        ok(c2a.status === 409 && c2a.data.status === 'confirm' && c2a.data.missing.length === 2, 'commit: refused until every warning is ticked');
        const c2 = await commit(admin, p2.data.token, ['row_drop', 'title_date', 'unknown_district']);
        ok(c2.status === 200 && stored().split('\r\n').length === 9, 'commit: accepted with every warning confirmed');
        eq(versions(), 2, 'storage: 2 versions kept');

        // The list changed after a preview -> that preview cannot commit.
        const pA = await preview(admin, exportRows(8));
        const pB = await preview(admin2, exportRows(9));
        eq((await commit(admin2, pB.data.token, pB.data.warnings.map((w) => w.code))).status, 200, 'commit: a second admin commits first');
        const stale = await commit(admin, pA.data.token, pA.data.warnings.map((w) => w.code));
        ok(stale.status === 409 && /changed after this preview/.test(stale.data.message), 'commit: a preview made before another commit is refused');

        // One upload at a time: a preview whose body is still arriving holds the lock.
        let release;
        const gate = new Promise((r) => { release = r; });
        const boundary = '----cmotest' + Date.now();
        const xl = makeXlsx(exportRows(5));
        const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`);
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
        const slowBody = new ReadableStream({
            async start(ctl) { ctl.enqueue(new Uint8Array(head)); await gate; ctl.enqueue(new Uint8Array(xl)); ctl.enqueue(new Uint8Array(tail)); ctl.close(); }
        });
        const slow = realFetch(base + '/api/cmo/upload/preview', { method: 'POST', duplex: 'half', body: slowBody,
            headers: { Origin: base, Cookie: admin, Accept: 'application/json', 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
        await new Promise((r) => setTimeout(r, 150));
        const busy = await preview(admin2, exportRows(5));
        ok(busy.status === 429 && /Another CMO upload/.test(busy.data.message), 'lock: a second upload while one is in progress gets 429');
        const busyUndo = await call('POST', '/api/cmo/upload/undo', { cookie: admin, json: {} });
        eq(busyUndo.status, 429, 'lock: undo waits for the running upload too');
        release();
        eq((await slow).status, 200, 'lock: the first upload finishes');
        eq((await preview(admin2, exportRows(5))).status, 200, 'lock: released afterwards');

        // Undo: admins only, back through the versions to the Google copy, then nothing left.
        eq((await call('POST', '/api/cmo/upload/undo', { cookie: flagged, json: {} })).status, 403, 'undo: a flag user may not undo');
        eq((await call('POST', '/api/cmo/upload/undo', { cookie: viewer, json: {} })).status, 403, 'undo: a viewer may not undo');
        eq((await call('POST', '/api/cmo/upload/undo', { cookie: admin, origin: null, json: {} })).status, 403, 'undo: without Origin refused');
        const u1 = await call('POST', '/api/cmo/upload/undo', { cookie: admin, json: {} });
        ok(u1.status === 200 && stored().split('\r\n').length === 9 && u1.data.last.action === 'undo', 'undo: back to the previous list (7 rows)');
        const u2 = await call('POST', '/api/cmo/upload/undo', { cookie: admin, json: {} });
        ok(u2.status === 200 && stored() === csv1, 'undo: again, back to the first upload');
        const u3 = await call('POST', '/api/cmo/upload/undo', { cookie: admin, json: {} });
        ok(u3.status === 200 && stored() === seedCsv, 'undo: and back to the Google copy');
        const u4 = await call('POST', '/api/cmo/upload/undo', { cookie: admin, json: {} });
        ok(u4.status === 409 && /no earlier version/.test(u4.data.message), 'undo: nothing left to undo');

        // Five versions kept.
        for (let n = 0; n < 7; n++) {
            const p = await preview(admin, exportRows(9 + n));
            eq((await commit(admin, p.data.token, p.data.warnings.map((w) => w.code))).status, 200, `commit: upload ${n + 1} of 7 in a row`);
        }
        eq(versions(), 5, 'storage: only the previous 5 versions are kept');

        // The audit trail and the logs: who, when, rows, sha256, warnings; never names or mobiles.
        const audit = fs.readFileSync(path.join(FILES, 'cmo_upload_audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        const firstWarned = audit.find((a) => a.warningsAccepted && a.warningsAccepted.length);
        ok(audit.length === 13 && audit[0].action === 'upload' && audit[0].by === 'clerk1' && /^[0-9a-f]{64}$/.test(audit[0].fileSha256) && audit[0].rows === 12, 'audit: one line per commit and undo, with who, rows and file sha256');
        eq(firstWarned.warningsAccepted.sort(), ['row_drop', 'title_date', 'unknown_district'], 'audit: the warnings accepted');
        const allText = fs.readFileSync(path.join(FILES, 'cmo_upload_audit.jsonl'), 'utf8') + fs.readFileSync(path.join(FILES, 'cmo_grievances_meta.json'), 'utf8') +
            logs.join('\n') + writes.map((w) => w.body).join('\n');
        ok(!/Test Person|90000000\d\d|Synthetic grievance|Synthetic remark/.test(allText), 'privacy: no applicant names, mobiles or grievance text in the audit, meta, logs or activity log');
        ok(writes.length > 0 && writes.every((w) => /activity_logs/.test(w.url)), 'upstream: the only writes are activity log rows (refused here)');
        ok(writes.some((w) => /Uploaded CMO grievances: 12 rows \(6 pending with MZO officers\)/.test(w.body)), 'activity log: counts only');
    } finally {
        console.error = keep.error; console.warn = keep.warn; console.log = keep.log;
        srv.close();
    }
}

// ---- The flag in the user store --------------------------------------------------------------------
function flags() {
    const US = require(path.join(ROOT, 'lib', 'users_store.js'));
    ok(US.FLAG_KEYS.includes('cmo_upload_autho') && US.UPLOAD_FLAGS.cmo === 'cmo_upload_autho', 'users: cmo_upload_autho is a grantable flag (upload_permissions word "cmo")');
    const adminP = US.toProfile({ id: 'a', username: 'a', role: 'admin', status: 'active', feature_flags: {} });
    const userP = US.toProfile({ id: 'b', username: 'b', role: 'viewer', status: 'active', scope_level: 'zone', feature_flags: { cmo_upload_autho: 'Y' } });
    const plainP = US.toProfile({ id: 'c', username: 'c', role: 'viewer', status: 'active', scope_level: 'zone', feature_flags: {} });
    ok(adminP['cmo-upload-autho'] === 'Y' && userP['cmo-upload-autho'] === 'Y' && userP.upload_permissions.includes('cmo') && plainP['cmo-upload-autho'] === '', 'users: admins carry it; a granted user carries it as cmo-upload-autho');
}

(async () => {
    try {
        await unit();
        flags();
        await server();
        console.log(`\nCMO upload: ${passed} checks passed`);
        fs.rmSync(TMP, { recursive: true, force: true });
        process.exit(0);
    } catch (err) {
        console.error('FAIL:', err && err.stack || err);
        fs.rmSync(TMP, { recursive: true, force: true });
        process.exit(1);
    }
})();
