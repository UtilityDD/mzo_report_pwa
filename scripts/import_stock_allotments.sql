-- =========================================================
-- Import legacy Stock Allotments into Supabase
-- Generated: 2026-08-04T16:30:21.570Z
-- Rows: 19
-- Run in Supabase SQL Editor (schema mzo_insight)
-- Idempotent on allotment_no: deletes matching numbers then re-inserts
-- =========================================================

BEGIN;

-- Remove any previously imported rows for these allotment numbers
DELETE FROM mzo_insight.stock_allotments
WHERE allotment_no IN (
'MZO/ALT/2026/0001',
  'MZO/ALT/2026/0002',
  'MZO/ALT/2026/0003',
  'MZO/ALT/2026/0004',
  'MZO/ALT/2026/0005',
  'MZO/ALT/2026/0006'
);

INSERT INTO mzo_insight.stock_allotments (
  allotment_no, date, movement_type, from_store, from_plant_code,
  division, plant_code, material_code, material_description, unit,
  present_stock_div, source_stock_at_allot, zone_stock_at_allot, allotted_qty,
  remarks, created_by, created_at
)
VALUES
('MZO/ALT/2026/0001', '2026-07-31', 'Allotment', 'Malda (D) Zone', '7201', 'Malda (D) Division', '6611', '301019641', 'DTR 250KVA 11/0.433KV 3PH WCBLBX WH SLNO', 'NOS', 0, 3, 3, 1, '', 'Partha Roy, ACE & ZM', '2026-07-31T11:44:03.077Z'),
('MZO/ALT/2026/0001', '2026-07-31', 'Allotment', 'Malda (D) Zone', '7201', 'Malda (D) Division', '6611', '301018341', 'DTR 100KVA 11/0.433KV, 3PH O/D WH SLNO', 'NOS', 1, 7, 7, 2, '', 'Partha Roy, ACE & ZM', '2026-07-31T11:44:03.077Z'),
('MZO/ALT/2026/0001', '2026-07-31', 'Allotment', 'Malda (D) Zone', '7201', 'Malda (D) Division', '6611', '301018241', 'DTR 63KVA 11/0.433KV, 3PH O/D WH SLNO', 'NOS', 16, 11, 11, 6, '', 'Partha Roy, ACE & ZM', '2026-07-31T11:44:03.077Z'),
('MZO/ALT/2026/0001', '2026-07-31', 'Allotment', 'Malda (D) Zone', '7201', 'Malda (D) Division', '6611', '301018141', 'DTR 25KVA 11/0.433KV, 3PH O/D WH SLNO', 'NOS', 15, 11, 11, 4, '', 'Partha Roy, ACE & ZM', '2026-07-31T11:44:03.077Z'),
('MZO/ALT/2026/0002', '2026-08-03', 'Diversion', 'Malda (D) Division', '6611', 'Islampur (D) Division', '6622', '901031241', '30V 35A A&M BATT. CHARGER', 'NOS', 0, 5, 5, 1, '', 'Partha Roy, ACE & ZM', '2026-08-03T06:27:49.157Z'),
('MZO/ALT/2026/0002', '2026-08-03', 'Diversion', 'Malda (D) Division', '6611', 'Islampur (D) Division', '6622', '901021132', '30V 100AH PLANTE BATTERY', 'SET', 0, 6, 6, 1, '', 'Partha Roy, ACE & ZM', '2026-08-03T06:27:49.157Z'),
('MZO/ALT/2026/0002', '2026-08-03', 'Allotment', 'Malda (D) Zone', '7201', 'Islampur (D) Division', '6622', '504130432', 'GI STAY SET HT(1830X20MM)WRKG LD-7900KG', 'SET', 2, 500, 500, 300, '', 'Partha Roy, ACE & ZM', '2026-08-03T06:27:49.157Z'),
('MZO/ALT/2026/0002', '2026-08-03', 'Allotment', 'Malda (D) Zone', '7201', 'Islampur (D) Division', '6622', '504110541', 'G I EARTH SPIKE 1853X20MM', 'NOS', 514, 2700, 2700, 300, '', 'Partha Roy, ACE & ZM', '2026-08-03T06:27:49.157Z'),
('MZO/ALT/2026/0002', '2026-08-03', 'Diversion', 'Malda (D) Division', '6611', 'Islampur (D) Division', '6622', '503010811', 'G.I. WIRE 5MM.', 'MT', 9.609, 35.204, 35.204, 10, '', 'Partha Roy, ACE & ZM', '2026-08-03T06:27:49.157Z'),
('MZO/ALT/2026/0003', '2026-08-03', 'Diversion', 'Malda (D) Division', '6611', 'Chanchal (D) Division', '6612', '504130332', 'GI STAY SET LT(1680X16MM)WRKG LD-5100KG', 'SET', 0, 1706, 1706, 500, '', 'Partha Roy, ACE & ZM', '2026-08-03T06:48:29.706Z'),
('MZO/ALT/2026/0003', '2026-08-03', 'Allotment', 'Malda (D) Zone', '7201', 'Chanchal (D) Division', '6612', '504130432', 'GI STAY SET HT(1830X20MM)WRKG LD-7900KG', 'SET', 0, 500, 500, 300, '', 'Partha Roy, ACE & ZM', '2026-08-03T06:48:29.706Z'),
('MZO/ALT/2026/0003', '2026-08-03', 'Allotment', 'Malda (D) Zone', '7201', 'Malda (D) Division', '6611', '504110541', 'G I EARTH SPIKE 1853X20MM', 'NOS', 293, 2700, 2700, 500, '', 'Partha Roy, ACE & ZM', '2026-08-03T06:48:29.706Z'),
('MZO/ALT/2026/0004', '2026-08-03', 'Allotment', 'Malda (D) Zone', '7201', 'Raiganj (D) Division', '6621', '504110541', 'G I EARTH SPIKE 1853X20MM', 'NOS', 0.991, 2700, 2700, 500, '', 'Partha Roy, ACE & ZM', '2026-08-03T07:06:10.867Z'),
('MZO/ALT/2026/0004', '2026-08-03', 'Allotment', 'Malda (D) Zone', '7201', 'Raiganj (D) Division', '6621', '508030641', '33KVPOLYMER COMP. WH FTTG DISC INSL70KN', 'NOS', 0, 800, 800, 300, '', 'Partha Roy, ACE & ZM', '2026-08-03T07:06:10.867Z'),
('MZO/ALT/2026/0004', '2026-08-03', 'Diversion', 'Malda (D) Division', '6611', 'Raiganj (D) Division', '6621', '309010541', 'LA42KVCLASS(10KA)FOR33KV', 'NOS', 0, 41, 41, 8, '', 'Partha Roy, ACE & ZM', '2026-08-03T07:06:10.867Z'),
('MZO/ALT/2026/0004', '2026-08-03', 'Allotment', 'Malda (D) Zone', '7201', 'Raiganj (D) Division', '6621', '301018241', 'DTR 63KVA 11/0.433KV, 3PH O/D WH SLNO', 'NOS', 5, 11, 11, 2, '', 'Partha Roy, ACE & ZM', '2026-08-03T07:06:10.867Z'),
('MZO/ALT/2026/0004', '2026-08-03', 'Diversion', 'Malda (D) Division', '6611', 'Raiganj (D) Division', '6621', '503010811', 'G.I. WIRE 5MM.', 'MT', 12.373, 35.204, 35.204, 5, '', 'Partha Roy, ACE & ZM', '2026-08-03T07:06:10.867Z'),
('MZO/ALT/2026/0005', '2026-08-03', 'Diversion', 'Malda (D) Division', '6611', 'Buniadpur (D) Division', '6632', '503050611', 'G I STAY WIRE 7/2.5MM', 'MT', 10.28, 117.152, 117.152, 18, '', 'Partha Roy, ACE & ZM', '2026-08-03T07:24:52.177Z'),
('MZO/ALT/2026/0006', '2026-08-03', 'Diversion', 'Malda (D) Division', '6611', 'Balurghat (D) Division', '6631', '309010541', 'LA42KVCLASS(10KA)FOR33KV', 'NOS', 18, 41, 41, 18, '', 'Partha Roy, ACE & ZM', '2026-08-03T07:55:30.028Z');

-- Advance sequence for 2026 past max imported seq 6
INSERT INTO mzo_insight.stock_allot_seq (year, next_seq)
VALUES (2026, 7)
ON CONFLICT (year) DO UPDATE
SET next_seq = GREATEST(mzo_insight.stock_allot_seq.next_seq, EXCLUDED.next_seq);

COMMIT;

NOTIFY pgrst, 'reload schema';

SELECT allotment_no, count(*) AS lines, min(date) AS date
FROM mzo_insight.stock_allotments
GROUP BY allotment_no
ORDER BY allotment_no;
