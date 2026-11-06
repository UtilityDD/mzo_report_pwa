# Supabase sources

`supabase.js` gives the sync every Supabase dataset as a Source (see the adapter interface in `docs/data-mirror.md`). It only reads: every request is a GET or HEAD, enforced in `httpGet_`, and nothing calls `/rpc/`.

| Project | What | Access |
|---|---|---|
| Old `unsmtschmcvftfqwabaq` | Tables in `public`, `mzo_insight` and `powermap`, through PostgREST | anon key: env `SUPABASE_ANON_KEY`, else `SUPABASE_FALLBACK_ANON_KEY` read from `server.js` at runtime. A key for another project is refused. |
| New (Insight) `gmasnqebdogtavoudbke` | The `mzo_insight` tables marked `insight: true` (logins, activity logs, stock ledger and sequence, unbilled months, stock upload history and snapshot copy), when `INSIGHT_LIVE` is on and `INSIGHT_SUPABASE_URL` and `INSIGHT_SUPABASE_KEY` are set, the same switch `server.js` uses. Production runs this way, so the mirror follows it. `prioritySI` exists only on the old project and stays there. | `INSIGHT_SUPABASE_KEY` (service key, server side only, GET only; on the VM in `/etc/mzo/app.env`, root-only). A key for another project is refused. |
| New `gmasnqebdogtavoudbke` | Public Storage snapshot CSVs | no key, public object URLs |

## Datasets

Rows as of 2026-11-01. Schedules: `frequent` = every 5 min, `hourly`, `daily` (`vm/sync/lib/schedule.js`).

### Old project tables (`sourceType: supabase_table`)

| Key | Schema.table | Rows | Schedule | Primary key | Page |
|---|---|---:|---|---|---|
| `portal_users` | `mzo_insight.portal_users` | 122 | hourly | `id` | admin_users.html?tab=users |
| `activity_logs` | `mzo_insight.activity_logs` | 4,247 | hourly | `id` | admin_users.html?tab=activity |
| `si_works` | `mzo_insight."prioritySI"` | 291 | hourly | `id` | si-works/si.html |
| `stock_allotments` | `mzo_insight.stock_allotments` | 180 | hourly | `id` | stock/index.html |
| `stock_allot_seq` | `mzo_insight.stock_allot_seq` | 1 | hourly | `year` | stock/index.html |
| `important_unbilled_months` | `mzo_insight.important_unbilled_months` | 8 | hourly | `id` | important_sheets.html |
| `stock_upload_meta` | `mzo_insight.stock_upload_meta` | 16 | daily | `id` | stock/upload.html |
| `stock_snapshot_db` | `mzo_insight.stock_snapshot` | 952 | daily | `id` | stock/index.html |
| `power_map_substations` | `public.mzo_power_substations` | 98 | hourly | `id` | power_map/map.html |
| `power_map_corrections` | `public.mzo_power_corrections` | 2 | hourly | `id` | admin_users.html?tab=corrections |
| `power_map_suggested_corrections` | `public.suggested_corrections` | 0 | daily | none | (legacy) |
| `dd_user_auth` | `public.user_auth` | 65 | daily | `id` | (legacy Upcoming DD login) |
| `powermap_assets` | `powermap.assets` | 635 | hourly | `id` | |
| `powermap_substations` | `powermap.substations` | 263 | hourly | `asset_id` | |
| `powermap_lines` | `powermap.lines` | 364 | hourly | `asset_id` | |
| `powermap_transformers` | `powermap.transformers` | 202 | hourly | `id` | |
| `powermap_tap_nodes` | `powermap.tap_nodes` | 3 | hourly | `asset_id` | |
| `powermap_tap_laterals` | `powermap.tap_laterals` | 3 | hourly | `asset_id` | |
| `powermap_voltage_levels` | `powermap.voltage_levels` | 5 | hourly | `id` | |
| `powermap_org_units` | `powermap.org_units` | 9 | hourly | `id` | |
| `powermap_editors` | `powermap.editors` | 0 | hourly | none | |
| `powermap_edit_suggestions` | `powermap.edit_suggestions` | 0 | hourly | none | |
| `powermap_profiles` | `powermap.profiles` | 0 | hourly | none | |
| `powermap_v_substations` | `powermap.v_substations` (view) | 165 | hourly | `id` | |
| `powermap_v_lines` | `powermap.v_lines` (view) | 209 | hourly | `id` | |
| `powermap_v_tap_nodes` | `powermap.v_tap_nodes` (view) | 3 | hourly | `id` | |
| `powermap_v_tap_laterals` | `powermap.v_tap_laterals` (view) | 3 | hourly | `id` | |

