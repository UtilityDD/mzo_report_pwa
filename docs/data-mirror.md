# Data mirror (PocketBase on the VM)

The VM keeps a copy of every dataset the app reads (Google Sheets, Supabase tables, Supabase Storage files and two repo files) in PocketBase, refreshed on a schedule. It has two uses:

- **Admin portal** (`https://data.130.210.43.11.sslip.io`): every dataset as a proper table with one uniform structure (see [vm/portal/README.md](../vm/portal/README.md)).
- **Mirror mode** for the VM's copy of the app: the sync also keeps the untouched source bytes of each dataset (a *snapshot*), which the VM app serves instead of fetching Google or Supabase (`MZO_DATA_MODE=mirror`, see [Snapshots](#snapshots)).

The mirror is read-only towards the sources: the sync only ever sends GET requests to Google and Supabase, never calls Apps Script, and never writes back. Vercel production does not use it.

| Where | What |
|---|---|
| `vm/sync/` | The sync: `run.js`, `lib/` (framework), `sources/*.js` (one file per source family) |
| `vm/sync/sources/google.js` | Every Google Sheet the app reads (this page) |
| `vm/sync/sources/files.js` | `data/costcenter.json`, `data/structure.csv` |
| `vm/sync/sources/supabase.js` | Supabase tables and Storage files ([vm/sync/sources/supabase.md](../vm/sync/sources/supabase.md)) |
| `vm/pocketbase/VERSION` | Pinned PocketBase version |
| `vm/pocketbase/pb_migrations/` | System collections, settings and the portal sign-in collection |
| `/opt/mzo/pocketbase/` (VM) | PocketBase binary and `pb_data/`, `pocketbase.service` on 127.0.0.1:8090 |
| `/etc/mzo/pocketbase.env` (VM) | `PB_URL`, `PB_SUPERUSER_EMAIL`, `PB_SUPERUSER_PASSWORD`, `MZO_SNAPSHOT_DIR` |
| `/opt/mzo/data/snapshots/` (VM) | Raw snapshots and `manifest.json` |

How the VM, the timers and the URLs are set up is in [docs/vm.md](vm.md).

## What is mirrored

<!-- inventory:start -->
76 sources from `google.js` and `files.js` (row counts from the first sync, 2026-11-01; about 1.06 million rows in all). The Supabase tables and Storage files from `supabase.js` are listed in [vm/sync/sources/supabase.md](../vm/sync/sources/supabase.md). "Snapshot" is the raw copy's format, if any (see [Snapshots](#snapshots)). `Sheet (pub)` is a published-to-web link, `export` and `gviz` are link-shared spreadsheets; the DataHub key is shown when the sheet is registered in `mzo_data_hub.js`.

