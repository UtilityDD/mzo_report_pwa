'use strict';
// What the checks know about columns and datasets beyond their values.
//
// Header patterns pick the columns each check looks at (office, key, date, quantity, geo).
// DATASETS gives per-dataset facts the data cannot tell: which cell is the "as on" date and how
// old it may get, the date order, key columns that must be unique, columns that are layouts.

// ---- Column roles by header ------------------------------------------------------------

const ROLE_HEADERS = {
    region: /^(_?region|reg|region[ _]?name|region_norm|circle[ _]?name|circle)$/i,
    district: /^(district)$/i,
    division: /^(_?divn|divn[ _]?name|division|division[ _]?name|div[ _]?name|diviasion|division_norm|divn_name_1|name 1)$/i,
    ccc: /^(_?supp|supp_off|ccc|ccc[ _]?name|unit[ _]?name|cccname|support office|ccc_norm|sub-division name|name of ccc.*|ccc_crm|ccc_final)$/i,
    code: /^(ccc[ _]?code|divn[ _]?code|div[ _]?code|office[ _]?code|cost[ _]?cen(ter|tre)?([ _]?code)?|cost cen_code|bill office code|resp\. ?cctr|ccc_code_hes|code of ccc.*|substr\(a\.supp_off,-7,[47]\)|plant_code|from_plant_code|plant)$/i
};

// Headers the app's office matcher reads (mzo_scope.js REGION_KEYS / DIV_KEYS / CCC_KEYS /
// CODE_KEYS): issues in these columns change what scoped users see.
const SCOPE_HEADERS = new Set([
    '_region', 'region', 'reg', 'region name', 'regionname', 'region_name', 'region_norm',
    '_divn', 'divn_name', 'divn', 'division', 'division name', 'divisionname', 'divn_name_1', 'division_norm',
    '_supp', 'supp_off', 'ccc', 'ccc name', 'unit_name', 'cccname', 'office', 'support', 'support office', 'ccc_norm',
    'ccc_code', 'ccccode', 'ccc code', 'divn_code', 'office_code', 'code', 'cost center'
]);

const KEY_HEADER = /^(appl_?no|application number|con_?id|consumer_id|consumer id|id|employee no|dtr_code|vendor_no|solar_appl_no|inspection id|victim id|doc_no|order number|registration number|mat code|material code|cost cen_code|asset_id|username|allotment_no|serial number)$/i;
const DATE_HEADER = /(date|_dt$|^dt_|dt$|\bdt\b|\bon$|time|created|updated|^today$|month|_at$|year of manufacture|lot_date|as on)/i;
const NOT_DATE_HEADER = /(year of manufacture|commission_year|^year$|defect_year|defect_month|^month$|dateorder|date_order|validity)/i;
const FUTURE_OK_HEADER = /(due|target|expiry|expire|valid|upto|up to|next|schedule|retirement|increment|plan|deadline|notice)/i;
const NONNEG_HEADER = /(qty|quantity|count|\bnos?\b|number of|no\.? of|load|\bkw|kva|capacity|stock|unrestricted|transit|mva|span|length|\bage\b|ageing|aging|age_months|delay|days|unit billed|pole|installed|supply|submit|connection|done|progress|total|_km$|rating|^pay$|^d$|^c$|^i$|^a$|^o$|over10|over5|ph3|industrial|smart|load_|phase_|agri)/i;
const SIGNED_HEADER = /(balance|value|amount|amt|osd|due|diff|variance|change|net |profit|loss|eff|lat|long|lng|percent|%|ratio|position|deviation|variation|remarks)/i;
const NOT_MEASURE_HEADER = /(code|plant|store|storage|material|mat code|matl|\bwon\b|wo_no|order|doc_no|docket|lot\b|feeder|reading|\bmr\b|network|issued document|document|vendor|fdr|substation|ss_|asset|parent|from_|to_|org_unit|voltage_level|^id$|_id$| id$|\bno\b|no\.|_no$|number|serial|sl\.? ?no|s\.?no|year|pin|phone|mobile|mob|lat|long|lng|account|mru|census|rank|seq|sequence|sort|version|gid|month|lgd|sno|zip|postl|ifsc|legacy)/i;
const NOT_NUMERIC_TEXT_HEADER = /(assignee|agency|vendor|remarks|status|name|desc|ref|note|comment|flag|type|class|cat)/i;
const LAT_HEADER = /^(z?lat|latitude|tappointlatitude|from_lat|to_lat)$/i;
const LNG_HEADER = /^(z?long|z?longitude|lng|lon|tappointlongitude|from_lng|to_lng)$/i;
// Malda zone (Malda, Uttar and Dakshin Dinajpur) with a margin.
const ZONE_BBOX = { latMin: 24.3, latMax: 26.8, lngMin: 87.3, lngMax: 89.4 };
const AS_ON_HEADER = /^(as ?on|as_on|report[ _]?date|report_as_on|update[ _]?(on|date)|upadte date|updated on|reporting date|today|report month|data date|date of report.*|report date\/email date|last updated)$/i;