- `portal_users` and `dd_user_auth` are copied as-is, PIN included. On the old project most PINs are still plain digits, so `pin` (like every `text` column) is typed `text` to keep leading zeros.
- The old project's `portal_users` lacks the columns that `scripts/sql/upgrade_existing_tables.sql` adds later (`email`, `user_status`, sync flags, …). The mirror follows the live table, so they appear when the table gets them.
- `stock_upload_meta` and `stock_snapshot_db` stopped changing when the stock dump moved to Storage (`STOCK_USE_STORAGE`). The live dump is `stock_snapshot` below.
- `powermap` is a second Power Map data model (assets, lines, tap nodes, PostGIS `geom` as hex EWKB text) in the same project. No page in this repo reads it. Primary keys of the views are unique today; views have no key in Postgres.
- Primary keys come from `scripts/sql/*.sql` where a table is defined there, otherwise from the `id` / `asset_id` columns. Every one was checked unique and non-blank on a full read.

### New project Storage files (`sourceType: supabase_storage`, all `frequent`, no primary key)

| Key | File | Rows | DataHub key | Group | Page |
|---|---|---:|---|---|---|
| `stock_snapshot` | `stock/snapshot.csv` | 950 | `CACHE_STOCK` | Important | stock/index.html |
| `defective_summary` | `reports/defective/summary.csv` (`summaryCsvUrl`) | 12,435 | `CACHE_DEFECTIVE` | Consumers & meters | consumer/defective_meter.html |
| `defective_details` | `reports/defective/details.csv` (`detailsCsvUrl`) | 55,997 | `CACHE_DEFECTIVE_DETAILS` | Consumers & meters | consumer/defective_meter.html |
| `disconnection` | `reports/disconnection/snapshot.csv` (`csvUrl`) | 19,906 | `CACHE_DISCONNECTION` | Revenue | disconnection.html |
| `pending_mc` | `reports/pending_mc/snapshot.csv` (`csvUrl`) | 2,153 | `CACHE_PENDING_MC` | New service connection | pending_mc.html |
| `load_extension` | `reports/load_extension/snapshot.csv` (`csvUrl`) | 821 | `CACHE_LOAD_EXT` | New service connection | pending_load_extension.html |

- The CSV URL comes from `reports/<folder>/meta.json` (the same file `server.js` `syncedMeta_` reads). If the meta is missing or not JSON, the plain object path is used.
- These keys also exist in `mzo_data_hub.js` with Google Sheet fallback URLs. Mirror them only from here, not again from the Google adapter.
- No primary key is set for CSVs. On the full read, these columns were unique: Plant+Material+Storage Location (stock), `CON_ID` (disconnection), `APPL_NO` (pending MC, load extension). `CON_ID` repeats in defective details (30,659 distinct in 55,997 rows).

## Mirror mode: snapshots and the fields for them

Each source carries the phase 2 fields (`agent-progress/CONTRACT-PHASE2.md`, "Snapshot store"):

