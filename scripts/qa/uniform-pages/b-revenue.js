// Page parity entries: batch B, revenue (docs/uniform-data-inventory.md).
// Every table, histogram, line chart (series sums), select and the page's header texts are recorded
// (record: 'all', texts), and steps(page, shot, h) adds the page's own selects, segmented controls
// and drawers on a fresh load. Keys: see the header of scripts/qa/uniform-pages.js.
'use strict';
const ALL = ['all'];
module.exports = {
  loss: {
    url: 'loss.html', key: 'loss_report', stats: '#kpis .ui-stat', tabs: '#tabs .ui-drill-tab', drillRows: '#table tbody tr.click', fdp: '#table', record: ALL,
    texts: ['trendTitle', 'tableTitle'],
    steps: async (page, shot, h) => {
      await h.selectAll('period', 6);
      await h.selectAll('regionFilter');
      await page.selectOption('#regionFilter', 'Malda').catch(() => {});
      await h.selectAll('divisionFilter');
      await page.selectOption('#divisionFilter', 'Malda').catch(() => {});
      await h.selectAll('cccFilter');
    },
    deep: ['?region=Raiganj', '?division=Gazole', '?ccc=Manikchak', '?ccc=MATHURAPUR', '?region=U/Dinajpur%20Region', '?division=Islampur%20Division&ccc=Goalpokher']
  },
  collection: {
    url: 'collection.html', key: 'collection_report', stats: '#kpis .ui-stat', tabs: '#tabs .ui-drill-tab', drillRows: '#table tbody tr.click', fdp: '#table', record: ALL,
    texts: ['meta', 'kFy', 'kMonth', 'kDay', 'trendTitle', 'tableTitle'],
    steps: async (page, shot, h) => {
      await h.clickAll('#scale button', 'scale');
      await h.clickAll('#bulk button', 'bulk');
      for (const d of ['1', '15', '31']) await h.pick('upto', d);
      await h.selectAll('regionFilter');
      await h.pick('regionFilter', 'Malda');
      await h.selectAll('divisionFilter');
      await h.pick('divisionFilter', 'Gazole');
      await h.selectAll('cccFilter');
    },
    deep: ['?division=Gazole', '?division=raiganj', '?division=Nowhere']
  },
  theft: {
    url: 'theft_assessment.html', key: 'theft_assessment', stats: '#stats .ui-stat', tabs: '#levelTabs .ui-tab', drillRows: '#officeTable tbody tr.click', fdp: '#officeTable', record: ALL,
    texts: ['meta', 'caseCount'],
    steps: async (page, shot, h) => {
      await h.selectAll('yearFilter', 8);
      await h.selectAll('statusFilter');
      await h.clickAll('#cutHist .row', 'cut');
      await h.clickAll('#yearHist .row', 'years');
      await h.open('#caseTable tbody tr.click', 'case');
      await h.search('q', '850149075');
    },
    deep: []
  },
  remosd: {
    url: 'remosd5000.html', key: 'rem_osd', stats: '#stats .ui-stat', tabs: '#tabs .ui-drill-tab', drillRows: '#table tbody tr.click', fdp: '#table', record: ALL,
    texts: ['meta', 'trendTitle', 'tableTitle'],
    steps: async (page, shot, h) => {
      await h.clickAll('#metric button', 'metric');
      await h.selectAll('dateFilter', 8);
      await h.selectAll('regionFilter');
      await h.pick('regionFilter', 'Raiganj');
      await h.selectAll('divisionFilter');
    },
    deep: []
  },
  defaulters: {
    url: 'rem/defaulters.html', key: 'rem_defaulters_dom', stats: '#stats .ui-stat', tabs: '#levelTabs .ui-tab', drillRows: '#officeTable tbody tr.click', fdp: '#officeTable', record: ALL,
    texts: ['meta', 'count'],
    steps: async (page, shot, h) => {
      await h.selectAll('classFilter');
      await h.selectAll('tagFilter');
      await h.clickAll('#payHist .row', 'pay');
      await h.clickAll('#osdHist .row', 'osd');
      await h.open('#table tbody tr.click', 'consumer');
      await h.search('q', 'school');
    },
    deep: []
  },
  disconnection: {
    url: 'disconnection.html', key: 'disconnection', stats: '#stats .ui-stat', tabs: '#drill .ui-drill-tab', fdp: '#table, #followTable', record: ALL,
    texts: ['asOn', 'base'],
    steps: async (page, shot, h) => {
      await h.clickAll('#fOsd .ui-opt', 'osd');
      await h.clickAll('#fClass .ui-opt', 'class');
      await h.search('q', 'KUMAR');
    },
    deep: ['?region=Raiganj', '?division=Gazole', '?ccc=Kaliyaganj', '?status=noAction', '?status=disconnected', '?status=partiallyPaid', '?status=Fully%20Paid', '?followups=1', '?region=Malda&status=disconnected', '?ccc=Fulbari&followups=1']
  }
};
