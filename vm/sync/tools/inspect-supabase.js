#!/usr/bin/env node
'use strict';
/**
 * Runs the Supabase source adapters without PocketBase and prints what they return.
 * GET/HEAD only. PIN, password, token, key-like, phone and email values are masked
 * in everything printed.
 *
 *   node vm/sync/tools/inspect-supabase.js                 # every source, first 5 rows
 *   node vm/sync/tools/inspect-supabase.js --limit 50
 *   node vm/sync/tools/inspect-supabase.js --full          # every row; counts, timings, key checks
 *   node vm/sync/tools/inspect-supabase.js --only portal_users,stock_snapshot
 *   node vm/sync/tools/inspect-supabase.js --json          # one JSON line per source
 *   node vm/sync/tools/inspect-supabase.js --full --no-checks --only defective_details   # memory test
 *   node vm/sync/tools/inspect-supabase.js --discover      # re-probe column types → sources/supabase.columns.json
 *   node vm/sync/tools/inspect-supabase.js --discover --scan   # also look for tables not in the list (~1 min)
 */
const fs = require('fs');
const sb = require('../sources/supabase.js');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const FULL = flag('--full');
const LIMIT = FULL ? Infinity : Number(opt('--limit', 5));
const ONLY = opt('--only', '').split(',').map((s) => s.trim()).filter(Boolean);
const JSON_OUT = flag('--json');
const CHECKS = !flag('--no-checks'); // --no-checks: skip key tracking (for memory measurements)

// ---------- masking ----------

const SECRET_COL = /(^|[^a-z])(pin|pins|password|passwd|pwd|pass|passcode|token|secret|apikey|api_key|key|otp|hash|salt|session)([^a-z]|$)/i;
const PII_COL = /(mobile|mob_no|phone|email|e_mail)/i;

function maskValue(col, v) {
    if (v === null || v === undefined || v === '') return v;
    if (SECRET_COL.test(col)) return '***';
    if (PII_COL.test(col)) return '***';
    if (typeof v === 'object') {
        const s = JSON.stringify(v);
        return s.length > 60 ? s.slice(0, 57) + '...' : s;
    }
    const s = String(v);
    if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(s)) return '<jwt>';
    if (/^scrypt\$/.test(s)) return '<scrypt hash>';
    if (/^[A-Fa-f0-9]{32,}$/.test(s)) return `<hex ${s.length} chars>`;
    if (/^[A-Za-z0-9+/=_-]{40,}$/.test(s)) return `<token-like ${s.length} chars>`;
    return s.length > 40 ? s.slice(0, 37) + '...' : v;
}

function maskRow(row) {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[k] = maskValue(k, v);
    return out;
}

