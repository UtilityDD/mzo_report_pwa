# Stock dump + allotments → Supabase

## One-time SQL (Supabase SQL Editor)

1. [`create_mzo_insight_stock_snapshot.sql`](create_mzo_insight_stock_snapshot.sql)
2. [`create_mzo_insight_stock_allotments.sql`](create_mzo_insight_stock_allotments.sql)
3. [`alter_portal_users_stock_auth.sql`](alter_portal_users_stock_auth.sql)

Ensure schema `mzo_insight` is exposed in API settings.

## Stock dashboard dump

- Upload: `/stock/upload.html` (users with **Stock Raw Upload = Yes**)
- Flow: raw SAP Excel → clean → `stock_snapshot` + local `data/stock.csv`
- Workbook layout:
  - **Sheet1** — SAP stock rows (Material + Material Group required)
  - **Local/Central** is hardcoded by material code in `lib/stock_material_category.js` (+ `stock/stock_material_category.js`); regenerate with `node scripts/generate_stock_material_category.js` if the master list changes
- If `stock_snapshot` already exists without category, also run [`alter_stock_snapshot_add_category.sql`](alter_stock_snapshot_add_category.sql)
- Dashboards: `/api/stock/dataset` → DataHub `CACHE_STOCK` (Sheet fallback until removed)
- **One-time Sheet → DB migrate:** `node scripts/migrate_stock_sheet_to_supabase.js`
  - also writes `scripts/import_stock_snapshot.sql` for manual SQL Editor import
- Filename: any name; optional `DD-MM-YYYY` in name only pre-fills the report date
- Size: app accepts up to ~60 MB locally; **Vercel live ~4.5 MB** until browser-publish is added (same as early NSC)
- **One-time Sheet → DB import:** run `node scripts/generate_stock_snapshot_import_sql.js`, then execute `scripts/import_stock_snapshot.sql` in Supabase SQL Editor

## Allot Material / View Allotments

- **Create** → Supabase `stock_allotments` (Apps Script fallback if Supabase create fails)
- **View** → Supabase `stock_allotments` (Sheet only if Supabase unreachable)
- **Migrate:** open View Allotments → **Migrate from Sheet**, **or** run generated SQL:
  - `node scripts/generate_stock_allotments_import_sql.js` → creates `scripts/import_stock_allotments.sql`
  - Paste that SQL into Supabase SQL Editor and run
- Auth create: **Stock Allot Create = Yes** (legacy usernames zm / aritra / dm1 still work)

## Admin UI

User Management → Stock Raw Upload / Stock Allot Create.