// ---- Per-dataset rules -------------------------------------------------------------------
// asOn: columns holding the report / data date (max value used), in order of preference.
// maxAgeDays: how old that date may be before the dataset counts as stale.
// layout: report-style sheet (title rows, merged headers); row and header checks are skipped.

const DAY = 1;
const DATASETS = {
    nsc_pending: { asOn: ['TODAY'], maxAgeDays: 3 * DAY, asOnSingle: true, keys: ['APPL_NO'] },
    withheld: { asOn: ['TODAY'], maxAgeDays: 3 * DAY, asOnSingle: true, keys: ['APPL_NO'] },
    loss_report: { asOn: ['Update On'], maxAgeDays: 45 , asOnFirstRow: true},
    loss_targets: { maxAgeDays: null },
    bharatnet_connections: { asOn: ['UPADTE DATE', 'UPDATE DATE'], maxAgeDays: 31 , asOnFirstRow: true},
    icds_a_plus: { asOn: ['UPDATE DATE'], maxAgeDays: 31 , asOnFirstRow: true},
    icds_a: { asOn: ['UPDATE DATE'], maxAgeDays: 31 , asOnFirstRow: true},
    feeder_outage: { asOn: ['REPORT MONTH'], maxAgeDays: 62, monthEnd: true },
    docket_calls: { asOn: ['doc_crn_dt'], maxAgeDays: 3 },
    cmo_grievances: { asOn: ['Report Date'], maxAgeDays: 10 , asOnSingle: true},
    collection_report: { asOn: ['PAYMENT_DT'], maxAgeDays: 10 },
    capex_details: { asOn: ['Reporting Date'], maxAgeDays: 20 , asOnSingle: true},
    onm_advance: { asOn: ['Creation Date'], maxAgeDays: 45 },
    pending_mc: { asOn: ['Report Date'], maxAgeDays: 10, asOnSingle: true, keys: ['APPL_NO'] },
    load_extension: { asOn: ['report_date'], maxAgeDays: 10, asOnSingle: true, keys: ['APPL_NO'] },
    defective_summary: { asOn: ['REPORT_AS_ON'], maxAgeDays: 45 , asOnSingle: true},
    defective_details: { asOn: ['REPORT_AS_ON'], maxAgeDays: 45 , asOnSingle: true},
    disconnection: { asOn: ['PAID/DISCON DATE'], maxAgeDays: 10, keys: ['CON_ID'] },
    stock_snapshot: { asOn: ['Date'], maxAgeDays: 10, asOnSingle: true, dateOrder: 'mdy', roles: { plant: 'plant', 'name 1': 'division' } },
    stock_snapshot_db: { asOn: ['date'], maxAgeDays: null, dateOrder: 'mdy', roles: { plant: 'plant', name_1: 'division' } },
    solar_connections: { asOn: ['Report Date'], maxAgeDays: 10 , asOnSingle: true},
    weekly_report: { asOn: [/^date of report/i], maxAgeDays: 14 },
    rem_osd: { asOn: ['Report Date/Email Date'], maxAgeDays: 20 },
    consumers: { asOn: ['Date'], maxAgeDays: 45 , asOnSingle: true},
    historical_nsc: { asOn: ['METER_INSTALL_DATE'], maxAgeDays: 45 },
    smart_meter_work_orders: { asOn: ['Date', 'RECORD_DATE'], maxAgeDays: 10 },
    dd_summary: { asOn: ['Date of Visit'], maxAgeDays: 45 },
    meter_erp: { asOn: ['Entry Date'], maxAgeDays: 45 },
    meter_isu: { asOn: ['TRAN_DT'], maxAgeDays: 45 },
    meter_crm: { asOn: ['METER_INSTALL_DATE'], maxAgeDays: 45 },
    rem_defaulters_ind_com: { asOn: ['UPD_DT'], maxAgeDays: 45, keys: ['CON_ID'] },
    rem_defaulters_agri: { asOn: ['UPD_DT'], maxAgeDays: 45, keys: ['CON_ID'] },
    rem_defaulters_dom: { asOn: ['UPD_DT'], maxAgeDays: 45, keys: ['CON_ID'] },
    safety_inspection: { asOn: ['Entered on'], maxAgeDays: 60, notKeys: ['Inspection ID'] },
    dtr_peak_load: { asOn: ['DATE_OF_MEASUREMENT'], maxAgeDays: 90 },
    activity_logs: { asOn: ['timestamp', 'created_at'], maxAgeDays: 3 },
    theft_assessment: { asOn: ['Inspection Date'], maxAgeDays: 60 },
    nsc_followups: { maxAgeDays: null },
    upcoming_dd: { maxAgeDays: null },
    dd_visit: { maxAgeDays: null },
    stock_upload_meta: { maxAgeDays: null },
    // Admin/reference tables: no as-on date.
    portal_users: { keys: ['username'], roles: { region_code: 'region', division_code: 'division', ccc_code: 'ccc', zone_code: 'none' }, officeBlankOk: true },
    dd_user_auth: { keys: ['username'], officeBlankOk: true },
    stock_materials: { keys: ['Mat Code'] },
    stock_allotments: { notKeys: ['allotment_no'], roles: { division: 'division', plant_code: 'plant', from_plant_code: 'plant!', from_store: 'none' } },
    // The mirror keys these by content (sync-core), but each crossing should still have its own ID.
    highway_crossings: { keys: ['ID'] },
    costcenter: { roles: { 'unit name': 'none', 'division name': 'division', 'cost cen_code': 'code' } },
    pmsgy_malda: { skipDataRows: 1 },
    pmsgy_uttar_dinajpur: { skipDataRows: 1 },
    pmsgy_dakshin_dinajpur: { skipDataRows: 1 },
    x_stock_google: { asOn: ['Date'], maxAgeDays: 10, dateOrder: 'mdy', roles: { plant: 'plant', 'name 1': 'division' } },
};

