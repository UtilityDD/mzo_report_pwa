/**
 * Stock dashboard CSV (CACHE_STOCK shape) helpers for the server and scripts/migrate.
 * The SAP Excel itself is cleaned in the browser by stock/stock_client_pipeline.js.
 */

const XLSX = require('xlsx');

const OUTPUT_COLUMNS = [
    'Plant',
    'Name 1',
    'Material Type',
    'Material',
    'Material Description',
    'Material Group',
    'Storage Location',
    'Descr. of Storage Loc.',
    'Base Unit of Measure',
    'Unrestricted',
    'Stock in Transit',
    'Transit and Transfer',
    'Store',
    'Category',
    'Date'
];

const DB_KEYS = [
    'plant',
    'name_1',
    'material_type',
    'material',
    'material_description',
    'material_group',
    'storage_location',
    'descr_of_storage_loc',
    'base_unit_of_measure',
    'unrestricted',
    'stock_in_transit',
    'transit_and_transfer',
    'store',
    'category',
    'date'
];

function toCsv(rows) {
    const header = OUTPUT_COLUMNS.join(',');
    const lines = rows.map((row) =>
        OUTPUT_COLUMNS.map((col) => {
            const val = String(row[col] == null ? '' : row[col]);
            if (/[",\n\r]/.test(val)) return `"${val.replace(/"/g, '""')}"`;
            return val;
        }).join(',')
    );
    return [header, ...lines].join('\n');
}

function dashboardRowToDb(row, uploadId) {
    const out = { upload_id: uploadId };
    for (let i = 0; i < OUTPUT_COLUMNS.length; i++) {
        out[DB_KEYS[i]] = row[OUTPUT_COLUMNS[i]] == null ? '' : String(row[OUTPUT_COLUMNS[i]]);
    }
    return out;
}

/** Parse cleaned dashboard CSV (from browser publish) back into row objects. */
function publishedFromCsv(csvText) {
    const text = String(csvText || '').trim();
    if (!text) return [];
    const workbook = XLSX.read(text, { type: 'string', raw: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];
    return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: false });
}

module.exports = {
    publishedFromCsv,
    OUTPUT_COLUMNS,
    DB_KEYS,
    toCsv,
    dashboardRowToDb
};
