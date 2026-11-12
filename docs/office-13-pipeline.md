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

## Phase 2 — NSC flow (only if Phase 1 passed)

Read-only. The purpose is one application history that can explain four numbers a day, per office. Do not export consumer names. Do not replace Pending NSC, Withheld, the KPI page, or the trend on this day.

Today’s pages cannot answer this. Pending NSC and its chart are the **stock** still waiting (paid, not yet connected). Withheld is the **stock** still held, with a reason. The KPI averages are computed only on those open rows, so a connection that has already been given has left the file and is invisible. Historical NSC counts connections given, but not on the same axis as payment or withheld. A person connected today usually paid on an earlier day, so the four numbers are events on their own dates, not one cohort.

| Series | Kind | Meaning | Date to find |
|---|---|---|---|
| Paid | flow | Quotation paid that day. This is the eligible applicant. | payment / collection date (`COLL_DATE` on the SAP dump) |
| Connected | flow | Connection given that day, including people who paid earlier | `DATE_OF_EFFECT` or meter-install date |
| Withheld | flow | Newly withheld that day, with the reason | withheld date + reason |
| Released | flow | Left withheld that day (connected, or returned to pending) | status change; record the column if one exists |
| Pending | stock | Paid, not connected, not currently withheld, at the end of the day | derived, not summed |
| Withheld outstanding | stock | Still withheld at the end of the day | derived |

Do not add up daily pending to make a “cumulative pending”. Pending is a balance. The cumulative figures are the flows (paid, connected, withheld, released) over the month or year, plus the closing stock. The check that must hold before any page is rebuilt:

`closing pending ≈ opening pending + paid that day − connected that day − newly withheld + released`

A connection is not a subset of that day’s payments.

In DbVisualizer, run these one at a time. Save **column names and row counts** in the day note.

```sql
SELECT COUNT(*) AS n FROM ISUDATA.REP_BIZ_MASTER_DETAIL;
SELECT COUNT(*) AS n FROM ISUDATA.ZNCN_CRM_DETAILS;
SELECT COUNT(*) AS n FROM ISUDATA.CRM_APPL_LIST;
```

If a table errors with authorization, record `no access` and continue. Do not ask for a new DB2 user on this day.

`REP_BIZ_MASTER_DETAIL` is the known source for connections given (`DATE_OF_EFFECT`, `BASE_CLASS`). Payment and withheld dates usually leave the pending dump once the connection is given, so they have to be found on `ZNCN_CRM_DETAILS` or `CRM_APPL_LIST` (remote `DP1_DB`; either may be `no access`).

For each table that is readable, list the columns (a catalog query, or five rows if that is all the user can run). In the note, record only whether these exist, and the real column name:

- application id (`APPL_NO` or equivalent)
- payment / quotation-paid date
- connection date (`DATE_OF_EFFECT` or meter install)
- withheld date, withheld reason, and a status that separates pending, withheld, and connected
- CCC or office code, and class (`BASE_CLASS` / `CONN_CLASS`)

Do not copy name, address, or phone into the note. Do not `SELECT *` a full table.

If a table is readable, also record three **counts** (Malda zone only, no row export):

1. Paid, not connected, not withheld — compare with today’s Pending NSC consumer count.
2. Currently withheld — compare with today’s Withheld count.
3. Connections on one recent day (`DATE_OF_EFFECT`) — compare with Historical NSC for that day.

**Pass:** each table marked `ok` or `no access`, the column names above, and the three counts (or “could not count” with the reason).  
**Fallback, still a pass:** only `REP_BIZ_MASTER_DETAIL` is readable. Daily connections can be a flow. Payment and withheld stay stocks from the existing dumps. Do not describe that as the four-line chart.  
**Stop:** do not build a fact table, do not change the NSC upload, do not rewire the trend or the KPI page, do not schedule a job. The KPI replacement (flows plus closing stock, and delay measured on connections already given) waits until these counts sit near the live pages.

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
3. Phase 2: access per table; the real names of payment date, connection date, withheld date, reason, status, office, and class; the three counts against Pending NSC, Withheld, and Historical NSC. Note if only the connection-date fallback is possible.
4. Phase 3: skipped, dry-run counts, or live upload.
5. Any chunk that timed out.

## Not this day

- New Postgres or Supabase fact tables.
- Second zone, or office-master changes.
- Collection, loss, meters, network.
- Rewiring the NSC trend or replacing the pending-only KPI. Phase 2 only records the columns and counts that rewiring needs.
- Committing data files or secrets.
