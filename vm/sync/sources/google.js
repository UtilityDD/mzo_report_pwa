'use strict';
// Google Sheets the app reads, mirrored through the same public CSV/TSV URLs the browser uses
// (published "pub" links, /export and gviz). GET only; never Apps Script.
//
// Not here, on purpose (sources/supabase.js mirrors them from Supabase / Supabase Storage):
// stock_snapshot, defective_summary, defective_details, disconnection, pending_mc,
// load_extension and the Power Map substations. Their Google sheets are only fallbacks.
//
// Not mirrored at all (reachable only through Apps Script, which the mirror must not call):
// the disconnection follow-ups, DD visit history/entry forms, the PRT "Map" tab, DTR load search
// and the stock allotment script. See docs/data-mirror.md.
//
// Google sends no ETag/Last-Modified for these URLs, so the change check is the sha1 of the
// streamed body (done by the framework). NSC and Withheld have a cheap version: the first two
// rows (they carry the TODAY report date), read through a gviz range query, plus the row count
// (gviz `select count(A)`), so a copy cut short mid-upload is read at once, not up to 6 h later.
//
// Snapshots: raw() hands the framework the exact bytes, which become the snapshot the VM app
// serves; rows() parses the same bytes from ctx.input, so each sheet is downloaded once.
// urls = the exact URLs pages and server.js fetch (the client maps them to the snapshot);
// dataHubKeys = the mzo_data_hub.js keys; sensitive = never snapshotted (PINs, bank details,
// Aadhaar/PAN numbers).

const { Readable, pipeline } = require('stream');
const { parse } = require('csv-parse');
const { parse: parseSync } = require('csv-parse/sync');
const { sha1, SkipError } = require('../lib/util');
const { parseDate } = require('../lib/infer');

const GS = 'https://docs.google.com/spreadsheets/d/';

// ---- URL helpers -------------------------------------------------------------------------

/** Published-to-web tab: /d/e/<pubId>/pub?gid=…&single=true&output=csv|tsv (no gid → first tab). */
function pub(pubId, gid, format = 'csv') {
    const q = gid === undefined || gid === null ? `output=${format}` : `gid=${gid}&single=true&output=${format}`;
    return {
        url: `${GS}e/${pubId}/pub?${q}`,
        format,
        ref: { pubId, gid: gid === undefined ? null : String(gid), format, via: 'pub' },
        human: `${GS}e/${pubId}/pubhtml` + (gid === undefined || gid === null ? '' : `?gid=${gid}&single=true`)
    };
}

/** Link-shared spreadsheet, /export?format=csv (gid optional). */
function exportCsv(spreadsheetId, gid) {
    return {
        url: `${GS}${spreadsheetId}/export?format=csv` + (gid === undefined ? '' : `&gid=${gid}`),
        format: 'csv',
        ref: { spreadsheetId, gid: gid === undefined ? null : String(gid), format: 'csv', via: 'export' },
        human: `${GS}${spreadsheetId}/edit` + (gid === undefined ? '' : `#gid=${gid}`)
    };
}

/** Link-shared spreadsheet through the gviz query endpoint (sheet name or gid; headers=0 keeps every row; tq: a query). */
function gviz(spreadsheetId, { sheet, gid, headers, range, tq } = {}) {
    let q = 'tqx=out:csv';
    if (headers !== undefined) q += `&headers=${headers}`;
    if (sheet) q += `&sheet=${encodeURIComponent(sheet)}`;
    if (gid !== undefined) q += `&gid=${gid}`;
    if (range) q += `&range=${range}`;
    if (tq) q += `&tq=${encodeURIComponent(tq)}`;
    return {
        url: `${GS}${spreadsheetId}/gviz/tq?${q}`,
        format: 'csv',
        ref: { spreadsheetId, sheet: sheet || null, gid: gid === undefined ? null : String(gid), format: 'csv', via: 'gviz' },
        human: `${GS}${spreadsheetId}/edit` + (gid === undefined ? '' : `#gid=${gid}`)
    };
}

// ---- Inventory -------------------------------------------------------------------------
// group = sidebar group in app.html NAV. schedule: frequent (5 min) for small sheets clerks
// edit during the day, hourly for mid-size ones, daily (after 02:00 IST) for multi-MB dumps.
// cache = the DataHub key in mzo_data_hub.js, when the sheet is registered there.

const NSC = 'New service connection';
const REV = 'Revenue';
const DD = 'DD visit';
const CM = 'Consumers & meters';
const ADV = 'Vendor advances';
const NET = 'Substation & network';
const IMP = 'Important';

