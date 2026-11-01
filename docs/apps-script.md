# Apps Script sources

`apps-script/` holds the Google Apps Script code behind the sheets the app writes to. Nothing in the app imports these files; each one is pasted into its spreadsheet's script editor and deployed as a web app. The folder is not served.

| File | Spreadsheet | Used by | `/exec` URL setting |
|---|---|---|---|
| `sheet_mirror_publish.gs` | `NSCWH` (Withheld), Stock | Withheld and Stock uploads (`MzoSheetMirror.publishTab` in `lib/sheet_mirror_client.js`). It can also serve `nsc_working`, but that workbook runs `nsc_mirror_and_followup.gs` | `NSC_WITHHELD_SHEET_SCRIPT_URL`, `STOCK_SHEET_SCRIPT_URL` |
| `nsc_mirror_and_followup.gs` | `nsc_working` | NSC dump mirror **and** Pending NSC follow-up notes in one web app. This is the version deployed on `nsc_working` | `NSC_SHEET_SCRIPT_URL`, `NSC_FOLLOWUP_SCRIPT_URL` |
| `defective_meter_publish.gs` | Defective meter workbook (tabs `summary`, `details`) | Defective meter upload | `DEFECTIVE_SHEET_SCRIPT_URL` |
| `disconnection_followup.gs` | Disconnection sheet (`Followups` tab) | Disconnection tracker follow-up notes | `DISCONNECTION_FOLLOWUP_SCRIPT_URL` |
| `mzo_metadata_sync.gs` | Standalone project | Report update dates for the hub and Sheet links, refreshed every 15 minutes and merged into `GET /api/hub/versions` | `METADATA_SCRIPT_URL` |
| `stock_allotment.gs` | Stock workbook (`Allotments` tab) | Legacy allotment store (see [stock.md](stock.md#backing-store)) | `STOCK_ALLOTMENT_SCRIPT_URL` |
| `dd_visit.gs` | DD visit tracking sheet | `dd/dd_visit.html` follow-up timeline (URL is in the page) | — |
| `prt_oil.gs` | PTR oil test records sheet | `prt-oil/index.html` (URL is in the page) | — |

The `*_SCRIPT_URL` settings are Vercel environment variables; `server.js` has a default for each.

## Deploying a change

1. Open the bound spreadsheet → Extensions → Apps Script, paste the file, Save.
2. Deploy → **Manage deployments** → pencil → **New version** → Deploy. This keeps the same `/exec` URL, so nothing else changes. A brand-new deployment gives a new URL that must then be set in Vercel (or in the page, for DD visit and PRT oil).
3. Web apps run as **Me** with access **Anyone**.

## Rules

- `doPost` must return `ContentService` JSON. Returning `HtmlService` produces Google's `ppConfig` HTML error page instead of JSON.
- Bulk uploads arrive as url-encoded chunks (`begin` → `chunk` … → `complete`); the browser retries a failed chunk (8 attempts) and restarts from `begin` up to 3 times.
- Do not route these sheets through Vercel, and do not intercept `script.google.com` in `sw.js`.
