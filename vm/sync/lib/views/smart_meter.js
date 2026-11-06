'use strict';
// smart_meter/dashboard.html, precomputed: the page reads the whole work-order sheet
// (smart_meter_work_orders, 18k rows with consumer names and addresses) for three things only:
//   - the number of work orders per office (rows with a work order, scoped to the login);
//   - the work order of each supplied meter (by new meter number, the later row winning), for the
//     meter list, its search, the drawer and the export;
//   - the "As on" date: the first Date of a row with a work order that UI.date can read.
// The view carries just those (prepare() in the page, same rules); the meter status sheet
// (smart_meter_status, small) still loads as before.
//
// main: { offices: [[_region, _division, _ccc, _ccc_code, ccc_code, count], …] (rows with a work order
//         and an office, grouped), rows: [full row, …] (rows with a work order and no office: the page
//         scopes those on all their cells), byMeter: { meter: { field: value } }, asOn: raw date or null }

const ui = require('./ui');

const OFFICE = ['_region', '_division', '_ccc', '_ccc_code'];
const WO_FIELDS = ['consumer_id', 'con_name', 'con_addr', 'work_order', 'work_order_date', 'old_meter_no', 'conn_load', 'con_class'];

module.exports = {
    inputs: ['smart_meter_status', 'smart_meter_work_orders'],
    files: ['mzo_ui.js'],
    build(ctx) {
        const { UI } = ui.load(ctx.app);
        // Meters the page can look up: meter_supply_qty of the status rows it keeps.
        const supplied = new Set();
        ctx.each('smart_meter_status', (d) => { if ((d.meter_supply_qty || d.con_id) && d.meter_supply_qty) supplied.add(String(d.meter_supply_qty)); });
        const groups = new Map(), loose = [], byMeter = {};
        let asOn = null, fields = null;
        const head = ctx.each('smart_meter_work_orders', (d) => {
            if (!d.work_order) return;
            if (asOn === null && d.date && UI.date(d.date)) asOn = d.date;
            if (d.new_meter_no && supplied.has(String(d.new_meter_no))) {
                const w = {};
                WO_FIELDS.forEach((f) => { w[f] = d[f]; });
                byMeter[d.new_meter_no] = w;
            }
            if (OFFICE.some((f) => d[f])) {
                const k = JSON.stringify([d._region, d._division, d._ccc, d._ccc_code, d.ccc_code]);
                groups.set(k, (groups.get(k) || 0) + 1);
            } else {
                loose.push(d);
            }
        });
        fields = head.columns.map((c) => c.name);
        const missing = WO_FIELDS.concat(OFFICE, ['work_order', 'new_meter_no', 'date', 'ccc_code']).filter((f) => !fields.includes(f));
        if (missing.length) throw new Error('smart_meter_work_orders has no ' + missing.join(', '));
        const offices = [];
        for (const [k, n] of groups) offices.push(JSON.parse(k).concat([n]));
        return { main: { offices, rows: loose, byMeter, asOn } };
    }
};