const NSC_ID = '1QnmPKSAtwmW-m1-gn4qmZBWanx9_Vwbk63XhwyQBiKU';
const WITHHELD_ID = '12nS8GAQ1weIMWoEIeydcdKTKd-XwHNu9W07DKudGuOg';
const METER_PUB = '2PACX-1vSmzya-jypjfu9nN5QWuRJ6sbIgrqQ7Wa1eAx6Wfoepft2UpNwBC4a_rd4uJ6VpLhNu7FnjDBa8mJxW';
const PMSGY_PUB = '2PACX-1vRcFPRu1ywimetADU-XYIZ_x3McWUhR5ZbPUIIySO6_V8VJTyU9Vhw8DD-1RBEPFj0q2pUFMvutYV30';
const DTR_PUB = '2PACX-1vRZPPnIF-T7wgii6J35a-3Wz7RC86Zq-eMSQud795CVJV-92Vy9oJjO6TDpjpgiLNAVPcVn6X_keILV';
const PRT_PUB = '2PACX-1vRtpueyQwlq63VP2Tm2_vITV31jKBSceDGJQVJtYeqVVDBSg3QAHzLKrv60i6Z9oODXXzOE-fdfMb8b';
const MANPOWER_PUB = '2PACX-1vRRXojudL5q-ln7pXOcbLaGsBqznppnvsINcp8xEFvpJUWRCiC7bjii9eZYSu0istzyM91m4yybd5g-';
const SMART_PUB = '2PACX-1vSWjwUI4EUgEABlcggpdOS-WSPKY8my-5T0cLxT4h8tNz_IreQy6jUYKBnB5yc0n-fcs8FpVbwo6Qay';
const LOSS_PUB = '2PACX-1vSYyqn0urGdbqXarhELRbSCeRvgUCSHID_1Z4E_kptBTR5u69R0HHX0Jk23n6KseriNct2q9XwXu04E';
const REM_DEF_PUB = '2PACX-1vRFk-wa_x-dsthFXNsWa9wRxWOQrMD-yEiucvA2FtJIbwnTiGqVs3OT_eXxqyAOBqvGSDRiG-Hr0hK1';
const ICDS_PUB = '2PACX-1vRoJd2-uQ5XxKjJ8LO1kDPpN76DepB_COmXyIg8qtO7fA7DBU0cydL27t87tj7upjxoC_F7JSBdPkvJ';
const VENDOR_PUB = '2PACX-1vTZPn6CB_cHTFVb8S5vpvaBnczj63fYMTI0RVEdMzVcQ8O6XQi5iwTbMp2xa5vsL6zHGWxezWUSehrN';
// URL prefixes pages complete at run time (meter_utilization.html: BASE_URL + '&gid=' + gid; manpower.html: SHEET + gid).
const METER_PAGE_URL = `${GS}e/${METER_PUB}/pub?output=csv`;
const MANPOWER_PAGE_URL = `${GS}e/${MANPOWER_PUB}/pub?single=true&output=csv&gid=`;

const REPORT_NOTE = 'Report-style sheet (title rows, merged headers): every row is kept as data and columns are named by letter (col_a, col_b, …).';
const GVIZ_NOTE = ' CSV download is turned off for viewers of this file, so it is read through gviz, which can leave a cell blank when its type differs from the rest of its column.';

