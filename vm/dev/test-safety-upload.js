#!/usr/bin/env node
'use strict';
// Test of the Safety Inspection upload (POST /api/safety/upload) and its bookmarklet token, with no network:
// upstream GETs get an empty JSON list, other upstream requests are refused and recorded.
//
//   node vm/dev/test-safety-upload.js
//
// Checks: /api/safety/meta never returns the session, and gives a short-lived upload token ("sut1.")
// only to a user who may upload and only from a cookie session; the token works only on the upload route,
// only from an allowed origin (SAFETY_UPLOAD_ORIGINS), and stops at its expiry or the session's; a session
// is never accepted as a Bearer token there; CORS answers only allowed origins and never allows
// credentials; the report is read from .xlsx (lib/xlsx_lite.js, no xlsx package), CSV or an HTML table,
// in a worker with limits, and stored as canonical CSV; /api/safety/dataset needs a session and is
// private; the safety meta is never fetched from Supabase; the admin sync schedules are validated.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const SECRET = 'test-secret-for-safety-upload';
const FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-safety-'));
const ALLOWED = 'https://safetyinsp.wbsedcl.in';
const EVIL = 'https://evil.example';
const HEADERS = ['Inspection ID', 'Site ID', 'Inspection By', 'Office', 'Location', 'Description', 'Inspected on',
    'Entered on', 'Rectification done by', 'Rectification done on', 'Remarks', 'Status', 'Image'];

process.env.JWT_SECRET = SECRET;
process.env.MZO_FILES_DIR = FILES;
delete process.env.SAFETY_UPLOAD_ORIGINS;
delete process.env.MZO_USER_STORE;
delete process.env.MZO_DATA_MODE;

let passed = 0;
function ok(cond, label) { assert.ok(cond, label); passed++; console.log('  ok  ' + label); }
function eq(a, b, label) { assert.deepStrictEqual(a, b, label); passed++; console.log('  ok  ' + label); }

