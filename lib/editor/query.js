'use strict';
// Reading rows for the editor grid: structured filters → a PocketBase filter (never raw filter text
// from the browser), sort and search, and every record → the cells the grid shows.
//
// Native rows show their exact source cells (_src). Mirror rows show the typed values the sync
// stored, written back as text the way the portal shows them: an empty number or yes/no (listed in
// _nulls) is empty, dates are dd/mm/yyyy (India time when the column has times), and a value that did
// not parse is shown from its _raw companion.

const R = require('./records');

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const MAX_FILTER = 3400;
const q = (v) => "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const likeEsc = (v) => String(v).replace(/[\\%_]/g, '\\$&');

/** Columns the grid shows: [{ name, source_name, type, date_order?, has_time?, index?, raw_name? }] */
function gridColumns(ds) {
    if (ds.mode === 'native' && ds.native_format && Array.isArray(ds.native_format.columns)) {
        return ds.native_format.columns.map((c) => ({ name: c.name, source_name: c.source_name, type: c.type, date_order: c.date_order, has_time: c.has_time, index: c.index, raw_name: c.raw_name || null }));
    }
    const cols = Array.isArray(ds.columns) ? ds.columns : [];
    const raws = new Map(cols.filter((c) => c.raw_of).map((c) => [c.raw_of, c.name]));
    return cols.filter((c) => !c.raw_of && IDENT.test(c.name)).map((c) => ({ name: c.name, source_name: c.source_name, type: c.type, date_order: c.date_order, has_time: c.has_time, raw_name: raws.get(c.name) || null }));
}

function pbDay(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
}
const stamp = (d) => d.toISOString().replace('T', ' ');

/** One structured condition → filter text. Throws Error(message) for a bad value. */
function clause(f, col) {
    const F = col.name;
    const v = f.value == null ? '' : String(f.value);
    const op = String(f.op || '');
    if (col.type === 'number') {
        if (op === 'empty') return `(${F} = 0 && _nulls ~ ${q('"' + F + '"')})`;
        if (op === 'nempty') return `!(${F} = 0 && _nulls ~ ${q('"' + F + '"')})`;
        const x = Number(v.replace(/,/g, '').trim());
        if (!v.trim() || !Number.isFinite(x)) throw new Error('Enter a number.');
        const sym = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
        if (!sym) throw new Error('Unknown condition.');
        return `${F} ${sym} ${x}`;
    }
    if (col.type === 'bool') {
        if (op === 'true') return `${F} = true`;
        if (op === 'false') return `(${F} = false && _nulls !~ ${q('"' + F + '"')})`;
        if (op === 'empty') return `_nulls ~ ${q('"' + F + '"')}`;
        throw new Error('Unknown condition.');
    }
    if (col.type === 'date') {
        if (op === 'empty') return `${F} = ''`;
        if (op === 'nempty') return `${F} != ''`;
        const a = pbDay(v);
        if (!a) throw new Error('Pick a date.');
        const next = (d) => new Date(d.getTime() + 86400000);
        if (op === 'before') return `${F} < ${q(stamp(a))}`;
        if (op === 'after') return `${F} >= ${q(stamp(a))}`;
        if (op === 'on') return `(${F} >= ${q(stamp(a))} && ${F} < ${q(stamp(next(a)))})`;
        throw new Error('Unknown condition.');
    }
    if (op === 'empty') return `${F} = ''`;
    if (op === 'nempty') return `${F} != ''`;
    if (v === '') throw new Error('Enter a value.');
    switch (op) {
        case 'eq': return `${F} = ${q(v)}`;
        case 'neq': return `${F} != ${q(v)}`;
        case 'starts': return `${F} ~ ${q(likeEsc(v) + '%')}`;
        case 'ncontains': return `${F} !~ ${q('%' + likeEsc(v) + '%')}`;
        case 'contains': return `${F} ~ ${q('%' + likeEsc(v) + '%')}`;
        default: throw new Error('Unknown condition.');
    }
}

