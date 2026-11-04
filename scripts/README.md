# scripts

Node, SQL and Python tooling run by hand from the repo root. None of it is served or loaded by the app.

> These scripts talk to the **production** Supabase project and Google Sheets. Anything that syncs, imports, copies or repairs writes to production. Ask the owner before running one.

| Folder | What | How to run |
|---|---|---|
| `sql/` | Schema SQL for the Supabase SQL Editor: `create_*` for new tables, `upgrade_existing_tables.sql` for columns added since, `drop_legacy_tables.sql` | Paste into the editor; which file when in [docs/database.md](../docs/database.md#sql-files-scriptssql) |
| `sync/` | Mirror a published Google Sheet into Supabase Storage plus a small `meta.json` (`npm run sync:*`), or direct CRM batch ingestion (`npm run sync:defective:crm`) | `npm run sync:disconnection`, `sync:defective`, `sync:defective:crm`, `sync:pending-mc`, `sync:load-ext` (load `.env`) |
| `migrate/` | `copy_insight_to_new_supabase.js`: copies the live `mzo_insight` rows and stock snapshot into the new insight project before the login cutover | `npm run copy:insight` |
| `tools/` | Generators | see below |

## sync/

`common.js` holds the shared plumbing (fetch the published CSV, upload to Storage, write meta). Each `sync_*.js` adds the report's own summary numbers. Credentials come from env (`SUPABASE_*` / `INSIGHT_*`) or the git-ignored `data/supabase_config.json` (template: `supabase_config.example.json` in this folder).

- `sync_defective_from_crm.js` (`npm run sync:defective:crm`): 100% automated division-by-division CRM sync from DB2 (`ibm db2` connection via `dbviscmd.bat`), processed through `lib/defective_meter_pipeline.js`, and uploaded directly to Supabase Storage, bypassing Google Sheets. For a new batch run from DB2, use `npm run sync:defective:crm -- --fresh`. Use `--dry-run` to test locally without uploading.

## migrate/

Only the insight-project copy is left. Earlier one-off imports (users, activity logs, Power Map, stock snapshot and allotments) were run and removed; git history has them.

## tools/

| File | Does |
|---|---|
| `generate_stock_material_category.js` (`npm run tools:stock-categories`) | Rebuilds `stock/stock_material_category.js` from the Local/Central material sheet |
| `compute_briefing_cccs.js` (`npm run tools:briefing-cccs`) | Adds per-division CCC hotspots to the local `data/*_meta.json` files |
| `generate_mzo_icons.py` | Draws the PWA icons in `icons/` (needs Pillow) |
| `check_syntax.js` (`node scripts/tools/check_syntax.js`) | `node --check` on every JS file and inline `<script>`, JSON parse; CI runs it ([docs/vm.md](../docs/vm.md#github-actions)) |
