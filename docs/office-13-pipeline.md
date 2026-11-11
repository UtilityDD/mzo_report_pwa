# Office network — 13 Nov agent runbook

Follow this file in order on an office PC that can reach DB2. Do not skip a phase. Do not upload until that phase’s dry-run passes.

Design background: [osd-revenue.md](osd-revenue.md). OSD command detail: [OSD_OFFICE_SPEC.md](OSD_OFFICE_SPEC.md). Repo rules: [AGENTS.md](../AGENTS.md).

**Stop the day** if DB2 is unreachable, a dry-run total is wildly off the current sheet, or a secret would have to be pasted into chat or git. Report the stop reason and the last successful step.

## Rules

- `--dry-run` until the check for that phase passes. A run without `--dry-run` writes the VM.
- Do not commit `.env`, `data/*.csv`, `data/*.json` dumps, or `data/temp/`.
- Do not call DB2 from Vercel or the VM.
- Do not create new database tables on this day. Phase 2 is discovery only.
- One division chunk first (`6611`), then the full zone.

## Phase 0 — machine (10 min)

| Check | Pass |
|---|---|
| `git checkout develop` then `git pull origin develop` | On latest `develop` |
| `node -v` | Node starts |
| File exists: `C:\Program Files\DbVisualizer\dbviscmd.bat` | DbVisualizer CLI present |
| DbVisualizer profile name is exactly `ibm db2` | Host `10.251.64.65:60000`, database `db2_mig`, user `report` |
| `.env` has `DISCONNECTION_SYNC_SECRET` (32+ characters) | Required only for a live OSD upload |

If the profile cannot connect, stop. Do not edit SQL.

## Phase 1 — one OSD dump (required)

Goal: Malda-zone outstanding dues from `ISUDATA.CON_WBSEDCL_OSD_CUR` become one master file. OSD summary, Disconnection, and REM read that file. Steps A–E in [OSD_OFFICE_SPEC.md](OSD_OFFICE_SPEC.md).

```bash
node scripts/sync/sync_revenue_osd_from_crm.js --prefix=6611 --dry-run
node scripts/sync/sync_revenue_osd_from_crm.js --dry-run
node scripts/sync/sync_revenue_osd_from_crm.js
```

Run the third command only after the full dry-run looks right.

**Pass**

- Console prints a total OSD and a REM share (`NOTOSD >= 5000`).
- `data/osd_summary.json` exists. Consumer count and total OSD are in the same range as the current disconnection sheet (note both numbers).
- After the live run: sign in on the VM, open Revenue → OSD summary, and confirm total OSD, REM share, and one division drill. REM ≥ ₹5,000 should match `remosd5000.html` for the same band.

**Fail → fix → retry the same step**

| Symptom | Action |
|---|---|
| `CON_STATUS` (or supply column) missing | Follow OSD spec §4.A. Keep the SQL alias `CON_STATUS`. Update `SUPPLY_MAP` in `scripts/sync/osd_buckets.js` for the real spellings (`live` / `deemed` / `temp`). |
| One chunk times out (3 min) | Re-run that prefix only: `--prefix=6611 --dry-run`. Do not start the live upload. |
| `Unknown division prefix` | Prefix must be one of `6611` `6612` `6613` `6621` `6622` `6631` `6632` `6610`. |
| dbviscmd not found | Install or fix the path. Do not switch tools mid-run. |
| Upload 401 / 403 | Secret missing or shorter than 32 characters, or it does not match the VM. Stay on `--dry-run`. |
| Totals far from the sheet | Do not upload. Record both totals and stop Phase 1. |

Reprocess the last extract without hitting DB2 again:

```bash
node scripts/sync/sync_revenue_osd_from_crm.js --skip-db --dry-run
```

## Phase 2 — application sources (only if Phase 1 passed)

Read-only. In DbVisualizer, run these one at a time. Save **column names and row counts** in the day note. Do not export consumer names into the repo.

```sql
SELECT COUNT(*) AS n FROM ISUDATA.REP_BIZ_MASTER_DETAIL;
SELECT COUNT(*) AS n FROM ISUDATA.ZNCN_CRM_DETAILS;
SELECT COUNT(*) AS n FROM ISUDATA.CRM_APPL_LIST;
```

If a table errors with authorization, record `no access` and continue. Do not ask for a new DB2 user on this day.

If `REP_BIZ_MASTER_DETAIL` is readable, sample five rows (no full dump):

```sql
SELECT * FROM ISUDATA.REP_BIZ_MASTER_DETAIL FETCH FIRST 5 ROWS ONLY;
```

Write down whether these columns exist: `DATE_OF_EFFECT`, `BASE_CLASS`, a CCC or office code, an application or consumer id.

**Pass:** a short note listing each table as `ok` or `no access`, plus the column names found.  
**Stop:** do not build `fact_application`, do not change NSC upload, do not schedule a new job.

## Phase 3 — unbilled (only if Phase 1 passed and time remains)

Same office DB2 user. Three existing extracts, not three new tables.

```bash
node scripts/sync/sync_unbilled_from_crm.js --dry-run
```

**Pass:** `data/unbilled_outsort.csv`, `data/unbilled_chronic.csv`, `data/unbilled_summary.csv`, and `data/unbilled_meta.json` exist, and the console counts are non-zero for at least outsort or chronic.

Live upload (writes the VM; needs `UNBILLED_SYNC_SECRET` in `.env`, 32+ characters):

```bash
node scripts/sync/sync_unbilled_from_crm.js
```

Run that only when the dry-run counts look sane. Then open Unbilled on the VM and confirm the as-of date matches `unbilled_meta.json`.

If the dry-run fails, record the error and leave unbilled as it is. Do not invent a new SQL file.

## After a good Phase 1

Schedule only the OSD job (Task Scheduler, daily, repo root):

```bash
node scripts/sync/sync_revenue_osd_from_crm.js
```

Do not schedule Phase 2. Phase 3 may be scheduled later, after one clean live unbilled run.

## Day note (required)

Leave this in the chat, not in git:

1. Phase 1: dry-run consumer count, total OSD, REM share; live upload yes/no; hub matches yes/no.
2. Supply column name and the Live / Deemed / Temp spellings.
3. Phase 2: access per table, and whether `DATE_OF_EFFECT` and `BASE_CLASS` exist.
4. Phase 3: skipped, dry-run counts, or live upload.
5. Any chunk that timed out.

## Not this day

- New Postgres or Supabase fact tables.
- Second zone, or office-master changes.
- Collection, loss, meters, network, NSC trend rewiring.
- Committing data files or secrets.
