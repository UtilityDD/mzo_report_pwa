'use strict';
/**
 * Supabase sources for the data mirror. Read-only: every request is a GET or HEAD
 * (enforced in httpGet_), and nothing calls /rpc/.
 *
 * - Old project (unsmtschmcvftfqwabaq): every table the anon key can read, in the
 *   public, mzo_insight and powermap schemas, through PostgREST in 1000-row pages.
 * - New project (gmasnqebdogtavoudbke): the public Storage snapshot CSVs (no key).
 *
 * The anon key comes from env SUPABASE_ANON_KEY, else from SUPABASE_FALLBACK_ANON_KEY
 * in the repo's server.js, read at runtime.
 *
 * Supabase only serves the PostgREST OpenAPI root (/rest/v1/) to the service key, so
 * the table list is TABLES below (from scripts/sql, server.js, si-works/si.html and
 * probing). Column types come from supabase.columns.json, written by
 * `node vm/sync/tools/inspect-supabase.js --discover`. If the OpenAPI root ever
 * answers, tables missing from TABLES are added from it. See supabase.md.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, pipeline } = require('stream');
const { parse } = require('csv-parse');

const OLD = { ref: 'unsmtschmcvftfqwabaq', url: 'https://unsmtschmcvftfqwabaq.supabase.co' };
const NEW = { ref: 'gmasnqebdogtavoudbke', url: 'https://gmasnqebdogtavoudbke.supabase.co' };
const SCHEMAS = ['public', 'mzo_insight', 'powermap'];
const PAGE = 1000; // Supabase max-rows default
const DIGEST_MAX_ROWS = 3000; // at or below this, version() hashes the whole table
const DIGEST_CACHE_MS = 10 * 60 * 1000; // rows fetched by version() are reused by rows() for this long
const REST_TIMEOUT_MS = 60 * 1000;
const CSV_TIMEOUT_MS = 10 * 60 * 1000;
const DASHBOARD_URL = `https://supabase.com/dashboard/project/${OLD.ref}/editor`;
const SERVER_JS = path.join(__dirname, '..', '..', '..', 'server.js');
const COLUMNS_FILE = path.join(__dirname, 'supabase.columns.json');

const ADMIN = 'Admin';
const NETWORK = 'Substation & network';
const IMPORTANT = 'Important';

/** A PostgREST URL on the old project, as server.js builds it (`${url}/rest/v1/${apiPath}`). */
const REST = (apiPath) => `${OLD.url}/rest/v1/${apiPath}`;

/**
 * Old-project tables. key → ds_<key>. primaryKey = source column names.
 * order: sort columns when there is no single-column key (pages then use offset).
 * versionColumns: max() columns for version() on tables above DIGEST_MAX_ROWS.
 * sensitive: PINs or personal data; never snapshotted, PocketBase only.
 * raw: the server or a page reads this table, so it gets a .json snapshot. query is the
 *   exact PostgREST query they send (same select and order, so the rows come in the same
 *   order); paged = they page it with limit=1000&offset=N.
 * urls: those exact request URLs. dataHubUrl: see power_map_substations.
 */
