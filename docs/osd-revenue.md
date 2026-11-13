# OSD revenue: one dump, many views

**Current path (13 Nov 2026).** The readable table is `ISUDATA.NOTICE_OSD`, not `CON_WBSEDCL_OSD_CUR` (that table is empty and has only `CCC_CODE, BASE_CLASS, CON_ID, AMT`). The zone summary is grouped on the office PC and uploaded as `osd_summary.json`. Each as-on date is also kept in `osd_summary_history.json` so the summary page can show a trend. `node scripts/sync/osd_sheet_history.js` folds the REM OSD notice sheet into that file: one REM snapshot per notice date, split by class, division and CCC. Those points have no total OSD. A date that already has an office-extract total is left as it is. Names are a separate current file, `osd_selected.csv`, for REM (outstanding above ₹5,000, except Government and Agriculture), all Industrial, Commercial above ₹1,000, and Domestic above ₹50,000 (`rem/osd_selected.html`). A new upload replaces that file. Payment follow-up stays on the Disconnection tracker. The full consumer master below is not what Sync Now publishes.

Clean target for outstanding dues (OSD) across Disconnection, REM OSD, REM defaulters, and the **OSD summary** hub. DB2 is only reachable on the office network.

**Office day runbook:** [OSD_OFFICE_SPEC.md](OSD_OFFICE_SPEC.md) — pull `develop` on the office PC and follow that checklist.

## Product target

**One consumer-grain fact table** from CRM, refreshed regularly. Every OSD report is a **view or filter** of that table — not a separate sheet or a separate DB2 pull.

```
IBM DB2  ISUDATA.CON_WBSEDCL_OSD_CUR  (+ supply-status column, confirm on 13th)
        │
        ▼  npm run sync:osd:crm   (office PC, DbVisualizer)
 data/osd_master.csv                 ← full Malda-zone OSD (66%)
 data/osd_summary.json               ← hub aggregates (small)
 data/disconnection.csv              ← same rows, tracker-compatible columns
        │
        ▼  x-sync-key upload
 VM /api/osd/*  +  /api/disconnection/*
        │
        ├── rem/osd.html              OSD summary hub (this target)
        ├── disconnection.html        action / follow-up list
        ├── remosd5000.html           REM slice (OSD ≥ ₹5,000)
        └── rem/defaulters.html       class / aging REM lists
```

### Hub page (`rem/osd.html`) — what officers see first

| Block | Meaning |
|--------|---------|
| **Total OSD** | Sum of `NOTOSD` in scope |
| **REM** | Outstanding above ₹5,000, except Government and Agriculture (amount + consumers + **share of total**) |
| **By class** | DOM / COM / IND / Others |
| **By supply status** | Live · Deemed disconnection · Temporary disconnection · Other |
| **By high-value band** | &lt;₹5k · ₹5–10k · ₹10–25k · ₹25–50k · ₹50k–1L · ≥₹1L |
| **By payment aging** | Paid &lt;90d · 90–180 · 180–365 · &gt;1y · Never / unknown |
| **Office drill** | Region → Division → CCC |
| **Jump cards** | Open Disconnection / REM OSD &gt;₹5k / REM defaulters (same filters via query when possible) |

REM is not a second universe of dues: the hub shows **how much of total OSD REM is watching**.

### What stays out of phase 1

- Collection and Loss (different DB2 facts; later module in the same orchestrator).
- Replacing REM sheet history / notice-trend charts until the hub totals match Sheets for a few days.
- Calling DB2 from Vercel or the VM.

## Data model

### `osd_master.csv` (one row = one consumer)

| Column | Source | Notes |
|--------|--------|--------|
| `CCC_CODE`, `MRU`, `CON_ID`, `NAME`, `ADDRESS` | OSD table | |
| `NOTOSD`, `CLASS_DESC` | OSD table | |
| `METER_NO`, `REG_MOB_NO` | OSD table | |
| `PAID_DATE`, `PAID_AMOUNT` | OSD table | aging uses paid date |
| `DISCONNECTION_DATE`, `PAID_DISCON_DATE`, `FINAL_PAID_AMOUNT` | OSD table | tracker status |
| `BILL_DISPUTE`, `GOVT_STAT` | OSD table | |
| `CON_STATUS` | **confirm 13th** | Live / Deemed / Temp — see SQL comments if the name differs |
| `_class`, `_supply`, `_value_band`, `_aging` | transform | filled by `scripts/sync/osd_buckets.js` |

### `osd_summary.json`

Pre-aggregated `totals`, `byClass`, `bySupply`, `byHighValue`, `byAging`, `byOffice`, plus `rem` (`osd`, `consumers`, `share`). The hub loads **only** this file (tiny). Consumer lists stay on the child pages.

### Buckets (code is the contract)

Defined in `scripts/sync/osd_buckets.js` (and mirrored in the hub for labels):

- **Class:** DOM / COM / IND / Others (from `CLASS_DESC`).
- **Supply:** `live` · `deemed` · `temp` · `other` (from `CON_STATUS` text; map tuned on 13th).
- **High value:** `lt5k` · `5k_10k` · `10k_25k` · `25k_50k` · `50k_1l` · `1l_plus`.
- **Aging:** `d0_90` · `d90_180` · `d180_365` · `y1_plus` · `never` (from last paid date).
- **REM band:** outstanding above ₹5,000 (`NOTOSD > 5000`), except Government and Agriculture.

## Pipeline commands

DB2 extract is **chunked by division** (`6611`…`6632`, `6610`) — same idea as the disconnection payment sync — then merged to `osd_raw.csv`. Each chunk has a 3‑minute CLI timeout so one slow division does not kill the whole zone pull.

```bash
# Today (no office network): fixture → local files only
node scripts/sync/sync_revenue_osd_from_crm.js --fixture --dry-run

# On office network: one division first (column / timeout smoke test)
node scripts/sync/sync_revenue_osd_from_crm.js --prefix=6611 --dry-run

# Full zone (8 chunks) → local files → VM upload
node scripts/sync/sync_revenue_osd_from_crm.js

# Reuse last merged temp extract without hitting DB2 again
node scripts/sync/sync_revenue_osd_from_crm.js --skip-db --dry-run
```

Env: `DISCONNECTION_SYNC_SECRET` (32+ chars, same as today’s disconnection CRM upload). Optional later: split to `OSD_SYNC_SECRET`.

## 13th checklist (office network)

1. In DbVisualizer on `ibm db2`, describe / sample `ISUDATA.CON_WBSEDCL_OSD_CUR` and confirm the **supply-status** column name and value spellings (Live / Deemed / Temporary).
2. If the column is not `CON_STATUS`, edit **both** `osdSelectSql()` in `scripts/sync/sync_revenue_osd_from_crm.js` and `scripts/sql/revenue_osd_crm_batch.sql` (keep alias `CON_STATUS`).
3. Extend `SUPPLY_MAP` in `scripts/sync/osd_buckets.js` for real spellings.
4. Smoke one chunk: `--prefix=6611 --dry-run`, then full `--dry-run` and compare consumer count / total OSD to the current disconnection dump.
5. Run without `--dry-run` to upload; open `rem/osd.html` and check REM share vs `remosd5000.html`.
6. Only then schedule Task Scheduler (e.g. daily 07:00).

## Nav

Revenue group: **OSD summary** first, then Disconnection, REM OSD &gt; ₹5,000, REM defaulters (siblings that the hub links into).
