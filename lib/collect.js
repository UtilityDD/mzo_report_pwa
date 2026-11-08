'use strict';
/* lib/collect.js — DISHA Collect (VM PocketBase).
 * Admin / region / division officers request structured reports from subordinate offices.
 * One shared draft per assignment/office; last-writer stamp; late stamp during extension.
 * Off without PB_URL + superuser (Vercel / local default). See docs/collect.md.
 *
 *   const collect = create({ env, offices, clientIp })
 *   collect.mount(app)   // /api/collect/*
 *   collect.on           // true when PocketBase credentials are set
 */
const officesLib = require('./offices');

const TEMPLATES = 'app_collect_templates';
const REQUESTS = 'app_collect_requests';
const ASSIGNMENTS = 'app_collect_assignments';
const SUBMISSIONS = 'app_collect_submissions';

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
    create(coll, body) { return this.req('POST', this.records(coll), body); }
    update(coll, id, body) { return this.req('PATCH', `${this.records(coll)}/${encodeURIComponent(id)}`, body); }
    async all(coll, { filter = '', sort = '', perPage = 200, max = 5000 } = {}) {
        const out = [];
        for (let page = 1; out.length < max; page++) {
            const q = { page: String(page), perPage: String(perPage), skipTotal: '1' };
            if (filter) q.filter = filter;
            if (sort) q.sort = sort;
            const r = await this.list(coll, q);
            const items = (r && r.items) || [];
            out.push(...items);
            if (items.length < perPage) break;
        }
        return out.slice(0, max);
    }
}

