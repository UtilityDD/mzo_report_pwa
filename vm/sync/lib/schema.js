'use strict';
// Spool column statistics + source hints → the column list of a ds_ collection:
// [{ name, source_name, type, index, date_order?, has_time?, raw_name? }] plus "<name>_raw"
// companions. Names and types are lib/uniform.js's (normalise.js, infer.js), so the collection
// has the same fields as the uniform rows built from the same bytes with the same hints.

const { fieldNames, uniqueName, baseName, RESERVED } = require('./normalise');
const { chooseType } = require('./infer');

/**
 * The type overrides the source gives, by original column name: its columnTypes, and text for
 * primary-key columns it does not type itself (ids must keep their exact spelling). lib/uniform.js
 * build() takes the same object as opts.columnTypes (scripts/qa/mirror-types.js passes it).
 */
function typeOverrides(source) {
    const out = Object.assign({}, source.columnTypes || {});
    for (const k of source.primaryKey || []) if (!out[k]) out[k] = 'text';
    return out;
}

/**
 * @param {{source_name, index, stats}[]} spoolColumns
 * @param {object} source adapter (primaryKey, columnTypes, dateOrder, header)
 * @returns {{ columns: object[], registryColumns: object[], warnings: string[] }}
 */
function buildColumns(spoolColumns, source) {
    const overrides = typeOverrides(source);
    const warnings = [];
    // Columns with neither a header nor any value are spreadsheet padding: dropped, as uniform
    // does. A header-less source (columns named by letter) keeps every column.
    const kept = source.header === false ? spoolColumns : spoolColumns.filter((c) => c.source_name !== '' || c.stats.nonEmpty > 0);
    const names = fieldNames(kept.map((c) => c.source_name), kept.map((c) => c.index));
    const taken = new Set([...RESERVED, ...names]);
    const columns = [];
    kept.forEach((c, i) => {
        const override = overrides[c.source_name] || overrides[names[i]] || null;
        const t = chooseType(c.stats, override, source.dateOrder, baseName(c.source_name, c.index));
        const col = { name: names[i], source_name: c.source_name, type: t.type, index: c.index, non_empty: c.stats.nonEmpty };
        if (t.dateOrder) col.date_order = t.dateOrder;
        if (t.hasTime) col.has_time = true;
        if (t.bad > 0) {
            col.raw_name = uniqueName(names[i] + '_raw', taken);
            col.raw_count = t.bad;
        }
        columns.push(col);
    });
    for (const name of Object.keys(source.columnTypes || {})) {
        if (!kept.some((c) => c.source_name === name)) warnings.push(`columnTypes names a missing column "${name}"`);
    }
    return { columns, registryColumns: registryView(columns), warnings };
}

/** Field list for the collection: data columns and their _raw companions, in source order. */
function fieldList(columns) {
    const out = [];
    for (const c of columns) {
        out.push({ name: c.name, type: c.type });
        if (c.raw_name) out.push({ name: c.raw_name, type: 'text' });
    }
    return out;
}

/** What sys_datasets.columns stores: [{name, source_name, type, ...}], as lib/uniform.js's columns. */
function registryView(columns) {
    const out = [];
    for (const c of columns) {
        const entry = { name: c.name, source_name: c.source_name, type: c.type };
        if (c.date_order) entry.date_order = c.date_order;
        if (c.has_time) entry.has_time = true;
        out.push(entry);
        if (c.raw_name) {
            out.push({ name: c.raw_name, source_name: c.source_name, type: 'text', raw_of: c.name, raw_count: c.raw_count });
        }
    }
    return out;
}

module.exports = { buildColumns, fieldList, registryView, typeOverrides };