| Field | Set on |
|---|---|
| `sensitive: true` | `portal_users`, `dd_user_auth` (PINs), `activity_logs` (usernames, names, pages visited), `powermap_org_units` (staff names and phones), `powermap_editors` and `powermap_profiles` (user accounts, empty today), and any table found only through the OpenAPI root. They stay in PocketBase only. Everything else is `false`. |
| `raw(ctx)` | the six Storage CSVs, plus the four tables the server or a page reads: `power_map_substations`, `stock_allotments`, `important_unbilled_months`, `si_works`. A source without `raw()` gets no snapshot. |
| `dataHubKeys` | `stock_snapshot` → `CACHE_STOCK`, `defective_summary` → `CACHE_DEFECTIVE`, `defective_details` → `CACHE_DEFECTIVE_DETAILS`, `disconnection` → `CACHE_DISCONNECTION`, `pending_mc` → `CACHE_PENDING_MC`, `load_extension` → `CACHE_LOAD_EXT`, `power_map_substations` → `CACHE_POWER_MAP`. `[]` elsewhere. |
| `dataHubUrl` | `power_map_substations` only: `/api/power-map/data`. Its snapshot is JSON, but `CACHE_POWER_MAP` holds the CSV that endpoint builds from it, so the DataHub must load the key from that URL, not from `/api/data/file/power_map_substations`. |
| `urls` | Storage: the public object URL, e.g. `https://gmasnqebdogtavoudbke.supabase.co/storage/v1/object/public/stock/snapshot.csv`. The server (`stockPublicCsvUrl_`) and `meta.json` add `?v=<version>`, so matching must ignore `v`. Tables with `raw()`: the PostgREST URL their reader sends (below). `[]` elsewhere. |

