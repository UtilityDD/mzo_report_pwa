# Pending NSC / Withheld upload (VM)

CMO-style upload for the SAP Pending NSC dump. The browser parses the raw `.xlsb` / `.xlsx` ([`nsc/nsc_client_pipeline.js`](../nsc/nsc_client_pipeline.js)), then DISHA stores only **slim** Working and Withheld rows, **viz aggregates**, and a **daily summary snapshot** (no consumer history archive, no raw file). Google Sheets remain a fallback when the VM upload path is off (Vercel).

| Where | What |
|---|---|
| `lib/nsc_pipeline.js` | Transform, slim columns, viz aggregates, review (blocks / warnings) |
| `lib/nsc_routes.js` | Preview / commit / undo, datasets, snapshots |
| `nsc/upload.html` | Date + file → process → tick warnings → Replace on DISHA |
| `nsc.html` / `withheld.html` | Read `/api/nsc/dataset` and `/api/withheld/dataset` (VM file first, else Google); **Trend** view uses `nsc/nsc_trend.js` + snapshots |
| `nsc/nsc_trend.js` | Zone → Region → Division → CCC chart + table from daily snapshots |

## One Excel, three outcomes

| File content | Action |
|---|---|
| Working/Accepted + Withheld | Replace both slim CSVs |
| Working only | Replace working; **keep** previous withheld → warning `working_only` |
| Withheld only | Replace withheld; **keep** previous working → warning `withheld_only` |

Caps (live Withheld is ~67k): Working ≤ 30 000, Withheld ≤ 150 000, combined ≤ 200 000, JSON body ≤ 25 MB.

## Upload flow (like CMO)

1. `GET /api/nsc/upload/meta` — `{ enabled, canUpload, canUndo, last, limits }` (off on Vercel).
2. Browser `processNscArrayBuffer` → slim CSVs.
3. `POST /api/nsc/upload/preview` — `{ reportDate, workingCsv, withheldCsv, originalName, fileSha256 }` → one-time token + warnings.
4. Uploader ticks every warning, then `POST /api/nsc/upload/commit` `{ token, confirmWarnings }`.
5. Admin `POST /api/nsc/upload/undo` — last **2** versions only.

### Warnings (must tick)

`same_report_date`, `title_date`, `row_drop`, `row_drop_withheld`, `working_only`, `withheld_only`, `status_unknown`, `div_unmapped`

### Blocks

Empty after parse, over row caps, missing report date, or **required columns missing** (upload refused for both Working and Withheld):

| Side | Required |
|------|----------|
| Raw Excel | `APPL_NO`, `SCN_STATUS`, and `CCC_CODE` or `SUPP_OFF` |
| Working (Pending NSC) | same |
| Withheld | `APPL_NO`, `CCC_CODE` or `SUPP_OFF`, and `SCN_WITHELD_DATE` (or `SCN_STATUS`) |

## Storage (`MZO_FILES_DIR`)

| File | Role |
|---|---|
| `nsc_working.csv` | Slim Working/Accepted (drawer + KPIs); also the mirror source once uploaded |
| `nsc_withheld.csv` | Slim Withheld; also the mirror source once uploaded |
| `nsc_meta.json` | as-on, by, counts, sha256, warnings accepted; `/api/nsc/meta` prefers this over Google when the CSVs exist |
| `nsc_viz_working.json` / `nsc_viz_withheld.json` | Current office aggregates |
| `nsc_snapshots/{yyyy-mm-dd}.json` + `index.json` | Daily summary for pendency trend (no PII) |
| `nsc_versions/<stamp>.json` | Last 2 packs for undo |
| `nsc_upload_audit.jsonl` | Commit/undo audit (no PII) |

Who may upload: admin, `nsc-upload-autho`, or legacy `dm1`.

## Trend

`GET /api/nsc/snapshots?detail=1` returns recent daily totals (`workingTotal`, `workingOver30`, `withheldTotal`).  
`GET /api/nsc/snapshots?offices=1&side=working|withheld` adds lean per-day office rows (`ccc`, `region`, `division`, `supp`, `total`, `over30`) for the Trend view on `nsc.html` / `withheld.html` (Zone → Region → Division → CCC via `nsc/nsc_trend.js`).  
`POST /api/nsc/snapshots/import` (upload autho, VM only) backfills **summary snapshots only** from `{ items:[{ reportDate, working, withheld }], skipExisting:true }` — does not replace live CSVs; skips dates already on disk. Helpers: `vm/dev/build_nsc_trend_snapshots.py` + `vm/dev/build_nsc_trend_viz.js`.  
`GET /api/nsc/viz` returns the current aggregates.
