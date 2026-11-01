// Row parity entries: batch D, office-heavy pages (docs/uniform-data-inventory.md). Keys: see the
// header of scripts/qa/uniform-rowparity.js.
'use strict';
// The defective page wires DOM events and reads location while it builds its rows.
function defectiveStubs(ctx) {
  ctx.document.querySelector = () => ctx.document.createElement();
  ctx.location = { search: '' };
  ctx.URLSearchParams = URLSearchParams;
  ctx.UI.table = ctx.UI.hist = function () {};
}
module.exports = {
  'cmo.html': {
    key: 'cmo_grievances', from: '    var DISTRICTS = ', to: '    function base()',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: false, id: (x) => x.name + ' ' + x.phone,
    offices: false, setup: (ctx) => { ctx.MzoScope = undefined; }, // the page loads neither lib/offices.js nor mzo_scope.js
    known: { applicant: 'kept in the row but never shown: uniform text is trimmed (one cell starts with a space)' }
  },
  'pmsgy.html': {
    keys: ['pmsgy_malda', 'pmsgy_uttar_dinajpur', 'pmsgy_dakshin_dinajpur'], scope: true,
    oldFrom: '    var MON = { jan', from: '    var JOBS = ', to: '    function fillFilters() {', rows: 'all', id: (x, y) => x.appl || y.appl,
    // the old load(): three tabs → ingest → as-on over every row → MzoScope.filterRows; the new paint()
    old: "(function () { var rows = []; [RAW.pmsgy_malda, RAW.pmsgy_uttar_dinajpur, RAW.pmsgy_dakshin_dinajpur].forEach(function (c, i) { rows = rows.concat(ingest(c, JOBS[i][1])); }); var last = rows.reduce(function (a, r) { return r.last && r.last > a ? r.last : a; }, null); rows = MzoScope.filterRows(rows); rows.asOn = last; return (all = rows); })()",
    new: "(function () { var ts = [ROWS.pmsgy_malda, ROWS.pmsgy_uttar_dinajpur, ROWS.pmsgy_dakshin_dinajpur], rows = []; ts.forEach(function (t, i) { rows = rows.concat(ingest(t, JOBS[i][1])); }); rows.asOn = asOnOf(ts); return (all = rows); })()",
    known: {
      last: 'bug fixed: the old date parser read only 3-letter months; "02-October-26" style Last Action Dates were empty',
      net: 'bug fixed: Net Metering Dates written with the full month name ("7-February-25") were not read, so those connections were not counted',
      connected: 'follows net (full month names now read): more applications count as Connected',
      agreement: 'bug fixed: Agreement Upload Dates with the full month name ("2-September-26") were not read'
    }
  },
  'safety_inspection.html': {
    key: 'safety_inspection', from: '    var raw = [], all = []', to: '    function base()',
    old: '(raw = UI.csv(RAW), build(), all)', new: '(raw = ROWS.rows, build(), all)', rows: 'all', scope: false, id: (x) => x.insp
  },
  'capex_all.html': {
    keys: ['vendor_map', 'costcenter', 'capex_details'], json: ['costcenter'], scope: { vendor_map: false, costcenter: false, capex_details: true },
    from: '    var AGE = [', to: '    function base(skipAge)', rows: 'all', id: (x, y) => (x.project || y.project) + ' ' + (x.mcode || y.mcode),
    old: '(maps(RAW.vendor_map, RAW.costcenter), prepare(RAW.capex_details), all.asOn = asOn, all)',
    new: '(maps(ROWS.vendor_map, ROWS.costcenter), prepare(ROWS.capex_details), all.asOn = asOn, all)'
  },
  'advance_onm.html': {
    keys: ['vendor_map', 'costcenter', 'onm_advance'], json: ['costcenter'], scope: { vendor_map: false, costcenter: false, onm_advance: true },
    from: '    var AGE = [', to: '    function base(skipAge)', rows: 'all', id: (x, y) => x.order || y.order,
    old: '(maps(RAW.vendor_map, RAW.costcenter), prepare(RAW.onm_advance), all.asOn = asOn, all)',
    new: '(maps(ROWS.vendor_map, ROWS.costcenter), prepare(ROWS.onm_advance), all.asOn = asOn, all)'
  },
  'consumer/defective_meter.html': {
    keys: ['defective_summary'], scope: true, scripts: ['lib/defective_meter_pipeline.js'],
    from: '    var P = window.MzoDefectivePipeline;', to: '    function fail(msg) {', rows: 'rows', id: (x, y) => (x.CCC_CODE || y.CCC_CODE) + ' ' + (x.BASE_CLASS || y.BASE_CLASS),
    setup: defectiveStubs,
    old: '(onSummary(RAW.defective_summary), rows.asOn = asOn, rows)', new: '(onSummary(ROWS.defective_summary), rows.asOn = asOn, rows)',
    display: Object.assign({ DEFECT_YEAR: (v) => (v == null ? '' : String(v)) }, ...['total', 'agri', 'over10', 'over5', 'ph3', 'industrial', 'smart', 'load_gt6', 'load_3_6', 'load_1_3', 'load_05_1', 'load_lt_05', 'phase_1', 'phase_3', 'phase_other'].map((k) => ({ [k]: (v) => Number(v) || 0 }))),
    ignore: ['REGION', 'REGION_CODE', 'DIVISION', 'DIVISION_CODE', 'DEFECT_MONTH']
  },
  'consumer/defective_meter.html:details': {
    file: 'consumer/defective_meter.html', keys: ['defective_details'], scope: true, scripts: ['lib/defective_meter_pipeline.js'],
    from: '    var P = window.MzoDefectivePipeline;', to: '    function fail(msg) {', rows: 'details', id: (x, y) => (x.CON_ID || y.CON_ID) + '|' + (x.METER_NO || y.METER_NO),
    setup: defectiveStubs,
    old: '(details = MzoScope.filterRows(parseRows(RAW.defective_details).map(withOffice)), details)',
    new: '(details = ROWS.defective_details.rows.filter(isRow).map(detailRow), details)',
    display: Object.assign({}, ...['over10', 'ph3', 'industrial', 'smart', 'load_gt6', 'load_3_6', 'load_1_3'].map((k) => ({ [k]: (v) => Number(v) || 0 }))),
    known: {
      ADDRESS: 'uniform text is trimmed: the dump pads addresses with spaces (HTML never showed them; the names CSV export no longer carries them)',
      MOBILE_NO: 'uniform text is trimmed: blank mobiles were runs of spaces',
      NAME: 'uniform text is trimmed (one name ends in a space)'
    }
  },
  'feeder_outage.html': {
    key: 'feeder_outage', from: '    var MON = [', to: '    /* events */',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true, id: (x) => x.code + ' ' + x.month
  },
  'safety_inspection.html:inspection': {
    file: 'safety_inspection.html', key: 'safety_inspection', from: '    var raw = [], all = []', to: '    function base()',
    old: "(groupBy = 'Inspection ID', raw = UI.csv(RAW), build(), all)", new: "(groupBy = 'Inspection ID', raw = ROWS.rows, build(), all)", rows: 'all', scope: false, id: (x) => x.insp
  }
};
