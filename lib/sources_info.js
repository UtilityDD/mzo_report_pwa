'use strict';
// Admin → Sources (server only, never loaded in the browser): where every dataset comes from, how it
// is refreshed and how fresh it is, for GET /api/admin/sources-info (admin only).
//
// It joins, read-only:
//   - the sync's source inventory (vm/sync/sources/*.js, loaded without network: the Google sheet list,
//     the repo files and the Supabase table / Storage lists);
//   - the snapshot manifest (lib/mirror.js, mirror mode only);
//   - PocketBase sys_datasets and the latest sys_sync_runs per dataset (PB_URL, PB_SUPERUSER_EMAIL,
//     PB_SUPERUSER_PASSWORD; GET requests plus the superuser sign-in);
//   - lib/sources_live.js: the parts the mirror does not know about (Apps Script features, server
//     files, external services) and per-report corrections;
//   - the report list from the shell NAV in app.html.
// Without mirror mode or PocketBase (Vercel, a local checkout) it answers with what it can read
// locally: the inventory and the descriptor, every copy marked as read live.

const fs = require('fs');
const path = require('path');

const MIN = 60000;
const HOUR = 60 * MIN;
const IST_MS = 330 * MIN;
// The same schedule rules as vm/sync/lib/schedule.js (the systemd timer ticks every 5 minutes).
const TIMER_MIN = 5;
const INTERVAL_MS = { frequent: 5 * MIN, hourly: 60 * MIN, daily: 24 * HOUR };
const DAILY_HOUR_IST = 2;
// A check later than its due time plus this is overdue (a run handles one source at a time, and the
// nightly run works through every multi-MB dump).
const GRACE_MS = { frequent: 10 * MIN, hourly: 20 * MIN, daily: 3 * HOUR };
// No successful check for this long: the copy is stale.
const STALE_MS = { frequent: 30 * MIN, hourly: 3 * HOUR, daily: 30 * HOUR };
const SCHEDULE_TEXT = {
    frequent: `Every ${INTERVAL_MS.frequent / MIN} min`,
    hourly: 'Every hour',
    daily: `Daily after 0${DAILY_HOUR_IST}:00 IST`
};
const CACHE_MS = 60 * 1000;
const PB_TIMEOUT_MS = 5000;
const DATASET_FIELDS = [
    'key', 'label', 'group', 'pages', 'source_type', 'source_url', 'schedule', 'row_count', 'column_count',
    'last_synced_at', 'last_checked_at', 'last_fetched_at', 'last_status', 'last_error', 'last_duration_ms', 'notes',
    'snapshot_file', 'snapshot_bytes', 'snapshot_at', 'source_modified_at', 'mode', 'native_since', 'native_by'
].join(',');
const RUN_FIELDS = 'dataset,started_at,finished_at,status,message,duration_ms,rows_total,rows_inserted,rows_updated,rows_deleted';

const CATEGORIES = [
    { id: 'vm_google', label: 'VM copy: Google Sheet', copied: true },
    { id: 'vm_supabase_table', label: 'VM copy: Supabase table', copied: true },
    { id: 'vm_supabase_storage', label: 'VM copy: Supabase Storage', copied: true },
    { id: 'vm_only', label: 'VM only', copied: false },
    { id: 'live_google', label: 'Live Google Sheet', copied: false },
    { id: 'live_supabase', label: 'Live Supabase', copied: false },
    { id: 'live_script', label: 'Live via Apps Script', copied: false },
    { id: 'external', label: 'External', copied: false },
    { id: 'none', label: 'No data', copied: false }
];
const COPY_CATEGORY = { google_sheet: 'vm_google', supabase_table: 'vm_supabase_table', supabase_storage: 'vm_supabase_storage' };
const LIVE_CATEGORY = { google_sheet: 'live_google', supabase_table: 'live_supabase', supabase_storage: 'live_supabase' };
const STATUS_RANK = { error: 6, held: 5, missing: 5, skipped: 5, off: 5, overdue: 4, stale: 3, never: 2, ok: 1, live: 0, info: 0 };
// The sync's hold-back (vm/sync/lib/holdback.js) writes "held: new copy looks incomplete (…)" as the error.
const HELD_ERROR = /(^|\] )held: /;

