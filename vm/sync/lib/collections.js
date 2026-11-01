'use strict';
// Create or alter a ds_<key> collection so its fields match the inferred columns.
// Data fields come first (source order), then the sync system fields.
//
// PocketBase cannot change a field's type in place, and dropping and re-adding a field empties
// it until every row is rewritten. So a column whose type changed is migrated in two steps that
// never leave the portal without values:
//   1. prepare (before the rows are written): the new field is added next to the old one as
//      _stage_<name>; the old field keeps its values. Fields the source no longer has stay too.
//   2. finish (after every row is written): one collection update drops the old fields and
//      renames each _stage_<name> to <name> (PocketBase renames the column, keeping its values).
// A run that dies between the two leaves both fields; the next run finds _stage_<name>, keeps it
// and only writes the rows that did not get their new values yet (their _hash still differs).

const PORTAL_RULE = '@request.auth.collectionName = "portal_users_auth"';
const TEXT_MAX = 1000000;
const JSON_MAX = 5000000;
const STAGE = '_stage_';
const NULLS_FIELD = '_nulls';

function dataFieldDef(col) {
    switch (col.type) {
        case 'number':
            return { name: col.name, type: 'number', onlyInt: false, required: false };
        case 'date':
            return { name: col.name, type: 'date', required: false };
        case 'bool':
            return { name: col.name, type: 'bool', required: false };
        case 'json':
            return { name: col.name, type: 'json', maxSize: JSON_MAX, required: false };
        default:
            return { name: col.name, type: 'text', max: TEXT_MAX, required: false };
    }
}

// _nulls: the number and bool fields of the row that are empty in the source (PocketBase stores
// them as 0 / false). null when there are none.
const SYSTEM_DEFS = [
    { name: '_row_no', type: 'number', onlyInt: true, required: false },
    { name: '_row_key', type: 'text', max: 2000, required: true },
    { name: '_hash', type: 'text', max: 64, required: false },
    { name: '_synced_at', type: 'date', required: false },
    { name: NULLS_FIELD, type: 'json', maxSize: 200000, required: false }
];

function indexesFor(name) {
    return [
        `CREATE UNIQUE INDEX \`idx_${name}_row_key\` ON \`${name}\` (\`_row_key\`)`,
        `CREATE INDEX \`idx_${name}_row_no\` ON \`${name}\` (\`_row_no\`)`
    ];
}

const RULES = {
    listRule: PORTAL_RULE,
    viewRule: PORTAL_RULE,
    createRule: null,
    updateRule: null,
    deleteRule: null
};

/** Does an existing field already satisfy the wanted definition? */
function sameField(ex, want) {
    if (!ex || ex.type !== want.type) return false;
    if (want.type === 'text') return Number(ex.max) === want.max && !!ex.required === !!want.required;
    if (want.type === 'json') return Number(ex.maxSize) === want.maxSize;
    if (want.type === 'number') return !!ex.onlyInt === !!want.onlyInt;
    return true;
}

/** Existing field `ex` brought to `want` (same id, so PocketBase keeps the column), and whether that changed it. */
function adopt(ex, want, name) {
    const same = sameField(ex, want) && ex.name === (name || want.name);
    return { field: same ? ex : Object.assign({}, ex, want, { id: ex.id, name: name || want.name }), changed: !same };
}

const order = (list) => list.map((f) => f.name).join(',');

/**
 * Make collection `name` ready for this run's rows (step 1 above).
 * @param {{name, type}[]} columns data fields, _raw companions and office fields, in order
 * @returns {Promise<{ created, altered, staged: string[], dropped: string[], oldTypes, force: boolean,
 *   writeName(name) → field to write the column to, finish() → Promise<{altered}> }>}
 *   force: a field was added that existing rows have no value in yet, so every row must be written.
 */