| Group | Key | Label | Source | Rows | Cols | Schedule | Snapshot |
|---|---|---|---|---:|---:|---|---|
| New service connection | `nsc_pending` | Pending NSC (working dump) | Sheet (gviz) · `CACHE_NSC_v5` | 5,140 | 43 | frequent | csv |
| New service connection | `nsc_followups` | NSC follow-ups | Sheet (gviz) | 76 | 6 | frequent | csv |
| New service connection | `withheld` | Withheld NSC | Sheet (gviz) · `CACHE_WITHHELD_v4` | 66,589 | 15 | frequent | csv |
| New service connection | `historical_nsc` | Historical NSC analysis | Sheet (pub) | 53,381 | 7 | daily | csv |
| New service connection | `weekly_report` | Weekly deposit vs disposal | Sheet (pub) · `CACHE_WEEKLY` | 2,911 | 30 | hourly | csv |
| New service connection | `solar_connections` | Solar connections | Sheet (pub) · `CACHE_SOLAR` | 6,827 | 55 | hourly | csv |
| New service connection | `jjm_connections` | JJM connections | Sheet (pub) · `CACHE_JJM` | 44 | 9 | frequent | csv |
| New service connection | `meter_erp` | Meter ERP data | Sheet (pub) · `CACHE_METER_ERP` | 2,40,525 | 6 | daily | csv |
| New service connection | `meter_master` | Meter master data | Sheet (pub) · `CACHE_METER_MASTER` | 2,82,303 | 3 | daily | csv |
| New service connection | `meter_crm` | Meter CRM data | Sheet (pub) · `CACHE_METER_CRM` | 10,843 | 7 | daily | csv |
| New service connection | `meter_isu` | Meter ISU data | Sheet (pub) · `CACHE_METER_ISU` | 62,422 | 5 | daily | csv |
| New service connection | `wridd_schemes` | WRIDD schemes | Sheet (pub) · `CACHE_WRIDD` | 236 | 18 | hourly | csv |
| New service connection | `bharatnet_connections` | Bharat Net connections | Sheet (pub) · `CACHE_BHARATNET` | 52 | 13 | frequent | csv |
| New service connection | `icds_a_plus` | ICDS connections A+ | Sheet (pub) · `CACHE_ICDS_APLUS` | 630 | 16 | hourly | csv |
| New service connection | `icds_a` | ICDS connections A | Sheet (pub) · `CACHE_ICDS_A` | 3,538 | 15 | hourly | csv |
| Revenue | `loss_report` | Loss report | Sheet (pub) · `CACHE_LOSS` | 2,863 | 10 | frequent | csv |
| Revenue | `loss_targets` | Loss targets | Sheet (pub) · `CACHE_LOSS_TARGET` | 51 | 7 | frequent | csv |
| Revenue | `collection_report` | Collection report | Sheet (pub) · `CACHE_COLLECTION` | 42,597 | 5 | hourly | csv |
| Revenue | `theft_assessment` | Theft assessment | Sheet (export) · `CACHE_THEFT_ASSESSMENT_v2` | 8,013 | 20 | daily | csv |
| Revenue | `rem_osd` | REM OSD > Rs 5,000 | Sheet (gviz) · `CACHE_REM_v2` | 2,664 | 18 | hourly | csv |
| Revenue | `rem_defaulters_ind_com` | REM Ind/Com defaulters | Sheet (pub, TSV) · `CACHE_REM_DEFAULTERS` | 3,027 | 24 | hourly | tsv |
| Revenue | `rem_defaulters_agri` | REM Agri defaulters | Sheet (pub, TSV) · `CACHE_REM_AGRI` | 5,519 | 22 | hourly | tsv |
| Revenue | `rem_defaulters_dom` | REM Dom defaulters | Sheet (pub, TSV) · `CACHE_REM_DOM` | 8,027 | 22 | hourly | tsv |
| DD visit | `upcoming_dd` | Upcoming DD | Sheet (gviz) | 18,668 | 59 | daily | no (sensitive) |
| DD visit | `dd_visit` | DD visit consumers | Sheet (pub) · `CACHE_DD_VISIT` | 10,251 | 44 | daily | no (sensitive) |
| DD visit | `dd_summary` | DD summary | Sheet (pub) | 47,332 | 28 | daily | csv |
| Consumers & meters | `consumers` | Consumers | Sheet (pub) | 6,544 | 14 | hourly | csv |
| Consumers & meters | `docket_calls` | Docket calls | Sheet (pub) · `CACHE_DOCKET` | 4,326 | 11 | frequent | csv |
| Consumers & meters | `docket_kpi` | Docket KPI | Sheet (pub) | 1,129 | 6 | frequent | csv |
| Consumers & meters | `smart_meter_status` | Smart meter utilization | Sheet (pub, TSV) | 9,541 | 18 | hourly | tsv |
| Consumers & meters | `smart_meter_work_orders` | Smart meter work orders | Sheet (pub, TSV) | 17,863 | 20 | daily | tsv |
| Vendor advances | `costcenter` | Cost center map | data/costcenter.json · `CACHE_COSTCENTER` | 239 | 3 | daily | json |
| Vendor advances | `capex_details` | Capex details | Sheet (pub) · `CACHE_CAPEX` | 41,608 | 13 | daily | csv |
| Vendor advances | `onm_advance` | O&M advance | Sheet (pub) | 3,252 | 7 | hourly | csv |
| Vendor advances | `vendor_map` | Vendor map | Sheet (pub) · `CACHE_VENDORS` | 23,565 | 2 | daily | csv |
| Substation & network | `feeder_outage` | Feeder outage | Sheet (pub) · `CACHE_FEEDER_OUTAGE` | 5,730 | 16 | hourly | csv |
| Substation & network | `highway_crossings` | Line–highway crossings | Sheet (pub) | 5,266 | 22 | hourly | csv |
| Substation & network | `prt_transformers` | PRT / power transformers | Sheet (pub) | 35 | 9 | frequent | csv |
| Substation & network | `prt_oil_tests` | PRT oil test records | Sheet (pub) | 0 | 25 | frequent | csv |
| Substation & network | `power_map_taps` | Power map tap points | Sheet (pub) | 7 | 7 | hourly | csv |
| Important | `cmo_grievances` | CMO grievances | Sheet (pub) · `CACHE_CMO` | 280 | 17 | frequent | csv |
| Important | `pmsgy_malda` | PM Surya Ghar: Malda | Sheet (pub) · `CACHE_PMSGY_MALDA` | 3,675 | 156 | daily | csv |
| Important | `pmsgy_uttar_dinajpur` | PM Surya Ghar: Uttar Dinajpur | Sheet (pub) · `CACHE_PMSGY_UD` | 1,666 | 155 | daily | csv |
| Important | `pmsgy_dakshin_dinajpur` | PM Surya Ghar: Dakshin Dinajpur | Sheet (pub) · `CACHE_PMSGY_DD` | 1,076 | 154 | daily | csv |
| Important | `accident_reports` | Accident reports | Sheet (pub) | 1,631 | 50 | hourly | csv |
| Important | `safety_inspection` | Safety app inspections | Sheet (gviz) · `CACHE_SAFETY_v2` | 6,137 | 13 | daily | csv |
| Important | `manpower_staff` | Manpower: staff | Sheet (pub) | 818 | 25 | hourly | no (sensitive) |
| Important | `manpower_pins` | Manpower: page PINs | Sheet (pub) | 3 | 2 | frequent | no (sensitive) |
| Important | `substation_upkeeping` | Substation upkeeping | Sheet (pub) | 21 | 187 | frequent | csv |
| Important | `dtr_records` | DTR records | Sheet (pub) | 40,429 | 11 | daily | csv |
| Important | `dtr_peak_load` | DTR peak load measurements | Sheet (pub) | 91 | 13 | frequent | csv |
| Important | `stock_materials` | Stock materials (rates and categories) | Sheet (export) · `CACHE_STOCK_METADATA` | 254 | 5 | hourly | csv |
| Important | `puja_format_1_2025` | Puja Format-I 2025 | Sheet (export) | 58 | 10 | hourly | csv |
| Important | `puja_format_1_2026` | Puja Format-I 2026 | Sheet (pub) | 58 | 10 | hourly | csv |
| Important | `puja_format_2_2025` | Puja Format-II 2025 | Sheet (export) | 58 | 10 | hourly | csv |
| Important | `puja_format_2_2026` | Puja Format-II 2026 | Sheet (pub) | 58 | 6 | hourly | csv |
| Important | `puja_hourly_load_2025` | Puja hourly load 2025 | Sheet (export) | 14 | 21 | hourly | csv |
| Important | `puja_hourly_load_2026` | Puja hourly load 2026 | Sheet (export) | 14 | 21 | hourly | csv |
| Important | `important_unbilled_jan_2026` | Unbilled report Jan-2026 | Sheet (export) | 56 | 24 | daily | csv |
| Important | `important_unbilled_feb_2026` | Unbilled report Feb-2026 | Sheet (export) | 56 | 24 | daily | csv |
| Important | `important_unbilled_mar_2026` | Unbilled report Mar-2026 | Sheet (gviz) | 53 | 17 | daily | csv |
| Important | `important_unbilled_apr_2026` | Unbilled report Apr-2026 | Sheet (export) | 56 | 24 | daily | csv |
| Important | `important_unbilled_may_2026` | Unbilled report May-2026 | Sheet (gviz) | 53 | 17 | daily | csv |
| Important | `important_unbilled_jun_2026` | Unbilled report Jun-2026 | Sheet (gviz) | 53 | 17 | daily | csv |
| Important | `important_unbilled_jul_2026` | Unbilled report Jul-2026 | Sheet (export) | 56 | 24 | daily | csv |
| Important | `important_unbilled_aug_2026` | Unbilled report Aug-2026 | Sheet (export) | 56 | 19 | daily | csv |
| Important | `important_unbilled_3_months` | 3 months unbilled | Sheet (gviz) | 57 | 19 | daily | csv |
| Important | `important_first_bill_pending` | 1st bill not generated | Sheet (gviz) | 55 | 10 | daily | csv |
| Important | `important_smart_metering` | Smart metering | Sheet (gviz) | 13 | 6 | daily | csv |
| Important | `important_smart_meter_non_push` | Smart meter: non-push cases | Sheet (gviz) | 61 | 12 | daily | csv |
| Important | `important_rem_less_unit_billed` | REM less unit billed | Sheet (gviz) | 55 | 14 | daily | csv |
| Important | `important_rem_osd_followup` | REM OSD follow-up | Sheet (gviz) | 54 | 38 | daily | csv |
| Important | `important_rem_atr_summary` | REM ATR summary | Sheet (gviz) | 54 | 19 | daily | csv |
| Important | `important_rem_stw_osd` | REM STW OSD | Sheet (export) | 54 | 9 | daily | csv |
| Important | `important_rem_osd_age` | REM OSD age analysis | Sheet (export) | 56 | 53 | daily | csv |
| Administration | `structure` | Estimate structures | data/structure.csv | 26 | 6 | daily | csv |
<!-- inventory:end -->

