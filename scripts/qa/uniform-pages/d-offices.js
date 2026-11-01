// Page parity entries: batch D, office-heavy pages and Important sheets (docs/uniform-data-inventory.md).
// Each page names its own selectors: asOn (header text), tableIds (containers whose tables are
// recorded), drillRows, fdp (the table whose first row marks the first data paint) and freshClicks
// (buttons pressed on a fresh load, each recorded); every hist and panel heading is recorded
// (record: 'heads'). Keys: see the header of scripts/qa/uniform-pages.js.
'use strict';
const HEADS = ['heads'];
module.exports = {
  cmo: {
    url: 'cmo.html', key: 'cmo_grievances', stats: '#stats .ui-stat', tabs: '#groupTabs .ui-tab', asOn: '#meta', record: HEADS,
    tableIds: ['groupTable', 'listTable'], drillRows: '#groupTable tbody tr.click', fdp: '#listTable', deep: []
  },
  safety: {
    url: 'safety_inspection.html', key: 'safety_inspection', stats: '#stats button.ui-stat', tabs: '#levelTabs .ui-tab', asOn: '#meta', record: HEADS,
    tableIds: ['officeTable', 'listTable'], drillRows: '#officeTable tbody tr.click', fdp: '#listTable', freshClicks: ['#countBy button:nth-child(2)'], deep: []
  },
  feeder: {
    url: 'feeder_outage.html', key: 'feeder_outage', stats: '#concernStat', tabs: '#levelTabs .ui-tab', asOn: '#meta', record: HEADS,
    tableIds: ['feederTable'], drillRows: '#feederTable tbody tr.click', fdp: '#feederTable', deep: []
  },
  pmsgy: {
    url: 'pmsgy.html', key: 'pmsgy_malda', stats: '#stats .ui-stat', tabs: '#tabs .ui-tab', asOn: '#meta', record: HEADS,
    tableIds: ['breakdown', 'appTable', 'gapTable'], drillRows: '#breakdown tbody tr.click', fdp: '#appTable', deep: []
  },
  capex: {
    url: 'capex_all.html', key: 'capex_details', stats: '#stats .ui-stat', tabs: '#dimTabs .ui-tab', asOn: '#meta', record: HEADS,
    tableIds: ['dimTable', 'ageTable', 'listTable'], drillRows: '#dimTable tbody tr.click', fdp: '#listTable', deep: []
  },
  onm: {
    url: 'advance_onm.html', key: 'onm_advance', stats: '#stats .ui-stat', tabs: '#dimTabs .ui-tab', asOn: '#meta', record: HEADS,
    tableIds: ['dimTable', 'ageTable', 'listTable'], drillRows: '#dimTable tbody tr.click', fdp: '#listTable', deep: []
  },
  defective: {
    url: 'consumer/defective_meter.html', key: 'defective_summary', stats: '.ui-stat[data-m]', tabs: '#levelTabs .ui-tab', asOn: '#meta', record: HEADS,
    tableIds: ['officeTable', 'namesTable'], drillRows: '#officeTable tbody tr.click', fdp: '#officeTable',
    deep: ['?kpi=over10', '?kpi=ph3', '?kpi=smart', '?kpi=load_gt6', '?kpi=agri', '?division=Gazole', '?kpi=industrial&division=Raiganj']
  },
  important: {
    url: 'important_sheets.html', key: '', stats: '.none', tabs: '.none', asOn: '#unbilled', drillRows: '.none', deep: [], ready: 'badges', record: HEADS,
    texts: ['#unbilled', '#billing', '#rem']
  }
};
