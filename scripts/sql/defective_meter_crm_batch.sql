-- =============================================================================
-- DISHA / MZO Reports: Defective Meter Division-by-Division Batch Extraction
-- Database: IBM DB2 (db2_mig @ 10.251.64.65:60000)
-- Connection Profile: "ibm db2" (User: report, Pass: report)
--
-- Run this script in DbVisualizer SQL Commander connected to "ibm db2".
-- Use "Execute All" (Ctrl+Alt+E) or run each block individually.
--
-- Output files are exported to: data/temp/crm_defective/chunk_<prefix>.csv
-- Once exported, run: npm run sync:defective:crm
-- (Or run: npm run sync:defective:crm to auto-extract directly via dbviscmd)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Malda Division (Prefix: 6611)
-- -----------------------------------------------------------------------------
@export on;
@export set filename="e:/Codes/MZO/mzo_report_pwa/data/temp/crm_defective/chunk_6611.csv" format="csv" delimiter="," quote="true";
SELECT * 
FROM isudata.meter_status_report 
WHERE CCC_code LIKE '6611%' 
  AND curr_def_status = 'X';
@export off;

-- -----------------------------------------------------------------------------
-- 2. Chanchal Division (Prefix: 6612)
-- -----------------------------------------------------------------------------
@export on;
@export set filename="e:/Codes/MZO/mzo_report_pwa/data/temp/crm_defective/chunk_6612.csv" format="csv" delimiter="," quote="true";
SELECT * 
FROM isudata.meter_status_report 
WHERE CCC_code LIKE '6612%' 
  AND curr_def_status = 'X';
@export off;

-- -----------------------------------------------------------------------------
-- 3. Gazole Division (Prefix: 6613)
-- -----------------------------------------------------------------------------
@export on;
@export set filename="e:/Codes/MZO/mzo_report_pwa/data/temp/crm_defective/chunk_6613.csv" format="csv" delimiter="," quote="true";
SELECT * 
FROM isudata.meter_status_report 
WHERE CCC_code LIKE '6613%' 
  AND curr_def_status = 'X';
@export off;

-- -----------------------------------------------------------------------------
-- 4. Raiganj Division (Prefix: 6621)
-- -----------------------------------------------------------------------------
@export on;
@export set filename="e:/Codes/MZO/mzo_report_pwa/data/temp/crm_defective/chunk_6621.csv" format="csv" delimiter="," quote="true";
SELECT * 
FROM isudata.meter_status_report 
WHERE CCC_code LIKE '6621%' 
  AND curr_def_status = 'X';
@export off;

-- -----------------------------------------------------------------------------
-- 5. Islampur Division (Prefix: 6622)
-- -----------------------------------------------------------------------------
@export on;
@export set filename="e:/Codes/MZO/mzo_report_pwa/data/temp/crm_defective/chunk_6622.csv" format="csv" delimiter="," quote="true";
SELECT * 
FROM isudata.meter_status_report 
WHERE CCC_code LIKE '6622%' 
  AND curr_def_status = 'X';
@export off;

-- -----------------------------------------------------------------------------
-- 6. Balurghat Division (Prefix: 6631)
-- -----------------------------------------------------------------------------
@export on;
@export set filename="e:/Codes/MZO/mzo_report_pwa/data/temp/crm_defective/chunk_6631.csv" format="csv" delimiter="," quote="true";
SELECT * 
FROM isudata.meter_status_report 
WHERE CCC_code LIKE '6631%' 
  AND curr_def_status = 'X';
@export off;

-- -----------------------------------------------------------------------------
-- 7. Buniadpur Division (Prefix: 6632)
-- -----------------------------------------------------------------------------
@export on;
@export set filename="e:/Codes/MZO/mzo_report_pwa/data/temp/crm_defective/chunk_6632.csv" format="csv" delimiter="," quote="true";
SELECT * 
FROM isudata.meter_status_report 
WHERE CCC_code LIKE '6632%' 
  AND curr_def_status = 'X';
@export off;