/**
 * @param cols gridColumns()
 * @param input { filters: [{field, op, value}], q, sort: 'field' | '-field' }
 * @param scope perms scope or null
 * @returns { filter, sort }
 */
function build(cols, input, scope) {
    const byName = new Map(cols.map((c) => [c.name, c]));
    const parts = [];
    for (const f of (input && Array.isArray(input.filters) ? input.filters : []).slice(0, 20)) {
        const col = byName.get(String(f && f.field));
        if (!col) throw Object.assign(new Error('Unknown column in a filter.'), { status: 400 });
        try { parts.push('(' + clause(f, col) + ')'); } catch (err) { throw Object.assign(err, { status: 400 }); }
    }
    const text = String((input && input.q) || '').trim().slice(0, 200);
    if (text) {
        const ors = cols.filter((c) => c.type === 'text').slice(0, 60).map((c) => `${c.name} ~ ${q('%' + likeEsc(text) + '%')}`);
        const x = Number(text.replace(/,/g, ''));
        if (/^-?[\d,]+(\.\d+)?$/.test(text) && Number.isFinite(x)) cols.filter((c) => c.type === 'number').slice(0, 30).forEach((c) => ors.push(`${c.name} = ${x}`));
        if (ors.length) parts.push('(' + ors.join(' || ') + ')');
    }
    if (scope) parts.push('(' + scope.filter + ')');
    const filter = parts.join(' && ');
    if (filter.length > MAX_FILTER) throw Object.assign(new Error('Too many filters for one query; remove one.'), { status: 400 });
    let sort = '_row_no,id';
    const s = String((input && input.sort) || '');
    const name = s.replace(/^[-+]/, '');
    if (name && (byName.has(name) || name === '_row_no')) sort = (s[0] === '-' ? '-' : '') + name + ',_row_no,id';
    return { filter, sort };
}

const pad = (n) => String(n).padStart(2, '0');
function fmtDate(v, col) {
    const t = Date.parse(String(v).replace(' ', 'T'));
    if (!Number.isFinite(t)) return String(v);
    const hasTime = !!col.has_time;
    const d = new Date(hasTime ? t + 330 * 60000 : t);
    const day = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
    return hasTime ? `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day;
}

/** A record → the grid row { id, hash, row_no, cells, office }. */
function toRow(rec, cols, native, width) {
    const out = { id: rec.id, hash: rec._hash || '', row_no: rec._row_no || 0, office: rec._ccc || rec._division || rec._region || '' };
    if (native) {
        const src = R.cellsOf(rec, width);
        out.cells = cols.map((c) => (src[c.index] == null ? '' : String(src[c.index])));
        return out;
    }
    const nulls = new Set(Array.isArray(rec._nulls) ? rec._nulls : []);
    out.cells = cols.map((c) => {
        const v = rec[c.name];
        const raw = c.raw_name ? rec[c.raw_name] : '';
        if (raw) return String(raw);
        if (v === null || v === undefined) return '';
        if (c.type === 'number') return nulls.has(c.name) && v === 0 ? '' : String(v);
        if (c.type === 'bool') return nulls.has(c.name) && v === false ? '' : (v ? 'Yes' : 'No');
        if (c.type === 'date') return v ? fmtDate(v, c) : '';
        if (c.type === 'json') return typeof v === 'string' ? v : JSON.stringify(v);
        return String(v);
    });
    return out;
}

/** The fields to ask PocketBase for. */
function fieldsFor(cols, native) {
    const set = new Set(['id', '_row_no', '_hash', '_nulls', '_region', '_division', '_ccc_code', '_ccc']);
    if (native) set.add(R.SRC_FIELD);
    else for (const c of cols) { set.add(c.name); if (c.raw_name) set.add(c.raw_name); }
    return [...set].join(',');
}

module.exports = { gridColumns, build, clause, toRow, fieldsFor, IDENT };
