// Page parity entries: batch A, NSC & connections (docs/uniform-data-inventory.md).
// Pages without the kit drill (#asOn, #drill, #table) name their own elements: asOn, tables, tabs
// (recorded as levelTabs), drillRows, extra (charts / histograms), clicks (facets, histogram rows),
// selects and segments. Keys: see the header of scripts/qa/uniform-pages.js.
'use strict';
const LEVEL = ['levelTabs'];
module.exports = {
  nsc_kpi: {
    url: 'nsc/kpi.html', key: 'nsc_pending', stats: '#stats .ui-stat', tabs: '#levelTabs .ui-tab:not([hidden])', asOn: '#meta', tables: ['#officeTable'], record: LEVEL,
    selects: ['#classFilter'], drillRows: '#officeTable tbody tr.click', deep: []
  },
  withheld: {
    url: 'withheld.html', key: 'withheld', stats: '#stats .ui-stat', tabs: '#drill .ui-drill-tab',
    clicks: ['#fSrc .ui-opt', '#fReason .ui-opt', '#fYear .ui-opt', '#fClass .ui-opt'],
    deep: ['?region=Raiganj', '?division=Gazole', '?ccc=Kaliyaganj', '?region=Malda&division=Chanchal']
  },
  load_extension: {
    url: 'pending_load_extension.html', key: 'load_extension', stats: '#stats .ui-stat', tabs: '#drill .ui-drill-tab',
    clicks: ['#fPhase .ui-opt', '#fWo .ui-opt', '#fAge .ui-opt', '#fClass .ui-opt'],
    deep: ['?region=Raiganj', '?division=Gazole', '?ccc=Kaliyaganj', '?kpi=y1', '?kpi=ind', '?kpi=ph3', '?kpi=big', '?q=6000', '?region=Malda&kpi=kpiAgeing1y']
  },
  pending_mc: {
    url: 'pending_mc.html', key: 'pending_mc', stats: '#stats .ui-stat', tabs: '#drill .ui-drill-tab',
    clicks: ['#fPhase .ui-opt', '#fAge .ui-opt', '#fClass .ui-opt'],
    deep: ['?region=Raiganj', '?division=Gazole', '?ccc=Kaliyaganj', '?kpiFilter=WithinMonth', '?kpiFilter=Delayed', '?kpiFilter=Industrial', '?region=Malda&kpiFilter=Delayed']
  },
  weekly: {
    url: 'weekly.html', key: 'weekly_report', stats: '#stats .ui-stat', tabs: '#levelTabs .ui-tab', asOn: '#meta', tables: ['#officeTable', '#weekTable'], record: LEVEL,
    extra: ['#chart', '#trendNote', '#officeNote', '#axisFrom', '#axisTo'], segments: ['#cat button'], selects: ['#weekFilter'], drillRows: '#officeTable tbody tr.click', deep: []
  },
  jjm: {
    url: 'jjm.html', key: 'jjm_connections', stats: '#stats .ui-stat', tabs: '#levelTabs .ui-tab', asOn: '#meta', tables: ['#officeTable'], record: LEVEL,
    extra: ['#mixHist', '#officeNote'], clicks: ['#mixHist .row'], drillRows: '#officeTable tbody tr.click', deep: []
  },
  wridd: {
    url: 'wridd.html', key: 'wridd_schemes', stats: '#stats .ui-stat', tabs: '#levelTabs .ui-tab', asOn: '#meta', tables: ['#officeTable', '#appTable'], record: LEVEL,
    extra: ['#reasonHist', '#typeHist', '#appCount'], clicks: ['#reasonHist .row', '#typeHist .row'], drillRows: '#officeTable tbody tr.click', deep: []
  },
  bharatnet: {
    url: 'bharatnet.html', key: 'bharatnet_connections', stats: '#stats .ui-stat', tabs: '#levelTabs .ui-tab', asOn: '#meta', tables: ['#officeTable', '#appTable'], record: LEVEL,
    extra: ['#monthHist', '#appCount'], clicks: ['#monthHist .row'], drillRows: '#officeTable tbody tr.click', deep: []
  },
  icds: {
    url: 'icds.html', key: 'icds_a_plus', stats: '#stats .ui-stat', tabs: '#levelTabs .ui-tab', asOn: '#meta', tables: ['#officeTable', '#appTable'], record: LEVEL,
    extra: ['#poleHist', '#projectHist', '#appCount', '#officeNote'], clicks: ['#poleHist .row', '#projectHist .row'], segments: ['#prio button'], drillRows: '#officeTable tbody tr.click', deep: []
  }
};
