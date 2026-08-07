Ledger-only allotment / diversion from the Stock page. Confirmed rows append to an **Allotments** tab; the published SAP stock dump is not modified.

## Simple flow

1. **From** — Malda Zone **or** any Division (source stock)
2. **To** — one or more destination divisions (cannot equal From)
3. Search-add materials → enter **qty per destination row**
4. Preview / Confirm & Upload → ID `MZO/ALT/YYYY/####` (PDF after Confirm)

Supports:

- Zone → Division(s) (allotment)
- Division → other Division(s) (diversion)
- One material → many To divisions, many materials → one To, or mix

## Access

**View Allotments** is available to **all logged-in portal users**.

**Allot Material** (create) remains restricted to portal usernames **`zm`**, **`aritra`**, and **`dm1`** (case-insensitive). The API enforces create access server-side; list/get only require login.

Use **View Allotments** on the Stock page to:

- Search by allotment no, material, remarks, created by
- Filter by division and date range
- Open an order letter (+ PDF)
- See **Material-wise**, **Division-wise**, and **Date-wise** summaries

## Soft-cancel

Users with **Stock Allot Cancel** (`stock_cancel_autho`) — separate from Create — can **Cancel** an order from View → order detail.

- Rows are **kept** (not deleted); `status=cancelled` on all lines for that `allotment_no`
- List shows a dimmed row + **Cancelled** badge
- Letter / PDF shows a large **CANCELLED by …** stamp
- KPIs and material/division/date summaries exclude cancelled qty
- Cannot be reverted (double confirmation in UI; no un-cancel API)

Run once:
1. [`../scripts/alter_stock_allotments_cancel.sql`](../scripts/alter_stock_allotments_cancel.sql) — cancel columns on allotments
2. [`../scripts/alter_portal_users_stock_cancel_auth.sql`](../scripts/alter_portal_users_stock_cancel_auth.sql) — `stock_cancel_autho` on users

Grant via Admin → User Management → **Stock Allot Cancel** = Yes.

API: `POST /api/stock/allotment` with `{ action: "cancelAllotment", allotmentNo }`

## One-time Google Sheet setup

1. Open the Stock spreadsheet.
2. **Extensions → Apps Script**, paste [`allotment_code.gs`](allotment_code.gs).
3. Run `setupAllotmentSheet` once (adds new columns if the Allotments sheet already exists).
4. **Deploy → New deployment → Web app** (or update existing deployment to a **New version**).
5. Opening the `/exec` URL should return `{"status":"ok","service":"stock-allotment"}`.

## Speed / reliability notes

- **View list** prefers CSV (`GET` Apps Script `?format=csv`, or optional `STOCK_ALLOTMENTS_CSV_URL`) and caches in Node for ~60s.
- **Create** uses one batch sheet write; client treats PDF failures separately from a successful save.
- If upload times out with a non-JSON response, the API returns `maybeSucceeded: true` — check View Allotments before retrying.
- After code changes to `allotment_code.gs`: **Deploy → Manage deployments → New version**.

Optional fastest path (no Apps Script cold start for reads):

1. Publish the **Allotments** tab to the web as CSV, or use  
   `https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=csv&gid=<ALLOTMENTS_GID>`
2. Set env: `STOCK_ALLOTMENTS_CSV_URL=<that url>`

Portal:

- `POST /api/stock/allotment` — `createAllotment` | `listAllotments` | `getAllotment`
- `GET /api/stock/allotment?action=listAllotments` — list / filter

```bash
STOCK_ALLOTMENT_SCRIPT_URL=https://script.google.com/macros/s/XXXX/exec
STOCK_ALLOTMENTS_CSV_URL=https://docs.google.com/spreadsheets/d/XXXX/export?format=csv&gid=YYYY
```