const SHEETS = [
    // ---- New service connection
    { key: 'nsc_pending', label: 'Pending NSC (working dump)', group: NSC, cache: 'CACHE_NSC_v5',
        pages: ['nsc.html', 'nsc/kpi.html', 'nsc/upload.html', 'performance_index.html', 'assistant.html', 'sheet_links.html'],
        src: gviz(NSC_ID, { sheet: 'nsc_working' }), schedule: 'frequent', primaryKey: ['APPL_NO'],
        peek: gviz(NSC_ID, { sheet: 'nsc_working', range: 'A1:AZ2' }).url, maxSkipHours: 6,
        peekCount: gviz(NSC_ID, { sheet: 'nsc_working', tq: 'select count(A)' }).url,
        extraUrls: ['/api/nsc/dataset'],
        notes: 'The server fallback URL for /api/nsc/dataset (Google Sheet nsc_working, written by nsc/upload.html).' },
    { key: 'nsc_followups', label: 'NSC follow-ups', group: NSC,
        pages: ['nsc.html'], src: gviz(NSC_ID, { sheet: 'Followups' }), schedule: 'frequent', primaryKey: ['id'], urls: [],
        notes: 'The Followups tab of the NSC workbook; the app writes it through Apps Script and the mirror reads it through gviz.' },
    { key: 'withheld', label: 'Withheld NSC', group: NSC, cache: 'CACHE_WITHHELD_v4',
        pages: ['withheld.html', 'nsc/upload.html', 'sheet_links.html'],
        src: gviz(WITHHELD_ID, { sheet: 'Sheet1' }), schedule: 'frequent', primaryKey: ['APPL_NO'],
        peek: gviz(WITHHELD_ID, { sheet: 'Sheet1', range: 'A1:Z2' }).url, maxSkipHours: 6,
        peekCount: gviz(WITHHELD_ID, { sheet: 'Sheet1', tq: 'select count(A)' }).url,
        // About 67,000 rows through gviz: a re-upload that shifts every row rewrites them all, which takes
        // the VM several minutes, so it gets more than a frequent source's 4 min.
        timeoutMs: 10 * 60000,
        extraUrls: ['/api/withheld/dataset'],
        notes: 'The server fallback URL for /api/withheld/dataset.' },
    { key: 'historical_nsc', label: 'Historical NSC analysis', group: NSC, pages: ['historical_nsc.html'],
        src: pub('2PACX-1vT1VYUaMC92oZPb3f452Q2b5WJf3Zhm02JdVq2Hsykt-_ipAcIIYaFdgYm4qZdZ8heGcrDon5eQA7nk', 2021450441), schedule: 'daily' },
    { key: 'weekly_report', label: 'Weekly deposit vs disposal', group: NSC, cache: 'CACHE_WEEKLY', pages: ['weekly.html'],
        src: pub('2PACX-1vSMuO-ddereEG6J2s2Bmqp-HXo85ky4S4R5Yt-0HdoNHHa5r8xOEK4MJ1Syhyqzjpm2lTI4sT85nR4N', 0), schedule: 'hourly' },
    { key: 'solar_connections', label: 'Solar connections', group: NSC, cache: 'CACHE_SOLAR', pages: ['solar.html', 'assistant.html'],
        src: pub('2PACX-1vR5Vnb9TxymVIcBZsUBWZ-21Frkn77O4IyNus3Zo42qPm09N6MlJ3E0Vh3tHywcMAiy2y0uRm5XfIdk', 0), schedule: 'hourly',
        primaryKey: ['SOLAR_APPL_NO'] },
    { key: 'jjm_connections', label: 'JJM connections', group: NSC, cache: 'CACHE_JJM', pages: ['jjm.html', 'sheet_links.html'],
        src: pub('2PACX-1vTZfBrOb6Y4kPoF_Lix-MhUxVFy5l7urYoAoI-h-w6EbcTFuZPqIhjWTQ26RYcvYenl51HdpCawEVc7', 2138035305), schedule: 'frequent' },
    { key: 'meter_erp', label: 'Meter ERP data', group: NSC, cache: 'CACHE_METER_ERP', pages: ['meter_utilization.html'],
        src: pub(METER_PUB, 1335293243), schedule: 'daily', extraUrls: [METER_PAGE_URL + '&gid=1335293243'] },
    { key: 'meter_master', label: 'Meter master data', group: NSC, cache: 'CACHE_METER_MASTER', pages: ['meter_utilization.html'],
        src: pub(METER_PUB, 1053803476), schedule: 'daily', extraUrls: [METER_PAGE_URL + '&gid=1053803476'] },
    { key: 'meter_crm', label: 'Meter CRM data', group: NSC, cache: 'CACHE_METER_CRM', pages: ['meter_utilization.html'],
        src: pub(METER_PUB, 1638328510), schedule: 'daily', extraUrls: [METER_PAGE_URL + '&gid=1638328510'] },
    { key: 'meter_isu', label: 'Meter ISU data', group: NSC, cache: 'CACHE_METER_ISU', pages: ['meter_utilization.html'],
        src: pub(METER_PUB, 329630218), schedule: 'daily', extraUrls: [METER_PAGE_URL + '&gid=329630218'] },
    { key: 'wridd_schemes', label: 'WRIDD schemes', group: NSC, cache: 'CACHE_WRIDD', pages: ['wridd.html'],
        src: pub('2PACX-1vTt6H8YfaFRi1H3KzVHv97nbhlJQ-96cuFh4J0KyVjRSw1I78BYxUek9etiE9xs-7vHYn98uPMc6sFj', 0), schedule: 'hourly' },
    { key: 'bharatnet_connections', label: 'Bharat Net connections', group: NSC, cache: 'CACHE_BHARATNET',
        pages: ['bharatnet.html', 'sheet_links.html'],
        src: pub('2PACX-1vRCD7M4eBch9ixyQH3N0F0k7Yjlw1zw92JNh_76l2orfROh-PElMo62bXeW0EHI9v-Zg5_0olpiQxmT', 0), schedule: 'frequent' },
    { key: 'icds_a_plus', label: 'ICDS connections A+', group: NSC, cache: 'CACHE_ICDS_APLUS', pages: ['icds.html', 'sheet_links.html'],
        src: pub(ICDS_PUB, 1839469967), schedule: 'hourly' },
    { key: 'icds_a', label: 'ICDS connections A', group: NSC, cache: 'CACHE_ICDS_A', pages: ['icds.html', 'sheet_links.html'],
        src: pub(ICDS_PUB, 193110110), schedule: 'hourly' },

    // ---- Revenue
    { key: 'loss_report', label: 'Loss report', group: REV, cache: 'CACHE_LOSS',
        pages: ['loss.html', 'performance_index.html', 'assistant.html', 'sheet_links.html'],
        src: pub(LOSS_PUB), schedule: 'frequent' },
    { key: 'loss_targets', label: 'Loss targets', group: REV, cache: 'CACHE_LOSS_TARGET', pages: ['loss.html', 'assistant.html'],
        src: pub(LOSS_PUB, 2042465667), schedule: 'frequent' },
    { key: 'collection_report', label: 'Collection report', group: REV, cache: 'CACHE_COLLECTION', pages: ['collection.html', 'sheet_links.html'],
        src: pub('2PACX-1vQ2S20QZ57pQpdawzKFHAIqD_OpCNmbmMbYlttluLVA0JZpVK405pS0-2ZIqm-X9jAA8ZB1XwF2serr', 1977250749), schedule: 'hourly' },
    { key: 'theft_assessment', label: 'Theft assessment', group: REV, cache: 'CACHE_THEFT_ASSESSMENT_v2', pages: ['theft_assessment.html'],
        src: exportCsv('1RiP2NDE6BgtgEp3Fufpx1G8p9k3VR786TY60LpvMdZM'), schedule: 'daily' },
    { key: 'rem_osd', label: 'REM OSD > Rs 5,000', group: REV, cache: 'CACHE_REM_v2', pages: ['remosd5000.html'],
        src: gviz('18y_nHZngDDO13nlluN9qba7AfgDe5dKGGHnXRYUU-b8'), schedule: 'hourly' },
    { key: 'rem_defaulters_ind_com', label: 'REM Ind/Com defaulters', group: REV, cache: 'CACHE_REM_DEFAULTERS', pages: ['rem/defaulters.html'],
        src: pub('2PACX-1vQOynlOrqc0iXUKYDgqh-tTjIgDA5WidJDcDhYM7MhfKIZzZ7iduFD2LN4fYRXmVvcLCz1X-OJfcmRx', 0, 'tsv'), schedule: 'hourly',
        primaryKey: ['CON_ID'] },
    { key: 'rem_defaulters_agri', label: 'REM Agri defaulters', group: REV, cache: 'CACHE_REM_AGRI', pages: ['rem/defaulters.html'],
        src: pub(REM_DEF_PUB, 0, 'tsv'), schedule: 'hourly', primaryKey: ['CON_ID'] },
    { key: 'rem_defaulters_dom', label: 'REM Dom defaulters', group: REV, cache: 'CACHE_REM_DOM', pages: ['rem/defaulters.html'],
        src: pub(REM_DEF_PUB, 1106133732, 'tsv'), schedule: 'hourly', primaryKey: ['CON_ID'] },

    // ---- DD visit
    { key: 'upcoming_dd', label: 'Upcoming DD', group: DD, pages: ['dd/upcomingDD.html', 'sheet_links.html'],
        src: gviz('1aUeVnSc-OmFqqrUdoZxv8v8659u52zlIWddnpJgU9Uk', { gid: 487034861 }), schedule: 'daily', sensitive: true,
        notes: 'Sensitive: holds consumer AADHAR (Aadhaar) and PAN numbers. PocketBase only, no snapshot; the page reads the sheet.' },
    { key: 'dd_visit', label: 'DD visit consumers', group: DD, cache: 'CACHE_DD_VISIT', pages: ['dd/dd_visit.html', 'sheet_links.html'],
        src: pub('2PACX-1vSCKEl95dh4kyG-QPJbFJ5x7U7yo7h5bJGuMewsMr2hjMAlCj7UWxqvL_a-2hdyQd-laI8BAX3hU5_T', 0), schedule: 'daily', sensitive: true,
        notes: 'Sensitive: holds consumer PAN numbers. PocketBase only, no snapshot; the page reads the sheet.' },
    { key: 'dd_summary', label: 'DD summary', group: DD, pages: ['sheet_links.html', 'admin_users.html'],
        src: pub('2PACX-1vRawhIW9ICZmzuThsL5opfI40WY6upCg5kFzoFXi2UJPR-svO6_cByXy5Y3u_p-2La_tH8SxhFfl29B', 220026293), schedule: 'daily',
        notes: 'Listed under Sheet links and Admin → Sources; DD visit results.' },

    // ---- Consumers & meters
    { key: 'consumers', label: 'Consumers', group: CM, pages: ['consumer/consumer.html', 'sheet_links.html'],
        src: pub('2PACX-1vQT4ufTMHJGTUqNSqFSzz0q2x-ShM_WHlfSRxT4tVqA6GcaMK5g38PDLmcJR4JXuxLi-tKafW-Yxwdo', 0), schedule: 'hourly' },
    { key: 'docket_calls', label: 'Docket calls', group: CM, cache: 'CACHE_DOCKET', pages: ['docket.html', 'sheet_links.html'],
        src: pub('2PACX-1vTT56PULgjKw_-wu8lmMWNE6SC1KBDyAKxeHaMloZJWUQ9HQsJoqosYF33DrQK3NX9Bvfn0mjfx-dkP', 1059428699), schedule: 'frequent' },
    { key: 'docket_kpi', label: 'Docket KPI', group: CM, pages: ['docket/kpi.html'],
        src: pub('2PACX-1vThi-zr48XGYbnQO7YR8xmhVQZV2Wb3t05wTN2kqM254DXNOr5wfeBWNIhywNk2egvpYeSte2EWLLvD', 0), schedule: 'frequent' },
    { key: 'smart_meter_status', label: 'Smart meter utilization', group: CM, pages: ['smart_meter/dashboard.html', 'sheet_links.html'],
        src: pub(SMART_PUB, 327926255, 'tsv'), schedule: 'hourly', timeoutMs: 10 * 60000,
        notes: 'Google takes over a minute to render this TSV.' },
    { key: 'smart_meter_work_orders', label: 'Smart meter work orders', group: CM, pages: ['smart_meter/dashboard.html'],
        src: pub(SMART_PUB, 958431052, 'tsv'), schedule: 'daily', timeoutMs: 15 * 60000,
        notes: 'Google takes over a minute to render this TSV.' },

    // ---- Vendor advances
    { key: 'capex_details', label: 'Capex details', group: ADV, cache: 'CACHE_CAPEX', pages: ['capex_all.html', 'sheet_links.html'],
        src: pub('2PACX-1vQI2neSVbvMR4fF910Q0AWUcq02leP-sob8q4f9goT46hgLutCpxCjSL6y6X3s2vYBJRNN7WrFCjE0R', 439685010), schedule: 'daily' },
    { key: 'onm_advance', label: 'O&M advance', group: ADV, pages: ['advance_onm.html', 'sheet_links.html'],
        src: pub('2PACX-1vQPBYq0ZQpaAnu0Mp_qN5oGvklgIpjolyRPf3LfSojRaN-GBBBXKHslR9ue1DOv1432oP2PzYznUUmn', 512034300), schedule: 'hourly' },
    { key: 'vendor_map', label: 'Vendor map', group: ADV, cache: 'CACHE_VENDORS', pages: ['capex_all.html', 'advance_onm.html', 'sheet_links.html'],
        src: pub(VENDOR_PUB, 1818971964), schedule: 'daily', primaryKey: ['VENDOR_NO'] },

    // ---- Substation & network
    { key: 'feeder_outage', label: 'Feeder outage', group: NET, cache: 'CACHE_FEEDER_OUTAGE', pages: ['feeder_outage.html', 'sheet_links.html'],
        src: pub('2PACX-1vTsRzMOPBm3foslF8BadPmN24KrV2kGZCAsX7GWrmIDm0uppSLmov0n51ZkKLMz2vJMIFpqYGJETm7R', 0), schedule: 'hourly' },
    { key: 'highway_crossings', label: 'Line–highway crossings', group: NET, pages: ['power_map/nh_sh_crossings.html'],
        src: pub('2PACX-1vQTy_LCddlFuzZx9ZyJQTLbqrQ8sb76DG4jyw8ys-s_w6LDxOYhnTTY49eddhqxb9RnTAbksh32y1bH', 870376934), schedule: 'hourly',
        notes: 'Its ID column repeats (245 rows on 2026-11-01), so rows are keyed by content.' },
    { key: 'prt_transformers', label: 'PRT / power transformers', group: NET, pages: ['prt-oil/index.html', 'sheet_links.html'],
        src: pub(PRT_PUB, 0), schedule: 'frequent', notes: 'The "ptrs" tab.' },
    { key: 'prt_oil_tests', label: 'PRT oil test records', group: NET, pages: ['prt-oil/index.html'],
        src: pub(PRT_PUB, 906452022), schedule: 'frequent', notes: 'The "testingrecords" tab.' },
    { key: 'power_map_taps', label: 'Power map tap points', group: NET, pages: ['power_map/map.html'],
        src: pub('2PACX-1vT8hYE6YBbfVQDJhgB3cIWqrrGrjMQAQ22mcmCJTOa995gCH-xBAfsAPpBvNYS1KlYIFMRHM59iGB7K', 2098159409), schedule: 'hourly',
        notes: 'Tap points drawn on the Power Map; the substations themselves are mirrored from Supabase.' },

    // ---- Important
    { key: 'cmo_grievances', label: 'CMO grievances', group: IMP, cache: 'CACHE_CMO', pages: ['cmo.html', 'sheet_links.html'],
        src: pub('2PACX-1vS7GVh5HflVhouhVfFOEN2RuA1kCBedmD4Q0CJP02K61DAtWuo3P8XIS8CO7ocZQuJ20uCJBa9qsgZ6', 1066071765), schedule: 'frequent' },
    { key: 'pmsgy_malda', label: 'PM Surya Ghar: Malda', group: IMP, cache: 'CACHE_PMSGY_MALDA', pages: ['pmsgy.html', 'sheet_links.html'],
        src: pub(PMSGY_PUB, 1969412059), schedule: 'daily' },
    { key: 'pmsgy_uttar_dinajpur', label: 'PM Surya Ghar: Uttar Dinajpur', group: IMP, cache: 'CACHE_PMSGY_UD', pages: ['pmsgy.html', 'sheet_links.html'],
        src: pub(PMSGY_PUB, 711223367), schedule: 'daily' },
    { key: 'pmsgy_dakshin_dinajpur', label: 'PM Surya Ghar: Dakshin Dinajpur', group: IMP, cache: 'CACHE_PMSGY_DD', pages: ['pmsgy.html', 'sheet_links.html'],
        src: pub(PMSGY_PUB, 40136871), schedule: 'daily' },
    { key: 'accident_reports', label: 'Accident reports', group: IMP, pages: ['accident/accident.html', 'sheet_links.html'],
        src: pub('2PACX-1vRrrGeyElvh8i8QzTl25Ej7_RJZ9FJ0jicG3tAhguLEvky178oKZ8-QADKcBceUQ5CFjn7hd9eECVJ6'), schedule: 'hourly' },
    // safety_inspection moved to vm/sync/sources/files.js (direct VM storage / sync)
    { key: 'manpower_staff', label: 'Manpower: staff', group: IMP, pages: ['manpower.html'],
        src: pub(MANPOWER_PUB, 2110628491), schedule: 'hourly', primaryKey: ['Employee No'], sensitive: true,
        extraUrls: [MANPOWER_PAGE_URL + '2110628491'],
        notes: 'Sensitive: staff IFSC Code, Bank Account No, PF A/C Number, PF Trust ID and pay. PocketBase only (portal sign-in), no snapshot.' },
    { key: 'manpower_pins', label: 'Manpower: page PINs', group: IMP, pages: ['manpower.html'],
        src: pub(MANPOWER_PUB, 2073511562), schedule: 'frequent', columnTypes: { pin: 'text' }, sensitive: true,
        urls: [MANPOWER_PAGE_URL + '2073511562'],
        notes: 'Sensitive: the PINs that unlock manpower.html (pin column). PocketBase only (portal sign-in), no snapshot.' },
    { key: 'substation_upkeeping', label: 'Substation upkeeping', group: IMP, pages: ['Upkeeping/index.html', 'sheet_links.html'],
        src: pub('2PACX-1vSHoWw-c-KCfsYrkQs67uWaKdag1WXVQobLkngEK-bvbky_LMF6RWg-BwgVYA-5f3RcR4u6rQA5XWhH', 422662764), schedule: 'frequent',
        notes: 'Form responses of the separate upkeeping app.' },
    { key: 'dtr_records', label: 'DTR records', group: IMP, pages: ['dtr/index.html', 'sheet_links.html'],
        src: pub(DTR_PUB, 2125422147), schedule: 'daily', primaryKey: ['DTR_CODE'] },
    { key: 'dtr_peak_load', label: 'DTR peak load measurements', group: IMP, pages: ['dtr/load.html', 'sheet_links.html'],
        src: pub(DTR_PUB, 1835924766), schedule: 'frequent' },
    { key: 'stock_materials', label: 'Stock materials (rates and categories)', group: IMP, cache: 'CACHE_STOCK_METADATA',
        pages: ['stock/index.html', 'sheet_links.html'],
        src: exportCsv('1wDvPuAxNfdO9QzUaIUubg2JnkFM5ZleFNXQdi8s5uh0', 696716331), schedule: 'hourly' },

    // Durga Puja reports (puja.html): Format-I, Format-II and hourly load, 2025 and 2026.
    ...[
        ['puja_format_1_2025', 'Puja Format-I 2025', exportCsv('1EGhWifLAYcnX6ZKVxPxtpxafdCrk_ueR67ObR9vDUM8', 0)],
        ['puja_format_1_2026', 'Puja Format-I 2026', pub('2PACX-1vT4MqI8y1hron59lymFqAcv-s1GUtZbQrTagrXfmNgsg16Pad1at-5BcLZTfcRP00d7k8SExO4FV21p')],
        ['puja_format_2_2025', 'Puja Format-II 2025', exportCsv('1Jh5-C7HXNoByxaGvzb8kBku1ov_HqwDS_wID-sS85Pk', 0)],
        ['puja_format_2_2026', 'Puja Format-II 2026', pub('2PACX-1vSe6UXoMQ0CIYX38GKifEdQqulDRgZgknQUOo2f1wm6AID9ezqSRzsR17SLIC3pjaMsnf0ISbEZQTYz')],
        ['puja_hourly_load_2025', 'Puja hourly load 2025', exportCsv('1lkQlOv4sWzSTIOKAkem-oJmEvA7RNTLT0w-tsKi-_kI', 0)],
        ['puja_hourly_load_2026', 'Puja hourly load 2026', exportCsv('1-9z4sry_mHbVg5jDFn5kkOHRtWqXwjqVD00ysOoxT3I', 1276887615)]
    ].map(([key, label, src]) => ({ key, label, group: IMP, pages: ['puja.html'], src, schedule: 'hourly', header: false, urls: [], notes: REPORT_NOTE })),

    // Important data sheets (important_sheets.html): the page links these and shows a few cells.
    // The month list there is editable (Supabase important_unbilled_months); these are its built-in months.
    ...[
        ['important_unbilled_jan_2026', 'Unbilled report Jan-2026', '1ujR9e1olZKeu1uIgzSsIl2XXK-fN6YWI-1Z_E6xyOTs', 979760067],
        ['important_unbilled_feb_2026', 'Unbilled report Feb-2026', '1cYIV5Uk5Wa0CPkFMPFdeIUwJ3262o6tNJTbxTe7Lelk', 827560931],
        ['important_unbilled_mar_2026', 'Unbilled report Mar-2026', '1iRAE1fXfCbkb7mtRIjYIGYdbMLUga-bmhlHgKm1ZorE', 0, true],
        ['important_unbilled_apr_2026', 'Unbilled report Apr-2026', '1u3x_XJ_re_MJvkDbGmcE4iwweRk5xe89Qib2p9JxAGc', 801371725],
        ['important_unbilled_may_2026', 'Unbilled report May-2026', '1c9I7Ng3OCqMik4jyRqO7WZn6ysdVXAFsm93va1Z1PFk', 0, true],
        ['important_unbilled_jun_2026', 'Unbilled report Jun-2026', '1rgHVfi2Z-8lKPCBl6byXCHfJ_QVCbQcB-7awggyDa1M', 0, true],
        ['important_unbilled_jul_2026', 'Unbilled report Jul-2026', '1Pw1mSp8x7b5DxgjQMu8WfVfX2dY0UkF836p4YXva1ko', 1573581583],
        ['important_unbilled_aug_2026', 'Unbilled report Aug-2026', '1SazJY-ohGvhTji5zN-mfrCTbaEUvfvGGKh6XWlRn76s', 903839015],
        ['important_unbilled_3_months', '3 months unbilled', '1g_YAYXocaaEDh42WpgT5jqzEwWMgwtvfrXP2J3Jh8lw', 0, true],
        ['important_first_bill_pending', '1st bill not generated', '1gPNCdyhoGNZy5i6FFp2HBIHs4-4FelNWGWThmC8PeQE', 0, true],
        ['important_smart_metering', 'Smart metering', '1-stbDqVWjFfeftqpe20zQOw2NFKj6595ptBLrCG-__s', 1066479111, true],
        ['important_smart_meter_non_push', 'Smart meter: non-push cases', '18z-dWyTbw9jsrJtQ67UUL2TbT-QUgi_Q', 183159560, true],
        ['important_rem_less_unit_billed', 'REM less unit billed', '1It8j3Ic8mjoVf7ejljj1VrN7LEEnqg-9A8n7BY3UrQM', 0, true],
        ['important_rem_osd_followup', 'REM OSD follow-up', '1kB6g0zxWqR7sX6KiJaHG1pn0Fq_CWFAjyLzDNyOvpDY', 0, true],
        ['important_rem_atr_summary', 'REM ATR summary', '1VGwEKCN5zQogt7EiPZ2potuSpPBBjZfFqm4FtutWxOk', 596686415, true],
        ['important_rem_stw_osd', 'REM STW OSD', '1hehnzupXA_4MFvaFf4blhwqb9gRbQS1YORB6IuGOfTg', 1783257436],
        ['important_rem_osd_age', 'REM OSD age analysis', '1t_N9fTRVbRaKPejMW5TfhMiRmBMmwL5kWrItzWnR3OM', 1275155087]
    ].map(([key, label, id, gid, noExport]) => ({
        key, label, group: IMP, pages: ['important_sheets.html'],
        src: noExport ? gviz(id, { gid, headers: 0 }) : exportCsv(id, gid),
        // Export snapshots keep every cell in place, so important_sheets.html can read its cells from the
        // mirror by position; gviz ones drop blank rows and odd-typed cells, so they are not offered.
        schedule: 'daily', header: false,
        urls: noExport ? [] : [`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`],
        notes: REPORT_NOTE + (noExport ? GVIZ_NOTE : '')
    }))
];

