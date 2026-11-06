'use strict';
// meter_utilization.html, precomputed: the page joins every ERP meter (meter_erp, 240k rows) with
// three lookup sheets (meter_master 290k, meter_crm, meter_isu) to tell whether it was used for a
// new connection, a replacement, or is still in hand, and takes the newest date of each sheet.
// Here the joins run once per sync, and the page gets only the ERP rows plus each meter's status.
//
// main:  { fields, columns, tuples, entryDates, serial: [..], tuple: [..], entry: [..], status: 'nrh…', dates }
//        Row i is the uniform meter_erp row (keys in the order of fields) { serial_number: serial[i],
//        entry_date: entryDates[entry[i]], and columns[k] = tuples[tuple[i]][k] }; status[i] is n (utilized-nsc),
//        r (utilized-replacement) or h (meter-in-hand). dates.erp / rep / nsc: [y, m, d] or null.
// ids:   { nsc: { meter: [con_id, inst_no] }, rep: { meter: con_id } } for the drawer, ERP meters only.
//
// The rules are the page's own (processData / prepare in meter_utilization.html), with the same
// plain-object lookups (later rows win, crm before isu), so the result is what the page computes.

const TUPLE_COLUMNS = ['meter_make', 'phase', 'cost_center', 'meter_category', '_region', '_division', '_ccc_code', '_ccc'];

// The page's day() and compact(): a calendar day as a number (0 when not a date). The page uses
// local midnight; UTC midnight orders the same days the same way and is the same in every time zone.
const day = (iso) => (iso ? +new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))) || 0 : 0);
const compact = (s) => (s.length === 8 ? +new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8))) || 0 : 0);
const ymd = (t) => { if (!t) return null; const d = new Date(t); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; };

module.exports = {
    inputs: ['meter_erp', 'meter_master', 'meter_crm', 'meter_isu'],
    files: [],
    build(ctx) {
        // 1. ERP meters, as they are (the page scopes them to the login itself).
        const tuples = [], tupleIx = new Map(), entryDates = [], entryIx = new Map();
        const serial = [], tuple = [], entry = [];
        const need = new Set();
        let maxErp = 0;
        const erp = ctx.each('meter_erp', (d) => {
            const vals = TUPLE_COLUMNS.map((c) => d[c]);
            const tk = JSON.stringify(vals);
            let ti = tupleIx.get(tk);
            if (ti === undefined) { ti = tuples.length; tuples.push(vals); tupleIx.set(tk, ti); }
            let ei = entryIx.get(d.entry_date);
            if (ei === undefined) { ei = entryDates.length; entryDates.push(d.entry_date); entryIx.set(d.entry_date, ei); }
            serial.push(d.serial_number);
            tuple.push(ti);
            entry.push(ei);
            need.add(String(d.serial_number));
            maxErp = Math.max(maxErp, day(d.entry_date));
        });
        // 2. The lookups, as the page builds them (plain objects, later rows winning), kept only for
        //    meters in the ERP list; a master entry is [con_id, inst_no], a replacement entry con_id.
        const masterLookup = {}, replacementLookup = {};
        ctx.each('meter_master', (d) => { if (d.meter_no && need.has(String(d.meter_no))) masterLookup[d.meter_no] = [d.con_id, d.inst_no]; });
        let maxRep = 0, maxNsc = 0;
        ctx.each('meter_crm', (d) => {
            if (d.meter_number && need.has(String(d.meter_number))) replacementLookup[d.meter_number] = [d.con_id];
            const t = d.prob_type, v = day(d.meter_install_date || d.serv_conn_date);
            if (t === 'Meter Burnt Problem') maxRep = Math.max(maxRep, v);
            else if (t && t !== 'Load Enhancement') maxNsc = Math.max(maxNsc, v);
        });
        ctx.each('meter_isu', (d) => {
            if (d.meter_no && need.has(String(d.meter_no))) replacementLookup[d.meter_no] = [d.con_id];
            if (d.replaced_by && need.has(String(d.replaced_by))) replacementLookup[d.replaced_by] = [d.con_id];
            maxRep = Math.max(maxRep, compact(d.replacement_dt), compact(d.tran_dt));
        });
        need.clear(); tupleIx.clear(); entryIx.clear();
        // 3. Each meter's status (prepare()) and the drawer's ids for it.
        const status = new Array(serial.length);
        const ids = { nsc: {}, rep: {} };
        for (let i = 0; i < serial.length; i++) {
            const meter = serial[i];
            const r = replacementLookup[meter], m = r ? null : masterLookup[meter];
            status[i] = r ? 'r' : m ? 'n' : 'h';
            if (r) ids.rep[meter] = r[0];
            else if (m) ids.nsc[meter] = m;
        }
        return {
            main: {
                fields: erp.columns.map((c) => c.name), columns: TUPLE_COLUMNS, tuples, entryDates, serial, tuple, entry, status: status.join(''),
                dates: { erp: ymd(maxErp), rep: ymd(maxRep), nsc: ymd(maxNsc) }, rows: serial.length
            },
            parts: { ids }
        };
    }
};
