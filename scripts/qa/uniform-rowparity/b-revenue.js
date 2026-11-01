// Row parity entries: batch B, revenue (docs/uniform-data-inventory.md). Keys: see the header of
// scripts/qa/uniform-rowparity.js.
'use strict';
module.exports = {
  'loss.html': {
    keys: ['loss_report', 'loss_targets'], from: '    var MON = [', to: '    function fillOffices() {',
    old: 'prepare(RAW.loss_report, RAW.loss_targets)', new: 'prepare(ROWS.loss_report, ROWS.loss_targets)', scope: false, stubs: ['fillOffices'],
    // every office x month the page keeps, the targets and the month list (the header text is compared too)
    rows: "Object.keys(data).sort().reduce(function (a, n) { Object.keys(data[n]).forEach(function (k) { a.push(Object.assign({ name: n, k: k }, data[n][k])); }); return a; }, [])" +
      ".concat(Object.keys(targets).sort().map(function (n) { return Object.assign({ target: n }, targets[n]); })).concat([{ periods: periods.join(',') }])"
  },
  'collection.html': {
    key: 'collection_report', from: '    function ymd(s) {', to: '    function fillFilters() {',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true, stubs: ['fillFilters']
  },
  'theft_assessment.html': {
    key: 'theft_assessment', from: '    var KEY = ', to: '    function fillFilters() {',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true, stubs: ['fillFilters'],
    known: {
      id: 'the row index was never read; removed',
      pay: 'PAYMENT AMT cells in scientific notation (7.51E+04): the old clean-up read 7.51, uniform rows read 75,100',
      balance: 'follows pay (scientific-notation PAYMENT AMT)',
      status: 'follows pay (scientific-notation PAYMENT AMT)'
    }
  },
  'remosd5000.html': {
    key: 'rem_osd', from: '    var CLASSES = [', to: '    function fillFilters() {',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', scope: true, stubs: ['fillFilters'],
    // the old page kept the raw sheet objects, the new one its own: compare what the page reads
    rows: "all.map(function (r) { var o = { due: UI.fmtDate(dmy(r._due)), dueT: r._dueD ? r._dueD.getTime() : null, region: r._region, divn: r._divn, supp: r._supp, code: r.CCC_CODE }; ['Total'].concat(CLASSES).forEach(function (c) { o['n' + c] = cnt(r, c); o['a' + c] = amt(r, c); }); o.email = UI.fmtDate(dmy(r.email || r['Report Date/Email Date'])); o.remarks = r.remarks != null ? r.remarks : r.Remarks; return o; })" +
      ".concat([{ dates: dates.map(function (d) { return UI.fmtDate(dmy(d)); }).join(',') }])",
    // UI.csv kept trailing spaces ('NIL '); uniform values are trimmed. The drawer shows the same text.
    display: { remarks: (v) => (v == null ? v : String(v).trim()) }
  },
  'rem/defaulters.html': {
    keys: ['rem_defaulters_dom', 'rem_defaulters_agri', 'rem_defaulters_ind_com'], from: '    var TYPE = {', to: '    function fillFilters() {',
    old: "(parts.DOM = enrich(tsv(RAW.rem_defaulters_dom), 'DOM'), parts.AGRI = enrich(tsv(RAW.rem_defaulters_agri), 'AGRI'), parts.IC = enrich(tsv(RAW.rem_defaulters_ind_com), 'IC'), rebuild())",
    new: "(parts.DOM = enrich(ROWS.rem_defaulters_dom, 'DOM'), parts.AGRI = enrich(ROWS.rem_defaulters_agri, 'AGRI'), parts.IC = enrich(ROWS.rem_defaulters_ind_com, 'IC'), rebuild())",
    scope: true, stubs: ['fillFilters'],
    // raw: the old page kept the sheet's text cells; the new one exports the same text through cells()
    rows: "all.map(function (r) { var o = Object.assign({}, r); o.raw = typeof cells === 'function' ? cells(r) : r.raw; return o; })"
  },
  'disconnection.html': {
    key: 'disconnection', from: '    /* ------------------------------------------------------------------ parsing */', to: '    /* ------------------------------------------------------------------ filters */',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true
  }
};
