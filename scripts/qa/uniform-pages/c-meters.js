// Page parity entries: batch C, meters, consumers & DD (docs/uniform-data-inventory.md).
// Pages with their own table ids: every select, table, hist, plain value and drawn chart inside
// <main> and an open drawer are recorded (record: 'main'), hist bars are clicked one by one
// (hists), and the first rows of the detail list open the drawer (list). Pages that compute ages
// at load time run on one fixed clock. Keys: see the header of scripts/qa/uniform-pages.js.
'use strict';
const MAIN = ['main'];
const CLOCK = '2026-11-01T12:00:00+05:30';
module.exports = {
  consumer: {
    url: 'consumer/consumer.html', key: 'consumers', stats: '.ui-stats .ui-stat', tabs: '#none', asOn: '#meta', fdp: '#pivot', record: MAIN,
    drillRows: '#pivot tbody tr.click', hists: true, deep: [],
    selectValues: { rowDim: ['_region', '_divn', '_supp', 'CONN_STAT', 'BASE_CLASS', 'CONN_PHASE', 'CATEGORY', 'GOVT_STAT', 'TYPE_OF_METER', 'CONN_BY', 'TIME_OF_DAY'], colDim: ['CONN_STAT', 'BASE_CLASS', 'CONN_PHASE', 'TYPE_OF_METER'], f_CONN_STAT: ['LIVE'], f_BASE_CLASS: ['D', 'A'], f_GOVT_STAT: ['YES'] }
  },
  docket: {
    url: 'docket.html', key: 'docket_calls', stats: '#stats .ui-stat', tabs: '#levelTabs .ui-tab', asOn: '#meta', fdp: '#officeTable', record: MAIN,
    drillRows: '#officeTable tbody tr.click', list: '#listTable tbody tr.click', hists: true, clock: CLOCK, deep: [],
    selectValues: { ageFilter: ['24', '48', '168', '720'], probFilter: ['No power', 'Meter Burnt Problem', 'Problem in New Connection'] }
  },
  docket_kpi: {
    url: 'docket/kpi.html', key: 'docket_kpi', stats: '.ui-stats .ui-stat', tabs: '#levelTabs .ui-tab', asOn: '#meta', fdp: '#officeTable', readyStats: '#sN, #sAvg', record: MAIN,
    drillRows: '#officeTable tbody tr.click', list: '#probTable tbody tr.click', buttons: ['#bulk button'], deep: [],
    selectValues: { probFilter: ['No power', 'Meter Burnt Problem', 'Abnormally high bill'] }
  },
  historical_nsc: {
    url: 'historical_nsc.html', key: 'historical_nsc', stats: '#kpis .ui-stat', tabs: '#tabs .ui-drill-tab', asOn: '#asOn', fdp: '#table', record: MAIN,
    drillRows: '#table tbody tr.click', buttons: ['#period button'],
    deep: ['?region=Raiganj', '?division=Gazole', '?ccc=Kaliyaganj', '?year=2025', '?class=D', '?period=year&tab=periods', '?tab=season']
  },
  upcoming_dd: {
    url: 'dd/upcomingDD.html', key: 'upcoming_dd', stats: '#stats .ui-stat', tabs: '#levelTabs .ui-tab', asOn: '#meta', fdp: '#officeTable', record: MAIN,
    drillRows: '#officeTable tbody tr.click', list: '#listTable tbody tr.click', hists: true, clock: CLOCK, deep: [],
    selectValues: { phaseFilter: ['1', '3'], govtFilter: ['Y', 'N'], osdFilter: ['25000', '50000'], classFilter: ['D', 'C', 'A'] }
  },
  dd_visit: {
    url: 'dd/dd_visit.html', key: 'dd_visit', stats: '#stats .ui-stat', tabs: '#levelTabs .ui-tab, #listTabs .ui-tab', asOn: '#meta', fdp: '#officeTable', record: MAIN,
    drillRows: '#officeTable tbody tr.click', list: '#listTable tbody tr.click', hists: true, deep: [],
    selectValues: { catFilter: ['R', 'U'], osdFilter: ['25000', '50000'], classFilter: ['D', 'C', 'A'] }
  },
  smart_meter: {
    url: 'smart_meter/dashboard.html', key: 'smart_meter_status', stats: '#stats .ui-stat', tabs: '#levelTabs .ui-tab', asOn: '#meta', fdp: '#officeTable', record: MAIN,
    drillRows: '#officeTable tbody tr.click', list: '#listTable tbody tr.click', hists: true, settle: 3000, deep: [],
    selectValues: { typeFilter: ['10-60A', '5-30A'], lotFilter: ['1st lot', '4th lot'] }
  },
  meter_utilization: {
    url: 'meter_utilization.html', key: 'meter_erp', stats: '#kpis .ui-stat', tabs: '#tabs .ui-drill-tab', asOn: '#asOn', fdp: '#table', record: MAIN,
    drillRows: '#table tbody tr.click', list: '#table tbody tr.click', clock: CLOCK, settle: 1500,
    deep: ['?region=Raiganj', '?division=Gazole', '?ccc=Kaliyaganj', '?kpi=hand', '?kpi=old', '?kpi=nsc', '?kpi=rep', '?kpi=used']
  }
};
