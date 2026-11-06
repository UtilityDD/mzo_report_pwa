-- =============================================================================
-- DISHA / MZO Reports: Disconnection Tracker Batch Extraction
-- Database: IBM DB2 (db2_mig @ 10.251.64.65:60000)
-- Connection Profile: "ibm db2" (User: report, Pass: report)
--
-- Run this script in DbVisualizer SQL Commander connected to "ibm db2".
-- Output files are exported to: data/temp/disconnection/
-- =============================================================================

@export on;
@export set filename="e:/Codes/MZO/mzo_report_pwa/data/temp/disconnection/discon_raw.csv" format="csv" delimiter="," quote="true";
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
  GOVT_STAT
FROM ISUDATA.CON_WBSEDCL_OSD_CUR 
WHERE CCC_CODE LIKE '66%' 
ORDER BY CCC_CODE, MRU, CON_ID;
@export off;
