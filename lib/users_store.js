'use strict';
/* lib/users_store.js: the VM's own user accounts, sign-in and activity log in PocketBase
 * (MZO_USER_STORE=pocketbase). Off everywhere else: Vercel and a local checkout keep the Supabase
 * portal_users path in server.js. Design, schema and rules: docs/users.md.
 *
 *   const store = create({ env, secret, localAdmins, appRoot })
 *   store.on                          true only with MZO_USER_STORE=pocketbase
 *   app.use(store.context)            remembers the request (IP, user agent) for activity rows
 *   store.mount(app, deps)            the /api/auth and /api/admin user routes for this store, seeding
 *   await store.ready()               the in-memory user list is loaded (refreshed in the background)
 *   store.profileForSession(s, local) the signed-in user's current profile, or null (revoked, disabled)
 *   store.pageAllowed(profile, path)  false for a report page outside the user's modules
 *   store.logActivity(entry)          queue an activity row (written in batches)
 *   store.legacyUsers()               every user as a legacy profile (server.js getLoginCredentials)
 *
 * server.js is the only client: it signs in to PocketBase as the superuser (PB_URL, PB_SUPERUSER_EMAIL,
 * PB_SUPERUSER_PASSWORD) and the collections' API rules are all null. Server-only (PRIVATE_PATH).
 */
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const offices = require('./offices');
const reportModules = require('./report_modules');
const googleAuth = require('./google_auth');
const { clientIp } = require('./local_admins');

// The accounts that are always active admins in this store. MZO_ADMIN_EMAILS (comma-separated)
// replaces this list; server.js's ROOT_ADMIN_EMAILS are always added. Change it here or in
// /etc/mzo/app.env, nowhere else.
const DEFAULT_ADMIN_EMAILS = ['dipnkr.das@gmail.com'];

const USERS = 'app_users';
const ACTIVITY = 'app_activity';
const AUDIT = 'app_user_audit';

const ROLES = ['admin', 'editor', 'viewer'];
const STATUSES = ['pending', 'active', 'disabled', 'rejected'];
const LEVELS = ['zone', 'region', 'division', 'ccc'];
// Office tier the admin page shows for each scope level (legacy office_level values).
const LEVEL_TIER = { zone: 'CE', region: 'SE', division: 'DE', ccc: 'CCC' };
const TIER_LEVEL = { CE: 'zone', SE: 'region', DE: 'division', AE: 'ccc', CCC: 'ccc' };

// Per-feature grants the pages and server.js already read from the profile, by their snake_case names.
// The profile carries them in the legacy kebab form ('nsc-upload-autho').
const FLAG_KEYS = [
    'nsc_autho', 'dd_autho', 'ss_autho', 'dtr_autho',
    'nsc_upload_autho', 'stock_upload_autho', 'stock_allot_autho', 'stock_cancel_autho',
    'defective_upload_autho', 'disconnection_sync_autho', 'pending_mc_sync_autho', 'load_ext_sync_autho',
    'unbilled_sync_autho', 'si_autho', 'si_divisions', 'sheets_autho'
];
// upload_permissions words (approval workbench) -> flag.
const UPLOAD_FLAGS = {
    disconnection: 'disconnection_sync_autho', pending_mc: 'pending_mc_sync_autho', load_ext: 'load_ext_sync_autho',
    defective: 'defective_upload_autho', nsc: 'nsc_upload_autho', stock: 'stock_upload_autho',
    stock_allot: 'stock_allot_autho', stock_cancel: 'stock_cancel_autho'
};
const ADMIN_FLAGS = Object.assign(
    Object.fromEntries(Object.values(UPLOAD_FLAGS).map((k) => [k, 'Y'])),
    { sheets_autho: 'edit', can_comment: true }
);

const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const CACHE_MS = 30 * 1000;
const SEEN_EVERY_MS = 5 * 60 * 1000;
const PENDING_COOKIE = 'mzo_pending';
const PENDING_MAX_AGE_S = 30 * 24 * 3600;

class UserError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const kebab = (k) => k.replace(/_/g, '-');
const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();
const clip = (v, max) => String(v == null ? '' : v).slice(0, max);
const isoOf = (pbDate) => (pbDate ? String(pbDate).replace(' ', 'T') : '');
const yes = (v) => ['y', 'yes', '1', 'true', 'upload', 'sync', 'allot', 'cancel'].includes(lower(v));

function parseEmailList(raw) {
    return String(raw || '').split(/[,;\s]+/).map(lower).filter((e) => EMAIL_RE.test(e));
}

// ---- PocketBase REST client (superuser) -----------------------------------------------------------
class Pb {
    constructor({ url, email, password }) {
        this.url = String(url || '').replace(/\/+$/, '');
        this.email = email;
        this.password = password;
        this.token = '';
        this.authing = null;
    }

    async auth() {
        if (!this.authing) {
            this.authing = this.raw('POST', '/api/collections/_superusers/auth-with-password', { identity: this.email, password: this.password }, false)
                .then((r) => { this.token = r.token; })
                .finally(() => { this.authing = null; });
        }
        return this.authing;
    }