const TABLES = [
    // mzo_insight: login, logs, stock ledger, SI works, important sheets
    { key: 'portal_users', schema: 'mzo_insight', table: 'portal_users', label: 'Portal users', group: ADMIN,
        pages: ['admin_users.html?tab=users', 'login.html'], schedule: 'hourly', primaryKey: ['id'],
        sensitive: true, notes: 'Login accounts and module flags, copied as-is including PIN.' },
    { key: 'activity_logs', schema: 'mzo_insight', table: 'activity_logs', label: 'Activity logs', group: ADMIN,
        pages: ['admin_users.html?tab=activity'], schedule: 'hourly', primaryKey: ['id'], versionColumns: ['id'],
        sensitive: true, notes: 'Append-only portal activity log (usernames, names, pages visited).' },
    { key: 'si_works', schema: 'mzo_insight', table: 'prioritySI', label: 'Priority SI works', group: IMPORTANT,
        pages: ['si-works/si.html'], schedule: 'hourly', primaryKey: ['id'],
        raw: { query: 'select=*' }, urls: [REST('prioritySI?select=*')],
        notes: 'si-works/si.html reads and edits this table directly with the anon key (supabase-js select).' },
    { key: 'stock_allotments', schema: 'mzo_insight', table: 'stock_allotments', label: 'Stock allotments', group: IMPORTANT,
        pages: ['stock/index.html'], schedule: 'frequent', primaryKey: ['id'],
        raw: { query: 'select=*&order=date.desc,allotment_no.desc', paged: true },
        urls: [REST('stock_allotments?select=*&order=date.desc,allotment_no.desc&limit=1000&offset=0')],
        notes: 'Allotment and diversion ledger (Allot Material / View Allotments); /api/stock/allotment lists it.' },
    { key: 'stock_allot_seq', schema: 'mzo_insight', table: 'stock_allot_seq', label: 'Stock allotment number sequence', group: IMPORTANT,
        pages: ['stock/index.html'], schedule: 'hourly', primaryKey: ['year'],
        notes: 'Next MZO/ALT/YYYY/#### number per year.' },
    { key: 'important_unbilled_months', schema: 'mzo_insight', table: 'important_unbilled_months', label: 'Important sheets: unbilled months', group: IMPORTANT,
        pages: ['important_sheets.html'], schedule: 'frequent', primaryKey: ['id'],
        raw: { query: 'select=*&order=sort_order.asc,id.asc' },
        urls: [REST('important_unbilled_months?select=*&order=sort_order.asc,id.asc')],
        notes: '/api/important-sheets/unbilled lists it (active rows only unless ?all=1).' },
    { key: 'stock_upload_meta', schema: 'mzo_insight', table: 'stock_upload_meta', label: 'Stock upload history (old database)', group: IMPORTANT,
        pages: ['stock/upload.html'], schedule: 'daily', primaryKey: ['id'],
        notes: 'Upload meta from before the dump moved to Storage (STOCK_USE_STORAGE); no longer written in production.' },
    { key: 'stock_snapshot_db', schema: 'mzo_insight', table: 'stock_snapshot', label: 'Stock snapshot (old database copy)', group: IMPORTANT,
        pages: ['stock/index.html'], schedule: 'daily', primaryKey: ['id'],
        notes: 'Database copy of an older stock dump. The live dump is the stock_snapshot Storage CSV.' },

    // public: Power Map (current app) and legacy tables
    { key: 'power_map_substations', schema: 'public', table: 'mzo_power_substations', label: 'Power Map substations', group: NETWORK,
        pages: ['power_map/map.html', 'admin_users.html?tab=powermap'], schedule: 'hourly', primaryKey: ['id'],
        raw: { query: 'select=*&limit=5000' }, urls: [REST('mzo_power_substations?select=*&limit=5000')],
        // The snapshot is JSON; CACHE_POWER_MAP is the CSV /api/power-map/data builds from it.
        dataHubKeys: ['CACHE_POWER_MAP'], dataHubUrl: '/api/power-map/data',
        notes: 'Substations, feeders and map styling for power_map/map.html, served as CSV by /api/power-map/data.' },
    { key: 'power_map_corrections', schema: 'public', table: 'mzo_power_corrections', label: 'Power Map pending corrections', group: NETWORK,
        pages: ['admin_users.html?tab=corrections', 'power_map/map.html'], schedule: 'hourly', primaryKey: ['id'],
        notes: 'Edit suggestions awaiting admin approval.' },
    { key: 'power_map_suggested_corrections', schema: 'public', table: 'suggested_corrections', label: 'Power Map suggested corrections (legacy)', group: NETWORK,
        pages: [], schedule: 'daily', primaryKey: null,
        notes: 'Old Power Map corrections table, replaced by mzo_power_corrections. Empty.' },
    { key: 'dd_user_auth', schema: 'public', table: 'user_auth', label: 'DD visit logins (legacy)', group: ADMIN,
        pages: [], schedule: 'daily', primaryKey: ['id'], sensitive: true,
        notes: 'Old Upcoming DD login table (office, PIN, dd_view/dd_edit); no page reads it now.' },

    // powermap: Power Map v2 data model (not read by this repo's pages)
    { key: 'powermap_assets', schema: 'powermap', table: 'assets', label: 'Power Map v2: assets', group: NETWORK,
        pages: [], schedule: 'hourly', primaryKey: ['id'] },
    { key: 'powermap_substations', schema: 'powermap', table: 'substations', label: 'Power Map v2: substations', group: NETWORK,
        pages: [], schedule: 'hourly', primaryKey: ['asset_id'] },
    { key: 'powermap_lines', schema: 'powermap', table: 'lines', label: 'Power Map v2: lines', group: NETWORK,
        pages: [], schedule: 'hourly', primaryKey: ['asset_id'] },
    { key: 'powermap_transformers', schema: 'powermap', table: 'transformers', label: 'Power Map v2: transformers', group: NETWORK,
        pages: [], schedule: 'hourly', primaryKey: ['id'] },
    { key: 'powermap_tap_nodes', schema: 'powermap', table: 'tap_nodes', label: 'Power Map v2: tap nodes', group: NETWORK,
        pages: [], schedule: 'hourly', primaryKey: ['asset_id'] },
    { key: 'powermap_tap_laterals', schema: 'powermap', table: 'tap_laterals', label: 'Power Map v2: tap laterals', group: NETWORK,
        pages: [], schedule: 'hourly', primaryKey: ['asset_id'] },
    { key: 'powermap_voltage_levels', schema: 'powermap', table: 'voltage_levels', label: 'Power Map v2: voltage levels', group: NETWORK,
        pages: [], schedule: 'hourly', primaryKey: ['id'] },
    { key: 'powermap_org_units', schema: 'powermap', table: 'org_units', label: 'Power Map v2: offices', group: NETWORK,
        pages: [], schedule: 'hourly', primaryKey: ['id'], sensitive: true, notes: 'Has staff names and phone numbers.' },
    { key: 'powermap_editors', schema: 'powermap', table: 'editors', label: 'Power Map v2: editors', group: NETWORK,
        pages: [], schedule: 'hourly', primaryKey: null, order: ['created_at'], sensitive: true, notes: 'User accounts. Empty.' },
    { key: 'powermap_edit_suggestions', schema: 'powermap', table: 'edit_suggestions', label: 'Power Map v2: edit suggestions', group: NETWORK,
        pages: [], schedule: 'hourly', primaryKey: null, order: ['created_at'], notes: 'Empty.' },
    { key: 'powermap_profiles', schema: 'powermap', table: 'profiles', label: 'Power Map v2: profiles', group: NETWORK,
        pages: [], schedule: 'hourly', primaryKey: null, order: ['created_at'], sensitive: true, notes: 'User accounts. Empty.' },
    { key: 'powermap_v_substations', schema: 'powermap', table: 'v_substations', label: 'Power Map v2: substations (view)', group: NETWORK,
        pages: [], schedule: 'hourly', primaryKey: ['id'], notes: 'Read-only view: substation assets with location, voltage and office names.' },
    { key: 'powermap_v_lines', schema: 'powermap', table: 'v_lines', label: 'Power Map v2: lines (view)', group: NETWORK,
        pages: [], schedule: 'hourly', primaryKey: ['id'], notes: 'Read-only view: line assets with end points and voltage.' },
    { key: 'powermap_v_tap_nodes', schema: 'powermap', table: 'v_tap_nodes', label: 'Power Map v2: tap nodes (view)', group: NETWORK,
        pages: [], schedule: 'hourly', primaryKey: ['id'], notes: 'Read-only view.' },
    { key: 'powermap_v_tap_laterals', schema: 'powermap', table: 'v_tap_laterals', label: 'Power Map v2: tap laterals (view)', group: NETWORK,
        pages: [], schedule: 'hourly', primaryKey: ['id'], notes: 'Read-only view.' }
];

