'use strict';
// Data quality rules: the one config file for vm/sync/quality.js (docs/data-quality.md, "Admin → Data quality").
//
// Column names are the uniform layer's (lib/uniform.js fieldNames: "Outstanding Amount (INR)" →
// outstanding_amount_inr), so a rule keeps working when only the header's spacing or case changes.
//
// GENERIC: thresholds of the checks every dataset gets.
// DATASETS: facts the data cannot tell: key columns, the "as on" column and how old it may get,
//   columns that must not be negative, report-style sheets that only get the row / header / age checks.
// RULES: specific checks for known problems. Each has an id, the datasets it applies to, a type
//   (handled in vm/sync/lib/quality/checks.js) and its own severity, message and fix. To add one,
//   copy an entry of the same type; a new type needs a function in checks.js RULE_TYPES.

const GENERIC = {
    // Row count against the last good copy: a fall of more than this share, or to 0 rows, is critical.
    rowDropCritical: 0.20,
    // Dates later than today plus this many days are "in the future" (due dates and targets excepted).
    futureMarginDays: 31,
    // Dates before this year are impossible for this data; 1900–1912 are spreadsheet placeholders.
    minYear: 1950,
    placeholderYears: [1899, 1900, 1901, 1902, 1903, 1904, 1905, 1906, 1907, 1908, 1909, 1910, 1911, 1912],
    // A dataset with no "as on" rule may be this many days old, by its sync schedule.
    defaultMaxAgeDays: { frequent: 14, hourly: 31, daily: 45 },
    // office.blank is a warning above this share of rows, a note below it.
    officeBlankWarnShare: 0.10,
    // Examples per finding (row numbers, or office codes and names where the dataset holds no personal data).
    examples: 3
};

// Column roles by uniform name. A column can be in several (an "amount" that is also an "id" is not checked as an amount).
const COLUMN = {
    id: /(^|_)(no|nos|id|code|number|num|appl|application|registration|serial|won|account|con_id|consumer_id|inst_no|meter_no)(_\d+)?$/,
    amount: /(amount|amt|osd|notosd|balance|outstanding|value|price|rate|paid|_rs$|_inr$|lakh|subsidy|emi|fee|fees|charges|cost)/,
    count: /(^|_)(count|qty|quantity|nos|total|no_of|number_of|units?|poles?|span|load|kw|kva|mva|capa|capacity|installed|supplied|submit|deposited|disposed|pending|over10|over5|ph3|phase_\d|agri)(_|$)/,
    notMeasure: /(^|_)(code|id|no(?!_of)|number(?!_of)|serial|year|month|pin|pincode|phone|mobile|mob|lat|latitude|long|longitude|lng|lon|account|mru|sl_no|s_no|sno|rank|seq|version|lgd|ifsc|zip|postl|percent|pct|eff|ratio|loss|diff|variance|dev|deviation|change|net)(_|$)/,
    lat: /^(lat|latitude|tappointlatitude|from_lat|to_lat|zlat)$/,
    lng: /^(long|longitude|lng|lon|tappointlongitude|from_lng|to_lng|zlong)$/,
    date: /(date|_dt$|^dt_|_on$|_at$|^today$|timestamp|time$|^as_on|month_end)/,
    futureOk: /(due|target|expiry|expire|valid|upto|up_to|next|schedule|retirement|plan|deadline|notice|tenure)/,
    // Columns that name a person or reach one: a dataset with any of them is "personal" and its findings
    // carry row numbers only (never the cell values, not even office spellings).
    personal: /^(name|fname|lname|first_name|last_name|party_name|con_name|consumer_name|name_of_victim|name_of_owner\w*|applicant\w*|insp_name|visit_by|inspection_by|supervisor|inspecting_officer)$|(^|_)(phone|phone_no|mobile|mob|mob_no|reg_mob_no|telephone|email|address|addr|addr1|addr2|street|aadha|aadhaar|pan|father|con_id|consumer_id|consumer_number|cont_account|victim_id)(_|$)/
};

// Malda zone (Malda, Uttar and Dakshin Dinajpur) with a margin, for latitude / longitude columns.
const ZONE_BBOX = { latMin: 24.3, latMax: 26.8, lngMin: 87.3, lngMax: 89.4 };