async function ensureCollection(pb, name, columns) {
    const wanted = columns.map(dataFieldDef).concat(SYSTEM_DEFS);
    const existing = await pb.getCollection(name);
    const none = { staged: [], dropped: [], oldTypes: {}, force: false, writeName: (n) => n, finish: async () => ({ altered: false }) };
    if (!existing) {
        const collection = await pb.createCollection(Object.assign({
            name,
            type: 'base',
            fields: wanted,
            indexes: indexesFor(name)
        }, RULES));
        return Object.assign({ created: true, altered: false, collection }, none);
    }
    if (existing.type !== 'base') throw new Error(`${name} exists but is a ${existing.type} collection`);

    const byName = new Map(existing.fields.map((f) => [f.name, f]));
    const wantedNames = new Set(wanted.map((f) => f.name));
    const fields = [existing.fields.find((f) => f.name === 'id')];
    const staged = new Map(); // column name → staging field name
    const oldTypes = {}; // column name → the type of the field the portal still shows while staged
    let changed = false;
    let force = false;
    for (const want of wanted) {
        const ex = byName.get(want.name);
        if (ex && ex.type === want.type) {
            const a = adopt(ex, want);
            fields.push(a.field);
            changed = changed || a.changed;
        } else if (ex) {
            // Retyped: keep the old field (and its values) until the new values are written.
            const sname = STAGE + want.name;
            const sx = byName.get(sname);
            fields.push(ex);
            if (sx && sx.type === want.type) {
                const a = adopt(sx, want, sname); // an earlier run's staging field: resume
                fields.push(a.field);
                changed = changed || a.changed;
            } else {
                fields.push(Object.assign({}, want, { name: sname })); // (a wrong-typed leftover is replaced)
                changed = true;
                force = true;
            }
            staged.set(want.name, sname);
            oldTypes[want.name] = ex.type;
        } else {
            fields.push(want);
            changed = true;
            // A new field is empty in existing rows; _nulls empty is null, which is right for them.
            if (want.name !== NULLS_FIELD) force = true;
        }
    }
    // Fields the columns no longer have stay until finish(), so the portal keeps showing them.
    // Leftover staging fields of columns that are not retyped any more hold nothing anyone reads.
    const dropped = [];
    for (const f of existing.fields) {
        if (f.name === 'id' || wantedNames.has(f.name)) continue;
        if (f.name.startsWith(STAGE)) {
            if (staged.get(f.name.slice(STAGE.length)) === f.name) continue;
            changed = true;
            continue;
        }
        fields.push(f);
        dropped.push(f.name);
    }
    if (!changed && order(existing.fields) !== order(fields)) changed = true;

    const wantIdx = indexesFor(name);
    const idxChanged = wantIdx.some((i) => !existing.indexes.includes(i));
    const rulesChanged = Object.keys(RULES).some((k) => existing[k] !== RULES[k]);
    let collection = existing;
    if (changed || idxChanged || rulesChanged) {
        const patch = Object.assign({}, RULES);
        if (changed) patch.fields = fields;
        if (idxChanged) patch.indexes = Array.from(new Set(existing.indexes.concat(wantIdx)));
        collection = await pb.updateCollection(existing.id, patch);
    }

    return {
        created: false,
        altered: changed,
        collection,
        staged: [...staged.keys()],
        dropped,
        oldTypes,
        force,
        writeName: (n) => staged.get(n) || n,
        // Step 2: one update swaps the staging fields in and drops what the source lost.
        async finish() {
            if (!staged.size && !dropped.length) return { altered: false };
            const now = await pb.getCollection(name);
            const have = new Map(now.fields.map((f) => [f.name, f]));
            const final = [have.get('id')];
            for (const want of wanted) {
                const sname = staged.get(want.name);
                const f = sname ? have.get(sname) : have.get(want.name);
                if (!f) throw new Error(`${name}: field ${sname || want.name} is missing before the swap`);
                final.push(sname ? Object.assign({}, f, { name: want.name }) : f);
            }
            await pb.updateCollection(now.id, { fields: final });
            return { altered: true };
        }
    };
}

module.exports = { PORTAL_RULE, NULLS_FIELD, STAGE, ensureCollection, dataFieldDef, SYSTEM_DEFS };
