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

**Allot Material** and **View Allotments** are shown only for portal usernames **`zm`**, **`aritra`**, and **`dm1`** (case-insensitive). The API also enforces this server-side.

Use **View Allotments** on the Stock page to:

- Search by allotment no, material, remarks, created by
- Filter by division and date range
- Open an order letter (+ PDF)
- See **Material-wise**, **Division-wise**, and **Date-wise** summaries

Requires Apps Script redeployed with `listAllotments` / `getAllotment` actions.

## One-time Google Sheet setup

1. Open the Stock spreadsheet.
2. **Extensions → Apps Script**, paste [`allotment_code.gs`](allotment_code.gs).
3. Run `setupAllotmentSheet` once (adds new columns if the Allotments sheet already exists).
4. **Deploy → New deployment → Web app** (or update existing deployment to a **New version**).
5. Opening the `/exec` URL should return `{"status":"ok","service":"stock-allotment"}`.

## Server

Default script URL is set in `server.js`. Optional override:

```bash
STOCK_ALLOTMENT_SCRIPT_URL=https://script.google.com/macros/s/XXXX/exec
```

Portal:

- `POST /api/stock/allotment` — `createAllotment` | `listAllotments` | `getAllotment`
- `GET /api/stock/allotment?action=listAllotments` — list / filter