**`raw(ctx)`.**
- Storage CSVs return `{ contentType: 'text/csv', stream, url, etag, bytes }`. The stream is a Node stream of the object's exact bytes, never buffered. The MD5 of the bytes equals the object's ETag, and `bytes` equals Content-Length.
- Tables return `{ contentType: 'application/json', stream, rows }`: the exact PostgREST response to the reader's query. When the reader pages (allotments), the pages are joined the way PostgREST joins rows (`, \n `). With one page, the usual case, the bytes are identical to what the reader gets today; `inspect-supabase.js --raw` checks this.
- The framework calls `raw()` once and passes the same bytes to `rows()` as `ctx.input`. `rows()` parses `ctx.input` when it is present (CSV rows, or the JSON array in the reader's order) and fetches on its own only when it is absent (the inspect tool, older callers). `csvRows(stream)` is exported as well.

### What the VM server reads in mirror mode, and the snapshot shape it needs

Each snapshot is the PostgREST JSON array, with every column, in the reader's order. The endpoint applies its usual mapping to it, so its response stays byte-for-byte the same.

| Endpoint or page | Snapshot | Query it replaces (old project) | What the endpoint does with the array |
|---|---|---|---|
| `GET /api/power-map/data` (`CACHE_POWER_MAP`) | `power_map_substations.json` | `public.mzo_power_substations?select=*&limit=5000`. No `order`, so rows come in Postgres's natural order, which today equals `id` order. | Keep rows with non-blank `Substation`, `LATITUDE` and `LONGITUDE`. Emit a CSV with the 22 columns `Region, Division, Substation, MVA, LATITUDE, LONGITUDE, Connected to, Colour, RL, LineStyle, Para-1, Para-2, Para-3, Comment, Symbol, SymbolSize, LegendText, LegendSymbol, LegendColour, Remarks, ConductorSize, PeakLoad`: `null` becomes empty, a value with `,` `"` or a newline is quoted with `""`, lines are joined by `\n` with no trailing newline. Send it through `sendDatasetCsv_` (text/csv, body ETag). |
| `GET /api/power-map/meta`, the Power Map entry of `/api/hub/versions` | same file | `?select=updated_at&order=updated_at.desc&limit=1` and `?select=Substation` | `version` = the largest `updated_at` string as PostgREST prints it (e.g. `2026-07-24T12:05:59.813168+00:00`), `rows` = array length. |
| `GET /api/stock/allotment?action=listAllotments\|getAllotment` | `stock_allotments.json` | `mzo_insight.stock_allotments?select=*&order=date.desc,allotment_no.desc&limit=1000&offset=N`, all pages | Map each row with `allotDbToClient_`, then `filterAllotmentRowsLocal_` (list) or match `AllotmentNo` (get). Respond `{ status: 'success', rows, count, source: 'supabase' }` (get adds `allotmentNo`). Lines of one allotment share `date` and `allotment_no`; their relative order is whatever Postgres returns for this query, so the snapshot must come from this exact query, not from the id-ordered `rows()`. |
| `GET /api/important-sheets/unbilled` | `important_unbilled_months.json` | `mzo_insight.important_unbilled_months?select=*&order=sort_order.asc,id.asc`, plus `&active=eq.true` unless a manager asks `?all=1` | Keep `active === true` rows unless `all=1`, map with `mapUnbilledMonthRow`, respond `{ status: 'success', months }`. |
| `si-works/si.html` (browser, supabase-js) | `si_works.json` | `mzo_insight.prioritySI?select=*` (what `.from('prioritySI').select('*')` sends): natural order, at most 1000 rows | The page uses the array as-is. The page also writes straight to Supabase, so the VM's write-through never sees those edits. Keep this page on live Supabase, or refresh `si_works` more often than hourly. |

All four readers are capped at 1000 rows by Supabase's max-rows, including `limit=5000`. `raw()` sends the same query and logs a warning when the table holds more rows than the query returns.

### Found while mapping

- **`CACHE_POWER_MAP` loads the Google Sheet today, not Supabase.** `/api/power-map/meta` returns `csvUrl: POWER_MAP_SHEET_CSV_URL`, and the DataHub (`originHeavy`) downloads that URL, so the map shows the published sheet. `/api/power-map/data` (Supabase) is used only when the DataHub fails. Edits go to Supabase, and the sheet already differs from the table in 3 values, with the same 98 substations. In mirror mode `/api/power-map/meta` should point `csvUrl` at `/api/power-map/data`. That fixes the stale values, but parity checks will show those 3 differences.
- **Stock meta.** In production, `/api/stock/meta` reads `stock_upload_meta` from the new project with its service key, which the mirror cannot read. The old project's `stock_upload_meta` (`stock_upload_meta` here) stopped in August. The as-on date of the live dump is the `Date` column of `stock_snapshot`. The VM app, with no `.env`, currently serves the old project's stale meta and the Google stock sheet.
- **Report meta files.** `reports/<folder>/meta.json` (version, report date, KPI stats) feeds the meta endpoints and `/api/executive/briefing`. It is not a source here: it is public and tiny, and `syncedMeta_` caches it for 60 s. If those endpoints must not touch Supabase in mirror mode, each could become a source with a JSON `raw()`.

## How it reads

**Tables.** Pages of 1000 rows (`limit`), ordered by the primary key, using keyset paging (`pk=gt.<last>`). A table without a key is ordered by `order` (`created_at` for the empty powermap tables) and paged with `offset`. The first page asks `Prefer: count=exact`, and paging continues until the exact count has arrived, so a lower server row cap cannot cut a table short. Rows are yielded as PostgREST returns them: numbers, booleans and json values (objects) stay typed, and timestamps are ISO strings such as `2026-07-27T05:39:57.785703+00:00`.

**CSVs.** The body is streamed into `csv-parse` and never held whole. The header row and then each row's cells are handed to the sync as arrays, so the sync names the columns exactly as `lib/uniform.js` does from the same bytes: a blank header with no values is padding and dropped (the disconnection sheet has four), a blank header with values becomes `col_<letter>`, a repeated one `<name>_2`. Rows where every cell is blank are skipped. Values stay as raw strings for sync-core to type.

**version().**

| Source | Version string | Cost |
|---|---|---|
| Table ≤ 3000 rows | `n:<count>\|h:<sha1 of all rows>` | the whole table (largest: 952 rows, ~0.3 s). The rows are kept and reused by the `rows()` call that follows, so nothing is downloaded twice. |
| Table > 3000 rows (`activity_logs`) | `n:<count>\|id:<max id>` | two `limit=1` GETs |
| Storage file with meta | `meta:<version>\|<updatedAt>` | one small JSON GET |
| `stock_snapshot` | `e:<ETag>` (else `m:` Last-Modified, `l:` length) | one HEAD |

Count plus max is not enough on small tables: logins change `portal_users.last_login` without touching `updated_at`, and `last_login` mixes `dd/mm/yyyy` and ISO values, so its max says nothing. A hash of the rows catches every change.

**Column types** (`columnTypes`) come from `supabase.columns.json`: bigint, integer, numeric, double precision → `number`; timestamptz, timestamp, date → `date`; boolean → `bool`; json, jsonb, arrays → `json`; text, uuid, enums, geometry → `text`. The file was generated by probing each column with a read-only filter that Postgres rejects with the column's type (`?col=eq.zz&limit=0` → "invalid input syntax for type bigint"). The results match the definitions in `scripts/sql/` wherever a table is defined there. Columns missing from the file get no override, and sync-core infers them.

**Why there is a fixed table list.** Supabase now serves the PostgREST OpenAPI root (`GET /rest/v1/`) only to the service key ("Only the service_role API key can be used for this endpoint"), so the anon key cannot list tables or read column formats. The list in `TABLES` was built from `scripts/sql/*.sql`, `server.js`, `si-works/si.html`, git history and probing: PostgREST suggests similar table names ("Perhaps you meant …") when an embed names an unknown relation. `sources()` still tries the OpenAPI root of each schema on every run; if it ever answers, tables missing from the list are added from it (schedule `daily`, group `System`).

## Not mirrored

| Schema.table | Reason |
|---|---|
| `public.profiles`, `public.logs`, `public.versions`, `public.offers`, `public.receipts`, `public.approvals`, `public.items`, `public.invoices`, `public.invoice_lines`, `public.di` | anon key: permission denied (42501). Not part of this app; reading them would need another key. |
| `public.pm_*` (13 views: `pm_assets`, `pm_lines`, `pm_substations`, `pm_transformers`, `pm_tap_nodes`, `pm_tap_laterals`, `pm_voltage_levels`, `pm_org_units`, `pm_editors`, `pm_edit_suggestions`, `pm_profiles`, `pm_v_substations`, `pm_v_lines`) | byte-identical aliases of the `powermap` tables and views, mirrored once from `powermap` |
| `mzo_insight.nsc_pending`, `nsc_withheld`, `nsc_upload_meta`, `user_access`; `public.user_access` | dropped (`scripts/sql/drop_legacy_tables.sql`) |
| `public.upcomingdd` | gone; Upcoming DD reads a Google Sheet now |
| `graphql_public` | exposed schema with no tables |
| Column lists of the empty tables (`suggested_corrections`, `powermap.editors`, `edit_suggestions`, `profiles`) | unknown until they have rows; they sync as empty datasets meanwhile |

Every table defined in `scripts/sql/` is readable by the anon key and mirrored. Storage buckets cannot be listed without a key (listing is a POST), so only the known files above are read.

## Testing

```
cd vm/sync && npm install
node tools/inspect-supabase.js                  # every source, first 5 rows
node tools/inspect-supabase.js --full           # every row, key checks, timings
node tools/inspect-supabase.js --only portal_users,defective_details --limit 20
node tools/inspect-supabase.js --full --no-checks --only defective_details   # memory test
node tools/inspect-supabase.js --raw --limit 1  # read every raw() snapshot: bytes, sha1, ETag and query checks
node tools/inspect-supabase.js --discover       # re-probe column types → supabase.columns.json
node tools/inspect-supabase.js --discover --scan   # also look for tables not in the list (~1 min)
```

It prints key, version, row count, columns with types (`*` = inferred from the rows read, as sync-core would), one sample row and the mirror fields. PIN, password, token, key-like, phone and email values are masked in everything it prints.

Measured on 2026-11-01 from a laptop (Node 24):

| Run | Rows | Time | Peak RSS |
|---|---:|---:|---:|
| `--full`, all 33 sources | 100,108 | 13.5 s | 149 MB |
| `defective_details` only (8.6 MB CSV) | 55,997 | 2.2 s | 123 MB |
| `activity_logs` only | 4,247 | 1.1 s | 114 MB |
| bare `node` | | | 49 MB |

Every run also completes with `node --max-old-space-size=32`, so the JS heap stays small. Most of the RSS is Node, fetch and TLS overhead. `raw()` of `defective_details`, hashed and parsed from the same stream: 2.3 s, 115 MB peak RSS with that heap cap.
