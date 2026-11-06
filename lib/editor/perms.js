'use strict';
// Who may do what in the data editor (docs/data-editor.md). Enforced here, on every request; the
// page only hides what the server already refuses.
//
//   admins       everything (req.user.isAdmin, or role 'admin' as everywhere else in the app)
//   others       one app_dataset_permissions row per (user_email, dataset_key): can_view, can_add,
//                can_edit, can_delete, scope_only. A row for dataset_key '*' applies to every dataset
//                that has no row of its own. No row: no access.
//   scope_only   only rows whose office (_region / _division / _ccc_code, filled by the sync from the
//                row's office columns) is inside the office of the user's login.
//   sensitive    datasets holding PINs, bank or identity numbers are admin-only, whatever the rows say.

const O = require('../offices.js');

const PERMS = 'app_dataset_permissions';
const CACHE_MS = 30000;
const RIGHTS = ['can_view', 'can_add', 'can_edit', 'can_delete'];

function userOf(req) {
    const u = req.user || null;
    if (!u) return null;
    const email = String(u.email || u.Email || '').trim().toLowerCase();
    const isAdmin = u.isAdmin === true || String(u.role || '').toLowerCase() === 'admin';
    // VM-only admins (MZO_LOCAL_ADMINS) may have no email: they are named by their username.
    const id = email || (isAdmin ? 'local:' + String(u.Username || u.username || 'admin').toLowerCase() : '');
    return { email, id, isAdmin, name: String(u.Name || u.name || u.Username || email || '').slice(0, 120), profile: u };
}

/** The office of a login: ccc, else division, else region; null for the whole zone. */
function officeOf(profile) {
    const p = profile || {};
    const pick = (raw, kinds) => {
        const s = String(raw == null ? '' : raw).trim();
        if (!s || /^(all|y|none|n\/?a|-)$/i.test(s)) return null;
        for (const k of kinds) {
            const o = k === 'code' ? O.parseCode(s) : k === 'ccc' ? O.parseCccName(s) : k === 'division' ? O.parseDivision(s) : O.parseRegion(s);
            if (o && o.level && o.level !== 'zone') return o;
        }
        return null;
    };
    const ccc = pick(p.ccc_code, ['code', 'ccc']);
    if (ccc && ccc.level === 'ccc') return { level: 'ccc', ccc_code: ccc.ccc_code, ccc: ccc.ccc, division: ccc.division, region: ccc.region };
    const div = pick(p.division_code, ['code', 'division']);
    if (div && (div.level === 'division' || div.level === 'ccc')) return { level: 'division', division: div.division, region: div.region };
    const reg = pick(p.region_code, ['code', 'region']);
    if (reg && reg.region) return { level: 'region', region: reg.region };
    return null;
}

/** A row matcher (on _region / _division / _ccc_code) and the PocketBase filter for an office. */
function scopeFor(office) {
    if (!office) return null;
    const q = (v) => "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    if (office.level === 'ccc') return { office, filter: '_ccc_code=' + q(office.ccc_code), match: (r) => !!r && r._ccc_code === office.ccc_code, label: office.ccc + ' CCC' };
    if (office.level === 'division') return { office, filter: '_division=' + q(office.division), match: (r) => !!r && r._division === office.division, label: office.division + ' Division' };
    return { office, filter: '_region=' + q(office.region), match: (r) => !!r && r._region === office.region, label: office.region + ' Region' };
}

function create(envx, opts) {
    const isSensitive = (opts && opts.isSensitive) || (() => false);
    const cache = new Map(); // email → { at, rows }

    async function rowsFor(email) {
        const hit = cache.get(email);
        if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
        const pb = await envx.client();
        const q = "'" + email.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
        const res = await pb.listRecords(PERMS, { page: 1, perPage: 500, skipTotal: 1, filter: 'user_email=' + q });
        const rows = res.items || [];
        cache.set(email, { at: Date.now(), rows });
        return rows;
    }

    function invalidate(email) {
        if (email) cache.delete(String(email).toLowerCase());
        else cache.clear();
    }

    /**
     * Rights of a user on a dataset. → { can_view, can_add, can_edit, can_delete, scope_only, scope, source }
     * scope: null (all rows) or { filter, match, label } (only rows of their office).
     */
    async function rights(user, key, ds) {
        const none = { can_view: false, can_add: false, can_edit: false, can_delete: false, scope_only: false, scope: null, source: 'none' };
        if (!user) return none;
        if (user.isAdmin) return { can_view: true, can_add: true, can_edit: true, can_delete: true, scope_only: false, scope: null, source: 'admin' };
        if (!user.email) return none;
        if (isSensitive(key, ds)) return Object.assign({}, none, { source: 'sensitive' });
        const rows = await rowsFor(user.email);
        const row = rows.find((r) => r.dataset_key === key) || rows.find((r) => r.dataset_key === '*');
        if (!row) return none;
        const out = { scope_only: !!row.scope_only, scope: null, source: row.dataset_key === '*' ? 'all datasets' : 'dataset' };
        for (const k of RIGHTS) out[k] = !!row[k];
        if (out.can_add || out.can_edit || out.can_delete) out.can_view = true; // writing implies reading
        if (out.scope_only) {
            const office = officeOf(user.profile);
            out.scope = scopeFor(office); // null: the login covers the whole zone
            if (out.scope && ds && !ds._hasOffices) {
                // The dataset has no office columns, so no row is inside any office.
                out.scope = { office, filter: 'id=""', match: () => false, label: out.scope.label, noOffices: true };
            }
        }
        return out;
    }

    async function list(filter) {
        const pb = await envx.client();
        const out = [];
        let page = 1;
        for (;;) {
            const res = await pb.listRecords(PERMS, { page, perPage: 500, skipTotal: 1, sort: 'user_email,dataset_key', filter: filter || undefined });
            out.push(...(res.items || []));
            if ((res.items || []).length < 500) return out;
            page++;
        }
    }

    return { rights, rowsFor, invalidate, list, PERMS };
}

module.exports = { create, userOf, officeOf, scopeFor, RIGHTS };