// Summary sheets (one row per office, category or month): their big values are totals, not outliers.
const SUMMARY = new Set(['consumers', 'loss_report', 'loss_targets', 'weekly_report', 'defective_summary', 'collection_report', 'docket_kpi',
    'jjm_connections', 'rem_osd', 'historical_nsc', 'x_defective_summary_google']);
// Per-meter or per-site lists whose quantity columns are naturally lumpy.
const NO_OUTLIERS = new Set(['smart_meter_status']);

function datasetRules(key, src) {
    const r = Object.assign({}, DATASETS[key] || {});
    if (SUMMARY.has(key)) {
        r.noOutliers = true;
        r.summary = true;
    }
    if (NO_OUTLIERS.has(key)) r.noOutliers = true;
    if (src && src.header === false) r.layout = true;
    if (/^(puja_|important_(?!unbilled_months))/.test(key)) r.layout = true;
    return r;
}

/** Default maximum age for a generic "as on" column, from the sync schedule. */
function defaultMaxAge(schedule) {
    if (schedule === 'frequent') return 7;
    if (schedule === 'hourly') return 14;
    return 31;
}

module.exports = {
    ROLE_HEADERS, SCOPE_HEADERS, KEY_HEADER, DATE_HEADER, NOT_DATE_HEADER, FUTURE_OK_HEADER, NONNEG_HEADER, SIGNED_HEADER,
    NOT_MEASURE_HEADER, NOT_NUMERIC_TEXT_HEADER, LAT_HEADER, LNG_HEADER, ZONE_BBOX, AS_ON_HEADER, DATASETS, datasetRules, defaultMaxAge
};
