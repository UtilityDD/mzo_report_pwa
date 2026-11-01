// Row parity entries: batch C, meters, consumers & DD (docs/uniform-data-inventory.md). Keys: see
// the header of scripts/qa/uniform-rowparity.js. The pages compute ages at parse time (docket "open for",
// DD days to due), so every entry runs on one fixed clock.
'use strict';
const CLOCK = '2026-11-01T12:00:00+05:30'; // Date.now() and new Date() in both runs
module.exports = {
  'consumer/consumer.html': {
    clock: CLOCK, key: 'consumers', from: '    function prepare(', to: '    function fillFilters()',
    prelude: 'var rows = [], asOn = ""; function fillFilters() {}',
    oldPrelude: 'function num(v) { return Number(String(v == null ? "" : v).replace(/,/g, "")) || 0; }',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', scope: true,
    // the old rows were the raw sheet rows (every column); the page reads these keys
    sets: { rows: 'rows.map(function (r) { return { CCC_CODE: r.CCC_CODE, _region: r._region, _divn: r._divn, _supp: r._supp, COUNT: r.COUNT, LOAD: r.LOAD, SD_LAKH: r.SD_LAKH, OSD_LAKH: r.OSD_LAKH, CONN_STAT: r.CONN_STAT, BASE_CLASS: r.BASE_CLASS, CONN_PHASE: r.CONN_PHASE, CATEGORY: r.CATEGORY, GOVT_STAT: r.GOVT_STAT, TYPE_OF_METER: r.TYPE_OF_METER, CONN_BY: r.CONN_BY, TIME_OF_DAY: r.TIME_OF_DAY }; })', asOn: '[{ shown: asOn ? UI.fmtDate(asOn) : "" }]' }
  },
  'historical_nsc.html': {
    clock: CLOCK, key: 'historical_nsc', oldFrom: '    function prepare(', from: '    function codeOf(', to: '    function fillOffices()',
    prelude: 'var all = [], CLASSES = ["D", "C", "I", "A", "O"]; function fillOffices() {} function mdy(s) { var m = String(s || "").trim().match(/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{2,4})/); if (m) { var y = +m[3]; if (y < 100) y += 2000; return new Date(y, +m[1] - 1, +m[2]); } return UI.date(s); }',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true
  },
  'dd/upcomingDD.html': {
    clock: CLOCK, key: 'upcoming_dd', oldFrom: '    // Only the fields this page shows', from: '    // t.rows: uniform rows (outstanding', to: '    function uniq(',
    prelude: 'var all = []; function fillFilters() {} function uniq() { return []; } function ymd(s) { s = String(s || "").trim(); if (!/^\\d{8}$/.test(s)) return null; var d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)); return isNaN(d) ? null : d; }',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true
  },
  'dd/dd_visit.html': {
    clock: CLOCK, key: 'dd_visit', oldFrom: '    function prepare(', from: '    // t.rows: uniform rows of schema/dd_visit.json', to: '    function uniq(',
    prelude: 'var all = [], onSheet = {}, osdDate = ""; function fillFilters() {} function uniq() { return []; } function ymd(s) { s = String(s || "").trim(); return /^\\d{8}$/.test(s) ? new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) : null; } function osdOf(d) { return d.total_osd != null ? d.total_osd : d.outstanding || 0; } function text(v) { return v == null ? "" : String(v); }',
    oldPrelude: 'function osdOf(r) { return parseFloat(r.TOTAL_OSD || r.OUTSTANDING) || 0; }',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', scope: true,
    sets: { rows: 'all', asOn: '[{ osdDate: osdDate }]' },
    // the old rows carried the whole sheet row (PAN included); the page uses four of its cells
    display: { raw: (v) => (v ? [v.NAME, v.DISCON_DT, v.TOTAL_OSD, v.OUTSTANDING].join('|') : '') }
  },
  'smart_meter/dashboard.html': {
    clock: CLOCK, keys: ['smart_meter_status', 'smart_meter_work_orders'], oldFrom: '    function tsv(text)', from: '    // Canonical office of a row', to: '    function fillOffices()',
    prelude: 'var meters = [], wos = [], woByMeter = {}, asOn = null; function fillOffices() {} function pick(w, a, b) { return w[a] !== undefined ? w[a] : w[b]; }',
    old: 'prepare(RAW.smart_meter_status, RAW.smart_meter_work_orders)', new: 'prepare(ROWS.smart_meter_status, ROWS.smart_meter_work_orders)', scope: true,
    sets: {
      meters: 'meters', wos: 'wos', asOn: '[{ asOn: asOn }]',
      // the drawer's work order fields (the old join kept the raw TSV row, the new one the uniform row)
      woByMeter: 'Object.keys(woByMeter).sort().map(function (k) { var w = woByMeter[k]; return { meter: k, wo: pick(w, "work_order", "WORK_ORDER"), con: pick(w, "consumer_id", "CONSUMER_ID"), name: pick(w, "con_name", "CON_NAME"), addr: pick(w, "con_addr", "CON_ADDR"), date: pick(w, "work_order_date", "WORK_ORDER_DATE"), old: pick(w, "old_meter_no", "OLD_METER_NO"), load: pick(w, "conn_load", "CONN_LOAD"), cls: pick(w, "con_class", "CON_CLASS") }; })'
    },
    ignore: ['zone', 'cccName', 'raw'], // read but never shown (zone, cccName); raw: the old WO row, compared through woByMeter
    display: { lotDate: (v, UI) => (v ? UI.fmtDate(v) : '') } // a date now (null when empty); the drawer shows UI.fmtDate of it
  },
  'meter_utilization.html': {
    clock: CLOCK, keys: ['meter_erp', 'meter_master', 'meter_crm', 'meter_isu'], oldFrom: '    var REGION_LABEL = {', from: "    var STATUS = { 'utilized-nsc'", to: '    function fillFilters()',
    prelude: 'function fillFilters() {}',
    old: '(buildHierarchy(), processData(UI.csv(RAW.meter_erp), UI.csv(RAW.meter_master), UI.csv(RAW.meter_crm), UI.csv(RAW.meter_isu)), prepare())',
    new: '(T = ROWS, processData(), prepare())', scope: true,
    sets: { rows: 'rows', masterLookup: 'masterLookup', replacementLookup: 'replacementLookup', dates: '[dates]' },
    // src: what the drawer and the export read (the old one also carried the parse-time office fields)
    display: { src: (v, UI) => (v ? [v.meter, v.status, v.phase, v.cccCode, v.entryDate === 'Unknown' ? 'Unknown' : +UI.date(v.entryDate)].join('|') : '') }
  },
  'docket.html': {
    clock: CLOCK, key: 'docket_calls', from: '    function prepare(', to: '    function fillOffices()',
    prelude: 'var all = [], latest = null, repeat = {}; function fillOffices() {} var AGE = [{ key: "h0", max: 24 }, { key: "h1", max: 48 }, { key: "h2", max: 168 }, { key: "h3", max: 720 }, { key: "h4", max: Infinity }]; var TECH = ' + JSON.stringify(['Meter defective and No Power', 'Meter (Tampering)', 'Service (main) problem', 'Service (main) problem (UG cable)', 'Service(main) problem(OH Line)', 'Breakage or uprooting of pole', 'Flashing/Glowing', 'No power', 'Dis. transformer problem', 'Voltage fluctuation', 'Insulator break at pole', 'Earthing problem', 'Fuse problem', 'Alteration of Services', 'Load Shedding Problem', 'Bird fault', 'Conductor snap', 'LT wire problem', 'Sagging of wire', 'Single phasing', 'Voltage complaint', 'Cable fault', 'Cable fault where RMU exists', 'Cable fault where no RMU exists', 'Frequent tripping', 'Short circuit', 'Problem in Shifting of Meter']) + '; function when(s) { var m = String(s || "").trim().match(/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})(?:\\s+(\\d{1,2})[.:](\\d{1,2})(?:[.:](\\d{1,2}))?)?/); return m ? new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : null; }',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', scope: true,
    sets: { rows: 'all', repeat: '[repeat]', latest: '[{ latest: latest }]' }
  },
  'docket/kpi.html': {
    clock: CLOCK, key: 'docket_kpi', from: '    function prepare(', to: '    function fillOffices()',
    prelude: 'var all = []; function fillOffices() {} var BULK = { "6610000": 1, "6620000": 1, "6630000": 1 };',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true
  }
};