/**
 * Seen but not mirrored, with the reason. supabase.md lists them; the inspect tool
 * reports any of them that becomes readable.
 */
const NOT_MIRRORED = [
    ...['profiles', 'logs', 'versions', 'offers', 'receipts', 'approvals', 'items', 'invoices', 'invoice_lines', 'di']
        .map((table) => ({ schema: 'public', table, reason: 'anon: permission denied (42501)' })),
    ...['pm_assets', 'pm_substations', 'pm_lines', 'pm_transformers', 'pm_tap_nodes', 'pm_tap_laterals', 'pm_voltage_levels',
        'pm_org_units', 'pm_editors', 'pm_edit_suggestions', 'pm_profiles', 'pm_v_substations', 'pm_v_lines']
        .map((table) => ({ schema: 'public', table, reason: `alias of powermap.${table.slice(3)} (identical rows), mirrored once from powermap` })),
    ...['nsc_pending', 'nsc_withheld', 'nsc_upload_meta', 'user_access']
        .map((table) => ({ schema: 'mzo_insight', table, reason: 'dropped (scripts/sql/drop_legacy_tables.sql)' })),
    { schema: 'public', table: 'user_access', reason: 'dropped (scripts/sql/drop_legacy_tables.sql)' },
    { schema: 'public', table: 'upcomingdd', reason: 'gone (old Upcoming DD table; the page now reads a Google Sheet)' },
    { schema: 'graphql_public', table: '*', reason: 'exposed schema with no tables (pg_graphql entry point only)' }
];

