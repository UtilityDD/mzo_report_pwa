// Row parity entries: batch A, NSC & connections (docs/uniform-data-inventory.md). Keys: see the
// header of scripts/qa/uniform-rowparity.js.
'use strict';
module.exports = {
  'nsc/kpi.html': {
    key: 'nsc_pending', from: '    var LABEL = {', to: '    function avg(rows, k)',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: false,
    known: {
      REGION: 'raw office cells were copied onto the row only for MzoScope; the login scope now runs on the uniform rows',
      DIVN_NAME: 'as REGION', SUPP_OFF: 'as REGION', CCC_CODE: 'as REGION'
    }
  },
  'withheld.html': {
    key: 'withheld', from: '    var CLASS = {', to: '    var STAT = {',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: false,
    known: {
      withheld: 'application 4001062497 has SCN_WITHELD_DATE "26/07/0201" (a typo in the sheet): UI.date read it as the year 201, uniform rows leave it empty and keep the text in scn_witheld_date_raw',
      year: 'as withheld (the "… and earlier" year facet counts one application less)', ago: 'as withheld (it was 666,663 days, in no stat card)'
    }
  },
  'pending_load_extension.html': {
    key: 'load_extension', from: '    var CLASS = {', to: '    var STAT = {',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true,
    // COLLECTION_DATE is kept as text and shown through UI.fmtDate: compare what is shown.
    display: { collected: (v, UI) => UI.fmtDate(v) }
  },
  'pending_mc.html': {
    key: 'pending_mc', from: '    var CLASS = {', to: '    // Every panel filter;',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true,
    display: { collected: (v, UI) => (UI.blank(v) ? '' : UI.fmtDate(v)) },
    known: { docs: 'DOCS_SUNMITTED was read into the row but never shown; it is no longer loaded' }
  },
  'weekly.html': {
    key: 'weekly_report', from: '    var METRIC = {', to: '    function fillOffices() {',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true, stubs: ['fillOffices'],
    // r.raw is the sheet row (old: UI.csv object, new: uniform row): compare the 18 metric values the page reads from it.
    display: {
      raw: (v) => {
        if (!v || typeof v !== 'object') return v;
        const out = [];
        for (const b of [['Pending as on Monday of Last Week', 'pending_as_on_monday_of_last_week'], ['Deposited in last week', 'deposited_in_last_week'], ['Conn. Eff.', 'conn_eff'], ['Withheld', 'withheld'], ['Total disposed', 'total_disposed'], ['Pending as on Monday of Current Week', 'pending_as_on_monday_of_current_week']]) {
          for (const c of ['DOM', 'COM', 'IND']) out.push(b[1] + '_dom' in v ? Math.trunc(v[b[1] + '_' + c.toLowerCase()]) || 0 : parseInt(v[b[0] + ' (' + c + ')'], 10) || 0);
        }
        return JSON.stringify(out);
      }
    }
  },
  'jjm.html': {
    key: 'jjm_connections', from: '    // Sheet columns', to: '    function fillFilters() {',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true, stubs: ['fillFilters'],
    known: { sheetDivision: 'computed from DIVISION but never used; dropped' }
  },
  'wridd.html': {
    key: 'wridd_schemes', from: '    var STATUS = {', to: '    function fillFilters() {',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true, stubs: ['fillFilters'],
    known: { id: 'the sheet row index, never read; dropped' }
  },
  'bharatnet.html': {
    key: 'bharatnet_connections', from: '    var STATUS = {', to: '    function fillFilters() {',
    old: 'prepare(RAW)', new: 'prepare(ROWS)', rows: 'all', scope: true, stubs: ['fillFilters'],
    known: { id: 'the row index, never read; dropped', 'CCC NAME': 'the raw CCC name was copied onto the row only for MzoScope; the login scope now runs on the uniform rows' }
  },
  'icds.html': {
    keys: { ap: 'icds_a_plus', a: 'icds_a' }, from: '    var STATUS = {', to: '    function fillFilters() {',
    old: '(texts = RAW, combine())', new: '(tables = ROWS, combine())', rows: 'all', scope: true, stubs: ['fillFilters', 'tabs'],
    known: {
      awc: 'sheet cells with a trailing space ("Laxmipur "): uniform values are trimmed', project: 'as awc ("Itahar " was a separate project in the histogram)',
      ownership: 'as awc', search: 'as awc (one space less)',
      code: '14 centres with the unknown code 662101040: the drawer shows the code as written instead of its first 7 digits (6621010, not a CCC either)'
    }
  }
};