const SECRET_QUERY = /((?:[?&](?:key|sig|pin)|\b(?:apikey|api_key|access_token|token|signature|secret|password))=)[^&\s"']+/gi;
const JWT_LIKE = /eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]*/g;
function scrub(text, max) {
    const s = String(text == null ? '' : text).replace(JWT_LIKE, '***').replace(SECRET_QUERY, '$1***');
    return max && s.length > max ? s.slice(0, max) + '…' : s;
}

function isAdmin(user) {
    if (!user) return false;
    if (user.isAdmin === true) return true;
    return String(user.role || user.Role || '').trim().toLowerCase() === 'admin';
}

/** PocketBase "2026-11-06 04:00:06.867Z" (or ISO) → ISO string, else null. */
function iso(v) {
    if (!v) return null;
    const t = Date.parse(String(v).replace(' ', 'T'));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
const ms = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null; };
const pbDate = (t) => new Date(t).toISOString().replace('T', ' ');

/** When the sync will next pick a source up, as vm/sync/lib/schedule.js decides it. */
function nextDue(schedule, lastChecked, lastStatus) {
    const interval = INTERVAL_MS[schedule] || INTERVAL_MS.hourly;
    const last = ms(lastChecked);
    if (last == null) return null;
    let next;
    if (schedule === 'daily') {
        const day = 24 * HOUR;
        const istDayStart = Math.floor((last + IST_MS) / day) * day - IST_MS; // 00:00 IST of the last check's day
        const today2 = istDayStart + DAILY_HOUR_IST * HOUR;
        next = last < today2 ? today2 : today2 + day;
        next = Math.min(next, last + 26 * HOUR);
    } else {
        next = last + interval;
    }
    if (lastStatus === 'error') next = Math.min(next, last + Math.min(interval, HOUR));
    return next;
}

// ---- Static inventory (no network) --------------------------------------------------------------

async function loadInventory(appRoot, env, log) {
    const dir = path.join(appRoot, 'vm', 'sync', 'sources');
    const out = [];
    const problems = [];
    const add = (s, extra) => out.push(Object.assign({
        key: s.key, label: s.label || s.key, group: s.group || '', pages: s.pages || [],
        sourceType: s.sourceType || 'other', sourceUrl: s.sourceUrl || '', schedule: s.schedule || 'hourly',
        sensitive: !!s.sensitive, notes: s.notes || '', dataHubKeys: s.dataHubKeys || [], hasSnapshot: true
    }, extra || {}));
    try {
        const google = require(path.join(dir, 'google.js'));
        (google.SHEETS || []).forEach((d) => add({
            key: d.key, label: d.label, group: d.group, pages: d.pages, sourceType: 'google_sheet',
            sourceUrl: d.src && d.src.human, schedule: d.schedule, sensitive: d.sensitive, notes: d.notes,
            dataHubKeys: d.cache ? [d.cache] : []
        }, { via: d.src && d.src.ref ? d.src.ref.via : '' }));
    } catch (err) { problems.push('google.js: ' + err.message); }
    try {
        const sb = require(path.join(dir, 'supabase.js'));
        let insight = null;
        try { insight = sb.insightCfg(env); } catch (_) { insight = null; }
        const oldRef = (sb.OLD && sb.OLD.ref) || '';
        (sb.TABLES || []).forEach((d) => {
            const ref = d.insight && insight ? insight.ref : oldRef;
            add({
                key: d.key, label: d.label, group: d.group, pages: d.pages, sourceType: 'supabase_table',
                sourceUrl: `https://supabase.com/dashboard/project/${ref}/editor`, schedule: d.schedule || 'hourly',
                sensitive: d.sensitive, notes: d.notes, dataHubKeys: d.dataHubKeys
            }, { hasSnapshot: !!d.raw, table: `${d.schema}.${d.table}` });
        });
        const base = (sb.NEW && sb.NEW.url) || '';
        (sb.STORAGE || []).forEach((d) => add({
            key: d.key, label: d.label, group: d.group, pages: d.pages, sourceType: 'supabase_storage',
            sourceUrl: `${base}/storage/v1/object/public/${d.bucket}/${d.path}`, schedule: 'frequent',
            notes: d.notes, dataHubKeys: d.dataHubKeys
        }, { table: `${d.bucket}/${d.path}` }));
    } catch (err) { problems.push('supabase.js: ' + err.message); }
    try {
        // files.js builds its list in an async function, but only from constants (no network).
        const files = require(path.join(dir, 'files.js'));
        (await files.sources()).forEach((s) => add(s));
    } catch (err) { problems.push('files.js: ' + err.message); }
    if (problems.length && log) log.warn('[Sources] inventory: ' + problems.join('; '));
    return { list: out, problems };
}

