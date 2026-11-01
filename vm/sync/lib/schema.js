'use strict';
// Spool column statistics + source hints → the column list of a ds_ collection:
// [{ name, source_name, type, index, date_order?, raw_name? }] plus "<name>_raw" companions.

const { fieldNames, uniqueName, RESERVED } = require('./normalise');
const { chooseType, converter } = require('./infer');

/**
 * @param {{source_name, index, stats}[]} spoolColumns
 * @param {object} source adapter (primaryKey, columnTypes, dateOrder)
 * @returns {{ columns: object[], registryColumns: object[], warnings: string[] }}
 */
function buildColumns(spoolColumns, source) {
    const overrides = source.columnTypes || {};
    const pk = new Set(source.primaryKey || []);
    const warnings = [];
    // Columns with neither a header nor any value are spreadsheet padding: drop them.
    const kept = spoolColumns.filter((c) => c.source_name !== '' || c.stats.nonEmpty > 0);
    const names = fieldNames(kept.map((c) => c.source_name), kept.map((c) => c.index));
    const taken = new Set([...RESERVED, ...names]);
    const columns = [];
    kept.forEach((c, i) => {
        // Key columns stay text unless the source says otherwise: ids must keep their exact spelling.
        const override = overrides[c.source_name] || (pk.has(c.source_name) ? 'text' : null);
        const t = chooseType(c.stats, override, source.dateOrder);
        const col = { name: names[i], source_name: c.source_name, type: t.type, index: c.index, non_empty: c.stats.nonEmpty };
        if (t.dateOrder) col.date_order = t.dateOrder;
        if (t.bad > 0) {
            col.raw_name = uniqueName(names[i] + '_raw', taken);
            col.raw_count = t.bad;
        }
        col.convert = converter(t.type, t.dateOrder);
        columns.push(col);
    });
    for (const name of Object.keys(overrides)) {
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

/** What sys_datasets.columns stores: [{name, source_name, type, ...}]. */
function registryView(columns) {
    const out = [];
    for (const c of columns) {
        const entry = { name: c.name, source_name: c.source_name, type: c.type };
        if (c.date_order) entry.date_order = c.date_order;
        out.push(entry);
        if (c.raw_name) {
            out.push({ name: c.raw_name, source_name: c.source_name, type: 'text', raw_of: c.name, raw_count: c.raw_count });
        }
    }
    return out;
}

module.exports = { buildColumns, fieldList, registryView };
