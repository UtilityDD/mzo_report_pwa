-- =============================================================================
-- DISHA / MZO Reports: Revenue OSD master extract (Malda Zone)
-- Database: IBM DB2 (db2_mig @ 10.251.64.65:60000)
-- Connection Profile: "ibm db2" (User: report)
--
-- LIVE PIPELINE: sync_revenue_osd_from_crm.js does NOT run this whole-zone file.
-- It extracts one division at a time (CCC_CODE LIKE '6611%' … '6632%', '6610%')
-- and merges chunk_*.csv → osd_raw.csv, to avoid DB2 / gateway timeouts.
--
-- This file is the reference SELECT (and a manual fallback). Keep the column
-- list in sync with osdSelectSql() in sync_revenue_osd_from_crm.js.
--
-- 13th office checklist:
--   1. Confirm supply-status column on ISUDATA.CON_WBSEDCL_OSD_CUR
--      (candidates: CON_STATUS, SUPPLY_STATUS, DISCON_STATUS, LIVE_STATUS).
--   2. If not CON_STATUS, change the SELECT below AND osdSelectSql() — keep AS CON_STATUS.
--   3. Sample distinct values for Live / Deemed / Temporary spellings.
--   4. Prefer: node scripts/sync/sync_revenue_osd_from_crm.js --prefix=6611 --dry-run
--      then full run without --prefix.
-- =============================================================================

@export on;
@export set filename="e:/Codes/MZO/mzo_report_pwa/data/temp/osd/osd_raw.csv" format="csv" delimiter="," quote="true";
SELECT
  CCC_CODE,
  MRU,
  CON_ID,
  NAME,
  ADDRESS,
  NOTOSD,
  CLASS_DESC,
  METER_NO,
  REG_MOB_NO,
  PAID_DATE,
  PAID_AMOUNT,
  DISCONNECTION_DATE,
  PAID_DISCON_DATE,
  FINAL_PAID_AMOUNT,
  BILL_DISPUTE,
  GOVT_STAT,
  -- Supply status: rename the source column on 13th if needed; keep alias CON_STATUS.
  CON_STATUS
FROM ISUDATA.CON_WBSEDCL_OSD_CUR
WHERE CCC_CODE LIKE '66%'
ORDER BY CCC_CODE, MRU, CON_ID;
@export off;

-- Example single-division chunk (what the Node sync runs for Malda Division):
-- WHERE CCC_CODE LIKE '6611%'