// ---- Shell NAV (app.html) -----------------------------------------------------------------------

function parseNav(html) {
    const start = html.indexOf('var NAV = [');
    if (start < 0) return [];
    const end = html.indexOf('var LS', start);
    const block = html.slice(start, end > start ? end : undefined);
    const out = [];
    let group = '';
    block.split('\n').forEach((line) => {
        let m = line.match(/^\s*id:\s*'([^']+)',\s*label:\s*'([^']+)'/);
        if (m) { group = m[2]; return; }
        m = line.match(/^\s*\['([^']+)',\s*'((?:[^'\\]|\\.)*)',\s*'([^']+)'/);
        if (m) { out.push({ id: m[1], label: m[2].replace(/\\'/g, "'"), group, page: m[3] }); return; }
        m = line.match(/^\s*var\s+(HOME|BRIEFING|ASK)\s*=\s*\{\s*k:\s*'([^']+)',\s*n:\s*'([^']+)',\s*u:\s*'([^']+)'/);
        if (m) out.unshift({ id: m[2], label: m[3], group: '', page: m[4] });
    });
    return out;
}

// ---- PocketBase (read-only) ---------------------------------------------------------------------

function pbClient(env, fetchImpl) {
    const url = String(env.PB_URL || '').replace(/\/+$/, '');
    const email = env.PB_SUPERUSER_EMAIL;
    const password = env.PB_SUPERUSER_PASSWORD;
    if (!url || !email || !password) return null;
    let token = '';
    async function call(method, p, body) {
        const res = await fetchImpl(url + p, {
            method,
            headers: Object.assign({ Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}, token && !body ? { Authorization: token } : {}),
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(PB_TIMEOUT_MS)
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
        return { status: res.status, data };
    }
    async function auth() {
        const r = await call('POST', '/api/collections/_superusers/auth-with-password', { identity: email, password });
        if (r.status !== 200 || !r.data || !r.data.token) throw new Error(`PocketBase sign-in failed (HTTP ${r.status})`);
        token = r.data.token;
    }
    async function list(collection, query) {
        const qs = new URLSearchParams();
        Object.entries(query).forEach(([k, v]) => { if (v != null && v !== '') qs.set(k, String(v)); });
        const p = `/api/collections/${encodeURIComponent(collection)}/records?${qs}`;
        if (!token) await auth();
        let r = await call('GET', p);
        if (r.status === 401 || r.status === 403) { await auth(); r = await call('GET', p); }
        if (r.status !== 200) throw new Error(`PocketBase ${collection}: HTTP ${r.status}`);
        return (r.data && r.data.items) || [];
    }
    return { list, url };
}

async function readPocketBase(pb, now) {
    const datasets = await pb.list('sys_datasets', { perPage: 1000, skipTotal: 1, fields: DATASET_FIELDS });
    const keys = datasets.map((d) => d.key);
    const latest = {};
    const take = (rows) => rows.forEach((r) => { if (r.dataset && !latest[r.dataset]) latest[r.dataset] = r; });
    take(await pb.list('sys_sync_runs', {
        perPage: 1000, skipTotal: 1, sort: '-started_at', fields: RUN_FIELDS,
        filter: `started_at >= "${pbDate(now - 75 * MIN)}"`
    }));
    // Daily and hourly sources not run in the last hour and a quarter: their last run within 30 hours.
    const rest = keys.filter((k) => !latest[k] && /^[a-z0-9_]{1,64}$/.test(k));
    for (let i = 0; i < rest.length; i += 40) {
        const part = rest.slice(i, i + 40);
        take(await pb.list('sys_sync_runs', {
            perPage: 1000, skipTotal: 1, sort: '-started_at', fields: RUN_FIELDS,
            filter: `started_at >= "${pbDate(now - 30 * HOUR)}" && (${part.map((k) => `dataset = "${k}"`).join(' || ')})`
        }));
    }
    const failures = {};
    (await pb.list('sys_sync_runs', {
        perPage: 1000, skipTotal: 1, sort: '-started_at', fields: 'dataset,started_at,status,message',
        filter: `(status = "error" || status = "skipped") && started_at >= "${pbDate(now - 7 * 24 * HOUR)}"`
    })).forEach((r) => {
        const f = failures[r.dataset] || (failures[r.dataset] = { count: 0, last: r });
        f.count++;
    });
    return { datasets, latest, failures };
}

// ---- Build ------------------------------------------------------------------------------------

function create(options) {
    const opts = options || {};
    const appRoot = opts.appRoot || path.join(__dirname, '..');
    const env = opts.env || process.env;
    const mirror = opts.mirror || null;
    const log = opts.log || console;
    const fetchImpl = opts.fetch || ((...a) => fetch(...a));
    const live = opts.descriptor || require('./sources_live');
    const pb = opts.pb === undefined ? pbClient(env, fetchImpl) : opts.pb;
    let inventory = null;
    let nav = null;
    let cache = { at: 0, body: null };
    let building = null;

    function getInventory() {
        if (!inventory) inventory = loadInventory(appRoot, env, log);
        return inventory; // a promise, resolved once
    }
    function getNav() {
        if (!nav) {
            try { nav = parseNav(fs.readFileSync(path.join(appRoot, 'app.html'), 'utf8')); } catch (_) { nav = []; }
        }
        return nav;
    }

    async function build(now) {
        now = now || Date.now();
        const mirrorOn = !!(mirror && mirror.on && mirror.on());
        let man = null;
        if (mirrorOn) { try { man = await mirror.manifest(); } catch (_) { man = null; } }
        const manData = (man && man.data) || null;
        const manDatasets = (manData && manData.datasets) || {};

        let pbState = { configured: !!pb, ok: false, error: null };
        let reg = null;
        if (pb && mirrorOn) {
            try {
                reg = await readPocketBase(pb, now);
                pbState.ok = true;
            } catch (err) {
                pbState.error = scrub(err.message, 200);
                log.warn('[Sources] PocketBase:', pbState.error);
            }
        } else if (pb) {
            pbState.error = 'not read outside mirror mode';
        }
        const regByKey = {};
        ((reg && reg.datasets) || []).forEach((d) => { regByKey[d.key] = d; });

        const inv = await getInventory();
        const byKey = {};
        inv.list.forEach((s) => { byKey[s.key] = s; });
        // Keys the registry or manifest knows that the static inventory does not (e.g. tables found
        // through the OpenAPI root): shown from what they say about themselves.
        Object.keys(regByKey).concat(Object.keys(manDatasets)).forEach((k) => {
            if (byKey[k]) return;
            const r = regByKey[k] || {};
            const e = manDatasets[k] || {};
            byKey[k] = {
                key: k, label: r.label || e.label || k, group: r.group || '', pages: r.pages || [], sourceType: r.source_type || e.sourceType || 'other',
                sourceUrl: r.source_url || '', schedule: r.schedule || 'hourly', sensitive: e.sensitive === true, notes: r.notes || '',
                dataHubKeys: e.dataHubKeys || [], hasSnapshot: !!manDatasets[k], unlisted: true
            };
        });

        const overrides = live.OVERRIDES || {};
        const datasets = Object.keys(byKey).sort().map((k) => datasetRow(byKey[k], regByKey[k], manDatasets[k], reg, overrides[k], mirrorOn, now));
        (live.LIVE || []).forEach((d) => datasets.push(liveRow(d, mirrorOn, now)));

        const dsByKey = {};
        datasets.forEach((d) => { dsByKey[d.key] = d; });
        const reports = reportRows(getNav(), datasets, dsByKey, live);

        const categories = CATEGORIES.map((c) => Object.assign({}, c, {
            label: !mirrorOn && c.id === 'vm_only' ? 'Server only' : c.label,
            count: datasets.filter((d) => d.category === c.id).length
        })).filter((c) => c.count || c.id !== 'none');

        return {
            status: 'success',
            generatedAt: new Date(now).toISOString(),
            mode: mirrorOn ? 'mirror' : 'static',
            mirror: { on: mirrorOn, manifestAt: (manData && manData.generatedAt) || null, snapshots: Object.keys(manDatasets).length },
            pocketbase: pbState,
            timerMinutes: TIMER_MIN,
            schedules: Object.keys(SCHEDULE_TEXT).map((id) => ({ id, label: SCHEDULE_TEXT[id], minutes: INTERVAL_MS[id] / MIN })),
            categories,
            inventoryProblems: inv.problems,
            datasets,
            reports
        };
    }

    function datasetRow(s, r, e, reg, ov, mirrorOn, now) {
        r = r || null;
        e = e || null;
        ov = ov || {};
        const schedule = (r && r.schedule) || s.schedule || 'hourly';
        const copied = mirrorOn && !s.sensitive && s.hasSnapshot;
        let category;
        if (s.sourceType === 'json_file' || s.sourceType === 'other') category = 'vm_only';
        else if (copied) category = COPY_CATEGORY[s.sourceType] || 'vm_only';
        else category = LIVE_CATEGORY[s.sourceType] || 'external';
        if (ov.category && (mirrorOn || !COPY_CATEGORY[s.sourceType] || /^live_/.test(ov.category))) category = ov.category;
        const mode = r && r.mode === 'native' ? 'native' : 'mirror';

        const checkedAt = iso(r && r.last_checked_at) || iso(e && e.checkedAt);
        const fetchedAt = iso(r && r.last_fetched_at) || iso(e && e.fetchedAt);
        const syncedAt = iso(r && r.last_synced_at);
        const snapshotAt = iso(e && e.snapshotAt) || iso(r && r.snapshot_at);
        const sourceModifiedAt = iso(e && e.sourceModifiedAt) || iso(r && r.source_modified_at);
        const lastStatus = (r && r.last_status) || '';
        const run = reg && reg.latest[s.key];
        const fail = reg && reg.failures[s.key];

        const row = {
            key: s.key,
            label: (r && r.label) || s.label,
            group: (r && r.group) || s.group,
            category,
            sourceType: s.sourceType,
            via: s.via || '',
            sourceUrl: scrub((r && r.source_url) || s.sourceUrl || ''),
            table: s.table || '',
            schedule,
            scheduleText: SCHEDULE_TEXT[schedule] || schedule,
            sensitive: !!s.sensitive,
            mode,
            nativeSince: mode === 'native' ? iso(r.native_since) : null,
            nativeBy: mode === 'native' ? String(r.native_by || '') : '',
            copy: copied ? 'snapshot' : (r ? 'portal' : 'none'),
            inManifest: !!e,
            checkedAt,
            fetchedAt,
            syncedAt,
            snapshotAt,
            sourceModifiedAt,
            changedAt: sourceModifiedAt || snapshotAt || syncedAt,
            changedKnown: !!sourceModifiedAt,
            nextDueAt: null,
            lastStatus,
            lastError: r && r.last_error ? scrub(r.last_error, 600) : '',
            lastDurationMs: r && r.last_duration_ms != null ? Number(r.last_duration_ms) : null,
            lastRun: run ? {
                status: run.status, startedAt: iso(run.started_at), finishedAt: iso(run.finished_at),
                durationMs: run.duration_ms != null ? Number(run.duration_ms) : null, message: scrub(run.message, 400),
                rows: { total: run.rows_total, inserted: run.rows_inserted, updated: run.rows_updated, deleted: run.rows_deleted }
            } : null,
            failures7d: fail ? { count: fail.count, at: iso(fail.last.started_at), status: fail.last.status, message: scrub(fail.last.message, 400) } : null,
            rows: r && r.row_count != null ? Number(r.row_count) : (e && e.rows != null ? Number(e.rows) : null),
            bytes: e && e.bytes != null ? Number(e.bytes) : (r && r.snapshot_bytes ? Number(r.snapshot_bytes) : null),
            pages: Array.isArray(ov.pages) ? ov.pages : ((r && Array.isArray(r.pages) && r.pages.length ? r.pages : s.pages) || []),
            notes: [ov.note, s.notes].filter(Boolean).join(' '),
            dataHubKeys: s.dataHubKeys || [],
            refresh: '',
            origin: s.unlisted ? 'registry' : 'sync',
            overdue: false,
            stale: false,
            error: false,
            status: 'live'
        };

        if (!mirrorOn) {
            row.status = category === 'vm_only' ? 'info' : 'live';
            row.refresh = category === 'vm_only' ? 'Read from the server on request' : 'Read live from the source (no VM copy here)';
            return row;
        }
        // Copied into PocketBase (and a snapshot when the site reads it): the sync's schedule applies.
        const tracked = !!r;
        if (!tracked) {
            row.status = copied ? 'never' : 'live';
            row.refresh = copied ? 'Not synced yet' : 'Read live on each load';
            return row;
        }
        const next = nextDue(schedule, checkedAt, lastStatus);
        row.nextDueAt = next != null ? new Date(next).toISOString() : null;
        row.overdue = next != null && now > next + (GRACE_MS[schedule] || GRACE_MS.hourly);
        const good = /^(ok|unchanged)$/.test(lastStatus) ? ms(checkedAt) : (run && /^(ok|unchanged)$/.test(run.status) ? ms(iso(run.started_at)) : ms(fetchedAt));
        row.stale = good == null || now - good > (STALE_MS[schedule] || STALE_MS.hourly);
        row.error = lastStatus === 'error' || lastStatus === 'skipped';
        row.refresh = row.copy === 'snapshot' || category === 'vm_only' ? row.scheduleText : row.scheduleText + ' (portal copy; pages read live)';
        // Pages that read the live source never show a stale copy; the copy's state still shows in the flags.
        if (!CATEGORIES.find((c) => c.id === category).copied && category !== 'vm_only') {
            row.status = 'live';
        } else {
            row.status = lastStatus === 'error' ? 'error' : lastStatus === 'skipped' ? 'skipped' : row.overdue ? 'overdue' : row.stale ? 'stale' : 'ok';
        }
        // Held: the new copy looked incomplete, so the pages keep the previous good copy (Admin → Data quality).
        row.held = lastStatus === 'error' && HELD_ERROR.test(String((r && r.last_error) || ''));
        if (row.held && row.status === 'error') { row.status = 'held'; row.error = false; }
        if (mode === 'native') {
            // Edited on the VM: the VM copy is the original; the sync no longer pulls it.
            row.refresh = 'Edited on the VM (native)';
            row.nextDueAt = null;
            row.overdue = false;
            row.stale = false;
            if (row.status !== 'error') row.status = 'ok';
        }
        return row;
    }

    function liveRow(d, mirrorOn, now) {
        let status = d.category === 'none' ? 'info' : 'live';
        let checkNote = '';
        if (d.check && d.check.files) {
            // Files the server reads from its own disk: present or not.
            // data/ means the server's data folder: MZO_FILES_DIR on the VM, outside the release.
            const dir = (d.check.dir || 'data') === 'data' && env.MZO_FILES_DIR ? path.resolve(env.MZO_FILES_DIR) : path.join(appRoot, d.check.dir || 'data');
            let found = [];
            try { found = fs.readdirSync(dir).filter((f) => d.check.files.test(f)); } catch (_) { found = []; }
            let newest = null;
            found.forEach((f) => { try { const t = fs.statSync(path.join(dir, f)).mtimeMs; if (newest == null || t > newest) newest = t; } catch (_) { /* gone */ } });
            status = found.length ? 'ok' : 'missing';
            checkNote = found.length ? `${found.length} file(s) on the server` : 'No files on this server: the page shows nothing';
            d = Object.assign({}, d, { changedAt: newest != null ? new Date(newest).toISOString() : null });
        }
        if (d.check && d.check.env) {
            const names = [].concat(d.check.env);
            const set = names.some((n) => !!String(env[n] || '').trim());
            status = set ? 'live' : 'off';
            checkNote = set ? '' : `${names.join(' or ')} ${names.length > 1 ? 'are' : 'is'} not set on this server: the feature does not work here`;
        }
        if (d.check && d.check.snapshotFile && mirrorOn && mirror && mirror.dir) {
            try {
                const st = fs.statSync(path.join(mirror.dir, d.check.snapshotFile));
                status = 'ok';
                d = Object.assign({}, d, { changedAt: new Date(st.mtimeMs).toISOString() });
            } catch (_) {
                status = 'missing';
                checkNote = 'Not built yet on this server';
            }
        } else if (d.check && d.check.snapshotFile) {
            status = 'info';
            checkNote = 'Outside mirror mode the page computes it in the browser';
        }
        return {
            key: d.key,
            label: d.label,
            group: d.group || '',
            category: d.category,
            sourceType: d.sourceType || 'other',
            via: d.via || '',
            sourceUrl: d.url || '',
            table: d.table || '',
            schedule: '',
            scheduleText: d.refresh || '',
            sensitive: !!d.sensitive,
            mode: 'mirror',
            nativeSince: null,
            nativeBy: '',
            copy: 'none',
            inManifest: false,
            checkedAt: null,
            fetchedAt: null,
            syncedAt: null,
            snapshotAt: null,
            sourceModifiedAt: null,
            changedAt: d.changedAt || null,
            changedKnown: false,
            nextDueAt: null,
            lastStatus: '',
            lastError: '',
            lastDurationMs: null,
            lastRun: null,
            failures7d: null,
            rows: null,
            bytes: null,
            pages: d.pages || [],
            notes: [d.notes, checkNote].filter(Boolean).join(' '),
            dataHubKeys: [],
            refresh: d.refresh || '',
            origin: 'descriptor',
            overdue: false,
            stale: false,
            error: status === 'missing' || status === 'off',
            status
        };
    }

    function reportRows(navItems, datasets, dsByKey, desc) {
        const alias = desc.PAGE_ALIASES || {};
        const norm = (p) => { const s = String(p || '').replace(/^\/+/, ''); return alias[s] || s; };
        const usedBy = {};
        datasets.forEach((d) => (d.pages || []).forEach((p) => { (usedBy[norm(p)] = usedBy[norm(p)] || []).push(d.key); }));
        const seen = {};
        const out = [];
        navItems.forEach((item) => {
            const page = norm(item.page);
            if (seen[page]) { seen[page].alsoIn.push(item.group); return; }
            const extra = (desc.REPORTS || {})[page] || {};
            const drop = new Set(extra.drop || []);
            const keys = [];
            (usedBy[page] || []).concat(extra.add || []).forEach((k) => { if (!drop.has(k) && dsByKey[k] && keys.indexOf(k) < 0) keys.push(k); });
            // Sources this page reads from the original although the mirror has a copy count as live here.
            const liveHere = new Set((extra.live || []).filter((k) => keys.indexOf(k) >= 0));
            const src = keys.map((k) => {
                const d = dsByKey[k];
                if (!liveHere.has(k) || !COPY_CATEGORY[d.sourceType]) return d;
                return Object.assign({}, d, { category: LIVE_CATEGORY[d.sourceType], status: 'live', overdue: false, stale: false, error: false, checkedAt: null });
            });
            const cats = [];
            src.forEach((d) => { if (cats.indexOf(d.category) < 0) cats.push(d.category); });
            if (!cats.length) cats.push(extra.category || 'none');
            cats.sort((a, b) => CATEGORIES.findIndex((c) => c.id === a) - CATEGORIES.findIndex((c) => c.id === b));
            const copiedSrc = src.filter((d) => d.checkedAt && d.copy === 'snapshot' || d.category === 'vm_only' && d.checkedAt);
            let oldest = null;
            copiedSrc.forEach((d) => { if (!oldest || ms(d.checkedAt) < ms(oldest.checkedAt)) oldest = d; });
            let worst = src.length ? 'live' : 'info';
            src.forEach((d) => { if ((STATUS_RANK[d.status] || 0) > (STATUS_RANK[worst] || 0)) worst = d.status; });
            const row = {
                id: item.id,
                label: item.label,
                group: item.group,
                alsoIn: [],
                page,
                category: extra.category || (cats.length === 1 ? cats[0] : 'mixed'),
                categories: cats,
                sources: keys,
                liveHere: Array.from(liveHere),
                freshAt: oldest ? oldest.checkedAt : null,
                oldestKey: oldest ? oldest.key : '',
                changedAt: null,
                status: worst,
                note: extra.note || ''
            };
            let lastChange = null;
            src.forEach((d) => { if (d.changedAt && (!lastChange || ms(d.changedAt) > ms(lastChange))) lastChange = d.changedAt; });
            row.changedAt = lastChange;
            seen[page] = row;
            out.push(row);
        });
        return out;
    }

    async function cached(force) {
        if (!force && cache.body && Date.now() - cache.at < CACHE_MS) return cache.body;
        if (building) return building;
        building = build().then((body) => { cache = { at: Date.now(), body }; return body; }).finally(() => { building = null; });
        return building;
    }

    async function handler(req, res) {
        if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
        if (!isAdmin(req.user)) return res.status(403).json({ status: 'error', message: 'Forbidden: Admin access required.' });
        try {
            const body = await cached(req.query && req.query.refresh === '1');
            res.setHeader('Cache-Control', 'private, no-store');
            return res.json(body);
        } catch (err) {
            log.error('[Sources] build failed:', err.message);
            return res.status(500).json({ status: 'error', message: 'Sources info unavailable.' });
        }
    }

    return { handler, build, cached, isAdmin };
}

module.exports = { create, isAdmin, nextDue, parseNav, scrub, INTERVAL_MS, CATEGORIES };