// ---- Fixtures ------------------------------------------------------------------------------------
const forgeSession = (profile, expiry) => {
    const payload = Buffer.from(JSON.stringify({ profile, expiry })).toString('base64');
    return { payload, value: payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64') };
};
const cookieOf = (s) => `mzo_session=${encodeURIComponent(s.value)}`;
const HOUR = 3600e3;
const admin = forgeSession({ Username: 'boss', Name: 'Boss', email: 'boss@example.com', role: 'admin' }, Date.now() + HOUR);
const syncer = forgeSession({ Username: 'syncer', Name: 'Syncer', role: 'viewer', 'safety-sync-autho': 'Y' }, Date.now() + HOUR);
const viewer = forgeSession({ Username: 'clerk', Name: 'Clerk', role: 'viewer', office_level: 'CCC', ccc_code: '6611108' }, Date.now() + HOUR);
const expiredAdmin = forgeSession({ Username: 'boss', Name: 'Boss', role: 'admin' }, Date.now() - 1000);

/** A token as the server makes it (same derivation), for the cases the server would never issue. */
function handToken(sessionPayload, { scope = 'safety-upload', exp = Date.now() + 60e3 } = {}) {
    const key = crypto.createHmac('sha256', SECRET).update('mzo:scoped-upload-token:v1').digest();
    const body = Buffer.from(JSON.stringify({ s: scope, exp, sp: sessionPayload })).toString('base64url');
    return `sut1.${body}.${crypto.createHmac('sha256', key).update('sut1.' + body).digest('base64url')}`;
}

/** A minimal .xlsx (stored or deflated zip parts, inline strings and numbers). */
function makeXlsx(rows, { inflate = true, extra = {} } = {}) {
    const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const col = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
    const sheet = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => {
            const ref = col(ci) + (ri + 1);
            if (v === '' || v == null) return '';
            return typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
        }).join('') + '</row>').join('') + '</sheetData></worksheet>';
    const parts = Object.assign({
        '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
        'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId7"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships><Relationship Id="rId7" Type="worksheet" Target="worksheets/report.xml"/></Relationships>',
        'xl/worksheets/report.xml': sheet
    }, extra);
    const locals = [];
    const central = [];
    let offset = 0;
    for (const [name, content] of Object.entries(parts)) {
        const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        const data = inflate ? zlib.deflateRawSync(raw) : raw;
        const nameBuf = Buffer.from(name, 'utf8');
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(inflate ? 8 : 0, 8);
        lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(inflate ? 8 : 0, 10);
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

const REPORT_ROWS = [
    ['Inspection_detail_report'],
    HEADERS,
    ['1001', 'S-1', 'JE A & B', 'Malda CCC (6611108)', 'Loc <1>', 'Pole "leaning"', 45000, 45001.25, '', '', 'ok', 'Open', ''],
    ['1001', 'S-2', 'JE A', 'Malda CCC (6611108)', 'Loc 2', 'Earthing', 45000, 45001, 'AE', 45010, 'done', 'Closed', ''],
    ['1002', 'S-3', 'JE C', 'Other CCC (5511101)', 'Loc 3', 'Guard wire', '12-03-2025', '13-03-2025', '', '', '', 'Open', ''],
    ['', '', '', '', '', '', '', '', '', '', '', '', '']
];
const CSV_TEXT = HEADERS.join(',') + '\n' +
    '2001,S-9,JE D,"Gazole CCC (6612201)","Loc, with comma",Desc,01-02-2025,02-02-2025,,,,Open,\n' +
    '2002,S-10,JE E,Elsewhere (4411101),Loc,Desc,01-02-2025,02-02-2025,,,,Open,\n';

// ---- Unit: the xlsx reader and the parser --------------------------------------------------------
async function unit() {
    const XL = require(path.join(ROOT, 'lib', 'xlsx_lite.js'));
    const SP = require(path.join(ROOT, 'lib', 'safety_parser.js'));
    const rows = XL.firstSheetRows(makeXlsx(REPORT_ROWS));
    eq(rows[1], HEADERS, 'xlsx: the header row through the workbook relationship (not sheet1.xml)');
    eq(rows[2][4], 'Loc <1>', 'xlsx: XML entities decoded');
    eq(rows[2][6], 45000, 'xlsx: numbers stay numbers');
    eq(XL.firstSheetRows(makeXlsx(REPORT_ROWS, { inflate: false }))[3][1], 'S-2', 'xlsx: stored (uncompressed) parts read too');
    const shared = makeXlsx([], { extra: {
        'xl/sharedStrings.xml': '<sst><si><t>Inspection ID</t></si><si><r><t>Of</t></r><r><t xml:space="preserve">fice</t></r><rPh><t>x</t></rPh></si></sst>',
        'xl/worksheets/report.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="3"><c r="B3" t="b"><v>1</v></c></row></sheetData></worksheet>'
    } });
    eq(XL.firstSheetRows(shared), [['Inspection ID', '', 'Office'], [], ['', true]], 'xlsx: shared and rich strings (no phonetic runs), gaps, booleans');

    const bomb = makeXlsx([], { extra: { 'xl/worksheets/report.xml': Buffer.alloc(4 * 1024 * 1024, 0x20) } });
    assert.throws(() => XL.firstSheetRows(bomb, { maxBytes: 1024 * 1024 }), /too large once unpacked/);
    passed++; console.log('  ok  xlsx: a part that inflates past the cap is refused (zip bomb)');
    assert.throws(() => XL.firstSheetRows(Buffer.from('PK\u0003\u0004 not really a zip')), /Not an \.xlsx file|damaged/);
    passed++; console.log('  ok  xlsx: a damaged zip is refused with a message');

    const parsed = SP.parseSafetyReport(makeXlsx(REPORT_ROWS), 'r.xlsx');
    eq([parsed.totalRows, parsed.mzoRows], [3, 2], 'parser: rows and Malda Zone rows counted, blank rows skipped');
    const lines = parsed.csv.trim().split('\n');
    eq(lines[0], HEADERS.map((h) => `"${h}"`).join(','), 'parser: canonical header');
    ok(lines[1].includes('"15-03-2023","16-03-2023"') && lines[2].includes('"25-03-2023"'), 'parser: Excel date serials written as DD-MM-YYYY');
    ok(lines[1].includes('"Pole ""leaning"""'), 'parser: quotes doubled');
    const reordered = SP.parseSafetyReport(Buffer.from('Office,Inspection ID,Status\n"X (6611108)",77,Open\n'), 'r.csv');
    ok(reordered.csv.split('\n')[1].startsWith('"77","","","X (6611108)"'), 'parser: CSV columns matched by header name');
    const html = '<html><body><table><tr><th>Inspection ID</th><th>Site ID</th><th>Inspection By</th><th>Office</th></tr>' +
        '<tr><td>9</td><td>S&amp;9</td><td>A<br>B</td><td>M (6611108)</td></tr></table></body></html>';
    const fromHtml = SP.parseSafetyReport(Buffer.from(html), 'r.xls');
    ok(fromHtml.totalRows === 1 && fromHtml.csv.includes('"9","S&9","A B","M (6611108)"'), 'parser: an HTML-table ".xls" export is read');
    assert.throws(() => SP.parseSafetyReport(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]), 'old.xls'), /save it as \.xlsx or \.csv/);
    passed++; console.log('  ok  parser: the old binary .xls is refused with a message');
    assert.throws(() => SP.parseSafetyReport(Buffer.from('a,b\n1,2\n'), 'x.csv'), /does not look like the Safety Inspection report/);
    passed++; console.log('  ok  parser: a file without the report header is refused');
    await assert.rejects(SP.parseSafetyReportIsolated(makeXlsx(REPORT_ROWS), 'r.xlsx', { timeoutMs: 1 }), /took too long/);
    passed++; console.log('  ok  parser: the worker has a time limit');
    const iso = await SP.parseSafetyReportIsolated(makeXlsx(REPORT_ROWS), 'r.xlsx');
    eq(iso.csv, parsed.csv, 'parser: the worker gives the same result');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    ok(!(pkg.dependencies || {}).xlsx, 'package.json: xlsx is not a production dependency');
}

