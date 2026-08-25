# NSC datasets → Google Sheets

NSC no longer stores rows in Supabase. Upload at `/nsc/upload.html` processes the raw SAP Excel in the browser and inserts cleaned rows into:

- Working/Accepted → spreadsheet tab `nsc_working`
- Withheld → NSCWH tab `Sheet1`

A small version record (who / when / row counts) is stored in Apps Script document properties plus optional local `data/nsc_meta.json`.

## Removed tables

Run [`drop_mzo_insight_nsc_tables.sql`](drop_mzo_insight_nsc_tables.sql) in the Supabase SQL Editor to drop:

- `mzo_insight.nsc_pending`
- `mzo_insight.nsc_withheld`
- `mzo_insight.nsc_upload_meta`

Do **not** drop `nsc_upload_autho` on `portal_users` — that flag still controls who can upload.

## Access

Upload requires `nsc_upload_autho` (or legacy `dm1`). Grant via Admin → User Management → **NSC Raw Upload**.
