# Uniform data: page inventory and conversion batches

What every page in the `app.html` NAV read before the conversion to uniform rows ([uniform-data.md](uniform-data.md)), how the pages were split into batches, and where each one stands. Read from the code on 2026-11-01 (develop at 1be5719); the page sections describe the code before conversion, and each starts with its status. **Status:** every page with sheet data is converted (prototype, batches A–E, the final step), except prt-oil (later) and the pages listed under [Not converted](#not-converted).

Complexity: **S** one dataset, straight mapping · **M** several datasets, or custom office/date logic, or drill + deep links · **L** a very large legacy page, many datasets, writes, maps or bespoke parsing. Points for balancing: S = 1, M = 2, L = 4.

## Summary

| Page (NAV key) | Datasets (mirror keys) | Loader before conversion | Cx | Status · batch · commit |
|---|---|---|---|---|
| nsc.html (nsc) | nsc_pending (+ follow-ups via Apps Script) | UI.load | L | converted · prototype · 6a73dc0 |
| historical_nsc.html | historical_nsc | direct fetch, no cache | M | converted · C · 9b72052 |
| nsc/kpi.html | nsc_pending | UI.load | S | converted · A · 552486b |
| weekly.html | weekly_report | UI.load | M | converted · A · 74ffd8b |
| pending_mc.html | pending_mc | UI.load | M | converted · A · 0c9158d |
| withheld.html | withheld | UI.load | M | converted · A · b252e40 |
| pending_load_extension.html | load_extension | UI.load | M | converted · A · a9e3efb |
| solar.html | solar_connections | UI.load | M | converted · prototype · 991110f |
| jjm.html (jjm, jjm_report) | jjm_connections | UI.load | M | converted · A · d7af4ac |
| meter_utilization.html | meter_erp, meter_master, meter_crm, meter_isu | waitForDataset ×4 + parsed bundle | L | converted · C · 8b376c9 |
| wridd.html | wridd_schemes | UI.load | M | converted · A · c4d32df |
| bharatnet.html | bharatnet_connections | UI.load | M | converted · A · bc1aa65 |
| icds.html | icds_a_plus, icds_a | UI.load ×2 | M | converted · A · 3288031 |
| loss.html | loss_report, loss_targets | waitForDataset (forceCheck) | M | converted · B · c058c54 |
| performance_index.html | loss_report, nsc_pending, pending_mc | waitForDataset ×3 | M | converted · rating rebuild · 615a25f, eef4db3 |
| collection.html | collection_report | UI.load | M | converted · B · 036a7c3 |
| disconnection.html | disconnection (+ follow-ups via Apps Script) | UI.load + fallback chain | L | converted · B · 03e6ef9 |
| theft_assessment.html | theft_assessment | UI.load | M | converted · B · 5afc0e5 |
| remosd5000.html | rem_osd | UI.load | M | converted · B · 1b31754 |
| rem/defaulters.html | rem_defaulters_dom, _agri, _ind_com (TSV) | UI.load ×3 | M | converted · B · 4437f5b |
| dd/upcomingDD.html | upcoming_dd | direct fetch (gviz) | S | converted · C · 00a39a6, c557c2d (no-store MzoRows.build) |
| dd/dd_visit.html | dd_visit (+ visit records via Apps Script) | UI.load | M | converted · C · 135a7cf, db374ab (no-store MzoRows.build) |
| consumer/defective_meter.html | defective_summary, defective_details | UI.load + lazy details | L | converted · D · c59ccfb |
| consumer/consumer.html | consumers | direct fetch | S | converted · C · cd070d5 |
| docket.html | docket_calls | UI.load | S | converted · C · 8fadb73 |
| docket/kpi.html | docket_kpi | direct fetch | S | converted · C · e2f32b1 |
| smart_meter/dashboard.html | smart_meter_status, smart_meter_work_orders (TSV) | direct fetch ×2, own cache | M | converted · C · 0175f68 |
| capex_all.html | capex_details, vendor_map, costcenter | UI.load + hub.get ×2 | M | converted · D · e5b04cc |
| advance_onm.html | onm_advance, vendor_map, costcenter | direct fetch + hub.get ×2 | M | converted · D · 5818883 |
| power_map/map.html | power_map_substations (CSV from /api/power-map/data), power_map_taps, pending corrections | DataHub + fetch, Papa | L | converted · E · c49254c |
| power_map/nh_sh_crossings.html | highway_crossings | direct fetch, Papa | M | converted · E · 081de67 |
| prt-oil/index.html | prt_transformers, prt_oil_tests, "Map" tab via Apps Script | fetch + Apps Script, Papa | L | not converted (later) |
| feeder_outage.html | feeder_outage | _peek + waitForDataset (forceCheck) | M | converted · D · 358246b |
| cmo.html | cmo_grievances | UI.load | S | converted · D · cc61edf |
| pmsgy.html | pmsgy_malda, pmsgy_uttar_dinajpur, pmsgy_dakshin_dinajpur | waitForDataset ×3 | M | converted · D · b2e8ec5 |
| si-works/si.html | si_works (Supabase prioritySI, read and write) | supabase-js | L | not converted |
| accident/accident.html | accident_reports | direct fetch, own parser | M | converted · E · 8967cde |
| safety_inspection.html | safety_inspection | UI.load | S | converted · D · 971ff37 |
| manpower.html | manpower_pins, manpower_staff (sensitive) | direct fetch | M | not converted |
| Upkeeping/index.html | none (link to an external app) | — | S | not converted |
| dtr/index.html | dtr_records | direct fetch, own parser | M | converted · E · 36710dd |
| dtr/load.html | dtr_peak_load (+ DTR master via Apps Script) | direct fetch ×3, own parser | M | converted · E · 6b9f07b |
| health_checkup.html | none (placeholder) | — | S | not converted |
| puja.html | none (embedded sheets) | — | S | not converted |
| stock/index.html | stock_snapshot, stock_materials, stock_allotments | DataHub + Papa, 6 JS files | L | converted · E · 3688550 |
| important_sheets.html | single cells of the important_* sheets, important_unbilled_months | cell fetches + server JSON | S | fixed, not converted · D · 4cac325 |
| sheet_links.html | as-on rules of ~15 datasets | DataHub registry + own parser | M | converted · final · cd102ec |
| media_news.html | none (server RSS JSON) | — | S | not converted |
| executive_briefing.html (home) | none in the page (server JSON from meta stats) | /api/executive/briefing | S | not converted (server) |
| assistant.html (ask) | nsc_pending, load_extension, solar_connections, loss_report, loss_targets | DataHub `_peek`/`waitForDataset` | M | converted · final · 11e4a93 |
| admin_users.html (6 tabs) | power_map_substations (one column) | Papa on /api/power-map/data | S | not converted |
| admin.html | data/structure.csv via /api/structures, portal users | server JSON | S | not converted |

52 distinct pages (59 NAV entries: performance index and JJM are listed twice, Users/Sources/Activity/… are six tabs of admin_users.html). Converted: 41 (the 2 prototype pages, 36 in batches A–E, performance_index through the rating rebuild, the 2 of the final step). Not converted: 10, plus prt-oil later.

### Not converted

| Page | Why |
|---|---|
| prt-oil/index.html | later: its "Map" tab is only reachable through Apps Script, so it cannot be mirrored; prt_transformers / prt_oil_tests can be converted when the page is |
| si-works/si.html | typed Supabase JSON (prioritySI) with writes and a permission model on raw strings; uniform rows would add only aliases. `schema/si_works.json` exists for the rating metrics only |
| manpower.html | sensitive (staff data, PINs): never mirrored |
| Upkeeping/index.html | no data (a link to an external app) |
| health_checkup.html | no data (placeholder) |
| puja.html | no tabular data (embedded sheets) |
| media_news.html | no sheet data (server RSS JSON) |
| executive_briefing.html | server JSON built from meta stats (`/api/executive/briefing`): a server-side job of its own, not a page conversion |
| admin_users.html (6 tabs) | admin pages; one column of the Power Map CSV |
| admin.html | admin page; server-parsed structure CSV and portal users |
| important_sheets.html | single cells, not rows; its cell reads were fixed in batch D (`4cac325`) |

## Batch plan (5 parallel conversions)

| Batch | Pages | Points | Datasets it owns (creates `schema/<key>.json`) |
|---|---|---|---|
| **A** NSC & connections | nsc/kpi, withheld, pending_load_extension, pending_mc, weekly, jjm, wridd, bharatnet, icds | 17 | withheld, load_extension, pending_mc, weekly_report, jjm_connections, wridd_schemes, bharatnet_connections, icds_a_plus, icds_a (+ adds `delayinqtn` to nsc_pending) |
| **B** Revenue | loss, performance_index, collection, disconnection, theft_assessment, remosd5000, rem/defaulters | 16 | loss_report, loss_targets, collection_report, disconnection, theft_assessment, rem_osd, rem_defaulters_dom, rem_defaulters_agri, rem_defaulters_ind_com |
| **C** Meters, consumers & DD | meter_utilization, consumer, docket, docket/kpi, smart_meter, dd/upcomingDD, dd/dd_visit, historical_nsc | 14 | meter_erp, meter_master, meter_crm, meter_isu, consumers, docket_calls, docket_kpi, smart_meter_status, smart_meter_work_orders, upcoming_dd, dd_visit, historical_nsc |
| **D** Offices-heavy & important | capex_all, advance_onm, feeder_outage, cmo, pmsgy, safety_inspection, defective_meter | 14 | capex_details, onm_advance, vendor_map, costcenter, feeder_outage, cmo_grievances, pmsgy_malda, pmsgy_uttar_dinajpur, pmsgy_dakshin_dinajpur, safety_inspection, defective_summary, defective_details |
| **E** Legacy pages | accident, dtr/index, dtr/load, nh_sh_crossings, stock, power_map | 16 | accident_reports, dtr_records, dtr_peak_load, highway_crossings, stock_snapshot, stock_materials, power_map_substations, power_map_taps |
| final (one person, after A–E) | assistant.html, sheet_links.html (+ dd_visit no-store, DTR drill, map pages on phones) | 4 | none (reads others' schemas; needed no new fields) |
| later | prt-oil/index.html | 4 | prt_transformers, prt_oil_tests (its Map tab is only reachable through Apps Script, so it cannot be mirrored) |

Parity entries ([uniform-data.md](uniform-data.md#parity-method)): the prototype pages and batches A–D are in `scripts/qa/uniform-rowparity/<batch>.js` and `scripts/qa/uniform-pages/<batch>.js` (`prototype`, `a-connections`, `b-revenue`, `c-meters`, `d-offices`), run by the one `uniform-rowparity.js` and `uniform-pages.js`. Batch E's pages are off the UI kit and have their own tools (`legacy-rowparity.js`, `legacy-pages.js`), as do the final step's (`sheet-links-rowparity.js`, `sheet-links-pages.js`, `assistant-rowparity.js`).

Rules that keep the batches independent:

- **Code shared between pages stays in one batch.** capex_all and advance_onm share a copied code block (`num`, `unitName`, `regionOf`, `maps()`): D. dd/upcomingDD and dd/dd_visit are copies of each other: C. bharatnet and icds share `asOnOf()` and the scope fallback: A. loss and performance_index share the office alias maps: B. The stock page's six JS files (one, `stock/stock_material_category.js`, is also loaded by `stock/upload.html`): E only.
- **Nobody edits the shared helpers** (`mzo_ui.js`, `mzo_scope.js`, `mzo_data_hub.js`, `lib/uniform.js`, `lib/offices.js`, `mzo_rows.js`). A batch that needs a change there asks the lead; an office alias goes to dq-offices (`lib/offices.js`).
- **One owner per schema file.** A dataset read by pages in two batches is owned by the batch listed above; the other batch adds the fields it needs to that file in a separate small commit (field lists are additive, so a merge is a union). Cross-batch datasets: nsc_pending (prototype, A, B, final), pending_mc (A owns, B adds), loss_report and loss_targets (B owns, final adds), load_extension (A owns, final adds), solar_connections (prototype, final adds), vendor_map and costcenter (D only).
- **assistant.html and sheet_links.html go last.** Their adapters copy logic from nsc, pending_load_extension, solar and loss, and sheet_links repeats the as-on rule of about 15 pages; converting them after those pages lets them reuse the same fields. sheet_links' as-on dates should then come from each dataset's uniform `t.first(…)` value, or better from one `as_on` field per dataset (open question in uniform-data.md).
- Not converted, with the reason: si-works (typed Supabase JSON with writes and a permission model on raw strings: uniform rows would add only aliases), manpower (sensitive: never mirrored), puja / Upkeeping / health_checkup (no data), media_news (server RSS), executive_briefing (server JSON built from meta stats: a server-side job of its own), admin_users (one column of the Power Map CSV), admin.html (server-parsed structure CSV), important_sheets (single cells, and its cell fetches read the wrong tab: fix that first).

## Cross-cutting findings (for the lead)

These came out of reading every page; none was fixed in this inventory. Where each stands on 2026-11-01 is in the **Now** note under it.

1. **Scope leak.** `jjm.html`, `bharatnet.html` and `icds.html` do `if (scoped.length || !all.length) all = scoped;`: when the login scope removes every row, the page shows **all** rows to that user. Converting them to `MzoRows.load` (scoped by default) removes the fallback; fix it in the conversion and say so in the commit.
   - **Now:** fixed. All three pages are scoped by `MzoRows` (batch A: `d7af4ac`, `bc1aa65`, `3288031`); the fallback is gone.
2. **Pages with no scope at all:** power_map/map.html, power_map/nh_sh_crossings.html, prt-oil/index.html and cmo.html do not load `mzo_scope.js`. The executive briefing applies no office scope either, and assistant.html does not scope loss rows.
   - **Now:** Ask's loss answers follow the login scope as loss.html does (`11e4a93`). power_map, nh_sh_crossings, cmo (and the other batch E pages) still show every office to every login, as before: the lead's open decision for the user (CMO rows name only a district). prt-oil is not converted. The briefing is server-built and still unscoped.
3. **One value, several rules.** The NSC "over a year" bucket is `AGE_MONTHS > 12` in the sync scripts but `>= 12` in pending_load_extension and assistant; the briefing's division hotspots show the total instead of the item's own measure. Uniform rows give one source for these values; the rules themselves still have to be agreed.
   - **Now:** open. Ask and pending_load_extension count over a year as `age >= 12` (574 applications on 2026-11-01), the load extension meta and the briefing as `> 12` (569). Ask's NSC "over 30 days" (`DelayInSC > 30`) and nsc.html's `?kpi=delay30` (DelayRange "More than 1 month") give the same count today (3,482) but are different rules.
4. **Single-cell values outside the scope.** Report dates that live in one row of a sheet (solar's `Report Date`, bharatnet N2, loss J2, ICDS M2, Disconnection base dates) disappear for a scoped user if a page reads them from scoped rows. The prototype hit this: use `t.first(field)` / `t.all` (see the recipe).
   - **Now:** fixed on every converted page: single cells are read with `t.first()` / `t.all` (the row parity tools compare the header text for every login), and sheet_links reads them the same way (`cd102ec`).
5. **important_sheets.html** reads single cells with `export?format=csv&range=D57` and no `gid`, so it reads the first tab, not the configured month tab; one sheet id is 33 characters long and looks truncated.
   - **Now:** fixed in batch D (`4cac325`): each cell is read from its configured tab (gviz with the tab's gid); the 33-character id is valid.
6. **sheet_links.html** picks the CMO date by plain text comparison (wrong across months for dd/mm/yyyy) and its dates depend on which request finishes first.
   - **Now:** fixed (`cd102ec`): the CMO date is read as a date (cmo.html's rule), and each row shows the best date it has in a fixed order (the data's as-on date first), whatever order the requests finish in. Its PM Surya Ghar parser also read only 3-letter months; uniform rows read full month names.
7. **Duplicate headers.** solar_connections has `APPL_NO` three times and weekly_report `Division` twice. `UI.csv` keeps the last copy under the plain name; uniform rows name them `appl_no`, `appl_no_2`, `appl_no_3` (first copy first). A page that read the plain name must pick the right one (weekly: check which `Division` column it meant).
   - **Now:** handled: uniform rows keep every copy (`appl_no`, `appl_no_2`, …) and weekly reads `division_2`, the column it read before (`74ffd8b`).
8. **Dates that stay numbers.** `yyyymmdd` (disconnection `PAID DATE`, rem/defaulters, DD pages) and `yyyymm` (feeder_outage `REPORT MONTH`) are not dates to the inference (the mirror does the same); pages keep converting them. A schema `format` hint is an open question.
   - **Now:** unchanged: pages still convert `yyyymmdd` / `yyyymm` themselves (a schema `format` hint is still an open question in uniform-data.md).

## Pages

Per page: what it loads, the raw columns it reads, number/date/office handling, filters and aggregations, deep links, writes, quirks, complexity and the uniform field names it would use (snake_case of the headers it reads, plus the office fields when it maps offices). Grouped as in the sidebar.


## New service connection

### nsc.html  (NAV key: nsc; retired hashes nsc_simple|nsc_pipeline|nsc_classic redirect here)
- **Status (2026-11-01):** converted in `6a73dc0` (prototype).
- **Kind:** kit (665 lines) · **Loads:** /mzo_presets_hub.js?v=88 (auth bootstrap; injects auth.js + /mzo_app_update.js)
- **Datasets:**
  - `nsc_pending` via UI.load CACHE_NSC_v5 (hub URL `/api/nsc/dataset` → 302 to the Google Sheet CSV; also `UI.refresh('refreshBtn', KEY)` and `mzoDataHub.refresh(KEY)`+`_peek` in "Load latest").
  - `nsc_followups` via Apps Script GET `<sheetScriptUrl>?list=1&t=` (JSON `{status, comments:[{id, applNo|appl_no, at, by, note}], deletedIds}`). The URL comes from `/api/nsc/followup-meta` (`sheetScriptUrl`).
  - Server JSON `/api/nsc/meta` (`canUpload`, `version`, `meta.reportDate`, `meta.stats.today`).
- **Parser:** UI.csv (main dump). Follow-ups: text → custom `parseJson` (slices from the first `{` to the last `}`, then JSON.parse).
- **Raw columns read:** `APPL_NO`, `TODAY`, `CCC_CODE`, `SUPP_OFF`, `REGION`, `REG`, `DIVN_NAME`, `NO_OF_POLES`, `PoleNonPole`, `COLL_DATE`, `DelayInSC`, `DelayRange`, `DelaySerial`, `CONN_CLASS`, `APPLIED_PHASE`, `SCN_WITHELD_DATE`, `WO_ISSUED`, `AGENCY_NAME`, `APPLICANT_TYPE`, `CON_ID` (search), `NAME` (search), `PHONE_NO` (search), `ADDRESS` (d), `LOAD_WATTS` (d), `CONN_CAT` (d), `WON` (d), `WO_CREATION_DATE` (d), `METER_NUMBER` (d), `SCN_WITHELD_REASON` (d), `IS_PORTAL_APPL` (d), `INSPECTION_COMMENT` (d), `SCN_STATUS` (d)
- **Numbers:**
  - `NO_OF_POLES` parseInt(,10)||0; `LOAD_WATTS` parseFloat||0 (watts).
  - `DelayInSC` parseFloat, NaN allowed. When NaN, delay = round((TODAY − COLL_DATE)/864e5), clamped ≥0, else null.
  - `DelaySerial` parseInt||0.
- **Dates:**
  - `TODAY`: UI.date; the as-on value is taken from the **first** row in file order with a parseable TODAY, read before dedupe.
  - `COLL_DATE` and `WO_CREATION_DATE` via UI.date (default d/m order: dd-mm-yyyy, dd.mm.yyyy, dd/mm/yyyy, or ISO).
  - Server `meta.reportDate`/`meta.stats.today` and BroadcastChannel `reportDate` go through a custom `dmy()` (ISO → dd/mm/yyyy, d/m/yyyy → padded) only to compare with the as-on date.
  - `SCN_WITHELD_DATE` is **not** parsed. It is a flag: non-empty and ≠ `'0'`.
- **Offices:**
  - `o = UI.office(d.CCC_CODE, d.SUPP_OFF)`.
  - `_region = o.region || MzoScope.regionNameOf(d.REGION || d.REG)`.
  - `_divn = o.division || MzoScope.divisionNameOf(d.DIVN_NAME) || raw DIVN_NAME`.
  - `_supp = o.ccc || MzoScope.cccNameOf(d.SUPP_OFF) || raw SUPP_OFF`.
  - `CCC_CODE` trimmed and kept.
  - `MzoScope.filterRows(rows)` runs on the built rows. Groups with an empty value show as "Unmapped". `UI.offices(all)` + `UI.lockScope()`.
- **Row filters / dedupe / positional:** skips rows with empty trimmed `APPL_NO`. Dedupe is one row per trimmed `APPL_NO` (case-sensitive); the last row wins (Map keeps the first position but stores the last value).
- **Aggregations:**
  - KPI cards (on the filtered rows):
    - Total pending (sub: median delay via UI.age)
    - Non-pole
    - Pole (sub: Σ `NO_OF_POLES`)
    - From withheld (flag above)
    - Industrial (cls `I`)
    - Proc-B (`APPLICANT_TYPE === 'Promoter/ Developer'`)
    - Com. 3-phase (cls `C` and phase `III`)
  - Custom tabs (not UI.drill): region→division→ccc (row click sets the select and moves to the next tab), consumer, delay (DelayRange ordered by DelaySerial), delay2 (cumulative buckets on DelaySerial 1–8), pole, class, phase, agency, wo, followups.
  - Facets: agri, pole, wo, delay, delay2.
  - Selects: region/division/ccc/class (`CONN_CLASS`)/agency.
  - Copy table and export CSV.
- **Deep links:**
  - `?region=` `?division=` `?ccc=`: case-insensitive exact match on an option value, no alias handling.
  - `?q=` (switches to the consumer tab).
  - `?kpi=` by regex: `30|delay` → delay2 "More than 1 month"; `withheld|rescued`; `non` → nonpole; `pole`; `ind`; `proc`; `com`.
  - `?followups=1`.
- **Writes:**
  - Follow-ups POST to `sheetScriptUrl` (Apps Script nsc_working), form body `data=<JSON {action:'add'|'delete', id, applNo, at, by, note}>`, through a localStorage outbox.
  - localStorage keys: `mzo_nsc_followups`, `mzo_nsc_followup_outbox`, `mzo_nsc_seen_version`, `mzo_nsc_pending_refresh`.
  - Listens on BroadcastChannel `mzo-nsc` (`nsc-uploaded`).
  - Polls every 15 s (follow-ups) and every 90 s (meta).
- **Quirks:**
  - The local `blank()` treats only empty and `(null)` as blank. It does not treat `-` or `NA` as blank (unlike UI.blank).
  - `CONN_CAT` `U`/`R`; `WO_ISSUED` `'Y'`; `IS_PORTAL_APPL` uppercased == `'Y'`; phase `'III'`.
  - Pole = `NO_OF_POLES>0` OR `PoleNonPole` matches `/^pole/i`.
  - `APPLICANT_TYPE` must equal `'Promoter/ Developer'` exactly (note the space).
  - Class codes include the 2-letter `GS`.
  - Delay prefers the sheet value and falls back to the computed value.
  - The header spelling `SCN_WITHELD_*` (sic) must be kept.
- **Complexity:** L: large page; dedupe, office fallbacks, delay derivation, many tabs/deep links, Apps Script follow-up sync with outbox/polling, upload-version notice.
- **Uniform fields it would use:** appl_no, today, ccc_code, supp_off, region, reg, divn_name, no_of_poles, polenonpole, coll_date, delayinsc, delayrange, delayserial, conn_class, applied_phase, scn_witheld_date, wo_issued, agency_name, applicant_type, con_id, name, phone_no, address, load_watts, conn_cat, won, wo_creation_date, meter_number, scn_witheld_reason, is_portal_appl, inspection_comment, scn_status, _region, _division, _ccc_code, _ccc (follow-ups JSON stays as is)
- **Shared with:**
  - No helper file.
  - Shares the `nsc_pending` parse/dedupe logic with nsc/kpi.html (the two differ; see kpi).
  - CACHE_NSC_v5 is also read by performance_index.html and assistant.html, referenced by admin_users.html and sheet_links.html, and written by nsc/upload.html.

### historical_nsc.html  (NAV key: historical_nsc)
- **Status (2026-11-01):** converted in `9b72052` (batch C).
- **Kind:** kit (289 lines) · **Loads:** none (kit only). It does **not** load mzo_data_hub.js or auth/presets.
- **Datasets:** `historical_nsc` via direct fetch `https://docs.google.com/spreadsheets/d/e/2PACX-1vT1VYUaMC92oZPb3f452Q2b5WJf3Zhm02JdVq2Hsykt-_ipAcIIYaFdgYm4qZdZ8heGcrDon5eQA7nk/pub?gid=2021450441&single=true&output=csv` (refresh uses `{cache:'no-store'}`; no IndexedDB cache).
- **Parser:** UI.csv
- **Raw columns read:** `CCC CODE` || `CCC_CODE`, `METER_INSTALL_DATE`, `D`, `C`, `I`, `A`, `O` (per-row connection counts by class)
- **Numbers:** `D` `C` `I` `A` `O` via Number(x)||0.
- **Dates:** `METER_INSTALL_DATE` via custom `mdy()`: regex `^(\d{1,2})\/(\d{1,2})\/(\d{2,4})` read as **M/D/YY(YY)** (month first; 2-digit year +2000). Anything else falls back to UI.date (d/m order or ISO). Period keys are week (Monday start), month, quarter and year. The header shows the min–max date range. There is no as-on cell.
- **Offices:**
  - code = digits of `CCC CODE`/`CCC_CODE`, `.slice(-7)`; `o = UI.office(code)` (no name).
  - `_region = o.region`, `_divn = o.division`, `_supp = o.ccc || code` (an unmapped CCC shows the raw code).
  - `MzoScope.filterRows(all)`; `UI.offices` + `UI.lockScope`.
  - The starting level depends on scope: division/ccc → ccc tab, region → division tab.
- **Row filters / dedupe / positional:** drops rows with no code or no parseable date. No dedupe (rows are already aggregates).
- **Aggregations:**
  - Stat cards: total, D, C, I, A. Each sub-line shows per-period average and share; clicking a card filters to that class.
  - Bar chart per period.
  - Office table (region/division/ccc tabs, row click drills): total, per-period average, per-year.
  - Period table plus CSV export.
  - Year filter.
- **Deep links:** none
- **Writes:** none
- **Quirks:** this is the only page in the set that reads dates month-first. Codes are reduced to the last 7 digits.
- **Complexity:** M: direct sheet with M/D/YY dates and period bucketing.
- **Uniform fields it would use:** ccc_code, meter_install_date, d, c, i, a, o, _region, _division, _ccc_code, _ccc
- **Shared with:** none (copy of block (a))

### nsc/kpi.html  (NAV key: nsc_kpi)
- **Status (2026-11-01):** converted in `552486b` (batch A).
- **Kind:** kit (129 lines) · **Loads:** none (kit only)
- **Datasets:** `nsc_pending` via UI.load CACHE_NSC_v5
- **Parser:** UI.csv
- **Raw columns read:** `APPL_NO`, `TODAY`, `CCC_CODE`, `SUPP_OFF`, `REGION`, `DIVN_NAME`, `CONN_CLASS`, `DelayInQtn`, `DelayInWO`, `DelayInSC`
- **Numbers:** `DelayInQtn`, `DelayInWO` and `DelayInSC` via parseInt(,10)||0. A blank delay counts as 0 and pulls averages down.
- **Dates:** `TODAY` via UI.date. Shows the **max** over rows as "Updated …".
- **Offices:**
  - `o = UI.office(d.CCC_CODE, d.SUPP_OFF)`.
  - `region = o.region || UI.regionName(d.REGION)`.
  - `division = o.division || UI.title(DIVN_NAME minus /\s*div(ision)?\.?$/i)`.
  - `ccc = o.ccc || UI.title(d.SUPP_OFF || d.CCC_CODE)`.
  - Field names have **no underscore**. The raw `REGION`, `DIVN_NAME`, `SUPP_OFF` and `CCC_CODE` are copied onto the row, and `MzoScope.filterRows(all)` matches on those raw fields first.
  - No office selects. Level tabs are hidden for scoped users.
- **Row filters / dedupe / positional:** dedupe by `APPL_NO` trimmed **and lowercased**, last wins. This differs from nsc.html, which is case-sensitive.
- **Aggregations:**
  - Stat cards: average quotation/WO/connection delay; a card sets the sort metric.
  - Office table by region/division/ccc: count, average of each delay, rank.
  - Class filter on `CONN_CLASS`.
- **Deep links:** none
- **Writes:** none
- **Quirks:** dedupe case-folding differs from nsc.html. Delays are integers (parseInt) here but parseFloat in nsc.html.
- **Complexity:** S: one dataset, straight mapping; the office fallbacks disappear with uniform fields.
- **Uniform fields it would use:** appl_no, today, ccc_code, supp_off, region, divn_name, conn_class, delayinqtn, delayinwo, delayinsc, _region, _division, _ccc_code, _ccc
- **Shared with:** no helper file. Same dataset/dedupe as nsc.html; the two should move to `nsc_pending` uniform rows together.

### weekly.html  (NAV key: weekly)
- **Status (2026-11-01):** converted in `74ffd8b` (batch A).
- **Kind:** kit (305 lines) · **Loads:** none (kit only)
- **Datasets:** `weekly_report` via UI.load CACHE_WEEKLY (+ UI.refresh)
- **Parser:** UI.csv
- **Raw columns read:**
  - Identity and office: `Date of report in Current Week`, `CCC Code`, `Region`, `Division`, `CCC`, `CCC1`, `CCC Name`.
  - Metric matrix: `<base> (<cat>)`, where `<base>` is one of `Pending as on Monday of Last Week`, `Deposited in last week`, `Conn. Eff.`, `Withheld`, `Total disposed`, `Pending as on Monday of Current Week`, and `<cat>` is one of `All`, `DOM`, `COM`, `IND` (24 columns).
- **Numbers:** each matrix cell via parseInt(,10)||0. For "All": if the column `<base> (All)` exists, it is used, even when blank (→0). If it does not exist, the page sums DOM+COM+IND. Net = deposited − disposed. With no week selected, values are averaged over the number of distinct weeks.
- **Dates:** `Date of report in Current Week` via UI.date (d/m order). The week key is that date's epoch ms. There is no as-on cell; the header shows the week range.
- **Offices:**
  - `o = UI.office(d['CCC Code'])` (code only).
  - `_region = UI.regionName(d.Region) || o.region` and `_divn = UI.title(d.Division) || o.division`: the sheet names win over the code.
  - `_supp = d.CCC || d.CCC1 || UI.title(d['CCC Name'])`: **raw, not canonicalised**, with no code fallback.
  - `CCC_CODE` kept. `MzoScope.filterRows`; `UI.offices` + `UI.lockScope`.
- **Row filters / dedupe / positional:** drops rows with empty `Date of report in Current Week`.
- **Aggregations:**
  - Stat cards: deposited, disposed (sub: effected/withheld), backlog change, withheld (% of disposed), pending on Monday (sub: last Monday). A card selects the chart metric.
  - Week bar chart (click to select a week).
  - Office table by region/division/ccc (drill).
  - Weeks table plus CSV export.
  - Category segment ALL/DOM/COM/IND.
- **Deep links:** none
- **Writes:** none
- **Quirks:** `(All)` fallback logic; office names taken from sheet text before codes; CCC names not canonicalised (`CCC`/`CCC1`/`CCC Name` variants).
- **Complexity:** M: 24-column category matrix, name-first office mapping, weekly averaging.
- **Uniform fields it would use:** date_of_report_in_current_week, ccc_code, region, division, ccc, ccc1, ccc_name, pending_as_on_monday_of_last_week_{all,dom,com,ind}, deposited_in_last_week_{all,dom,com,ind}, conn_eff_{all,dom,com,ind}, withheld_{all,dom,com,ind}, total_disposed_{all,dom,com,ind}, pending_as_on_monday_of_current_week_{all,dom,com,ind}, _region, _division, _ccc_code, _ccc
- **Shared with:** none (copy of block (a))

### pending_mc.html  (NAV key: pending_mc)
- **Status (2026-11-01):** converted in `0c9158d` (batch A).
- **Kind:** kit (272 lines) · **Loads:** none (kit only)
- **Datasets:**
  - `pending_mc` via UI.load CACHE_PENDING_MC (+ UI.refresh).
  - Server JSON `/api/pending-mc/meta` (`canSync`, `isAdmin`; only shows the Sync button).
- **Parser:** UI.csv (also accepts an already-parsed array: `Array.isArray(text) ? text : UI.csv(text)`)
- **Raw columns read:** `Region`, `Division`, `CCC`, `SUBSTR(A.SUPP_OFF,-7,7)` (CCC code), `APPL_NO`, `CON_ID`, `FNAME`, `LNAME`, `Report Date`, `Meter Installation Date`, `CLASS`, `DESC`, `PHASE`, `WO_ASSIGNEE_TYPE`, `ADDR1` (d), `ADDR2` (d), `LOAD` (d), `TARIFF_CLASS` (d), `PROB_TYPE` (d), `WO_NO` (d), `WO_STATUS` (d), `COLL_DATE` (d), `CATG` (d), `DOCS_SUNMITTED` (read but never shown)
- **Numbers:** `LOAD` parseFloat||0. days = round((Report Date − Meter Installation Date)/864e5), or null.
- **Dates:** `Report Date` and `Meter Installation Date` via UI.date (d/m order). As-on = **max** `Report Date` over rows. Days are measured to the report date, not to today. `COLL_DATE` is kept raw and formatted by UI.fmtDate only in the drawer.
- **Offices:**
  - **Names only**, no UI.office.
  - `_region = UI.regionName(d.Region)`.
  - `_divn = MzoScope.divisionNameOf(d.Division) || UI.title(d.Division)`.
  - `_supp = MzoScope.cccNameInDivision(d.CCC, division) || MzoScope.cccNameOf(d.CCC) || raw`.
  - `CCC_CODE` = trimmed `SUBSTR(A.SUPP_OFF,-7,7)`, used only by filterRows.
  - `MzoScope.filterRows(all)`. UI.drill levels: region `_region` → division `_divn` → ccc `_supp` → **agency** (`agency`) → list.
- **Row filters / dedupe / positional:** keeps rows where `Region || APPL_NO` is truthy. No dedupe.
- **Aggregations:**
  - Stat cards: pending (sub: number of distinct CCCs), WithinMonth (days ≤30), Delayed (≥90), Industrial (cls `I`).
  - Facets: phase (`I`/`III`), age buckets (≤7, 8–30, 31–60, 61–89, 90+), class.
  - Drill table columns: pending, 90+ days.
  - Search on appl/con/name. CSV export.
- **Deep links:** `?kpiFilter=WithinMonth|Delayed|Industrial`; `?region=` `?division=` `?ccc=` (`UI.drill.fromParams`; because agency is a drill level, `?agency=` also works).
- **Writes:**
  - POST `/api/pending-mc/sync` (server pulls the sheet).
  - Then `mzoDataHub.delete('CACHE_PENDING_MC_PARSED')`, removes localStorage `mzo_hub_ver_CACHE_PENDING_MC` / `mzo_hub_ver_CACHE_PENDING_MC_PARSED`, and calls `hub.refresh`.
- **Quirks:**
  - Header `SUBSTR(A.SUPP_OFF,-7,7)` is an SQL expression; its snake name is `substr_a_supp_off_7_7`.
  - Typo header `DOCS_SUNMITTED`.
  - `WO_STATUS === 'C'` → Completed.
  - `WO_ASSIGNEE_TYPE` blank → "Individual".
  - `CATG` `U`/`R`.
  - Class map includes `T`, `J`.
- **Complexity:** M: name-based office mapping, drill with an extra agency level, deep links, sync write.
- **Uniform fields it would use:** region, division, ccc, substr_a_supp_off_7_7, appl_no, con_id, fname, lname, report_date, meter_installation_date, class, desc, phase, wo_assignee_type, addr1, addr2, load, tariff_class, prob_type, wo_no, wo_status, coll_date, catg, docs_sunmitted, _region, _division, _ccc_code, _ccc
- **Shared with:** no helper file (copy of block (b)). CACHE_PENDING_MC is also read by performance_index.html and referenced by sheet_links.html.

### withheld.html  (NAV key: withheld)
- **Status (2026-11-01):** converted in `b252e40` (batch A).
- **Kind:** kit (256 lines) · **Loads:** none (kit only)
- **Datasets:**
  - `withheld` via UI.load CACHE_WITHHELD_v4 (hub URL `/api/withheld/dataset` → 302 to the sheet). When localStorage `mzo_withheld_pending_refresh` is set, the page calls `mzoDataHub.refresh(KEY)` first. Also UI.refresh.
  - Server JSON `/api/nsc/meta?ts=` (`meta.reportDate`, `meta.stats.today`).
- **Parser:** UI.csv (also accepts a parsed array)
- **Raw columns read:** `APPL_NO`, `TODAY`, `REGION`, `DIVN_NAME`, `SUPP_OFF`, `CCC_CODE`, `CONN_CLASS`, `APPLIED_PHASE`, `COLL_DATE`, `SCN_WITHELD_DATE`, `SCN_WITHELD_REASON`, `IS_PORTAL_APPL`, `NAME`, `PHONE_NO`
- **Numbers:** none parsed. Derived: ago = floor((asOn − withheld date)/864e5).
- **Dates:**
  - `TODAY` via UI.date, **max** over rows.
  - `/api/nsc/meta` `meta.reportDate` (else `meta.stats.today`) via UI.date.
  - As-on is the later of the two and only ever moves later. Rows are recomputed when the meta arrives.
  - `COLL_DATE` and `SCN_WITHELD_DATE` via UI.date. The withheld year comes from SCN_WITHELD_DATE.
- **Offices:**
  - **Names only**, no UI.office and no MzoScope canonicalisation.
  - `_region = UI.regionName(d.REGION)`, `_divn = UI.title(d.DIVN_NAME)`, `_supp = UI.title(d.SUPP_OFF)` (keeps any " Ccc" suffix as title case).
  - `CCC_CODE` kept for filterRows. `MzoScope.filterRows(all)`; default UI.drill (region/division/ccc → list).
- **Row filters / dedupe / positional:** skips rows with empty `APPL_NO`. Dedupe per trimmed `APPL_NO`, last wins (the first position is kept).
- **Aggregations:**
  - Stat cards: withheld (sub: % from the portal), last 7/30/90 days (by ago), "No valid reason".
  - Facets: source (portal Y/N), reason group, year (top 9 years, then "<=YYYY and earlier"), class.
  - Drill table columns: withheld, last 30 d, no valid reason, portal %.
  - CSV export.
- **Deep links:** `?region=` `?division=` `?ccc=` (`UI.drill.fromParams`)
- **Writes:** localStorage `mzo_withheld_pending_refresh` (set when BroadcastChannel `mzo-withheld` says `withheld-uploaded`, then the page reloads; cleared after refresh). No server writes.
- **Quirks:**
  - A hard-coded `INVALID` reason list (exact strings, including `''`, `'n'`, `'N'`, `'NO'`, `'Y'`, `'YES'`, `'y'`, `'no'`, `'yes'` and long sentences) is grouped as "No valid reason". An empty reason displays as "Not specified".
  - `IS_PORTAL_APPL === 'Y'` (case-sensitive).
  - Header typo `SCN_WITHELD_*`.
  - Office names are not canonicalised, so `?ccc=` must match the title-cased raw SUPP_OFF.
- **Complexity:** M: dedupe, as-on from dump plus server meta, drill + deep links, reason classification.
- **Uniform fields it would use:** appl_no, today, region, divn_name, supp_off, ccc_code, conn_class, applied_phase, coll_date, scn_witheld_date, scn_witheld_reason, is_portal_appl, name, phone_no, _region, _division, _ccc_code, _ccc
- **Shared with:** no helper file (copy of block (b)). CACHE_WITHHELD_v4 is written by nsc/upload.html and referenced by admin_users.html and sheet_links.html.

### pending_load_extension.html  (NAV key: pending_load_extension)
- **Status (2026-11-01):** converted in `a9e3efb` (batch A).
- **Kind:** kit (252 lines) · **Loads:** none (kit only)
- **Datasets:**
  - `load_extension` via UI.load CACHE_LOAD_EXT (+ UI.refresh, + `hub.refresh`/`_peek` after sync).
  - Server JSON `/api/load-extension/meta` (`canSync`, `isAdmin`).
- **Parser:** UI.csv
- **Raw columns read:** `APPL_NO`, `CON_ID`, `report_date`, `CCC CODE`, `NAME`, `CONN_CLASS`, `CONN_PHASE`, `LOAD_APPLIED`, `CURR_LOAD`, `AGE_MONTHS`, `WO_ASSIGNEE`, `ADDRESS` (d), `COLLECTION_DATE` (d), `WON_ASSIGNED` (d), `CONN_CATEGORY` (d)
- **Numbers:**
  - `LOAD_APPLIED` and `CURR_LOAD` parseFloat||0. They are in **watts**: "Above 10 kW" means `applied > 10000`.
  - `AGE_MONTHS` parseInt(,10)||0 (months).
  - Estimated loss = round((applied − curr) × rate × age / 850), with rate I=75, C/A=60, else 30; 0 if applied ≤ curr.
- **Dates:**
  - As-on = the first row with a non-empty `report_date` (lowercase header), shown via UI.fmtDate (UI.date d/m order).
  - `COLLECTION_DATE` is kept raw and formatted by UI.fmtDate in the drawer.
  - Waiting time comes from `AGE_MONTHS`, not from dates.
- **Offices:**
  - **Code only**: `o = UI.office(d['CCC CODE'])`; `_region = o.region`, `_divn = o.division`, `_supp = o.ccc`. Unmapped values are '' and show as "Unmapped"; the list shows the code.
  - `CCC_CODE` kept. `MzoScope.filterRows(all)`; default UI.drill.
- **Row filters / dedupe / positional:** keeps rows with `APPL_NO || CON_ID`. No dedupe.
- **Aggregations:**
  - Stat cards: pending (sub: estimated loss in ₹), over a year (age ≥12), industrial, three phase, above 10 kW (each with loss).
  - Facets: phase, WO issued (on `WO_ASSIGNEE` presence), waiting buckets in months (≤2, ≤5, ≤11, ≤23, ≤59, more), class.
  - Drill table columns: pending, over a year, loss.
  - CSV export.
- **Deep links:** `?region=` `?division=` `?ccc=` (`UI.drill.fromParams`); `?q=`; `?kpi=` by regex (`^y1$|1y|year` → y1; `ind`; `ph3|three`; `big|10`).
- **Writes:** POST `/api/load-extension/sync`, then removes localStorage `mzo_hub_ver_CACHE_LOAD_EXT` and calls `hub.refresh('CACHE_LOAD_EXT')`.
- **Quirks:** the `report_date` header is lowercase while all others are uppercase; `CONN_CATEGORY` `U`/`R`; loads in W despite the kW labels; age comes from a sheet column.
- **Complexity:** M: drill + deep links + sync write, loss formula.
- **Uniform fields it would use:** appl_no, con_id, report_date, ccc_code, name, conn_class, conn_phase, load_applied, curr_load, age_months, wo_assignee, address, collection_date, won_assigned, conn_category, _region, _division, _ccc_code, _ccc
- **Shared with:** no helper file (copy of block (b)). CACHE_LOAD_EXT is also read by assistant.html.

### solar.html  (NAV key: solar)
- **Status (2026-11-01):** converted in `991110f` (prototype).
- **Kind:** kit (229 lines) · **Loads:** none (kit only)
- **Datasets:** `solar_connections` via UI.load CACHE_SOLAR (+ UI.refresh)
- **Parser:** UI.csv
- **Raw columns read:** `SOLAR_APPL_NO`, `CON_ID`, `Report Date`, `CCC CODE`, `SUPP_OFF`, `CREATION_DATE`, `REPLACE_STATUS`, `REMARKS` (scheme), `FNAME`, `LNAME`, `LOAD_APPL`, `PHONE_NO` (d), `CLASS` (d), `CURR_LOAD` (d), `METER_TYPE` (d), `GEN_METER1` (d), `CON_METER` (d), `WON` (d), `WORK_ORDER_DATE` (d), `QUOTATION_DUE_DATE` (d), `RESPONSE1` (d), `RESPONSE2` (d), `RESPONSE3` (d)
- **Numbers:** `LOAD_APPL` and `CURR_LOAD` parseFloat||0 (kW). Load buckets: ≤2, ≤3, ≤5, >5.
- **Dates:**
  - `CREATION_DATE` via UI.date. Wait = `UI.days(created)` (days to **now**), or null when connected.
  - As-on = the first row with a non-empty `Report Date`, via UI.fmtDate.
  - `WORK_ORDER_DATE` and `QUOTATION_DUE_DATE` are kept raw and shown via UI.fmtDate (d).
- **Offices:**
  - `o = UI.office(d['CCC CODE'], d.SUPP_OFF)`; `_region = o.region`, `_divn = o.division`.
  - `_supp = o.ccc || UI.title(SUPP_OFF minus /\s*CCC.*$/i)`.
  - `CCC_CODE` kept. `MzoScope.filterRows(all)`; default UI.drill.
- **Row filters / dedupe / positional:** keeps rows with `SOLAR_APPL_NO || CON_ID`. No dedupe.
- **Aggregations:**
  - Stat cards: applications (sub: Σ applied kW), connected, pending (sub: median wait), meter issue.
  - Facets: scheme, pending-for buckets (pending rows only), load buckets.
  - Drill table columns: applications, pending, issue, connected %.
  - CSV export.
- **Deep links:** `?region=` `?division=` `?ccc=` (`UI.drill.fromParams`); `?q=`; `?status=done|pending|issue`; `?scheme=PMSGMBY|WBREDA|ALOSHREE|OTHERS` (only if that scheme occurs in the data).
- **Writes:** none
- **Quirks:**
  - `REPLACE_STATUS` is uppercased: `SUCCESS`/`EFFECTED`/`DONE` → done; `''`/`(NULL)`/`NOT YET`/`PENDING` → pending; anything else → "issue".
  - `REMARKS` is uppercased: `''`/`OTHER`/`(NULL)` → OTHERS.
  - Name parts equal to `'NA'` are dropped.
  - `CLASS` is not trimmed.
- **Complexity:** M: drill + several deep links, status/scheme normalisation.
- **Uniform fields it would use:** solar_appl_no, con_id, report_date, ccc_code, supp_off, creation_date, replace_status, remarks, fname, lname, load_appl, phone_no, class, curr_load, meter_type, gen_meter1, con_meter, won, work_order_date, quotation_due_date, response1, response2, response3, _region, _division, _ccc_code, _ccc
- **Shared with:** no helper file (copy of block (b)). CACHE_SOLAR is also read by assistant.html.

### jjm.html  (NAV keys: jjm and jjm_report, the same page listed twice in app.html)
- **Status (2026-11-01):** converted in `d7af4ac` (batch A).
- **Kind:** kit (195 lines) · **Loads:** none (kit only)
- **Datasets:** `jjm_connections` via UI.load CACHE_JJM (+ UI.refresh)
- **Parser:** UI.csv
- **Raw columns read:**
  - Fixed: `CCC NAME`, `DIVISION`, `REGION NAME`.
  - Six count columns are found by regex over the header row; the first matching header wins: `/TOTAL NO CONNECTION/i` (deposited), `/ALREADY DONE/i` (connected), `/^work in progress/i`, `/PHE NOT READY/i`, `/ISSUED OF PHE|ISSUES? OF PHE/i` (PHE issue), `/OBJECTION FOR POLE/i` (right of way). The exact header text is not in the code: the comment says the headers "carry long descriptions and letters A–F".
- **Numbers:** each matched column via parseFloat||0 (0 if no header matched). blocked = phe + row.
- **Dates:** none. The meta line says "As updated by RMs".
- **Offices:**
  - CCC name first: `S.parentOfCcc(ALIAS[upper(CCC NAME)] || CCC NAME)`. ALIAS: MOKDAMPUR→Mokdumpur, BAISNABNAGAR→Baishnabnagar, H.C. PUR / HC PUR→Harishchandrapur, BAMANGOLA→Bamongola, KALIAGANJ→Kaliyaganj, KARANDEGHI→Karandighi, GOALPOKHAR→Goalpokher, KUMARGUNJ→Kumarganj, KUSHMUNDI→Kusmandi.
  - Unmapped: `_region` = custom `region(REGION NAME)` (contains MALDA→Malda, UTTAR→Raiganj, DAK→Balurghat, else UI.title); `_divn = S.divisionNameOf(DIVISION) || ''`; `_supp = UI.title(CCC NAME)`.
  - Empty groups show as "Other".
  - `MzoScope.filterRows` runs with the **show-all fallback when scope empties** (see the leak note at the top). `UI.offices` + `UI.lockScope`.
- **Row filters / dedupe / positional:** drops rows with empty trimmed `CCC NAME`. Columns are picked by header regex (`Object.keys(rows[0])`). Each row is one CCC's aggregate.
- **Aggregations:**
  - Stat cards: deposited (sub: number of CCCs), connected %, WIP %, PHE not ready, blocked (PHE + right of way). A card filters the office table to groups where that metric > 0.
  - Office table by region/division/ccc (drill).
  - Histogram of the mix (clickable).
  - CSV export.
- **Deep links:** none
- **Writes:** none
- **Quirks:** headers are found by regex, so uniform snake names depend on the live sheet headers. `sheetDivision` (UI.title(DIVISION)) is computed but unused. Scope leak.
- **Complexity:** M: regex header discovery, custom CCC alias map, custom region fallback.
- **Uniform fields it would use:** ccc_name, division, region_name, plus the six snake_cased count headers (names unknown from code: whatever the headers matching TOTAL NO CONNECTION / ALREADY DONE / work in progress / PHE NOT READY / ISSUE(S|D) OF PHE / OBJECTION FOR POLE become), _region, _division, _ccc (_ccc_code only if derived from the name)
- **Shared with:** no helper file (copy of block (a)). CACHE_JJM is referenced by sheet_links.html.

### meter_utilization.html  (NAV key: meter_utilization)
- **Status (2026-11-01):** converted in `8b376c9` (batch C).
- **Kind:** kit (412 lines) · **Loads:** none (kit only)
- **Datasets:**
  - `meter_erp`, `meter_master`, `meter_crm`, `meter_isu` via `mzoDataHub._peek` / `waitForDataset` on CACHE_METER_ERP/MASTER/CRM/ISU (all four together).
  - Parsed bundle `CACHE_METER_PARSED_v1` via `hub._peek`. It is used only when localStorage `mzo_hub_ver_CACHE_METER_PARSED_v1` equals the joined `mzo_hub_ver_<raw key>` values.
  - With no hub: direct fetch of `https://docs.google.com/spreadsheets/d/e/2PACX-1vSmzya-jypjfu9nN5QWuRJ6sbIgrqQ7Wa1eAx6Wfoepft2UpNwBC4a_rd4uJ6VpLhNu7FnjDBa8mJxW/pub?output=csv&gid=` with 1335293243 / 1053803476 / 1638328510 / 329630218.
  - `revalidate()` reloads the page if any raw key returns `'updated'`.
- **Parser:** UI.csv for each of the four sheets
- **Raw columns read:**
  - ERP: `Serial Number`, `Cost Center` || `CCC CODE`, `Phase`, `Meter Make`, `Entry Date`, `Meter Category`.
  - MASTER: `METER_NO` || `METER_NUMBER`, `CON_ID` || `CONS_ID` (d), `INST_NO` || `INSTALLATION` (d).
  - CRM: `METER_NUMBER` || `METER_NO`, `CON_ID` || `CONS_ID` (d), `PROB_TYPE`, `METER_INSTALL_DATE` || `SERV_CONN_DATE`.
  - ISU: `METER_NO`, `REPLACED_BY`, `CON_ID` || `CONS_ID` (d), `REPLACEMENT_DT`, `TRAN_DT`.
- **Numbers:** none parsed from cells. Counts only; used per month = used / months since the group's earliest entry date.
- **Dates:** three formats.
  - ERP `Entry Date`: per row via UI.date (d/m order) for "days in hand". The max uses a custom `split(/[./-]/)` read as **d/m/y**.
  - ISU `REPLACEMENT_DT` / `TRAN_DT`: compact **yyyymmdd** (8 characters).
  - CRM `METER_INSTALL_DATE` / `SERV_CONN_DATE`: **yyyy-mm-dd[ time]**, with a `(null)` guard. These give the max replacement date (`PROB_TYPE === 'Meter Burnt Problem'`) and the max NSC date (other types except `Load Enhancement`).
  - The three "to" dates are shown as dd-Mon-yyyy with dashes turned into spaces. A missing entry date is stored as the string `'Unknown'`.
- **Offices:** fully custom.
  - A hard-coded `OFFICES` string maps code → name (region/division/CCC codes plus division "booking" codes `1111111`…`7777777`).
  - `DIVCODE` maps 5-digit prefix → booking code; `regionNameForCode` uses prefixes 661/662/663 plus the booking codes.
  - `parseOfficeCode`: first match of regex `66[123]\d{4}`, else strip a leading `C3` and take the first 7 characters.
  - `canonicalDivisionName` → `MzoScope.divisionNameOf`, else strip DIV/DIVN/DIVISION(/DIVISIOIN).
  - `MzoScope.filterRows(allERP)` runs on the intermediate objects (`region` like `MALDA`, `division`, `cccName`, `cccCode`).
  - View: `_region = REGION_LABEL[upper(region)]` (MALDA→Malda, UTTAR DINAJPUR→Raiganj, DAKSHIN DINAJPUR→Balurghat) `|| UI.title(region)`. `_divn = division` unless it is `Unknown`. `_supp = MzoScope.cccNameOf(code) || UI.title(cccName minus CCC)`, set only for CCC-type offices.
  - Booking codes map to a division with empty `_supp`; the CCC tab skips them and the list shows "Division store". An unknown office gives region `'Unknown'`.
  - `UI.offices` + `UI.lockScope`.
- **Row filters / dedupe / positional:** none. The status lookup is: replacement if the meter is in CRM (any `PROB_TYPE`) or in ISU `METER_NO`/`REPLACED_BY`; else NSC if it is in MASTER; else in hand.
- **Aggregations:**
  - Stat cards: issued, used for NSC, used for replacement, in hand.
  - Office table (region/division/ccc): issued, NSC, replacement, used/month, in hand, used %.
  - Histograms: in-hand age (including "Date unknown") and in-hand make (top 6).
  - In-hand meter list. Exact-serial lookup when Enter is pressed in search.
  - Filters: phase segment (`1PH`/`3PH`; raw `1`/`3` normalised), smart/non-smart type (`Meter Category` contains `SMART METER`).
  - Two CSV exports.
- **Deep links:** none
- **Writes:** `hub.set('CACHE_METER_PARSED_v1', {allERP, masterLookup, replacementLookup, erpDateText, repDateText, nscDateText})` and localStorage `mzo_hub_ver_CACHE_METER_PARSED_v1`. These are local IndexedDB cache writes only.
- **Quirks:**
  - **Every** CRM meter counts as a replacement, including new-connection problem types; only the max date splits them.
  - `applyParsed` strips a legacy ` REGION` suffix from cached regions.
  - Make is cleaned (`UI.title`, collapse spaces, `' Li Mited'`→`' Limited'`).
  - Booking pseudo-codes and the `C3` prefix are handled.
  - `parseOfficeCode` is regex-first, while UI.office takes the last 7 digits. The two disagree for 10-character cost centres like `C366111050`.
- **Complexity:** L: four datasets joined, custom office table with pseudo-codes, three date formats, parsed-bundle cache write.
- **Uniform fields it would use:**
  - meter_erp: serial_number, cost_center, ccc_code, phase, meter_make, entry_date, meter_category.
  - meter_master: meter_no, meter_number, con_id, cons_id, inst_no, installation.
  - meter_crm: meter_number, meter_no, con_id, cons_id, prob_type, meter_install_date, serv_conn_date.
  - meter_isu: meter_no, replaced_by, con_id, cons_id, replacement_dt, tran_dt.
  - Offices from cost_center: _region, _division, _ccc_code, _ccc. The mapper must cover the booking codes 1111111–7777777 (division, no CCC).
- **Shared with:** no helper file (copy of block (a)). CACHE_METER_* and CACHE_METER_PARSED_v1 are used only by this page.

### wridd.html  (NAV key: wridd)
- **Status (2026-11-01):** converted in `c4d32df` (batch A).
- **Kind:** kit (258 lines) · **Loads:** none (kit only)
- **Datasets:** `wridd_schemes` via UI.load CACHE_WRIDD (+ UI.refresh)
- **Parser:** UI.csv
- **Raw columns read:**
  - Fixed headers: `CCC`, `Name of scheme`, `Remarks/ Project name`, `District` (d), `Block`, `Mouza`, `Jl. no.` (d), `Name of Circle / Division` (d).
  - Headers found by regex (first match): `/^status of connection as on date/i`, `/^status of connection as per previous/i`, `/^location/i` (d, plot), `/^previous remarks/i`, `/^present remarks/i` (d), `/^brief of subjects/i`, `/^any local communication/i`, `/^whether communicated/i` (d).
- **Numbers:** none
- **Dates:** none
- **Offices:**
  - **CCC name only**. `clean()` lowercases, strips a trailing " ccc"/" division" and removes non-alphanumerics. It looks up an index built from `MzoScope.HIERARCHY` CCC names plus `OVERRIDES` (kushmandi→Kusmandi, hcpur→Harishchandrapur, bamangola→Bamongola, gazol→Gazole, golapgang→Golapganj, sujpur→Sujapur, oldmalda→Old Malda, aiho→Aiho) via `MzoScope.parentOfCcc`.
  - `_region`/`_divn`/`_supp` come from the match. There is no code column.
  - `MzoScope.filterRows(all)`; `UI.offices` + `UI.lockScope`.
- **Row filters / dedupe / positional:** the sheet is **statewide**. Rows whose `CCC` does not map to a Malda Zone CCC are dropped (the meta shows zone vs statewide counts). The row index is kept as derived `id`.
- **Aggregations:**
  - Status: done when the "as on date" status (else the "previous" status) matches /effected/i.
  - Core sector: /core sector/i in remarks/brief/local.
  - Type is classified from `Remarks/ Project name` + `Name of scheme`: MIDI RLI, Major RLI, LDTW, DTW, Other.
  - Pending reason is classified from status + brief text.
  - Stat cards: schemes (sub: number of CCCs), effected, pending, core sector.
  - Office table (drill), histograms (reason, type), scheme list, search, CSV export.
- **Deep links:** none
- **Writes:** none
- **Quirks:** most headers are found by prefix regex, so the full snake names are unknown from code. Text classification depends on free text. `type()` concatenates possibly-undefined cells.
- **Complexity:** M: statewide sheet filtered through a custom CCC-name index; regex headers.
- **Uniform fields it would use:** ccc, name_of_scheme, remarks_project_name, district, block, mouza, jl_no, name_of_circle_division, plus snake names starting status_of_connection_as_on_date…, status_of_connection_as_per_previous…, location…, previous_remarks…, present_remarks…, brief_of_subjects…, any_local_communication…, whether_communicated… (full names depend on the sheet), _region, _division, _ccc (the library must drop rows outside the zone or flag them unmapped)
- **Shared with:** none (copy of block (a))

### bharatnet.html  (NAV key: bharatnet)
- **Status (2026-11-01):** converted in `bc1aa65` (batch A).
- **Kind:** kit (243 lines) · **Loads:** none (kit only)
- **Datasets:** `bharatnet_connections` via UI.load CACHE_BHARATNET (+ UI.refresh)
- **Parser:** UI.csv
- **Raw columns read:** all go through a local `pick(row, [variants])` that takes the first non-blank value.
  - `Appl No` | `Appl No.` | `APPLICATION NO`
  - `Cont.Account` | `Cont Account` (| `Account` for display)
  - `CCC CODE` | `CCC_CODE`
  - `CCC NAME` | `CCC`
  - `METER NUMBER` | `Meter Number` | `METER`
  - `MOVE IN DATE` | `Move In Date`
  - `Street`
  - `First Name`, `Last Name`
  - `Street 3` (d)
  - `Postl Code` | `Postal Code` | `PIN` (d)
  - `Telephone` (d)
  - As-on header matching `/upadte\s*date|update\s*date/i` (first row)
- **Numbers:** none
- **Dates:**
  - `MOVE IN DATE` via UI.date (d/m order). monthKey = `year*100 + getMonth()` (**0-based month**, not yyyymm).
  - As-on: "cell N2", the first data row's `UPADTE DATE`/`UPDATE DATE`, matched as `dd.mm.yyyy` (or `/`/`-`, 2-digit year +2000). It is normalised to dd/mm/yyyy, then reversed to y-m-d for UI.fmtDate.
- **Offices:**
  - `o = UI.office(code, name)`; `_region = o.region`, `_divn = o.division`.
  - `_supp = o.ccc || UI.title(name minus /\s+CCC$/i)`.
  - `CCC_CODE` and `'CCC NAME'` are copied onto the row for filterRows.
  - `MzoScope.filterRows` runs with the **show-all fallback when scope empties**. `UI.offices` + `UI.lockScope`.
- **Row filters / dedupe / positional:** keeps rows with an appl no or an account. GP name is derived from `Street` (strip a leading "THE PRADHAN", strip "VILL…" onwards, title case, roman numerals uppercased).
- **Aggregations:**
  - Status: connected when a meter number is present, else pending.
  - Stat cards: applications, connected, pending.
  - Office table (drill), "connected by month" histogram (last 8 months, clickable), application list, search, CSV export.
- **Deep links:** none
- **Writes:** localStorage `mzo_bharatnet_as_on` (no reader anywhere in the repo)
- **Quirks:** header variants that differ only in case or punctuation (`Appl No`/`Appl No.`, `Cont.Account`/`Cont Account`, `METER NUMBER`/`Meter Number`) collapse to the same snake key, which helps here. The header typo `UPADTE DATE` is handled. 0-based month key. Scope leak.
- **Complexity:** M: header-variant picking, positional as-on cell, derived GP and month key.
- **Uniform fields it would use:** appl_no, application_no, cont_account, account, ccc_code, ccc_name, ccc, meter_number, meter, move_in_date, street, first_name, last_name, street_3, postl_code, postal_code, pin, telephone, upadte_date / update_date, _region, _division, _ccc_code, _ccc
- **Shared with:**
  - No helper file (copy of block (a)).
  - `asOnOf()` and the scope fallback are near-identical copies in icds.html.
  - CACHE_BHARATNET is referenced by sheet_links.html and apps-script/mzo_metadata_sync.gs.

### icds.html  (NAV key: icds)
- **Status (2026-11-01):** converted in `3288031` (batch A).
- **Kind:** kit (300 lines) · **Loads:** none (kit only)
- **Datasets:**
  - `icds_a_plus` via UI.load CACHE_ICDS_APLUS and `icds_a` via UI.load CACHE_ICDS_A, both with `{ forceCheck: true }`.
  - The refresh button calls `hub.waitForDataset(k, {forceCheck:true})` + `_peek` for both.
  - Rows are combined with a derived `prio` of `'A+'` or `'A'`.
- **Parser:** UI.csv (each sheet separately)
- **Raw columns read:** `AWC NAME`, `AWC CODE`, `PROJECT`, `DISTRICT`, `CCC CODE`, `METER NUMBER`, `NO OF POLE REQUIRED`, `APPL_NO`, `UPDATE DATE` (first row only), `BUILDING OWNERSHIP` (d), `POLE ERECTION COMPLETED(Y/N)` (d), `METER INSTALL DATE` (d), `REMARKS` (d)
- **Numbers:** `NO OF POLE REQUIRED` via parseInt for the bucket key (NaN → "Not assessed", ≥3 → "3 or more"); the raw string is kept for display.
- **Dates:**
  - As-on: "cell M2", the first data row's `UPDATE DATE` from the A+ sheet (else the A sheet), as `dd.mm.yyyy` (or `/`/`-`), normalised like bharatnet.
  - `METER INSTALL DATE` is shown only via UI.fmtDate.
- **Offices:**
  - Custom `cccCode()`: strip `.0`; hard fixes `66111609`→`6611109` and `66131101`→`6613101`; then regex `\b(66[123]\d{4})\b`; else the **first** 7 digits if they look like `66[123]xxxx`. This differs from UI.office's last-7 rule.
  - `o = UI.office(code)`. `_divn`/`_supp`/`CCC_CODE` are set only if `o.ccc` is set (division-level codes count as unmapped).
  - **`_region` = district name** (`Malda` / `Uttar Dinajpur` / `Dakshin Dinajpur`) from custom `district(DISTRICT)` (DAKSHIN/SOUTH/DD/BALURGHAT, MALDA, UTTAR/NORTH/UD/RAIGANJ, else UI.title). It is **not** the zone region name.
  - `MzoScope.filterRows` runs with the **show-all fallback when scope empties** (district names match the region aliases).
  - `UI.offices(all, 'All districts')`. After `UI.lockScope`, the locked region select is rewritten via `DISTRICT_OF` (Raiganj→Uttar Dinajpur, Balurghat→Dakshin Dinajpur). `base()` ignores locked selects.
- **Row filters / dedupe / positional:** drops rows with neither `AWC NAME` nor `AWC CODE`. No dedupe across the two sheets.
- **Aggregations:**
  - Status: meter (a meter number that is not blankish) > mapped (has a CCC) > nocc.
  - Stat cards: centres without supply (sub: A+/A counts), no CCC yet, with CCC, meter given.
  - Office table by district/division/ccc. The division and ccc levels count only mapped centres.
  - Histograms: poles required, top 7 projects.
  - Priority segment All/A+/A. Centre list, search, CSV export.
- **Deep links:** none
- **Writes:** localStorage `mzo_icds_as_on` (no reader anywhere in the repo)
- **Quirks:**
  - The local `blankish()` treats `0`, `na`, `n.a.`, `nil`, `n/a` and `-` as blank (applied to METER NUMBER and APPL_NO).
  - The code fixes are hard-coded.
  - `_region` holds districts. The uniform `_region` (zone name) would need a district display field, or the page has to map back.
  - Scope leak.
- **Complexity:** M: two datasets combined, custom code cleaning, district-as-region, positional as-on cell.
- **Uniform fields it would use:** awc_name, awc_code, project, district, ccc_code, meter_number, no_of_pole_required, appl_no, update_date, building_ownership, pole_erection_completed_y_n, meter_install_date, remarks, _region, _division, _ccc_code, _ccc (district stays page-level)
- **Shared with:** no helper file (copy of block (a)). `asOnOf()` and the scope fallback are copies of bharatnet.html's. CACHE_ICDS_* are referenced by sheet_links.html and apps-script/mzo_metadata_sync.gs.


## Revenue

### loss.html  (NAV key: loss)
- **Status (2026-11-01):** converted in `c058c54` (batch B).
- **Kind:** kit (264 lines) · **Loads:** none besides the kit files
- **Datasets:** `loss_report` via `hub._peek('CACHE_LOSS')` + `waitForDataset('CACHE_LOSS', { forceCheck: true })` (it always revalidates; no UI.load). `loss_targets` is loaded the same way from `CACHE_LOSS_TARGET`.
- **Parser:** UI.csv (both)
- **Raw columns read:** loss_report: `YEAR`, `MONTH`, `CCC`, `Update On` (d), `CUM. AT&C LOSS`, `CUM. DIST. LOSS`, `COLL. EFF.`, `CUM. INPUT (MU)`, `CUM. DEMAND(MU)`, `CUM. COLLEC. (MU)`. loss_targets: `CCC`, `CUM. AT&C LOSS`, `CUM. DIST. LOSS`
- **Numbers:** the % columns go through `pctNum`: `parseFloat(String(v).replace('%',''))`, which strips only the first `%` and gives null when not finite. The MU columns go through `num`: `parseFloat(v)` with no comma strip, null fallback. `YEAR` and `MONTH` use `parseInt(…,10)`.
- **Dates:** the period key is `YEAR*100+MONTH` (yyyymm). The FY runs Apr–Mar, and the page compares against the previous March (`lastMarch`) and against the same month last year (`k-100`). As-on is the first non-empty `Update On` cell, shown with `UI.fmtDate` (UI.date, so dd-mm-yyyy etc. or a `new Date` fallback).
- **Offices:** a static `TREE` maps the sheet's row names, not codes. Zone row `MALDA ZONE`. Region rows `MALDA REGION`, `U/DINAJPUR REGION`, `D/DINAJPUR REGION`. Division rows `Malda Div Total`, `Gazole Div Total`, `Chanchal Div Total`, `Raiganj Div Total`, `Islampur Div Total`, `Balurghat Div Total`, `Buniadpur Div Total`. Upper-case CCC rows (e.g. `H.C. PUR`, `MOKDAMPUR`, `MATHURAPUR`). The labels come from the `NAME` map plus `UI.title`. There is **no MzoScope.filterRows**. Scope is enforced only by `UI.lockScope()` pinning the selects. `selection()` maps a pinned canonical CCC name back to the sheet row name through `cccLabel`.
- **Row filters / dedupe / positional:** rows without `CCC`, `YEAR` or `MONTH` are skipped. Rows are keyed by trimmed `CCC` name; a later duplicate for the same name and period overwrites the earlier one. The sheet mixes zone, region, division-total and CCC rows in one table.
- **Aggregations:** none computed. Every number is read from the sheet's own total rows. There are 5 stat cards (AT&C, dist loss, coll eff, input MU with billed `CUM. DEMAND(MU)`, collected MU) with deltas vs March / last year and target lines. A 3-FY line chart for the metric chosen with `#metric`. An office table one level below the current selection, with a custom click-drill Zone → Region → Division → CCC.
- **Deep links:** `?region=`, `?division=`, `?ccc=` (deepest wins; "X Division"/"X Region" suffixes stripped; region through `UI.regionName`)
- **Writes:** none
- **Quirks:** sheet CCC spellings differ from MzoScope: `MATHURAPUR`=Manikchak, `KALIAGANJ`=Kaliyaganj, `KUSHMUNDI`=Kusmandi (NAME maps it to "Kushmandi"), `GOALPOKHAR`=Goalpokher. For these four, a CCC-pinned login matches no row and the page shows "—". `MzoScope.cccNameOf` does not resolve most of these sheet spellings. Aggregate rows (`… Div Total`, `… REGION`, `MALDA ZONE`) need a row-level marker in uniform rows, not a `_ccc`. The loss sheet is pasted by hand, which is why the page always force-checks.
- **Complexity:** M. Two datasets, office names only (no codes), with aggregate rows mixed in and a custom name map, plus deep links.
- **Uniform fields it would use:** `year`, `month`, `ccc`, `update_on`, `cum_at_c_loss`, `cum_dist_loss`, `coll_eff`, `cum_input_mu`, `cum_demand_mu`, `cum_collec_mu` (targets: `ccc`, `cum_at_c_loss`, `cum_dist_loss`), plus `_region`/`_division`/`_ccc` from names (no `_ccc_code`). Mapping needs an alias table and a row-level marker (zone/region/division/ccc).
- **Shared with:** no helper file. `CACHE_LOSS` is also parsed by performance_index.html (and assistant.html). The same name aliases appear in performance_index.html's `ALIAS`/`DIV_PAT`/`REG_PAT`.

### performance_index.html  (NAV key: performance_index; also perf_index_imp)
- **Status (2026-11-01):** rebuilt by the rating work instead of batch B: it shows the VM's precomputed rating (`/api/data/rating`), else rates in the browser from uniform rows (`lib/rating_metrics.js` reads every dataset through `MzoRows.get`; `615a25f`, `eef4db3`, `bc72255`).
- **Kind:** kit (343 lines) · **Loads:** none besides the kit files
- **Datasets:** `loss_report`, `nsc_pending` and `pending_mc`, each via `waitForDataset(k, { forceCheck })` + `hub.get(k)` on `CACHE_LOSS`, `CACHE_NSC_v5` (`/api/nsc/dataset`) and `CACHE_PENDING_MC` respectively. On force it also calls `hub.resetVersionChecks()`.
- **Parser:** UI.csv (all three)
- **Raw columns read:** loss_report: `YEAR`, `MONTH`, `CCC`, `CUM. AT&C LOSS`. nsc_pending: `SUPP_OFF`, `CCC_CODE`, `DIVN_NAME`, `REG`, `REGION`, `DelayInQtn`, `DelayInWO`, `DelayInSC`. pending_mc: `Meter Installation Date`, `Report Date`, `CCC`, `SUPP_OFF`, `Division`, `Region`
- **Numbers:** the delay columns use `parseFloat`; '' or null becomes NaN, and only values ≥ 0 are averaged. AT&C uses `parseFloat(String(v).replace('%',''))`, and a **missing or invalid loss row becomes 0**. `YEAR`/`MONTH` use `parseInt`.
- **Dates:** only the latest `YEAR`/`MONTH` in the loss data is used. For master cards, `UI.date(r['Meter Installation Date'])` and `UI.date(r['Report Date'])` (default dmy) are compared; a card counts when `(rep - ins)/864e5 >= 90`.
- **Offices:** CCC comes from `MzoScope.cccNameOf(SUPP_OFF || CCC_CODE)` for NSC and `cccNameOf(CCC || SUPP_OFF)` for MC. Division comes from `parentOfCcc(ccc).division`, falling back to `DIVN_NAME` / `Division`. Region goes through the custom `normalizeRegion(parent.region || REG || REGION / Region, div)` into **'Malda' / 'Uttar Dinajpur' / 'Dakshin Dinajpur'**, which are not the MzoScope names; unknown values default to 'Malda'. Loss rows are matched to offices by name: the `ALIAS` table for CCCs (non-total rows), `DIV_PAT` regexes (`/^malda\s+div/i`…) for divisions, `REG_PAT` (`/^u\/dinajpur\s+region$/i`…) for regions. The unit list is `MzoScope.listAllUnits()`. There is **no MzoScope.filterRows**: all offices are ranked, and the login scope only highlights rows.
- **Row filters / dedupe / positional:** MC rows count only when they are ≥ 90 days old. NSC rows whose CCC does not resolve to a `listAllUnits` name drop out of the CCC ranking, and rows whose division is a raw `DIVN_NAME` not in `DIVS` drop out of the division ranking.
- **Aggregations:** per CCC, division and region: average quotation, work-order and connection delay, pending NSC count, MC count over 3 months, and AT&C. Each metric is min-max scaled within its peer group and weighted (30/8/8/9/25/20). The stat cards show the top region, top division, top CCC and the CCC average. The level is chosen with a segmented control (`#level`), not UI.drill. A division filter appears at CCC level. The scorecard opens in a drawer.
- **Deep links:** none
- **Writes:** none
- **Quirks:** a missing AT&C is scored as 0% loss, i.e. the best possible. The region display names differ from `MzoScope.HIERARCHY` (Raiganj/Balurghat), so the `mine` highlight at region level never matches. `listAllUnits().filter(u => u.name !== 'Gazol')` is a no-op. The loss name aliases duplicate the ones in loss.html.
- **Complexity:** M. Three datasets with custom office normalisation and name-alias matching, but no writes.
- **Uniform fields it would use:** loss_report: `year`, `month`, `ccc`, `cum_at_c_loss`. nsc_pending: `supp_off`, `ccc_code`, `divn_name`, `reg`, `region`, `delayinqtn`, `delayinwo`, `delayinsc`. pending_mc: `meter_installation_date`, `report_date`, `ccc`, `supp_off`, `division`, `region`. Plus `_region`/`_division`/`_ccc` (and `_ccc_code` for NSC/MC).
- **Shared with:** no helper file. Datasets are shared with loss.html (CACHE_LOSS), nsc.html and nsc/kpi.html (CACHE_NSC_v5; nsc/kpi also reads `DelayInQtn`), and pending_mc.html (CACHE_PENDING_MC).

### collection.html  (NAV key: collection)
- **Status (2026-11-01):** converted in `036a7c3` (batch B).
- **Kind:** kit (305 lines) · **Loads:** none besides the kit files
- **Datasets:** `collection_report` via UI.load CACHE_COLLECTION (+ UI.refresh)
- **Parser:** UI.csv
- **Raw columns read:** `PAYMENT_DT`, `CCC_CODE`, `AMOUNT PAID`, `COUNT`
- **Numbers:** `(parseFloat(r['AMOUNT PAID']) || 0) * 1e5`, because the sheet is **in lakhs**. `parseInt(r.COUNT,10) || 0`.
- **Dates:** `PAYMENT_DT` goes through a custom `ymd`: **yyyymmdd**, first 8 characters sliced, rejected when shorter than 8. The FY starts in April, and "latest" is the max payment date. The month-to-day comparison is capped by the `#upto` day select (default: the day of the max date).
- **Offices:** `UI.office(CCC_CODE)` (code only). Bulk codes are `/0000$/`: `_divn = region + ' bulk'` and `_supp = region + ' bulk'`. Fallbacks: `_region` 'Unmapped', `_divn` 'Unmapped', `_supp` = the code. `MzoScope.filterRows` runs on the built rows (they carry `_region/_divn/_supp/CCC_CODE`).
- **Row filters / dedupe / positional:** rows without a date or a `CCC_CODE` are skipped.
- **Aggregations:** stat cards show FY total, month-to-day vs last month, this week (Monday start), latest day, and monthly average. The trend is monthly (3 FYs), weekly (26 weeks) or daily (60 days). The office table uses custom tabs Region/Division/CCC with FY / this month / last month / same month last year and MoM/YoY. CCC rows open a 12-month drawer. A With/Without bulk toggle sits above.
- **Deep links:** `?division=` (case-insensitive match against the options; switches to CCC level)
- **Writes:** none
- **Quirks:** amounts are in lakhs. The bulk pseudo-office labels ("Malda bulk") differ from disconnection ("Bulk" / "X region bulk") and from docket/kpi ("Bulk" / "Bulk · X").
- **Complexity:** M. One dataset, but a custom date format, units in lakhs, bulk-office logic, custom drill and a deep link.
- **Uniform fields it would use:** `payment_dt`, `ccc_code`, `amount_paid`, `count`, `_region`, `_division`, `_ccc_code`, `_ccc` (bulk flag needed)
- **Shared with:** none

### disconnection.html  (NAV key: disconnection)
- **Status (2026-11-01):** converted in `03e6ef9` (batch B).
- **Kind:** kit (865 lines) · **Loads:** `/auth.js` (explicit), nothing else besides the kit files
- **Datasets:** `disconnection` via UI.load CACHE_DISCONNECTION (+ UI.refresh). Fallback when the hub has nothing: fetch `meta.csvUrl` from `/api/disconnection/meta`, else the published sheet `…2PACX-1vSkl9m38…/pub?gid=0&single=true&output=csv`. It also reads `/api/disconnection/meta` (server JSON: `canSync`, `sheetScriptUrl`, `csvUrl`, `stats.{totalConsumers,totalOSD,fullyPaid,partiallyPaid,disconnected,noAction}`). A follow-up comments feed comes from the Apps Script `sheetScriptUrl?list=1` as JSON `{comments:[{id,conId|con_id,note,at,by}], deletedIds}`. That feed is not in the dataset lists (nsc_followups is NSC only).
- **Parser:** first `normalizeCsv` (header-row detection), then UI.csv. Base dates use a custom `csvLine` split of the first two lines.
- **Raw columns read:** `CCC_CODE`, `UNIT_NAME`, `NOTOSD`, `NOTOSD_UPD`, `FINAL PAID AMOUNT`, `PAID/DISCON DATE`, `CON_ID`, `NAME`, `ADDRESS`, `REMARKS`, `CLASS_DESC`, `TARIFF CLASS` (d), `METER_NO` (d), `MRU` (d), `BILL DISPUTE` (d), `GOVT STAT` (d). Base-date headers come from the first data row: one matching `/^dom(\s|&)*com\s*base date$/i` or `/^dom base date$/i`, and one matching `/^ind/i` + `/base date/i`.
- **Numbers:** `parseAmount(row.NOTOSD, row.NOTOSD_UPD)` takes the first parseable of the two, after `replace(/,/g,'')`; it skips `#N/A`/`N/A`, falls back to 0. `parseAmount(row['FINAL PAID AMOUNT'])` works the same way.
- **Dates:** `PAID/DISCON DATE` is **dd.mm.yyyy**, parsed by `split('.')` → `new Date(y, m-1, d)`. Blank, `#N/A` or `'0'` mean no date. As-on is the max of these dates. Base dates (`osdDate`) accept d/m/y with `. / -` separators and 2-digit years (>50 → 19xx), and are normalised to dd.mm.yyyy. They are read **positionally from the first data row**, falling back to column index **21 / 22** and then to the first/last date-like cell in that row.
- **Offices:** a page `office(code, unitName)`. It calls `UI.office(code)` (code only). If a region is found but no division and the code ends in `0000`, the row becomes `{division:'Bulk', ccc: region+' region bulk'}`. If no CCC is found and `UNIT_NAME` is present, the CCC is `UI.title(UNIT_NAME minus ' CCC')`. Fallback 'Unmapped' for all three. `MzoScope.filterRows` runs on the mapped rows. Drill uses `UI.drill` (Region → Division → CCC → Consumers / Follow-ups).
- **Row filters / dedupe / positional:** `normalizeCsv` drops any lines before the first one containing `CCC_CODE` and (`NOTOSD` or `CON_ID`); Google sometimes adds a blank row before the header. Rows without `CON_ID` get the id `synthetic-<idx>`. Base dates are positional, as above. No dedupe.
- **Aggregations:** derived status: no date → No Action Taken; date but no paid amount → Disconnected; paid ≥ osd → Fully Paid; else Partially Paid. Stat cards show counts and amounts per status (the cards narrow the lists). Facets: OSD > ₹3,000 / > ₹5,000 (`UI.facet` `#fOsd`) and `CLASS_DESC` (`#fClass`), plus a search box. The UI.drill group table counts consumers, OSD, paid, disconnected, no action and action %. A 10-day "Recent activity" chart counts paid vs disconnected per date. A follow-up board lists notes per consumer.
- **Deep links:** `?region=`, `?division=`, `?ccc=` (through `dr.fromParams`). `?status=` takes `noAction` / `disconnected` / `partiallyPaid` or the full status names. `?followups=1` opens the follow-ups tab.
- **Writes:** `POST /api/disconnection/sync` (then `hub.refresh(CACHE_DISCONNECTION)`). Apps Script follow-ups at `sheetScriptUrl`: `POST` form `data={action:'add',id,conId,at,by,note}` / `{action:'delete',id}`, and `GET ?list=1&t=` every 15 s. localStorage `mzo_discon_followups` and `mzo_discon_followup_outbox`.
- **Quirks:** magic values `#N/A` and `'0'` for date and paid amount. Base dates are positional (cols 21/22). Dates are dd.mm.yyyy only. Bulk office labels are page-specific. The status logic counts paid only when the string is non-empty, not `#n/a` and not `'0'`.
- **Complexity:** L. Header-row detection, positional base-date cells, bespoke status rules, a fallback fetch chain, sync and Apps Script write paths, UI.drill and deep links.
- **Uniform fields it would use:** `ccc_code`, `unit_name`, `notosd`, `notosd_upd`, `final_paid_amount`, `paid_discon_date`, `con_id`, `name`, `address`, `remarks`, `class_desc`, `tariff_class`, `meter_no`, `mru`, `bill_dispute`, `govt_stat`, and the base-date cell (e.g. `dom_com_base_date` / `dom_base_date` and an `ind…_base_date`; exact header unknown), plus `_region`, `_division`, `_ccc_code`, `_ccc`
- **Shared with:** no helper file. The same CSV and column names are parsed server-side by `scripts/sync/sync_disconnection_to_supabase.js` (it also uses positional fallbacks, e.g. `NOTOSD` → 5 and `PAID/DISCON DATE` → 12), by `scripts/tools/compute_briefing_cccs.js`, and by server.js meta/sync.

### theft_assessment.html  (NAV key: theft_assessment)
- **Status (2026-11-01):** converted in `5afc0e5` (batch B).
- **Kind:** kit (307 lines) · **Loads:** none besides the kit files
- **Datasets:** `theft_assessment` via UI.load CACHE_THEFT_ASSESSMENT_v2 (+ UI.refresh)
- **Parser:** UI.csv. An object body `{data: text}` is unwrapped first.
- **Raw columns read:** `Location Code`, `CCC Name`, `Consumer ID`, `Provsnl Bill Unit`, `Provsnl Bill Amt`, `Final Billing Unit`, `Final Bill Amt`, `PAYMENT AMT`, `Final Print Doc No`, `Case Type`, `Inspection Date`, `Provsnl Bill Date`, `Provsnl Bill No`, `Final Billing Date` (d), `PAYMENT DT` (d), `FIR DETAILS`, `POLICE STATION`, `S&LP UNIT` (d)
- **Numbers:** `num(s)` = `parseFloat(String(s).replace(/[^\d.-]/g,''))`, which strips commas, ₹ and units; NaN → 0. Derived values: explicit final when `Final Bill Amt > 0` or `Final Print Doc No` is longer than 3 characters. A paid provisional bill counts as final. Cut = provisional − final, with % buckets >50 / 20–50 / <20 / zero / increased. Balance = max(0, assess − pay).
- **Dates:** `Inspection Date` goes through custom `dmy`: `split(/[./-]/)` d/m/y, kept only when the year is 2000–2040. The year facet is the trailing 4 digits of `Provsnl Bill Date`, else of `Inspection Date`. `Final Billing Date` and `PAYMENT DT` are shown raw. The meta range is the min/max inspection date.
- **Offices:** `UI.office(Location Code)` (code only). If that fails, a **page `PREFIX` map** on the first 4 digits (6611 → Malda/Malda … 6632 → Balurghat/Buniadpur), **defaulting to ['Malda','Malda'] for any unknown code**. The CCC fallback is `cccName(CCC Name)`: strip `CUSTOMER CARE CENTER|CENTRE|CCC`, apply `UI.title`, else 'Unknown'. `MzoScope.filterRows` runs on the mapped rows.
- **Row filters / dedupe / positional:** none. Every UI.csv row is kept, including rows of only commas.
- **Aggregations:** stat cards show provisional, final, cut at final, recovered and outstanding; clicking one filters. Custom tabs Region/Division/CCC for the office table (cases, provisional, cut %, cut > 50%, recovery bar, outstanding). Histograms for the cut bucket and for cases by year. Filters: year, status (recovered / partial / unpaid / final pending / FIR / not FIR) and search. The case table opens a drawer.
- **Deep links:** none
- **Writes:** none (a static "Open sheet" link only)
- **Quirks:** unmapped location codes fall into Malda/Malda. `Case Type` blank → 'FIR'; it counts as FIR when it contains "FIR" and not "NOT". Dates are d/m/y with mixed separators. Possible blank comma rows become empty cases.
- **Complexity:** M. One dataset, but custom number cleanup, an office fallback map with a wrong default, and derived assessment rules.
- **Uniform fields it would use:** `location_code`, `ccc_name`, `consumer_id`, `provsnl_bill_unit`, `provsnl_bill_amt`, `final_billing_unit`, `final_bill_amt`, `payment_amt`, `final_print_doc_no`, `case_type`, `inspection_date`, `provsnl_bill_date`, `provsnl_bill_no`, `final_billing_date`, `payment_dt`, `fir_details`, `police_station`, `s_lp_unit`, `_region`, `_division`, `_ccc_code`, `_ccc`
- **Shared with:** none

### remosd5000.html  (NAV key: remosd5000)
- **Status (2026-11-01):** converted in `1b31754` (batch B).
- **Kind:** kit (241 lines) · **Loads:** none besides the kit files
- **Datasets:** `rem_osd` via UI.load CACHE_REM_v2 (+ UI.refresh). The source is the gviz `tq?tqx=out:csv` export.
- **Parser:** UI.csv
- **Raw columns read:** `Notice Due Date`, `CCC Code`, `CCC name`, `Region Name`, `Division`, `DOM-Count`, `COM-Count`, `IND-Count`, `Others-Count`, `Total-Count`, `DOM-Amount in Lakhs`, `COM-Amount in Lakhs`, `IND-Amount in Lakhs`, `Others-Amount in Lakhs`, `Total-Amount in Lakhs`, `Report Date/Email Date`, `Remarks` (d)
- **Numbers:** unary `+r[col] || 0`. "Total" is the sum of the four class columns, falling back to `Total-Count` / `Total-Amount in Lakhs` when the sum is 0. Amounts are **in lakhs** (×1e5 for display).
- **Dates:** `Notice Due Date` and `Report Date/Email Date` go through custom `dmy`: `split('/')` → **dd/mm/yyyy**. The distinct due dates, sorted descending, fill the `#dateFilter` select. The REM email date comes from the first row of the selected notice date.
- **Offices:** `UI.office(CCC Code, CCC name)` (code then name). Fallbacks: `UI.title(Region Name)`, `UI.title(Division)`, `UI.title(CCC name)`. Rows are mutated in place (`r._region/_divn/_supp/CCC_CODE`). `MzoScope.filterRows` runs on them.
- **Row filters / dedupe / positional:** a row is kept only with `Notice Due Date` and (`CCC Code` or `CCC name`). Each row is one office × one notice date (a snapshot series).
- **Aggregations:** stat cards per class (Total/DOM/COM/IND/Others) for the selected date, showing amount, count and average; clicking one picks the class. A trend across notice dates for amount or count. Custom tabs Region/Division/CCC with change vs the previous notice date. CCC rows open a class-breakdown drawer.
- **Deep links:** none
- **Writes:** none
- **Quirks:** units are lakhs. `Remarks` 'Nil' is treated as blank. Header names contain hyphens and spaces. gviz CSV quotes every value. The date key is the raw string, so it must stay stable or be mapped to ISO consistently.
- **Complexity:** M. One dataset, but code+name office mapping with name fallbacks, a snapshot-by-date model, and lakh units.
- **Uniform fields it would use:** `notice_due_date`, `ccc_code`, `ccc_name`, `region_name`, `division`, `dom_count`, `com_count`, `ind_count`, `others_count`, `total_count`, `dom_amount_in_lakhs`, `com_amount_in_lakhs`, `ind_amount_in_lakhs`, `others_amount_in_lakhs`, `total_amount_in_lakhs`, `report_date_email_date`, `remarks`, `_region`, `_division`, `_ccc_code`, `_ccc`
- **Shared with:** none

### rem/defaulters.html  (NAV key: rem_defaulters)
- **Status (2026-11-01):** converted in `4437f5b` (batch B).
- **Kind:** kit (315 lines) · **Loads:** none besides the kit files
- **Datasets:** `rem_defaulters_dom` via UI.load CACHE_REM_DOM, `rem_defaulters_agri` via UI.load CACHE_REM_AGRI, and `rem_defaulters_ind_com` via UI.load CACHE_REM_DEFAULTERS. All three are published `output=tsv`. On refresh: `waitForDataset(forceCheck)` + `_peek`.
- **Parser:** custom `split('\t')` (`tsv()`): `\r` removed, blank lines dropped, header trimmed, values trimmed
- **Raw columns read:** `CON_ID`, `CCC_CODE`, `BASE_CLASS`, `LAST_PDT`, `NAME`, `ADDRESS`, `NOTOSD_UPD`, `LOCKED_OSD`, `REG_MOB_NO`, `UPD_DT`, `GOVT_STAT` (positional check + d), `INST_NO` (d), `MRU` (d), `CLASS_DESC` (d), `BDATE` (d), `NOT_ISSUE_DT` (d), `DISC_FLAG` (d). The export writes every raw column.
- **Numbers:** `parseFloat(r.NOTOSD_UPD) || 0` and `parseFloat(r.LOCKED_OSD) || 0`. No comma strip.
- **Dates:** `LAST_PDT`, `UPD_DT`, `BDATE` and `NOT_ISSUE_DT` go through custom `ymd`: **yyyymmdd**, exactly 8 characters. "Updated" is the max `UPD_DT` by **string comparison**. Months and days since `LAST_PDT` (local midnight) set the payment-age bucket.
- **Offices:** `UI.office(CCC_CODE)` (code only). `_supp` falls back to the code; `_region` and `_divn` stay '' when unmapped and show as 'Unmapped' in the groups. `MzoScope.filterRows` runs on the merged enriched rows (they carry `_region/_divn/_supp/CCC_CODE` plus `raw`).
- **Row filters / dedupe / positional:** a row is kept when it has `CON_ID` or `CCC_CODE`. **Positional repair:** when the `GOVT_STAT` cell is not YES/NO but the next cell is, and the `ADDRESS` cell is empty, `v.splice(ai,1)` drops the extra empty cell (the sheet sometimes adds a cell after NAME). Type: the DOM sheet gives 'DOM', the AGRI sheet 'AGRI', and the I/C sheet gives `BASE_CLASS==='I'` → 'IND' else 'COM'.
- **Aggregations:** stat cards per type (All/DOM/COM/IND/AGRI) with amount and count. Custom tabs Region/Division/CCC (count, OSD, share, no payment for over a year). Histograms for last-payment age and OSD size bands. Filters: `BASE_CLASS` select, and a tag select (school / party / tower, by keyword search in NAME+ADDRESS). The consumer list opens a drawer with a copy-to-clipboard button.
- **Deep links:** none
- **Writes:** none
- **Quirks:** TSV is split without quote handling. A column-shift repair is keyed on YES/NO in `GOVT_STAT`. Tags are keyword based ('indus', 'bharti', 'jio', 'bsnl', 'telecom'). The I/C split depends on `BASE_CLASS` 'I'.
- **Complexity:** M. Three TSV datasets, a custom parser with positional repair, and yyyymmdd dates.
- **Uniform fields it would use:** `con_id`, `ccc_code`, `base_class`, `last_pdt`, `name`, `address`, `notosd_upd`, `locked_osd`, `reg_mob_no`, `upd_dt`, `govt_stat`, `inst_no`, `mru`, `class_desc`, `bdate`, `not_issue_dt`, `disc_flag`, `_region`, `_division`, `_ccc_code`, `_ccc`. The shared parser must reproduce the column-shift repair.
- **Shared with:** none (`NOTOSD` naming also appears in disconnection, with a different column)


## DD visit

### dd/upcomingDD.html  (NAV key: upcoming_dd)
- **Status (2026-11-01):** converted in `00a39a6` (batch C); `c557c2d` builds its rows with `MzoRows.build`, nothing stored on the device.
- **Kind:** kit (296 lines) · **Loads:** none besides the kit files (no mzo_data_hub.js)
- **Datasets:** `upcoming_dd` via fetch `https://docs.google.com/spreadsheets/d/1aUeVnSc-OmFqqrUdoZxv8v8659u52zlIWddnpJgU9Uk/gviz/tq?tqx=out:csv&gid=487034861` with `cache: 'no-store'`
- **Parser:** UI.csv
- **Raw columns read:** `CCC_CODE` || `OFFICE_CODE`, `OUTSTANDING`, `DISCON_DT`, `CON_ID` || `CONSUMER_ID`, `NAME` || `CONSUMER_NAME`, `REG_MOB_NO`, `ADDRESS` (d), `BASE_CLASS`, `CONN_PHASE`, `GOVT_STAT`, `CONN_LOAD` (d), `METER_NO` (d). The sheet also carries Aadhaar, PAN and email; these are deliberately not kept.
- **Numbers:** `parseFloat(r.OUTSTANDING) || 0`
- **Dates:** `DISCON_DT` goes through custom `ymd`: strict `/^\d{8}$/` **yyyymmdd**. Due = DISCON_DT + 180 days. Days to due run against local midnight today. Buckets: OVERDUE (or no date) / TODAY / 7D / 15D / 30D / FUTURE / CLEARED (when osd ≤ 0).
- **Offices:** `UI.office(code)` (code only). `_region/_divn/_supp` stay '' when unmapped and show as 'Unmapped' in groups. `MzoScope.filterRows` runs after mapping. Office selects come from a page `uniq` (not UI.offices).
- **Row filters / dedupe / positional:** rows without a consumer id are dropped
- **Aggregations:** stat cards: consumers, overdue, due in 7 days, due in 8–30 days, arrears cleared. Custom tabs Region/Division/CCC (count, overdue, due ≤ 30 days, OSD, share). Histograms for the due bucket and for class. Filters: class, phase, govt, OSD threshold, search.
- **Deep links:** none
- **Writes:** localStorage only (`mzo_upcoming_dd_notes`, visit notes kept on this device)
- **Quirks:** header variants (`a || b`). `CONN_PHASE` defaults to '1' and `BASE_CLASS` to 'Other'. `GOVT_STAT` matches `/^(y|yes|govt)/i` → 'Y'. Sensitive columns are dropped on purpose. The gviz CSV is fetched directly with no DataHub cache.
- **Complexity:** S. One dataset with straight code mapping; the only special date is yyyymmdd.
- **Uniform fields it would use:** `ccc_code`, `office_code`, `outstanding`, `discon_dt`, `con_id`, `consumer_id`, `name`, `consumer_name`, `reg_mob_no`, `address`, `base_class`, `conn_phase`, `govt_stat`, `conn_load`, `meter_no`, `_region`, `_division`, `_ccc_code`, `_ccc` (the uniform layer should drop the Aadhaar/PAN/email columns)
- **Shared with:** no shared file. The code is very similar to dd/dd_visit.html (own copies of `ymd`, `uniq`, `fillFilters`, `drill`, and the `DISCON_DT` handling).

### dd/dd_visit.html  (NAV key: dd_visit_page)
- **Status (2026-11-01):** converted in `135a7cf` (batch C); `db374ab` (final) reads the sheet with no cache and builds its rows with `MzoRows.build`, storing nothing on the device (the sheet holds PAN), and deletes the copies older versions kept.
- **Kind:** kit (368 lines) · **Loads:** none besides the kit files
- **Datasets:** `dd_visit` via UI.load CACHE_DD_VISIT; refresh uses `waitForDataset(forceCheck)` + `_peek`. Visit records come from the Apps Script `https://script.google.com/macros/s/AKfycbxgrKdt--yXk4A3_jL8PS6Z5kYXohHVNA3GKxq2jss8TVgqfvJdff_jFDwjj8Gxcdv00Q/exec?t=` as JSON `{status:'success', data:{<conId>: rec}}`, merged with localStorage `dd_visit_followups_v1` by `updatedAt`. That feed is not in the dataset lists.
- **Parser:** UI.csv (sheet); JSON (visits)
- **Raw columns read:** sheet: `CCC_CODE` || `CCC`, `OSD_DATE`, `CON_ID` || `CONSUMER_ID`, `INST_NO`, `NAME`, `ADDRESS`, `REG_MOB_NO`, `CATEGORY`, `BASE_CLASS`, `TOTAL_OSD` || `OUTSTANDING`, `CONN_LOAD` (d), `DISCON_DT` || `DISCONN_DATE`. Visit record: `conId`, `instNo`, `consumerName`, `address`, `cccCode`, `category`, `totalOsd`, `mobile`, `visitDate`, `visitBy`, `visitorName`, `status`, `paidAmount`, `paidDate`, `remarks`, `updatedAt`, `reportOsdDate`, `history[]` (each entry: `id`, `visitDate`, `visitByOffice`, `visitorName`, `visitBy`, `status`, `paidAmount`, `paidDate`, `remarks`, `createdAt`)
- **Numbers:** `parseFloat(r.TOTAL_OSD || r.OUTSTANDING) || 0`, `parseFloat(rec.paidAmount) || 0`, `parseFloat(rec.totalOsd) || 0`, `parseFloat(c.load) || 0`
- **Dates:** `DISCON_DT`/`DISCONN_DATE` and `OSD_DATE` go through custom `ymd`: **yyyymmdd**. As-on is the first non-empty `OSD_DATE`. Visit `visitDate`/`paidDate` are yyyy-mm-dd from `<input type=date>`, read with `UI.date`/`UI.fmtDate`. `updatedAt` is ISO.
- **Offices:** sheet rows use `UI.office(code)` (code only), with '' when unmapped (shown as 'Unmapped'). Then `MzoScope.filterRows`. **The visit history uses `UI.office(rec.cccCode)` and is not scope-filtered.** Office selects come from a page `uniq`.
- **Row filters / dedupe / positional:** rows without a consumer id are dropped. Visits are keyed by `conId`, with the newer `updatedAt` winning.
- **Aggregations:** stat cards: DD consumers, visited (coverage), not visited, paid after visit (sum of `paidAmount`), and off-sheet history count. Custom tabs Region/Division/CCC (count, visited, coverage, OSD, recovered). An outcome histogram over the 5 `OUTCOMES`. List tabs: Consumers / Visit history. Filters: class, `CATEGORY` (R/U), OSD threshold, search.
- **Deep links:** none
- **Writes:** Apps Script `POST` (no-cors) `{action:'SAVE_DD_VISIT', data: rec}` on save, and on admin delete of a timeline entry. localStorage `dd_visit_followups_v1`.
- **Quirks:** header variants. `osdDate` is module-level and never reset, so a refresh keeps the old as-on. The off-sheet count and the history list include out-of-scope consumers, since `visits` are not scope-filtered. `CATEGORY` U → Urban, anything else → Rural.
- **Complexity:** M. A sheet plus an Apps Script JSON source with a merge, write paths, and yyyymmdd dates.
- **Uniform fields it would use:** `ccc_code`, `ccc`, `osd_date`, `con_id`, `consumer_id`, `inst_no`, `name`, `address`, `reg_mob_no`, `category`, `base_class`, `total_osd`, `outstanding`, `conn_load`, `discon_dt`, `disconn_date`, `_region`, `_division`, `_ccc_code`, `_ccc`. The visit JSON stays as is, but it needs `_region` etc. from `cccCode` plus scope filtering.
- **Shared with:** no shared file. The code is very similar to dd/upcomingDD.html (separate copies).


## Consumers & meters

### consumer/defective_meter.html  (NAV key: defective_meter)
- **Status (2026-11-01):** converted in `c59ccfb` (batch D).
- **Kind:** kit (460 lines) · **Loads:** `/lib/defective_meter_pipeline.js?v=85`, `/lib/sheet_mirror_client.js?v=110`
- **Datasets:** `defective_summary` via UI.load CACHE_DEFECTIVE. On error it falls back to fetching `meta.summaryCsvUrl` or `…1dMLSX2bZBqZMPooh7_CrniCjqgy4MijaFW62GKJJldA/export?format=csv&gid=0`. `defective_details` is loaded lazily: `waitForDataset('CACHE_DEFECTIVE_DETAILS')` + `_peek`, else fetch `meta.detailsCsvUrl` or `…&gid=1638574999`. It also reads `/api/defective/meta` (server JSON: `summaryCsvUrl`, `detailsCsvUrl`, `sheetScriptUrl`, `canUpload`, `canSync`, `stats.{totalDefective,agri,over5,load05_1,loadLt05,over10,ph3,industrial,smart,loadGt6,load3_6,load1_3,reportDate}`).
- **Parser:** `MzoDefectivePipeline.parseDump(text).rows` → `parseCsv`. It auto-detects the delimiter (tab, `|`, `;` or `,`), strips NULs and BOM, and finds the header row among the first 25 rows by alias score. Headers are canonicalised via `FIELD_ALIASES`/`mapHeader`; lowercase KPI names (`total`, `over10`…) are preserved. TOTAL / GRAND TOTAL rows are skipped, and so are rows with no id, ccc or meter. The page also drops rows that are entirely blank and throws when the text looks like a Google sign-in page.
- **Raw columns read:** summary: `REPORT_AS_ON`, `CCC_CODE`, `BASE_CLASS`, `DEFECT_YEAR`, `total`, `agri`, `over10`, `over5`, `ph3`, `industrial`, `smart`, `load_gt6`, `load_3_6`, `load_1_3`, `load_05_1`, `load_lt_05`, `phase_1`, `phase_3`, `phase_other`. Present but unused: `REGION`, `REGION_CODE`, `DIVISION`, `DIVISION_CODE`, `DEFECT_MONTH`. details: `CON_ID`, `CCC_CODE`, `NAME`, `METER_NO`, `FIRST_REPORTED_DEF_DT`, `BASE_CLASS`, `PHASE` (d), `CONN_LOAD`, `MRU` (d), `CONN_STAT` (d), `MOBILE_NO` (d), `ADDRESS` (d), plus flags `over10`, `ph3`, `industrial`, `smart`, `load_gt6`, `load_3_6`, `load_1_3`
- **Numbers:** metric sums use `Number(r[f])` (falsy is skipped). Details flags are tested with `Number(r[flag]) === 1`. Load sorting uses `parseFloat(CONN_LOAD) || 0`.
- **Dates:** `REPORT_AS_ON` (first summary row) and `FIRST_REPORTED_DEF_DT` go through page `ymd`: **yyyymmdd**, else `UI.date`. The year filter compares the `FIRST_REPORTED_DEF_DT` year with `DEFECT_YEAR`.
- **Offices:** `withOffice`: `UI.office(CCC_CODE)`, with `_supp` falling back to the code and '' otherwise. It ignores the sheet's `REGION`/`DIVISION`. `MzoScope.filterRows` runs on summary and details separately.
- **Row filters / dedupe / positional:** details are deduped on `CON_ID|METER_NO`, because the names tab repeats rows. The summary must have some non-empty `total`, else it errors "Summary is empty."
- **Aggregations:** two stat strips (5 count metrics and 7 priority metrics) that switch the active metric. Custom tabs Region/Division/CCC (meters and share for the active metric). Class and phase histograms. A year column chart (it ignores the year filter). Priority metrics open a names table for one CCC.
- **Deep links:** `?kpi=` (metric key, or the aliases `over10`, `ph3`, `smart`, `load_gt6`) and `?division=`
- **Writes:** `POST /api/defective/sync`. Upload: the dump is processed in the browser with `P.buildFromCsvText`, then `MzoSheetMirror.publishTab(sheetScriptUrl,'summary',…)` and `publishTab(…,'details',…)`, then `postScript({action:'savemeta', meta})`, then `hub.refresh(CACHE_DEFECTIVE / _DETAILS)`. The Apps Script default is `AKfycbzULRzoJRMlt_…/exec`.
- **Quirks:** the header alias mapping can rename columns (e.g. `CCC` → `CCC_CODE`, `STATUS` → `CONN_STAT`, `TODAY` → `REPORT_AS_ON`). The KPI column names are lowercase. Summary rows are pre-aggregated counts per CCC × class × year × month. The pipeline also carries its own office prefix map (`OFFICE_BY_PREFIX`, upper-case "MALDA REGION"…), which is used only when building uploads.
- **Complexity:** L. A bespoke parser in a helper file, two datasets plus a meta fallback chain, upload, publish and sync write paths, and deep links.
- **Uniform fields it would use:** summary: `report_as_on`, `ccc_code`, `base_class`, `defect_year`, `total`, `agri`, `over10`, `over5`, `ph3`, `industrial`, `smart`, `load_gt6`, `load_3_6`, `load_1_3`, `load_05_1`, `load_lt_05`, `phase_1`, `phase_3`, `phase_other`. details: `con_id`, `ccc_code`, `name`, `address`, `meter_no`, `first_reported_def_dt`, `phase`, `conn_load`, `base_class`, `conn_stat`, `mru`, `mobile_no`, plus the flag columns. Both plus `_region`, `_division`, `_ccc_code`, `_ccc`. The uniform reader must keep (or reproduce) the pipeline's header aliasing.
- **Shared with:** `/lib/sheet_mirror_client.js` is also loaded by nsc/upload.html and stock/upload.html. `/lib/defective_meter_pipeline.js` is loaded only by this page (also listed in sw.js).

### consumer/consumer.html  (NAV key: consumers)
- **Status (2026-11-01):** converted in `cd070d5` (batch C).
- **Kind:** kit (232 lines) · **Loads:** none besides the kit files (no mzo_data_hub.js)
- **Datasets:** `consumers` via fetch `https://docs.google.com/spreadsheets/d/e/2PACX-1vQT4ufTMHJGTUqNSqFSzz0q2x-ShM_WHlfSRxT4tVqA6GcaMK5g38PDLmcJR4JXuxLi-tKafW-Yxwdo/pub?gid=0&single=true&output=csv` (`cache: 'no-store'` on refresh, `'default'` otherwise)
- **Parser:** UI.csv
- **Raw columns read:** `CCC_CODE`, `Date`, `COUNT`, `LOAD`, `SD_LAKH`, `OSD_LAKH`, `CONN_STAT`, `BASE_CLASS`, `CONN_PHASE`, `CATEGORY`, `GOVT_STAT`, `TYPE_OF_METER`, `CONN_BY`, `TIME_OF_DAY`
- **Numbers:** `num(v)` = `Number(String(v).replace(/,/g,'')) || 0` for `COUNT`, `LOAD` (kW), `SD_LAKH` and `OSD_LAKH`. The last two are **in lakhs** (×1e5 for display). Values are written back onto the raw row.
- **Dates:** as-on is the first non-empty `Date`, shown with `UI.fmtDate` (UI.date default)
- **Offices:** `UI.office(CCC_CODE)` (code only), with fallbacks `_region`/`_divn` 'Unmapped' and `_supp` = the code. Rows are mutated in place. `MzoScope.filterRows` runs on them.
- **Row filters / dedupe / positional:** rows without `CCC_CODE` are dropped. Each row is a **pre-aggregated count** for one combination of dimensions.
- **Aggregations:** stat cards: consumers (live = `CONN_STAT === 'LIVE'`), load, SD, OSD, govt (`GOVT_STAT === 'YES'`). A pivot table with a choice of row and column dimensions (`_region`, `_divn`, `_supp`, `CONN_STAT`, `BASE_CLASS`, `CONN_PHASE`, `CATEGORY`, `GOVT_STAT`, `TYPE_OF_METER`, `CONN_BY`, `TIME_OF_DAY`); Region and Division rows drill. Histograms for status, meter type and connected-by. Select filters for 5 dimensions.
- **Deep links:** none
- **Writes:** none
- **Quirks:** magic misspelt values are mapped for display: `ELECTRIONIC`, `ELECTROMAGNATIC`, `NO METER`, `SMART`, `MANNUAL(GHOST)`. `TIME_OF_DAY` 'T'/'W'/blank → 'Not set'. Status values include `DEEMED DISCONNECTED`, `PERMANENTLY DISCONNECTED`, `TEMPORARY DISCONNECTED`. `GOVT_STAT` is 'YES'/'NO' (in other datasets it is Y/N).
- **Complexity:** S. One dataset with a straight code mapping; the only cleanup is commas.
- **Uniform fields it would use:** `ccc_code`, `date`, `count`, `load`, `sd_lakh`, `osd_lakh`, `conn_stat`, `base_class`, `conn_phase`, `category`, `govt_stat`, `type_of_meter`, `conn_by`, `time_of_day`, `_region`, `_division`, `_ccc_code`, `_ccc`
- **Shared with:** none

### docket.html  (NAV key: docket)
- **Status (2026-11-01):** converted in `8fadb73` (batch C).
- **Kind:** kit (251 lines) · **Loads:** none besides the kit files
- **Datasets:** `docket_calls` via UI.load CACHE_DOCKET (+ UI.refresh)
- **Parser:** UI.csv
- **Raw columns read:** `doc_no`, `ccc_code`, `ccc_name`, `doc_crn_dt`, `prob_type`, `con_id`, `PARTY_NAME`, `Mob_No`, `addr` (d), `DESCRIPTION` (d)
- **Numbers:** none parsed. Open hours = `(Date.now() - created)/36e5`, computed at parse time.
- **Dates:** `doc_crn_dt` goes through custom `when()`: **dd/mm/yyyy hh:mm[:ss]**, with seconds sometimes dotted (`22.44.30`, matched by `[.:]`). As-on is the max created time.
- **Offices:** `UI.office(ccc_code)` (code only). The `_supp` fallback is `UI.title(ccc_name || ccc_code, minus /\s*CCC.*$/i)`. `_region`/`_divn` stay '' when unmapped and show as 'Unmapped' in groups. `MzoScope.filterRows` runs on the mapped rows.
- **Row filters / dedupe / positional:** rows without `doc_no` are dropped
- **Aggregations:** stat cards: open, technical, non-technical (via the exact-string `TECH` list of 27 `prob_type` values), open over 48 h, and repeat consumers (`con_id` with more than one open docket). Custom tabs Region/Division/CCC (open, technical, over 48 h, oldest, share); at CCC level a click sets the CCC filter. An age histogram (<24 h … >30 d) and a top-problems histogram. Filters: problem, age, search.
- **Deep links:** none (the KPI link calls `parent.openPage('docket/kpi.html')`)
- **Writes:** none
- **Quirks:** mixed-case headers (`PARTY_NAME`, `Mob_No`, lowercase `doc_no`). `UI.blank` handles `(NULL)`/NA in the name and mobile. Technical vs non-technical depends on exact problem strings (e.g. `Service(main) problem(OH Line)`). Ages are relative to page load.
- **Complexity:** S. One dataset with a straight code mapping; the custom datetime regex is the only special parsing.
- **Uniform fields it would use:** `doc_no`, `ccc_code`, `ccc_name`, `doc_crn_dt`, `prob_type`, `con_id`, `party_name`, `mob_no`, `addr`, `description`, `_region`, `_division`, `_ccc_code`, `_ccc`
- **Shared with:** none. It links to docket/kpi.html, which uses a different sheet; `DESCRIPTION` means free text here and a 'B' flag there.

### docket/kpi.html  (NAV key: docket_kpi)
- **Status (2026-11-01):** converted in `e2f32b1` (batch C).
- **Kind:** kit (211 lines) · **Loads:** none besides the kit files (no mzo_data_hub.js)
- **Datasets:** `docket_kpi` via fetch `https://docs.google.com/spreadsheets/d/e/2PACX-1vThi-zr48XGYbnQO7YR8xmhVQZV2Wb3t05wTN2kqM254DXNOr5wfeBWNIhywNk2egvpYeSte2EWLLvD/pub?gid=0&single=true&output=csv` (`no-store` on refresh)
- **Parser:** UI.csv
- **Raw columns read:** `ccc_code`, `DESCRIPTION`, `prob_type`, `Count of doc_no`, `Sum of Diff`
- **Numbers:** `Number(d['Count of doc_no']) || 0` and `Number(d['Sum of Diff']) || 0`. Diff is in **days**; the average is sum/count.
- **Dates:** none. The meta line is static ("Closed dockets, Jan 2023 – Jun 2025").
- **Offices:** `UI.office(code)` (code only). Bulk codes `6610000`, `6620000`, `6630000` → `_divn: 'Bulk'`, `_supp: 'Bulk · ' + region`. `MzoScope.filterRows` runs on the mapped rows.
- **Row filters / dedupe / positional:** rows without `ccc_code` are dropped. Rows are a **pre-aggregated pivot** (ccc × problem × type).
- **Aggregations:** stat cards: closed count, average closure, technical average, non-technical average, and the fastest CCC (needs ≥ 20 dockets, excludes bulk). Custom tabs Region/Division/CCC show weighted averages. A by-problem table that also acts as the problem filter. A bulk toggle: All / Excluding / Only.
- **Deep links:** none
- **Writes:** none
- **Quirks:** `DESCRIPTION === 'B'` means technical. The pivot export headers ('Count of doc_no', 'Sum of Diff') come straight from Sheets. The bulk labels differ from collection.html and disconnection.html.
- **Complexity:** S. One small pre-aggregated dataset with a straight code mapping and a bulk rule.
- **Uniform fields it would use:** `ccc_code`, `description`, `prob_type`, `count_of_doc_no`, `sum_of_diff`, `_region`, `_division`, `_ccc_code`, `_ccc`
- **Shared with:** none

### smart_meter/dashboard.html  (NAV key: smart_meter)
- **Status (2026-11-01):** converted in `0175f68` (batch C).
- **Kind:** kit (272 lines) · **Loads:** none besides the kit files (no mzo_data_hub.js)
- **Datasets:** `smart_meter_status` via fetch `https://docs.google.com/spreadsheets/d/e/2PACX-1vSWjwUI4EUgEABlcggpdOS-WSPKY8my-5T0cLxT4h8tNz_IreQy6jUYKBnB5yc0n-fcs8FpVbwo6Qay/pub?gid=327926255&single=true&output=tsv`, and `smart_meter_work_orders` via fetch of the same document with `gid=958431052&…&output=tsv`. Both use `cache: 'no-store'`, with the last good copy kept in the Cache API `mzo-smart-meter-v1` and painted first.
- **Parser:** custom `split('\t')` (`tsv()`): BOM stripped, blank lines dropped, header and values trimmed, no quote handling
- **Raw columns read:** meters: `Meter Supply  Qty.` (two spaces; **holds the meter number**), `con_id`, `ccc_final`, `meter_type`, `Lot`, `Lot_date`, `Meter Installed Qty.  In Field_Active In Hes_` (two spaces), `Total Submit In Ami Portal`, `Remarks` (d), `GENERATION METER` (d), `CHECKED METER` (d). `Zone Name` and `CCC Name` are read but never used. work orders: `WORK_ORDER`, `Date`, `CCC_code`, `NEW_METER_NO`, `CONSUMER_ID` (d), `CON_NAME` (d), `CON_ADDR` (d), `WORK_ORDER_DATE` (d), `OLD_METER_NO` (d), `CONN_LOAD` (d), `CON_CLASS` (d)
- **Numbers:** none. Installed and pushed are **non-empty-string truthiness** (`!!r[...]`), so a cell holding `0` still counts.
- **Dates:** as-on is the first non-empty WO `Date`, through `UI.date`. `Lot_date` is shown through `UI.fmtDate` (UI.date). `WORK_ORDER_DATE` is shown raw.
- **Offices:** page `office(code)` = `UI.office(code)` (code only), with `_supp` falling back to the code; used with `ccc_final` (meters) and `CCC_code` (WO). `MzoScope.filterRows` runs on meters and WOs separately.
- **Row filters / dedupe / positional:** meters are kept when `Meter Supply  Qty.` or `con_id` is set. WOs are kept when `WORK_ORDER` is set. WOs are joined to meters on `NEW_METER_NO` = meter number (the last match wins).
- **Aggregations:** stat cards: work orders, then supplied, installed, pushed to AMI, installed-not-pushed (the last four filter). Custom tabs Region/Division/CCC (WO, supplied, pushed, not pushed, installed %). A meter-type table that doubles as a filter. A lot histogram. Filters: type, lot, search.
- **Deep links:** none
- **Writes:** none (Cache API only)
- **Quirks:** odd headers with double spaces and trailing `_`. The meter-number column is named "Qty.". Flags are truthy strings. TSV without quotes. The sheets export slowly (over a minute), so the page paints the cache first.
- **Complexity:** M. Two direct TSV sources, a custom cache, odd headers, a join, and truthiness flags.
- **Uniform fields it would use:** meters: `meter_supply_qty`, `con_id`, `ccc_final`, `meter_type`, `lot`, `lot_date`, `meter_installed_qty_in_field_active_in_hes`, `total_submit_in_ami_portal`, `remarks`, `generation_meter`, `checked_meter`, `zone_name`, `ccc_name`. work orders: `work_order`, `date`, `ccc_code`, `new_meter_no`, `consumer_id`, `con_name`, `con_addr`, `work_order_date`, `old_meter_no`, `conn_load`, `con_class`. Both plus `_region`, `_division`, `_ccc_code`, `_ccc`.
- **Shared with:** none


## Vendor advances

### capex_all.html  (NAV key: capex_all)
- **Status (2026-11-01):** converted in `e5b04cc` (batch D).
- **Kind:** kit (256 lines) · **Loads:** none (only mzo_theme / mzo_ui / mzo_data_hub / mzo_scope)
- **Datasets:** `capex_details` via UI.load CACHE_CAPEX (+ UI.refresh CACHE_CAPEX; if hub reports error, falls back to direct fetch of the same published CSV URL gid=439685010) · `vendor_map` via `hub.get('CACHE_VENDORS')`, fallback fetch of the published CSV gid=1818971964 · `costcenter` via `hub.get('CACHE_COSTCENTER')`, fallback fetch `/data/costcenter.json` (maps are loaded first; the main render waits for them)
- **Parser:** UI.csv (main + vendor map); JSON for costcenter (accepts either a parsed array or a string → `JSON.parse`)
- **Raw columns read:**
  - capex_details: `Net Balance Value`, `Project ID`, `Material Code`, `Cost Centre`, `Vendor`, `Reporting Date`, `Net Balance Qty`, `Ageing in Days`, `Material description`, `Network`, `Issued Document`, `Issued Date` (d), `Plant` (d)
  - vendor_map: `VENDOR_NO`, `NAME`
  - costcenter: `Cost Cen_Code`, `Unit Name`, `Division Name`
- **Numbers:** local `num(v)` = `parseFloat(String(v).replace(/,/g,''))`, `isFinite` else 0 → `Net Balance Value`, `Net Balance Qty`. `Ageing in Days` = `parseInt(String(x||'0').replace(/,/g,''),10) || 0`. Values can be negative (breakdown keeps groups with `Math.abs(value) >= 1`; filter lists only offer values with `value > 0`; bars use `Math.max(0, v)`).
- **Dates:** `Reporting Date` → `UI.date` (dd.mm.yyyy per sheet_links DOTTED / metadata sync); as-on = max Reporting Date over all rows ("As on …" in meta). `Issued Date` kept raw, shown via `UI.fmtDate` (UI.date) in the drawer, exported raw. Age comes from the sheet's `Ageing in Days`, not computed.
- **Offices:** `Cost Centre` (trimmed, e.g. `C366313090`) looked up exactly in costcenter `Cost Cen_Code` → `{unit: Unit Name, division: Division Name}`. Division: if `Division Name` ends in "division" → strip `\s*division$`, `_divn` = that, `_region` = custom `regionOf(div)` (scan `MzoScope.HIERARCHY[r].divisions[div]`); else division = `UI.title(divRaw)` and `_divn`/`_region` = ''. Unmapped → division 'Unknown', unit 'Unknown unit'. Unit label = `UI.title(Unit Name)` with Ccc→CCC, Ss→SS, Kv→kV, Dtr→DTR. `_supp` = `MzoScope.cccNameOf(unit without " CCC")` only when Unit Name ends in "CCC". `MzoScope.filterRows(all)` is called on the mapped rows (uses `_region`/`_divn`/`division`/`_supp`).
- **Row filters / dedupe / positional:** keep rows where `r['Net Balance Value'] !== undefined && (r['Project ID'] || r['Material Code'])`. No dedupe, no positional reads.
- **Aggregations:** 5 stat buttons = sum of value (+ line count, % of total) for age > 0/180/365/730/1095 days (Outstanding, Over 6 months, Over 1 year, Over 2 years, Over 3 years); clicking sets an "over" filter. "Outstanding by" tabs Division / Unit / Vendor / Material (custom tabs, not UI.drill): sum value, Over-1-year sum, line count, share; clicking a row sets that filter (Division click also switches to the Unit tab). Ageing table: 8 buckets (<6m, 6–12m, 12–18m, 18–24m, 2–3y, 3–4y, 4–5y, >5y), click toggles an age filter. Cascading selects Division → Unit → Vendor → Material; search over project / network / document / material / material code. Lines table + CSV export.
- **Deep links:** none
- **Writes:** none
- **Quirks:** `Division Name` values look like "Balurghat Division" (suffix stripped); unknown vendor shown as `Unknown vendor (<code>)`; vendor codes are matched as exact trimmed strings (keep leading zeros, so the vendor code must stay a string); cost-centre codes have a `C` prefix and must stay strings; search lowercases the query but compares network / document / material code case-sensitively; the main sheet URL is duplicated in the page (same as the DataHub URL).
- **Complexity:** M — three datasets (main + vendor map + cost-centre JSON), custom office mapping through cost centre, age buckets.
- **Uniform fields it would use:** net_balance_value, project_id, material_code, cost_centre, vendor, reporting_date, net_balance_qty, ageing_in_days, material_description, network, issued_document, issued_date, plant; vendor_map: vendor_no, name; costcenter: cost_cen_code, unit_name, division_name; plus `_region`, `_division`, `_ccc` (via cost centre → unit / division)
- **Shared with:** advance_onm.html (near-identical code block: `num`, `unitName`, `regionOf`, `maps()`, `hubText`, AGE/OVER stats, dim tabs; both read vendor_map + costcenter). sheet_links.html also parses CACHE_CAPEX `Reporting Date` (dd.mm.yyyy) for its as-on label. No page-specific JS file.

### advance_onm.html  (NAV key: advance_onm)
- **Status (2026-11-01):** converted in `5818883` (batch D).
- **Kind:** kit (246 lines) · **Loads:** none (only mzo_theme / mzo_ui / mzo_data_hub / mzo_scope)
- **Datasets:** `onm_advance` via direct fetch `https://docs.google.com/spreadsheets/d/e/2PACX-1vQPBYq0ZQpaAnu0Mp_qN5oGvklgIpjolyRPf3LfSojRaN-GBBBXKHslR9ue1DOv1432oP2PzYznUUmn/pub?gid=512034300&single=true&output=csv` (no DataHub key; refresh uses `cache: 'no-store'`) · `vendor_map` via `hub.get('CACHE_VENDORS')`, fallback CSV fetch · `costcenter` via `hub.get('CACHE_COSTCENTER')`, fallback `/data/costcenter.json`
- **Parser:** UI.csv (main + vendor map); JSON (costcenter, string or array)
- **Raw columns read:**
  - onm_advance: `Order Number`, `Resp. CCtr`, `Plant`, `Creation Date`, `Vendor`, `Mat Balance(Value)`, `Description`
  - vendor_map: `VENDOR_NO`, `NAME`
  - costcenter: `Cost Cen_Code`, `Unit Name`, `Division Name`
- **Numbers:** `num(v)` = `parseFloat(String(v).replace(/,/g,''))`, `isFinite` else 0 → `Mat Balance(Value)`. Age computed: `Math.max(0, Math.ceil((Date.now() - created) / 864e5))`, 0 if no date.
- **Dates:** `Creation Date` → `UI.date` (dd.mm.yyyy per sheet_links / metadata sync DOTTED). As-on = max Creation Date over all rows (shown as "As on …", so it is really the newest order date). Raw string kept for CSV export.
- **Offices:** `Resp. CCtr` looked up exactly in costcenter `Cost Cen_Code` → unit / division (same rules as capex: strip " division", `_divn`, `_region` via custom `regionOf` over `MzoScope.HIERARCHY`). If there is no cost-centre match: `MzoScope.divisionNameOf(Plant)` (4-digit plant = division prefix) → division (treated as a real division). Unmapped → 'Unknown' / 'Unknown unit'. `_supp` = `MzoScope.cccNameOf(unit without " CCC")` when Unit Name ends in CCC. `MzoScope.filterRows(all)` is called.
- **Row filters / dedupe / positional:** keep rows with a truthy `Order Number`. No dedupe.
- **Aggregations:** 5 stat buttons: value sums + order counts for age > -1/180/365/730/1095. Tabs Division / Unit / Vendor (custom tabs, click a row to filter; Division switches to Unit). Ageing: 7 buckets (<6m, 6–12m, 1–2y, 2–3y, 3–4y, 4–5y, >5y). Cascading selects Division → Unit → Vendor; search over order no. / work / vendor. Orders table + CSV export.
- **Deep links:** none
- **Writes:** none
- **Quirks:** the cost-centre column here is `Resp. CCtr` (capex uses `Cost Centre`); the Plant-code fallback uses the 4-digit division prefix; vendor and cost-centre codes must stay strings; the main sheet is fetched on every load (not cached in DataHub). sheet_links / mzo_metadata_sync.gs know it as `OM_ADVANCE`, dateColumn `Creation Date`.
- **Complexity:** M — three sources, custom cost-centre / plant office mapping, computed age.
- **Uniform fields it would use:** order_number, resp_cctr, plant, creation_date, vendor, mat_balance_value, description; vendor_map: vendor_no, name; costcenter: cost_cen_code, unit_name, division_name; plus `_region`, `_division`, `_ccc`
- **Shared with:** capex_all.html (same code block and the same vendor_map + costcenter maps). sheet_links.html fetches the same CSV for its `Creation Date` as-on label. No page-specific JS file.


## Substation & network

### power_map/map.html  (NAV key: power_map)
- **Status (2026-11-01):** converted in `c49254c` (batch E); `ec5478b` (final) adds the Filters button on phones.
- **Kind:** legacy (5389 lines) · **Loads:** `../mzo_data_hub.js` (relative path) + CDN: Leaflet 1.9.4, PapaParse 5.3.2, typed.js 2.1.0, Leaflet.PolylineMeasure 3.0.0, jsPDF 2.5.1, html2canvas 1.4.1. Does **not** load mzo_ui.js, mzo_scope.js or auth.js. No power_map/*.js files exist (the folder holds only map.html, nh_sh_crossings.html, streetview_overlay.html).
- **Datasets:**
  - `power_map_substations` via `mzoDataHub.retryDataset('CACHE_POWER_MAP')` + `mzoDataHub.get('CACHE_POWER_MAP')`; if empty, direct `fetch('/api/power-map/data', {credentials:'same-origin'})` and then `mzoDataHub.set('CACHE_POWER_MAP', rawText)`. Server: Supabase table `mzo_power_substations` rebuilt as CSV, falling back to the published sheet `…2PACX-1vT8hYE6YBbfVQDJhgB3cIWqrrGrjMQAQ22mcmCJTOa995gCH-xBAfsAPpBvNYS1KlYIFMRHM59iGB7K/pub?output=csv`. Retried up to 3 times.
  - `power_map_taps` via direct fetch `https://docs.google.com/spreadsheets/d/e/2PACX-1vT8hYE6YBbfVQDJhgB3cIWqrrGrjMQAQ22mcmCJTOa995gCH-xBAfsAPpBvNYS1KlYIFMRHM59iGB7K/pub?gid=2098159409&single=true&output=csv` (same `fetchCSV`, no hub).
  - pending corrections via `/api/power-map/pending-corrections` (server JSON `{status, data}`, from Supabase table `mzo_power_corrections` with `status=eq.pending`). This table is not in the brief's list (it is `mzo_power_*`, not `power_map_*`).
  - Non-tabular: WestBengal.geojson from raw.githubusercontent.com; OSM Overpass POSTs (EHV lines / roads overlays) to overpass-api.de / overpass.kumi.systems.
- **Parser:** `Papa.parse(trimmed, { header: true, dynamicTyping: false, skipEmptyLines: true })` for both CSVs; server JSON for corrections (`proposed_value` JSON-parsed for `add_substation`).
- **Raw columns read:**
  - power_map_substations: `Substation`, `LATITUDE`, `LONGITUDE`, `Region`, `Division`, `Remarks`, `Comment`, `Connected to`, `RL`, `ConductorSize`, `PeakLoad`, `LineStyle`, `Colour`, `MVA` (d), `Para-1` (d, "Loading"), `Para-2` (d, "Voltage"), `Para-3` (d, "Remarks"), `Symbol` (d), `SymbolSize` (d). The server also emits `LegendText`, `LegendSymbol`, `LegendColour` (not read).
  - power_map_taps: `TappedSubstation`, `SourceFeederStart`, `SourceFeederEnd`, `TapPointLatitude`, `TapPointLongitude`, `LineStyle`, `Colour`
  - corrections JSON: `type`, `substation`, `column_name`, `connection_target`, `proposed_value`
- **Numbers:** `dmsToDecimal()` for `LATITUDE` / `LONGITUDE` / `TapPointLatitude` / `TapPointLongitude`: plain decimal via `/^[+-]?\d+(\.\d+)?$/` → parseFloat, else DMS like `N25°00.026'` (degrees + decimal minutes/60, negative for S/W), NaN if neither. `SymbolSize` → `parseInt` if `!isNaN`, default 18. `RL` per connection: `parseRouteLengthKm` = parseFloat after removing commas and `km` (summed once per SS pair for the "route km" stat); `formatRouteLength` treats `N/A`, `-`, `--` as blank, keeps values that already carry km/m, else appends " km". `MVA`, `PeakLoad`, `ConductorSize` stay strings.
- **Dates:** none (only `new Date().toISOString()` for the PDF filename).
- **Offices:** `Region` and `Division` used as raw trimmed strings for checkbox facets (plus `Remarks`); region value `TCL` (case-insensitive) is split out as its own checkbox and left out of the Region "All" report. No MzoScope and no scope filtering at all. Edit rights: `localStorage.mzo_user_profile` → role 'admin', or `division_code` / `region_code` (lowercased) equal to `entry.Division` / `entry.Region` (lowercased).
- **Row filters / dedupe / positional:** a body starting with `{` or `<` is treated as an error / login page (redirects to /login.html on 401 or login HTML). Substations kept only if `LATITUDE` and `LONGITUDE` both parse via dmsToDecimal; the Supabase path on the server also drops rows without Substation / LATITUDE / LONGITUDE. Taps skipped unless tapped SS, source start/end and coordinates are valid and the tapped SS is on the map. Duplicate Substation names: `substationMap` keeps the last row; the report's `entryByName` keeps the first. Filtering: blank Region / Division / Remarks always pass; `Comment === 'blue'` (proposed SS) is hidden when "show proposed" is off.
- **Aggregations:** network stats bar: SS count, solid / dashed connection counts, tap count, total route km (unique pairs). Filter checkboxes with counts per Region / Division / Remarks; per-value report modal (grouped by `Remarks`, rows sorted by Region → Division → Substation, columns MVA / Para-1/2/3, plus a connectivity list built from outgoing `Connected to`, incoming references from other rows and taps); Tapping Sources report (division taken from the tapped SS row). SS label toggles (GSS = name contains "GSS").
- **Deep links:** no incoming URL params. Outbound Google Street View link per SS (`cbll=lat,lng`).
- **Writes:** `POST /api/admin/edit-sheet-row` (substation fields MVA / Para-1 / Para-2 / Para-3 with rowKeyColumn 'Substation'; connection fields ConductorSize / PeakLoad / RL with `connectionTarget`); `POST /api/admin/append-sheet-row` (new SS row); `POST /api/admin/add-connection`; all with spreadsheetId `1nBLLL3zc3OjuJ6umq3uQVmjXCPhlVATYhQX1BlfqS2w`. The response may be `isSuggestion` (stored as a pending correction). Also `mzoDataHub.set('CACHE_POWER_MAP', …)` (cache write) and in-memory updates (connection edits rejoined with `' : '`).
- **Quirks:** headers are case-sensitive and mixed style (`LATITUDE`, `Connected to`, `Para-1`, `LineStyle`, `SymbolSize`). `Connected to`, `RL`, `ConductorSize`, `PeakLoad` are colon-separated lists matched by index (split on `:` and trim); these must stay raw strings and not be number-coerced. Coordinates may be DMS strings, so they must not be blindly turned into numbers. `Comment` holds the marker colour (`blue` = proposed SS, `green` = GSS, `red` = existing); `LineStyle === 'dashed'` = proposed line; `Colour` = line colour; the `Para-*` popup labels differ from the column names; the `Remarks` facet column is separate from `Para-3`. The new-SS form reads a Division but does not write Region / Division into rowData (writes `Para-3: "CCC: <ccc>"`). The page reads the hub with `retryDataset` + `get`, not `waitForDataset` / `_peek`.
- **Complexity:** L — very large legacy map page, two CSVs plus server JSON, DMS / colon-list parsing, many write paths, no kit scripts loaded.
- **Uniform fields it would use:** substation, latitude, longitude, region, division, remarks, comment, connected_to, rl, conductorsize, peakload, linestyle, colour, mva, para_1, para_2, para_3, symbol, symbolsize; taps: tappedsubstation, sourcefeederstart, sourcefeederend, tappointlatitude, tappointlongitude, linestyle, colour; (corrections JSON stays server JSON). `_region` / `_division` could come from `Region` / `Division` text (the page does not map offices today).
- **Shared with:** admin_users.html (also fetches `/api/power-map/data`, lists CACHE_POWER_MAP as source "Supabase", and handles the admin pending-corrections endpoints); server.js builds the CSV. No shared page JS file. nh_sh_crossings.html uses a similar Leaflet / Papa / WestBengal.geojson pattern but shares no code file.

### power_map/nh_sh_crossings.html  (NAV key: highway_crossings)
- **Status (2026-11-01):** converted in `081de67` (batch E); `ec5478b` (final) adds the Filters button on phones.
- **Kind:** legacy (1575 lines) · **Loads:** none of the kit besides mzo_theme.js; CDN Leaflet 1.9.4, PapaParse 5.3.2, Leaflet.PolylineMeasure 3.0.0 (no mzo_ui / mzo_data_hub / mzo_scope / auth)
- **Datasets:** `highway_crossings` via direct fetch `https://docs.google.com/spreadsheets/d/e/2PACX-1vQTy_LCddlFuzZx9ZyJQTLbqrQ8sb76DG4jyw8ys-s_w6LDxOYhnTTY49eddhqxb9RnTAbksh32y1bH/pub?gid=870376934&single=true&output=csv`. Non-tabular: WestBengal.geojson (GitHub raw), Nominatim reverse geocode per marker click.
- **Parser:** `Papa.parse(csvText, { header: true, dynamicTyping: true, skipEmptyLines: true })`
- **Raw columns read:** `Division`, `CCC`, `NH/SH`, `Voltage Level`, `DTR Required`, `Status`, `Approx. UG Cable required (m)`, `Number of Span (HT)`, `Number of Span (LT)`, `R/L HT-11kV (in m)`, `R/L HT-33kV (in m)`, `R/L LT (in m)`, `Approx. OH-HT required (m)`, `Approx. OH-LT required (m)`, `ID`, `e-note no.`, `Lat`, `Long`; the popup also lists every other column of the row (d)
- **Numbers:** Papa `dynamicTyping: true` turns numeric-looking cells into numbers. `num = v => parseFloat(v) || 0` for spans / lengths / cable (sums); `Lat` / `Long` via `parseFloat` (marker skipped if NaN); `'Approx. UG Cable required (m)' > 0` gives the derived "UG Cable Required" Yes/No facet. Material summary: UG km = sum/1000; HT conductor km = OH-HT × 3 × 1.03 / 1000; LT conductor km = OH-LT × 4 × 1.03 / 1000 (toFixed(3)).
- **Dates:** none
- **Offices:** `Division` and `CCC` are raw trimmed strings used as checkbox facets; no mapping, no MzoScope, no scope filtering (every user sees every row).
- **Row filters / dedupe / positional:** none at load; rows without numeric Lat/Long get no marker but still count in facets / reports; blank facet values always pass the filters.
- **Aggregations:** filter panel summary "Total Loc / Total X-ing" (X-ing = sum of HT + LT spans); facet counts for Division, CCC, NH/SH, Voltage Level, DTR Required, UG Cable Required (derived), Status; per-value and overall report modals with breakdowns by every other facet (count, HT/LT spans, HT length = 11kV + 33kV R/L, LT length, UG / OH-HT / OH-LT) + material summary; report CSV export. Colour-by radio (Voltage Level / Status / NH/SH); search by `ID` or `e-note no.`.
- **Deep links:** no incoming params. Builds an outbound `streetview_overlay.html?lat=&lng=&id=&division=&ccc=&enote=` link (opens in a new tab).
- **Writes:** none
- **Quirks:** with dynamicTyping, a `Voltage Level` like `33` or `11` becomes a number and `getStyleForVoltage` (which checks `typeof level === 'string'`) then falls back to purple "Other"; likewise `ID` / `e-note no.` may be numbers (compared via `String()`). `DTR Required` counts as "required" unless (lowercased) blank, `no`, `n/a`, `not required` or `0`. Status containing `e-note not prepared` is highlighted red; `NH/SH` is upper-cased for colour (`NH`, `SH`). Column names contain `/`, `.`, `()` and units.
- **Complexity:** M — single dataset with no office mapping, but a large bespoke legacy page with Papa dynamic typing and custom report maths.
- **Uniform fields it would use:** division, ccc, nh_sh, voltage_level, dtr_required, status, approx_ug_cable_required_m, number_of_span_ht, number_of_span_lt, r_l_ht_11kv_in_m, r_l_ht_33kv_in_m, r_l_lt_in_m, approx_oh_ht_required_m, approx_oh_lt_required_m, id_2, e_note_no, lat, long; `_division` / `_ccc` could come from `Division` / `CCC` text
- **Shared with:** power_map/streetview_overlay.html (receives its URL params). admin_users.html lists the same sheet URL as "Highway Crossings" (catalogue only). No shared JS file.

### prt-oil/index.html  (NAV key: prt_oil)
- **Status (2026-11-01):** not converted: later (its Map tab is only reachable through Apps Script, so it cannot be mirrored).
- **Kind:** legacy (1771 lines) · **Loads:** none of the kit besides mzo_theme.js; CDN Bootstrap 5.3.0 bundle, jsPDF 2.5.1, PapaParse 5.4.1, jspdf-autotable 3.5.28 (no mzo_ui / mzo_data_hub / mzo_scope / auth)
- **Datasets:**
  - Apps Script `https://script.google.com/macros/s/AKfycbxhEdt6LWidyEwq0VUoHv55vSXX1DyWbAHqEppFA1X59j43mlgfxS1NVhXNdz5KpVbe/exec?action=getInitialData` → JSON `{ map, ptrs }` (apps-script/prt_oil.gs: `getSheetData("Map")`, `getSheetData("ptrs")`). `ptrs` = `prt_transformers`; **`map` = the "Map" tab (Region / Division / Substation list), which is not in the brief's dataset list.**
  - `prt_oil_tests` via direct fetch `https://docs.google.com/spreadsheets/d/e/2PACX-1vRtpueyQwlq63VP2Tm2_vITV31jKBSceDGJQVJtYeqVVDBSg3QAHzLKrv60i6Z9oODXXzOE-fdfMb8b/pub?gid=906452022&single=true&output=csv` ("testingrecords"), fetched twice: in `fetchData()` and again on the "Not tested in 3 months" alert button.
  - `prt_transformers` again via direct fetch `…/pub?gid=0&single=true&output=csv` (View PTRs tab, `loadPTRs()`).
- **Parser:** JSON (Apps Script; values from `getValues()` so numbers and dates are typed, dates serialised to ISO strings); `Papa.parse(csvText, { header: true, skipEmptyLines: true })` for the test records in fetchData; custom `split("\n")` + `split(",")` with all `"` stripped for the ptrs CSV (loadPTRs) and for the test-records CSV on the alert button.
- **Raw columns read:**
  - Map (Apps Script): `Region`, `Division`, `Substation`
  - ptrs (Apps Script and CSV): `Region`, `Division`, `Substation`, `Equipment`, `Make`, `Capacity (MVA)`, `Serial No.`, `Year of Manufacture`, `Impedance Voltage %` (d); the test form copies every other ptrs key into the record
  - testingrecords: `Substation`, `Division`, `Equipment`, `Capacity (MVA)`, `Sample Testing Date`, `Observations`, `Specific Resistance at 27 °C (ohm-cm)`, `Specific Resistance at 90 °C (ohm-cm)`; PDF / detail (d): `Region`, `Make`, `Serial No.`, `Year of Manufacture`, `Sample Collection Date`, `Sample Collected By`, `Source Referance`, `Oil Sample Position`, `Physical Appearance`, `Testing Referance`; the detail modal and PDF table dump every other key (d), e.g. `Density (gm/CC)`, `BDV with 2.5mm Gap (kV)`, `Acidity (mg of KOH/gm)`, `Tan δ at 27 °C`, `Tan δ at 90 °C`, `Dielectric Disssipation Factor (tan δ)` (older records), `Moisture Content (PPM)`, `IFT (mN/m)`, `Oil Type`
- **Numbers:** `Specific Resistance at 27/90 °C (ohm-cm)` → `parseFloat`, shown as `(num / 1e12).toFixed(3) + ' × 10¹²'` (stored in the sheet as full ohm-cm; the form multiplies the input by 1e12 before writing). Other test values are shown raw; form thresholds use parseFloat. The PTR duplicate check compares `Capacity (MVA)` / `Year of Manufacture` as trimmed strings.
- **Dates:** `Sample Testing Date`: sort uses `raw.includes('/') ? new Date(raw.split('/').reverse().join('-')) : new Date(raw)` (dd/mm/yyyy → yyyy-mm-dd, parsed as UTC); display `formatDateToDDMMYYYY` accepts yyyy-mm-dd (from `<input type="date">`) or dd/mm/yyyy, else `new Date`; the alert button parses dd/mm/yyyy (or `new Date` if it contains '-') and flags tests older than now − 3 months. Form dates are written as yyyy-mm-dd, so the sheet mixes yyyy-mm-dd and dd/mm/yyyy. `Sample Collection Date` is display only.
- **Offices:** `Region` / `Division` / `Substation` are raw strings from the Apps Script Map tab feeding cascading selects (exact `===` matches); ptrs are filtered by exact `p.Region` / `p.Division` / `p.Substation`; loadPTRs groups by `Division` → `Substation` ('Unknown' fallback). No MzoScope, no scope filtering.
- **Row filters / dedupe / positional:** the alert button skips lines whose comma count differs from the header (`cols.length !== headers.length`), so a quoted comma drops the row; loadPTRs' naive split misaligns rows with quoted commas. Papa `skipEmptyLines`. Sorting throws if `Sample Testing Date` is missing (`.includes` on undefined).
- **Aggregations:** none numeric; reports table sorted by testing date (desc), "outdated" list (> 3 months), PTR cards grouped Division → Substation; single-record PDF.
- **Deep links:** none
- **Writes:** Apps Script `POST action=submitTestRecord` and `POST action=addPTR` (form-urlencoded `data=<JSON>`; appended by header into the "testingrecords" / "ptrs" tabs).
- **Quirks:** header typos must be kept exactly (`Referance`, `Disssipation`); non-ASCII headers (`°`, `δ`, `Ω`) — under the ASCII snake rule `Tan δ at 27 °C` → `tan_at_27_c` (if the library treats Unicode letters as alphanumeric it would be `tan_δ_at_27_c`; decide once). `Observations` is multi-line (first line in the table). Papa is loaded after the main script but only used after DOMContentLoaded. The PTR tab is reached two ways (Apps Script JSON with typed values vs published CSV with strings), so `Serial No.` is compared with `String().trim()`.
- **Complexity:** L — legacy page with three sources (Apps Script JSON + two published CSVs, one parsed three ways), mixed date formats, two write paths, PDF.
- **Uniform fields it would use:** Map: region, division, substation; ptrs: region, division, substation, equipment, make, capacity_mva, serial_no, year_of_manufacture, impedance_voltage; testingrecords: substation, division, region, equipment, make, capacity_mva, serial_no, year_of_manufacture, sample_testing_date, sample_collection_date, sample_collected_by, source_referance, testing_referance, oil_sample_position, physical_appearance, observations, specific_resistance_at_27_c_ohm_cm, specific_resistance_at_90_c_ohm_cm, density_gm_cc, bdv_with_2_5mm_gap_kv, acidity_mg_of_koh_gm, tan_at_27_c, tan_at_90_c, dielectric_disssipation_factor_tan, moisture_content_ppm, ift_mn_m, oil_type; `_region` / `_division` could come from Region / Division text
- **Shared with:** apps-script/prt_oil.gs (backend for getInitialData / addPTR / submitTestRecord). admin_users.html and sheet_links.html list the gid=0 PTR CSV (links only). No shared page JS file.

### feeder_outage.html  (NAV key: feeder_outage)
- **Status (2026-11-01):** converted in `358246b` (batch D).
- **Kind:** kit (365 lines) · **Loads:** none (only mzo_theme / mzo_ui / mzo_data_hub / mzo_scope)
- **Datasets:** `feeder_outage` via `mzoDataHub._peek('CACHE_FEEDER_OUTAGE')` (paint from cache) then `waitForDataset('CACHE_FEEDER_OUTAGE', { forceCheck: true })` + `_peek` on every load (the published CSV has no ETag)
- **Parser:** UI.csv
- **Raw columns read:** `REPORT MONTH`, `FEEDER NAME`, `CIRCLE NAME`, `DIVISION NAME`, `TOTAL DURATION OF OUTAGE OVER 5 MIN`, `TOTAL COUNT OF OUTAGE OVER 5 MIN`, `SUBSTATION NAME`, `FEEDER CODE`, `FEEDER CATEGORY`, `NATURE OF FEEDER`, `FEEDER FLAG`. All read through `pick(row, name)`: exact key first, then a match after lowercasing and dropping non-alphanumerics, so header variants are tolerated.
- **Numbers:** `parseFloat(x.replace(/,/g,'')) || 0` for duration (minutes) and count; hours = minutes / 60; daily = hours / days-in-month (`new Date(y, m, 0).getDate()`, default 30).
- **Dates:** `REPORT MONTH` → `replace(/\D/g,'').slice(0,6)` = yyyymm string (row dropped if < 6 digits); labels via MON[] ("Apr 2025"). Latest month → writes `localStorage.mzo_feeder_outage_as_on` = last day of that month as dd/mm/yyyy (`Date.UTC`). The meta line shows the first–latest month range.
- **Offices:** region = `MzoScope.regionNameOf(CIRCLE NAME)` || `UI.title(CIRCLE NAME)`; division = `MzoScope.divisionNameOf(DIVISION NAME)` || `UI.title(DIVISION NAME)`; no CCC. Rows carry `region`, `division`, `REGION_NORM`, `DIVISION_NORM`. `MzoScope.filterRows(rows)` (in try/catch); `UI.lockScope()` pins the region / division selects for scoped users.
- **Row filters / dedupe / positional:** `prepare` rejects the text unless `/REPORT MONTH/i` appears in the first 2000 chars; rows without month or feeder are dropped; per feeder (key = `FEEDER CODE` || `feeder|substation|division`) only the first row per month is kept.
- **Aggregations:** stats: Feeders (count), Avg daily outage, Monthly range (min–max of the per-month average across months, or across feeders when there is one month), Yearly average (latest year), Concern count (last month daily ≥ 1 h, or count ≥ 30, or rising ≥ 1.5× and +2 h vs previous month; a toggle). Level tabs All / Region / Division / Substation / Feeder (custom drill: a row click sets the filter and goes one level down); line chart of average hours per feeder by month (top 12 for SS / feeder); table with daily / per month / outages / range / year avg / trend; month picker; selects Region → Division → Substation, plus Category (R/U/M), Nature (A/O/I/`__blank`), Scheme; search; CSV export.
- **Deep links:** none
- **Writes:** `localStorage.mzo_feeder_outage_as_on` only
- **Quirks:** `FEEDER CATEGORY` / `NATURE OF FEEDER` are upper-cased one-letter codes (R/U/M, A/O/I; blank nature is a separate filter value); `FEEDER FLAG` is shown as "scheme"; `REPORT MONTH` is a yyyymm month, not a day date, so the library should not force it into an ISO day (or should give the month separately). The feeder `code` field sits under a key MzoScope's collectCodes scans (`code`), so a feeder code containing `66[123]dddd` could pass scope by accident.
- **Complexity:** M — one dataset, but custom CIRCLE→region / division mapping, yyyymm handling, per-feeder dedupe and multi-level drill.
- **Uniform fields it would use:** report_month, feeder_name, circle_name, division_name, total_duration_of_outage_over_5_min, total_count_of_outage_over_5_min, substation_name, feeder_code, feeder_category, nature_of_feeder, feeder_flag, plus `_region`, `_division`
- **Shared with:** sheet_links.html (parses CACHE_FEEDER_OUTAGE `REPORT MONTH` the same way and writes the same `mzo_feeder_outage_as_on` key). No page-specific JS file.


## Important

### cmo.html  (NAV key: cmo)
- **Status (2026-11-01):** converted in `cc61edf` (batch D).
- **Kind:** kit (225 lines) · **Loads:** none (mzo_theme / mzo_ui / mzo_data_hub only; **mzo_scope.js is not loaded**)
- **Datasets:** `cmo_grievances` via UI.load CACHE_CMO (+ UI.refresh CACHE_CMO)
- **Parser:** UI.csv
- **Raw columns read:** `District`, `Report Date`, `Pending With`, `Grievance Since`, `Police Station`, `Name`, `Applicant Name & Mobile Number`, `Phone`, `Received Date & Time` (d), `Block/ Municipality`, `GP/ Ward`, `Grievance Category`, `Grievance Description`, `Status` (d), `Assign To` (d), `Last ATN` (d), `Last ATN Remarks`
- **Numbers:** `Grievance Since` → `parseInt(x, 10)`, null if not finite (age in days).
- **Dates:** as-on = `Report Date` of the first row that has one → `UI.fmtDate` (UI.date; format not pinned in code — sheet_links takes the string max of the same column). `Received Date & Time` raw, display only. Ages come from `Grievance Since`, not computed.
- **Offices:** only `District`, which must be exactly one of `Malda`, `Uttar Dinajpur`, `Dakshin Dinajpur` (trimmed); no region / division / CCC mapping, no MzoScope.filterRows (no scope filtering: every user sees all three districts).
- **Row filters / dedupe / positional:** rows whose District is not one of the three are dropped. No dedupe.
- **Aggregations:** stats: Grievances (all), Pending (not disposed, oldest days), Pending 3 months+ (days ≥ 90), Disposed / with HQ (`Pending With` === `Disposed / pending with HQ`); each acts as a status filter. "Pending with" table by officer or police station (pending count, ≥ 90 days, oldest; click filters); histograms by district and by category (top 6); selects District / Pending with / Category / Age (≥ N×30 days); search; CSV export.
- **Deep links:** none
- **Writes:** none
- **Quirks:** `clean()` blanks `UI.blank` values plus `none` / `not known`; Police Station falls back to 'Not known'; Name falls back to `Applicant Name & Mobile Number` with trailing phone digits stripped (`/[\d\s\-+]{8,}$/`); description cleanup removes `{#…#}` tokens, `_x000D_`, runs of 4+ `-=_`, and collapses whitespace; category short labels are keyed on exact long strings (including the source typo `Appoinment`). Contains personal data (names, phones).
- **Complexity:** S — one dataset, straight mapping, no office logic.
- **Uniform fields it would use:** district, report_date, pending_with, grievance_since, police_station, name, applicant_name_mobile_number, phone, received_date_time, block_municipality, gp_ward, grievance_category, grievance_description, status, assign_to, last_atn, last_atn_remarks; `_region` could come from District (UI.regionName aliases: Uttar Dinajpur→Raiganj, Dakshin Dinajpur→Balurghat), which would also allow scope filtering
- **Shared with:** sheet_links.html (reads CACHE_CMO `Report Date` for its as-on label). No page-specific JS file.

### pmsgy.html  (NAV key: pmsgy)
- **Status (2026-11-01):** converted in `b2e8ec5` (batch D).
- **Kind:** kit (334 lines) · **Loads:** none (only mzo_theme / mzo_ui / mzo_data_hub / mzo_scope)
- **Datasets:** `pmsgy_malda`, `pmsgy_uttar_dinajpur`, `pmsgy_dakshin_dinajpur` via `waitForDataset(CACHE_PMSGY_MALDA / _UD / _DD)` (with `{forceCheck:true}` on refresh; the datasets are lazySync) then `_peek` each; rows concatenated
- **Parser:** UI.csv
- **Raw columns read:** `Application Number`, `Consumer Name`, `Consumer Number`, `Mobile (Masked)` | `Mobile Number` | `Mobile` (first non-empty), `Consumer Category`, `Category`, `Current Stage`, `Sub Status of Current Stage`, `Connection Phase` (d), `Vendor Name`, `Installed Capacity (in kW)`, `Net Metering Date`, `Last Action Date`, `Agreement Upload Date`, `Installation Status`, `Division Name`, `Sub-Division Name`; plus the first column's value (`row[Object.keys(row)[0]]`) for row skipping. All via `pick(row, keys)`: case-insensitive match on the trimmed header, first non-empty value.
- **Numbers:** `Installed Capacity (in kW)` → `parseFloat(x) || 0`. Mobile `phone()`: if it looks like scientific notation (`9.87E+09`), rebuild the digits and pad the missing ones with `•`.
- **Dates:** custom `parseDate`: `dd-Mon-yy(yy)` (e.g. 05-Mar-25) or `dd[./-]mm[./-]yy(yy)`; anything else → null (no yyyy-mm-dd). `Net Metering Date` → `net` (connected = parsed), `Last Action Date` → `last` (sort column), `Agreement Upload Date` → only whether it parses. As-on = max `last` over all rows, computed **before** `MzoScope.filterRows`, so it is not scoped.
- **Offices:** region comes from which tab the row is in (MALDA→Malda, UD→Raiganj, DD→Balurghat), not from a column. CCC = `Sub-Division Name` with a trailing ` CCC` removed → `MzoScope.cccNameOf` → `parentOfCcc` gives division + ccc; if no parent: division = `MzoScope.divisionNameOf(Division Name)` || raw, ccc = the cccNameOf result (which returns the raw text when unmatched). Rows carry `REGION`, `DIVISION`, `CCC NAME`, `REGION_NORM`, `DIVISION_NORM`, `CCC_NORM`. `MzoScope.filterRows(rows)`; `UI.lockScope()` pins the selects.
- **Row filters / dedupe / positional:** a tab is ignored unless `/application number/i` appears in its first 800 chars; drop rows whose first cell is blank or equals `logic` (glossary row); drop rows without `Application Number`. No dedupe across tabs.
- **Aggregations:** stats: Applications (+ RWA count), Vendor assigned, Agreement, Installed (`/installation completed/i` on `Installation Status`), Connected (net metering date parsed), as % of applications; each is a step filter. Breakdown tabs Region / Division / CCC / Vendor / Stage (custom drill: an office row sets the filter and the tab moves down; Stage = Current Stage + Sub Status, click filters); funnel histogram; "installed but not connected" gap by the next office level; category segment (Residential-Self / RWA / Other from `Consumer Category` + `Category` text: welfare|rwa → RWA, self → Residential-Self); selects Region → Division → CCC → Vendor; search; CSV export.
- **Deep links:** none
- **Writes:** none
- **Quirks:** email and bank columns must stay off the page (docs/reports.md; the page keeps only the fields above), so a uniform-rows library delivering every column must not leak them into the display or export. Blank stage / sub-status become `'Blank'`; blank vendor becomes 'No vendor'; a CCC that is not mapped is shown as 'CCC pending' in the CCC tab. Mobile numbers arrive masked or in scientific notation. Two date styles (dd-Mon-yy and dd/mm/yyyy).
- **Complexity:** M — three datasets, region taken from the tab, custom CCC→division mapping, custom date / phone parsing, drill tabs.
- **Uniform fields it would use:** application_number, consumer_name, consumer_number, mobile_masked, mobile_number, mobile, consumer_category, category, current_stage, sub_status_of_current_stage, connection_phase, vendor_name, installed_capacity_in_kw, net_metering_date, last_action_date, agreement_upload_date, installation_status, division_name, sub_division_name, plus `_region` (from the dataset), `_division`, `_ccc`
- **Shared with:** sheet_links.html (parses the same three tabs' `Last Action Date` with the same dd-Mon-yy / dd/mm/yyyy logic for its as-on labels). No page-specific JS file.

### si-works/si.html  (NAV key: si_works)
- **Status (2026-11-01):** not converted: typed Supabase JSON with writes and a permission model on raw strings; uniform rows would add only aliases (its schema exists for the rating metrics only).
- **Kind:** legacy (3837 lines) · **Loads:** CDN bootstrap@5.3.0 (css + bundle), bootstrap-icons@1.10.0, jspdf 2.5.1, jspdf-autotable 3.5.28, ESM `@supabase/supabase-js@2` (also `../auth.js`). Does NOT load mzo_ui / mzo_data_hub / mzo_scope.
- **Datasets:** `si_works` via Supabase table `prioritySI` (schema `mzo_insight`, supabase-js `createClient(SUPABASE_URL, anon key)` hardcoded in the page): `fetchData()` → `client.from('prioritySI').select('*')`; `editRecord(id)` re-reads one row `.select('*').eq('id', id).single()`. Plus `/api/session-check` (GET, JSON) for the portal profile (`role`, `si-autho`/`si_autho`, `si-divisions`/`si_divisions`, `Username`, `Name`), cached in localStorage `mzo_user_profile`.
- **Parser:** JSON (supabase-js rows; keys are the Postgres column names, which are the original sheet headers with spaces/punctuation).
- **Raw columns read:** `id`, `Region`, `Division`, `Scheme Head`, `Related SS`, `Name of Scheme`, `Priority`, `Status`, `TAA Value (Rs.)`, `Billed Value till date (Rs.)`, `Target Date`, `TAA Date`, `updated_at`, `TAA No.`; display/form only (d): `Existing Parameter (Capacity/RL/Size)` (d), `Proposed Parameter (Capacity/RL/Size)` (d), `Loading (%) / Peak Load (A)` (d), `Major Material Requirement` (d), `eOffice ref.` (d), `Presently with` (d), `Detail Work Status` (d). CSV export dumps every key of the row (`Object.keys(records[0])`).
- **Numbers:** `TAA Value (Rs.)`, `Billed Value till date (Rs.)` via `parseMoneyRs`: `Number(String(v).replace(/,/g,'').trim())`, returns `null` for blank/non-finite (no `|| 0`). Shown as ₹ Th / Lakh / Cr (`formatRsCompact`). No sums of money anywhere; only counts.
- **Dates:** `Target Date`, `TAA Date`: expected `yyyy-mm-dd` (from `<input type="date">`), shown via `formatDate` → `dd/mm/yy`; any other format is shown unchanged. `updated_at`: timestamp via `new Date()`, shown `dd/mm/yyyy hh:mm AM/PM`, and shown as `--` when it falls on today ("placeholder creation date"). Max `updated_at` per Scheme Head on the overview. No as-on cell.
- **Offices:** no MzoScope / UI.office. `Division` holds short names (`Balurghat`, `Buniadpur`, `Islampur`, `Raiganj`, `Chanchal`, `Gazole`, `Malda`). Two hardcoded maps that disagree on region names: `regionDivisionMap` {`Dakshin Dinajpur`: [Balurghat, Buniadpur], `Uttar Dinajpur`: [Islampur, Raiganj], `Malda`: [Malda, Gazole, Chanchal]} is used for permissions and is matched against the row's `Region` column; `regionDefinitions` (repeated 5 times: buildRegionTabs, updateRegionTabCounts, filterAndRenderTable, CSV and PDF export) {`Dakshin Dinajpur`, `Raiganj`, `Malda`} drives the region tabs from `Division`, not from `Region`. Scope comes from the profile (`si-divisions`), not from `MzoScope.filterRows`. Viewers (no edit rights) see all rows; editors with a division list see only rows where `Region` ∈ allowed regions AND `Division` ∈ their divisions.
- **Row filters / dedupe / positional:** none. No dedupe. Blank `Status` / `Related SS` are bucketed as `Not yet updated`.
- **Aggregations:** Card (default) view: an overview table grouped by `Scheme Head`, sorted by the `SCHEME_CONFIG` letter. It counts total, completed (`Status` includes `completed`), in progress (includes `in progress`), pending (includes `pending`) and not initiated (everything else; added into Pending), plus a progress %, a grand total row and the max updated_at. Header counters: total schemes, completed. Top tabs: Region (All / Dakshin Dinajpur / Raiganj / Malda, by Division), Priority (All + distinct `Priority`, default `Phase-I`), Division chips. Sidebar checkbox facets with live counts: `Scheme Head`, `Status`, `Related SS`. Free-text search over TABLE_COLUMNS. Table paginated 15 per page. Exports: CSV and PDF (jsPDF autotable).
- **Deep links:** none.
- **Writes:** Supabase `prioritySI` `insert(record)`, `update(record).eq('id')` and `delete().eq('id')` from the edit modal; a cost-only `update({ 'TAA Value (Rs.)', 'Billed Value till date (Rs.)' }).eq('id')` from the detail modal. All go direct from the browser with the anon key.
- **Quirks:** the Supabase URL and anon JWT are hardcoded in the HTML. Region naming is inconsistent: the `Region` column must literally be `Uttar Dinajpur` / `Dakshin Dinajpur` / `Malda` for editor scoping, while the tab says `Raiganj`. Neither matches the canonical MzoScope names (Malda / Raiganj / Balurghat). Priority badge treats `'1'/'2'/'3'` or `high/medium/low`. Status values are a fixed list in the form (`Proposal not initiated`, `Approval pending`, `TAA issued, work yet to start`, `Work in progress`, `Completed`), but grouping uses substring matches. Writes use the raw spaced column names, so uniform snake_case keys must not leak into write payloads.
- **Complexity:** L. A very large legacy Bootstrap page with Supabase reads and writes and a permission model tied to raw `Region`/`Division` strings. The data is already typed JSON, so the shared library would add only snake_case aliases and `_region`/`_division`.
- **Uniform fields it would use:** `id_2`, `region`, `division`, `scheme_head`, `related_ss`, `name_of_scheme`, `existing_parameter_capacity_rl_size`, `proposed_parameter_capacity_rl_size`, `loading_peak_load_a`, `major_material_requirement`, `taa_no`, `taa_date`, `taa_value_rs`, `billed_value_till_date_rs`, `priority`, `eoffice_ref`, `presently_with`, `detail_work_status`, `target_date`, `status`, `updated_at`, plus `_region`, `_division` (from `Division` short names; no CCC).
- **Shared with:** none (page-specific code is all inline; `auth.js` is the common auth file).

### accident/accident.html  (NAV key: accident)
- **Status (2026-11-01):** converted in `8967cde` (batch E).
- **Kind:** legacy (1698 lines) · **Loads:** nothing beyond mzo_theme.js / mzo_theme.css (no mzo_ui, data hub or scope).
- **Datasets:** `accident_reports` via `fetch('https://docs.google.com/spreadsheets/d/e/2PACX-1vRrrGeyElvh8i8QzTl25Ej7_RJZ9FJ0jicG3tAhguLEvky178oKZ8-QADKcBceUQ5CFjn7hd9eECVJ6/pub?output=csv')` (first tab, no gid, no cache options).
- **Parser:** custom `parseCSV`: `text.trim().split('\n')`, then `parseCSVLine` per line (a quote char toggles inQuotes; `""` escapes are not handled; a quoted field with a newline breaks the row). Headers `.trim()`, values `.trim()` (which also strips `\r`).
- **Raw columns read:** `Name of the Region`, `Accident Id`, `Date of Accident`, `Fatality On Enquery`, `Nature of Injury`, `Inquiry Submitted on`, `Name of Division / RE Project`, `Name of CCC/ Substation/ RE Project`, `Name of victim`, `Accident Location`, `Age of Victim`, `Type of Victim`, `Category of Victim`, `Cause of Accident`, `Accident in Voltage Class`, `Pending since last status change(days)` (dead path). Victim drawer only (d): `Victim Id`, `Victim Status`, `Status Description`, `Type of Injury`, `Type of Animal`, `Type of property`, `Name of Owner of Animal/ property`, `Address of victim/ Owner of Animal`, `Name of Outsourced Agency`, `Type of job performed`, `Skilled or Not`, `Coverage under ESI or Not`, `Post Morten Attached`, `Incident submitted by (Reporting officer`, `CUG No of Reporting officer`, `Authorised or not`, `Working System in Voltage Class`, `Addl. Casue of Accident`, `Inquiry Accepted on`, `Incident Disposed on`, `Payment Released on`.
- **Numbers:** `Age of Victim` → `parseFloat`, NaN dropped (average age of `Type of Victim` = `human` rows). Everything else is counted; `Pending since last status change(days)` is only tested for truthiness.
- **Dates:** `Date of Accident` via `parseDMY`: split on `/` into dd, mm, yyyy, then `new Date(\`${yyyy}-${mm}-${dd}\`)`. With 2-digit parts this is an ISO string parsed as UTC midnight; single-digit parts give a non-ISO string parsed per engine; a time suffix (`dd/mm/yyyy hh:mm`) makes it invalid → null. `Inquiry Submitted on` is parsed the same way, inline in `generateAnalytics`, to get the average days from accident to inquiry per region. Header shows the data span min–max `Date of Accident` with a "N Years, M Months" duration. Month labels come from `toLocaleString('default', {month:'short'})`, which is locale-dependent.
- **Offices:** names only, no codes. `Name of the Region` must be one of `VALID_REGIONS` = `Malda (D) Region`, `Dakshin Dinajpur (D) Region`, `Raiganj (D) Region`, `Uttar Dinajpur (D) Region`; other rows are dropped. `_mappedRegion` = `Raiganj (D) Region` for `Uttar Dinajpur (D) Region`, else unchanged. The "Uttar Dinajpur" tab filters `_mappedRegion === 'Raiganj (D) Region'` via `regionKey()`. Division = `Name of Division / RE Project`, unit/CCC = `Name of CCC/ Substation/ RE Project`, with whitespace collapsed and the first letter uppercased for grouping. No MzoScope.filterRows. `UI.regionName` aliases don't cover the `"(D) Region"` forms, so the shared lib needs aliases like `malda (d) region` → Malda, `dakshin dinajpur (d) region` → Balurghat, `uttar dinajpur (d) region` / `raiganj (d) region` → Raiganj. Division/CCC names may carry "RE Project" values that won't map.
- **Row filters / dedupe / positional:** drops rows with a blank `Accident Id`. Dedupe keeps the FIRST row per `Accident Id`. The sheet is victim-level (`Victim Id`), so extra victims of the same accident are dropped. Region whitelist as above.
- **Aggregations:** Region tabs Zone / Malda / Uttar Dinajpur (incl. Raiganj) / Dakshin Dinajpur. Stat cards: Total Accidents (count), Fatal Accidents (`Fatality On Enquery` = `yes` OR `Nature of Injury` = `fatal`, case-folded), Pending Inquiries (blank `Inquiry Submitted on`). A card click opens a breakdown modal grouped by Division or Unit (modal tabs `division` / `unit`). A group click lists its victims; a victim click opens the drawer. Timeline: monthly (month-of-year across all years, top 3 highlighted) or yearly; a cell click opens the reverse breakdown (month → years, year → months). Universal search (≥2 chars) on `Name of victim` / `Accident Id` / `Accident Location`, first 25 results. "Analytics summary" accordion per region: fatality rate (`Nature of Injury` = Fatal only), average human age, voltage class %, inquiries pending, top 3 divisions, top 3 causes, category %, average inquiry delay by region, top cause for `Category of Victim` = `outsourced`, top 10 police stations parsed from `Accident Location` with regex `/P[.\s-]*S[.\s:-]*([\w\s]+)/gi`.
- **Deep links:** none.
- **Writes:** none.
- **Quirks:** header typos are load-bearing: `Fatality On Enquery`, `Post Morten Attached`, `Addl. Casue of Accident`, and `Incident submitted by (Reporting officer` with its parenthesis never closed. Fatal is defined differently by the stat card (either column) and the analytics (`Nature of Injury` only). The `recent` and `response` card paths are dead (no such cards exist; `titleMap` has no `recent`). Search and analytics use `processedData`, i.e. the deduped and region-whitelisted rows. `accident/map.html` is a Looker Studio iframe and does not read this sheet.
- **Complexity:** M. One dataset and no writes, but a bespoke CSV parser, a bespoke dd/mm/yyyy parser, a name-only region whitelist/merge, first-row dedupe, and ~35 raw header references to rename.
- **Uniform fields it would use:** `name_of_the_region`, `accident_id`, `date_of_accident`, `fatality_on_enquery`, `nature_of_injury`, `inquiry_submitted_on`, `name_of_division_re_project`, `name_of_ccc_substation_re_project`, `name_of_victim`, `accident_location`, `age_of_victim`, `type_of_victim`, `category_of_victim`, `cause_of_accident`, `accident_in_voltage_class`, `pending_since_last_status_change_days`, `victim_id`, `victim_status`, `status_description`, `type_of_injury`, `type_of_animal`, `type_of_property`, `name_of_owner_of_animal_property`, `address_of_victim_owner_of_animal`, `name_of_outsourced_agency`, `type_of_job_performed`, `skilled_or_not`, `coverage_under_esi_or_not`, `post_morten_attached`, `incident_submitted_by_reporting_officer`, `cug_no_of_reporting_officer`, `authorised_or_not`, `working_system_in_voltage_class`, `addl_casue_of_accident`, `inquiry_accepted_on`, `incident_disposed_on`, `payment_released_on`, plus `_region` (from region name), `_division` / `_ccc` (name match only, best effort; no `_ccc_code` source).
- **Shared with:** none.

### safety_inspection.html  (NAV key: safety_app)
- **Status (2026-11-01):** converted in `971ff37` (batch D).
- **Kind:** kit (279 lines) · **Loads:** nothing beyond kit (mzo_theme, mzo_ui, mzo_data_hub, mzo_scope).
- **Datasets:** `safety_inspection` via `UI.load('CACHE_SAFETY_v2')` (+ `UI.refresh('refreshBtn', 'CACHE_SAFETY_v2')`). The DataHub URL is gviz `…/1A2fjKboWKnw10iaOs1wcXDrdg9jhhDGfzF9OagPjA5s/gviz/tq?tqx=out:csv`, lazySync.
- **Parser:** UI.csv
- **Raw columns read:** `Site ID`, `Inspection ID`, `Office`, `Location`, `Description`, `Inspection By`, `Entered on`, `Inspected on` (d), `Rectification done by` (d), `Rectification done on`, `Remarks` (d), `Status` (d, shown as "App status"), `Image` (d).
- **Numbers:** none parsed (only counts; "Per week" = count / span-in-weeks).
- **Dates:** `UI.date` on `Entered on`, `Inspected on`, `Rectification done on` (UI.date: dd-mm-yyyy / dd.mm.yyyy / dd/mm/yyyy [hh:mm], yyyy-mm-dd [hh:mm], else `new Date`). `UI.days(entered)` gives the pending age. The span is min..max of entered and rectified dates and sets `weeks`. "This week" means entered on or after the current Monday. The monthly chart keys months as yyyymm. No as-on cell.
- **Offices:** code = trailing `(\d+)` in `Office` (regex `/\((\d+)\)\s*$/`), then `UI.office(code)` (no name passed) → `_region`, `_divn`, `_supp`; `CCC_CODE` = code. Display name = `UI.title(Office minus the "(code)")`. Unmapped offices land in an `Unmapped` bucket in the office table. `MzoScope.filterRows(all)` is called on the built rows; then `UI.offices(all)` + `UI.lockScope()`.
- **Row filters / dedupe / positional:** dedupe on the "Count by" key (`Site ID` by default, or `Inspection ID`). The FIRST row per key is kept; rows with a blank key all collapse to one.
- **Aggregations:** stat buttons Inspected (all), Rectified (has `Rectification done on`), Pending (no rectification date; default list filter); non-button stats Per week (inspected/rectified ÷ weeks) and This week. Office table with Region / Division / CCC tabs and a custom `drill()` (sets selects and moves down a level; not UI.drill), showing Inspected, Pending, Rectified %, This week, Per week and Last inspection. "Pending by issue" histogram by category derived from `Description` keywords (`spacer` → Spacer, `lt kiosk`, `ht 11 kv`, `ht 33 kv`, `lt`/`low tension` → Other LT, else Other) that also filters. Monthly line chart: inspected (by entered month) vs rectified (by rectification month). Search over location + description + inspector + office. Export CSV.
- **Deep links:** none.
- **Writes:** none.
- **Quirks:** done-ness comes only from a parseable `Rectification done on`; the `Status` column is ignored for logic. Keys use the old kit names `_divn` / `_supp` (not `_division` / `_ccc`). Codes longer than 7 digits are cut to the last 7 by UI.office. Category matching is case-folded substring and order-sensitive (`lt kiosk` is tested before generic `lt`).
- **Complexity:** S. One dataset with UI.csv/UI.date/UI.office already. Only the code-from-`Office` regex and the dedupe toggle are custom.
- **Uniform fields it would use:** `site_id`, `inspection_id`, `office`, `location`, `description`, `inspection_by`, `entered_on`, `inspected_on`, `rectification_done_by`, `rectification_done_on`, `remarks`, `status`, `image`, plus `_region`, `_division`, `_ccc_code`, `_ccc` (code from `office` trailing parentheses).
- **Shared with:** none.

### manpower.html  (NAV key: manpower)
- **Status (2026-11-01):** not converted: sensitive (staff data and PINs), never mirrored.
- **Kind:** kit (268 lines) · **Loads:** none besides mzo_theme/mzo_ui. Note it does NOT load mzo_data_hub or mzo_scope.
- **Datasets:** `manpower_pins` (sensitive) via `fetch(SHEET + '2073511562', {cache:'no-store'})`, and `manpower_staff` (sensitive) via `fetch(SHEET + '2110628491', {cache:'no-store'})` after the PIN passes. `SHEET` = `https://docs.google.com/spreadsheets/d/e/2PACX-1vRRXojudL5q-ln7pXOcbLaGsBqznppnvsINcp8xEFvpJUWRCiC7bjii9eZYSu0istzyM91m4yybd5g-/pub?single=true&output=csv&gid=`.
- **Parser:** pins: custom `text.split(/\r?\n/).slice(1)`, each line through `UI.csv('a,b\n' + line)[0].b`, i.e. column B by position with the real header ignored. Staff: `UI.csv`, then keys re-trimmed (redundant).
- **Raw columns read:** pins: column B (positional). Staff: `Name`, `Employee No`, `Designation`, `Class`, `Profit Center Name`, `Profit Center Code`, `Cost Center Name`, `Cost Center Code`, `Legacy ID`, `Date of joining`, `Date of Retirement`. Drawer only (d), via `FIELDS`: `Position`, `Date of Increment`, `IFSC Code`, `Bank Account No`, `Payscale Group`, `Payscale Level`, `Pay`, `Grade Pay`, `Dearness Allowance`, `House Rent Allowance`, `Gross Salary`, `PF A/C Number`, `PF Trust ID`, `Lock Status`.
- **Numbers:** none parsed. Pay and allowance columns are shown raw in the drawer. PIN compare: exact string, or `Number(p) === Number(v)` when both are all-digits (so leading zeros are ignored).
- **Dates:** `toDate()` on `Date of Retirement`, `Date of joining` (and every `/^Date of/` field in the drawer, including `Date of Increment`). Blank or `NA`/`N/A` → null. 5-digit (optionally fractional) values are Excel serials → `new Date(Date.UTC(1899,11,30) + serial*864e5)` (UTC midnight). Anything else goes through `UI.date` (dd/mm/yyyy etc.). Birthday is positional from `Legacy ID`: only 10-char IDs, `slice(4,6)` = month and `slice(6,8)` = day, for this year (next year if already past), shown if within 7 days. `retDays = Math.round((ret - localMidnightToday)/864e5)`, which mixes UTC and local midnights. Service length is computed from join date.
- **Offices:** no region/division/CCC mapping. Grouping uses `Profit Center Name || Profit Center Code` (`pc`) and `Cost Center Name || Cost Center Code` (`cc`). No MzoScope.filterRows: login scope is not applied at all; access is the PIN gate only. If the profit/cost center codes are WBSEDCL office codes, `UI.office(code)` could fill `_region`/`_division`/`_ccc`; this is unverified.
- **Row filters / dedupe / positional:** rows with a blank `Name` are dropped. The PIN sheet's first line is skipped and column B is read by position.
- **Aggregations:** stat buttons Employees (subtitle = distinct designations), Retiring in 3 months (0 < retDays ≤ 90), Retiring in a year (≤ 365), Birthdays this week. "Strength" table with tabs Designation / Profit center / Cost center (staff count, retiring-in-a-year count, share bar); a row click toggles the matching filter. Side lists: Retiring soon (≤ 182 days, top 8) and Birthdays (top 8). Filters: profit center (cascades cost center + designation), cost center, designation, class, and search on name + employee no. Export CSV.
- **Deep links:** none.
- **Writes:** none.
- **Quirks:** the PIN list is read client-side from a public published CSV, so the "gate" is cosmetic. Designation blank → `Not set`. Header variants come only as `Name || Code` fallbacks. Excel-serial detection is limited to exactly 5 digits.
- **Complexity:** M. Two sensitive sheets, a positional PIN read, custom Excel-serial/positional-birthday date logic, and no office scope (the shared lib must not force scope rows it cannot map).
- **Uniform fields it would use:** staff: `employee_no`, `name`, `profit_center_code`, `profit_center_name`, `cost_center_code`, `cost_center_name`, `legacy_id`, `position`, `designation`, `class`, `date_of_joining`, `date_of_retirement`, `date_of_increment`, `ifsc_code`, `bank_account_no`, `payscale_group`, `payscale_level`, `pay`, `grade_pay`, `dearness_allowance`, `house_rent_allowance`, `gross_salary`, `pf_a_c_number`, `pf_trust_id`, `lock_status`. Pins: second column (header unknown, positional). No office fields unless codes are verified.
- **Shared with:** none.

### Upkeeping/index.html  (NAV key: upkeeping)
- **Status (2026-11-01):** not converted: no data (a link to an external app).
- **Kind:** kit (21 lines, static) · **Loads:** none (only mzo_theme.js/css).
- **Datasets:** none. The page is a static link-out button to `https://mzowbsedcl-dev.github.io/Upkeeping/` (external app). It does not read `substation_upkeeping`; if a mirror dataset exists, only the external app uses it.
- **Parser:** n/a
- **Raw columns read:** none
- **Numbers / Dates / Offices / Row filters / Aggregations:** n/a
- **Deep links:** none.
- **Writes:** none.
- **Quirks:** none.
- **Complexity:** S. Static link.
- **Uniform fields it would use:** Uniform: not applicable.
- **Shared with:** none.

### dtr/index.html  (NAV key: dtr)
- **Status (2026-11-01):** converted in `36710dd` (batch E); `a83ce53` (final) drills the CCC level on the canonical `_ccc`.
- **Kind:** legacy (939 lines) · **Loads:** CDN bootstrap@5.3.0 (css + bundle), font-awesome 6.0.0-beta3. No mzo_ui, data hub or scope.
- **Datasets:** `dtr_records` via `fetch('https://docs.google.com/spreadsheets/d/e/2PACX-1vRZPPnIF-T7wgii6J35a-3Wz7RC86Zq-eMSQud795CVJV-92Vy9oJjO6TDpjpgiLNAVPcVn6X_keILV/pub?gid=2125422147&single=true&output=csv')`.
- **Parser:** custom: `csvText.split('\n')` (blank lines dropped), header `lines[0].split(',')` with `.trim()` and all `"` removed; each row `split(',')` the same way. Rows whose cell count ≠ header count are silently dropped, which includes any row with a quoted comma.
- **Raw columns read:** `REGION`, `DIVN NAME`, `SUPP_OFF`, `SS_NAME`, `FDR_NAME`, `CAPA_KV`, `DTR_CODE`, `LOC_NAME`, `CAT`; the detail modal lists every column of the row (d).
- **Numbers:** `CAPA_KV` → `parseFloat(...) || 0`; summed as kVA, shown `x.xx kVA` or `/1000 → x.xx MVA` (`formatCapacity`). The capacity-level drill filter compares `parseFloat(item.CAPA_KV) === parseFloat(filter)`. Capacity-wise totals are `parseFloat(name) * count`. Percent shares use `toFixed(2)`.
- **Dates:** none.
- **Offices:** raw text columns `REGION` → `DIVN NAME` → `SUPP_OFF` (CCC). The CCC display/group key drops the last 12 characters of `SUPP_OFF` when it is longer than 12 (`slice(0,-12).trim()`; presumably a code suffix, check the data, it may hold the CCC code). The drill filter keeps the first full `SUPP_OFF` value seen per truncated key. No UI.office / MzoScope; no login scope is applied.
- **Row filters / dedupe / positional:** blank lines and column-count-mismatched rows are dropped; no dedupe.
- **Aggregations:** overall DTR count (rows) and total capacity. Custom 7-level drill `REGION → DIVN NAME → SUPP_OFF → SS_NAME → FDR_NAME → CAPA_KV → DTR_LIST`, each level showing DTR count, capacity sum, % share of count and % share of capacity, with a footer total. A "Capacity" shortcut button appears on REGION / DIVN NAME / SS_NAME rows. A direct-level select jumps to any level unfiltered. Breadcrumb buttons; sortable headers. The DTR list shows `DTR_CODE`, `LOC_NAME`, `CAT`, and a DTR click opens the detail modal.
- **Deep links:** none.
- **Writes:** none.
- **Quirks:** naive comma split (no quote handling, `"` stripped everywhere). Header names are upper-case with a space in `DIVN NAME`. Filter matching is strict string equality on raw (untrimmed-except-split) values. Two distinct `SUPP_OFF` values that share a prefix after truncation merge into one row.
- **Complexity:** M. One dataset, but a broken bespoke parser, a custom drill with the SUPP_OFF suffix truncation, and no office mapping or scope.
- **Uniform fields it would use:** `region`, `divn_name`, `supp_off`, `ss_name`, `fdr_name`, `capa_kv`, `dtr_code`, `loc_name`, `cat`, plus `_region`, `_division`, `_ccc` (and `_ccc_code` if the 12-char `SUPP_OFF` suffix is a code).
- **Shared with:** no shared code. Same published spreadsheet (other gid) as dtr/load.html; the URL is also listed in sheet_links.html and admin_users.html.

### dtr/load.html  (NAV key: dtr_load)
- **Status (2026-11-01):** converted in `6b9f07b` (batch E).
- **Kind:** legacy (1981 lines) · **Loads:** CDN jquery 3.6.0, DataTables 1.13.6 (+ bootstrap5 css/js), FixedHeader 3.4.0, Buttons 2.4.2 (+ html5, print), JSZip 3.10.1, Responsive 2.5.0, bootstrap@5.3.2 (css twice + bundle), font-awesome 6.4.0. No mzo_ui, data hub or scope.
- **Datasets:** `dtr_peak_load` via `fetch(updateDataSheetUrl)` = `…/2PACX-1vRZPPnIF-T7wgii6J35a-3Wz7RC86Zq-eMSQud795CVJV-92Vy9oJjO6TDpjpgiLNAVPcVn6X_keILV/pub?gid=1835924766&single=true&output=csv`. It is fetched fresh three separate times: pre-fill the form, the confirm check, and the "all data" modal. The DTR master record comes from Apps Script GET `https://script.google.com/macros/s/AKfycbwzaD7imXDsD3gWhxRXf9kx01NHKrzyXZGsBg2-azotO26PjybS-3R07Vyuh7Wscy1UIw/exec?action=search&code=<code>` (JSON `{status, data}`; one row of the master DTR sheet, not in the dataset list). Access: the signed-in profile's `dtr-autho` (comma-separated DTR code prefixes; an admin with none, or `Y`/`ALL`/`*`, gets every code).
- **Parser:** custom `parseCSV`: `split('\n')`, then per line a regex `/(?:"([^"]*(?:""[^"]*)*)"|([^,]*))(?:,|$)/g`, which handles quotes and `""` but not embedded newlines. Values `.trim()`. Rows with fewer values than headers are dropped. Apps Script search is JSON.
- **Raw columns read:** peak load: `DTR_CODE`, `DATE_OF_MEASUREMENT`, `NEW_LOC_NAME`, `NEW_FDR_NAME`, `NEW_CAPA_KV`, `LOAD_R`, `LOAD_Y`, `LOAD_B`, `LOAD_N`, `KIOSK`, `LA`, `NEUTRAL_FLAT_EARTHING`, `REMARKS`. The all-data DataTable shows every column (d). KPI header variants: `KIOSK || kiosk || Kiosk`, `LA || la`, `NEUTRAL_FLAT_EARTHING || neutral_flat_earthing`. Apps Script master (JSON): every key displayed (d); the form pre-fill uses `LOC_NAME`, `FDR_NAME`, `CAPA_KV`, `LOAD_R`, `LOAD_Y`, `LOAD_B`, `LOAD_N`, `KIOSK`, `LA`, `NEUTRAL_FLAT_EARTHING`, `REMARKS`.
- **Numbers:** sheet values are not parsed (shown raw). The form's `LOAD_R/Y/B/N` are sent as `parseFloat(...) || 0` in the POST payload. `NEW_CAPA_KV` carries units (`10kVA`, `25kVA`, `63kVA`, `100kVA`: the form's select values).
- **Dates:** `DATE_OF_MEASUREMENT` via `parseDateTime`: first `/(\d{2})\/(\d{2})\/(\d{4})[\sT](\d{2}):(\d{2})(?::(\d{2}))?/` as dd/mm/yyyy hh:mm[:ss]. Otherwise `new Date(str)`, so a date-only `dd/mm/yyyy` or one with a 1-digit part is parsed as MM/DD by the engine. Used to pick the latest update per DTR (sort desc). Converted back to `YYYY-MM-DDTHH:mm` local for the datetime-local input. Measurement date validation: not in the future (the UI says 15 days, but only the future check exists). The DataTable default-sorts the date column desc, probably as text (DataTables does not detect dd/mm/yyyy dates).
- **Offices:** none. Access scoping is by DTR code prefix: `DTR_CODE.toUpperCase().startsWith(any dtrAutho prefix)` (search, submit and all-data list). No MzoScope. If the prefixes are office codes, `_ccc_code`/`_division` could derive from `DTR_CODE`; this is unverified.
- **Row filters / dedupe / positional:** all-data view: rows without `DTR_CODE` or outside the user's prefixes are dropped. Per-DTR "latest" = max `DATE_OF_MEASUREMENT`. Adding a new entry is refused when a DTR already has ≥ 4 records; "Replace Last Entry" is allowed instead.
- **Aggregations:** KPI cards over DataTable rows matching the current search: Total Records, No Kiosk, No LA, No Flat Earthing (`isEmpty` regex `/^no|n\/a|na$/i`, or `/^no$/i` for flat). Tabs All / No Kiosk (`KIOSK` ≠ `Ok`) / No LA (`LA` ≠ `Ok`) / No Flat Earthing (`NEUTRAL_FLAT_EARTHING` ≠ `Yes`) via DataTables regex column search; the Over-Loaded tab shows a static message only. CSV button (DataTables).
- **Deep links:** none.
- **Writes:** POST Apps Script `scriptUrl` with body JSON `{DTR_CODE, DATE_OF_MEASUREMENT, NEW_LOC_NAME, NEW_FDR_NAME, NEW_CAPA_KV, LOAD_R, LOAD_Y, LOAD_B, LOAD_N, KIOSK, LA, NEUTRAL_FLAT_EARTHING, REMARKS, isReplacingData}`.
- **Quirks:** the `isEmpty` regex has a precedence bug: it matches anything starting with `no`, containing `n/a`, or ending in `na`. The code goes into the Apps Script URL unencoded. Day/month order is ambiguous for date-only values (see Dates). Capacity in the peak-load sheet is text with a `kVA` unit, while the master `CAPA_KV` is numeric. Magic values: `Ok`, `No kiosk`, `Damaged`, `No LA`, `Defective`, `Yes`/`No`.
- **Complexity:** M. One CSV (fetched three times) plus Apps Script JSON. The bespoke parser and date parser need replacing; the writes and PIN flow stay as they are.
- **Uniform fields it would use:** `dtr_code`, `date_of_measurement`, `new_loc_name`, `new_fdr_name`, `new_capa_kv`, `load_r`, `load_y`, `load_b`, `load_n`, `kiosk`, `la`, `neutral_flat_earthing`, `remarks` (no office fields unless DTR code prefixes are mapped).
- **Shared with:** no shared code. Same spreadsheet (other gid) as dtr/index.html.

### health_checkup.html  (NAV key: health_checkup)
- **Status (2026-11-01):** not converted: no data (placeholder page).
- **Kind:** kit (16 lines, static placeholder) · **Loads:** none (only mzo_theme.js/css).
- **Datasets:** none ("Records are not available yet.").
- **Parser:** n/a
- **Raw columns read:** none
- **Numbers / Dates / Offices / Row filters / Aggregations:** n/a
- **Deep links:** none.
- **Writes:** none.
- **Quirks:** none.
- **Complexity:** S. Empty placeholder.
- **Uniform fields it would use:** Uniform: not applicable.
- **Shared with:** none.

### puja.html  (NAV key: puja)
- **Status (2026-11-01):** not converted: no tabular data (embedded sheets).
- **Kind:** legacy (553 lines; pure embed) · **Loads:** `/mzo_present.js` (desktop presentation zoom; puja.html is its only loader), CDN font-awesome 6.5.0, Google Fonts Inter.
- **Datasets:** none parsed. It iframes six Google Sheets chosen by year pills: Format-I 2025 (`/spreadsheets/d/1EGhWifLAYcnX6ZKVxPxtpxafdCrk_ueR67ObR9vDUM8/edit?gid=0`), Format-I 2026 (`/d/e/2PACX-1vT4MqI8y1hron59lymFqAcv-s1GUtZbQrTagrXfmNgsg16Pad1at-5BcLZTfcRP00d7k8SExO4FV21p/pubhtml`, default), Format-II 2025 (`/d/1Jh5-C7HXNoByxaGvzb8kBku1ov_HqwDS_wID-sS85Pk/edit?gid=0`), Format-II 2026 (`/d/e/2PACX-1vSe6UXoMQ0CIYX38GKifEdQqulDRgZgknQUOo2f1wm6AID9ezqSRzsR17SLIC3pjaMsnf0ISbEZQTYz/pubhtml`), Hourly Load 2025 (`/d/1lkQlOv4sWzSTIOKAkem-oJmEvA7RNTLT0w-tsKi-_kI/edit?gid=0`), Hourly Load 2026 (`/d/1-9z4sry_mHbVg5jDFn5kkOHRtWqXwjqVD00ysOoxT3I/edit?gid=1276887615`). These correspond to the mirror's `puja_format_1_2025` … `puja_hourly_load_2026`, but the page uses them only as `pubhtml?widget=true&chrome=false` or `/htmlview` embeds plus Excel/PDF export links (`pub?output=xlsx|pdf` or `export?format=xlsx|pdf[&gid]`).
- **Parser:** n/a (iframe).
- **Raw columns read:** none
- **Numbers / Dates / Offices / Row filters / Aggregations:** n/a
- **Deep links:** none.
- **Writes:** none.
- **Quirks:** theme comes from localStorage `theme` (not the kit). `/edit` URLs are rewritten to `/htmlview`.
- **Complexity:** S. Embed only.
- **Uniform fields it would use:** Uniform: not applicable (unless the page is rebuilt to render the `puja_*` datasets as tables).
- **Shared with:** none (`mzo_present.js` has no other loader).

### stock/index.html  (NAV key: stock)
- **Status (2026-11-01):** converted in `3688550` (batch E).
- **Kind:** legacy (303 lines HTML + 3.8k lines JS; `class="ui"` but no mzo_ui) · **Loads:** `/stock/stock_material_category.js`, `/stock/stock_pole_count.js`, `/stock/script.js`, `/stock/allotment.js`, `/stock/allotment_view.js`, `/stock/style.css`, CDN papaparse 5.3.0, jspdf 2.5.1 (umd), html2canvas 1.4.1. Loads mzo_data_hub.js but NOT mzo_ui or mzo_scope.
- **Datasets:** `stock_snapshot` via `mzoDataHub._peek('CACHE_STOCK')`, else `waitForDataset` then `_peek`; a background `waitForDataset` re-renders on `'updated'`. Fallback `Papa.parse('/api/stock/dataset', {download:true, header:true})`. Before load it calls `mzoDataHub.refresh('CACHE_STOCK')` once when localStorage `mzo_stock_pending_refresh === '1'` (set by upload.html). `stock_materials` via `_peek` / `waitForDataset('CACHE_STOCK_METADATA')`, fallback `Papa.parse(METADATA_URL, {download:true, header:true})` with `https://docs.google.com/spreadsheets/d/1wDvPuAxNfdO9QzUaIUubg2JnkFM5ZleFNXQdi8s5uh0/export?format=csv&gid=696716331`. `stock_allotments` via POST `/api/stock/allotment` `{action:'listAllotments', force}` (server JSON `{rows, source}`; the server reads Supabase `stock_allotments`, with a legacy sheet / Apps Script fallback). `/api/session-check` (profile flags, allotment.js).
- **Parser:** `Papa.parse(text, {header:true, skipEmptyLines:true})` for cached bodies. The network fallbacks use `{download:true, header:true}` without `skipEmptyLines`. Allotments are server JSON.
- **Raw columns read:** stock_snapshot: `Plant`, `Store`, `Name 1`, `Material`, `Material Description`, `Material Group`, `Base Unit of Measure`, `Unrestricted`, `Category`, `Date` (the CSV also has `Material Type`, `Storage Location`, `Descr. of Storage Loc.`, `Stock in Transit`, `Transit and Transfer`; all unread). stock_materials: `Mat Code`, `Category` (used); `Mat Desc`, `UOM`, `Material Price` (parsed into `materialMetadata` but never used). Allotment rows (JSON keys): `AllotmentNo`, `Date`, `CreatedAt`, `CreatedBy`, `Division`, `FromStore`, `MaterialCode`, `MaterialDescription`, `Unit`, `AllottedQty`, `Remarks`, `MovementType`, `Status`/`status`, `CancelledBy`, `CancelledAt`, `CancelReason`.
- **Numbers:** `Unrestricted` via `parseStockNumber`: numbers pass through; strings `replace(/,/g,'')` → `parseFloat || 0` (exposed as `window.parseStockNumber`, reused by allotment.js `parseNum`). `Material Price` uses `parseFloat(replace(/,/g,'')) || 0` (unused). `AllottedQty` → `Number() || 0`. Display: `toLocaleString` with up to 3 decimals. For material codes `0110020711` (676 kg) and `0110051311` (396 kg), MT stock is also shown as `(N no.)` = `floor(MT*1000/kg)` (stock_pole_count.js).
- **Dates:** `Date` (one report date per upload, written as M/D/YYYY by stock_client_pipeline.js `formatDateMDY`). The latest is picked by STRING max (`item.Date > max`), then `new Date(str)` (native US M/D parse) → header `Stock of Major Materials (dd/mm/yyyy)`. Allotment `Date` / `CreatedAt` are `slice(0,10)` ISO strings (allotment.js writes `Date` as yyyy-mm-dd); the date filter and date-wise tab key on that string. `CancelledAt` is shown via `new Date().toLocaleDateString('en-GB')`.
- **Offices:** a custom `PLANT_MAP` maps 4-digit `Plant` to a store name: `6611`/`3342` Malda (D) Division, `6612`/`3343` Chanchal, `6613` Gazole, `6621`/`3432` Raiganj, `6622`/`3434` Islampur, `6631`/`3461` Balurghat, `6632`/`3462` Buniadpur, `6600`/`7201` Malda (D) Zone. Fallback `Store || 'Name 1' || 'Unknown'`. `StoreType` = `old` for a 3xxx plant, `new` for 6xxx (tabs). Rows named `Malda & Zone` are split by Plant (`6611` → `Malda`, `7201` → `Zone`). allotment.js `ALL_STORES` matches lowercased `StoreName` with substring rules (zone: `malda (d) zone` / `zone` / `malda & zone`) and has `plantPrefer` codes. No MzoScope.filterRows; there is no login scope on stock. Uniform note: 66xx plants are MzoScope division prefixes (UI.office would give `_division` from the 4-digit key); the old 3xxx codes and the zone codes 6600/7201 need explicit aliases.
- **Row filters / dedupe / positional:** drop rows without `Material Group` (StoreName always truthy). The table and modals hide groups whose summed stock is exactly 0. Allotment views exclude `Status` = `cancelled` from summaries. No dedupe: rows are summed per `StoreName|Material|Material Description` (store key = `Plant (StoreName)` on the old/new tabs).
- **Aggregations:** KPI cards summing `Unrestricted` for `Material Group` POLE (excluding `RAIL POLE 11-13M (52KG.)`), HBEAM, TRANSFORM (only descriptions containing `DTR`; titled DTR), SMART_MET and CONDUCTOR, with the unit from the first row. A card click opens a store-wise breakdown with subtotals (Zone first). Tabs Total / New Codes (6xxx) / Old Codes (3xxx). Cascading selects Store → Material Group → Material Description, Central/Local checkboxes on `Category`, and search on description/code with highlighting. Grouped table with a total row; sortable; CSV download of the rendered table. Low-stock modal with per-group thresholds: CONDUCTOR < 10, SMART_MET === 10, METER < 100, MSANGLE/MSCHANNEL/MSFLAT === 1, else ≤ 10, always > 0. Allotment view: KPIs Orders/Lines/Items, tabs Orders, Material-wise, Division-wise, Date-wise; filters search, material, Division (To), from/to date.
- **Deep links:** none.
- **Writes:** POST `/api/stock/allotment` `{action:'createAllotment', createdBy, rows:[{FromStore, FromPlantCode, Division, PlantCode, MaterialCode, MaterialDescription, Unit, PresentStockDiv, SourceStockAtAllot, ZoneStockAtAllot, AllottedQty, Remarks, MovementType, Date}]}` (allotment.js). POST `/api/stock/allotment` `{action:'cancelAllotment', allotmentNo, cancelledBy}` (allotment_view.js). The upload goes through the separate stock/upload.html (link only). Access is gated by profile flags `stock-allot-autho`, `stock-cancel-autho`, `stock-upload-autho` and the hardcoded `ALLOT_ALLOWED_USERS ['zm','aritra','dm1']`.
- **Quirks:** Category precedence is hardcoded `lookupStockCategory(Material)` (exact match, then leading zeros stripped) → the row's `Category` → the metadata `Category` → `UNKNOWN`. Material codes have inconsistent leading zeros between the SAP dump and the maps (pole-count map keys have a leading `0` with a `Number()` fallback). The date is M/D/YYYY and its max is found lexicographically. allotment.js and allotment_view.js read the raw keys through `window.allData` (`item.Material`, `item.StoreName`, `item.Unrestricted`, `item['Material Description']`, `item['Base Unit of Measure']`) and `window.PLANT_MAP`, so a rename to snake_case must cover all three files at once. `SMART_MET === 10` looks like a bug (likely meant ≤ 10).
- **Complexity:** L. Six page-specific JS files, three sources (stock CSV, metadata CSV, allotment JSON), plant-code store mapping with old/new codes, writes, and raw keys shared via globals across modules.
- **Uniform fields it would use:** stock_snapshot: `plant`, `name_1`, `material_type`, `material`, `material_description`, `material_group`, `storage_location`, `descr_of_storage_loc`, `base_unit_of_measure`, `unrestricted`, `stock_in_transit`, `transit_and_transfer`, `store`, `category`, `date`, plus `_division` (from plant; zone for 6600/7201) and `_region` where derivable. stock_materials: `mat_code`, `category`, `mat_desc`, `uom`, `material_price`. Allotments are server JSON (not a sheet dataset); uniform is not applicable unless the server output is aliased.
- **Shared with:** `stock/stock_material_category.js` is also loaded by stock/upload.html. `stock/stock_client_pipeline.js` (upload.html only) defines the published CSV columns and the M/D/YYYY `Date`; it mirrors server `lib/stock_pipeline.js`. script.js, allotment.js and allotment_view.js share globals (`window.allData`, `window.PLANT_MAP`, `window.parseStockNumber`, `MzoStockPoleCount`). Convert the whole stock folder as one unit.

### important_sheets.html  (NAV key: important_sheets)
- **Status (2026-11-01):** not converted to rows (single cells); batch D fixed its cell reads (`4cac325`: each cell from its configured tab; the 33-character sheet id is valid).
- **Kind:** kit (207 lines) · **Loads:** none besides kit + `/auth.js`
- **Datasets:**
  - Supabase table `important_unbilled_months` (schema `mzo_insight`) via `GET /api/important-sheets/unbilled` (server JSON; the server maps `sheet_id`→`sheetId` and `sort_order`→`sortOrder`, and filters `active=eq.true` unless `?all=1` and the user can manage). If the call fails or returns no months, a hard-coded `FALLBACK` list (Jan-2026 … Aug-2026, with sheet id and gid) is used.
  - Single cells read directly from Google Sheets: `fetch('https://docs.google.com/spreadsheets/d/<id>/export?format=csv&range=<A1>')`. Per unbilled month: `D57` (label "Q") and `E57` (label "M"). Billing sheets: "3 months unbilled" `1g_YAYXocaaEDh42WpgT5jqzEwWMgwtvfrXP2J3Jh8lw` `Q60`; "1st bill not generated" `1gPNCdyhoGNZy5i6FFp2HBIHs4-4FelNWGWThmC8PeQE` `J57`; "Smart meter: non-push cases" `18z-dWyTbw9jsrJtQ67UUL2TbT-QUgi_Q` `G63`; "REM less unit billed" `1It8j3Ic8mjoVf7ejljj1VrN7LEEnqg-9A8n7BY3UrQM` `I56` (label "<10") and `M56` (label "0"). "Smart metering" and the 4 REM OSD sheets are links only, with no cell read. These are the mirror's `important_*` datasets. The repo has no mirror key names for them; my proposed keys: `important_unbilled_<mon_yyyy>`, `important_3_months_unbilled`, `important_1st_bill_not_generated`, `important_smart_meter_non_push`, `important_rem_less_unit_billed`.
  - `/api/session-check` (profile only, for the manage gate).
- **Parser:** server JSON for the month list. Cells: raw response text with `t.replace(/"/g, '').trim()`. No CSV parsing.
- **Raw columns read:** from the month JSON: `id`, `label`, `sheetId` (or `sheet_id`), `gid`, `sortOrder`. Cells: only the A1 cells listed above, all (d).
- **Numbers:** none parsed. The cell text is shown as-is; empty shows as `'0'`, a fetch error as `'—'`. `sortOrder` in the manage form uses `Number(sort)`.
- **Dates:** none. The month label (`Sep-2026`) is free text.
- **Offices:** none. No MzoScope.
- **Row filters / dedupe / positional:** months without a sheet id, or with id `'#'`, are dropped. An empty gid becomes `'0'`. All values are fixed cell positions (D57/E57, Q60, J57, G63, I56/M56).
- **Aggregations:** none. Each cell value is a badge.
- **Deep links:** none.
- **Writes:** `POST /api/important-sheets/unbilled`, `PATCH /api/important-sheets/unbilled/:id`, `DELETE /api/important-sheets/unbilled/:id` (server writes Supabase `important_unbilled_months` and calls `logActivity`). Writes `localStorage` `mzo_authenticated` and `mzo_user_profile`.
- **Quirks:** the cell fetch does not pass `gid`, so `export?format=csv&range=D57` reads the first tab of the spreadsheet, not the configured month gid (the gid is used only in the Open link). The non-push sheet id is 33 characters, shorter than a normal 44-character id, and may be truncated (not verified). Cell text may contain commas or units and is not normalised. The manage gate is `role === 'admin'` or `sheets-autho` / `sheets_autho` ∈ {`edit`, `y`, `all`}.
- **Complexity:** S. There are no row datasets, only fixed single-cell reads and one small server JSON list.
- **Uniform fields it would use:** not applicable for rows. It would need a "single cell / as-on value" helper, or mirror `important_*` scalar values. Month table fields, if mirrored: `id_2`, `label`, `sheet_id`, `gid`, `sort_order`, `active`.
- **Shared with:** none (no helper file). The `sheets-autho` gate logic is duplicated in sheet_links.html (`allowed()`), app.html and server `requireSheetsEditor`.

### sheet_links.html  (NAV key: sheet_links)
- **Status (2026-11-01):** converted in `cd102ec` (final step).
- **Kind:** legacy (525 lines; uses `html.ui` and mzo_theme.css but not mzo_ui.js; own table, CSS and CSV parser) · **Loads:** none besides `mzo_theme.js` and `mzo_data_hub.js?v=90`
- **Datasets:** the page lists every `window.MZO_DATASETS` entry (registry `key`, `label`, `url`), except `CACHE_VENDORS` and `CACHE_LOSS_TARGET`, plus a hard-coded `extras` list of direct sheets: consumers, smart_meter_status, upcoming_dd, dd_visit, dd_summary, accident_reports, dtr_records, dtr_peak_load, substation_upkeeping, prt_transformers, and onm_advance (pseudo-key `OM_ADVANCE`). It reads row data only to find an "Updated" (as-on) date. For each dataset below it calls `loadSheetCsv(key)`, which tries `mzoDataHub._peek(key)` first (string, or object `.body` / `.text` / `.csv`) and otherwise `fetch(item.url)` of the whole registry URL:
  - `disconnection` (CACHE_DISCONNECTION), `docket_calls` (CACHE_DOCKET), `capex_details` (CACHE_CAPEX), `pending_mc` (CACHE_PENDING_MC), `cmo_grievances` (CACHE_CMO), `collection_report` (CACHE_COLLECTION), `bharatnet_connections` (CACHE_BHARATNET), `icds_a_plus` (CACHE_ICDS_APLUS), `icds_a` (CACHE_ICDS_A), `pmsgy_malda` / `pmsgy_uttar_dinajpur` / `pmsgy_dakshin_dinajpur` (CACHE_PMSGY_MALDA / _UD / _DD), `loss_report` (CACHE_LOSS), `feeder_outage` (CACHE_FEEDER_OUTAGE).
  - `onm_advance` via a direct `fetch` of `https://docs.google.com/spreadsheets/d/e/2PACX-1vQPBYq0ZQpaAnu0Mp_qN5oGvklgIpjolyRPf3LfSojRaN-GBBBXKHslR9ue1DOv1432oP2PzYznUUmn/pub?gid=512034300&single=true&output=csv` on every load, with no cache.
  - Meta JSON: `/api/hub/versions` (`versions[key]`), `/api/nsc/meta` (`meta.reportDate`, `meta.stats.today`, `meta.uploadedAt`, applied to NSC and Withheld), `/api/defective/meta` (`uploadMeta.uploadedAt` / `.reportAsOn` / `version`, applied to CACHE_DEFECTIVE and _DETAILS), `/api/stock/meta` (`meta.reportDate` / `meta.stats.today`, applied to CACHE_STOCK_METADATA). Also `localStorage` `mzo_hub_ver_<key>`.
- **Parser:** its own `csvRows(text, limit)`, an RFC-4180-ish parser to arrays that drops blank rows and does not trim. `collectionToDate` uses a naive `text.split(/\r?\n/)` and then `line.split(',')[0]`.
- **Raw columns read** (header matched by regex on the trimmed header; all are used only for the as-on date (d)):
  - disconnection: `/PAID\/DISCON DATE/i` (`PAID/DISCON DATE`)
  - docket_calls: `/^doc_crn_dt$/i`
  - capex_details: `/^Reporting Date$/i`
  - pending_mc: `/^Report Date$/i`
  - cmo_grievances: `/^Report Date$/i`
  - collection_report: column 0 by position (per docs/reports.md, the payment date; collection.html parses it as `PAYMENT_DT`, yyyymmdd)
  - bharatnet_connections: `/upadte\s*date|update\s*date/i` (sheet header `UPADTE DATE`), fallback column index 13 (N)
  - icds_a_plus / icds_a: `/update\s*date/i` (`UPDATE DATE`), fallback index 12 (M)
  - pmsgy_*: `/^Last Action Date$/i`
  - loss_report: `/update\s*on|update\s*date/i` (`Update On`), fallback index 9 (J)
  - feeder_outage: `/^REPORT MONTH$/i`
  - onm_advance: `/^Creation Date$/i`
- **Numbers:** none, apart from date parts parsed with `parseInt` / `+x`.
- **Dates:** everything is re-formatted to `dd/mm/yyyy` strings.
  - `latestDate()` finds the header within the first 8 rows and takes the max over all rows. The `DOTTED` regex `^(\d{1,2})\.(\d{1,2})\.(\d{4})$` (dd.mm.yyyy) is used for PAID/DISCON DATE, Reporting Date and Creation Date. Docket uses `^dd/mm/yyyy` (prefix, time allowed). Pending MC uses `^dd[-/]mm[-/]yyyy` with a `new Date(raw)` fallback (`looseDates`).
  - CMO takes the lexicographic string max of the raw `Report Date`, then `formatWhen`.
  - Collection takes the max 8-digit `yyyymmdd` value in column 0.
  - Bharatnet, ICDS and Loss (`firstRowHeaderDate`) read only data row 1 (sheet row 2), format `dd[./-]mm[./-]yy(yy)`. A 2-digit year gets +2000.
  - PMSGY `pmsgyAsOn` takes the max of `dd-Mon-yy(yy)` (month-name map) or `dd[./-]mm[./-]yy(yy)`.
  - Feeder outage takes digits only, the first 6 as `yyyymm`, then the max, then the last day of that month.
  - `formatWhen(raw)` reads `d/m/y` (`/`, `.` or `-`) when the value does not start with `yyyy-`; otherwise it uses `new Date` (only if the text has letters, a `T`, or a leading yyyy-).
  - `dateFromVersion(ver)` reads a `|`-separated token that is a d/m/y, else `m:<Last-Modified>`, else an embedded ISO timestamp.
- **Offices:** none. There is no MzoScope (the page loads no mzo_scope.js) and no office data.
- **Row filters / dedupe / positional:** registry rows are deduped by `label` and skipped when there is no sheet URL (fallback URLs are hard-coded for CACHE_NSC_v5 and CACHE_WITHHELD_v4). Header-row detection looks through the first 8 rows (`latestDate`). Positional fallbacks are cols 13, 12 and 9, and col 0 for collection. Only data row 1 is used for the "first row" as-on cells (sheet cells N2, M2, J2).
- **Aggregations:** none. It is a sorted link table with search by name.
- **Deep links:** none.
- **Writes:** none to the server. Writes `localStorage` `mzo_feeder_outage_as_on`, which feeder_outage.html also writes and no page reads.
- **Quirks:**
  - Whichever date arrives first wins unless a call passes `force` (Bharatnet, ICDS, PMSGY, Loss, Feeder and NSC report date force; the others do not). The shown date therefore depends on the order of the async calls.
  - The CMO max is a string max, which is wrong for dd/mm/yyyy across months.
  - Whole CSVs are downloaded only to get one date when the hub has no cache.
  - The CACHE_JJM date is fixed to the text 'As updated by RMs'.
  - The disconnection header regex is not anchored.
  - `formatWhen` treats `a/b/c` as d/m/y.
  - The access gate is the localStorage profile: `role === 'admin'` or `sheets-autho` ∈ {`list`, `edit`, `y`, `all`}, else redirect to `/app.html`.
- **Complexity:** M. It touches about 15 datasets, each with its own as-on date rule, a custom parser, header-row detection and positional fallbacks. With the mirror, all of this collapses to one per-dataset `as_on` field.
- **Uniform fields it would use:** `paid_discon_date`, `doc_crn_dt`, `reporting_date`, `report_date`, `payment_dt` (collection col 0), `upadte_date` / `update_date`, `last_action_date`, `update_on`, `report_month`, `creation_date`. Better: a per-dataset `as_on` field from the mirror. No office fields.
- **Shared with:** no helper file. `sheetOpenUrl()` is nearly the same as admin_users.html `sheetCopyUrl()`, and the `extras` list is nearly the same as admin_users.html `EXTRA_SOURCES`. Each as-on rule copies the header-date logic of its own page: disconnection.html, docket.html, capex_all.html, pending_mc.html, cmo.html, collection.html, bharatnet.html, icds.html, pmsgy.html, loss.html, feeder_outage.html, advance_onm.html. Convert it together with, or after, those pages.


## Media

### media_news.html  (NAV key: media_news)
- **Status (2026-11-01):** not converted: no sheet data (server RSS JSON).
- **Kind:** kit (173 lines) · **Loads:** none besides kit
- **Datasets:** none from the registry. It reads `GET /api/news` (`?force=1` on refresh). The server fetches 4 Google News RSS queries (`english`, `bangla`, `districts`, `national`) and caches them for 15 min. This source is not in the mirror lists. Offline fallback: `localStorage` `mzo_merged_news_v2`, or the legacy key `mzo_merged_news`.
- **Parser:** server JSON (`{status:'ok', items:[…]}`).
- **Raw columns read:** item fields `title`, `source`, `link`, `pubDate`, `description`, `category`, `isAccident` (all display or classification).
- **Numbers:** none.
- **Dates:** `pubDate` (RSS RFC-822 string) via `new Date()`. Shows relative time (m/h ago), groups by "Today", "Yesterday" or `UI.fmtDate`, and sorts by newest first.
- **Offices:** none. The keyword tag `/malda|raiganj|balurghat|dinajpur/i` → "Malda Zone" applies to headlines only.
- **Row filters / dedupe / positional:** dedupe by `(link + '::' + title).toLowerCase()`. A ` - Source` suffix is split off the title when there is no source. The description is dropped if it contains `<a ` or `&lt;a`, or equals the title. A link that is not http(s) becomes `'#'`.
- **Aggregations:** section counts (`category`, with `'english'`→`'state'`), the safety count (`isAccident` or keyword list, English and Bengali), and topic tags (first 2 regex matches).
- **Deep links:** none.
- **Writes:** `localStorage` `mzo_merged_news_v2` only.
- **Quirks:** Bengali keyword matching. `category` falls back to `'general'`.
- **Complexity:** S. It reads one server JSON feed and no tabular data.
- **Uniform fields it would use:** not applicable.
- **Shared with:** none.


## Briefing and Ask

### executive_briefing.html  (NAV key: home (HOME entry "Briefing"))
- **Status (2026-11-01):** not converted: server JSON built from meta stats (`/api/executive/briefing`); converting it is a server-side job of its own.
- **Kind:** kit (204 lines) · **Loads:** none besides kit
- **Datasets:** page: `GET /api/executive/briefing` only (server JSON `{status, briefing:{asOn, generatedAt, summaryCounts, items[]}}`). The server reads no row data at request time. It reads precomputed meta JSON:
  - `pending_mc`: `PENDING_MC_META.read()`, i.e. Supabase Storage public `reports/pending_mc/meta.json` (60 s cache), local fallback `data/pending_mc_meta.json`.
  - `load_extension`: `reports/load_extension/meta.json`, fallback `data/load_ext_meta.json`.
  - `disconnection`: `reports/disconnection/meta.json`, fallback `data/disconnection_meta.json`.
  - `defective_summary`: `reports/defective/meta.json`, fallback `data/defective_meta.json`.
  - `nsc_pending` / `withheld`: `readLocalNscMeta_()` (`data/nsc_meta.json`), else `fetchNscSheetMeta_()` (nsc_working Apps Script `?meta=1`, 60 s cache).
  These meta files are written by `scripts/sync/sync_*_to_supabase.js` (run from the in-app Sync buttons or the CLI). `divisionCccs`, and the NSC `delayed30` / `divisions` / `divisionCccs`, are added only by the local tool `scripts/tools/compute_briefing_cccs.js`.
- **Parser:** page: server JSON. Upstream sync scripts: `split('\n')` plus `parseCsvLine` (scripts/sync/common.js; quoted fields; cells `.replace(/^"|"$/g,'').trim()`). Defective uses a naive `line.split(',')` with no quote handling. compute_briefing_cccs.js has its own `parseCsvLine` that trims.
- **Raw columns read** (upstream, for the numbers the page shows):
  - pending_mc: `Region`, `Division`, `CLASS`, `Report Date`, `Meter Installation Date`, plus `CCC` (compute tool)
  - load_extension: `CCC CODE`, `CONN_CLASS`, `CONN_PHASE`, `LOAD_APPLIED`, `AGE_MONTHS`, `report_date` / `REPORT_DATE`
  - disconnection: `CCC_CODE` (fallback idx 0), `CON_ID` (2), `NOTOSD` (5), `PAID/DISCON DATE` (12), `FINAL PAID AMOUNT` (13), plus header cells beginning `DOM BASE DATE` / `IND&COM BASE DATE`
  - defective_summary: `REPORT_AS_ON`, `total`, `agri`, `over10`, `over5`, `ph3`, `industrial`, `smart`, `load_gt6`, `load_3_6`, `load_1_3`, `load_05_1`, `load_lt_05`, `DIVISION`, plus `CCC_CODE` (compute tool)
  - nsc_pending (compute tool, from `data/nsc.csv`): `DIVN_NAME`, `SUPP_OFF`, `DelayInSC`. From the NSC upload meta: `stats.withheldRows`, `stats.statusCounts.Witheld`, `stats.regionCounts`, computed client-side at NSC upload.
  - Page fields used: `items[].id`, `priority`, `title`, `domain`, `metric`, `hotspots[{division,count,amount}]`, `divisions`, `divisionCccs`, `deepLink`, `pageTitle`, plus `generatedAt`.
- **Numbers:**
  - Upstream: disconnection `parseAmount` (`replace(/,/g,'')` then `parseFloat`, else 0). Load ext `parseFloat(LOAD_APPLIED) > 10000` and `parseInt(AGE_MONTHS)` > 6 / > 12. Defective `Number(cols[i] || 0)` (compute tool `parseInt || 0`). NSC `parseFloat(DelayInSC) || 0` > 30. Server `Number(x || 0)`, `formatCr_` (/1e7, 2 dp + ' Cr'), `formatLakh_` (/1e5, 2 dp + ' L').
  - Page: `num(v)` (number, else `v.total`, else `Number(v) || 0`). `isZero(metric)` strips non-digits. `UI.n`, `UI.inr`.
- **Dates:**
  - Upstream: pending MC `parseDate` reads `dd[-/]mm[-/]yyyy[ time]` else `new Date`; delayed90 = days(Report Date − Meter Installation Date) ≥ 90, withinMonth ≤ 30; as-on = max `Report Date`. Disconnection uses `PAID/DISCON DATE` `dd.mm.yyyy` (y ≥ 2020); `#n/a`, `'0'` and empty mean "no action"; as-on = the latest date, or the `DOM BASE DATE: <x>` text from the header row. Defective `REPORT_AS_ON` is `yyyymmdd` → dd/mm/yyyy. Load ext as-on = the first non-empty `report_date`.
  - Page: shows `generatedAt`, which is always the server's "now", not the data date. `briefing.asOn` is ignored.
- **Offices:**
  - Upstream: divisions come from the CCC code prefix through `DIV_BY_CODE` / `divMap` (6611 Malda, 6612 Chanchal, 6613 Gazole, 6621 Raiganj, 6622 Islampur, 6631 Balurghat, 6632 Buniadpur) for load ext and disconnection. Pending MC uses the raw `Division` column value. Defective uses the raw `DIVISION` value (keys like `MALDA DIVISION`). The compute tool has its own `CCC_MAP` (7-digit code → CCC name) and `normalizeDivName` (strips " division").
  - Page: `divStat()` tries `divisions[div]`, then `div.toUpperCase() + ' DIVISION'`. The division picker is built from all `divisions` keys via `UI.title(d.replace(/\s+division$/i,''))`.
  - No MzoScope: every user sees zone-wide numbers, and the division list is not scoped.
- **Row filters / dedupe / positional:** upstream: pending MC skips rows with empty `Region` or fewer than 4 cells. Disconnection skips rows with no `CON_ID` and no `CCC_CODE`, with positional fallbacks. Defective skips rows with fewer than 10 cells. The NSC item is included only when `stats.delayed30 != null`, and the withheld item only when the count is non-zero.
- **Aggregations:** 9 items (mc-delayed-90, discon-no-action, defective-over-10m, nsc-delayed-30, load-ext-ageing-1y, mc-industrial-pending, defective-3phase-ind, nsc-withheld, discon-partially-paid). The page groups them into critical / high / watch / clear (clear when the metric is 0) and shows 4 stat cards with those counts. The per-division view reads `divisions[div]` (`osd` for discon-no-action, `over10` / `ph3` for defective) and the top 4 `divisionCccs`. "Copy summary" builds a WhatsApp-style text.
- **Deep links:** reads no params. On click it opens `item.deepLink` and appends `division=<Division>` (e.g. `pending_mc.html?kpiFilter=Delayed`, `disconnection.html?status=noAction`, `consumer/defective_meter.html?kpi=over10`, `pending_load_extension.html?kpi=kpiAgeing1y`, `nsc.html`, `withheld.html`).
- **Writes:** none from the page. The sync POST routes behind the meta live on other pages.
- **Quirks:**
  - `divisions` is the total-pending count per division for pending MC and load ext. Hotspots and the division view for "MC > 90 days", "Industrial MC" and "Load ext > 1 year" therefore show total pending, not the item's measure.
  - discon-no-action hotspot `amount` and the division view use `divStats.osd`, which is the total OSD of all statuses, not the no-action OSD.
  - discon-partially-paid in the division view shows `divStats[div].total` (all consumers).
  - The load ext sync uses `AGE_MONTHS > 12` for ageing1y, while pending_load_extension.html and the assistant use `>= 12`.
  - Division keys are mixed: `Raiganj` vs `MALDA DIVISION`.
  - The disconnection header row holds dates inside header text (`DOM BASE DATE: dd.mm.yyyy`), so snake_case of those headers is unstable.
  - The withheld hotspot labels are district-style region names (`Malda`, `Uttar Dinajpur`, `Dakshin Dinajpur`).
  - No scope filtering, which goes against the AGENTS.md "Scope rows" rule.
- **Complexity:** page S (server JSON only). The server side is M if the briefing is rebuilt from uniform rows of 5–6 datasets with consistent office mapping, which would also fix the semantic mismatches above.
- **Uniform fields it would use** (only if recomputed from rows):
  - pending_mc: `region`, `division`, `class`, `report_date`, `meter_installation_date`, `ccc`
  - load_extension: `ccc_code`, `conn_class`, `conn_phase`, `load_applied`, `age_months`, `report_date`
  - disconnection: `ccc_code`, `con_id`, `notosd`, `paid_discon_date`, `final_paid_amount`
  - defective_summary: `report_as_on`, `total`, `agri`, `over10`, `over5`, `ph3`, `industrial`, `smart`, `load_gt6`, `load_3_6`, `load_1_3`, `load_05_1`, `load_lt_05`, `division`, `ccc_code`
  - nsc_pending: `divn_name`, `supp_off`, `delayinsc`
  - all of the above: `_region`, `_division`, `_ccc_code`, `_ccc`
- **Shared with:** assistant.html (`briefing()` reads the same endpoint and repeats the `isZero` and hotspot logic). The server-side helpers are shared with scripts/sync/* and scripts/tools/compute_briefing_cccs.js; `/api/hub/versions` and the `/api/*/meta` routes read the same `*_META` stores.

### assistant.html  (NAV key: ask (ASK entry "Ask"))
- **Status (2026-11-01):** converted in `11e4a93` (final step).
- **Kind:** kit (435 lines) · **Loads:** `/lib/assistant_catalog.js?v=1` (also `mzo_data_hub.js?v=90`, `mzo_scope.js?v=14`)
- **Datasets:** read through `dataset(key)`, which returns `mzoDataHub._peek(key)` if cached (and triggers `waitForDataset` in the background), else `await waitForDataset(key)` and then `_peek`:
  - `nsc_pending` (CACHE_NSC_v5)
  - `load_extension` (CACHE_LOAD_EXT)
  - `solar_connections` (CACHE_SOLAR)
  - `loss_report` (CACHE_LOSS) and `loss_targets` (CACHE_LOSS_TARGET)
  - `GET /api/executive/briefing` (server JSON, `get_briefing` tool)
  - `POST /api/assistant` (the Ask model call; sends `messages` and `context.scope`)
  - lib/assistant_catalog.js reads no datasets. It is static: `OFFICES` (region → division → CCC names), `REPORTS` (key, title, url, `params`, `views` → URL query, `data:true` for nsc / load_extension / solar / loss), `GLOSSARY`, `report(key)`, `buildLink(key, opts)`. server.js `require`s it for the system prompt and tool schemas.
- **Parser:** `UI.csv` for all four CSVs; server JSON for the briefing.
- **Raw columns read:**
  - nsc_pending: `APPL_NO`, `NO_OF_POLES`, `SCN_WITHELD_DATE`, `DelayInSC`, `CONN_CLASS`, `APPLIED_PHASE`, `CCC_CODE`, `SUPP_OFF`, `REGION`, `DIVN_NAME`
  - load_extension: `APPL_NO`, `CON_ID`, `LOAD_APPLIED`, `CURR_LOAD`, `AGE_MONTHS`, `CONN_CLASS`, `CONN_PHASE`, `report_date` (stored as `asOn`, never used), `CCC CODE`
  - solar_connections: `SOLAR_APPL_NO`, `CON_ID`, `REPLACE_STATUS`, `REMARKS`, `CREATION_DATE`, `CCC CODE`, `SUPP_OFF`
  - loss_report: `YEAR`, `MONTH`, `CCC`, `CUM. AT&C LOSS`, `CUM. DIST. LOSS`, `COLL. EFF.`, `CUM. INPUT (MU)`, `CUM. COLLEC. (MU)`
  - loss_targets: `CCC`, `CUM. AT&C LOSS`, `CUM. DIST. LOSS`
  - briefing JSON: `generatedAt`, `items[].metric` / `priority` / `title` / `deepLink` / `hotspots`
- **Numbers:**
  - nsc: `parseInt(NO_OF_POLES,10) || 0`; `parseFloat(DelayInSC)`, where NaN becomes null.
  - load ext: `parseFloat(LOAD_APPLIED) || 0`, `parseFloat(CURR_LOAD) || 0`, `parseInt(AGE_MONTHS,10) || 0`. The fixed-charge loss is `applied > curr ? round((applied−curr) × rate × age / 850) : 0`, with rate I = 75, C/A = 60, else 30.
  - loss: `pct()` = `parseFloat(String(v).replace('%',''))` (null if not finite); MU columns `parseFloat(...) || null`; `YEAR` / `MONTH` `parseInt`.
  - Outputs use the median helper and `UI.inr`.
- **Dates:**
  - solar `UI.days(CREATION_DATE)` (dd/mm/yyyy, dd.mm.yyyy, dd-mm-yyyy or ISO), for non-connected rows only.
  - nsc `DelayInSC` is an already-computed day count.
  - `SCN_WITHELD_DATE` is only a flag (non-empty and not `'0'`).
  - loss period key `YEAR*100+MONTH`. The latest period is the default; input `month` `YYYY-MM`. Comparisons are to the last March of the financial year (`m>=4 ? y : y-1`) and to the same month last year (`k-100`).
- **Offices:**
  - `officeRow(d, code, name, regionRaw, divRaw)`: `UI.office(code, name)` → `_region`, `_divn`, `_supp`. Fallbacks are `MzoScope.regionNameOf(REGION)` and `MzoScope.divisionNameOf(DIVN_NAME)` (nsc only). It also sets `d.CCC_CODE = code`.
  - load ext passes only `r['CCC CODE']`; solar passes `r['CCC CODE']` and `r.SUPP_OFF`.
  - After build: `MzoScope.filterRows(rows)` on the derived rows (nsc, load ext, solar).
  - Query filters: case-insensitive equality on `_region` / `_divn` / `_supp`. Input names pass through `clean()`, which strips a trailing region / division / div. / ccc. `normRegion` uses `UI.regionName` (alias Uttar Dinajpur → Raiganj, Dakshin Dinajpur → Balurghat). Rows that map to nothing are grouped as `'Unmapped'`.
  - Loss: no `filterRows`. The office comes from the hard-coded `LOSS_TREE`, a mapping from region / division / CCC to the sheet's `CCC` row labels: `MALDA ZONE`, `MALDA REGION`, `U/DINAJPUR REGION`, `D/DINAJPUR REGION`, `<Div> Div Total`, and upper-case CCC names. `LOSS_NAME` fixes spellings (`H.C. PUR` → Harishchandrapur, `MOKDAMPUR`, `BAISNABNAGAR`, `KARANDEGHI`, `KUMARGUNJ`, `KUSHMUNDI`, `BAMANGOLA`, `GOALPOKHAR`, `KALIAGANJ`). When no office is given, it defaults to the user's scope if that scope is exactly one region or one division.
- **Row filters / dedupe / positional:** nsc keeps the last row per `APPL_NO` (trimmed, lower-cased) and drops empty APPL_NO. Load ext keeps rows with `APPL_NO || CON_ID`; solar keeps rows with `SOLAR_APPL_NO || CON_ID`. Loss skips rows without YEAR, MONTH and CCC. The built rows are cached per report for the session.
- **Aggregations:** the `query_report` tool.
  - nsc measures: applications, over_30_days (`delay > 30`), pole_cases, poles_needed, median_days_since_payment. Views: over_30_days, pole_cases, rescued_from_withheld, industrial (`CONN_CLASS` 'I'), commercial_three_phase (C + III).
  - load_extension measures: applications, over_1_year (`age >= 12`), est_fixed_charge_loss, median_wait_months. Views: industrial, three_phase, above_10kw (`applied > 10000`).
  - solar: status from `REPLACE_STATUS`: SUCCESS / EFFECTED / DONE → connected; '' / '(NULL)' / 'NOT YET' / 'PENDING' → pending; anything else → meter_issue. Scheme from `REMARKS`: '' / 'OTHER' / '(NULL)' → 'OTHERS'; view pm_surya_ghar = 'PMSGMBY'. Measures: counts by status, median_days_pending.
  - `group_by` region / division / ccc (top 20 plus `more_offices`).
  - loss: totals for the selected node plus children.
  - `get_briefing`: items mapped to priority (clear when the metric is 0), value, link, top_divisions.
- **Deep links:** `?q=<question>` asks on load and then strips itself from the URL. Answer buttons use `C.buildLink` → `<report url>?region=&division=&ccc=&q=&<view query>` and open inside the app shell (`/app.html#~<link>`).
- **Writes:** `POST /api/assistant` (the Ask model call; not a data write). `sessionStorage` `mzo_assistant_v1`.
- **Quirks:**
  - Uses `_divn` / `_supp` (MzoScope key names), not `_division` / `_ccc`.
  - The loss rows are not scope-filtered.
  - `LOSS_TREE` Malda division lists `MATHURAPUR` and has no `Manikchak`, while catalog `OFFICES` has Manikchak and no Mathurapur.
  - Division and CCC names are compared by exact lower-case match, so spelling variants miss; it reports "No rows matched that office name".
  - over_1_year `>= 12` differs from the briefing's `> 12`.
  - `report_date` → `asOn` is dead code.
  - `'(NULL)'` is handled as a magic value for solar.
- **Complexity:** M. Five datasets and the office mapping (UI.office plus MzoScope fallbacks), plus a bespoke loss-row label tree. Its adapters copy logic from four other pages and must stay consistent with them.
- **Uniform fields it would use:**
  - nsc_pending: `appl_no`, `no_of_poles`, `scn_witheld_date`, `delayinsc`, `conn_class`, `applied_phase`, `ccc_code`, `supp_off`, `region`, `divn_name`, plus `_region` / `_division` / `_ccc_code` / `_ccc`
  - load_extension: `appl_no`, `con_id`, `load_applied`, `curr_load`, `age_months`, `conn_class`, `conn_phase`, `report_date`, `ccc_code`, plus office fields
  - solar_connections: `solar_appl_no`, `con_id`, `replace_status`, `remarks`, `creation_date`, `ccc_code`, `supp_off`, plus office fields
  - loss_report: `year`, `month`, `ccc`, `cum_at_c_loss`, `cum_dist_loss`, `coll_eff`, `cum_input_mu`, `cum_collec_mu`
  - loss_targets: `ccc`, `cum_at_c_loss`, `cum_dist_loss`
  - Loss office fields would need a label → office map, because `ccc` holds zone / region / "Div Total" labels.
- **Shared with:** `lib/assistant_catalog.js` is loaded only by this page and by server.js (system prompt and tools). The adapters copy code blocks from nsc.html (APPL_NO dedupe, views), pending_load_extension.html (the `/850` loss formula, `age >= 12`), solar.html (REPLACE_STATUS → status) and loss.html (the same `LOSS_TREE`). `briefing()` matches executive_briefing.html.


## Administration

### admin_users.html  (NAV keys: admin_users, admin_sources, admin_activity, admin_visitors, admin_powermap, admin_corrections; all `admin_users.html?tab=…`)
- **Status (2026-11-01):** not converted: admin pages; reads one column of the Power Map CSV.
- **Kind:** legacy (6374 lines; no `html.ui`; Font Awesome; own CSS plus mzo_theme.css) · **Loads:** `https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.3.2/papaparse.min.js`, `mzo_scope.js?v=14`, `mzo_data_hub.js?v=90` (used only for `window.MZO_DATASETS`). CSS: font-awesome 6.5.0 CDN.
- **Datasets:**
  - `power_map_substations` via `fetch('/api/power-map/data')` (server CSV of CACHE_POWER_MAP; the DataHub is not used), for the substation dropdowns.
  - `portal_users` via `GET /api/admin/users` (server JSON from Supabase `mzo_insight.portal_users`).
  - `activity_logs` via `GET /api/admin/logs` (last 2000) and `GET /api/admin/logs?days=15` (`timestamp`, `username` only). Server JSON from Supabase `mzo_insight.activity_logs`, local `LOGS_FILE` fallback.
  - Power-map corrections via `GET /api/admin/pending-corrections`, i.e. Supabase table `mzo_power_corrections?status=eq.pending`. This table name is not in the brief's list.
  - Sources tab: no row data. It reads the registry `MZO_DATASETS` (`key`, `label`, `url`, `type`), a hard-coded `EXTRA_SOURCES` list (sheet URLs incl. Manpower `…2PACX-1vRRXojudL5q-…/pub?gid=2110628491…` and Highway Crossings `…2PACX-1vQTy_LCddlFuzZx9ZyJQTLbqrQ8sb76DG4jyw8ys-…/pub?gid=870376934…`), `GET /api/stock/meta` (`source`, `csvUrl`) and `GET /api/nsc/meta` (`source`, `csvUrl`, `withheldCsvUrl`).
- **Parser:** `Papa.parse(csvText, { header: true, skipEmptyLines: true })` for power map. Server JSON for everything else. `JSON.parse(corr.proposed_value)` for add_substation and add_connection corrections.
- **Raw columns read:**
  - power_map_substations: `Substation` only (trimmed, unique, sorted)
  - portal_users JSON: `Username`, `Name`, `role`, `user_status`, `email`, `auth_provider`, `requested_at`, `office_level`, `zone_code`, `region_code`, `division_code`, `ccc_code`, `division`, `ss-autho`, `dtr-autho`, `dd-autho`, `nsc-autho`, `nsc-upload-autho`, `si-autho`, `si-divisions`, `sheets-autho`, `stock-upload-autho`, `stock-allot-autho`, `stock-cancel-autho`, `pending-mc-sync-autho`, `load-ext-sync-autho`, `disconnection-sync-autho`, `defective-upload-autho`
  - activity_logs: `timestamp`, `username`, `name`, `type` (`login`, `page_visit`), `details`
  - corrections: `id`, `created_at`, `suggested_by`, `suggested_by_name`, `type` (`edit_substation` / `add_substation` / `add_connection`), `substation`, `column_name`, `proposed_value` (JSON with `MVA`, `Division`, `LATITUDE`, `LONGITUDE` / `rl`, `conductorSize`, `peakLoad`), `connection_target` (all (d))
- **Numbers:** none parsed beyond counts.
- **Dates:** log `timestamp` (ISO) is compared to "today" with `new Date().toISOString().split('T')[0]`, which is the UTC date. "Last used" uses `new Date(timestamp).getTime()` within 15 days. `created_at` and `requested_at` go through `new Date(...).toLocale*String`.
- **Offices:** only the jurisdiction pickers in the user form: `MzoScope.listRegions`, `listDivisions`, `listCccs`, `regionNameOf`, `divisionNameOf`, `cccNameOf`, `parentOfCcc`, `listAllUnits`, `unitDisplayName`. No data rows are office-mapped and there is no `filterRows`.
- **Row filters / dedupe / positional:** substation names are deduped through a `Set`. Visitors are deduped by lower-cased username from today's logs. Source rows sort by kind rank, then name.
- **Aggregations:** KPI ribbon (total users, admins, pending approvals (`user_status === 'pending'`), today's unique users, logins and page visits), the unique-visitors table (logins and visits per user today), last-active per user, and source counts by kind (Supabase, Sheet, Script, JSON, CSV, RSS).
- **Deep links:** `?tab=users|sources|activity|logs|visitors|powermap|corrections` (or a raw tab id).
- **Writes:**
  - `POST /api/admin/users/create`, `/api/admin/users/update`, `/api/admin/users/delete`, `/api/admin/users/approve`, `/api/admin/users/reject`
  - `POST /api/admin/sync`
  - `POST /api/admin/approve-correction`, `/api/admin/reject-correction`
  - client-side CSV downloads (logs, visitors)
- **Quirks:**
  - The Power map tab forms call `saveSubstation(event)` / `saveConnection(event)`, which are not defined on this page (only in power_map/map.html). Submitting them fails.
  - "Today" is the UTC date, so between 00:00 and 05:30 IST it is the previous day.
  - The admin gate reads the localStorage profile (`role !== 'admin'` redirects).
  - `sheetCopyUrl` is a near copy of sheet_links `sheetOpenUrl`; this one keeps the gid only via `#gid`.
- **Complexity:** S for this refactor. Its only tabular read is one column (`Substation`) of `power_map_substations` via Papa.parse. The page itself is a very large legacy admin page with many writes, but those stay as they are.
- **Uniform fields it would use:** `substation` (power_map_substations). Users, logs and corrections are server JSON and not applicable.
- **Shared with:** no page-specific helper file. Code blocks: `EXTRA_SOURCES` / `sheetCopyUrl` ≈ sheet_links.html `extras` / `sheetOpenUrl`. power_map/map.html reads the same `/api/power-map/data` CSV and defines the missing `saveSubstation` / `saveConnection`. admin.html calls the same `/api/admin/users*` and `/api/admin/sync` endpoints.

### admin.html  (NAV key: admin_structure)
- **Status (2026-11-01):** not converted: admin page; server-parsed structure CSV and portal users.
- **Kind:** legacy (669 lines; `html.ui` plus mzo_theme.css, no mzo_ui.js) · **Loads:** none besides `mzo_theme.js`
- **Datasets:**
  - Estimate structures via `GET /api/structures` (server JSON). The server reads the repo file `data/structure.csv`, which is not in the mirror lists.
  - `portal_users` via `GET /api/admin/users` (server JSON).
- **Parser:** server JSON. The server parses `data/structure.csv` with `parseCsvLine_` (cells trimmed; rows whose cell count differs from the header are dropped; columns `id`, `name`, `description`, `voltage`, `materials`, `labour`). On the client, `materials` / `labour` are parsed from `"index:qty;index:qty"` with `split(';')` and `split(':')`, and `voltage` with `split('|')`.
- **Raw columns read:** structures: `id`, `name`, `description`, `voltage`, `materials`, `labour`. Users: `Username`, `Name`, `role`, `ss-autho`, `dtr-autho`, `dd-autho`, `nsc-autho`, `nsc-upload-autho`, `si-autho`, `si-divisions`, `zone_code`, `region_code`, `division_code`, `ccc_code` (d).
- **Numbers:** materials and labour pairs use `parseInt(index,10)` and `parseFloat(qty)`, dropping NaN pairs.
- **Dates:** none.
- **Offices:** none. `division_code` / `ccc_code` are shown raw.
- **Row filters / dedupe / positional:** none beyond dropping invalid pairs.
- **Aggregations:** none. It is an editor and a user table with text search.
- **Deep links:** none.
- **Writes:** `POST /api/structures/update` (server rewrites `data/structure.csv`, voltage joined with `|`, pairs `index:qty;…`; this fails on Vercel because the filesystem is read-only). `POST /api/admin/users/create`, `/update`, `/delete`, `POST /api/admin/sync`.
- **Quirks:** the voltage field is labelled "comma-separated" and split on `,`, but stored `|`-separated. There is no client-side admin check; GET `/api/structures` is open to any signed-in user, and the server enforces `requireAdmin` only on writes.
- **Complexity:** S. It reads one small server-parsed CSV and has no office or date logic.
- **Uniform fields it would use:** not applicable (no mirror dataset). If `structure.csv` were ever mirrored: `id_2`, `name`, `description`, `voltage`, `materials`, `labour`.
- **Shared with:** none (no helper file). It uses the same `/api/admin/users*` and `/api/admin/sync` endpoints as admin_users.html.