// asOn: columns holding the report / data date (the latest value counts). maxAgeDays: how old it may get.
// keys: columns that must be unique (repeats are key.duplicate). nonNegative: amounts that can never be below zero.
// dateFormats: { column: 'yyyymm' | 'm/d/yy' } for date columns the uniform layer reads as numbers or text.
// layout: a report-style sheet (title rows, merged cells, read by position): only rows, header and age checks.
const DATASETS = {
    nsc_pending: { asOn: ['today'], maxAgeDays: 3, keys: ['appl_no'] },
    withheld: { asOn: ['today'], maxAgeDays: 3, keys: ['appl_no'] },
    loss_report: { asOn: ['update_on'], maxAgeDays: 45 },
    bharatnet_connections: { asOn: ['upadte_date', 'update_date'], maxAgeDays: 31 },
    icds_a: { asOn: ['update_date'], maxAgeDays: 31 },
    icds_a_plus: { asOn: ['update_date'], maxAgeDays: 31 },
    feeder_outage: { asOn: ['report_month'], maxAgeDays: 62, dateFormats: { report_month: 'yyyymm' } },
    docket_calls: { asOn: ['doc_crn_dt'], maxAgeDays: 7 },
    cmo_grievances: { asOn: ['report_date'], maxAgeDays: 10 },
    collection_report: { asOn: ['payment_dt'], maxAgeDays: 10 },
    capex_details: { asOn: ['reporting_date'], maxAgeDays: 20 },
    onm_advance: { asOn: ['creation_date'], maxAgeDays: 45 },
    pending_mc: { asOn: ['report_date'], maxAgeDays: 10, keys: ['appl_no'] },
    load_extension: { asOn: ['report_date'], maxAgeDays: 10, keys: ['appl_no'] },
    defective_summary: { asOn: ['report_as_on'], maxAgeDays: 45 },
    defective_details: { asOn: ['report_as_on'], maxAgeDays: 45 },
    disconnection: { asOn: ['paid_discon_date'], maxAgeDays: 10 },
    stock_snapshot: { asOn: ['date'], maxAgeDays: 10 },
    solar_connections: { asOn: ['report_date'], maxAgeDays: 10, keys: ['solar_appl_no'] },
    weekly_report: { asOn: ['date_of_report_in_current_week'], maxAgeDays: 14 },
    rem_osd: { asOn: ['report_date_email_date'], maxAgeDays: 20 },
    consumers: { asOn: ['date'], maxAgeDays: 45 },
    historical_nsc: { asOn: ['meter_install_date'], maxAgeDays: 45, dateFormats: { meter_install_date: 'm/d/yy' } },
    smart_meter_work_orders: { asOn: ['date', 'record_date'], maxAgeDays: 10 },
    dd_summary: { asOn: ['date_of_visit'], maxAgeDays: 45 },
    meter_erp: { asOn: ['entry_date'], maxAgeDays: 45, keys: ['serial_number'] },
    meter_isu: { asOn: ['tran_dt'], maxAgeDays: 45 },
    meter_crm: { asOn: ['meter_install_date'], maxAgeDays: 45 },
    meter_master: { keys: ['con_id'] },
    rem_defaulters_ind_com: { asOn: ['upd_dt'], maxAgeDays: 45, keys: ['con_id'] },
    rem_defaulters_agri: { asOn: ['upd_dt'], maxAgeDays: 45, keys: ['con_id'] },
    rem_defaulters_dom: { asOn: ['upd_dt'], maxAgeDays: 45, keys: ['con_id'] },
    safety_inspection: { asOn: ['entered_on'], maxAgeDays: 60, keys: ['inspection_id'], keySeverity: 'info' },
    dtr_peak_load: { asOn: ['date_of_measurement'], maxAgeDays: 90 },
    dtr_records: { keys: ['dtr_code'] },
    theft_assessment: { asOn: ['inspection_date'], maxAgeDays: 60 },
    accident_reports: { asOn: ['date_of_accident', 'incident_created_on'], maxAgeDays: 90 },
    highway_crossings: { keys: ['id_2'] },
    vendor_map: { keys: ['vendor_no'] },
    stock_materials: { keys: ['mat_code'] },
    costcenter: { keys: ['cost_cen_code'] },
    pmsgy_malda: { nonNegative: ['outstanding_amount_inr', 'sanctioned_amount_inr', 'eligible_subsidy_amount'] },
    pmsgy_uttar_dinajpur: { nonNegative: ['outstanding_amount_inr', 'sanctioned_amount_inr', 'eligible_subsidy_amount'] },
    pmsgy_dakshin_dinajpur: { nonNegative: ['outstanding_amount_inr', 'sanctioned_amount_inr', 'eligible_subsidy_amount'] },
    // Lists whose "as on" is not a date in the data, or that have none.
    nsc_followups: { maxAgeDays: null },
    loss_targets: { maxAgeDays: null },
    structure: { maxAgeDays: null },
    stock_allotments: { maxAgeDays: null },
    prt_oil_tests: { maxAgeDays: null, allowEmpty: true }
};

