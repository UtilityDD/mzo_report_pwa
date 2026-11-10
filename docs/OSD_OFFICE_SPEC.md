# OSD common dump — office network specification

**Purpose:** Pull this branch on an office PC (DB2 reachable), finish the live extract, and wire the Revenue OSD hub. Scaffold was built off-network; this file is the day-of runbook.

**Related:** product/architecture detail in [osd-revenue.md](osd-revenue.md). Repo rules in [AGENTS.md](../AGENTS.md) — do not write to production while casually testing; use `--dry-run` until counts match.

---

## 1. Goal (one sentence)

One scheduled DB2 pull of Malda-zone outstanding dues → `osd_master` + `osd_summary` → hub page shows total OSD and **REM’s share**; Disconnection / REM pages become views of the same dump.

```
DB2 ISUDATA.CON_WBSEDCL_OSD_CUR
  → (8 division chunks) → osd_raw.csv
  → osd_master.csv + osd_summary.json (+ disconnection.csv)
  → rem/osd.html  ·  disconnection.html  ·  remosd5000  ·  rem/defaulters
```

---

## 2. Machine prerequisites

| Need | Check |
|------|--------|
| Git | `git pull` this repo on `develop` |
| Node | `node -v` (same major as usual for this app) |
| DbVisualizer | `C:\Program Files\DbVisualizer\dbviscmd.bat` |
| Connection | Profile name exactly `ibm db2` → `10.251.64.65:60000` / `db2_mig`, user `report` |
| Env | `.env` with `DISCONNECTION_SYNC_SECRET` (32+ chars, same as VM) for real upload |
| Optional | `VM_BASE_URL` if not the default sslip.io host |

---

## 3. Pull and open

```bash
git checkout develop
git pull origin develop
```

Start here: **`docs/OSD_OFFICE_SPEC.md`** (this file). Deeper design: `docs/osd-revenue.md`.

Key paths:

| Path | Role |
|------|------|
| `scripts/sync/sync_revenue_osd_from_crm.js` | Pipeline (chunked extract → transform → upload) |
| `scripts/sync/osd_buckets.js` | Class / supply / value / aging / REM thresholds |
| `scripts/sql/revenue_osd_crm_batch.sql` | Reference SELECT (not run whole-zone; chunks use same columns) |
| `scripts/fixtures/osd_sample.csv` | Offline smoke data |
| `rem/osd.html` | OSD summary hub |
| `/api/osd/*` | meta, summary, dataset, upload, crm-sync |

---

## 4. Day-of checklist (in order)

### A. Confirm DB2 columns (15–30 min)

1. Open DbVisualizer → `ibm db2`.
2. Sample / describe `ISUDATA.CON_WBSEDCL_OSD_CUR`.
3. Confirm supply-status column. Candidates: `CON_STATUS`, `SUPPLY_STATUS`, `DISCON_STATUS`, `LIVE_STATUS`.
4. List distinct status spellings for **Live**, **Deemed disconnection**, **Temporary disconnection**.
5. If the column is **not** `CON_STATUS`:
   - Edit `osdSelectSql()` in `scripts/sync/sync_revenue_osd_from_crm.js` (keep alias `CON_STATUS`).
   - Edit `scripts/sql/revenue_osd_crm_batch.sql` the same way.
6. Extend `SUPPLY_MAP` in `scripts/sync/osd_buckets.js` so real spellings map to `live` / `deemed` / `temp`.

### B. Smoke one division chunk

```bash
node scripts/sync/sync_revenue_osd_from_crm.js --prefix=6611 --dry-run
```

Expect: `data/temp/osd/chunk_6611.csv` and a merged `data/temp/osd/osd_raw.csv`, then local `data/osd_master.csv` + `data/osd_summary.json`. No VM upload (`--dry-run`).

If CLI errors on `CON_STATUS`, fix column name (step A) and retry.

### C. Full zone dry-run (8 chunks)

```bash
node scripts/sync/sync_revenue_osd_from_crm.js --dry-run
```

Compare to today’s disconnection dump (counts / total OSD). Note REM share printed in the console summary.

### D. Live upload (only when dry-run looks right)

```bash
node scripts/sync/sync_revenue_osd_from_crm.js
```

Writes local files and uploads to VM (`/api/osd/upload`) using `DISCONNECTION_SYNC_SECRET`. Also refreshes `disconnection.csv` unless you pass options to skip it.

### E. Verify in the app

1. `npm run dev` (or use the VM URL).
2. Sign in → Revenue → **OSD summary** (`rem/osd.html`).
3. Check: Total OSD, REM ≥ ₹5,000 amount, REM share bar, class / supply / high-value / aging / office tabs.
4. Jump cards → Disconnection, REM OSD > ₹5,000, REM defaulters.
5. Spot-check REM share vs `remosd5000.html` totals (same ≥ ₹5,000 band).

### F. Schedule (after a good live run)

Windows Task Scheduler, e.g. daily 07:00, working directory = repo root:

```bash
node scripts/sync/sync_revenue_osd_from_crm.js
```

---

## 5. Chunking (timeout safety)

| Item | Value |
|------|--------|
| Chunks | `6611` Malda, `6612` Chanchal, `6613` Gazole, `6621` Raiganj, `6622` Islampur, `6631` Balurghat, `6632` Buniadpur, `6610` Zonal/HQ |
| Timeout | 3 minutes **per** chunk |
| Merge | `chunk_*.csv` → `osd_raw.csv` |
| Single chunk | `--prefix=6611` |

Same pattern as `scripts/sync/sync_disconnection_payments.js`.

---

## 6. Hub metrics (what “done” looks like)

| Metric | Definition |
|--------|------------|
| Total OSD | Σ `NOTOSD` |
| REM-considered | Σ `NOTOSD` where `NOTOSD >= 5000` |
| REM share | REM-considered ÷ Total OSD |
| Class | DOM / COM / IND / Others from `CLASS_DESC` |
| Supply | Live / Deemed / Temp / Other from `CON_STATUS` |
| High value | &lt;5k · 5–10k · 10–25k · 25–50k · 50k–1L · ≥1L |
| Aging | from last `PAID_DATE`: &lt;90d · 90–180 · 180–365 · &gt;1y · never |

---

## 7. Useful commands

```bash
# Offline fixture (no DB2)
node scripts/sync/sync_revenue_osd_from_crm.js --fixture --dry-run

# Reprocess last temp extract (no DB2)
node scripts/sync/sync_revenue_osd_from_crm.js --skip-db --dry-run

# Syntax check after edits
node --check scripts/sync/sync_revenue_osd_from_crm.js
node --check scripts/sync/osd_buckets.js
```

---

## 8. Out of scope for this first office day

- Collection / Loss from DB2 (different facts; later module).
- Cutting REM sheet history / notice-trend charts over until hub totals match Sheets for a few days.
- Calling DB2 from Vercel or the VM.

---

## 9. When you change something on the office PC

- Keep line endings as the file already uses.
- If hub HTML/JS/CSS must reach users: bump `CACHE_NAME` in `sw.js` and `version.json`.
- Update this spec or `osd-revenue.md` if column names or bucket maps change.
- Commit on `develop` when the live path is proven; avoid committing `data/*.csv` / secrets.
