// Page parity entries: the prototype pages (docs/uniform-data.md), on the kit drill (#drill, #table).
// Keys: see the header of scripts/qa/uniform-pages.js.
'use strict';
module.exports = {
  solar: {
    url: 'solar.html', key: 'solar_connections', stats: '#stats .ui-stat', tabs: '#drill .ui-drill-tab',
    deep: ['?region=Raiganj', '?division=Gazole', '?ccc=Kaliyaganj', '?status=pending', '?status=issue', '?scheme=WBREDA', '?q=3004463846', '?region=Malda&status=done']
  },
  nsc: {
    url: 'nsc.html', key: 'nsc_pending', stats: '#kpis .ui-stat', tabs: '#tabs .ui-drill-tab',
    deep: ['?region=Raiganj', '?division=Gazole', '?ccc=Kaliyaganj', '?q=6000188039', '?kpi=delay30', '?kpi=pole', '?kpi=nonpole', '?kpi=withheld', '?kpi=ind', '?kpi=procb', '?kpi=com3', '?followups=1']
  }
};