// ---- Server --------------------------------------------------------------------------------------
async function server() {
    const realFetch = global.fetch;
    const upstream = [];
    const writes = [];
    global.fetch = async (input, opts) => {
        const url = String(input && input.url ? input.url : input);
        const method = String((opts && opts.method) || 'GET').toUpperCase();
        if (url.startsWith('http://127.0.0.1:')) return realFetch(input, opts);
        upstream.push(`${method} ${url.replace(/\?.*$/, '')}`);
        if (method !== 'GET' && method !== 'HEAD') writes.push({ url, body: opts && opts.body ? String(opts.body) : '' });
        if (method !== 'GET' && method !== 'HEAD') return new Response('{"message":"write refused by the test"}', { status: 599 });
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const app = require(path.join(ROOT, 'server.js'));
    const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const call = async (method, p, { cookie, origin, auth, body, json } = {}) => {
        const headers = { Accept: 'application/json' };
        if (origin === undefined && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.Origin = base;
        else if (origin) headers.Origin = origin;
        if (cookie) headers.Cookie = cookie;
        if (auth) headers.Authorization = auth;
        if (method === 'OPTIONS') { headers['Access-Control-Request-Method'] = 'POST'; headers['Access-Control-Request-Headers'] = 'authorization'; }
        let payload = body;
        if (json !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
        const res = await realFetch(base + p, { method, headers, body: payload, redirect: 'manual' });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch (_) { /* not JSON */ }
        return { status: res.status, text, data, h: (n) => res.headers.get(n) };
    };
    const form = (buf, name) => { const fd = new FormData(); fd.append('file', new Blob([buf]), name); return fd; };
    const csvForm = () => form(Buffer.from(CSV_TEXT), 'report.csv');

    try {
        // Meta: never the session; the upload token only for an uploader with a cookie session.
        const mAdmin = await call('GET', '/api/safety/meta', { cookie: cookieOf(admin) });
        eq(mAdmin.status, 200, 'meta: admin 200');
        ok(!('token' in mAdmin.data) && !mAdmin.text.includes(admin.payload.slice(0, 40)) && !mAdmin.text.includes(encodeURIComponent(admin.value).slice(0, 40)), 'meta: the session cookie is not in the response');
        ok(/^sut1\.[\w-]+\.[\w-]+$/.test(mAdmin.data.uploadToken || ''), 'meta: an upload token for an admin');
        const ttl = Date.parse(mAdmin.data.uploadTokenExpires) - Date.now();
        ok(ttl > 10 * 60e3 && ttl <= 15 * 60e3 + 5e3, 'meta: the upload token lasts about 15 minutes');
        ok(/private/.test(mAdmin.h('cache-control') || '') && /no-store/.test(mAdmin.h('cache-control') || ''), 'meta: private, no-store');
        const mSyncer = await call('GET', '/api/safety/meta', { cookie: cookieOf(syncer) });
        ok(mSyncer.data.canSync && /^sut1\./.test(mSyncer.data.uploadToken || ''), 'meta: an upload token for a user with safety-sync-autho');
        const mViewer = await call('GET', '/api/safety/meta', { cookie: cookieOf(viewer) });
        ok(mViewer.status === 200 && !mViewer.data.canSync && !mViewer.data.uploadToken, 'meta: no upload token for a viewer');
        const mBearer = await call('GET', '/api/safety/meta', { auth: 'Bearer ' + admin.value });
        ok(mBearer.status === 200 && !mBearer.data.uploadToken, 'meta: no upload token without a cookie session (Bearer session)');
        const mAnon = await call('GET', '/api/safety/meta');
        eq(mAnon.status, 401, 'meta: 401 without a session');
        const token = mAdmin.data.uploadToken;

        // CORS preflight: answered before the session check, allowed origins only, never with credentials.
        const preOk = await call('OPTIONS', '/api/safety/upload', { origin: ALLOWED });
        ok(preOk.status === 204 && preOk.h('access-control-allow-origin') === ALLOWED && /authorization/i.test(preOk.h('access-control-allow-headers') || ''), 'preflight: allowed origin answered');
        eq(preOk.h('access-control-allow-credentials'), null, 'preflight: no Access-Control-Allow-Credentials');
        const preEvil = await call('OPTIONS', '/api/safety/upload', { origin: EVIL });
        eq(preEvil.h('access-control-allow-origin'), null, 'preflight: another origin gets no CORS header');
        const preCase = await call('OPTIONS', '/API/Safety/Upload/', { origin: EVIL });
        eq(preCase.h('access-control-allow-origin'), null, 'preflight: path spelling does not matter');

        // The session is never an upload credential as a Bearer token.
        const sessBearerX = await call('POST', '/api/safety/upload', { origin: ALLOWED, auth: 'Bearer ' + admin.value, body: csvForm() });
        eq(sessBearerX.status, 403, 'upload: a session as Bearer from the safety site is refused (origin rule)');
        const sessBearerSame = await call('POST', '/api/safety/upload', { auth: 'Bearer ' + admin.value, body: csvForm() });
        eq(sessBearerSame.status, 401, 'upload: a session as Bearer is refused on this route even from the app');
        const sessBearerEvil = await call('POST', '/api/safety/upload', { origin: EVIL, auth: 'Bearer ' + admin.value, body: csvForm() });
        ok(sessBearerEvil.status === 403 && !sessBearerEvil.h('access-control-allow-origin'), 'upload: a session as Bearer from another site is refused, no CORS');

        // The token: only from an allowed origin.
        const tokEvil = await call('POST', '/api/safety/upload', { origin: EVIL, auth: 'Bearer ' + token, body: csvForm() });
        ok(tokEvil.status === 403 && !tokEvil.h('access-control-allow-origin'), 'upload: the token from another origin is refused');
        const tokNoOrigin = await call('POST', '/api/safety/upload', { origin: null, auth: 'Bearer ' + token, body: csvForm() });
        eq(tokNoOrigin.status, 403, 'upload: the token without an Origin is refused');
        ok(!fs.existsSync(path.join(FILES, 'safety_inspection.csv')), 'upload: nothing written by refused requests');

        const tokOk = await call('POST', '/api/safety/upload', { origin: ALLOWED, auth: 'Bearer ' + token, body: csvForm() });
        eq(tokOk.status, 200, 'upload: the token from the safety site uploads a CSV');
        ok(tokOk.h('access-control-allow-origin') === ALLOWED && tokOk.h('access-control-allow-credentials') === null, 'upload: CORS for the safety site, without credentials');
        eq([tokOk.data.meta.totalRows, tokOk.data.meta.mzoRows, tokOk.data.meta.updatedBy], [2, 1, 'boss'], 'upload: counts and uploader in the meta');
        const stored = fs.readFileSync(path.join(FILES, 'safety_inspection.csv'), 'utf8');
        ok(stored.startsWith('"Inspection ID","Site ID"') && stored.includes('"Loc, with comma"'), 'upload: stored as canonical CSV in MZO_FILES_DIR');
        eq((fs.statSync(path.join(FILES, 'safety_inspection.csv')).mode & 0o777).toString(8), '600', 'upload: written atomically, mode 600');
        ok(fs.readdirSync(FILES).every((f) => !f.endsWith('.tmp')), 'upload: no temp files left');

        // The token is good for nothing else.
        const tokMeta = await call('GET', '/api/safety/meta', { auth: 'Bearer ' + token });
        eq(tokMeta.status, 401, 'token: not a session on GET /api/safety/meta');
        const tokDataset = await call('GET', '/api/safety/dataset', { auth: 'Bearer ' + token });
        eq(tokDataset.status, 401, 'token: not a session on GET /api/safety/dataset');
        const tokAdmin = await call('POST', '/api/admin/sync-schedules', { auth: 'Bearer ' + token, json: { key: 'defective', schedule: {} } });
        eq(tokAdmin.status, 401, 'token: not a session on an admin route');
        const tokCookie = await call('GET', '/api/session-check', { cookie: `mzo_session=${encodeURIComponent(token)}` });
        eq(tokCookie.status, 401, 'token: not a session as the cookie');
        const tampered = token.slice(0, -2) + (token.slice(-2) === 'AA' ? 'BB' : 'AA');
        eq((await call('POST', '/api/safety/upload', { origin: ALLOWED, auth: 'Bearer ' + tampered, body: csvForm() })).status, 401, 'token: a tampered token is refused');
        const expired = await call('POST', '/api/safety/upload', { origin: ALLOWED, auth: 'Bearer ' + handToken(admin.payload, { exp: Date.now() - 1 }), body: csvForm() });
        ok(expired.status === 401 && /drag a fresh button/.test(expired.data.message) && expired.h('access-control-allow-origin') === ALLOWED, 'token: an expired token is refused, readable by the bookmarklet, with what to do');
        eq((await call('POST', '/api/safety/upload', { origin: ALLOWED, auth: 'Bearer ' + handToken(admin.payload, { scope: 'other' }), body: csvForm() })).status, 401, 'token: a token of another scope is refused');
        eq((await call('POST', '/api/safety/upload', { origin: ALLOWED, auth: 'Bearer ' + handToken(expiredAdmin.payload), body: csvForm() })).status, 401, 'token: ends with its session');
        const viewerTok = await call('POST', '/api/safety/upload', { origin: ALLOWED, auth: 'Bearer ' + handToken(viewer.payload), body: csvForm() });
        eq(viewerTok.status, 403, 'token: the permission is checked again at upload');
        const otherKey = crypto.createHmac('sha256', SECRET).update(admin.payload).digest('base64url');
        eq((await call('POST', '/api/safety/upload', { origin: ALLOWED, auth: `Bearer sut1.${Buffer.from(JSON.stringify({ s: 'safety-upload', exp: Date.now() + 60e3, sp: admin.payload })).toString('base64url')}.${otherKey}` , body: csvForm() })).status, 401, 'token: signed with the session key instead of the token key is refused');

        // The app's own upload (cookie, same origin), .xlsx and bad files.
        const xl = await call('POST', '/api/safety/upload', { cookie: cookieOf(syncer), body: form(makeXlsx(REPORT_ROWS), 'report.xlsx') });
        ok(xl.status === 200 && xl.data.meta.totalRows === 3 && xl.data.meta.mzoRows === 2, 'upload: .xlsx from the page with the cookie');
        const noOrigin = await call('POST', '/api/safety/upload', { cookie: cookieOf(admin), origin: null, body: csvForm() });
        eq(noOrigin.status, 403, 'upload: a cookie POST without Origin is refused');
        const viewerUp = await call('POST', '/api/safety/upload', { cookie: cookieOf(viewer), body: csvForm() });
        eq(viewerUp.status, 403, 'upload: a viewer may not upload');
        const biff = await call('POST', '/api/safety/upload', { cookie: cookieOf(admin), body: form(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]), 'old.xls') });
        ok(biff.status === 400 && /\.xlsx or \.csv/.test(biff.data.message), 'upload: old .xls refused with a message');
        const junk = await call('POST', '/api/safety/upload', { cookie: cookieOf(admin), body: form(Buffer.from('a,b\n1,2\n'), 'x.csv') });
        eq(junk.status, 400, 'upload: a file that is not the report is refused');
        const big = await call('POST', '/api/safety/upload', { cookie: cookieOf(admin), body: form(Buffer.alloc(21 * 1024 * 1024, 0x41), 'big.csv') });
        eq(big.status, 413, 'upload: over 20 MB refused');
        eq(fs.readFileSync(path.join(FILES, 'safety_inspection.csv'), 'utf8').split('\n').length, 5, 'upload: a refused file leaves the last good report');

        // Dataset: session only, private.
        const dsAnon = await call('GET', '/api/safety/dataset');
        eq(dsAnon.status, 401, 'dataset: 401 without a session');
        const ds = await call('GET', '/api/safety/dataset', { cookie: cookieOf(viewer) });
        ok(ds.status === 200 && ds.text.startsWith('"Inspection ID"'), 'dataset: served to a signed-in user from the data folder');
        ok(/private/.test(ds.h('cache-control') || '') && !/public/.test(ds.h('cache-control') || ''), 'dataset: Cache-Control private');
        const meta2 = await call('GET', '/api/safety/meta', { cookie: cookieOf(viewer) });
        ok(meta2.data.csvUrl === '/api/safety/dataset' && meta2.data.totalRows === 3, 'meta: the uploaded report is the source');

        // Admin sync schedules: admin only, validated, stored atomically.
        const good = { enabled: false, frequency: 'weekly', time: '04:00', day: 'Mon', interval: 12 };
        eq((await call('POST', '/api/admin/sync-schedules', { cookie: cookieOf(viewer), json: { key: 'defective', schedule: good } })).status, 403, 'schedules: a viewer may not save');
        eq((await call('GET', '/api/admin/sync-schedules', { cookie: cookieOf(viewer) })).status, 403, 'schedules: a viewer may not read');
        eq((await call('POST', '/api/admin/sync-schedules', { cookie: cookieOf(admin), json: { key: '__proto__', schedule: good } })).status, 400, 'schedules: unknown key refused');
        eq((await call('POST', '/api/admin/sync-schedules', { cookie: cookieOf(admin), json: { key: 'defective', schedule: { ...good, time: '25:00' } } })).status, 400, 'schedules: bad time refused');
        eq((await call('POST', '/api/admin/sync-schedules', { cookie: cookieOf(admin), json: { key: 'defective', schedule: { ...good, interval: 0 } } })).status, 400, 'schedules: bad interval refused');
        eq((await call('POST', '/api/admin/sync-schedules', { cookie: cookieOf(admin), origin: EVIL, json: { key: 'defective', schedule: good } })).status, 403, 'schedules: another origin refused');
        const saved = await call('POST', '/api/admin/sync-schedules', { cookie: cookieOf(admin), json: { key: 'defective', schedule: { ...good, cmd: 'rm -rf /', enabled: true } } });
        eq(saved.status, 200, 'schedules: a valid schedule saved');
        const file = JSON.parse(fs.readFileSync(path.join(FILES, 'sync_schedules.json'), 'utf8'));
        eq(Object.keys(file.defective).sort(), ['day', 'enabled', 'frequency', 'interval', 'time', 'updatedAt', 'updatedBy'], 'schedules: only the known fields are stored');
        eq((await call('GET', '/api/admin/sync-schedules', { cookie: cookieOf(admin) })).data.schedules.defective.frequency, 'weekly', 'schedules: read back');

        // No request for a Supabase safety meta, and no upstream writes.
        eq(upstream.filter((u) => /safety/i.test(u)), [], 'upstream: the safety meta is never fetched from Supabase');
        ok(writes.length > 0 && writes.every((w) => /\/activity_logs$/.test(w.url)), 'upstream: the only writes are activity log rows (refused here)');
        ok(writes.every((w) => /Synced Safety Inspection data/.test(w.body) && !/Loc, with comma|Pole|JE /.test(w.body)), 'activity log: counts only, no report contents');
    } finally {
        srv.close();
    }
}

(async () => {
    try {
        await unit();
        await server();
        console.log(`\nSafety upload: ${passed} checks passed`);
        fs.rmSync(FILES, { recursive: true, force: true });
        process.exit(0);
    } catch (err) {
        console.error('FAIL:', err.message);
        fs.rmSync(FILES, { recursive: true, force: true });
        process.exit(1);
    }
})();
