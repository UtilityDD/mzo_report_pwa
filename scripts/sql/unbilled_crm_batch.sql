-- =============================================================================
-- DISHA / MZO Reports: Unbilled Consumers & Billing Exceptions Batch Extraction
-- Database: IBM DB2 (db2_mig @ 10.251.64.65:60000)
-- Connection Profile: "ibm db2" (User: report, Pass: report)
--
-- Run this script in DbVisualizer SQL Commander connected to "ibm db2".
-- Output files are exported to: data/temp/unbilled/
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Billing Outsorts / Exceptions (Readings blocked from invoicing)
-- -----------------------------------------------------------------------------
@export on;
@export set filename="e:/Codes/MZO/mzo_report_pwa/data/temp/unbilled/outsort.csv" format="csv" delimiter="," quote="true";
SELECT 
  BASE_LINE_DATE, CON_ID, INST_NO, NAME, ADDRESS, PIN_CODE, 
  CCC_CODE, DIV_CODE, ZONE_CODE, CATEGORY, BASE_CLASS, TARIFF_CLASS, 
  CONN_LOAD, CONN_PHASE, TYPE_OF_METER, MRU, SMRD, METER_NO, 
  LAST_BILL_DATE, UNIT_CONSUMP_LAST_BILL, LATITUDE, LONGITUDE, INV_PENDING_FLAG 
FROM ISUDATA.OUTSORT_CURR_MON_UNBIL_REPORT 
WHERE CCC_CODE LIKE '66%' 
ORDER BY CCC_CODE, MRU, CON_ID;
@export off;

-- -----------------------------------------------------------------------------
-- 2. Chronic Unbilled (>= 3 Consecutive Months Unbilled)
-- -----------------------------------------------------------------------------
@export on;
@export set filename="e:/Codes/MZO/mzo_report_pwa/data/temp/unbilled/chronic.csv" format="csv" delimiter="," quote="true";
SELECT 
  BASE_LINE_DATE, CON_ID, INST_NO, NAME, ADDRESS, PIN_CODE, 
  CCC_CODE, DIV_CODE, ZONE_CODE, CATEGORY, BASE_CLASS, TARIFF_CLASS, 
  CONN_LOAD, CONN_PHASE, TYPE_OF_METER, MRU, SMRD, METER_NO, 
  LAST_BILL_DATE, UNIT_CONSUMP_LAST_BILL, LATITUDE, LONGITUDE, INV_PENDING_FLAG 
FROM ISUDATA.CURR_3MON_UNBIL_REPORT 
WHERE CCC_CODE LIKE '66%' 
ORDER BY CCC_CODE, MRU, CON_ID;
@export off;

-- -----------------------------------------------------------------------------
-- 3. Current Month Unbilled Summary (Aggregated by CCC, Class, MRU)
-- -----------------------------------------------------------------------------
@export on;
@export set filename="e:/Codes/MZO/mzo_report_pwa/data/temp/unbilled/summary.csv" format="csv" delimiter="," quote="true";
SELECT 
  BASE_LINE_DATE, CCC_CODE, BASE_CLASS, MRU, COUNT(*) AS UNBILLED_COUNT 
FROM ISUDATA.CURR_MON_UNBIL_REPORT 
WHERE CCC_CODE LIKE '66%' 
GROUP BY BASE_LINE_DATE, CCC_CODE, BASE_CLASS, MRU 
ORDER BY CCC_CODE, BASE_CLASS, MRU;
@export off;

