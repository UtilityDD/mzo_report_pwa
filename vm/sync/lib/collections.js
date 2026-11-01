'use strict';
// Create or alter a ds_<key> collection so its fields match the inferred columns.
// Data fields come first (source order), then the sync system fields. A column whose type
// changed is dropped and re-added (PocketBase cannot convert a field in place); its values are
// rewritten by the same sync run because every row's hash changes with the new typed value.

const PORTAL_RULE = '@request.auth.collectionName = "portal_users_auth"';
const TEXT_MAX = 1000000;
const JSON_MAX = 5000000;

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

const SYSTEM_DEFS = [
    { name: '_row_no', type: 'number', onlyInt: true, required: false },
    { name: '_row_key', type: 'text', max: 2000, required: true },
    { name: '_hash', type: 'text', max: 64, required: false },
    { name: '_synced_at', type: 'date', required: false }
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

/**
 * Make collection `name` match `columns` ([{name, type}]). Returns { created, altered, collection }.
 */
async function ensureCollection(pb, name, columns) {
    const wanted = columns.map(dataFieldDef).concat(SYSTEM_DEFS);
    const existing = await pb.getCollection(name);
    if (!existing) {
        const collection = await pb.createCollection(Object.assign({
            name,
            type: 'base',
            fields: wanted,
            indexes: indexesFor(name)
        }, RULES));
        return { created: true, altered: false, collection };
    }
    if (existing.type !== 'base') throw new Error(`${name} exists but is a ${existing.type} collection`);

    const byName = new Map(existing.fields.map((f) => [f.name, f]));
    const idField = existing.fields.find((f) => f.name === 'id');
    const fields = [idField];
    let changed = false;
    for (const want of wanted) {
        const ex = byName.get(want.name);
        if (ex && sameField(ex, want)) {
            fields.push(ex);
        } else if (ex && ex.type === want.type) {
            fields.push(Object.assign({}, ex, want, { id: ex.id }));
            changed = true;
        } else {
            fields.push(want); // new, or retyped (new field id; the old field is dropped)
            changed = true;
        }
    }
    const keep = new Set(wanted.map((f) => f.name).concat('id'));
    if (existing.fields.some((f) => !keep.has(f.name))) changed = true;
    const order = (list) => list.map((f) => f.name).join(',');
    if (!changed && order(existing.fields) !== order(fields)) changed = true;

    const wantIdx = indexesFor(name);
    const idxChanged = wantIdx.some((i) => !existing.indexes.includes(i));
    const rulesChanged = Object.keys(RULES).some((k) => existing[k] !== RULES[k]);
    if (!changed && !idxChanged && !rulesChanged) return { created: false, altered: false, collection: existing };

    const patch = Object.assign({}, RULES);
    if (changed) patch.fields = fields;
    if (idxChanged) patch.indexes = Array.from(new Set(existing.indexes.concat(wantIdx)));
    const collection = await pb.updateCollection(existing.id, patch);
    return { created: false, altered: changed, collection };
}

module.exports = { PORTAL_RULE, ensureCollection, dataFieldDef, SYSTEM_DEFS };