// ---- Adapter ---------------------------------------------------------------------------

/** A sheet that is not shared publicly answers with a sign-in or error page instead of CSV. */
async function openCsv(ctx, url) {
    const res = await ctx.fetch(url, { headers: { Accept: 'text/csv, text/tab-separated-values, text/plain' } });
    const ct = String(res.headers.get('content-type') || '');
    if ([401, 403, 404].includes(res.status) || (res.ok && /text\/html/i.test(ct))) {
        try { await res.body?.cancel(); } catch (_) { /* ignore */ }
        throw new SkipError(`not publicly readable (Google answered HTTP ${res.status} ${ct.split(';')[0] || 'no content type'})`);
    }
    if (!res.ok) {
        try { await res.body?.cancel(); } catch (_) { /* ignore */ }
        throw new Error(`Google answered HTTP ${res.status}`);
    }
    return res;
}

/** NSC / Withheld: the TODAY report date in the peeked first row, as ISO (UTC midnight), or null. */
function reportDateFromPeek(text) {
    try {
        const [header, row] = parseSync(text, { bom: true, relax_column_count: true, relax_quotes: true });
        const i = (header || []).findIndex((h) => String(h).trim().toUpperCase() === 'TODAY');
        const d = i >= 0 && row ? parseDate(String(row[i] || '').trim()) : null;
        return d && d.dmy !== null ? new Date(d.dmy).toISOString() : null;
    } catch (_) {
        return null;
    }
}

