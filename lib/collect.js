'use strict';
/* lib/collect.js — DISHA Collect (VM PocketBase).
 * Admin / region / division officers request structured reports from subordinate offices.
 * One shared draft per assignment/office; last-writer stamp; late stamp during extension.
 * Off without PB_URL + superuser (Vercel / local default). See docs/collect.md.
 *
 *   const collect = create({ env, clientIp, currentUser })   // currentUser(req) -> fresh profile or null
 *   collect.mount(app)   // /api/collect/*
 *   collect.on           // true when PocketBase credentials are set
 */
const officesLib = require('./offices');

const REQUESTS = 'app_collect_requests';
const ASSIGNMENTS = 'app_collect_assignments';
const SUBMISSIONS = 'app_collect_submissions';
const USERS = 'app_users';

// Limits on what a request or a save may carry (the body parser allows 5 MB; a PocketBase json field 1 MB).
const LIMITS = {
    officesIn: 200,          // office picks in one create / add (there are under 60 offices; duplicates fold)
    usersIn: 500,            // optional people picks in one create
    idsIn: 200,              // assignment ids in one withdraw
    fields: 150,             // columns in a report format, all levels
    depth: 4,                // levels of columns, tables included (a table of tables of tables)
    rows: 500,               // rows in one table of a draft
    cells: 20000,            // values in one draft
    text: 2000,              // characters in a text value
    textarea: 10000,         // characters in a long-text value
    payloadBytes: 800 * 1024,
    horizonMs: 366 * 86400000 // a due or extended time at most a year ahead
};
const FIELD_TYPES = ['text', 'number', 'checkbox', 'date', 'textarea', 'group'];
// Column ids become object keys in the payload, here and in the browser: never an Object.prototype name.
const RESERVED_IDS = new Set(Object.getOwnPropertyNames(Object.prototype).concat(['prototype']));
const PB_ID = /^[a-z0-9]{15}$/;
const EMAIL = /^[^\s@"<>]{1,128}@[^\s@"<>]{1,120}$/;

