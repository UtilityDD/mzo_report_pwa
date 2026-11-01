# Stock

The Stock page (`stock/index.html`) shows the SAP stock dump; `stock/upload.html` publishes a new dump; **Allot Material** / **View Allotments** keep a ledger of allotments and diversions between offices. The published dump is never modified by an allotment.

> Local development talks to production. Uploading, allotting or cancelling from localhost writes real data.

## Stock dump

- **Upload:** `/stock/upload.html`, for admins and users with **Stock Raw Upload = Yes** (`stock_upload_autho`). Others see the page locked.
- **Workbook:** `Sheet1` of the SAP export (Material and Material Group are required). The Excel is cleaned **in the browser** (`stock/stock_client_pipeline.js`); dump bytes never pass through Vercel.
- **Where it goes:** when `STOCK_USE_STORAGE=1` and `INSIGHT_SUPABASE_URL` / `INSIGHT_SUPABASE_KEY` are set (production today), the browser `PUT`s `stock/snapshot.csv` to Supabase Storage with a signed upsert URL from `/api/stock/meta`, then `/api/stock/publish` records only the meta. Supabase returns the signed path as `/object/upload/sign/...`; prefix it with `/storage/v1` or the PUT 404s. Without Storage the page publishes to the Google Sheet through Apps Script.
- **Dashboard:** DataHub `CACHE_STOCK` with `versionUrl: /api/stock/meta` and the `csvUrl` it returns (Storage or Google).
- **Local / Central** material categories are hard-coded in `stock/stock_material_category.js`; regenerate it with `npm run tools:stock-categories`.

## New insight project

The new Supabase project (`gmasnqebdogtavoudbke`) already serves the stock dump and upload. Login still uses the old project until `INSIGHT_LIVE=1`.

1. In the new project's SQL Editor run `scripts/sql/create_insight_project_gmasnqeb.sql`, then add `mzo_insight` to **Exposed schemas**.
2. Copy `scripts/supabase_config.example.json` to the git-ignored `data/supabase_config.json` and fill the old and new keys. Keep `"insightLive": false`; set `"stockUseStorage": true`.
3. Pause admin user edits, then `npm run copy:insight` (copies `portal_users`, logs, unbilled months, allotments and the snapshot; it does not switch production).
4. On Vercel set `INSIGHT_SUPABASE_URL`, `INSIGHT_SUPABASE_KEY`, `STOCK_USE_STORAGE=1`. Only set `INSIGHT_LIVE` when login should move.

## Allotments

Ledger-only allotment (Zone → Division) and diversion (Division → Division). One material can go to many divisions, many materials to one, or a mix. Confirming creates `MZO/ALT/YYYY/####` and an order letter (PDF).

**Flow:** From (Zone or a Division) → To (one or more other divisions) → search-add materials → qty per destination → Preview → Confirm.

**Who can do what:**

| Action | Who |
|---|---|
| View Allotments | Every logged-in user |
| Allot Material | Admin, or **Stock Allot Create** (`stock_allot_autho`). Usernames `zm`, `aritra`, `dm1` are a legacy allow-list until they get the flag |
| Cancel | **Stock Allot Cancel** (`stock_cancel_autho`), separate from Create |

The server enforces create and cancel; list/get only need a session.

**Cancel is a soft cancel:** rows stay, every line of that `allotment_no` gets `status = cancelled`. Lists dim the order with a **Cancelled** badge, the letter/PDF gets a **CANCELLED by …** stamp, and KPIs and summaries exclude cancelled quantities. There is no un-cancel. SQL: the allotment-cancel and `stock_cancel_autho` blocks in `scripts/sql/upgrade_existing_tables.sql`.

**View Allotments** searches by allotment no, material, remarks and creator; filters by division and date; opens the order letter; and summarises material-wise, division-wise and date-wise.

### API

- `POST /api/stock/allotment` with `action`: `createAllotment`, `listAllotments`, `getAllotment`, `cancelAllotment`
- `GET /api/stock/allotment?action=listAllotments|getAllotment` is read-only; any other GET action returns 405

### Backing store

Allotments live in `mzo_insight.stock_allotments` on the insight project. The legacy Google Sheet path (Apps Script `apps-script/stock_allotment.gs`) remains as a fallback:

1. Stock spreadsheet → Extensions → Apps Script → paste `apps-script/stock_allotment.gs`, run `setupAllotmentSheet` once.
2. Deploy → New deployment → Web app (or Manage deployments → **New version** after changes). The `/exec` URL should answer `{"status":"ok","service":"stock-allotment"}`.
3. Env: `STOCK_ALLOTMENT_SCRIPT_URL` (the `/exec` URL) and optionally `STOCK_ALLOTMENTS_CSV_URL` (published CSV of the Allotments tab) for faster reads. The list is cached in Node for about 60 s.

If a create times out with a non-JSON response the API returns `maybeSucceeded: true`; check View Allotments before retrying.