    async raw(method, path, body, withAuth = true) {
        const headers = { Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (withAuth && this.token) headers.Authorization = this.token;
        const res = await globalThis.fetch(this.url + path, {
            method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000)
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
        if (!res.ok) {
            const err = new Error(`PocketBase ${method} ${path.split('?')[0]}: HTTP ${res.status} ${data && data.message ? data.message : ''}`.trim());
            err.status = res.status;
            err.data = data;
            throw err;
        }
        return data;
    }

    async req(method, path, body) {
        if (!this.token) await this.auth();
        try {
            return await this.raw(method, path, body);
        } catch (err) {
            if (err.status !== 401) throw err;
            await this.auth();
            return this.raw(method, path, body);
        }
    }

    records(coll) { return `/api/collections/${coll}/records`; }
    list(coll, q) { return this.req('GET', `${this.records(coll)}?${new URLSearchParams(q)}`); }
    create(coll, body) { return this.req('POST', this.records(coll), body); }
    update(coll, id, body) { return this.req('PATCH', `${this.records(coll)}/${encodeURIComponent(id)}`, body); }
    remove(coll, id) { return this.req('DELETE', `${this.records(coll)}/${encodeURIComponent(id)}`); }
    batch(requests) { return this.req('POST', '/api/batch', { requests }); }
    collection(name) { return this.req('GET', `/api/collections/${encodeURIComponent(name)}`); }

    async all(coll, { filter = '', sort = '', fields = '', perPage = 500, max = 100000 } = {}) {
        const out = [];
        for (let page = 1; out.length < max; page++) {
            const q = { page: String(page), perPage: String(perPage), skipTotal: '1' };
            if (filter) q.filter = filter;
            if (sort) q.sort = sort;
            if (fields) q.fields = fields;
            const r = await this.list(coll, q);
            const items = (r && r.items) || [];
            out.push(...items);
            if (items.length < perPage) break;
        }
        return out.slice(0, max);
    }
}

/** A PocketBase filter string literal. */
function q(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** PocketBase's date format (UTC). */
function pbDate(d) {
    return new Date(d).toISOString().replace('T', ' ');
}

// ---- Office scope -----------------------------------------------------------------------------------
const REGION_NAMES = offices.REGIONS.map((r) => r.name);
const DIVISIONS = offices.DIVISIONS;
const CCCS = offices.CCCS;

function findRegion(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    const exact = REGION_NAMES.find((n) => n.toLowerCase() === s.toLowerCase());
    if (exact) return exact;
    const p = offices.parseRegion(s);
    return p && p.level === 'region' ? p.region : null;
}

function findDivision(v) {
    const s = String(v || '').trim();
    if (!s) return null;
    const exact = DIVISIONS.find((d) => d.name.toLowerCase() === s.toLowerCase().replace(/\s+div(ision|\.)?$/i, ''));
    if (exact) return exact;
    const p = offices.parseDivision(s);
    return p && p.level === 'division' ? DIVISIONS.find((d) => d.name === p.division) || null : null;
}

function findCcc(v, divisionName) {
    const s = String(v || '').trim();
    if (!s) return null;
    if (/^\d{7}$/.test(s)) return CCCS.find((c) => c.code === s) || null;
    const exact = CCCS.filter((c) => c.name.toLowerCase() === s.toLowerCase());
    const pick = exact.find((c) => !divisionName || c.division === divisionName) || exact[0];
    if (pick) return pick;
    const p = offices.parseCccName(s);
    return p && p.level === 'ccc' ? CCCS.find((c) => c.code === p.ccc_code) || null : null;
}

/**
 * A complete, consistent scope from a level and office values (names or a CCC code), or a 400.
 * The parents of a division or CCC come from lib/offices.js; ones that were given must agree.
 */
function validateScope(level, regionIn, divisionIn, cccIn) {
    const lv = lower(level);
    if (!LEVELS.includes(lv)) throw new UserError(400, 'Office scope must be zone, region, division or ccc.');
    const has = (v) => String(v || '').trim() !== '';
    const region = has(regionIn) ? findRegion(regionIn) : '';
    if (region === null) throw new UserError(400, `Unknown region: ${regionIn}.`);
    const division = has(divisionIn) ? findDivision(divisionIn) : '';
    if (division === null) throw new UserError(400, `Unknown division: ${divisionIn}.`);
    if (lv === 'zone') {
        if (region || division || has(cccIn)) throw new UserError(400, 'A zone scope takes no region, division or CCC.');
        return { scope_level: 'zone', region: '', division: '', ccc_code: '' };
    }
    if (lv === 'region') {
        if (!region) throw new UserError(400, 'Choose the region.');
        if (division || has(cccIn)) throw new UserError(400, 'A region scope takes no division or CCC.');
        return { scope_level: 'region', region, division: '', ccc_code: '' };
    }
    if (lv === 'division') {
        if (!division) throw new UserError(400, 'Choose the division.');
        if (has(cccIn)) throw new UserError(400, 'A division scope takes no CCC.');
        if (region && region !== division.region) throw new UserError(400, `${division.name} division is in ${division.region} region, not ${region}.`);
        return { scope_level: 'division', region: division.region, division: division.name, ccc_code: '' };
    }
    const ccc = findCcc(cccIn, division ? division.name : '');
    if (!ccc) throw new UserError(400, has(cccIn) ? `Unknown CCC: ${cccIn}.` : 'Choose the CCC.');
    if (division && division.name !== ccc.division) throw new UserError(400, `${ccc.name} CCC is in ${ccc.division} division, not ${division.name}.`);
    if (region && region !== ccc.region) throw new UserError(400, `${ccc.name} CCC is in ${ccc.region} region, not ${region}.`);
    return { scope_level: 'ccc', region: ccc.region, division: ccc.division, ccc_code: ccc.code };
}

/**
 * The scope an admin payload asks for, or undefined when it does not touch the scope. Takes the new
 * form (scope_level, region, division, ccc_code) or the admin page's legacy one (zone_code,
 * region_code, division_code, ccc_code as office names), where the most specific office sets the level.
 */
function scopeFromBody(body) {
    if (body.scope_level !== undefined) return validateScope(body.scope_level, body.region, body.division, body.ccc_code);
    const legacy = ['zone_code', 'region_code', 'division_code', 'ccc_code'];
    if (!legacy.some((k) => body[k] !== undefined)) return undefined;
    const has = (k) => String(body[k] || '').trim() !== '';
    const level = has('ccc_code') ? 'ccc' : has('division_code') ? 'division' : has('region_code') ? 'region' : 'zone';
    return validateScope(level, body.region_code, body.division_code, body.ccc_code);
}

// ---- Record <-> profile ----------------------------------------------------------------------------
function flagsOf(rec) {
    const f = rec && rec.feature_flags && typeof rec.feature_flags === 'object' ? rec.feature_flags : {};
    const out = {};
    for (const k of FLAG_KEYS) out[k] = clip(f[k] == null ? '' : f[k], 2000).trim();
    out.can_comment = !!f.can_comment;
    return out;
}

function legacyStatus(status) {
    return status === 'disabled' ? 'suspended' : status;
}

function scopeOf(rec) {
    if (rec.role === 'admin') return { level: 'zone', region: '', division: '', ccc_code: '', ccc: '' };
    const level = LEVELS.includes(rec.scope_level) ? rec.scope_level : '';
    const ccc = rec.ccc_code ? CCCS.find((c) => c.code === rec.ccc_code) : null;
    return {
        level,
        // A record saved under an old region name (Raiganj, Balurghat) is shown and scoped under the
        // current one; the stored value is left as it is.
        region: level && level !== 'zone' ? offices.canonRegion(rec.region) || rec.region || '' : '',
        division: level === 'division' || level === 'ccc' ? rec.division || '' : '',
        ccc_code: level === 'ccc' ? rec.ccc_code || '' : '',
        ccc: level === 'ccc' && ccc ? ccc.name : ''
    };
}

/**
 * The session profile the pages and server.js read: the legacy portal fields (Username, Name, role,
 * zone/region/division/ccc_code as office names, office_level, kebab-case flags, upload_permissions)
 * plus email, isAdmin, status, scope_level, scope_ccc_code, modules and uid.
 */
function toProfile(rec) {
    const isAdmin = rec.role === 'admin';
    const flags = isAdmin ? Object.assign(flagsOf(rec), ADMIN_FLAGS) : flagsOf(rec);
    const scope = scopeOf(rec);
    const p = {
        Username: rec.username,
        Name: rec.name || rec.username,
        email: lower(rec.email),
        role: ROLES.includes(rec.role) ? rec.role : 'viewer',
        isAdmin,
        uid: rec.id,
        status: rec.status,
        user_status: legacyStatus(rec.status),
        auth_provider: 'google',
        zone_code: scope.level ? 'MZO' : '',
        region_code: scope.region,
        division_code: scope.division,
        ccc_code: scope.ccc,
        office_level: scope.level ? LEVEL_TIER[scope.level] : '',
        scope_level: scope.level,
        scope_ccc_code: scope.ccc_code,
        modules: !isAdmin && Array.isArray(rec.modules) ? rec.modules.slice() : null,
        LastLogin: isoOf(rec.last_login_at),
        requested_at: isoOf(rec.requested_at),
        approved_by: rec.approved_by || '',
        approved_at: isoOf(rec.approved_at),
        designation: rec.designation || '',
        photo_url: rec.photo_url || ''
    };
    for (const k of FLAG_KEYS) p[kebab(k)] = flags[k];
    p.can_comment = flags.can_comment;
    p.upload_permissions = Object.keys(UPLOAD_FLAGS).filter((w) => yes(flags[UPLOAD_FLAGS[w]]));
    return p;
}

/** What Admin -> Users shows: the profile plus the account's own fields. */
function toAdminUser(rec, seeded) {
    return Object.assign(toProfile(rec), {
        phone: rec.phone || '',
        employee_id: rec.employee_id || '',
        notes: rec.notes || '',
        disabled_reason: rec.disabled_reason || '',
        login_count: rec.login_count || 0,
        last_seen_at: isoOf(rec.last_seen_at),
        created: isoOf(rec.created),
        updated: isoOf(rec.updated),
        google_linked: !!rec.google_sub,
        seeded: !!seeded
    });
}

// ---- The store --------------------------------------------------------------------------------------
function create(options) {
    const opts = options || {};
    const env = opts.env || process.env;
    const log = opts.log || console;
    const clock = opts.now || Date.now; // the retention prune's clock (tests move it forward)
    const on = lower(env.MZO_USER_STORE) === 'pocketbase';
    const off = { on: false };
    if (!on) return off;

    const secret = String(opts.secret || '');
    const localAdmins = opts.localAdmins || { isLocalUsername: () => false };
    const modules = reportModules.load(opts.appRoot || process.cwd());
    const retentionDays = Math.max(7, Number(env.MZO_ACTIVITY_RETENTION_DAYS) || 180);
    const configured = !!(env.PB_URL && env.PB_SUPERUSER_EMAIL && env.PB_SUPERUSER_PASSWORD);
    const pb = new Pb({ url: env.PB_URL, email: env.PB_SUPERUSER_EMAIL, password: env.PB_SUPERUSER_PASSWORD });
    const als = new AsyncLocalStorage();
    const envAdmins = parseEmailList(env.MZO_ADMIN_EMAILS);
    let seedAdmins = new Set(envAdmins.length ? envAdmins : DEFAULT_ADMIN_EMAILS);

    if (!configured) log.error('[Users] MZO_USER_STORE=pocketbase but PB_URL / PB_SUPERUSER_EMAIL / PB_SUPERUSER_PASSWORD are not all set: sign-in is unavailable.');

    // In-memory copy of app_users: server.js is the only writer, so it is updated on every write and
    // reloaded every CACHE_MS for edits made elsewhere (the PocketBase dashboard).
    let byId = new Map();
    let loadedAt = 0;
    let loading = null;
    let initDone = false;

    function setCache(list) {
        byId = new Map(list.map((r) => [r.id, r]));
        loadedAt = Date.now();
    }
    function put(rec) { byId.set(rec.id, rec); }
    function findBy(field, value) {
        const v = lower(value);
        if (!v) return null;
        for (const r of byId.values()) if (lower(r[field]) === v) return r;
        return null;
    }

    async function reload() {
        if (!loading) {
            loading = pb.all(USERS, { sort: 'username' })
                .then((list) => { setCache(list); return list; })
                .finally(() => { loading = null; });
        }
        return loading;
    }

    let failedAt = 0;
    async function ready() {
        if (!configured) return;
        if (!loadedAt) {
            // Not loaded yet: try, but at most every 5 s while PocketBase is down.
            if (Date.now() - failedAt < 5000) return;
            try {
                await reload();
            } catch (err) {
                failedAt = Date.now();
                throw err;
            }
            return;
        }
        if (Date.now() - loadedAt > CACHE_MS && !loading) {
            reload().catch((err) => {
                log.warn('[Users] reload failed, keeping the last list:', err.message);
                loadedAt = Date.now() - CACHE_MS + 5000; // retry in 5 s
            });
        }
    }

    /** One user, read from PocketBase (not the cache): sign-in and admin writes use it. */
    async function fetchOne(field, value) {
        const r = await pb.list(USERS, { filter: `${field} = ${q(value)}`, perPage: '1', skipTotal: '1' });
        const rec = r && r.items && r.items[0];
        if (rec) put(rec);
        return rec || null;
    }

    function actorOf(user) {
        if (!user) return { email: '', name: 'system' };
        return { email: lower(user.email), name: user.Name || user.Username || '' };
    }

    function requestInfo() {
        const req = als.getStore();
        if (!req) return { ip: '', ua: '' };
        return { ip: clip(clientIp(req), 64), ua: clip(req.headers['user-agent'] || '', 400) };
    }

    async function audit(rec, action, actor, changes, reason) {
        try {
            await pb.create(AUDIT, {
                user_email: rec.email, username: rec.username || '', actor_email: actor.email, actor_name: clip(actor.name, 200),
                action, changes: changes || [], reason: clip(reason || '', 500), ip: requestInfo().ip
            });
        } catch (err) {
            log.error('[Users] audit write failed:', err.message);
        }
    }

    // ---- Activity log: queued, written in batches ----
    let queue = [];
    let flushTimer = null;
    let flushing = null;

    function logActivity(activity) {
        if (!configured) return Promise.resolve();
        const a = activity || {};
        const { ip, ua } = requestInfo();
        const req = als.getStore();
        const who = (req && req.user) || null;
        const username = clip(a.username, 100);
        const sameUser = who && lower(who.Username) === lower(username);
        const type = clip(a.type || 'event', 50);
        const text = clip(a.details, 1000);
        const pageMatch = type === 'page_visit' ? /^Visited page:\s*(\S+)/.exec(text) : null;
        const row = {
            user_email: clip(a.email != null ? lower(a.email) : (sameUser ? lower(who.email) : ''), 254),
            username,
            user_name: clip(a.name, 200),
            action: type,
            page: clip(a.page || (pageMatch ? pageMatch[1] : ''), 300),
            details: Object.assign({ text }, a.data && typeof a.data === 'object' ? a.data : {}),
            ip,
            user_agent: ua
        };
        if (!row.user_email) {
            const rec = findBy('username', username);
            if (rec) row.user_email = rec.email;
        }
        if (type === 'page_visit') touchSeen(row.user_email);
        else if (localAdmins.isLocalUsername(username)) log.log(`[Activity] ${username} ${type}: ${text}`);
        queue.push(row);
        if (queue.length > 5000) queue = queue.slice(-5000);
        if (!flushTimer) {
            flushTimer = setTimeout(() => { flushTimer = null; flush().catch(() => {}); }, 1000);
            if (flushTimer.unref) flushTimer.unref();
        }
        return Promise.resolve();
    }

    async function flush() {
        if (flushing) await flushing;
        if (!queue.length) return;
        const rows = queue.splice(0, 500);
        flushing = (async () => {
            try {
                await pb.batch(rows.map((body) => ({ method: 'POST', url: pb.records(ACTIVITY), body })));
            } catch (err) {
                // One by one, so a single bad row does not lose the rest.
                for (const body of rows) {
                    try { await pb.create(ACTIVITY, body); } catch (e) { log.error('[Activity] write failed:', e.message); break; }
                }
            }
        })();
        try { await flushing; } finally { flushing = null; }
        if (queue.length) return flush();
    }

    const seenAt = new Map();
    function touchSeen(email) {
        const rec = email ? findBy('email', email) : null;
        if (!rec) return;
        const now = Date.now();
        const last = Math.max(seenAt.get(rec.id) || 0, Date.parse(isoOf(rec.last_seen_at)) || 0);
        if (now - last < SEEN_EVERY_MS) return;
        seenAt.set(rec.id, now);
        pb.update(USERS, rec.id, { last_seen_at: pbDate(now) }).then(put).catch((err) => log.warn('[Users] last_seen update failed:', err.message));
    }

    async function prune() {
        const cutoff = pbDate(clock() - retentionDays * 86400000);
        let removed = 0;
        for (let round = 0; round < 20; round++) {
            const r = await pb.list(ACTIVITY, { filter: `created < ${q(cutoff)}`, fields: 'id', perPage: '500', skipTotal: '1', sort: 'created' });
            const ids = ((r && r.items) || []).map((x) => x.id);
            if (!ids.length) break;
            await pb.batch(ids.map((id) => ({ method: 'DELETE', url: `${pb.records(ACTIVITY)}/${id}` })));
            removed += ids.length;
            if (ids.length < 500) break;
        }
        if (removed) log.log(`[Activity] pruned ${removed} rows older than ${retentionDays} days`);
        return removed;
    }

    // ---- Accounts ----
    function isSeed(email) { return seedAdmins.has(lower(email)); }

    async function uniqueUsername(wanted, email) {
        let base = lower(wanted || String(email).split('@')[0]).replace(/[^a-z0-9_.-]/g, '').slice(0, 50) || 'user';
        let name = base;
        for (let i = 1; ; i++) {
            const taken = findBy('username', name) || (await fetchOne('username', name)) || localAdmins.isLocalUsername(name);
            if (!taken) return name;
            name = `${base}${i}`;
        }
    }

    async function seed() {
        for (const email of seedAdmins) {
            let rec = await fetchOne('email', email);
            if (!rec) {
                rec = await pb.create(USERS, {
                    email, username: await uniqueUsername('', email), role: 'admin', status: 'active', scope_level: 'zone',
                    session_version: 1, approved_by: 'seed', approved_at: pbDate(Date.now()), requested_at: pbDate(Date.now())
                });
                put(rec);
                await audit(rec, 'seed', { email: '', name: 'seed' }, [{ field: 'role', from: null, to: 'admin' }, { field: 'status', from: null, to: 'active' }], 'built-in admin');
                log.log(`[Users] seeded admin ${email}`);
            } else if (rec.role !== 'admin' || rec.status !== 'active') {
                const changes = [];
                if (rec.role !== 'admin') changes.push({ field: 'role', from: rec.role, to: 'admin' });
                if (rec.status !== 'active') changes.push({ field: 'status', from: rec.status, to: 'active' });
                rec = await pb.update(USERS, rec.id, { role: 'admin', status: 'active', scope_level: 'zone', region: '', division: '', ccc_code: '' });
                put(rec);
                await audit(rec, 'seed', { email: '', name: 'seed' }, changes, 'built-in admin');
                log.log(`[Users] restored built-in admin ${email}`);
            }
        }
    }

    async function init(rootAdmins) {
        if (!configured || initDone) return;
        for (const e of rootAdmins || []) if (EMAIL_RE.test(lower(e))) seedAdmins.add(lower(e));
        for (let attempt = 0; ; attempt++) {
            try {
                for (const c of [USERS, ACTIVITY, AUDIT]) await pb.collection(c);
                await seed();
                await reload();
                initDone = true;
                log.log(`[Users] PocketBase user store ready: ${byId.size} users, built-in admins: ${[...seedAdmins].join(', ')}`);
                break;
            } catch (err) {
                if (attempt === 0 || attempt % 30 === 0) log.error('[Users] PocketBase user store not ready (retrying every 10 s):', err.message);
                await new Promise((r) => { const t = setTimeout(r, 10000); if (t.unref) t.unref(); });
            }
        }
        const t1 = setTimeout(() => prune().catch((e) => log.warn('[Activity] prune failed:', e.message)), 120000);
        const t2 = setInterval(() => prune().catch((e) => log.warn('[Activity] prune failed:', e.message)), 6 * 3600 * 1000);
        if (t1.unref) t1.unref();
        if (t2.unref) t2.unref();
    }

    /** Field-level changes from an admin payload; throws a UserError for anything invalid. */
    function buildPatch(rec, body, actorUser) {
        const patch = {};
        const self = actorUser && lower(actorUser.email) && lower(actorUser.email) === lower(rec.email);
        // Identity fields
        const text = { name: ['Name', 'name', 200], phone: ['phone', 'phone', 20], designation: ['designation', 'designation', 120],
            employee_id: ['employee_id', 'employee_id', 40], notes: ['notes', 'notes', 2000], disabled_reason: ['disabled_reason', 'disabled_reason', 500] };
        for (const [field, [a, b, max]] of Object.entries(text)) {
            const v = body[a] !== undefined ? body[a] : body[b];
            if (v !== undefined) patch[field] = clip(String(v == null ? '' : v).trim(), max);
        }
        if (body.email !== undefined && lower(body.email) !== lower(rec.email)) {
            const email = lower(body.email);
            if (!EMAIL_RE.test(email)) throw new UserError(400, 'Enter a valid email address.');
            if (isSeed(rec.email)) throw new UserError(400, `${rec.email} is a built-in admin; its email cannot change.`);
            patch.email = email;
            patch.google_sub = '';
        }
        // Role
        if (body.role !== undefined) {
            const r = lower(body.role);
            const role = r === 'admin' ? 'admin' : r === 'editor' ? 'editor' : 'viewer';
            if (role !== rec.role) {
                if (isSeed(rec.email)) throw new UserError(400, `${rec.email} is a built-in admin (MZO_ADMIN_EMAILS); it stays an admin.`);
                if (self) throw new UserError(400, 'You cannot change your own role.');
            }
            patch.role = role;
        }
        // Status
        const statusIn = body.status !== undefined ? body.status : body.user_status;
        if (statusIn !== undefined) {
            const s = lower(statusIn) === 'suspended' ? 'disabled' : lower(statusIn);
            if (!STATUSES.includes(s)) throw new UserError(400, 'Status must be pending, active, disabled or rejected.');
            if (s !== rec.status) {
                if (isSeed(rec.email) && s !== 'active') throw new UserError(400, `${rec.email} is a built-in admin (MZO_ADMIN_EMAILS); it cannot be disabled here.`);
                if (self && s !== 'active') throw new UserError(400, 'You cannot disable your own account.');
            }
            patch.status = s;
        }
        // Scope
        const role = patch.role || rec.role;
        let scope = scopeFromBody(body);
        if (role === 'admin') scope = { scope_level: 'zone', region: '', division: '', ccc_code: '' };
        if (scope) Object.assign(patch, scope);
        // Modules
        if (body.modules !== undefined) {
            if (body.modules === null || body.modules === 'all') patch.modules = null;
            else if (Array.isArray(body.modules)) {
                const keys = [...new Set(body.modules.map(String))];
                const unknown = keys.filter((k) => !modules.byKey.has(k));
                if (unknown.length) throw new UserError(400, `Unknown report key(s): ${unknown.join(', ')}.`);
                patch.modules = keys;
            } else throw new UserError(400, 'modules must be null (every report) or a list of report keys.');
        }
        // Feature flags (only the keys the payload carries change)
        const flags = flagsOf(rec);
        let flagsTouched = false;
        for (const k of FLAG_KEYS) {
            const v = body[kebab(k)] !== undefined ? body[kebab(k)] : body[k];
            if (v !== undefined) { flags[k] = clip(String(v == null ? '' : v).trim(), 2000); flagsTouched = true; }
        }
        if (Array.isArray(body.upload_permissions)) {
            for (const [w, k] of Object.entries(UPLOAD_FLAGS)) flags[k] = body.upload_permissions.includes(w) ? 'Y' : '';
            flagsTouched = true;
        }
        if (body.can_comment !== undefined || body['can-comment'] !== undefined) {
            flags.can_comment = !!(body.can_comment !== undefined ? body.can_comment : body['can-comment']);
            flagsTouched = true;
        }
        if (flagsTouched) patch.feature_flags = flags;
        // An active non-admin needs an office.
        const status = patch.status || rec.status;
        const level = patch.scope_level !== undefined ? patch.scope_level : rec.scope_level;
        if (status === 'active' && role !== 'admin' && !level) {
            throw new UserError(400, "Set the user's office (zone, region, division or CCC) before activating the account.");
        }
        return patch;
    }

    const SESSION_FIELDS = ['role', 'status', 'scope_level', 'region', 'division', 'ccc_code', 'email'];
    const same = (a, b) => JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b);

    function diff(rec, patch) {
        const changes = [];
        for (const [field, to] of Object.entries(patch)) {
            const from = rec[field] === undefined ? null : rec[field];
            if (field === 'feature_flags') {
                const f0 = flagsOf(rec);
                for (const k of Object.keys(to)) if (!same(f0[k], to[k])) changes.push({ field: `feature_flags.${k}`, from: f0[k], to: to[k] });
            } else if (!same(from === '' && to === null ? null : from, to)) {
                changes.push({ field, from, to });
            }
        }
        return changes;
    }

    /** Apply an admin change: write, bump session_version when access changed, audit, log. */
    async function applyChange(rec, patch, actorUser, action, reason) {
        const changes = diff(rec, patch);
        const write = {};
        for (const c of changes) {
            const top = c.field.split('.')[0];
            write[top] = patch[top];
        }
        if (!changes.length) return { rec, changes };
        if (changes.some((c) => SESSION_FIELDS.includes(c.field))) write.session_version = (rec.session_version || 0) + 1;
        if (write.status === 'active' && rec.status !== 'active') {
            write.approved_by = lower(actorUser && actorUser.email) || (actorUser && actorUser.Username) || '';
            write.approved_at = pbDate(Date.now());
        }
        if (write.email) {
            const clash = findBy('email', write.email) || (await fetchOne('email', write.email));
            if (clash && clash.id !== rec.id) throw new UserError(400, `Another account already uses ${write.email}.`);
        }
        const updated = await pb.update(USERS, rec.id, write);
        put(updated);
        const actor = actorOf(actorUser);
        const act = action || (write.status === 'disabled' ? 'disable' : write.status === 'active' && rec.status === 'disabled' ? 'enable' : 'update');
        await audit(updated, act, actor, changes, reason);
        return { rec: updated, changes };
    }

    function adminLog(req, details, data) {
        logActivity({ username: req.user.Username, name: req.user.Name, email: req.user.email || '', type: 'user_management', details, data });
    }

    function summary(changes) {
        return changes.map((c) => c.field).filter((f, i, a) => a.indexOf(f) === i).join(', ');
    }

    async function targetOf(body) {
        const b = body || {};
        const key = lower(b.Username || b.username);
        const email = lower(b.email_lookup);
        let rec = (key && findBy('username', key)) || (email && findBy('email', email)) || null;
        if (!rec && key && /^[a-z0-9_.-]{1,60}$/.test(key)) rec = await fetchOne('username', key);
        if (!rec && email && EMAIL_RE.test(email)) rec = await fetchOne('email', email);
        if (!rec) throw new UserError(404, 'User not found.');
        return rec;
    }

    // ---- Pending ticket: /api/auth/pending-status answers only the browser that signed in ----
    function pendingTicket(email) {
        const e = Buffer.from(email).toString('base64url');
        return `${e}.${crypto.createHmac('sha256', secret).update('pending:' + e).digest('base64url')}`;
    }
    function pendingEmailFrom(req) {
        const raw = String(req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(PENDING_COOKIE + '='));
        if (!raw) return '';
        const [e, sig] = decodeURIComponent(raw.slice(PENDING_COOKIE.length + 1)).split('.');
        if (!e || !sig) return '';
        const want = crypto.createHmac('sha256', secret).update('pending:' + e).digest('base64url');
        if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return '';
        return Buffer.from(e, 'base64url').toString('utf8');
    }
    function setPendingCookie(res, email) {
        const prev = res.getHeader('Set-Cookie');
        const c = `${PENDING_COOKIE}=${encodeURIComponent(pendingTicket(email))}; Path=/api/auth; HttpOnly; Max-Age=${PENDING_MAX_AGE_S}; SameSite=Lax`;
        res.setHeader('Set-Cookie', [].concat(prev || [], c));
    }

    // ---- Sign-in ----
    /**
     * Google claims (already verified) -> { status, httpStatus, profile?, rec?, message }.
     * Unknown emails become pending users; only active ones get a session.
     */
    async function signIn(claims) {
        const email = lower(claims.email);
        if (!EMAIL_RE.test(email)) return { httpStatus: 401, status: 'error', message: 'Google sign-in could not be verified. Please try again.' };
        let rec = await fetchOne('email', email);
        const now = pbDate(Date.now());
        // A built-in admin is always an active admin, even if someone changed it in the dashboard.
        if (isSeed(email) && (!rec || rec.role !== 'admin' || rec.status !== 'active')) {
            await seed();
            rec = await fetchOne('email', email);
        }
        if (!rec) {
            rec = await pb.create(USERS, {
                email, username: await uniqueUsername('', email), google_sub: String(claims.sub || '').replace(/\D/g, ''),
                name: clip(claims.name || email.split('@')[0], 200), photo_url: clip(claims.picture || '', 1000),
                role: 'viewer', status: 'pending', requested_at: now, session_version: 1
            });
            put(rec);
            await audit(rec, 'register', { email, name: rec.name }, [{ field: 'status', from: null, to: 'pending' }], 'first Google sign-in');
            logActivity({ username: rec.username, name: rec.name, email, type: 'user_management', details: `New Google user requested registration: ${email}` });
            return { httpStatus: 200, status: 'pending', rec, message: 'Registration received! Your account is pending administrator approval.' };
        }
        const sub = String(claims.sub || '').replace(/\D/g, '');
        if (rec.google_sub && sub && rec.google_sub !== sub) {
            logActivity({ username: rec.username, name: rec.name, email, type: 'login_refused', details: 'Google account does not match the one linked to this email' });
            return { httpStatus: 403, status: 'error', message: 'This Google account is not the one linked to this email. Ask an administrator.' };
        }
        if (rec.status === 'pending') {
            return { httpStatus: 200, status: 'pending', rec, message: 'Your registration is awaiting administrator approval.' };
        }
        if (rec.status === 'rejected' || rec.status === 'disabled') {
            logActivity({ username: rec.username, name: rec.name, email, type: 'login_refused', details: `Sign-in refused: account ${rec.status}` });
            return rec.status === 'rejected'
                ? { httpStatus: 403, status: 'rejected', message: 'Your access request was not approved by an administrator.' }
                : { httpStatus: 403, status: 'suspended', message: 'Your account has been deactivated.' };
        }
        const write = { last_login_at: now, 'login_count+': 1, last_seen_at: now };
        if (!rec.google_sub && sub) write.google_sub = sub;
        if (!rec.name && claims.name) write.name = clip(claims.name, 200);
        if (claims.picture && claims.picture !== rec.photo_url) write.photo_url = clip(claims.picture, 1000);
        const updated = await pb.update(USERS, rec.id, write);
        put(updated);
        if (write.google_sub) await audit(updated, 'link_google', { email, name: updated.name }, [{ field: 'google_sub', from: '', to: '(linked)' }], 'first sign-in');
        return { httpStatus: 200, status: 'success', rec: updated, profile: toProfile(updated) };
    }

    // ---- Session ----
    function profileForSession(session, isLocal) {
        if (!session) return null;
        if (isLocal) {
            const p = session.profile || {};
            return Object.assign({}, p, { email: lower(p.email), isAdmin: lower(p.role) === 'admin' });
        }
        const rec = session.uid ? byId.get(session.uid) : null;
        if (!rec || rec.status !== 'active') return null;
        if ((rec.session_version || 0) !== session.sv) return null;
        return toProfile(rec);
    }

    function sessionExtra(rec) {
        return { uid: rec.id, sv: rec.session_version || 0, store: 'pb' };
    }

    function pageAllowed(profile, pathName) {
        if (!profile || profile.isAdmin || !Array.isArray(profile.modules)) return true;
        const keys = modules.keysForPath(pathName);
        return !keys.length || keys.some((k) => profile.modules.includes(k));
    }

    function legacyUsers() {
        return [...byId.values()].map(toProfile).sort((a, b) => a.Username.localeCompare(b.Username));
    }

    /** The same-origin .html page a request came from, or ''. Sign-in and admin pages are not counted. */
    function pageOfReferer(req) {
        try {
            const u = new URL(String(req.headers.referer || ''));
            if (u.host !== req.headers.host) return '';
            const p = u.pathname;
            if (!/\.html$/i.test(p) || p === '/login.html' || p === '/admin_users.html') return '';
            return clip(p, 300);
        } catch (_) {
            return '';
        }
    }

    // ---- Routes ----
    function mount(app, deps) {
        const { issueSessionCookie, requireAdmin, clientId, fetch: fetchFn, rootAdmins } = deps;
        init(rootAdmins).catch((err) => log.error('[Users] init failed:', err.message));
        const unavailable = (res) => res.status(503).json({ status: 'error', message: 'Sign-in is unavailable right now. Try again in a minute.' });
        const fail = (res, err, what) => {
            if (err instanceof UserError) return res.status(err.status).json({ status: 'error', message: err.message });
            log.error(`[Users] ${what}:`, err.message);
            return res.status(500).json({ status: 'error', message: `Could not ${what}. Try again.` });
        };

        app.post('/api/auth/google', async (req, res) => {
            const { credential, accessToken } = req.body || {};
            if (!credential && !accessToken) return res.status(400).json({ status: 'error', message: 'Google authentication credential is required.' });
            if (!clientId()) return res.status(503).json({ status: 'error', message: 'Google sign-in is not configured on the server.' });
            if (!configured) return unavailable(res);
            let claims;
            try {
                claims = await googleAuth.tokenInfo(credential ? 'id_token' : 'access_token', credential || accessToken, { clientId: clientId(), fetch: fetchFn });
            } catch (err) {
                log.error('[Google Auth] verification unreachable:', err.message);
                return res.status(503).json({ status: 'error', message: 'Could not connect to Google for authentication verification.' });
            }
            if (!claims) return res.status(401).json({ status: 'error', message: 'Google sign-in could not be verified. Please try again.' });
            let out;
            try {
                out = await signIn(claims);
            } catch (err) {
                log.error('[Users] sign-in failed:', err.message);
                return unavailable(res);
            }
            if (out.status === 'pending') {
                setPendingCookie(res, out.rec.email);
                return res.status(200).json({ status: 'pending', email: out.rec.email, name: out.rec.name, requested_at: isoOf(out.rec.requested_at), message: out.message });
            }
            if (out.status !== 'success') return res.status(out.httpStatus).json({ status: out.status, message: out.message });
            const p = out.profile;
            issueSessionCookie(res, { Username: p.Username, Name: p.Name, email: p.email, role: p.role }, sessionExtra(out.rec));
            logActivity({ username: p.Username, name: p.Name, email: p.email, type: 'login', details: `Signed in via Google (${p.email})${p.isAdmin ? ' [ADMIN]' : ''}` });
            return res.status(200).json({ status: 'success', profile: p });
        });

        app.get('/api/auth/pending-status', async (req, res) => {
            const email = lower(req.query.email);
            if (!email) return res.status(400).json({ status: 'error', message: 'Email required.' });
            // Only the browser that registered may ask, so the endpoint cannot be used to probe emails.
            if (!configured || pendingEmailFrom(req) !== email) return res.status(200).json({ status: 'not_found' });
            try {
                const rec = await fetchOne('email', email);
                if (!rec) return res.status(200).json({ status: 'not_found' });
                const p = toProfile(rec);
                return res.status(200).json({ status: 'success', user_status: p.user_status, role: p.role, office_level: p.office_level, approved_at: p.approved_at || null });
            } catch (err) {
                return fail(res, err, 'check the status');
            }
        });

        // Every page asks this (auth.js, the app shell), so it also records the page visit, from the Referer.
        const visitAt = new Map();
        app.get('/api/session-check', (req, res) => {
            if (!req.user || !req.user.Username) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
            const page = pageOfReferer(req);
            if (page) {
                const key = `${req.user.Username}|${page}`;
                const now = Date.now();
                if (now - (visitAt.get(key) || 0) > 60000) {
                    visitAt.set(key, now);
                    if (visitAt.size > 5000) visitAt.clear();
                    logActivity({ username: req.user.Username, name: req.user.Name, email: req.user.email || '', type: 'page_visit', details: `Visited page: ${page}`, page });
                }
            }
            return res.status(200).json({ status: 'success', profile: req.user });
        });

        app.get('/api/admin/users', requireAdmin, async (req, res) => {
            try {
                await ready();
                const users = [...byId.values()].map((r) => toAdminUser(r, isSeed(r.email))).sort((a, b) => a.Username.localeCompare(b.Username));
                res.json({
                    status: 'success', store: 'pocketbase', users,
                    modules: modules.list.map((m) => ({ key: m.key, name: m.name, group: m.group })),
                    roles: ROLES, statuses: STATUSES, builtInAdmins: [...seedAdmins]
                });
            } catch (err) {
                fail(res, err, 'load the users');
            }
        });

        app.post('/api/admin/users/create', requireAdmin, async (req, res) => {
            try {
                const body = req.body || {};
                const email = lower(body.email || body.Email);
                if (!EMAIL_RE.test(email)) throw new UserError(400, 'A Google email is required: sign-in is Google only.');
                if (findBy('email', email) || (await fetchOne('email', email))) throw new UserError(400, `A user with ${email} already exists.`);
                const wanted = lower(body.Username || body.username);
                if (wanted && !/^[a-z0-9_.-]{1,60}$/.test(wanted)) throw new UserError(400, 'Username: letters, digits, dot, dash and underscore only.');
                if (wanted && (findBy('username', wanted) || localAdmins.isLocalUsername(wanted))) throw new UserError(400, 'Username already exists.');
                const blank = { id: '', email, username: '', role: 'viewer', status: 'pending', scope_level: '', feature_flags: null, modules: null, session_version: 1 };
                const statusIn = body.status !== undefined ? body.status : body.user_status;
                const patch = buildPatch(blank, Object.assign({}, body, { email: undefined, user_status: statusIn === undefined ? 'active' : statusIn }), req.user);
                const now = pbDate(Date.now());
                const row = Object.assign({ role: 'viewer', status: 'active', session_version: 1 }, patch, {
                    email, username: wanted || (await uniqueUsername('', email)), requested_at: now
                });
                if (row.status === 'active') Object.assign(row, { approved_by: lower(req.user.email) || req.user.Username, approved_at: now });
                const rec = await pb.create(USERS, row);
                put(rec);
                await audit(rec, 'create', actorOf(req.user), diff(blank, patch).concat([{ field: 'email', from: null, to: email }]));
                adminLog(req, `Created user account: ${rec.username} (${email})`);
                res.json({ status: 'success', message: 'User created successfully.', user: toAdminUser(rec, isSeed(email)) });
            } catch (err) {
                fail(res, err, 'create the user');
            }
        });

        app.post('/api/admin/users/update', requireAdmin, async (req, res) => {
            try {
                const body = req.body || {};
                const rec = await targetOf(body);
                const patch = buildPatch(rec, body, req.user);
                const { rec: updated, changes } = await applyChange(rec, patch, req.user, null, body.disabled_reason);
                if (changes.length) adminLog(req, `Updated user account: ${updated.username} (${summary(changes)})`, { changes });
                res.json({ status: 'success', message: changes.length ? 'User updated successfully.' : 'No changes.', user: toAdminUser(updated, isSeed(updated.email)) });
            } catch (err) {
                fail(res, err, 'update the user');
            }
        });

        app.post('/api/admin/users/approve', requireAdmin, async (req, res) => {
            try {
                const body = req.body || {};
                const rec = await targetOf(body);
                const b = Object.assign({}, body, { status: 'active', user_status: undefined });
                const patch = buildPatch(rec, b, req.user);
                // The workbench sends an office tier next to the office names: they must agree.
                const tierLevel = TIER_LEVEL[String(b.office_level || '').trim().toUpperCase()];
                const role = patch.role || rec.role;
                if (tierLevel && role !== 'admin' && patch.scope_level && patch.scope_level !== tierLevel) {
                    throw new UserError(400, `Office tier ${String(b.office_level).toUpperCase()} needs a ${tierLevel === 'ccc' ? 'CCC' : tierLevel} office, but the office chosen is a ${patch.scope_level === 'ccc' ? 'CCC' : patch.scope_level}. Pick the office or change the tier.`);
                }
                const { rec: updated, changes } = await applyChange(rec, patch, req.user, 'approve');
                const p = toProfile(updated);
                adminLog(req, `Approved user: ${updated.username} (Role: ${p.role}, Office: ${p.scope_level}${p.ccc_code || p.division_code || p.region_code ? ' ' + (p.ccc_code || p.division_code || p.region_code) : ''})`, { changes });
                res.json({ status: 'success', message: `User ${updated.username} approved and activated successfully.` });
            } catch (err) {
                fail(res, err, 'approve the user');
            }
        });

        app.post('/api/admin/users/reject', requireAdmin, async (req, res) => {
            try {
                const body = req.body || {};
                const rec = await targetOf(body);
                const reason = clip(String(body.reason || '').trim(), 500);
                const patch = buildPatch(rec, { status: 'rejected', disabled_reason: reason }, req.user);
                const { rec: updated } = await applyChange(rec, patch, req.user, 'reject', reason);
                adminLog(req, `Rejected registration for: ${updated.username}${reason ? ` (Reason: ${reason})` : ''}`);
                res.json({ status: 'success', message: `User ${updated.username} registration rejected.` });
            } catch (err) {
                fail(res, err, 'reject the user');
            }
        });

        app.post('/api/admin/users/delete', requireAdmin, async (req, res) => {
            try {
                const rec = await targetOf(req.body);
                if (isSeed(rec.email)) throw new UserError(400, `${rec.email} is a built-in admin (MZO_ADMIN_EMAILS); remove it from that list first.`);
                if (lower(req.user.email) && lower(req.user.email) === lower(rec.email)) throw new UserError(400, 'You cannot delete your own account.');
                await pb.remove(USERS, rec.id);
                byId.delete(rec.id);
                const snapshot = toAdminUser(rec, false);
                await audit(rec, 'delete', actorOf(req.user), [{ field: 'account', from: { role: snapshot.role, status: rec.status, scope_level: rec.scope_level, region: rec.region, division: rec.division, ccc_code: rec.ccc_code }, to: null }]);
                adminLog(req, `Deleted user account: ${rec.username} (${rec.email})`);
                res.json({ status: 'success', message: 'User deleted successfully.' });
            } catch (err) {
                fail(res, err, 'delete the user');
            }
        });

        app.get('/api/admin/users/audit', requireAdmin, async (req, res) => {
            try {
                const rec = await targetOf({ Username: req.query.username, email_lookup: lower(req.query.email) });
                const rows = await pb.all(AUDIT, { filter: `user_email = ${q(rec.email)}`, sort: '-created', perPage: 200, max: 200 });
                res.json({ status: 'success', audit: rows.map((r) => ({ at: isoOf(r.created), action: r.action, actor_email: r.actor_email, actor_name: r.actor_name, changes: r.changes || [], reason: r.reason || '' })) });
            } catch (err) {
                fail(res, err, 'load the change history');
            }
        });

        app.post('/api/admin/sync', requireAdmin, async (req, res) => {
            try {
                const list = await reload();
                res.json({ status: 'success', message: `Reloaded ${list.length} users from the VM user store.`, count: list.length });
            } catch (err) {
                fail(res, err, 'reload the users');
            }
        });

        app.get('/api/admin/logs', requireAdmin, async (req, res) => {
            try {
                await flush();
                const days = Math.min(Math.max(parseInt(req.query.days, 10) || 0, 0), 30);
                const rows = days
                    ? await pb.all(ACTIVITY, { filter: `created >= ${q(pbDate(Date.now() - days * 86400000))}`, sort: '-created', fields: 'created,username', perPage: 1000, max: 5000 })
                    : await pb.all(ACTIVITY, { sort: '-created', perPage: 1000, max: 2000 });
                const logs = rows.map((r) => (days
                    ? { timestamp: isoOf(r.created), username: r.username || '' }
                    : {
                        timestamp: isoOf(r.created), username: r.username || '', name: r.user_name || '', type: r.action || '',
                        details: (r.details && r.details.text) || '', email: r.user_email || '', page: r.page || '', ip: r.ip || ''
                    }));
                res.json({ status: 'success', logs });
            } catch (err) {
                fail(res, err, 'load the activity log');
            }
        });
    }

    return {
        on: true,
        configured,
        context: (req, res, next) => als.run(req, next),
        mount,
        ready: () => ready().catch((err) => { log.warn('[Users] user list unavailable:', err.message); }),
        profileForSession,
        pageAllowed,
        logActivity,
        legacyUsers,
        // For tests and maintenance.
        init: (rootAdmins) => { initDone = false; return init(rootAdmins); },
        flush,
        prune,
        reload,
        signIn,
        seedAdmins: () => [...seedAdmins],
        _pb: pb
    };
}

module.exports = {
    create, validateScope, scopeFromBody, toProfile, toAdminUser,
    DEFAULT_ADMIN_EMAILS, FLAG_KEYS, UPLOAD_FLAGS, ROLES, STATUSES, LEVELS
};
