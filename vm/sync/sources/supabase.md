# Supabase sources

`supabase.js` gives the sync every Supabase dataset as a Source (see the adapter interface in `docs/data-mirror.md`). It only reads: every request is a GET or HEAD, enforced in `httpGet_`, and nothing calls `/rpc/`.

| Project | What | Access |
|---|---|---|
| Old `unsmtschmcvftfqwabaq` | Tables in `public`, `mzo_insight` and `powermap`, through PostgREST | anon key: env `SUPABASE_ANON_KEY`, else `SUPABASE_FALLBACK_ANON_KEY` read from `server.js` at runtime. A key for another project is refused. |
| New `gmasnqebdogtavoudbke` | Public Storage snapshot CSVs | no key, public object URLs |

## Datasets

Rows as of 2026-11-01. Schedules: `frequent` = every 15 min, `hourly`, `daily`.

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

## How it reads

**Tables.** Pages of 1000 rows (`limit`), ordered by the primary key, using keyset paging (`pk=gt.<last>`). A table without a key is ordered by `order` (`created_at` for the empty powermap tables) and paged with `offset`. The first page asks `Prefer: count=exact`, and paging continues until the exact count has arrived, so a lower server row cap cannot cut a table short. Rows are yielded as PostgREST returns them: numbers, booleans and json values (objects) stay typed, and timestamps are ISO strings such as `2026-07-27T05:39:57.785703+00:00`.

**CSVs.** The body is streamed into `csv-parse` and never held whole. Each row becomes an object keyed by the original header. A blank header becomes `Column <n>` and a repeated one `<name> (2)`, because object keys must be unique (the disconnection sheet has four blank headers). Rows where every cell is blank are skipped. Values stay as raw strings for sync-core to type.

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
node tools/inspect-supabase.js --discover       # re-probe column types → supabase.columns.json
node tools/inspect-supabase.js --discover --scan   # also look for tables not in the list (~1 min)
```

It prints key, version, row count, columns with types (`*` = inferred from the rows read, as sync-core would) and one sample row. PIN, password, token, key-like, phone and email values are masked in everything it prints.

Measured on 2026-11-01 from a laptop (Node 24):

| Run | Rows | Time | Peak RSS |
|---|---:|---:|---:|
| `--full`, all 33 sources | 100,108 | 13.5 s | 149 MB |
| `defective_details` only (8.6 MB CSV) | 55,997 | 2.2 s | 123 MB |
| `activity_logs` only | 4,247 | 1.1 s | 114 MB |
| bare `node` | | | 49 MB |

Every run also completes with `node --max-old-space-size=32`, so the JS heap stays small. Most of the RSS is Node, fetch and TLS overhead.