class CollectError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

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
            this.authing = this.raw('POST', '/api/collections/_superusers/auth-with-password', {
                identity: this.email, password: this.password
            }, false).then((r) => { this.token = r.token; }).finally(() => { this.authing = null; });
        }
        return this.authing;
    }
    async raw(method, path, body, withAuth = true) {
        const headers = { Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (withAuth && this.token) headers.Authorization = this.token;
        const res = await globalThis.fetch(this.url + path, {
            method, headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(20000)
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
        if (!res.ok) {
            const err = new Error(`PocketBase ${method} ${path.split('?')[0]}: HTTP ${res.status}`);
            err.status = res.status;
            err.data = data;
            throw err;
        }
        return data;
    }
    async req(method, path, body) {
        if (!this.token) await this.auth();
        try { return await this.raw(method, path, body); }
        catch (err) {
            if (err.status !== 401) throw err;
            await this.auth();
            return this.raw(method, path, body);
        }
    }
    records(coll) { return `/api/collections/${coll}/records`; }
    list(coll, q) { return this.req('GET', `${this.records(coll)}?${new URLSearchParams(q)}`); }
    get(coll, id) { return this.req('GET', `${this.records(coll)}/${pbId(id)}`); }
    create(coll, body) { return this.req('POST', this.records(coll), body); }
    update(coll, id, body) { return this.req('PATCH', `${this.records(coll)}/${pbId(id)}`, body); }
    async all(coll, { filter = '', sort = '', fields = '', perPage = 200, max = 5000 } = {}) {
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
/** A record id for a URL path: only PocketBase's own id shape (no "..", no slashes). */
function pbId(id) {
    const s = String(id == null ? '' : id);
    if (!PB_ID.test(s)) throw new CollectError(404, 'Not found');
    return s;
}
function pbDate(d) {
    return new Date(d).toISOString().replace('T', ' ');
}
function lower(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function clip(v, max) { return String(v == null ? '' : v).slice(0, max); }
function hasOwn(o, k) { return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
function canonRegion(r) { return officesLib.canonRegion(r || '') || String(r || '').trim(); }
function officeKey(o) {
    return [o.level, o.region || '', o.division || '', o.ccc_code || ''].join('|');
}

/**
 * The report format as stored: { fields: [{ id, type, label, required, repeat?, children? }] }, nothing
 * else. Ids are kept when safe (letters, digits, _ and -; unique among siblings; never a prototype name)
 * and renamed otherwise. strict (create): a format over the limits is refused; lenient (reading an older
 * row): it is cut to the limits instead.
 */
function cleanSchema(schema, strict) {
    const src = schema && Array.isArray(schema.fields) ? schema.fields : [];
    if (strict && !src.length) throw new CollectError(400, 'Report format needs at least one field');
    let count = 0;
    function walk(list, depth) {
        const out = [];
        const used = new Set();
        for (const f of Array.isArray(list) ? list : []) {
            if (!f || typeof f !== 'object' || Array.isArray(f)) {
                if (strict) throw new CollectError(400, 'Report format has an invalid column');
                continue;
            }
            if (count >= LIMITS.fields) {
                if (strict) throw new CollectError(400, `Report format has too many columns (at most ${LIMITS.fields})`);
                break;
            }
            count += 1;
            const base = typeof f.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(f.id) ? f.id : 'f' + count;
            let id = base;
            for (let n = 2; RESERVED_IDS.has(id) || used.has(id); n++) id = base.slice(0, 56) + '_' + n;
            used.add(id);
            const kids = Array.isArray(f.children) ? f.children : [];
            let type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
            if (kids.length) type = 'group';
            const field = { id, type, label: clip(f.label, 200).trim() || 'Untitled', required: f.required === true };
            if (type === 'group') {
                if (depth >= LIMITS.depth && kids.length) {
                    if (strict) throw new CollectError(400, `Report format nests too deep (at most ${LIMITS.depth} levels)`);
                    field.children = [];
                } else {
                    field.children = walk(kids, depth + 1);
                }
                field.repeat = true;
            }
            out.push(field);
        }
        return out;
    }
    const fields = walk(src, 1);
    if (strict && !fields.length) throw new CollectError(400, 'Report format needs at least one field');
    return { fields };
}

/**
 * A draft cut to its report format: only the format's column ids, values of the column's type, at most
 * LIMITS.rows rows per table and LIMITS.cells values in all. Anything else is dropped.
 */
function cleanPayload(schemaFields, payload) {
    let cells = 0;
    function walk(fields, data) {
        const src = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
        const out = {};
        for (const f of fields || []) {
            if (RESERVED_IDS.has(f.id)) continue;
            const v = hasOwn(src, f.id) ? src[f.id] : undefined;
            if (f.type === 'group') {
                const list = Array.isArray(v) ? v : [];
                if (list.length > LIMITS.rows) throw new CollectError(413, `"${f.label}" has more than ${LIMITS.rows} rows`);
                out[f.id] = list.map((item) => walk(f.children || [], item));
                continue;
            }
            cells += 1;
            if (cells > LIMITS.cells) throw new CollectError(413, `This report has more than ${LIMITS.cells} values`);
            if (f.type === 'checkbox') {
                out[f.id] = v === true || v === 'true' || v === 1;
            } else if (f.type === 'number') {
                const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : NaN);
                out[f.id] = Number.isFinite(n) ? n : '';
            } else {
                const max = f.type === 'textarea' ? LIMITS.textarea : f.type === 'date' ? 40 : LIMITS.text;
                out[f.id] = typeof v === 'string' || typeof v === 'number' ? clip(v, max) : '';
            }
        }
        return out;
    }
    const data = payload && typeof payload === 'object' && hasOwn(payload, 'fields') ? payload.fields : payload;
    const out = { fields: walk(schemaFields, data) };
    if (Buffer.byteLength(JSON.stringify(out)) > LIMITS.payloadBytes) {
        throw new CollectError(413, 'This report is too large to save. Split long text or tables.');
    }
    return out;
}

/** A time from the request body, refused unless it is a real date in the next year (and after notBefore). */
function futureDate(raw, name, notBefore, now) {
    const d = raw ? new Date(raw) : null;
    if (!d || isNaN(d.getTime())) throw new CollectError(400, `${name} is required (ISO date)`);
    const t = d.getTime();
    if (t <= now) throw new CollectError(400, `${name} must be in the future`);
    if (notBefore && t <= notBefore) throw new CollectError(400, `${name} must be after the due time`);
    if (t > now + LIMITS.horizonMs) throw new CollectError(400, `${name} must be within a year`);
    return d;
}

function profileOffice(user) {
    if (!user) return { level: '', region: '', division: '', ccc_code: '', ccc: '', email: '', name: '', username: '', isAdmin: false };
    const isAdmin = !!(user.isAdmin || lower(user.role) === 'admin');
    const level = isAdmin ? 'zone' : String(user.scope_level || '').trim();
    const region = isAdmin ? '' : String(user.region_code || user.region || '').trim();
    const division = isAdmin ? '' : String(user.division_code || user.division || '').trim();
    let ccc_code = isAdmin ? '' : String(user.scope_ccc_code || '').trim();
    let ccc = isAdmin ? '' : String(user.ccc_code || '').trim();
    if (!ccc_code && ccc && /^\d{7}$/.test(ccc)) { ccc_code = ccc; ccc = ''; }
    if (!ccc_code && ccc) {
        const found = officesLib.CCCS.find((c) => lower(c.name) === lower(ccc) || c.code === ccc);
        if (found) { ccc_code = found.code; ccc = found.name; }
    }
    if (ccc_code && !ccc) {
        const found = officesLib.CCCS.find((c) => c.code === ccc_code);
        if (found) ccc = found.name;
    }
    return {
        level, region: officesLib.canonRegion(region) || region, division, ccc_code, ccc,
        email: lower(user.email || ''),
        name: String(user.Name || user.name || '').trim(),
        username: String(user.Username || user.username || '').trim(),
        isAdmin
    };
}

function canCreate(office) {
    return office.isAdmin || office.level === 'zone' || office.level === 'region' || office.level === 'division';
}

function officeUnderActor(actor, target) {
    if (!target || !target.level) return false;
    if (actor.isAdmin || actor.level === 'zone') return true;
    const tRegion = officesLib.canonRegion(target.region) || target.region || '';
    const aRegion = actor.region || '';
    if (actor.level === 'region') {
        if (tRegion !== aRegion) return false;
        return target.level === 'region' || target.level === 'division' || target.level === 'ccc';
    }
    if (actor.level === 'division') {
        if ((target.division || '') !== actor.division) return false;
        if (tRegion && aRegion && tRegion !== aRegion) return false;
        return target.level === 'division' || target.level === 'ccc';
    }
    return false;
}

function normalizeOffice(raw) {
    const level = String((raw && raw.level) || (raw && raw.office_level) || '').trim();
    if (!['zone', 'region', 'division', 'ccc'].includes(level)) {
        throw new CollectError(400, 'Each office needs level zone|region|division|ccc');
    }
    let region = officesLib.canonRegion((raw && raw.region) || '') || String((raw && raw.region) || '').trim();
    let division = String((raw && raw.division) || '').trim();
    let ccc_code = String((raw && raw.ccc_code) || '').trim();
    let ccc_name = String((raw && raw.ccc_name) || (raw && raw.ccc) || '').trim();

    if (level === 'zone') {
        return { level: 'zone', region: '', division: '', ccc_code: '', ccc_name: '', office_label: 'Malda Zone' };
    }
    if (level === 'region') {
        if (!officesLib.REGIONS.some((r) => r.name === region)) throw new CollectError(400, 'Unknown region');
        return { level: 'region', region, division: '', ccc_code: '', ccc_name: '', office_label: region + ' Region' };
    }
    if (level === 'division') {
        const d = officesLib.DIVISIONS.find((x) => lower(x.name) === lower(division));
        if (!d) throw new CollectError(400, 'Unknown division');
        return { level: 'division', region: d.region, division: d.name, ccc_code: '', ccc_name: '', office_label: d.name + ' Division' };
    }
    const c = officesLib.CCCS.find((x) => x.code === ccc_code || lower(x.name) === lower(ccc_name || ccc_code));
    if (!c) throw new CollectError(400, 'Unknown CCC');
    return {
        level: 'ccc', region: c.region, division: c.division, ccc_code: c.code, ccc_name: c.name,
        office_label: c.name + ' CCC'
    };
}

function assignmentMatchesUser(asg, office) {
    if (!asg || asg.status === 'withdrawn') return false;
    if (asg.assignee_user && lower(asg.assignee_user) !== office.email) return false;
    if (asg.office_level === 'ccc') {
        return office.level === 'ccc' && office.ccc_code && office.ccc_code === asg.ccc_code;
    }
    if (asg.office_level === 'division') {
        return office.level === 'division' && office.division === asg.division;
    }
    if (asg.office_level === 'region') {
        return office.level === 'region' && (officesLib.canonRegion(office.region) || office.region) === (officesLib.canonRegion(asg.region) || asg.region);
    }
    if (asg.office_level === 'zone') {
        return office.isAdmin || office.level === 'zone';
    }
    return false;
}

function timingOf(dueAt, extendedDueAt, now) {
    const due = dueAt ? new Date(dueAt).getTime() : 0;
    const ext = extendedDueAt ? new Date(extendedDueAt).getTime() : 0;
    const t = now || Date.now();
    const locked = !!(due && t > due && (!ext || t > ext));
    const late = !!(due && ext && t > due && t <= ext);
    const openUntil = ext && ext > due ? ext : due;
    return {
        due_at: dueAt || null,
        extended_due_at: extendedDueAt || null,
        locked,
        late,
        can_edit: !locked,
        open_until: openUntil ? new Date(openUntil).toISOString() : null,
        ms_left: openUntil ? (openUntil - t) : null
    };
}

/**
 * Admin and zone officers manage every request; a region or division officer manages the ones they
 * raised, and only while they still hold the office they raised them from (a moved or demoted officer
 * loses them, as they lose the offices).
 */
function canManageRequest(actor, row) {
    if (!row || !canCreate(actor)) return false;
    if (actor.isAdmin || actor.level === 'zone') return true;
    if (!actor.email || lower(row.created_by_email) !== actor.email) return false;
    if (String(row.created_by_level || '') !== actor.level) return false;
    if (canonRegion(row.created_by_region) !== canonRegion(actor.region)) return false;
    return actor.level !== 'division' || String(row.created_by_division || '') === actor.division;
}

function flattenPayload(schemaFields, payload, rows, path) {
    path = path || [];
    const data = (payload && payload.fields) || payload || {};
    (schemaFields || []).forEach((f) => {
        if (RESERVED_IDS.has(f.id)) return;
        if (f.type === 'group') {
            const list = hasOwn(data, f.id) && Array.isArray(data[f.id]) ? data[f.id] : [];
            if (!list.length) {
                rows.push({ path: path.concat([f.label || f.id]).join(' › '), value: '(empty list)' });
                return;
            }
            list.forEach((item, i) => {
                const p = path.concat([(f.label || f.id) + ' #' + (i + 1)]);
                flattenPayload(f.children || [], item, rows, p);
            });
        } else {
            const v = hasOwn(data, f.id) ? data[f.id] : null;
            rows.push({
                path: path.concat([f.label || f.id]).join(' › '),
                value: v == null || v === '' ? '' : (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v))
            });
        }
    });
}

function create({ env, clientIp, currentUser } = {}) {
    env = env || process.env;
    const url = String(env.PB_URL || '').trim();
    const email = String(env.PB_SUPERUSER_EMAIL || '').trim();
    const password = String(env.PB_SUPERUSER_PASSWORD || '').trim();
    const on = !!(url && email && password);
    const pb = on ? new Pb({ url, email, password }) : null;
    const ipOf = typeof clientIp === 'function' ? clientIp : (req) => {
        try { return require('./local_admins').clientIp(req); } catch (_) { return ''; }
    };
    // The signed-in user's current profile (server.js re-reads it so a disabled or demoted account is cut
    // off at once); null refuses the call. Default: the session profile requireAuth put on req.user.
    const userOf = typeof currentUser === 'function' ? currentUser : async (req) => req.user || null;

    function unavailable(res) {
        return res.status(503).json({
            error: 'DISHA Collect needs the VM PocketBase (PB_URL + superuser). Not available on this host.',
            available: false
        });
    }

    // fn(req, res, user). Only CollectError messages reach the browser; anything else (PocketBase down,
    // a refused write) is logged here and answered with a plain message.
    function wrap(fn) {
        return async (req, res) => {
            try {
                if (!on) return unavailable(res);
                const user = await userOf(req);
                if (!user) return res.status(401).json({ error: 'Sign in again to use DISHA Collect' });
                await fn(req, res, user);
            } catch (err) {
                if (err instanceof CollectError) return res.status(err.status).json({ error: err.message });
                console.error('[Collect]', req.method, req.path, (err && err.message) || err);
                const down = !(err && err.status);
                res.status(down ? 503 : 502).json({
                    error: down ? 'DISHA Collect cannot reach its database right now. Try again in a minute.'
                        : 'DISHA Collect could not complete this. Try again, or tell the admin if it keeps failing.'
                });
            }
        };
    }

    function makeStamp(actor, req, late) {
        return {
            stamp_email: clip(actor.email, 254),
            stamp_name: clip(actor.name, 200),
            stamp_username: clip(actor.username, 80),
            stamp_office_level: clip(actor.level, 20),
            stamp_region: clip(actor.region, 80),
            stamp_division: clip(actor.division, 80),
            stamp_ccc_code: clip(actor.ccc_code, 16),
            stamp_at: pbDate(new Date()),
            stamp_ip: clip(ipOf(req), 64),
            stamp_late: !!late
        };
    }

    async function getRequest(id) {
        try { return await pb.get(REQUESTS, id); }
        catch (err) {
            if (err.status === 404) throw new CollectError(404, 'Request not found');
            throw err;
        }
    }

    async function getAssignment(id) {
        try { return await pb.get(ASSIGNMENTS, id); }
        catch (err) {
            if (err.status === 404) throw new CollectError(404, 'Assignment not found');
            throw err;
        }
    }

    async function submissionFor(assignmentId) {
        const rows = await pb.all(SUBMISSIONS, { filter: 'assignment_id = ' + q(assignmentId), perPage: 1, max: 1 });
        return rows[0] || null;
    }

    async function createAssignmentWithDraft(row, o, actor, req, due_at, extended_due_at, assignee) {
        const a = await pb.create(ASSIGNMENTS, {
            request_id: row.id,
            office_level: o.level,
            region: o.region,
            division: o.division,
            ccc_code: o.ccc_code,
            ccc_name: o.ccc_name,
            office_label: o.office_label,
            assignee_user: assignee || '',
            status: 'pending',
            due_at: pbDate(due_at),
            extended_due_at: extended_due_at ? pbDate(extended_due_at) : null
        });
        await pb.create(SUBMISSIONS, Object.assign({
            assignment_id: a.id,
            request_id: row.id,
            payload: { fields: {} },
            status: 'draft',
            revision: 0
        }, makeStamp(actor, req, false)));
        return a;
    }

    /** The PocketBase filter for assignments addressed to this user's office ('' when none can be). */
    function inboxFilter(office) {
        if (office.isAdmin || office.level === 'zone') return 'office_level = "zone"';
        if (office.level === 'region' && office.region) return 'office_level = "region" && region = ' + q(canonRegion(office.region));
        if (office.level === 'division' && office.division) return 'office_level = "division" && division = ' + q(office.division);
        if (office.level === 'ccc' && office.ccc_code) return 'office_level = "ccc" && ccc_code = ' + q(office.ccc_code);
        return '';
    }

    async function requestsByIds(ids, extra) {
        const out = [];
        for (let i = 0; i < ids.length; i += 40) {
            const part = ids.slice(i, i + 40).map((id) => 'id = ' + q(id)).join(' || ');
            out.push(...await pb.all(REQUESTS, { filter: (extra ? extra + ' && ' : '') + '(' + part + ')', max: 40 }));
        }
        return out;
    }

    async function inboxFor(user) {
        const office = profileOffice(user);
        const where = inboxFilter(office);
        const empty = { available: true, can_create: canCreate(office), items: [], pending_count: 0 };
        if (!where) return empty;
        const asgs = (await pb.all(ASSIGNMENTS, { filter: 'status != "withdrawn" && ' + where, sort: '-updated', max: 2000 }))
            .filter((a) => assignmentMatchesUser(a, office));
        if (!asgs.length) return empty;
        const ids = [...new Set(asgs.map((a) => a.request_id).filter((id) => PB_ID.test(String(id))))];
        const reqById = {};
        (await requestsByIds(ids, 'status = "open"')).forEach((r) => { reqById[r.id] = r; });
        const mine = asgs.filter((a) => reqById[a.request_id]);
        const now = Date.now();
        const items = mine.map((a) => {
            const r = reqById[a.request_id];
            const due = a.due_at || r.due_at;
            const ext = a.extended_due_at || r.extended_due_at;
            const timing = timingOf(due, ext, now);
            const pending = a.status !== 'submitted' && a.status !== 'withdrawn';
            return {
                assignment_id: a.id,
                request_id: r.id,
                title: r.title,
                description: r.description || '',
                office_label: a.office_label,
                office_level: a.office_level,
                status: a.status,
                pending,
                last_saved_at: a.last_saved_at || null,
                last_saved_by_name: a.last_saved_by_name || '',
                submitted_at: a.submitted_at || null,
                timing
            };
        });
        items.sort((a, b) => {
            const ao = a.timing.open_until ? new Date(a.timing.open_until).getTime() : 0;
            const bo = b.timing.open_until ? new Date(b.timing.open_until).getTime() : 0;
            return ao - bo;
        });
        return { available: true, can_create: canCreate(office), items, pending_count: items.filter((i) => i.pending).length };
    }

    /** The checked office list from a body array (at most LIMITS.officesIn), each under the actor. */
    function officesFromBody(actor, list) {
        const officesIn = Array.isArray(list) ? list : [];
        if (!officesIn.length) throw new CollectError(400, 'Pick at least one office');
        if (officesIn.length > LIMITS.officesIn) throw new CollectError(400, `Pick at most ${LIMITS.officesIn} offices`);
        const seen = {};
        const unique = [];
        for (const raw of officesIn) {
            const o = normalizeOffice(raw);
            if (!officeUnderActor(actor, o)) throw new CollectError(403, 'Office out of your scope: ' + o.office_label);
            const key = officeKey(o);
            if (seen[key]) continue;
            seen[key] = 1;
            unique.push(o);
        }
        return unique;
    }

    async function createRequest(user, body, req) {
        const actor = profileOffice(user);
        if (!canCreate(actor)) throw new CollectError(403, 'Only admin, region or division officers can create Collect requests');
        const title = clip(body && body.title, 200).trim();
        if (!title) throw new CollectError(400, 'Title is required');
        const now = Date.now();
        const due_at = futureDate(body && body.due_at, 'due_at', 0, now);
        const extended_due_at = body && body.extended_due_at
            ? futureDate(body.extended_due_at, 'extended_due_at', due_at.getTime(), now) : null;
        const unique = officesFromBody(actor, body && body.offices);
        const schema = cleanSchema(body && body.schema, true);

        // Optional people: { email, level, region, division, ccc_code }. One person picked at an office
        // makes the assignment theirs alone; only people at that office count.
        const people = Array.isArray(body && body.users) ? body.users : [];
        if (people.length > LIMITS.usersIn) throw new CollectError(400, `Pick at most ${LIMITS.usersIn} people`);
        const userByOffice = {};
        people.forEach((u) => {
            const mail = lower(u && u.email);
            if (!EMAIL.test(mail) || mail.length > 254) return;
            try {
                const o = normalizeOffice({
                    level: u.level || (u.ccc_code ? 'ccc' : (u.division ? 'division' : 'region')),
                    region: u.region, division: u.division, ccc_code: u.ccc_code, ccc_name: u.ccc_name
                });
                const key = officeKey(o);
                if (!userByOffice[key]) userByOffice[key] = [];
                if (!userByOffice[key].includes(mail)) userByOffice[key].push(mail);
            } catch (_) { /* skip bad user office */ }
        });

        const row = await pb.create(REQUESTS, {
            template_id: clip((body && body.template_id) || '', 40),
            title,
            description: clip((body && body.description) || '', 2000),
            schema,
            due_at: pbDate(due_at),
            extended_due_at: extended_due_at ? pbDate(extended_due_at) : null,
            status: 'open',
            offices: unique,
            created_by_email: clip(actor.email, 254),
            created_by_name: clip(actor.name, 200),
            created_by_level: actor.level,
            created_by_region: clip(actor.region, 80),
            created_by_division: clip(actor.division, 80)
        });

        const asgRows = [];
        try {
            for (const o of unique) {
                const matched = userByOffice[officeKey(o)] || [];
                asgRows.push(await createAssignmentWithDraft(row, o, actor, req, due_at, extended_due_at, matched.length === 1 ? matched[0] : ''));
            }
        } catch (err) {
            // Half a request is worse than none: cancel it so no office sees it, then report the failure.
            try { await pb.update(REQUESTS, row.id, { status: 'cancelled' }); } catch (_) { /* logged below */ }
            for (const a of asgRows) {
                try { await pb.update(ASSIGNMENTS, a.id, { status: 'withdrawn' }); } catch (_) { /* best effort */ }
            }
            throw err;
        }
        return { request: row, assignments: asgRows };
    }

    async function extendRequest(user, id, body) {
        const actor = profileOffice(user);
        const row = await getRequest(id);
        if (!canManageRequest(actor, row)) throw new CollectError(403, 'Only the requester or an admin can extend this deadline');
        if (row.status !== 'open') throw new CollectError(400, 'Request is not open');
        const due = new Date(row.due_at).getTime();
        const ext = futureDate(body && body.extended_due_at, 'extended_due_at', due, Date.now());

        const updated = await pb.update(REQUESTS, row.id, { extended_due_at: pbDate(ext) });
        const asgs = await pb.all(ASSIGNMENTS, { filter: 'request_id = ' + q(row.id), max: 500 });
        // Submitted offices too: the requester may return one later, and it must reopen under this time.
        for (const a of asgs) {
            if (a.status === 'withdrawn') continue;
            await pb.update(ASSIGNMENTS, a.id, { extended_due_at: pbDate(ext) });
        }
        return { request: updated };
    }

    async function myRequests(user) {
        const actor = profileOffice(user);
        if (!canCreate(actor)) return { items: [] };
        let filter = 'status != "cancelled"';
        if (!actor.isAdmin && actor.level !== 'zone') {
            if (!actor.email) return { items: [] };
            filter += ' && created_by_email = ' + q(actor.email);
        }
        const rows = (await pb.all(REQUESTS, { filter, sort: '-created', max: 200 })).filter((r) => canManageRequest(actor, r));
        const now = Date.now();
        return {
            items: rows.map((r) => {
                const timing = timingOf(r.due_at, r.extended_due_at, now);
                return {
                    id: r.id,
                    title: r.title,
                    status: r.status,
                    office_count: Array.isArray(r.offices) ? r.offices.length : 0,
                    created_by_name: r.created_by_name,
                    created_by_email: r.created_by_email,
                    timing
                };
            })
        };
    }

    /** The request, when this actor may manage it (view the tree, export, extend, add, withdraw, return). */
    async function managedRequest(actor, id) {
        const row = await getRequest(id);
        if (!canManageRequest(actor, row)) throw new CollectError(403, 'Not allowed to view this request');
        return row;
    }

    async function requestDetail(user, id) {
        const actor = profileOffice(user);
        const row = await managedRequest(actor, id);
        const asgs = await pb.all(ASSIGNMENTS, { filter: 'request_id = ' + q(row.id), sort: 'office_label', max: 500 });
        const subs = await pb.all(SUBMISSIONS, { filter: 'request_id = ' + q(row.id), max: 500 });
        const subByAsg = {};
        subs.forEach((s) => { subByAsg[s.assignment_id] = s; });
        const now = Date.now();
        const timing = timingOf(row.due_at, row.extended_due_at, now);
        const assignments = asgs.map((a) => {
            const s = subByAsg[a.id];
            const t = timingOf(a.due_at || row.due_at, a.extended_due_at || row.extended_due_at, now);
            return {
                id: a.id,
                office_label: a.office_label,
                office_level: a.office_level,
                region: a.region,
                division: a.division,
                ccc_code: a.ccc_code,
                status: a.status,
                last_saved_at: a.last_saved_at,
                last_saved_by_name: a.last_saved_by_name,
                submitted_at: a.submitted_at,
                timing: t,
                stamp_late: !!(s && s.stamp_late),
                revision: s ? s.revision : 0,
                has_data: !!(s && s.payload && s.payload.fields && Object.keys(s.payload.fields).length)
            };
        });
        return {
            request: {
                id: row.id,
                title: row.title,
                description: row.description || '',
                status: row.status,
                schema: cleanSchema(row.schema, false),
                offices: row.offices || [],
                created_by_name: row.created_by_name,
                created_by_email: row.created_by_email,
                timing
            },
            assignments,
            _subs: subByAsg,
            _asgs: asgs
        };
    }

    async function assignmentDetail(user, id) {
        const actor = profileOffice(user);
        const a = await getAssignment(id);
        const row = await getRequest(a.request_id);
        const isAssignee = assignmentMatchesUser(a, actor);
        const isManager = canManageRequest(actor, row);
        if (!isAssignee && !isManager) throw new CollectError(403, 'Not allowed');
        const s = await submissionFor(a.id);
        const now = Date.now();
        const timing = timingOf(a.due_at || row.due_at, a.extended_due_at || row.extended_due_at, now);
        const statusBlocks = a.status === 'submitted' || a.status === 'withdrawn';
        const can_edit = isAssignee && timing.can_edit && !statusBlocks && row.status === 'open';
        return {
            assignment: {
                id: a.id,
                request_id: row.id,
                title: row.title,
                office_label: a.office_label,
                status: a.status,
                last_saved_at: a.last_saved_at,
                last_saved_by_name: a.last_saved_by_name,
                last_saved_by_email: a.last_saved_by_email,
                submitted_at: a.submitted_at
            },
            schema: cleanSchema(row.schema, false),
            payload: (s && s.payload) || { fields: {} },
            submission: s ? {
                id: s.id,
                status: s.status,
                revision: s.revision,
                stamp_late: !!s.stamp_late,
                stamp_name: s.stamp_name,
                stamp_at: s.stamp_at
            } : null,
            revision: s ? Number(s.revision || 0) : 0,
            timing,
            can_edit,
            is_manager: isManager
        };
    }

    /**
     * Save the office's shared draft. The whole draft is replaced (last writer wins); a body with
     * base_revision (the revision the page loaded) is refused with 409 when someone saved since.
     */
    async function saveDraft(user, id, body, req) {
        const actor = profileOffice(user);
        const a = await getAssignment(id);
        if (!assignmentMatchesUser(a, actor)) throw new CollectError(403, 'Only users at this office can edit');
        if (a.status === 'withdrawn') throw new CollectError(400, 'Assignment withdrawn');
        if (a.status === 'submitted') throw new CollectError(400, 'Already submitted — wait for return if the requester unlocks it');
        const row = await getRequest(a.request_id);
        if (row.status !== 'open') throw new CollectError(400, 'Request is closed');
        const timing = timingOf(a.due_at || row.due_at, a.extended_due_at || row.extended_due_at, Date.now());
        if (timing.locked) throw new CollectError(403, 'Deadline passed — no updates until the requester extends');

        const payload = cleanPayload(cleanSchema(row.schema, false).fields, (body && body.payload) || { fields: {} });
        const stamp = makeStamp(actor, req, timing.late);
        let s = await submissionFor(a.id);
        const base = body && body.base_revision;
        if (base !== undefined && base !== null && base !== '' && Number(base) !== Number((s && s.revision) || 0)) {
            throw new CollectError(409, 'Someone at your office saved this report after you opened it. Reload to see their changes.');
        }
        if (!s) {
            s = await pb.create(SUBMISSIONS, Object.assign({
                assignment_id: a.id,
                request_id: row.id,
                payload,
                status: 'draft',
                revision: 1
            }, stamp));
        } else {
            s = await pb.update(SUBMISSIONS, s.id, Object.assign({
                payload,
                status: 'draft',
                revision: Number(s.revision || 0) + 1
            }, stamp));
        }
        await pb.update(ASSIGNMENTS, a.id, {
            status: a.status === 'returned' ? 'in_progress' : (a.status === 'pending' ? 'in_progress' : a.status),
            last_saved_at: stamp.stamp_at,
            last_saved_by_email: stamp.stamp_email,
            last_saved_by_name: stamp.stamp_name
        });
        return { ok: true, revision: s.revision, late: timing.late, stamp };
    }

    async function submitAssignment(user, id, body, req) {
        // Save first, then lock as submitted.
        const saved = await saveDraft(user, id, body, req);
        const actor = profileOffice(user);
        const a = await getAssignment(id);
        const row = await getRequest(a.request_id);
        const timing = timingOf(a.due_at || row.due_at, a.extended_due_at || row.extended_due_at, Date.now());
        if (timing.locked) throw new CollectError(403, 'Deadline passed — cannot submit');
        const s = await submissionFor(a.id);
        const stamp = makeStamp(actor, req, timing.late);
        await pb.update(SUBMISSIONS, s.id, Object.assign({ status: 'submitted' }, stamp));
        await pb.update(ASSIGNMENTS, a.id, {
            status: 'submitted',
            submitted_at: stamp.stamp_at,
            last_saved_at: stamp.stamp_at,
            last_saved_by_email: stamp.stamp_email,
            last_saved_by_name: stamp.stamp_name
        });
        return { ok: true, late: timing.late, revision: saved.revision };
    }

    async function returnAssignment(user, id) {
        const actor = profileOffice(user);
        const a = await getAssignment(id);
        const row = await getRequest(a.request_id);
        if (!canManageRequest(actor, row)) throw new CollectError(403, 'Only the requester or an admin can return a submission');
        if (row.status !== 'open') throw new CollectError(400, 'Request is not open');
        if (a.status !== 'submitted') throw new CollectError(400, 'Only submitted assignments can be returned');
        const timing = timingOf(a.due_at || row.due_at, a.extended_due_at || row.extended_due_at, Date.now());
        if (timing.locked) throw new CollectError(400, 'Extend the deadline before returning for correction');
        const s = await submissionFor(a.id);
        if (s) await pb.update(SUBMISSIONS, s.id, { status: 'draft' });
        await pb.update(ASSIGNMENTS, a.id, { status: 'returned', submitted_at: null });
        return { ok: true };
    }

    async function addOffices(user, id, body, req) {
        const actor = profileOffice(user);
        const row = await managedRequest(actor, id);
        if (row.status !== 'open') throw new CollectError(400, 'Request is not open');
        const wanted = officesFromBody(actor, body && body.offices);
        const existing = await pb.all(ASSIGNMENTS, { filter: 'request_id = ' + q(row.id), max: 500 });
        const have = {};
        existing.forEach((a) => {
            if (a.status === 'withdrawn') return;
            have[officeKey({ level: a.office_level, region: a.region, division: a.division, ccc_code: a.ccc_code })] = 1;
        });
        const added = [];
        const officesSnap = Array.isArray(row.offices) ? row.offices.slice() : [];
        for (const o of wanted) {
            const key = officeKey(o);
            if (have[key]) continue;
            have[key] = 1;
            added.push(await createAssignmentWithDraft(
                row, o, actor, req,
                new Date(row.due_at),
                row.extended_due_at ? new Date(row.extended_due_at) : null
            ));
            officesSnap.push(o);
        }
        await pb.update(REQUESTS, row.id, { offices: officesSnap });
        return { added: added.length, assignments: added };
    }

    async function removeOffices(user, id, body) {
        const actor = profileOffice(user);
        const row = await managedRequest(actor, id);
        if (row.status !== 'open') throw new CollectError(400, 'Request is not open');
        const ids = [...new Set((Array.isArray(body && body.assignment_ids) ? body.assignment_ids : []).map(String))];
        if (!ids.length) throw new CollectError(400, 'assignment_ids required');
        if (ids.length > LIMITS.idsIn) throw new CollectError(400, `Withdraw at most ${LIMITS.idsIn} offices at a time`);
        // Only this request's own assignments, read in one query (never by an id from another request).
        const asgs0 = await pb.all(ASSIGNMENTS, { filter: 'request_id = ' + q(row.id), max: 500 });
        const byId = {};
        asgs0.forEach((a) => { byId[a.id] = a; });
        const targets = ids.map((aid) => byId[aid]).filter(Boolean);
        if (targets.some((a) => a.status === 'submitted')) {
            throw new CollectError(400, 'Cannot remove a submitted office — return it first or leave it');
        }
        let n = 0;
        for (const a of targets) {
            if (a.status === 'withdrawn') continue;
            await pb.update(ASSIGNMENTS, a.id, { status: 'withdrawn' });
            a.status = 'withdrawn';
            n += 1;
        }
        const officesSnap = asgs0.filter((a) => a.status !== 'withdrawn').map((a) => ({
            level: a.office_level, region: a.region, division: a.division,
            ccc_code: a.ccc_code, ccc_name: a.ccc_name, office_label: a.office_label
        }));
        await pb.update(REQUESTS, row.id, { offices: officesSnap });
        return { removed: n };
    }

    // JSON only. If a CSV or Excel export is added, prefix cells starting with = + - @ (or a tab / CR)
    // with ' so a spreadsheet never runs an answer as a formula.
    async function exportRequest(user, id) {
        const detail = await requestDetail(user, id);
        const row = detail.request;
        const out = [];
        for (const a of detail._asgs) {
            if (a.status === 'withdrawn') continue;
            const s = detail._subs[a.id];
            const flat = [];
            flattenPayload(row.schema.fields, (s && s.payload) || {}, flat);
            out.push({
                office: a.office_label,
                status: a.status,
                last_saved_by: a.last_saved_by_name || '',
                submitted_at: a.submitted_at || '',
                late: !!(s && s.stamp_late),
                rows: flat
            });
        }
        return { title: row.title, request_id: row.id, offices: out };
    }

    function listAssignableOffices(actor) {
        const list = [];
        const pushRegion = (r) => {
            list.push({ level: 'region', region: r.name, division: '', ccc_code: '', ccc_name: '', office_label: r.name + ' Region' });
            officesLib.DIVISIONS.filter((d) => d.region === r.name).forEach((d) => {
                list.push({ level: 'division', region: d.region, division: d.name, ccc_code: '', ccc_name: '', office_label: d.name + ' Division' });
                officesLib.CCCS.filter((c) => c.division === d.name).forEach((c) => {
                    list.push({ level: 'ccc', region: c.region, division: c.division, ccc_code: c.code, ccc_name: c.name, office_label: c.name + ' CCC' });
                });
            });
        };
        if (actor.isAdmin || actor.level === 'zone') {
            officesLib.REGIONS.forEach(pushRegion);
        } else if (actor.level === 'region') {
            const r = officesLib.REGIONS.find((x) => x.name === actor.region);
            if (r) pushRegion(r);
        } else if (actor.level === 'division') {
            const d = officesLib.DIVISIONS.find((x) => x.name === actor.division);
            if (d) {
                list.push({ level: 'division', region: d.region, division: d.name, ccc_code: '', ccc_name: '', office_label: d.name + ' Division' });
                officesLib.CCCS.filter((c) => c.division === d.name).forEach((c) => {
                    list.push({ level: 'ccc', region: c.region, division: c.division, ccc_code: c.code, ccc_name: c.name, office_label: c.name + ' CCC' });
                });
            }
        }
        return list.filter((o) => officeUnderActor(actor, o));
    }

    /** Active users at offices under the actor (for the optional people pick): name, email and office only. */
    async function scopedUsers(actor) {
        let rows = [];
        try {
            rows = await pb.all(USERS, {
                filter: 'status = "active"', sort: 'name', max: 2000,
                fields: 'email,name,username,role,scope_level,region,division,ccc_code'
            });
        } catch (err) {
            // app_users only exists with the VM user store; without it, return empty.
            return [];
        }
        return rows.map((u) => {
            const isAdmin = lower(u.role) === 'admin';
            const level = isAdmin ? 'zone' : String(u.scope_level || '').trim();
            const region = isAdmin ? '' : canonRegion(u.region);
            const division = isAdmin ? '' : String(u.division || '').trim();
            const ccc_code = isAdmin ? '' : String(u.ccc_code || '').trim();
            const ccc = ccc_code ? (officesLib.CCCS.find((c) => c.code === ccc_code) || null) : null;
            const office = { level, region, division, ccc_code, ccc_name: ccc ? ccc.name : '', office_label: '' };
            if (level === 'ccc' && ccc) office.office_label = ccc.name + ' CCC';
            else if (level === 'division') office.office_label = division + ' Division';
            else if (level === 'region') office.office_label = region + ' Region';
            else if (level === 'zone' || isAdmin) office.office_label = 'Malda Zone';
            return {
                email: lower(u.email),
                name: String(u.name || u.username || u.email || '').trim(),
                level: office.level,
                region: office.region,
                division: office.division,
                ccc_code: office.ccc_code,
                ccc_name: office.ccc_name,
                office_label: office.office_label
            };
        }).filter((u) => u.email && officeUnderActor(actor, u));
    }

    function mount(app) {
        // The shell polls this on every host: off (Vercel, local) is a plain answer, not an error.
        app.get('/api/collect/status', async (req, res) => {
            if (!on) return res.json({ available: false, pending_count: 0, can_create: false });
            let user = null;
            try { user = await userOf(req); } catch (_) { user = null; }
            if (!user) return res.status(401).json({ available: false, pending_count: 0, can_create: false });
            const office = profileOffice(user);
            try {
                const inbox = await inboxFor(user);
                res.json({
                    available: true,
                    pending_count: inbox.pending_count,
                    can_create: inbox.can_create,
                    office: { level: office.level, region: office.region, division: office.division, ccc_code: office.ccc_code }
                });
            } catch (err) {
                console.error('[Collect] status:', (err && err.message) || err);
                res.json({ available: false, pending_count: 0, can_create: canCreate(office) });
            }
        });

        app.get('/api/collect/inbox', wrap(async (req, res, user) => {
            res.json(await inboxFor(user));
        }));

        app.get('/api/collect/requests', wrap(async (req, res, user) => {
            res.json(await myRequests(user));
        }));

        app.post('/api/collect/requests', wrap(async (req, res, user) => {
            res.status(201).json(await createRequest(user, req.body || {}, req));
        }));

        app.get('/api/collect/requests/:id', wrap(async (req, res, user) => {
            const d = await requestDetail(user, req.params.id);
            res.json({ request: d.request, assignments: d.assignments });
        }));

        app.get('/api/collect/requests/:id/export', wrap(async (req, res, user) => {
            res.json(await exportRequest(user, req.params.id));
        }));

        app.post('/api/collect/requests/:id/extend', wrap(async (req, res, user) => {
            res.json(await extendRequest(user, req.params.id, req.body || {}));
        }));

        app.post('/api/collect/requests/:id/offices', wrap(async (req, res, user) => {
            res.json(await addOffices(user, req.params.id, req.body || {}, req));
        }));

        app.post('/api/collect/requests/:id/offices/remove', wrap(async (req, res, user) => {
            res.json(await removeOffices(user, req.params.id, req.body || {}));
        }));

        app.get('/api/collect/assignments/:id', wrap(async (req, res, user) => {
            res.json(await assignmentDetail(user, req.params.id));
        }));

        app.put('/api/collect/assignments/:id/draft', wrap(async (req, res, user) => {
            res.json(await saveDraft(user, req.params.id, req.body || {}, req));
        }));

        app.post('/api/collect/assignments/:id/submit', wrap(async (req, res, user) => {
            res.json(await submitAssignment(user, req.params.id, req.body || {}, req));
        }));

        app.post('/api/collect/assignments/:id/return', wrap(async (req, res, user) => {
            res.json(await returnAssignment(user, req.params.id));
        }));

        app.get('/api/collect/offices', wrap(async (req, res, user) => {
            const actor = profileOffice(user);
            if (!canCreate(actor)) throw new CollectError(403, 'Not allowed');
            res.json({ offices: listAssignableOffices(actor) });
        }));

        app.get('/api/collect/users', wrap(async (req, res, user) => {
            const actor = profileOffice(user);
            if (!canCreate(actor)) throw new CollectError(403, 'Not allowed');
            res.json({ users: await scopedUsers(actor) });
        }));
    }

    return {
        on, mount, inboxFor,
        _test: { timingOf, normalizeOffice, officeUnderActor, profileOffice, assignmentMatchesUser, flattenPayload, canManageRequest, cleanSchema, cleanPayload }
    };
}

module.exports = { create, CollectError, timingOf, normalizeOffice, cleanSchema, cleanPayload, canManageRequest, LIMITS };
