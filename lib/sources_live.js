'use strict';
// Admin → Sources: the parts of the app the data mirror does not know about, and corrections to the
// sync inventory's page lists (server only; read by lib/sources_info.js).
//
//   LIVE       sources that are not in vm/sync/sources/*.js: Apps Script features, files on the server
//              disk, values computed on the server, external services. One row each in "By dataset".
//              category: vm_only | live_google | live_supabase | live_script | external | none
//              check:    { files: /re/, dir }  files on the server disk (present or missing)
//                        { env: 'NAME' }        the feature needs this env variable (or one of a list)
//                        { snapshotFile: 'x' }  a file the sync writes next to the snapshots
//   OVERRIDES  per sync key: pages that really read it (replaces the inventory's list) and a note.
//   REPORTS    per page (as in the app.html NAV): add / drop source keys; live: keys the page reads
//              from the original although the mirror has a copy; category for pages with no source;
//              note.
//   PAGE_ALIASES  page names in the inventory that mean a NAV entry (none today).
//
// Checked against the pages on 2026-11-06. When a page starts or stops reading something, change it here.

let RATING_INPUTS = [];
try { RATING_INPUTS = require('./rating_metrics').DATASETS.slice(); } catch (_) { RATING_INPUTS = []; }

const SCRIPT = 'Apps Script';

const LIVE = [
    // ---- Files and values on the server
    { key: 'crm_unbilled_files', label: 'Unbilled & exceptions (CRM extract files)', group: 'Consumers & meters', category: 'vm_only',
        sourceType: 'server_file', table: 'data/unbilled_{outsort,chronic,summary}.csv', pages: ['consumer/unbilled.html'],
        refresh: 'On each CRM sync', check: { files: /^unbilled_.*\.csv$/i, dir: 'data' },
        notes: 'Written to the server data folder (MZO_FILES_DIR; /opt/mzo/data/files on the VM) by the CRM extract upload (scripts/sync/sync_unbilled_from_crm.js); /api/unbilled/* stream them. Not part of the mirror.' },
    { key: 'performance_rating', label: 'Performance index rating (computed)', group: 'Revenue', category: 'vm_only',
        sourceType: 'computed', table: 'rating.json', pages: ['performance_index.html'],
        refresh: 'After each sync run', check: { snapshotFile: 'rating.meta.json' },
        notes: `Calculated on the VM (vm/sync/rating.js) from the copies of ${RATING_INPUTS.length || 'its'} input datasets and served by /api/data/rating. Without a mirror the page computes it in the browser.` },

    // ---- Live Supabase reads the mirror does not replace
    { key: 'storage_report_meta', label: 'Report meta files (Storage)', group: 'Briefing', category: 'live_supabase',
        sourceType: 'supabase_storage', table: 'reports/{pending_mc,load_extension,disconnection,defective}/meta.json',
        pages: ['executive_briefing.html', 'assistant.html', 'pending_mc.html', 'pending_load_extension.html', 'disconnection.html', 'consumer/defective_meter.html'],
        refresh: 'Live, kept 60 s',
        notes: 'Report date and KPI counts of the Storage reports. The Briefing builds on them; on the VM it keeps its result for 2 to 10 minutes.' },

    // ---- Apps Script (the mirror never calls it: several of its GET paths can write)
    { key: 'script_nsc_meta', label: 'NSC upload meta', group: 'New service connection', category: 'live_script', sourceType: SCRIPT,
        table: '?meta=1', pages: ['nsc.html', 'nsc/kpi.html', 'withheld.html', 'executive_briefing.html'], refresh: 'Live, kept 60 s',
        notes: 'Who uploaded the NSC dump and when (behind /api/nsc/meta, in mirror mode too).' },
    { key: 'script_nsc_followups', label: 'NSC follow-ups', group: 'New service connection', category: 'live_script', sourceType: SCRIPT,
        table: '?list=1', pages: ['nsc.html'], refresh: 'Live on each load and save',
        notes: 'nsc.html lists and saves follow-ups through Apps Script; the nsc_followups copy is kept for the data portal only.' },
    { key: 'script_disconnection_followups', label: 'Disconnection follow-ups', group: 'Revenue', category: 'live_script', sourceType: SCRIPT,
        pages: ['disconnection.html'], refresh: 'Live on each load and save' },
    { key: 'script_dd_visit', label: 'DD visit history and entries', group: 'DD visit', category: 'live_script', sourceType: SCRIPT,
        table: 'DD_Visits tab', pages: ['dd/dd_visit.html'], refresh: 'Live on each load and save' },
    { key: 'script_prt_initial', label: 'PRT map tab and transformer list', group: 'Substation & network', category: 'live_script', sourceType: SCRIPT,
        table: '?action=getInitialData', pages: ['prt-oil/index.html'], refresh: 'Live on each load' },
    { key: 'script_dtr_load', label: 'DTR load search and entry', group: 'Important', category: 'live_script', sourceType: SCRIPT,
        table: '?action=search', pages: ['dtr/load.html'], refresh: 'Live on each search and save' },
    { key: 'script_hub_metadata', label: 'Sheet versions (hub metadata)', group: 'Important', category: 'live_script', sourceType: SCRIPT,
        pages: ['sheet_links.html'], refresh: 'Live', notes: 'Behind /api/hub/versions.' },
    { key: 'script_stock_allotment', label: 'Stock allotment fallback', group: 'Important', category: 'live_script', sourceType: SCRIPT,
        pages: ['stock/index.html'], refresh: 'Only if Supabase fails',
        notes: 'The legacy allotment script; allotments are listed from the stock_allotments copy and saved to Supabase.' },

    // ---- External services
    { key: 'power_news', label: 'Power news (Google News RSS)', group: 'Media', category: 'external', sourceType: 'rss',
        url: 'https://news.google.com/', pages: ['media_news.html'], refresh: 'Kept 15 min by the server', notes: 'Browsers keep the answer 5 min.' },
    { key: 'ask_api', label: 'Ask: model API (Gödel Machines or Anthropic)', group: 'Ask', category: 'external', sourceType: 'api',
        pages: ['assistant.html'], refresh: 'Live per question', check: { env: ['GOEDEL_API_KEY', 'ANTHROPIC_API_KEY'] } },
    { key: 'map_layers', label: 'Map layers (GeoJSON, OpenStreetMap)', group: 'Substation & network', category: 'external', sourceType: 'api',
        pages: ['power_map/map.html', 'power_map/nh_sh_crossings.html'], refresh: 'Live in the browser',
        notes: 'District boundaries from GitHub, roads from Overpass and place names from Nominatim.' },
    { key: 'upkeeping_app', label: 'Substation upkeeping app', group: 'Important', category: 'external', sourceType: 'link',
        url: 'https://mzowbsedcl-dev.github.io/Upkeeping/', pages: ['Upkeeping/index.html'], refresh: 'Link only' }
];