function maskText(s) {
    return String(s)
        .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>')
        .replace(/scrypt\$[^\s"',]+/g, '<scrypt hash>');
}

// ---------- type inference (display only, same rules as the contract) ----------

const DATE_RES = [
    /^\d{1,2}\/\d{1,2}\/\d{4}( \d{1,2}:\d{2}(:\d{2})?)?$/, // dd/mm/yyyy, m/d/yyyy
    /^\d{1,2}\.\d{1,2}\.\d{4}$/, // dd.mm.yyyy
    /^\d{4}-\d{2}-\d{2}$/, // yyyy-mm-dd
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/ // ISO
];

function newStats() {
    return { n: 0, num: 0, date: 0, bool: 0, json: 0 };
}

function observe(st, v) {
    if (v === null || v === undefined) return;
    if (typeof v === 'object') { st.n++; st.json++; return; }
    if (typeof v === 'boolean') { st.n++; st.bool++; return; }
    if (typeof v === 'number') { st.n++; st.num++; return; }
    const s = String(v).trim();
    if (!s) return;
    st.n++;
    if (/^[-+]?(\d{1,3}(,\d{2,3})+|\d+)(\.\d+)?$/.test(s) || /^[-+]?\.\d+$/.test(s)) st.num++;
    if (DATE_RES.some((re) => re.test(s))) st.date++;
    if (/^(y|n|yes|no|true|false)$/i.test(s)) st.bool++;
}

function inferred(st) {
    if (!st.n) return 'text';
    if (st.json === st.n) return 'json';
    if (st.bool === st.n) return 'bool';
    if (st.num / st.n >= 0.98) return 'number';
    if (st.date / st.n >= 0.98) return 'date';
    return 'text';
}

// ---------- memory sampling ----------

let peakRss = process.memoryUsage().rss;
const memTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
memTimer.unref();
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';

/** Natural-key candidates to check in --full mode (report only; the adapters set no key for CSVs). */
const KEY_CANDIDATES = {
    stock_snapshot: [['Plant', 'Material', 'Storage Location']],
    defective_summary: [],
    defective_details: [['CON_ID']],
    disconnection: [['CON_ID']],
    pending_mc: [['APPL_NO']],
    load_extension: [['APPL_NO']]
};

// ---------- run sources ----------

async function inspectSource(src, ctx) {
    const out = { key: src.key, ref: src.sourceRef, schedule: src.schedule, primaryKey: src.primaryKey };
    const t0 = Date.now();
    try {
        out.version = await src.version(ctx);
    } catch (e) {
        out.versionError = maskText(e.message);
    }
    out.versionMs = Date.now() - t0;

    const t1 = Date.now();
    const columns = new Map(); // name → stats
    const pkSeen = CHECKS && src.primaryKey ? new Set() : null;
    let pkDupes = 0;
    let pkNulls = 0;
    const cand = FULL && CHECKS ? (KEY_CANDIDATES[src.key] || []).map((cols) => ({ cols, seen: new Set(), dupes: 0, blanks: 0 })) : [];
    let n = 0;
    let sample = null;
    const rssBefore = process.memoryUsage().rss;
    try {
        for await (const row of src.rows(ctx)) {
            n++;
            if (!sample) sample = row;
            for (const [k, v] of Object.entries(row)) {
                if (!columns.has(k)) columns.set(k, newStats());
                observe(columns.get(k), v);
            }
            if (pkSeen) {
                const vals = src.primaryKey.map((c) => row[c]);
                if (vals.some((v) => v === null || v === undefined || v === '')) pkNulls++;
                const id = JSON.stringify(vals);
                if (pkSeen.has(id)) pkDupes++;
                else pkSeen.add(id);
            }
            for (const c of cand) {
                const vals = c.cols.map((k) => String(row[k] == null ? '' : row[k]).trim());
                if (vals.some((v) => !v)) { c.blanks++; continue; }
                const id = vals.join('\u0001');
                if (c.seen.has(id)) c.dupes++;
                else c.seen.add(id);
            }
            if (n >= LIMIT) break;
        }
    } catch (e) {
        out.rowsError = maskText(e.message);
    }
    out.rows = n;
    out.complete = !out.rowsError && n < LIMIT;
    out.rowsMs = Date.now() - t1;
    out.rssDelta = process.memoryUsage().rss - rssBefore;
    const types = src.columnTypes || {};
    out.columns = [...columns.entries()].map(([name, st]) => ({
        name,
        type: types[name] || inferred(st),
        from: types[name] ? 'source' : 'inferred'
    }));
    if (pkSeen) out.primaryKeyCheck = { unique: pkDupes === 0 && pkNulls === 0, duplicates: pkDupes, nulls: pkNulls };
    if (cand.length) out.keyCandidates = cand.map((c) => ({ columns: c.cols, duplicates: c.dupes, blanks: c.blanks, distinct: c.seen.size }));
    out.sample = sample ? maskRow(sample) : null;
    return out;
}

function printHuman(r) {
    const ref = r.ref.table ? `${r.ref.schema}.${r.ref.table}` : `${r.ref.bucket}/${r.ref.path}`;
    console.log(`\n== ${r.key}  (${ref})  schedule=${r.schedule}  pk=${r.primaryKey ? r.primaryKey.join('+') : '-'}`);
    console.log(`   version  ${r.versionError ? 'ERROR ' + r.versionError : r.version}  (${r.versionMs} ms)`);
    const rowsNote = r.rowsError ? `ERROR ${r.rowsError}` : r.complete ? 'all rows' : `stopped at --limit ${LIMIT}`;
    console.log(`   rows     ${r.rows} in ${r.rowsMs} ms (${rowsNote}), rss +${mb(Math.max(0, r.rssDelta))}`);
    if (r.primaryKeyCheck) {
        const c = r.primaryKeyCheck;
        console.log(`   pk check ${c.unique ? 'unique' : `NOT unique: ${c.duplicates} duplicates, ${c.nulls} blanks`}`);
    }
    for (const c of r.keyCandidates || []) {
        console.log(`   key? ${c.columns.join('+')}: ${c.distinct} distinct, ${c.duplicates} duplicates, ${c.blanks} blank`);
    }
    const cols = r.columns.map((c) => `${c.name}:${c.type}${c.from === 'inferred' ? '*' : ''}`);
    console.log(`   columns  ${cols.length}${cols.length ? ': ' + cols.join(', ') : ''}`);
    if (cols.some((c) => c.endsWith('*'))) console.log('            (* = inferred from the rows read; sync-core does its own inference)');
    console.log(`   sample   ${r.sample ? JSON.stringify(r.sample) : '(no rows)'}`);
}

async function runSources() {
    const ctx = {
        fetch: globalThis.fetch,
        log: (m) => console.error('[log] ' + maskText(m)),
        env: process.env,
        limits: { maxRowsPerBatch: 500 }
    };
    const tAll = Date.now();
    let list = await sb.sources(ctx);
    if (ONLY.length) list = list.filter((s) => ONLY.includes(s.key));
    if (!JSON_OUT) console.log(`${list.length} source(s), ${FULL ? 'full read' : `first ${LIMIT} rows each`}`);
    const results = [];
    for (const src of list) {
        const r = await inspectSource(src, ctx);
        results.push(r);
        if (JSON_OUT) console.log(JSON.stringify(r));
        else printHuman(r);
    }
    if (!JSON_OUT) {
        const failed = results.filter((r) => r.versionError || r.rowsError);
        console.log(`\nTotal ${results.reduce((a, r) => a + r.rows, 0)} rows from ${results.length} sources in ${((Date.now() - tAll) / 1000).toFixed(1)} s; peak RSS ${mb(peakRss)}; ${failed.length} with errors${failed.length ? ': ' + failed.map((r) => r.key).join(', ') : ''}`);
    }
    return results;
}

// ---------- --discover: column types, blocked tables, optional table scan ----------

function pgTypeFromError(msg) {
    const s = String(msg || '');
    let m = s.match(/invalid input syntax for type ([a-z ]+?)(:|$)/i);
    if (m) return m[1].trim().toLowerCase();
    if (/malformed array literal/i.test(s)) return 'array';
    m = s.match(/invalid input value for enum ([^:]+)/i);
    if (m) return 'enum';
    if (/date\/time field value out of range/i.test(s)) return 'date';
    if (/within geometry|invalid geometry/i.test(s)) return 'geometry';
    return null;
}

function typeFromSample(v) {
    if (typeof v === 'number') return 'numeric';
    if (typeof v === 'boolean') return 'boolean';
    if (v && typeof v === 'object') return Array.isArray(v) ? 'array' : 'jsonb';
    return 'text';
}

async function rawGet(get, key, schema, pathq) {
    const res = await get(`${sb.OLD.url}/rest/v1/${pathq}`, sb.restHeaders(key, schema, { Prefer: 'count=exact' }));
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch (_) { /* text */ }
    return { status: res.status, range: res.headers.get('content-range'), body };
}

async function discover() {
    const key = sb.anonKey(process.env);
    const get = sb.httpGet({ fetch: globalThis.fetch });
    const report = { openApiRoot: {}, tables: {}, empty: [], notMirrored: [], scan: [] };

    for (const schema of sb.SCHEMAS) {
        const res = await get(`${sb.OLD.url}/rest/v1/`, sb.restHeaders(key, schema, { Accept: 'application/openapi+json' }));
        const text = await res.text();
        let msg = '';
        try { msg = JSON.parse(text).message || ''; } catch (_) { /* not JSON */ }
        report.openApiRoot[schema] = `${res.status}${msg ? ' ' + msg : ''}`;
    }

    const tables = sb.TABLES.filter((t) => !ONLY.length || ONLY.includes(t.key));
    for (const t of tables) {
        const id = `${t.schema}.${t.table}`;
        const first = await rawGet(get, key, t.schema, `${encodeURIComponent(t.table)}?select=*&limit=1`);
        if (first.status >= 300 || !Array.isArray(first.body)) {
            report.tables[id] = null;
            console.log(`${id}: HTTP ${first.status} ${maskText(JSON.stringify(first.body)).slice(0, 120)}`);
            continue;
        }
        const row = first.body[0];
        if (!row) {
            report.empty.push(id);
            console.log(`${id}: empty, columns unknown`);
            continue;
        }
        const cols = {};
        for (const [c, v] of Object.entries(row)) {
            if (typeof v === 'string' && /^0[01]0[0-9A-F]{15,}$/i.test(v)) { cols[c] = 'geometry'; continue; }
            const q = encodeURIComponent(/^[A-Za-z_][A-Za-z0-9_]*$/.test(c) ? c : `"${c}"`);
            const r = await rawGet(get, key, t.schema, `${encodeURIComponent(t.table)}?select=${q}&${q}=eq.zz&limit=0`);
            if (r.status < 300) cols[c] = typeof v === 'string' || v === null ? 'text' : typeFromSample(v);
            else cols[c] = pgTypeFromError(r.body && (r.body.message || r.body.hint)) || typeFromSample(v);
        }
        report.tables[id] = cols;
        console.log(`${id}: ${Object.entries(cols).map(([c, ty]) => `${c}=${ty}`).join(', ')}`);
    }

    for (const t of sb.NOT_MIRRORED) {
        if (t.table === '*') continue;
        const r = await rawGet(get, key, t.schema, `${encodeURIComponent(t.table)}?select=*&limit=0`);
        const msg = r.body && r.body.message ? r.body.message : '';
        const now = r.status < 300 ? `readable (${r.range})` : /does not exist/.test(msg) ? 'missing' : `HTTP ${r.status} ${msg}`;
        report.notMirrored.push({ id: `${t.schema}.${t.table}`, reason: t.reason, now });
    }

    if (flag('--scan')) report.scan = await scanTables(get, key);

    const previous = (() => { try { return JSON.parse(fs.readFileSync(sb.COLUMNS_FILE, 'utf8')); } catch (_) { return {}; } })();
    const merged = { ...(previous.tables || {}) };
    for (const [id, cols] of Object.entries(report.tables)) if (cols) merged[id] = cols;
    const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
    const file = {
        note: 'Postgres column types of the old project tables, probed with read-only GETs. Regenerate: node vm/sync/tools/inspect-supabase.js --discover',
        generatedAt: new Date().toISOString(),
        openApiRoot: report.openApiRoot,
        empty: report.empty,
        tables: sorted
    };
    fs.writeFileSync(sb.COLUMNS_FILE, JSON.stringify(file, null, 2) + '\n');
    console.log(`\nOpenAPI root: ${JSON.stringify(report.openApiRoot)}`);
    console.log('Not mirrored:');
    for (const t of report.notMirrored) console.log(`  ${t.id}: ${t.now}  [${t.reason}]`);
    if (report.scan.length) {
        console.log('Scan: names Supabase suggested that are not in the table list:');
        for (const s of report.scan) console.log(`  ${s}`);
    } else if (flag('--scan')) {
        console.log('Scan: nothing new.');
    }
    console.log(`Wrote ${sb.COLUMNS_FILE}`);
}

/**
 * PostgREST answers an embed of an unknown relation with "Perhaps you meant '<table>'".
 * Feeding it many near-miss names lists the tables that take part in relationships;
 * each suggestion is then probed in every schema.
 */
async function scanTables(get, key) {
    const words = ('a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z,pm,pm_,asset,line,feeder,edit,suggest,profile,log,org,role,member,voltage,level,sub,'
        + 'substation,pole,dtr,transformer,circuit,segment,node,layer,map,photo,file,comment,task,audit,history,event,change,request,approval,team,project,'
        + 'zone,region,division,office,consumer,meter,survey,inspection,note,setting,config,session,device,notification,message,report,stock,material,store,'
        + 'work,scheme,si,dd,nsc,access,auth,link,sheet,month,unbilled,visitor,activity,seq,meta,upload,snapshot,correction,mzo,power,version,item,invoice,offer,receipt').split(',');
    const known = new Set([...sb.TABLES.map((t) => t.table), ...sb.NOT_MIRRORED.map((t) => t.table)]);
    const names = new Set();
    for (const schema of sb.SCHEMAS) {
        for (const w of words) {
            const r = await rawGet(get, key, schema, `${encodeURIComponent(w + '_zq')}?select=*,zzzz(*)&limit=0`);
            const hint = (r.body && r.body.hint) || '';
            for (const m of hint.matchAll(/'([^']+)'/g)) names.add(m[1].split('!')[0]);
        }
    }
    const found = [];
    for (const name of names) {
        if (known.has(name)) continue;
        for (const schema of sb.SCHEMAS) {
            const r = await rawGet(get, key, schema, `${encodeURIComponent(name)}?select=*&limit=0`);
            const msg = r.body && r.body.message ? r.body.message : '';
            if (/does not exist/.test(msg)) continue;
            found.push(`${schema}.${name}: ${r.status < 300 ? `readable ${r.range}` : `HTTP ${r.status} ${msg}`}`);
        }
    }
    return found;
}

(flag('--discover') ? discover() : runSources()).catch((e) => {
    console.error('inspect-supabase failed:', maskText(e.message));
    process.exitCode = 1;
});