function sheetSource(def) {
    const tsv = def.src.format === 'tsv';
    let reportDate = null; // set by version() for NSC / Withheld
    const src = {
        key: def.key,
        label: def.label,
        group: def.group,
        pages: def.pages || [],
        sourceType: 'google_sheet',
        sourceRef: Object.assign({}, def.src.ref, def.cache ? { cacheKey: def.cache } : {}),
        sourceUrl: def.src.human,
        schedule: def.schedule,
        primaryKey: def.primaryKey || null,
        columnTypes: def.columnTypes,
        dateOrder: def.dateOrder,
        header: def.header === false ? false : undefined, // no header row: columns col_a, col_b, … (lib/uniform.js header: false)
        notes: def.notes || '',
        timeoutMs: def.timeoutMs,
        maxSkipHours: def.maxSkipHours,
        dataHubKeys: def.cache ? [def.cache] : [],
        urls: def.urls || [def.src.url, ...(def.extraUrls || [])],
        sensitive: !!def.sensitive,
        rawExt: tsv ? 'tsv' : 'csv',
        async raw(ctx) {
            const res = await openCsv(ctx, def.src.url);
            // Google sends no Last-Modified for these URLs today; use it if that ever changes.
            const lm = Date.parse(res.headers.get('last-modified') || '');
            return {
                contentType: res.headers.get('content-type') || (tsv ? 'text/tab-separated-values' : 'text/csv'),
                stream: res.body,
                modifiedAt: Number.isFinite(lm) ? new Date(lm).toISOString() : reportDate
            };
        },
        async *rows(ctx) {
            // ctx.input: the bytes raw() fetched (the framework tees them into the snapshot).
            const input = ctx.input || Readable.fromWeb((await openCsv(ctx, def.src.url)).body);
            const parser = parse({
                delimiter: tsv ? '\t' : ',',
                quote: tsv ? false : '"', // Google's TSV output never quotes
                relax_quotes: true,
                relax_column_count: true,
                bom: true,
                skip_empty_lines: false
            });
            pipeline(input, parser, () => { /* errors surface through the iterator */ });
            if (def.header === false) yield []; // no header row: columns are named by letter
            for await (const record of parser) yield record;
        }
    };
    if (def.peek) {
        src.version = async (ctx) => {
            const res = await openCsv(ctx, def.peek);
            const text = await res.text();
            reportDate = reportDateFromPeek(text);
            if (!text.trim()) return null;
            // The row count as well: a partial upload that keeps the header and the first row changes it.
            // If the count cannot be read the version changes, so the sheet is read in full (the safe side).
            let count = '';
            if (def.peekCount) {
                try {
                    count = (await (await openCsv(ctx, def.peekCount)).text()).trim();
                } catch (err) {
                    if (err instanceof SkipError) throw err;
                    count = 'unknown ' + Date.now();
                }
            }
            return 'peek:' + sha1(count ? text + '\n' + count : text);
        };
    }
    return src;
}

async function sources() {
    return SHEETS.map(sheetSource);
}

module.exports = { sources, SHEETS };