function q(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
function pbDate(d) {
    return new Date(d).toISOString().replace('T', ' ');
}
function lower(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function clip(v, max) { return String(v == null ? '' : v).slice(0, max); }

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

/** True when target office is under (or equal to) the actor's scope. */
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
        if (!region) throw new CollectError(400, 'Region office needs a region');
        return { level: 'region', region, division: '', ccc_code: '', ccc_name: '', office_label: region + ' Region' };
    }
    if (level === 'division') {
        const d = officesLib.DIVISIONS.find((x) => lower(x.name) === lower(division));
        if (!d) throw new CollectError(400, 'Unknown division: ' + division);
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
    // Shared draft at the assigned office: user must sit at that exact office.
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

function create({ env, clientIp } = {}) {
    env = env || process.env;
    const url = String(env.PB_URL || '').trim();
    const email = String(env.PB_SUPERUSER_EMAIL || '').trim();
    const password = String(env.PB_SUPERUSER_PASSWORD || '').trim();
    const on = !!(url && email && password);
    const pb = on ? new Pb({ url, email, password }) : null;
    const ipOf = typeof clientIp === 'function' ? clientIp : () => '';

    function unavailable(res) {
        return res.status(503).json({
            error: 'DISHA Collect needs the VM PocketBase (PB_URL + superuser). Not available on this host.',
            available: false
        });
    }

    function wrap(fn) {
        return async (req, res) => {
            try {
                if (!on) return unavailable(res);
                await fn(req, res);
            } catch (err) {
                const status = err.status || 500;
                if (status >= 500) console.error('[Collect]', err.message || err);
                res.status(status).json({ error: err.message || 'Collect error' });
            }
        };
    }

    async function inboxFor(user) {
        const office = profileOffice(user);
        const openReqs = await pb.all(REQUESTS, { filter: 'status = "open"', sort: '-created', max: 500 });
        const reqById = {};
        openReqs.forEach((r) => { reqById[r.id] = r; });
        if (!openReqs.length) return { available: true, can_create: canCreate(office), items: [], pending_count: 0 };

        const asgs = await pb.all(ASSIGNMENTS, {
            filter: 'status != "withdrawn"',
            sort: '-updated',
            max: 2000
        });
        const mine = asgs.filter((a) => reqById[a.request_id] && assignmentMatchesUser(a, office));
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

    async function createRequest(user, body, req) {
        const actor = profileOffice(user);
        if (!canCreate(actor)) throw new CollectError(403, 'Only admin, region or division officers can create Collect requests');
        const title = clip(body && body.title, 200).trim();
        if (!title) throw new CollectError(400, 'Title is required');
        const due_at = body && body.due_at ? new Date(body.due_at) : null;
        if (!due_at || isNaN(due_at.getTime())) throw new CollectError(400, 'due_at is required (ISO date)');
        let extended_due_at = null;
        if (body && body.extended_due_at) {
            extended_due_at = new Date(body.extended_due_at);
            if (isNaN(extended_due_at.getTime())) throw new CollectError(400, 'extended_due_at is invalid');
            if (extended_due_at.getTime() <= due_at.getTime()) throw new CollectError(400, 'extended_due_at must be after due_at');
        }
        const officesIn = Array.isArray(body && body.offices) ? body.offices : [];
        if (!officesIn.length) throw new CollectError(400, 'Pick at least one office');
        const offices = officesIn.map(normalizeOffice);
        for (const o of offices) {
            if (!officeUnderActor(actor, o)) {
                throw new CollectError(403, 'Office out of your scope: ' + o.office_label);
            }
        }
        // Dedupe by office key
        const seen = {};
        const unique = [];
        offices.forEach((o) => {
            const key = [o.level, o.region, o.division, o.ccc_code].join('|');
            if (seen[key]) return;
            seen[key] = 1;
            unique.push(o);
        });

        const schema = (body && body.schema) || { fields: [] };
        const row = await pb.create(REQUESTS, {
            template_id: clip((body && body.template_id) || '', 40),
            title,
            description: clip((body && body.description) || '', 2000),
            schema,
            due_at: pbDate(due_at),
            extended_due_at: extended_due_at ? pbDate(extended_due_at) : null,
            status: 'open',
            offices: unique,
            created_by_email: actor.email,
            created_by_name: actor.name,
            created_by_level: actor.level,
            created_by_region: actor.region,
            created_by_division: actor.division
        });

        const asgRows = [];
        for (const o of unique) {
            const a = await pb.create(ASSIGNMENTS, {
                request_id: row.id,
                office_level: o.level,
                region: o.region,
                division: o.division,
                ccc_code: o.ccc_code,
                ccc_name: o.ccc_name,
                office_label: o.office_label,
                assignee_user: '',
                status: 'pending',
                due_at: pbDate(due_at),
                extended_due_at: extended_due_at ? pbDate(extended_due_at) : null
            });
            asgRows.push(a);
            await pb.create(SUBMISSIONS, {
                assignment_id: a.id,
                request_id: row.id,
                payload: { fields: {} },
                status: 'draft',
                revision: 0,
                stamp_email: actor.email,
                stamp_name: actor.name,
                stamp_username: actor.username,
                stamp_office_level: actor.level,
                stamp_region: actor.region,
                stamp_division: actor.division,
                stamp_ccc_code: actor.ccc_code,
                stamp_at: pbDate(new Date()),
                stamp_ip: clip(ipOf(req), 64),
                stamp_late: false
            });
        }
        return { request: row, assignments: asgRows };
    }

    async function extendRequest(user, id, body) {
        const actor = profileOffice(user);
        if (!canCreate(actor)) throw new CollectError(403, 'Only admin, region or division officers can extend Collect deadlines');
        const row = (await pb.all(REQUESTS, { filter: 'id = ' + q(id), max: 1 }))[0];
        if (!row) throw new CollectError(404, 'Request not found');
        if (row.status !== 'open') throw new CollectError(400, 'Request is not open');
        if (!actor.isAdmin && lower(row.created_by_email) !== actor.email) {
            throw new CollectError(403, 'Only the requester or an admin can extend this deadline');
        }
        const ext = body && body.extended_due_at ? new Date(body.extended_due_at) : null;
        if (!ext || isNaN(ext.getTime())) throw new CollectError(400, 'extended_due_at is required');
        const due = new Date(row.due_at).getTime();
        if (ext.getTime() <= due) throw new CollectError(400, 'extended_due_at must be after due_at');

        const updated = await pb.update(REQUESTS, id, { extended_due_at: pbDate(ext) });
        const asgs = await pb.all(ASSIGNMENTS, { filter: 'request_id = ' + q(id), max: 500 });
        for (const a of asgs) {
            if (a.status === 'withdrawn' || a.status === 'submitted') continue;
            await pb.update(ASSIGNMENTS, a.id, { extended_due_at: pbDate(ext) });
        }
        return { request: updated };
    }

    async function myRequests(user) {
        const actor = profileOffice(user);
        if (!canCreate(actor)) return { items: [] };
        let filter = 'status != "cancelled"';
        if (!actor.isAdmin && actor.level !== 'zone') {
            filter += ' && created_by_email = ' + q(actor.email);
        }
        const rows = await pb.all(REQUESTS, { filter, sort: '-created', max: 200 });
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

    function mount(app) {
        app.get('/api/collect/status', wrap(async (req, res) => {
            const office = profileOffice(req.user);
            if (!on) return res.json({ available: false, pending_count: 0, can_create: false });
            try {
                const inbox = await inboxFor(req.user);
                res.json({
                    available: true,
                    pending_count: inbox.pending_count,
                    can_create: inbox.can_create,
                    office: { level: office.level, region: office.region, division: office.division, ccc_code: office.ccc_code }
                });
            } catch (err) {
                // Collection missing until migration runs
                res.json({ available: false, pending_count: 0, can_create: canCreate(office), error: err.message });
            }
        }));

        app.get('/api/collect/inbox', wrap(async (req, res) => {
            res.json(await inboxFor(req.user));
        }));

        app.get('/api/collect/requests', wrap(async (req, res) => {
            res.json(await myRequests(req.user));
        }));

        app.post('/api/collect/requests', wrap(async (req, res) => {
            const out = await createRequest(req.user, req.body || {}, req);
            res.status(201).json(out);
        }));

        app.post('/api/collect/requests/:id/extend', wrap(async (req, res) => {
            res.json(await extendRequest(req.user, req.params.id, req.body || {}));
        }));

        app.get('/api/collect/offices', wrap(async (req, res) => {
            const actor = profileOffice(req.user);
            if (!canCreate(actor)) throw new CollectError(403, 'Not allowed');
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
            res.json({ offices: list.filter((o) => officeUnderActor(actor, o)) });
        }));
    }

    return { on, mount, inboxFor };
}

module.exports = { create, CollectError };