/**
 * New-project public Storage files. meta: reports/<folder>/meta.json field that holds the
 * CSV URL. urls = the public object URL; the server and meta.json add ?v=<version>.
 * These CSVs hold consumer names, addresses and phone numbers, but pages read them and
 * they are public objects today, so they are not marked sensitive.
 */
const STORAGE = [
    { key: 'stock_snapshot', dataHubKeys: ['CACHE_STOCK'], label: 'Stock', group: IMPORTANT, pages: ['stock/index.html'], bucket: 'stock', path: 'snapshot.csv',
        notes: 'Version: object ETag.' },
    { key: 'defective_summary', dataHubKeys: ['CACHE_DEFECTIVE'], label: 'Defective meter summary', group: 'Consumers & meters', pages: ['consumer/defective_meter.html'],
        bucket: 'reports', path: 'defective/summary.csv', meta: { folder: 'defective', field: 'summaryCsvUrl' } },
    { key: 'defective_details', dataHubKeys: ['CACHE_DEFECTIVE_DETAILS'], label: 'Defective meter details', group: 'Consumers & meters', pages: ['consumer/defective_meter.html'],
        bucket: 'reports', path: 'defective/details.csv', meta: { folder: 'defective', field: 'detailsCsvUrl' } },
    { key: 'disconnection', dataHubKeys: ['CACHE_DISCONNECTION'], label: 'Disconnection tracker', group: 'Revenue', pages: ['disconnection.html'],
        bucket: 'reports', path: 'disconnection/snapshot.csv', meta: { folder: 'disconnection', field: 'csvUrl' } },
    { key: 'pending_mc', dataHubKeys: ['CACHE_PENDING_MC'], label: 'Pending master card', group: 'New service connection', pages: ['pending_mc.html'],
        bucket: 'reports', path: 'pending_mc/snapshot.csv', meta: { folder: 'pending_mc', field: 'csvUrl' } },
    { key: 'load_extension', dataHubKeys: ['CACHE_LOAD_EXT'], label: 'Pending load extension', group: 'New service connection', pages: ['pending_load_extension.html'],
        bucket: 'reports', path: 'load_extension/snapshot.csv', meta: { folder: 'load_extension', field: 'csvUrl' } }
];

// ---------- helpers ----------

/** Postgres type (as found by --discover) → contract field type. Unknown → text. */
function fieldType(pgType) {
    const t = String(pgType || '').toLowerCase();
    if (/^(smallint|integer|bigint|numeric|real|double precision)$/.test(t)) return 'number';
    if (/^(date|timestamp|timestamp with time zone|timestamp without time zone)$/.test(t)) return 'date';
    if (t === 'boolean') return 'bool';
    if (t === 'json' || t === 'jsonb' || t === 'array') return 'json';
    return 'text';
}

let columnsCache_;
/** { 'schema.table': { column: pgType } } from supabase.columns.json, or {} when missing. */
function columnCatalog() {
    if (columnsCache_ === undefined) {
        try {
            columnsCache_ = JSON.parse(fs.readFileSync(COLUMNS_FILE, 'utf8')).tables || {};
        } catch (_) {
            columnsCache_ = {};
        }
    }
    return columnsCache_;
}

function columnTypesFor(schema, table) {
    const cols = columnCatalog()[`${schema}.${table}`];
    if (!cols) return undefined;
    const out = {};
    for (const [name, pg] of Object.entries(cols)) out[name] = fieldType(pg);
    return out;
}

function jwtPayload_(key) {
    const parts = String(key).split('.');
    if (parts.length !== 3) return null;
    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch (_) {
        return null;
    }
}