const OVERRIDES = {
    nsc_followups: { pages: [], note: 'No page reads this copy: nsc.html reads the follow-ups through Apps Script.' },
    substation_upkeeping: { pages: [], note: 'No page reads this copy: the upkeeping page only links to the separate app.' },
    stock_snapshot_db: { pages: [], note: 'Written by stock uploads, read by no page.' },
    stock_allot_seq: { pages: [], note: 'Read only when the server numbers a new allotment.' },
    si_works: { note: 'si-works/si.html reads and writes Supabase itself (supabase-js); the VM copy feeds the performance rating.' },
    costcenter: { note: 'Every page that builds rows in the browser loads it (mzo_rows.js).' },
    power_map_substations: { note: 'Without a mirror the map loads the published Google sheet and only its version comes from Supabase.' },
    stock_upload_meta: { note: '/api/stock/meta reads it live from Supabase.' }
};

const GVIZ_CELLS = ['important_unbilled_mar_2026', 'important_unbilled_may_2026', 'important_unbilled_jun_2026', 'important_unbilled_3_months',
    'important_first_bill_pending', 'important_smart_meter_non_push', 'important_rem_less_unit_billed'];
const LINK_ONLY = ['nsc_pending', 'withheld', 'jjm_connections', 'consumers', 'upcoming_dd', 'dd_visit', 'dd_summary', 'smart_meter_status',
    'prt_transformers', 'accident_reports', 'dtr_records', 'dtr_peak_load', 'stock_materials', 'vendor_map'];

const REPORTS = {
    'performance_index.html': { add: RATING_INPUTS, note: 'On the VM the page reads the precomputed rating; elsewhere it computes it in the browser.' },
    'assistant.html': { add: ['load_extension'] },
    'si-works/si.html': { live: ['si_works'], note: 'Reads and edits Supabase directly.' },
    'puja.html': { live: ['puja_format_1_2025', 'puja_format_1_2026', 'puja_format_2_2025', 'puja_format_2_2026', 'puja_hourly_load_2025', 'puja_hourly_load_2026'],
        note: 'Shows the sheets embedded from Google.' },
    'important_sheets.html': { drop: ['important_smart_metering', 'important_rem_osd_followup', 'important_rem_atr_summary', 'important_rem_stw_osd', 'important_rem_osd_age'],
        live: GVIZ_CELLS, note: 'Cells come from the export copies; sheets without CSV export are read live through gviz. The other sheets are links.' },
    'stock/index.html': { add: ['stock_upload_meta'] },
    'sheet_links.html': { add: ['disconnection', 'pending_mc'], drop: LINK_ONLY, note: 'Links to the source sheets; a few datasets are read for their dates.' },
    'health_checkup.html': { category: 'none', note: 'No data.' },
    'Upkeeping/index.html': { note: 'A link to the separate upkeeping app.' },
    'executive_briefing.html': { note: 'The server builds it from the report meta files and the NSC upload meta.' },
    'admin_users.html?tab=visitors': { add: ['activity_logs'] }
};

const PAGE_ALIASES = {};

module.exports = { LIVE, OVERRIDES, REPORTS, PAGE_ALIASES };
