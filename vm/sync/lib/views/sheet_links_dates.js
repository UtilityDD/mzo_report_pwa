'use strict';
// sheet_links.html, precomputed: the "Updated" column takes each dataset's own as-on date from its
// uniform rows, which made the page download 15 whole datasets (about 2 MB compressed) to show 15 dates.
// Here the page's own rules run once per sync: the block between "---- as-on rules" and
// "---- end of as-on rules ----" in sheet_links.html, with the app's mzo_ui.js, on each dataset's rows,
// exactly as the page calls them (t.all, t.columns, t.first; every row, whatever the login).
//
// main: { dates: { <registry key>: 'dd/mm/yyyy' or '' } } for the datasets whose rows are fresh; the
// page loads the rows of any other dataset itself, as before.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ui = require('./ui');

const PAGE = 'sheet_links.html';
// Uniform rows keys the rules read (AS_ON in the page names them; checked below).
const INPUTS = ['disconnection', 'docket_calls', 'capex_details', 'pending_mc', 'cmo_grievances', 'collection_report',
    'bharatnet_connections', 'icds_a_plus', 'icds_a', 'pmsgy_malda', 'pmsgy_uttar_dinajpur', 'pmsgy_dakshin_dinajpur',
    'loss_report', 'feeder_outage', 'onm_advance'];

function rulesOf(app) {
    const src = fs.readFileSync(path.join(app, PAGE), 'utf8');
    const a = src.indexOf('    // ---- as-on rules'), b = src.indexOf('    // ---- end of as-on rules ----');
    if (a < 0 || b < a) throw new Error('the as-on rules block is not in ' + PAGE);
    return src.slice(a, b);
}

/** The page's t for a rows document (mzo_rows.js fromDoc, without scoping: the rules read t.all). */
function tOf(doc) {
    const names = doc.columns.map((c) => c.name), all = new Array(doc.rows.length);
    for (let i = 0; i < doc.rows.length; i++) { const a = doc.rows[i], o = {}; for (let k = 0; k < names.length; k++) o[names[k]] = a[k]; all[i] = o; }
    return {
        key: doc.key, version: doc.version, columns: doc.columns, rows: all, all,
        first(field) { for (let j = 0; j < all.length; j++) { const v = all[j][field]; if (v !== '' && v != null) return v; } return null; }
    };
}

module.exports = {
    inputs: INPUTS,
    partial: true,
    files: [PAGE, 'mzo_ui.js'],
    build(ctx) {
        const { context } = ui.load(ctx.app);
        vm.runInContext('(function () {\n' + rulesOf(ctx.app) + '\nthis.__AS_ON = AS_ON;\n}).call(this);', context, { filename: PAGE + ' (as-on rules)' });
        const AS_ON = context.__AS_ON;
        const named = Object.keys(AS_ON).map((k) => AS_ON[k][0]);
        const unknown = named.filter((k) => !INPUTS.includes(k));
        if (unknown.length) throw new Error('as-on rules read datasets this view does not list: ' + unknown.join(', '));
        const dates = {};
        for (const hub of Object.keys(AS_ON)) {
            const key = AS_ON[hub][0];
            if (!ctx.inputs.includes(key)) continue; // rows not fresh: the page reads them itself
            let doc = ctx.doc(key);
            dates[hub] = String(AS_ON[hub][1](tOf(doc)) || '');
            doc = null;
        }
        return { main: { dates } };
    }
};
