# Stock dump + allotments → Supabase

## Live vs new project

Present users keep the **old** `portal_users` login until `INSIGHT_LIVE=1`. Stock dump and **authorized upload** go to the new project when `STOCK_USE_STORAGE=1` and `INSIGHT_SUPABASE_URL` / `INSIGHT_SUPABASE_KEY` are set (or local `"stockUseStorage": true`).

Who can upload: Admin, or User Management → **Stock Raw Upload = Yes** (`stock_upload_autho`). Others see the page locked.

Flow: Excel is cleaned in the browser → signed `PUT` to Storage `stock/snapshot.csv` (not through Vercel) → `/api/stock/publish` records meta only. Dashboard DataHub `CACHE_STOCK` uses that public `csvUrl`.

Power Map stays on the old project either way. Do not set `INSIGHT_LIVE` until you are ready to switch login.

## One-time: empty new project

1. In project `gmasnqebdogtavoudbke`, SQL Editor: [`create_insight_project_gmasnqeb.sql`](create_insight_project_gmasnqeb.sql)
2. Settings → API → **Exposed schemas** → include `mzo_insight`
3. Copy [`supabase_config.example.json`](supabase_config.example.json) to `data/supabase_config.json` (gitignored). Fill old + new keys. Keep `"insightLive": false` until login cutover. Set `"stockUseStorage": true` so authorized stock upload uses the new project.
4. Pause admin user edits, then:

```bash
npm run copy:insight
```

That copies `portal_users`, logs, unbilled months, allotments, and `snapshot.csv` (from `data/stock.csv` or the Google sheet). It does not switch production.

5. For **stock upload only**, set Vercel `INSIGHT_SUPABASE_URL`, `INSIGHT_SUPABASE_KEY`, `STOCK_USE_STORAGE=1` (do not set `INSIGHT_LIVE` yet). Deploy. Confirm a Stock Raw Upload user can publish and the Stock page updates. Login still uses the old project.

## Stock dashboard dump

- Upload: `/stock/upload.html` (users with **Stock Raw Upload = Yes**, or admin)
- Flow after flip: Excel cleaned in the browser → `PUT` `snapshot.csv` to Supabase Storage (signed URL from `/api/stock/meta`) → tiny `/api/stock/publish` meta only
- Before flip: same page still publishes to the Google sheet + Apps Script
- Workbook: **Sheet1** — SAP stock rows (Material + Material Group required)
- Local/Central is hardcoded in `lib/stock_material_category.js` (+ `stock/stock_material_category.js`)
- DataHub `CACHE_STOCK` uses `versionUrl: /api/stock/meta` and `csvUrl` (Google or Storage). Dump bytes do not transit Vercel.

## Allot Material / View Allotments

- **Create / View / Cancel** → `/api/stock/allotment` → `mzo_insight.stock_allotments` on the **insight** project (old until `INSIGHT_*` is set)
- Auth: **Stock Allot Create** / **Stock Allot Cancel** in User Management

## Admin UI

User Management → Stock Raw Upload / Stock Allot Create / Stock Allot Cancel.
