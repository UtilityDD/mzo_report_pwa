'use strict';
// Rows of source cells → PocketBase records, exactly as the sync writes them (vm/sync/lib/upsert.js):
// the same typed values (lib/uniform.js through the sync's Converter), _raw companions, office fields
// (_region, _division, _ccc_code, _ccc), _nulls, _hash and _row_key, and the record id derived from
// the key. A row the editor writes is therefore indistinguishable from one the sync wrote from the
// same cells, so the portal, the quality checks and a later return to mirror mode all agree with it.
//
// Native datasets also keep the row's exact source cells in the system field _src (a JSON array in
// source column order, untrimmed). The snapshot is written from _src, so the pages get the cells
// byte for byte as typed, while the typed fields serve filters, sorting and the portal.

const path = require('path');

const SYNC = path.join(__dirname, '..', '..', 'vm', 'sync', 'lib');
const { Converter } = require(path.join(SYNC, 'infer'));
const officeEnrich = require(path.join(SYNC, 'office_enrich'));
const { rowKeyFn } = require(path.join(SYNC, 'upsert'));
const { normValue } = require(path.join(SYNC, 'spool'));
const { NULLS_FIELD } = require(path.join(SYNC, 'collections'));
const { sha1, recordId, stableStringify } = require(path.join(SYNC, 'util'));
const U = require('../uniform.js');

const SRC_FIELD = '_src';
const OFFICE_FIELDS = ['_region', '_division', '_ccc_code', '_ccc'];

/** Spool-style values from exact cells: trimmed, trailing empty cells removed (spool.js). */
function spoolValues(cells) {
    const values = cells.map(normValue);
    let last = values.length - 1;
    while (last >= 0 && values[last] === '') last--;
    values.length = last + 1;
    return values;
}

function isBlank(cells) {
    for (const c of cells) if (String(c == null ? '' : c).trim() !== '') return false;
    return true;
}

/**
 * @param {object} layout native layout (lib/editor/native.js): { columns, primaryKey, key, width }
 *   columns: buildColumns() output: [{ name, source_name, type, index, date_order?, raw_name?, non_empty }]
 */
function makeBuilder(layout) {
    const columns = layout.columns;
    const warnings = [];
    const keyer = rowKeyFn(columns, layout.primaryKey || null, warnings);
    const oe = officeEnrich.prepare({ key: layout.key, officeColumns: layout.officeColumns }, columns);
    const conv = new Converter(columns, {});
    const byName = new Map(columns.map((c) => [c.name, c]));

    /**
     * cells[][] (exact) → [{ record, key, baseKey, hash, values }]. record has every data field, the
     * _raw companions, office fields, _nulls, _hash, _row_key; not id or _row_no (the caller sets them).
     */
    function build(cellRows) {
        const valueRows = cellRows.map(spoolValues);
        const cv = conv.convert(valueRows);
        const out = [];
        for (let r = 0; r < valueRows.length; r++) {
            const values = valueRows[r];
            const record = {};
            const typed = [];
            let ri = 0;
            for (let ci = 0; ci < columns.length; ci++) {
                const c = columns[ci];
                const v = cv.values[ci][r];
                record[c.name] = v;
                typed.push(v);
                if (c.raw_name) {
                    const raw = cv.raw[ri++];
                    const rawText = raw ? raw[r] : '';
                    record[c.raw_name] = rawText;
                    typed.push(rawText);
                }
            }
            if (oe) {
                const extra = oe.enrich(values);
                for (const k of Object.keys(extra)) {
                    record[k] = extra[k];
                    typed.push(extra[k]);
                }
            }
            const nulls = cv.nulls[r];
            record[NULLS_FIELD] = nulls;
            if (nulls) typed.push(nulls);
            const hash = sha1(stableStringify(typed));
            record._hash = hash;
            const baseKey = keyer.key(values);
            out.push({ record, baseKey, hash, values });
        }
        return out;
    }

    /**
     * Check one cell's text against its column's type, as lib/uniform.js reads it.
     * → null when it is fine, else a message.
     */
    function validate(name, text) {
        const c = byName.get(name);
        if (!c) return 'Unknown column';
        const s = String(text == null ? '' : text).trim();
        if (!s || c.type === 'text') return null;
        const st = U.stats([s]);
        if (st.nulls) return null; // placeholders (NA, -, (null)…) are an empty value
        if (c.type === 'number') return st.num ? null : 'Not a number';
        if (c.type === 'bool') return st.bool ? null : 'Use Y / N, Yes / No or true / false';
        if (c.type === 'date') {
            const ok = c.date_order === 'mdy' ? st.mdy : st.dmy;
            if (ok) return null;
            return c.date_order === 'mdy' ? 'Not a date (mm/dd/yyyy)' : 'Not a date (dd/mm/yyyy)';
        }
        if (c.type === 'json') {
            try { JSON.parse(s); return null; } catch (_) { return 'Not valid JSON'; }
        }
        return null;
    }

    return {
        build,
        validate,
        usesPk: keyer.usesPk,
        hasOffices: !!oe,
        warnings,
        columns,
        byName,
        idFor: (key) => recordId(key)
    };
}

/**
 * Keys for rows in source order the way one sync run gives them: repeats of a key get ':2', ':3'.
 * @param {string[]} baseKeys
 * @returns {{ key, id }[]}
 */
function claimKeys(baseKeys) {
    const seen = new Set();
    return baseKeys.map((base) => {
        let key = base;
        let id = recordId(key);
        for (let occ = 2; seen.has(id); occ++) {
            key = base + ':' + occ;
            id = recordId(key);
        }
        seen.add(id);
        return { key, id };
    });
}

/** The cells of a native record, padded to `width` (new rows get every column of the header). */
function cellsOf(record, width) {
    const src = Array.isArray(record && record[SRC_FIELD]) ? record[SRC_FIELD].map((v) => (v == null ? '' : String(v))) : [];
    while (src.length < width) src.push('');
    return src;
}

module.exports = { SRC_FIELD, OFFICE_FIELDS, makeBuilder, claimKeys, spoolValues, isBlank, cellsOf };
