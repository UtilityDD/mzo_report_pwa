#!/usr/bin/env node
/* scripts/rating/check-schema-needs.js: do the schema files carry every field lib/rating_metrics.js reads?
 *
 *   node scripts/rating/check-schema-needs.js [--schemas <dir>] [--markdown]
 *
 * For each dataset in MzoRatingMetrics.NEEDS: the schema/<key>.json owner, the fields already
 * pinned, the fields to add (with the type to pin) and any type that differs from the one the
 * module reads (fine: the module reads typed values and raw text alike; listed for the record).
 * A schema with keep "all" carries every column. Exit 1 when a required field is missing or when
 * the schema's office roles differ from the rating's own (MzoRatingMetrics.SCHEMA_OPTS).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const APP = path.resolve(__dirname, '..', '..');
const M = require(path.join(APP, 'lib', 'rating_metrics.js'));

// Schema owners (docs/uniform-data-inventory.md, batch table).
const OWNER = {
    A: ['withheld', 'load_extension', 'pending_mc', 'weekly_report'],
    B: ['loss_report', 'loss_targets', 'collection_report', 'disconnection', 'theft_assessment', 'rem_osd'],
    C: ['meter_erp', 'meter_master', 'meter_crm', 'meter_isu', 'consumers', 'docket_calls', 'docket_kpi', 'smart_meter_status', 'smart_meter_work_orders', 'historical_nsc'],
    D: ['capex_details', 'onm_advance', 'feeder_outage', 'cmo_grievances', 'pmsgy_malda', 'pmsgy_uttar_dinajpur', 'pmsgy_dakshin_dinajpur', 'safety_inspection', 'defective_summary'],
    E: ['accident_reports', 'dtr_records'],
    prototype: ['nsc_pending', 'solar_connections'],
    'rating-metrics': ['important_unbilled_3_months', 'important_first_bill_pending', 'important_rem_less_unit_billed', 'si_works']
};
const ownerOf = (k) => Object.keys(OWNER).find((o) => OWNER[o].includes(k)) || '?';

function check(dir) {
    const out = [];
    for (const key of M.DATASETS) {
        const need = M.NEEDS[key];
        const f = path.join(dir, key + '.json');
        const doc = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
        const fields = (doc && doc.fields) || {};
        const all = doc && doc.keep !== 'pinned';
        const have = [], add = [], optional = [], types = [];
        for (const [name, spec] of Object.entries(need)) {
            const pinned = fields[name];
            const want = spec.type + (spec.order ? '/' + spec.order : '') + (spec.for ? ' (only for ' + spec.for.join(', ') + ')' : '') + (spec.soft ? ' (targets)' : '');
            if (pinned) {
                have.push(name);
                const got = pinned.type + (pinned.order ? '/' + pinned.order : ''), as = spec.type + (spec.order ? '/' + spec.order : '');
                if (got !== as) types.push(name + ' ' + got + ' (read as ' + as + ')');
            } else if (all && doc) have.push(name + ' (keep all)');
            else (spec.opt ? optional : add).push(name + ': ' + want);
        }
        // Office roles: the browser's rows (this schema) and the VM's (schemaFor) must place rows alike.
        const mine = (M.SCHEMA_OPTS[key] || {}).offices, theirs = doc ? doc.offices : undefined;
        const offices = doc && mine !== false && JSON.stringify(mine || null) !== JSON.stringify(theirs || null)
            ? 'schema ' + JSON.stringify(theirs || 'header rules') + ' vs rating ' + JSON.stringify(mine || 'header rules') : '';
        out.push({ key, owner: ownerOf(key), file: !!doc, have, add, optional, types, offices });
    }
    return out;
}

function main() {
    const a = process.argv.slice(2);
    const i = a.indexOf('--schemas');
    const dir = path.resolve(i >= 0 ? a[i + 1] : path.join(APP, 'schema'));
    const res = check(dir);
    if (a.includes('--markdown')) {
        console.log('| Dataset | Owner | Already pinned | Add (type) | Optional | Pinned as another type |');
        console.log('|---|---|---|---|---|---|');
        for (const r of res) console.log('| `' + r.key + '` | ' + r.owner + (r.file ? '' : ' (no file yet)') + ' | ' + (r.have.join(', ') || '—') + ' | ' + (r.add.map((x) => '**' + x + '**').join(', ') || '—') + ' | ' + (r.optional.join(', ') || '—') + ' | ' + (r.types.join('; ') || '—') + ' |');
    } else {
        for (const r of res) console.log((r.add.length ? 'MISSING ' : 'ok      ') + r.key + ' [' + r.owner + ']' + (r.file ? '' : ' no schema file') + (r.add.length ? ': add ' + r.add.join(', ') : '') + (r.optional.length ? '; optional ' + r.optional.join(', ') : '') + (r.types.length ? '; types: ' + r.types.join('; ') : '') + (r.offices ? '; OFFICE ROLES DIFFER: ' + r.offices : ''));
    }
    const missing = res.filter((r) => r.add.length || r.offices);
    if (!a.includes('--markdown')) console.log(missing.length ? missing.length + ' datasets lack fields or differ in office roles' : 'every needed field is pinned');
    process.exitCode = missing.length ? 1 : 0;
}

if (require.main === module) main();
module.exports = { check, OWNER };
