/* Assistant catalogue — shared by server.js (system prompt + tool schemas) and
 * assistant.html (building links, running data tools in the browser).
 *
 * report.views: named presets → URL query the report page understands today.
 * report.params: which office/search filters the page accepts in its URL.
 * report.data: true when the assistant can count it in the browser (query_report).
 */
(function (root, factory) {
  var catalog = factory();
  if (typeof module === 'object' && module.exports) module.exports = catalog;
  else root.MZO_ASSISTANT_CATALOG = catalog;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var OFFICES = {
    Malda: {
      Malda: ['Manikchak', 'Golapganj', 'Baishnabnagar', 'Kaliachak', 'Mothabari', 'Sujapur', 'Rathbari', 'Fulbari', 'Mokdumpur'],
      Chanchal: ['Bhaluka', 'Samsi', 'Paranpur', 'Chanchal', 'Malatipur', 'Harishchandrapur', 'Kushida'],
      Gazole: ['Gazole', 'Aiho', 'Pandua', 'Bamongola', 'Old Malda']
    },
    'Uttar Dinajpur': {
      Raiganj: ['Itahar', 'Hemtabad', 'Kaliyaganj', 'Raiganj', 'Birnagar', 'Karandighi'],
      Islampur: ['Islampur', 'Chopra', 'Dalkhola', 'Goalpokher', 'Kanki']
    },
    'Dakshin Dinajpur': {
      Balurghat: ['Balurghat', 'Tapan', 'Kumarganj', 'Hili', 'Patiram'],
      Buniadpur: ['Buniadpur', 'Kusmandi', 'Harirampur', 'Gangarampur']
    }
  };

  var OFFICE = ['region', 'division', 'ccc'];

  var REPORTS = [
    { key: 'briefing', title: 'Briefing', url: 'executive_briefing.html', about: 'Zone-wide list of what needs attention today (critical / high / watch items across NSC, master cards, disconnection, defective meters, load extension).' },
    { key: 'nsc', title: 'Pending NSC', url: 'nsc.html', data: true, params: OFFICE.concat(['search']),
      about: 'New service connection applications that are paid but not yet connected: delay since payment, pole cases, agency, class.',
      views: { over_30_days: 'kpi=delay30', pole_cases: 'kpi=pole', rescued_from_withheld: 'kpi=withheld', industrial: 'kpi=ind', commercial_three_phase: 'kpi=com3', followups: 'followups=1' } },
    { key: 'nsc_kpi', title: 'NSC KPIs', url: 'nsc/kpi.html', about: 'Average quotation, work-order and connection delay (days) by office.' },
    { key: 'historical_nsc', title: 'NSC: Historical Analysis', url: 'historical_nsc.html', about: 'Connections released per week / month / quarter / year by class.' },
    { key: 'weekly', title: 'Weekly deposit vs disposal', url: 'weekly.html', about: 'Applications deposited vs disposed each week and the backlog change.' },
    { key: 'pending_mc', title: 'Pending master card', url: 'pending_mc.html', params: OFFICE,
      about: 'Meters installed whose master card is still pending.',
      views: { over_90_days: 'kpiFilter=Delayed', industrial: 'kpiFilter=Industrial', within_30_days: 'kpiFilter=WithinMonth' } },
    { key: 'withheld', title: 'Withheld NSC', url: 'withheld.html', about: 'Withheld applications, their reasons, and how many have no valid reason.' },
    { key: 'load_extension', title: 'Pending load extension', url: 'pending_load_extension.html', data: true, params: OFFICE.concat(['search']),
      about: 'Load extension applications waiting, how long they have waited, and the estimated fixed-charge revenue held up.',
      views: { over_1_year: 'kpi=y1', industrial: 'kpi=ind', three_phase: 'kpi=ph3', above_10kw: 'kpi=big' } },
    { key: 'solar', title: 'Solar connections', url: 'solar.html', data: true, params: OFFICE.concat(['search']),
      about: 'Rooftop solar applications (PM Surya Ghar, WBREDA, Aloshree, others): connected (meter replaced), pending, meter issue.',
      views: { connected: 'status=done', pending: 'status=pending', meter_issue: 'status=issue', pm_surya_ghar: 'scheme=PMSGMBY' } },
    { key: 'jjm', title: 'JJM connection', url: 'jjm.html', about: 'Jal Jeevan Mission connections by office (deposited, connected, blocked).' },
    { key: 'meter_utilization', title: 'Meter utilization', url: 'meter_utilization.html', about: 'Meters issued vs used for new connections / replacement, meters in hand.' },
    { key: 'wridd', title: 'WRIDD schemes', url: 'wridd.html', about: 'Water resources schemes: effected vs pending connections.' },
    { key: 'bharatnet', title: 'Bharat Net', url: 'bharatnet.html', about: 'Bharat Net gram panchayat connections: connected vs pending.' },
    { key: 'icds', title: 'ICDS connections', url: 'icds.html', about: 'Anganwadi (ICDS) centres: CCC mapping and meters given.' },
    { key: 'loss', title: 'Losses', url: 'loss.html', data: true, params: OFFICE,
      about: 'Cumulative AT&C loss, distribution loss and collection efficiency by office and month (financial year April–March), with targets.' },
    { key: 'performance_index', title: 'Performance index', url: 'performance_index.html', about: 'Office ranking by a weighted score (loss, delays, pending).' },
    { key: 'collection', title: 'Collection', url: 'collection.html', params: ['division'], about: 'Revenue collection by day / week / month and office.' },
    { key: 'osd_summary', title: 'OSD summary', url: 'rem/osd.html', about: 'Total outstanding dues with REM share, class, supply status, high-value and payment-aging views; jumps to Disconnection and REM pages.' },
    { key: 'disconnection', title: 'Disconnection tracker', url: 'disconnection.html', params: ['division'],
      about: 'Defaulters with outstanding dues: fully paid, part paid, disconnected, no action yet; follow-up notes.',
      views: { no_action: 'status=noAction', disconnected: 'status=disconnected', part_paid: 'status=partiallyPaid', followups: 'followups=1' } },
    { key: 'theft', title: 'Theft assessment', url: 'theft_assessment.html', about: 'Theft cases: provisional and final assessment, recovery, outstanding.' },
    { key: 'rem_osd', title: 'REM OSD > ₹5,000', url: 'remosd5000.html', about: 'Consumers with outstanding above ₹5,000 by class and office.' },
    { key: 'rem_defaulters', title: 'REM defaulters', url: 'rem/defaulters.html', about: 'Defaulter lists by type and last payment.' },
    { key: 'upcoming_dd', title: 'Upcoming DD', url: 'dd/upcomingDD.html', about: 'Upcoming disconnection-drive (DD) consumers.' },
    { key: 'dd_visit', title: 'DD visit', url: 'dd/dd_visit.html', about: 'DD visit follow-up dashboard.' },
    { key: 'consumer_profile', title: 'Consumer & meter profile', url: 'consumer/profile.html', about: 'Live consumer base with defective, smart-meter and unbilled rates (%) by office for comparison.' },
    { key: 'defective_meter', title: 'Defective meter', url: 'consumer/defective_meter.html', about: 'Defective meters by age, class, load.' },
    { key: 'consumers', title: 'Consumers', url: 'consumer/consumer.html', about: 'Consumer counts, load and outstanding by office and class.' },
    { key: 'docket', title: 'Docket calls', url: 'docket.html', about: 'Complaint dockets and closure.' },
    { key: 'docket_kpi', title: 'Docket KPI', url: 'docket/kpi.html', about: 'Docket closure time by office.' },
    { key: 'smart_meter', title: 'Smart meter utilization', url: 'smart_meter/dashboard.html', about: 'Smart meter installation and use.' },
    { key: 'capex', title: 'Capex summary', url: 'capex_all.html', about: 'Advances to vendors (capex) and their ageing.' },
    { key: 'onm', title: 'O&M summary', url: 'advance_onm.html', about: 'O&M advances to vendors and their ageing.' },
    { key: 'power_map', title: 'Power map', url: 'power_map/map.html', about: 'Map of substations and feeders.' },
    { key: 'feeder_outage', title: 'Feeder outage', url: 'feeder_outage.html', about: 'Feeder outage hours by month and office.' },
    { key: 'cmo', title: 'CMO grievance', url: 'cmo.html', about: 'Chief Minister\'s Office grievances.' },
    { key: 'pmsgy', title: 'PM Surya Ghar', url: 'pmsgy.html', about: 'PM Surya Ghar rooftop solar pipeline by stage and vendor.' },
    { key: 'si_works', title: 'Priority SI works', url: 'si-works/si.html', about: 'Priority system improvement works and their progress.' },
    { key: 'accident', title: 'Accident reports', url: 'accident/accident.html', about: 'Electrical accidents by month and region.' },
    { key: 'safety', title: 'Safety app reports', url: 'safety_inspection.html', about: 'Safety inspections by office.' },
    { key: 'manpower', title: 'Manpower report', url: 'manpower.html', about: 'Staff strength (PIN protected).' },
    { key: 'dtr', title: 'DTR records', url: 'dtr/index.html', about: 'Distribution transformers and capacity by office.' },
    { key: 'stock', title: 'Stock', url: 'stock/index.html', about: 'Stock of major materials by store.' },
    { key: 'important_sheets', title: 'Important data sheets', url: 'important_sheets.html', about: 'Links to important Google Sheets.' },
    { key: 'news', title: 'Power news hub', url: 'media_news.html', about: 'Power sector news.' }
  ];

  var GLOSSARY = {
    NSC: 'new service connection', MC: 'master card (consumer record created after a meter is installed)', CCC: 'customer care centre (the smallest office)',
    'AT&C loss': 'aggregate technical and commercial loss', OSD: 'outstanding dues', WO: 'work order', DD: 'disconnection drive',
    'Proc-B': 'promoter/developer applications', PMSGMBY: 'PM Surya Ghar Muft Bijli Yojana (rooftop solar)', JJM: 'Jal Jeevan Mission',
    WRIDD: 'Water Resources Investigation & Development Department', ICDS: 'Integrated Child Development Services (Anganwadi centres)'
  };

  function report(key) { for (var i = 0; i < REPORTS.length; i++) if (REPORTS[i].key === key) return REPORTS[i]; return null; }

  // Build the in-app link for a report + filters. Unknown filters are dropped.
  function buildLink(key, opts) {
    var r = report(key);
    if (!r) return null;
    opts = opts || {};
    var q = [], allowed = r.params || [];
    ['region', 'division', 'ccc'].forEach(function (k) { if (opts[k] && allowed.indexOf(k) !== -1) q.push(k + '=' + encodeURIComponent(opts[k])); });
    if (opts.search && allowed.indexOf('search') !== -1) q.push('q=' + encodeURIComponent(opts.search));
    if (opts.view && r.views && r.views[opts.view]) q.push(r.views[opts.view]);
    return r.url + (q.length ? '?' + q.join('&') : '');
  }

  return { OFFICES: OFFICES, REPORTS: REPORTS, GLOSSARY: GLOSSARY, report: report, buildLink: buildLink };
});