/** The old project's anon key: env SUPABASE_ANON_KEY, else server.js SUPABASE_FALLBACK_ANON_KEY. */
function anonKey(env) {
    let key = String((env && env.SUPABASE_ANON_KEY) || '').trim();
    let from = 'SUPABASE_ANON_KEY';
    if (!key) {
        let src = '';
        try {
            src = fs.readFileSync(SERVER_JS, 'utf8');
        } catch (e) {
            throw new Error(`Cannot read ${SERVER_JS} for the Supabase anon key; set SUPABASE_ANON_KEY`);
        }
        const m = src.match(/SUPABASE_FALLBACK_ANON_KEY\s*=\s*['"]([^'"]+)['"]/);
        if (!m) throw new Error('SUPABASE_FALLBACK_ANON_KEY not found in server.js; set SUPABASE_ANON_KEY');
        key = m[1];
        from = 'server.js';
    }
    const p = jwtPayload_(key);
    if (p && p.ref && p.ref !== OLD.ref) {
        throw new Error(`Supabase key from ${from} is for project ${p.ref}, not ${OLD.ref}`);
    }
    return key;
}

const sleep_ = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET/HEAD only, with a timeout and up to 3 tries on network errors, 429 and 5xx. */
function httpGet_(ctx) {
    const f = (ctx && ctx.fetch) || globalThis.fetch;
    return async function get(url, headers = {}, opts = {}) {
        const method = String(opts.method || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') throw new Error(`read-only source: ${method} refused`);
        if (/\/rpc\//i.test(new URL(url).pathname)) throw new Error('read-only source: /rpc/ refused');
        const timeoutMs = opts.timeoutMs || REST_TIMEOUT_MS;
        for (let attempt = 1; ; attempt++) {
            let res;
            try {
                res = await f(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
            } catch (e) {
                if (attempt < 3) {
                    await sleep_(1000 * attempt);
                    continue;
                }
                throw new Error(`${method} ${redactUrl_(url)} failed: ${e.message}`);
            }
            if ((res.status === 429 || res.status >= 500) && attempt < 3) {
                try { await res.body?.cancel(); } catch (_) { /* ignore */ }
                await sleep_(1000 * attempt);
                continue;
            }
            return res;
        }
    };
}

function redactUrl_(url) {
    return String(url).replace(/([?&](apikey|token)=)[^&]+/gi, '$1***');
}

/** PostgREST identifier in select/order/filter: quote anything that is not a plain name. */
function ident_(name) {
    const s = String(name);
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
}

function restHeaders_(key, schema, extra) {
    return { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': schema, Accept: 'application/json', ...extra };
}

async function restGet_(get, key, schema, table, query, extra) {
    const url = `${OLD.url}/rest/v1/${encodeURIComponent(table)}?${query}`;
    const res = await get(url, restHeaders_(key, schema, extra));
    const text = await res.text();
    if (!res.ok) {
        let msg = text.slice(0, 200);
        try { msg = JSON.parse(text).message || msg; } catch (_) { /* keep raw */ }
        const err = new Error(`${schema}.${table}: HTTP ${res.status} ${msg}`);
        err.status = res.status;
        throw err;
    }
    return { res, text };
}

function totalFromRange_(res) {
    const m = String(res.headers.get('content-range') || '').match(/\/(\d+)$/);
    return m ? Number(m[1]) : null;
}

/**
 * Pages of a table in a stable order: keyset on a single-column primary key, else
 * offset with def.order. Keeps going while pages are full or fewer rows than the exact
 * count have arrived, so a lower server max-rows cannot truncate silently.
 */
async function* tablePages_(get, key, def) {
    const pk = def.primaryKey && def.primaryKey.length === 1 ? def.primaryKey[0] : null;
    const order = pk ? [pk] : (def.primaryKey && def.primaryKey.length ? def.primaryKey : def.order || []);
    const orderQ = order.length ? '&order=' + order.map((c) => encodeURIComponent(ident_(c)) + '.asc').join(',') : '';
    let total = null;
    let seen = 0;
    let last;
    for (let page = 0; ; page++) {
        let q = `select=*&limit=${PAGE}${orderQ}`;
        if (pk) {
            if (last !== undefined) q += `&${encodeURIComponent(ident_(pk))}=gt.${encodeURIComponent(String(last))}`;
        } else {
            q += `&offset=${seen}`;
        }
        const { res, text } = await restGet_(get, key, def.schema, def.table, q, page === 0 ? { Prefer: 'count=exact' } : undefined);
        if (page === 0) total = totalFromRange_(res);
        const rows = JSON.parse(text);
        if (!Array.isArray(rows)) throw new Error(`${def.schema}.${def.table}: expected a JSON array`);
        if (!rows.length) return;
        seen += rows.length;
        yield { text, rows };
        if (rows.length < PAGE && (total == null || seen >= total)) return;
        if (pk) {
            last = rows[rows.length - 1][pk];
            if (last === null || last === undefined) throw new Error(`${def.schema}.${def.table}: null ${pk} in key column`);
        }
    }
}

async function tableCount_(get, key, def) {
    const pk = def.primaryKey && def.primaryKey[0];
    const { res } = await restGet_(get, key, def.schema, def.table,
        `select=${encodeURIComponent(pk ? ident_(pk) : '*')}&limit=1`, { Prefer: 'count=exact' });
    return totalFromRange_(res);
}

async function columnMax_(get, key, def, col) {
    const c = encodeURIComponent(ident_(col));
    const { text } = await restGet_(get, key, def.schema, def.table, `select=${c}&order=${c}.desc.nullslast&limit=1`);
    const rows = JSON.parse(text);
    const v = rows && rows[0] ? rows[0][col] : null;
    return v === null || v === undefined ? '' : String(v);
}

function defaultVersionColumns_(def) {
    const cols = columnCatalog()[`${def.schema}.${def.table}`] || {};
    const out = [];
    const pk = def.primaryKey && def.primaryKey.length === 1 ? def.primaryKey[0] : null;
    if (pk && fieldType(cols[pk]) === 'number') out.push(pk);
    for (const c of ['updated_at', 'created_at', 'timestamp']) if (cols[c]) out.push(c);
    return out.slice(0, 2);
}

/**
 * The snapshot body of a table the server or a page reads: the exact PostgREST response
 * to their query (def.raw.query), pages joined into one array the way PostgREST joins
 * rows (", \n "). One page, the usual case, is byte-for-byte the response they get.
 */
async function rawTableBody_(get, key, def, log) {
    const spec = def.raw;
    if (!spec.paged) {
        const { res, text } = await restGet_(get, key, def.schema, def.table, spec.query, { Prefer: 'count=exact' });
        const rows = JSON.parse(text).length;
        const total = totalFromRange_(res);
        if (total != null && total > rows && log) {
            log(`supabase: ${def.schema}.${def.table} has ${total} rows but its reader's query returns ${rows} (server row cap)`);
        }
        return { text, rows };
    }
    const parts = [];
    let rows = 0;
    for (;;) {
        const { text } = await restGet_(get, key, def.schema, def.table, `${spec.query}&limit=${PAGE}&offset=${rows}`);
        const page = JSON.parse(text);
        if (!Array.isArray(page) || !page.length) break;
        parts.push(text);
        rows += page.length;
        if (page.length < PAGE) break;
    }
    if (parts.length === 1) return { text: parts[0], rows };
    const inner = parts.map((t) => t.trim().slice(1, -1).trim()).filter(Boolean);
    return { text: `[${inner.join(', \n ')}]`, rows };
}

function tableSource(def, key) {
    let cached = null; // rows read by version() for small tables, reused once by rows()
    const src = {
        key: def.key,
        label: def.label,
        group: def.group,
        pages: def.pages || [],
        sourceType: 'supabase_table',
        sourceRef: { project: OLD.ref, schema: def.schema, table: def.table },
        sourceUrl: DASHBOARD_URL,
        schedule: def.schedule || 'hourly',
        primaryKey: def.primaryKey || null,
        columnTypes: def.columnTypes || columnTypesFor(def.schema, def.table),
        notes: def.notes || '',
        dataHubKeys: def.dataHubKeys || [],
        urls: def.urls || [],
        sensitive: !!def.sensitive,

        /**
         * Small tables (≤ DIGEST_MAX_ROWS): n:<count>|h:<sha1 of every row>, which also
         * catches in-place edits that do not touch a timestamp (e.g. portal_users.last_login).
         * Larger tables: n:<count>|<col>:<max>, from cheap limit=1 GETs.
         */
        async version(ctx) {
            const get = httpGet_(ctx);
            const n = await tableCount_(get, key, def);
            if (n != null && n <= DIGEST_MAX_ROWS) {
                const h = crypto.createHash('sha1');
                const rows = [];
                for await (const page of tablePages_(get, key, def)) {
                    h.update(page.text);
                    for (const r of page.rows) rows.push(r);
                }
                const version = `n:${rows.length}|h:${h.digest('hex').slice(0, 16)}`;
                cached = { at: Date.now(), rows };
                return version;
            }
            const parts = [`n:${n == null ? '?' : n}`];
            for (const col of def.versionColumns || defaultVersionColumns_(def)) {
                parts.push(`${col}:${await columnMax_(get, key, def, col)}`);
            }
            return parts.join('|');
        },

        /**
         * When the framework passes the raw() bytes as ctx.input (sources with raw()), the
         * rows are parsed from them, in the reader's order. Otherwise rows are fetched.
         */
        async *rows(ctx) {
            if (ctx && ctx.input) {
                cached = null;
                const chunks = [];
                for await (const c of ctx.input) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
                const rows = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!Array.isArray(rows)) throw new Error(`${def.schema}.${def.table}: raw input is not a JSON array`);
                yield* rows;
                return;
            }
            if (cached && Date.now() - cached.at < DIGEST_CACHE_MS) {
                const rows = cached.rows;
                cached = null;
                yield* rows;
                return;
            }
            cached = null;
            const get = httpGet_(ctx);
            for await (const page of tablePages_(get, key, def)) yield* page.rows;
        }
    };
    if (def.dataHubUrl) src.dataHubUrl = def.dataHubUrl;
    if (def.raw && !def.sensitive) {
        /** { contentType, stream, rows }: the JSON snapshot (see rawTableBody_). */
        src.raw = async function raw(ctx) {
            const { text, rows } = await rawTableBody_(httpGet_(ctx), key, def, ctx && ctx.log);
            return { contentType: 'application/json', stream: Readable.from([Buffer.from(text, 'utf8')]), rows };
        };
    }
    return src;
}

/** Header cells → unique, non-empty object keys (blank → "Column <n>", repeat → "<name> (2)"). */
function uniqueHeaders(cells) {
    const used = new Set();
    return cells.map((raw, i) => {
        let name = String(raw == null ? '' : raw);
        if (!name.trim()) name = `Column ${i + 1}`;
        let out = name;
        for (let k = 2; used.has(out); k++) out = `${name} (${k})`;
        used.add(out);
        return out;
    });
}

/**
 * Parses a CSV byte stream and yields the header row, then one array of cells per data row. The
 * framework names the columns from the header exactly as lib/uniform.js names them from the same
 * bytes (blank headers, duplicates, padding columns), so the mirror and the uniform rows agree.
 */
async function* csvRows(stream) {
    const parser = parse({ bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true });
    pipeline(stream, parser, () => { /* errors surface in the loop below */ });
    let header = false;
    for await (const rec of parser) {
        if (!header) {
            header = true;
            yield rec.map((v) => (v == null ? '' : v));
            continue;
        }
        if (rec.every((v) => v === '' || v == null || !String(v).trim())) continue;
        yield rec.map((v) => (v == null ? '' : v));
    }
}

function publicObjectUrl_(bucket, objectPath) {
    return `${NEW.url}/storage/v1/object/public/${bucket}/${objectPath}`;
}

function storageSource(def) {
    const plainUrl = publicObjectUrl_(def.bucket, def.path);

    /** { url, version }: from meta.json when the file has one, else a HEAD on the object. */
    async function resolve(get) {
        if (def.meta) {
            const metaUrl = publicObjectUrl_('reports', `${def.meta.folder}/meta.json`);
            const res = await get(metaUrl, { Accept: 'application/json' });
            let meta = null;
            if (res.ok) {
                try { meta = await res.json(); } catch (_) { meta = null; }
            } else {
                try { await res.body?.cancel(); } catch (_) { /* ignore */ }
            }
            if (meta && typeof meta === 'object') {
                const url = String(meta[def.meta.field] || '').startsWith(NEW.url) ? meta[def.meta.field] : plainUrl;
                const v = [meta.version, meta.updatedAt].filter(Boolean).join('|');
                if (v) return { url, version: `meta:${v}` };
                return { url, version: await headVersion(get, url) };
            }
        }
        return { url: plainUrl, version: await headVersion(get, plainUrl) };
    }

    async function headVersion(get, url) {
        const res = await get(url, {}, { method: 'HEAD' });
        if (!res.ok) throw new Error(`${def.bucket}/${def.path}: HEAD HTTP ${res.status}`);
        const etag = res.headers.get('etag');
        const lm = res.headers.get('last-modified');
        const len = res.headers.get('content-length');
        if (etag) return `e:${etag.replace(/"/g, '')}`;
        if (lm) return `m:${lm}`;
        if (len && len !== '0') return `l:${len}`;
        return null;
    }

    /**
     * { contentType, stream, url, etag, bytes }: the object's exact bytes as a Node
     * stream, not buffered. Read it to the end or destroy it.
     */
    async function raw(ctx) {
        const get = httpGet_(ctx);
        const { url } = await resolve(get);
        const res = await get(url, { Accept: 'text/csv' }, { timeoutMs: CSV_TIMEOUT_MS });
        if (!res.ok) {
            try { await res.body?.cancel(); } catch (_) { /* ignore */ }
            throw new Error(`${def.bucket}/${def.path}: GET HTTP ${res.status}`);
        }
        return {
            contentType: 'text/csv',
            stream: Readable.fromWeb(res.body),
            url,
            etag: res.headers.get('etag'),
            bytes: Number(res.headers.get('content-length')) || null
        };
    }

    return {
        key: def.key,
        label: def.label,
        group: def.group,
        pages: def.pages || [],
        sourceType: 'supabase_storage',
        sourceRef: { project: NEW.ref, bucket: def.bucket, path: def.path },
        sourceUrl: plainUrl,
        schedule: 'frequent',
        primaryKey: null,
        notes: def.notes || '',
        dataHubKeys: def.dataHubKeys || [],
        urls: [plainUrl],
        sensitive: false,

        async version(ctx) {
            return (await resolve(httpGet_(ctx))).version;
        },

        raw,

        /** Parses ctx.input (the raw() bytes, passed by the framework) or fetches on its own. */
        async *rows(ctx) {
            const stream = ctx && ctx.input ? ctx.input : (await raw(ctx)).stream;
            yield* csvRows(stream);
        }
    };
}

// ---------- OpenAPI root (works only with a key Supabase allows there) ----------

function openApiFieldType_(prop) {
    const fmt = String((prop && prop.format) || '').toLowerCase().replace(/\[\]$/, '');
    if (prop && (prop.type === 'array' || /\[\]$/.test(String(prop.format || '')))) return 'json';
    return fieldType(fmt);
}

function snake_(s) {
    return String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Tables from the OpenAPI root that TABLES does not list. [] when the root is not readable. */
async function openApiExtras_(get, key, log) {
    const known = new Set(TABLES.map((t) => `${t.schema}.${t.table}`));
    const skip = new Set(NOT_MIRRORED.map((t) => `${t.schema}.${t.table}`));
    const extras = [];
    for (const schema of SCHEMAS) {
        let res;
        try {
            res = await get(`${OLD.url}/rest/v1/`, restHeaders_(key, schema, { Accept: 'application/openapi+json' }));
        } catch (_) {
            continue;
        }
        if (!res.ok) {
            try { await res.body?.cancel(); } catch (_) { /* ignore */ }
            continue;
        }
        let doc;
        try { doc = await res.json(); } catch (_) { continue; }
        for (const [table, defn] of Object.entries((doc && doc.definitions) || {})) {
            const id = `${schema}.${table}`;
            if (known.has(id) || skip.has(id)) continue;
            const props = defn.properties || {};
            const pk = Object.keys(props).filter((c) => /<pk\/>/.test(String(props[c].description || '')));
            const columnTypes = {};
            for (const [c, p] of Object.entries(props)) columnTypes[c] = openApiFieldType_(p);
            extras.push({
                key: (schema === 'public' ? '' : snake_(schema) + '_') + snake_(table),
                schema, table, label: `${schema}.${table}`, group: 'System', pages: [], schedule: 'daily',
                primaryKey: pk.length ? pk : null, columnTypes, sensitive: true,
                notes: 'Found through the PostgREST OpenAPI root; not in the built-in table list. Marked sensitive until reviewed.'
            });
        }
    }
    if (extras.length && log) log(`supabase: ${extras.length} extra table(s) from the OpenAPI root`);
    return extras;
}

// ---------- entry point ----------

/** All Supabase sources. ctx = { fetch, log, env, limits }. */
async function sources(ctx = {}) {
    const key = anonKey(ctx.env || process.env);
    const get = httpGet_(ctx);
    const extras = await openApiExtras_(get, key, ctx.log);
    return [
        ...TABLES.concat(extras).map((def) => tableSource(def, key)),
        ...STORAGE.map((def) => storageSource(def))
    ];
}

module.exports = {
    sources,
    // for tools/inspect-supabase.js and tests
    TABLES,
    STORAGE,
    NOT_MIRRORED,
    SCHEMAS,
    OLD,
    NEW,
    COLUMNS_FILE,
    anonKey,
    fieldType,
    uniqueHeaders,
    csvRows,
    httpGet: httpGet_,
    restHeaders: restHeaders_
};
