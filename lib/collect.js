'use strict';
/* lib/collect.js — DISHA Collect (VM PocketBase).
 * Admin / region / division officers request structured reports from subordinate offices.
 * One shared draft per assignment/office; last-writer stamp; late stamp during extension.
 * Off without PB_URL + superuser (Vercel / local default). See docs/collect.md.
 *
 *   const collect = create({ env, clientIp })
 *   collect.mount(app)   // /api/collect/*
 *   collect.on           // true when PocketBase credentials are set
 */
const officesLib = require('./offices');

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
    get(coll, id) { return this.req('GET', `${this.records(coll)}/${encodeURIComponent(id)}`); }
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
function officeKey(o) {
    return [o.level, o.region || '', o.division || '', o.ccc_code || ''].join('|');
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

function canManageRequest(actor, row) {
    if (!row) return false;
    if (actor.isAdmin || actor.level === 'zone') return true;
    return lower(row.created_by_email) === actor.email;
}

function flattenPayload(schemaFields, payload, rows, path) {
    path = path || [];
    const data = (payload && payload.fields) || payload || {};
    (schemaFields || []).forEach((f) => {
        if (f.type === 'group') {
            const list = Array.isArray(data[f.id]) ? data[f.id] : [];
            if (!list.length) {
                rows.push({ path: path.concat([f.label || f.id]).join(' › '), value: '(empty list)' });
                return;
            }
            list.forEach((item, i) => {
                const p = path.concat([(f.label || f.id) + ' #' + (i + 1)]);
                flattenPayload(f.children || [], item, rows, p);
            });
        } else {
            const v = data[f.id];
            rows.push({
                path: path.concat([f.label || f.id]).join(' › '),
                value: v == null || v === '' ? '' : (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v))
            });
        }
    });
}