### Not mirrored from Google, on purpose

- **Covered from Supabase by `supabase.js`:** `stock_snapshot`, `defective_summary`, `defective_details`, `disconnection`, `pending_mc`, `load_extension` (their Google sheets are only fallbacks; the app reads the Supabase Storage copies) and the Power Map substations. The Power Map *tap points* sheet is a separate Google sheet and is mirrored as `power_map_taps`.
- **Reachable only through Apps Script**, which the mirror must not call (several of its GET paths can write): disconnection follow-ups, DD visit history and the SM/DM and RM entry forms, the PRT "Map" tab (`?action=getInitialData`), the DTR load search, the stock allotment sheet (the allotments themselves are mirrored from Supabase) and the hub metadata script. The NSC follow-ups are an exception: their `Followups` tab is link-shared, so `nsc_followups` reads it through gviz.

## Storage structure

Every dataset is one PocketBase collection named `ds_<key>`, for example `ds_nsc_pending`, `ds_meter_erp`, `ds_portal_users`.

### Columns

Names, types and values are `lib/uniform.js`'s, the same module that builds the pages' uniform rows ([uniform-data.md](uniform-data.md)): the sync calls its `fieldNames`, `stats`, `chooseType` and `build` rather than having rules of its own, so a column has the same name and type in the portal as in `/api/data/rows/<key>` for the same bytes. `scripts/qa/mirror-types.js` checks that for every dataset ([below](#checking-that-the-mirror-and-the-uniform-rows-agree)).

- **Names:** the source header in snake_case ASCII: lowercase, anything that is not a letter or digit becomes `_`, repeats collapse, leading and trailing `_` go, a leading digit gets `c_` (`2025` → `c_2025`), at most 60 characters, duplicates get `_2`, `_3`. Names PocketBase reserves (`id`, `created`, `updated`, …) are treated as taken, so a source column `id` becomes `id_2`. An empty header becomes `col_<letter>` (`col_c` for column C). Columns with neither a header nor any value (spreadsheet padding) are dropped. `sys_datasets.columns` maps every field back to its original header.
- **Report-style sheets** (Puja, Important data sheets) have title rows and merged headers. They are copied with every row as data and columns named by letter (`col_a`, `col_b`, …), so nothing is lost to a guessed header.
- **Types**, inferred per column from all its non-empty values, where placeholders (`(null)`, `null`, `NA`, `N/A`, `#N/A`, `NIL`, `none`, `-`, `.`) do not count: they are empty in a typed column and stay as written in a text column.
  - **Identifier columns stay text**, whatever their values: names ending in `no`, `nos`, `id`, `empid`, `code`, `number`, `num`, `phone`, `mobile`, `mob`, `contact`, `pin`, `pincode`, `mru`, `won`, `account`, `acc_no` or `ifsc` (`con_id`, `ccc_code`, `phone_no`, `inst_no`), unless the name says it is a count or an amount (`count_of_doc_no`, `subsidy_amount_released_to_loan_account`). Leading zeros, search and joins keep working, and a phone column does not change type when someone types a landline.
  - `number` when at least 98 % parse as numbers. Indian (`12,34,567`) and Western (`1,234,567`) grouping commas are stripped. Codes with leading zeros (`007`) and integers of more than 15 significant digits (bank accounts) stay text, since a number would change them.
  - `date` when at least 98 % parse as dates: `dd/mm/yyyy`, `dd.mm.yyyy`, `dd-mm-yyyy`, `m/d/yyyy`, `yyyy-mm-dd`, ISO, `1-Oct-2026`, `Oct 1, 2026`, with optional times. Slash dates are read day-first unless the column only makes sense month-first (a day above 12 in the second place) or the source says `dateOrder: 'mdy'`. Date-only values are stored as UTC midnight. Times without a zone are India time (UTC+05:30), except zone-less ISO `T` timestamps from Supabase, which are UTC. Fractions of a second are cut to milliseconds.
  - `bool` when every non-empty value is Y/N, Yes/No or true/false.
  - `json` for Supabase json/array values (kept as objects).
  - `text` otherwise.
  - Primary-key columns stay text unless the source says otherwise. A source can force a type per column (`columnTypes`; Supabase tables take theirs from the Postgres column types); forcing `text` keeps PINs and codes exactly as written. These overrides are handed to `lib/uniform.js` as its `columnTypes`.
  - Header-less report sheets (`header: false`) keep every column, including empty ones, as `col_<letter>`, as uniform does.
- **Nothing is dropped.** When a column is typed but a few of its values (at most 2 %) do not parse, those values are kept word for word in a companion text field `<name>_raw` next to it (empty on the rows that did parse); its `columns` entry has `raw_of`. A placeholder is not such a value: it is simply empty.
- **Empty values.** In the uniform rows an empty number, date or yes/no is `null`. PocketBase 0.40.6 has no empty number or bool: it stores `null` as `0` and `false` (there is no nullable option; tested 2026-11-01). So every row has a system field `_nulls`, a json list of its number and bool fields that are empty (for example `["paid_amount","metered"]`), or `null` when there are none. `0` in a field listed there means "no value"; `0` in any other number field is a real zero. `_nulls` only means something for number and bool fields: while a column's type is changing it describes the field the portal shows (the old one), and a name left over from that for a column that became text is ignored and tidied by the next run. The portal shows listed fields as empty and leaves them out of CSV exports; to filter them in the API use `_nulls ~ '"paid_amount"'` (or `!~`). Empty dates are `''` and empty json is `null`, which PocketBase stores as they are, so they are not listed. Empty text is `''`.

### System fields on every `ds_` collection

| Field | Meaning |
|---|---|
| `id` | 15 characters derived from `_row_key` (so the sync can update or delete without a lookup) |
| `_row_key` | Unique. The source primary key when known (several key columns joined with `\|`), otherwise the sha1 of the row. Repeats get `:2`, `:3` in source order |
| `_row_no` | Position in the source (1 = first data row); the portal's default order |
| `_hash` | sha1 of the row's stored values, used to skip unchanged rows |
| `_synced_at` | When the sync last inserted or updated this row (not touched for unchanged rows) |
| `_nulls` | The row's number and bool fields that are empty in the source (stored as `0` / `false`), or `null` |

### Office fields and `dim_offices`

A `ds_` collection whose source has office columns (CCC code, CCC / unit name, division, region, circle, district, cost centre, plant…) also gets `_region`, `_division`, `_ccc_code` and `_ccc`: the row's office in the canonical list (`lib/offices.js`; empty when the row names no MZO office, e.g. a zone store, another zone's row in a statewide sheet, or a total row). `dim_offices` holds that list: one row per office (zone, 3 regions, 7 divisions, 41 CCCs) with code, parent, district, old plant codes and the aliases found in the data; the sync rewrites it when the list changes. Unknown, contradictory and out-of-zone office values reach `sys_quality_issues` as `office.*` checks. The glue is `vm/sync/lib/office_enrich.js` (three calls from `sync.js`, `upsert.js` and `run.js`); see [architecture.md](architecture.md#offices) and [data-quality-offices.md](data-quality-offices.md).

### Who can read it

Every `ds_` collection and both `sys_` collections can be listed and viewed only by signed-in portal users (`@request.auth.collectionName = "portal_users_auth"`) and superusers; create, update and delete are superuser-only. No collection has a public rule: the mirror holds PINs, staff bank details and consumer contact data as-is. `portal_users_auth` is an email + password auth collection with no self sign-up; provisioning creates the accounts. A fresh install's default `users` collection (public sign-up) is removed by a migration.

### `sys_datasets`: the registry

One row per source, written by the sync after every attempt: `key`, `label`, `group` (sidebar group in `app.html`), `pages`, `source_type` (`google_sheet`, `supabase_table`, `supabase_storage`, `json_file`, `other`), `source_ref` (spreadsheet id/gid, project/schema/table, file, plus the DataHub key), `source_url` (human-openable, no keys), `collection`, `row_count`, `column_count`, `columns` (`[{name, source_name, type, date_order?, raw_of?}]`), `primary_key`, `schedule`, `last_version`, `content_hash`, `last_synced_at` (data last written), `last_checked_at` (last attempt), `last_fetched_at` (last full download), `last_status` (`ok`, `unchanged`, `error`, `skipped`), `last_error`, `last_duration_ms`, `notes`, the snapshot fields `snapshot_file`, `snapshot_sha1`, `snapshot_bytes`, `snapshot_at`, and `source_modified_at` (when the source itself says it last changed, if it does).

### `sys_sync_runs`: the run log

One row per dataset attempt: `dataset`, `started_at`, `finished_at`, `status`, `rows_total`, `rows_inserted`, `rows_updated`, `rows_deleted`, `duration_ms`, `message` (counts, warnings, the error, and `[reason]` for targeted runs). Rows older than 30 days are pruned at the end of each run.

### Why the data collections are not migrations

`vm/pocketbase/pb_migrations/` creates only the fixed collections: `sys_datasets`, `sys_sync_runs`, `portal_users_auth`, and the settings. The `ds_` collections are created and altered by the sync at run time from what it reads, because their fields are the source headers: a clerk adding, renaming or retyping a sheet column would otherwise need a migration, a commit and a deploy before the mirror could follow. The sync keeps each collection in step on every run (new columns added, removed ones dropped, a retyped column migrated as below). For the same reason PocketBase runs with `--automigrate=false`: otherwise it writes a migration file for every change the sync makes.

### Type changes

PocketBase cannot change a field's type in place (`validation_field_type_change`), and dropping and re-adding a field leaves it empty until every row is written again. So when a column's type changes (a sheet starts holding text in a number column, or the inference rules change), the sync migrates it in two steps that never show the portal an empty column:

1. Before writing rows, it adds the new field next to the old one as `_stage_<name>`. The old field keeps its values, and fields the source no longer has stay too. Every row is then written, with the new values in `_stage_<name>`.
2. After the rows, one collection update drops the old field and renames `_stage_<name>` to `<name>` (PocketBase renames the column, so the values stay), drops the columns the source lost, and the registry's `columns` is updated right after.

The portal reads the field list from `sys_datasets.columns`, so it never sees the `_stage_` fields. A run that stops between the two steps (time limit, crash, restart) leaves both fields; the next run keeps `_stage_<name>`, writes only the rows that did not get their new values yet (their `_hash` still differs) and then swaps. Whenever a field is added to an existing collection, the run writes every row, so a new or renamed column is filled at once.

### Upgrading from the first sync (mzo-sync/1)

The VM's collections were written by mzo-sync/1 (its own inference, empties as `0`/`false`, no `_nulls`). `LOGIC_VERSION` is `mzo-sync/2`, a hash of `lib/uniform.js` is in the content salt, and a collection without `_nulls` is treated as out of date whatever its cheap version check says, so the first time each source runs after the deploy it is re-read in full and migrated with the type change steps above. What changes (measured on a copy of the mirror, 109 datasets, 2026-11-01):

- **Types:** 132 columns in 42 datasets change type: 114 identifier columns from number to text (`con_id`, `ccc_code`, `phone_no`, `inst_no`, `mat_code`, …), and 18 columns that placeholders had made text become number, date or yes/no (`insp_date`, `em_recp`, `paid_amount`, the accident safety-gear columns, …). 38 leftover fields are dropped: 34 `_raw` companions of columns that are text now or only had placeholders, and the four invented `column_17`–`column_20` of `disconnection`. Afterwards `scripts/qa/mirror-types.js` finds 0 of 2,504 columns and 0 of 16.5 million cells that differ from `lib/uniform.js`.
- **Rows:** `_nulls` is added to every collection. Rows with an empty number or bool, and every row of a collection with a retyped column, are written once (812,832 of 1,161,007 rows); the others keep their hash and are not written (40 datasets, among them `meter_erp`, need no writes at all). Record ids stay the same, except `disconnection`, whose rows are keyed by their content and lose four empty columns: its 19,906 rows get new ids, each old record deleted in the same batch as its new one is inserted, so its row count never changes.
- **Portal:** never shows an empty or missing column: the old field keeps its values until the swap, and while it is staged `_nulls` describes it (a row with an empty old number lists it, so it shows empty rather than 0). Such rows are tidied by the next run. Pages are not affected: they read the snapshots and `/api/data/rows`, which the migration does not touch.
- **Quality checks** may report a one-time `header.drift` on `disconnection` (its four blank headers no longer have invented names); it clears on the next run.

On the timer alone (`--due`), frequent and hourly datasets migrate within the hour and the daily dumps (meter ERP/master/CRM/ISU, capex, DD lists, DTR, PM Surya Ghar) at the next 02:00 IST run. To do all of them at once, run `node --env-file=/etc/mzo/pocketbase.env run.js --all --reason "mzo-sync/2 upgrade"` as `opc` in `/opt/mzo/app/vm/sync` once after the deploy (`sudo systemctl start mzo-sync` is a `--due` run). A source that hits its time limit mid-way resumes on its next run. While the `--all` run holds the sync lock, the app's write-through refreshes wait up to 10 minutes and then leave the work to the next timer run.

### Checking that the mirror and the uniform rows agree

```bash
node scripts/qa/mirror-types.js --snap <snapshot dir> --env <pb env file> [--live] [--values] [--only a,b] [--json out.json]
```

For every dataset it compares `lib/uniform.js` `build()` on the snapshot bytes (with the source's `header`, `dateOrder` and type overrides), the sync's own column builder on the same bytes, and the live collection's fields and `sys_datasets.columns`: names, types, date order, `_raw` companions and office fields. `--live` reads the datasets without a snapshot (sensitive ones, Supabase tables no page reads) from the source, GET only and in memory. It also lists where a `schema/<key>.json` pins a different type than the mirror infers (the pages' view). `--values` also compares every cell PocketBase holds with uniform's value for the same bytes (empties through `_nulls`, dates as instants) and counts missing and extra rows. `vm/dev/test-sync-types.js --env <local pb env>` runs a mzo-sync/1 collection through an interrupted, a resumed and an unchanged run on a local PocketBase.

## Schedules and change detection

The systemd timer starts `run.js --due` every 5 minutes; each source's schedule decides whether it is due:

| Schedule | Runs | Used for |
|---|---|---|
| `frequent` | every 5 min | small sheets clerks edit during the day (dockets, losses, CMO, follow-ups, NSC/Withheld) |
| `hourly` | every hour | mid-size sheets (collection, solar, REM defaulters, accidents, smart meters) |
| `daily` | once per India day, after 02:00 IST | multi-MB dumps (meter ERP/master/CRM/ISU, capex, DD lists, DTR, PM Surya Ghar) |

A source whose last attempt failed is retried within the hour. One run handles one source at a time.

For each due source:

1. **Cheap version check**, where the source has one (Supabase ETag/count, a repo file's sha1, the first two rows of NSC and Withheld). Unchanged → `unchanged`, nothing downloaded. A full download is still forced every 6 to 24 hours, and on every `--only` run.
2. **Download once**, streamed: the bytes go to the snapshot file and, at the same time, through the CSV parser into a temporary spool file, while the sync hashes the content and counts per-column statistics. Google sends no ETag or Last-Modified for these URLs, so for sheets this hash is the change check: same content as last time → `unchanged`, no database writes.
3. **Types** are inferred from the statistics and the collection is created or altered.
4. **Rows are diffed:** inserted when the `_row_key` is new, updated when `_hash` or `_row_no` changed, deleted when gone from the source, otherwise left alone. A first, key-only pass over the spool finds the records that go; each is deleted in the same batch transaction as the new record inserted at its row number, so a row whose key changes (rows without a primary key are keyed by their content) is replaced in one step and the portal never sees it twice. Writes use the PocketBase batch API (500 requests per transaction; measured faster than 50, 200 or 1000).
5. The registry row and a run-log row are written; the snapshot manifest is rewritten if a snapshot changed.

Safety: a source that suddenly returns no rows while the mirror has some is an error and the previous copy is kept. A sheet that stops being public (Google answers with a sign-in page or 401/403/404) is `skipped` with the reason and keeps its last copy. Each source has a time limit (4, 10 or 30 minutes by schedule, longer for the slow smart-meter TSVs); network errors, 429 and 5xx are retried three times with backoff; one source failing never stops the others.

Google's published (`/pub`) CSVs can lag an edit by up to about 5 minutes on Google's side; `/export` and gviz URLs are live.

## Snapshots

For every dataset the website reads, the sync keeps the exact source bytes in `MZO_SNAPSHOT_DIR` (default `/opt/mzo/data/snapshots` when that folder exists):

- `<key>.csv`, `<key>.tsv` (TSV sheets) or `<key>.json`: the bytes as fetched, for every source that provides `raw()` (all Google sheets, the repo files, the Supabase Storage CSVs and the Supabase tables the app reads). Other Supabase tables get no snapshot; they are only in PocketBase.
- `<key>.<ext>.gz` and `<key>.<ext>.br`: precompressed copies (brotli quality 9, or 5 above 1 MB).
- All written through hidden temp files and renamed into place, only when the sha1 of the bytes changed.
- `manifest.json`, rewritten atomically whenever a snapshot changes and at the end of each run:

```json
{ "generatedAt": "2026-11-01T06:32:15.136Z",
  "datasets": { "nsc_pending": {
      "version": "<sha1 of the bytes>", "bytes": 2140781, "contentType": "text/csv; charset=utf-8",
      "file": "nsc_pending.csv", "fetchedAt": "…", "snapshotAt": "…", "checkedAt": "…",
      "sourceModifiedAt": "2026-10-30T00:00:00.000Z",
      "sourceType": "google_sheet", "dataHubKeys": ["CACHE_NSC_v5"],
      "urls": ["https://docs.google.com/spreadsheets/d/…/gviz/tq?tqx=out:csv&sheet=nsc_working", "/api/nsc/dataset"],
      "sensitive": false, "label": "Pending NSC (working dump)", "rows": 5140 } } }
```

Fields beyond the obvious ones:

- `sourceModifiedAt` (only when known) is when the source itself last changed: an HTTP `Last-Modified`, or a report date the source exposes (NSC and Withheld: their TODAY column; Supabase Storage: the file's Last-Modified or meta report date). Google sheets send no modification time, so for them `snapshotAt` (when the mirror first saw the current bytes, at most one schedule interval after the edit) is the best "updated" date; `fetchedAt` is only the last check.
- `dataHubKeys` are the `mzo_data_hub.js` keys the snapshot replaces.
- `urls` are the exact URLs pages and `server.js` fetch, so a page's direct fetch can be mapped to the snapshot. A `?v=` parameter in them is a cache-buster and is kept as written. URLs a page builds at run time are listed fully built (meter utilization: `…/pub?output=csv&gid=<gid>`).
- `dataHubUrl` (optional; Power Map: `/api/power-map/data`) tells the client to load that DataHub key from that same-origin URL instead of `/api/data/file/<key>`.

**Sensitive sources never get a snapshot** and are not in the manifest: anything holding Aadhaar, PAN, bank account or PIN-like personal identifiers. From Google: `manpower_staff` (staff IFSC, bank account, PF account, PF trust ID, pay), `manpower_pins` (page PINs), `upcoming_dd` (consumer Aadhaar and PAN) and `dd_visit` (consumer PAN); from Supabase: portal users, DD user auth and activity logs (see [supabase.md](../vm/sync/sources/supabase.md)). They stay only in PocketBase, behind the portal sign-in, and their pages keep reading the original source. A source marked sensitive later has its old snapshot deleted on its next run. (Checked on 2026-11-01 by scanning every column name; PM Surya Ghar's "PIN Code" is a postal code and its bank fields are bank names and IFSC branch codes, so it is not sensitive.)

How the VM app serves the snapshots (`/api/data/manifest`, `/api/data/file/:key`) and how pages use them is described with the server and client changes.

## Admin → Sources: where each dataset comes from

`admin_users.html?tab=sources` (app menu → Administration → Sources) shows, for admins, where every dataset and live feature comes from, how it is refreshed and how fresh it is. It reads `GET /api/admin/sources-info` (admin only: 401 without a session, 403 for other users; a session with `role: admin` or `isAdmin: true` passes), built by `lib/sources_info.js` from:

- the sync's inventory (`vm/sync/sources/*.js`, loaded without network): label, group, pages, schedule, link to the original, sensitive;
- `manifest.json` (mirror mode): snapshot times, size and rows;
- PocketBase `sys_datasets` and the latest `sys_sync_runs` per dataset, plus errors and skips of the last 7 days (`PB_URL`, `PB_SUPERUSER_EMAIL`, `PB_SUPERUSER_PASSWORD`, which the app gets from `/etc/mzo/pocketbase.env`; GET requests and the superuser sign-in only). `sys_datasets.mode` (`native` = edited on the VM in the data editor, with `native_since`, `native_by`) is shown when present; a missing value means `mirror`;
- `lib/sources_live.js`: what the mirror does not know about (Apps Script features, `data/unbilled_*.csv`, the precomputed rating, Storage meta files, news RSS, the Ask API, map layers, link-only pages) and corrections to the inventory's page lists (pages that read the original although a copy exists, links that are not reads). Keep it in step when a page changes what it reads;
- the report list from the `app.html` NAV.

The answer is kept 60 s (`?refresh=1` rebuilds it). **By dataset** has one row per source: category (VM copy of a Google Sheet / Supabase table / Supabase Storage file, VM only, live Google Sheet, live Supabase, live through Apps Script, external), source type and link, refresh schedule and next due time, last checked, last copied (full download) and last changed, rows and size, the last run and error, and the pages that use it. **By report** has one row per menu report: its categories, sources, worst status and the oldest last check of its copies. Status: *Overdue* when the sync has not checked a source by its due time plus 10 min (frequent), 20 min (hourly) or 3 h (daily); *Stale* when the last successful check is older than 30 min, 3 h or 30 h; *Error* / *Skipped* from the last attempt; *Missing* / *Not set up* for server files or keys this server lacks. Sensitive sources and copies kept only in PocketBase count as read live, since that is what the pages do. Times are shown in IST.

Without mirror mode (Vercel, a local checkout) PocketBase is not read and every source shows as read live; the inventory, the descriptor and the reports still show. Tests: `node vm/dev/test-sources-info.js`.

## Running a sync by hand (VM)

```bash
sudo systemctl start mzo-sync          # one --due run now, as the timer would
journalctl -u mzo-sync -n 100          # what it did
```

A specific dataset, as the `opc` user, with the same environment as the service:

```bash
cd /opt/mzo/app/vm/sync
node --env-file=/etc/mzo/pocketbase.env run.js --only nsc_pending,withheld --reason "manual check"
node --env-file=/etc/mzo/pocketbase.env run.js --list         # inventory: key, schedule, type, group
node --env-file=/etc/mzo/pocketbase.env run.js --all          # everything now (slow: every dump)
```

Options: `--due`, `--all`, `--only <key[,key]>`, `--list`, `--dry-run` (download and infer types only; no PocketBase, no snapshots), `--force` (rewrite even if unchanged), `--strict` (exit 1 if any source failed), `--batch <n>`, `--reason <text>`. `--only` always downloads (skips the cheap version check) and, if another sync is running, waits up to 10 minutes for it instead of giving up, which is what the app's write-through refresh relies on; an unknown key in its list is logged and skipped. Two runs never overlap (a lock file in the temp dir). `SYNC_DEBUG=1` logs each phase of each source with its time and memory.

Keys the app's write-through should refresh after a write (the sheet the write lands in): NSC/Withheld publish → `nsc_pending`, `withheld`; NSC follow-ups → `nsc_followups`; DTR peak-load entry → `dtr_peak_load`; PRT new transformer → `prt_transformers`; PRT oil test → `prt_oil_tests`. DD visit saves go to a `DD_Visits` tab reachable only through Apps Script, which is not mirrored (`dd_visit` is the read-only consumer list), and disconnection follow-ups likewise. Supabase writes (stock, allotments, Power Map, important months) map to the keys in [supabase.md](../vm/sync/sources/supabase.md).

Other environment: `MZO_SNAPSHOT_DIR`, `SYNC_TMP_DIR` (spool files; default `$CACHE_DIRECTORY` from systemd, else `vm/sync/.tmp`), `SYNC_BATCH_SIZE`. The exit code is 0 unless the run itself failed (PocketBase unreachable, bad credentials, migrations missing); per-source failures are in `sys_datasets` and the log.

Locally: download the darwin PocketBase build into `vm/pocketbase/local/` (git-ignored). Create the superuser **before** the first `serve` on a new data folder (otherwise PocketBase opens its installer page in the browser), then start it and sync:

```bash
cd vm/pocketbase
./local/pocketbase superuser upsert you@example.com <password> --dir ./local/pb_data
./local/pocketbase serve --http 127.0.0.1:8091 --dir ./local/pb_data \
  --migrationsDir ./pb_migrations --automigrate=false
cd ../sync && npm ci && node --env-file=<your env file> run.js --all
```

## Memory and speed

The VM has about 500 MB of RAM, so the sync streams everything: rows go from the HTTP stream to a spool file on disk, and only per-column counters plus one compact index entry per existing row (about 60 bytes) stay in memory. Node's default young generation grows to tens of MB under the sync's allocation rate, so the sync runs with `--max-old-space-size=160 --max-semi-space-size=4` (about 60 MB less peak memory, same speed). The systemd unit passes these flags; started without them, `run.js` starts itself again with them.

<!-- measurements:start -->
Measured on a Mac (Node 24, PocketBase 0.40.6 on 127.0.0.1, 2026-11-01). On macOS an idle Node process that has made one `fetch` already shows about 105 MB RSS (Linux uses less), so the sync's own share is the difference:

| Run | Time | Peak RSS |
|---|---|---|
| First sync of all 76 sources into an empty PocketBase (1.06 M rows inserted, 72 snapshots written) | 7 min 36 s | 203 MB |
| Second run, nothing changed (all `unchanged`: every sheet downloaded and hashed, no writes) | 3 min 29 s | 117 MB |
| `meter_erp` first load (18.7 MB, 240,525 rows) | 47 s | 152 MB |
| `meter_master` first load (8.4 MB, 282,303 rows) | 45 to 70 s | 158 to 171 MB |
| `meter_erp` unchanged-content check | 9 s | 117 MB |

- The second run is download-bound: Google takes about 80 s to render each of the two smart-meter TSVs. A typical 5-minute `--due` tick checks about 15 small sheets in under 10 s.
- PocketBase inserts about 5,000 to 6,000 rows a second through the batch API; its own memory stayed near 50 MB.
- Disk after the first sync: `data.db` 339 MB, snapshots 116 MB (with their .gz and .br copies).
- Two fixes made these numbers: record ids built as flat strings (a `+=` loop kept a rope per id; 319 MB before) and a 1 MB brotli window for the snapshots (the default window took up to 440 MB of native memory on `meter_master` and `dd_summary`).
- Each run prints `peak RSS` in its last log line (`journalctl -u mzo-sync`), which gives the real figure on the VM.

mzo-sync/2 (types from `lib/uniform.js`, `_nulls`, staged type changes), same Mac, PocketBase 0.40.6, 109 sources, 1.16 M rows, 2026-11-01:

| Run | Time | Peak RSS |
|---|---|---|
| mzo-sync/1 first load into an empty PocketBase (the before state; same machine and day, for comparison) | 9 min 58 s | 225 MB |
| Upgrade run over that mirror: every source re-read, 132 columns retyped, 812,832 rows rewritten, 19,906 re-keyed | 21 min 42 s | 168 MB |
| After a `lib/uniform.js` rule change: every source re-read, 7 columns retyped in 5 datasets, 14,373 rows rewritten | 8 min 15 s | 211 MB |
| Nothing changed (109 `unchanged`; 9 s of CPU, the rest is waiting on Google, mostly the two smart-meter TSVs) | 6 min 25 s | 125 MB |
| `meter_master` type change alone (282,303 rows rewritten and swapped) | 1 min 38 s | 202 MB |

- Updates go at about 1,600 rows a second (inserts 5,000 to 6,000), so a type change costs about a minute per 100k rows; the swap itself (one collection update) took under a second on `meter_master`. Expect two to three times these times on the VM, so run the upgrade at a quiet hour.
- The upgrade run was measured before the key-only pass that keeps re-keyed rows from showing twice; that pass adds about 5 s and 6 MB on `meter_master`. The sync's own heap stays under 60 MB; most of the RSS is Node itself (about 105 MB on macOS, less on Linux).
- During the upgrade, readers polling like the portal (the sys_datasets columns, then 100 to 200 rows with those fields, every 0.3 s; 15,785 polls over 13 retyped collections) got no error and no missing column. A stricter reader that records every value it is shown, re-run over 6 retyped datasets, never saw a value other than the old or the new one (3,800 cells, 1,056 polls). Responses were mostly under 0.3 s; reads of `meter_master` during its own migration and swap stayed under 0.27 s. Under the heaviest load a few took 1 to 1.3 s (the 150-column PM Surya Ghar tables while being written), and once, during the full upgrade run, about 7 s (not reproduced; no request failed).
<!-- measurements:end -->

## Adding a source

1. Pick the file in `vm/sync/sources/` for its family (or add one: every `sources/*.js` is loaded; a file that throws is reported and skipped). A file exports `async function sources(ctx)` returning a list of sources:

```js
{
  key: 'stock_allotments',             // → ds_stock_allotments; snake_case, under 50 characters, never renamed
  label: 'Stock allotments',
  group: 'Important',                  // sidebar group in app.html NAV (or Admin / System)
  pages: ['stock/index.html'],
  sourceType: 'supabase_table',        // google_sheet | supabase_table | supabase_storage | json_file | other
  sourceRef: { project, schema, table },
  sourceUrl: 'https://…',              // human-openable, never with a key
  schedule: 'hourly',                  // frequent | hourly | daily
  primaryKey: ['id'],                  // original column names, or null
  columnTypes: { pin: 'text' },        // optional overrides by original column name
  dateOrder: 'mdy',                    // optional, for month-first slash dates
  notes: '…',                          // optional, shown in the portal
  dataHubKeys: ['CACHE_…'],            // snapshots: DataHub keys this dataset feeds
  dataHubUrl: '/api/…',                // optional: same-origin URL the client loads those keys from
  urls: ['https://…'],                 // snapshots: exact URLs pages/server fetch
  sensitive: false,                    // true: PocketBase only, never a snapshot
  async version(ctx) { return 'etag-or-count' },  // optional cheap version, or null
  async raw(ctx) { return { contentType, stream, modifiedAt } },  // optional: exact bytes (the snapshot);
                                       // modifiedAt: ISO time the source last changed, if known
  async *rows(ctx) { /* yield objects keyed by original column names, raw values,
                        or arrays with the header row first; when raw() exists,
                        parse ctx.input (the same bytes) instead of fetching again */ }
}
```

`ctx` gives `fetch` (GET/HEAD only, with timeout, retries and the source's abort signal), `log`, `env`, `limits.maxRowsPerBatch`, `signal` and, with `raw()`, `input`.

2. Run `node run.js --only <key> --dry-run` to see the row count and the inferred types, then `--only <key>` against a local PocketBase.
3. Add it to the inventory above.

Changing type inference or row hashing: bump `LOGIC_VERSION` in `lib/sync.js` so every source is re-read in full once. Type inference itself lives in `lib/uniform.js`; a hash of that file is part of the sync's content hash, so any change to it re-reads the sources by itself (sources with a cheap version check within their 24-hour full-download window), and the collections follow through the type change steps above. That run diffs every row (rows whose values did not change are not written).

## PocketBase setup

- Version pinned in `vm/pocketbase/VERSION` (0.40.6, the latest stable release on 2026-11-01).
- `pb_migrations/` sets: batch API on (up to 1000 requests per batch, 120 s), the default rate limits with 127.0.0.1 excluded (the sync), the client IP from Caddy's `X-Forwarded-For`, logs kept 7 days, dashboard collection controls hidden (the sync owns the schema). Then `sys_datasets`, `sys_sync_runs`, `portal_users_auth` (1-day sign-in tokens, no OAuth/OTP/MFA, no sign-up) and the snapshot fields.
- Always start it with `--migrationsDir /opt/mzo/app/vm/pocketbase/pb_migrations --automigrate=false`.
