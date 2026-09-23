# NSC datasets → Google Sheets

NSC no longer stores rows in Supabase. Upload at `/nsc/upload.html` processes the raw SAP Excel in the browser and inserts cleaned rows into:

- Working/Accepted → spreadsheet tab `nsc_working` (status Working/Accepted stays here even if a withheld date or reason is still filled). One row per `APPL_NO` (last row wins) so a repeated consumer in the same division is not counted twice.
- Withheld → NSCWH tab `Sheet1`

If the file has **no** Withheld status rows, upload **does not clear** the Withheld sheet. It keeps the previous Withheld data and previous withheld row count in meta.

A small version record (who / when / row counts) is stored in Apps Script document properties plus optional local `data/nsc_meta.json`.

## Removed tables

Run [`drop_mzo_insight_nsc_tables.sql`](drop_mzo_insight_nsc_tables.sql) in the Supabase SQL Editor to drop:

- `mzo_insight.nsc_pending`
- `mzo_insight.nsc_withheld`
- `mzo_insight.nsc_upload_meta`

Do **not** drop `nsc_upload_autho` on `portal_users` — that flag still controls who can upload.

## Access

Upload requires admin, `nsc_upload_autho`, or legacy `dm1`. Grant via Admin → User Management → **NSC Raw Upload**. Admins always can, even if that flag is blank.