// Report-style sheets (header: false in vm/sync/sources/google.js): read by cell position.
const LAYOUT = /^(puja_|important_(?!unbilled_months$))/;

const RULES = [
    {
        id: 'rem.osd_all_zero',
        datasets: ['rem_defaulters_ind_com', 'rem_defaulters_agri', 'rem_defaulters_dom'],
        type: 'notAllZero',
        column: 'notosd_upd',
        severity: 'critical',
        message: 'NOTOSD_UPD (the outstanding amount the REM defaulters page shows) is 0 or blank in every row, so the page shows ₹0 for every defaulter.',
        fix: 'Ask the owner of the REM dump whether the export changed; re-export with NOTOSD_UPD filled. Until then the page could fall back to NOTOSD.'
    },
    {
        id: 'collection.office_codes',
        datasets: ['collection_report'],
        type: 'officeLevel',
        expect: 'ccc',
        sum: 'amount_paid',
        sumUnit: 'lakh',
        severity: 'warning',
        message: 'Payments are booked to region, division or zone office codes instead of a CCC, so the page shows extra divisions and CCCs.',
        fix: 'Map region-office codes (6610000, 6620000, 6630000) to a "Region office (HT / bulk)" bucket in the page, or book them to the CCC in the sheet.'
    },
    {
        id: 'loss.rollup',
        datasets: ['loss_report'],
        type: 'rollup',
        column: 'cum_input_mu',
        groupBy: ['year', 'month'],
        parent: 'region',
        child: 'ccc',
        tolerance: 0.02,
        unit: 'MU',
        severity: 'warning',
        message: 'The region rows carry more input energy than their CCC rows add up to, so zone and region AT&C are not the weighted mean of their divisions.',
        fix: 'Ask the Loss sheet owner what the extra input is (HT / bulk consumers booked at region level) and add a note on the Losses page, or add the missing rows.'
    },
    {
        id: 'geo.range',
        datasets: ['highway_crossings', 'power_map_substations', 'power_map_taps', 'pmsgy_malda', 'pmsgy_uttar_dinajpur', 'pmsgy_dakshin_dinajpur'],
        type: 'geo',
        severity: 'warning',
        message: 'Coordinates outside Malda zone or not valid at all (often the decimal point was lost, e.g. 24,870,257 for 24.870257), so the point is missing or misplaced on the map.',
        fix: 'Correct the latitude / longitude in the sheet (decimal degrees, about 24.3–26.8 N and 87.3–89.4 E).'
    }
];

function datasetRules(key) {
    const r = Object.assign({}, DATASETS[key] || {});
    if (LAYOUT.test(key)) r.layout = true;
    r.rules = RULES.filter((x) => x.datasets.includes(key));
    return r;
}

/** The rules' identity: a change re-checks every dataset on the next run. */
function rulesHash() {
    const crypto = require('crypto');
    const fs = require('fs');
    const path = require('path');
    const h = crypto.createHash('sha1');
    for (const f of ['rules.js', 'checks.js', 'engine.js']) {
        try { h.update(fs.readFileSync(path.join(__dirname, f))); } catch (_) { h.update('-'); }
    }
    return h.digest('hex').slice(0, 12);
}

module.exports = { GENERIC, COLUMN, ZONE_BBOX, DATASETS, LAYOUT, RULES, datasetRules, rulesHash };