function create({ env, clientIp } = {}) {
    env = env || process.env;
    const url = String(env.PB_URL || '').trim();
    const email = String(env.PB_SUPERUSER_EMAIL || '').trim();
    const password = String(env.PB_SUPERUSER_PASSWORD || '').trim();
    const on = !!(url && email && password);
    const pb = on ? new Pb({ url, email, password }) : null;
    const ipOf = typeof clientIp === 'function' ? clientIp : (req) => {
        try { return require('./local_admins').clientIp(req); } catch (_) { return ''; }
    };

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

    function makeStamp(actor, req, late) {
        return {
            stamp_email: actor.email,
            stamp_name: actor.name,
            stamp_username: actor.username,
            stamp_office_level: actor.level,
            stamp_region: actor.region,
            stamp_division: actor.division,
            stamp_ccc_code: actor.ccc_code,
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
        const rows = await pb.all(SUBMISSIONS, { filter: 'assignment_id = ' + q(assignmentId), max: 1 });
        return rows[0] || null;
    }

    async function createAssignmentWithDraft(row, o, actor, req, due_at, extended_due_at) {
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
        await pb.create(SUBMISSIONS, Object.assign({
            assignment_id: a.id,
            request_id: row.id,
            payload: { fields: {} },
            status: 'draft',
            revision: 0
        }, makeStamp(actor, req, false)));
        return a;
    }

    async function inboxFor(user) {
        const office = profileOffice(user);
        const openReqs = await pb.all(REQUESTS, { filter: 'status = "open"', sort: '-created', max: 500 });
        const reqById = {};
        openReqs.forEach((r) => { reqById[r.id] = r; });
        if (!openReqs.length) return { available: true, can_create: canCreate(office), items: [], pending_count: 0 };

        const asgs = await pb.all(ASSIGNMENTS, { filter: 'status != "withdrawn"', sort: '-updated', max: 2000 });
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
            if (!officeUnderActor(actor, o)) throw new CollectError(403, 'Office out of your scope: ' + o.office_label);
        }
        const seen = {};
        const unique = [];
        offices.forEach((o) => {
            const key = officeKey(o);
            if (seen[key]) return;
            seen[key] = 1;
            unique.push(o);
        });
        const schema = (body && body.schema) || { fields: [] };
        if (!schema.fields || !schema.fields.length) throw new CollectError(400, 'Report format needs at least one field');

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
            asgRows.push(await createAssignmentWithDraft(row, o, actor, req, due_at, extended_due_at));
        }
        return { request: row, assignments: asgRows };
    }

    async function extendRequest(user, id, body) {
        const actor = profileOffice(user);
        const row = await getRequest(id);
        if (row.status !== 'open') throw new CollectError(400, 'Request is not open');
        if (!canManageRequest(actor, row)) throw new CollectError(403, 'Only the requester or an admin can extend this deadline');
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

    async function requestDetail(user, id) {
        const actor = profileOffice(user);
        const row = await getRequest(id);
        if (!canManageRequest(actor, row) && !actor.isAdmin) {
            // Assignees may not see the full tree of other offices — only managers.
            throw new CollectError(403, 'Not allowed to view this request');
        }
        const asgs = await pb.all(ASSIGNMENTS, { filter: 'request_id = ' + q(id), sort: 'office_label', max: 500 });
        const subs = await pb.all(SUBMISSIONS, { filter: 'request_id = ' + q(id), max: 500 });
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
                schema: row.schema || { fields: [] },
                offices: row.offices || [],
                created_by_name: row.created_by_name,
                created_by_email: row.created_by_email,
                timing
            },
            assignments
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
        const can_edit = isAssignee && timing.can_edit && !statusBlocks;
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
            schema: row.schema || { fields: [] },
            payload: (s && s.payload) || { fields: {} },
            submission: s ? {
                id: s.id,
                status: s.status,
                revision: s.revision,
                stamp_late: !!s.stamp_late,
                stamp_name: s.stamp_name,
                stamp_at: s.stamp_at
            } : null,
            timing,
            can_edit,
            is_manager: isManager
        };
    }

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

        const payload = (body && body.payload) || { fields: {} };
        const stamp = makeStamp(actor, req, timing.late);
        let s = await submissionFor(a.id);
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
            last_saved_by_email: actor.email,
            last_saved_by_name: actor.name
        });
        return { ok: true, revision: s.revision, late: timing.late, stamp };
    }

    async function submitAssignment(user, id, body, req) {
        // Save first, then lock as submitted.
        await saveDraft(user, id, body, req);
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
            last_saved_by_email: actor.email,
            last_saved_by_name: actor.name
        });
        return { ok: true, late: timing.late };
    }

    async function returnAssignment(user, id) {
        const actor = profileOffice(user);
        const a = await getAssignment(id);
        const row = await getRequest(a.request_id);
        if (!canManageRequest(actor, row)) throw new CollectError(403, 'Only the requester or an admin can return a submission');
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
        const row = await getRequest(id);
        if (row.status !== 'open') throw new CollectError(400, 'Request is not open');
        if (!canManageRequest(actor, row)) throw new CollectError(403, 'Not allowed');
        const officesIn = Array.isArray(body && body.offices) ? body.offices : [];
        if (!officesIn.length) throw new CollectError(400, 'Pick at least one office');
        const existing = await pb.all(ASSIGNMENTS, { filter: 'request_id = ' + q(id), max: 500 });
        const have = {};
        existing.forEach((a) => {
            if (a.status === 'withdrawn') return;
            have[officeKey({ level: a.office_level, region: a.region, division: a.division, ccc_code: a.ccc_code })] = 1;
        });
        const added = [];
        const officesSnap = Array.isArray(row.offices) ? row.offices.slice() : [];
        for (const raw of officesIn) {
            const o = normalizeOffice(raw);
            if (!officeUnderActor(actor, o)) throw new CollectError(403, 'Office out of your scope: ' + o.office_label);
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
        await pb.update(REQUESTS, id, { offices: officesSnap });
        return { added: added.length, assignments: added };
    }

    async function removeOffices(user, id, body) {
        const actor = profileOffice(user);
        const row = await getRequest(id);
        if (row.status !== 'open') throw new CollectError(400, 'Request is not open');
        if (!canManageRequest(actor, row)) throw new CollectError(403, 'Not allowed');
        const ids = Array.isArray(body && body.assignment_ids) ? body.assignment_ids : [];
        if (!ids.length) throw new CollectError(400, 'assignment_ids required');
        let n = 0;
        for (const aid of ids) {
            const a = await getAssignment(aid);
            if (a.request_id !== id) continue;
            if (a.status === 'submitted') throw new CollectError(400, 'Cannot remove a submitted office — return it first or leave it');
            await pb.update(ASSIGNMENTS, a.id, { status: 'withdrawn' });
            n += 1;
        }
        const asgs = await pb.all(ASSIGNMENTS, { filter: 'request_id = ' + q(id) + ' && status != "withdrawn"', max: 500 });
        const officesSnap = asgs.map((a) => ({
            level: a.office_level, region: a.region, division: a.division,
            ccc_code: a.ccc_code, ccc_name: a.ccc_name, office_label: a.office_label
        }));
        await pb.update(REQUESTS, id, { offices: officesSnap });
        return { removed: n };
    }

    async function exportRequest(user, id) {
        const detail = await requestDetail(user, id);
        const row = detail.request;
        const asgs = await pb.all(ASSIGNMENTS, { filter: 'request_id = ' + q(id) + ' && status != "withdrawn"', max: 500 });
        const out = [];
        for (const a of asgs) {
            const s = await submissionFor(a.id);
            const flat = [];
            flattenPayload((row.schema && row.schema.fields) || [], (s && s.payload) || {}, flat);
            out.push({
                office: a.office_label,
                status: a.status,
                last_saved_by: a.last_saved_by_name || '',
                submitted_at: a.submitted_at || '',
                late: !!(s && s.stamp_late),
                rows: flat
            });
        }
        return { title: row.title, request_id: id, offices: out };
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
            res.status(201).json(await createRequest(req.user, req.body || {}, req));
        }));

        app.get('/api/collect/requests/:id', wrap(async (req, res) => {
            res.json(await requestDetail(req.user, req.params.id));
        }));

        app.get('/api/collect/requests/:id/export', wrap(async (req, res) => {
            res.json(await exportRequest(req.user, req.params.id));
        }));

        app.post('/api/collect/requests/:id/extend', wrap(async (req, res) => {
            res.json(await extendRequest(req.user, req.params.id, req.body || {}));
        }));

        app.post('/api/collect/requests/:id/offices', wrap(async (req, res) => {
            res.json(await addOffices(req.user, req.params.id, req.body || {}, req));
        }));

        app.post('/api/collect/requests/:id/offices/remove', wrap(async (req, res) => {
            res.json(await removeOffices(req.user, req.params.id, req.body || {}));
        }));

        app.get('/api/collect/assignments/:id', wrap(async (req, res) => {
            res.json(await assignmentDetail(req.user, req.params.id));
        }));

        app.put('/api/collect/assignments/:id/draft', wrap(async (req, res) => {
            res.json(await saveDraft(req.user, req.params.id, req.body || {}, req));
        }));

        app.post('/api/collect/assignments/:id/submit', wrap(async (req, res) => {
            res.json(await submitAssignment(req.user, req.params.id, req.body || {}, req));
        }));

        app.post('/api/collect/assignments/:id/return', wrap(async (req, res) => {
            res.json(await returnAssignment(req.user, req.params.id));
        }));

        app.get('/api/collect/offices', wrap(async (req, res) => {
            const actor = profileOffice(req.user);
            if (!canCreate(actor)) throw new CollectError(403, 'Not allowed');
            res.json({ offices: listAssignableOffices(actor) });
        }));
    }

    return { on, mount, inboxFor, _test: { timingOf, normalizeOffice, officeUnderActor, profileOffice, assignmentMatchesUser, flattenPayload } };
}

module.exports = { create, CollectError, timingOf, normalizeOffice };
