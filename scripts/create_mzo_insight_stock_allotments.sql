-- Stock allotment ledger (replaces Apps Script Allotments tab as primary store)
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS mzo_insight.stock_allot_seq (
  year integer PRIMARY KEY,
  next_seq integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS mzo_insight.stock_allotments (
  id bigserial PRIMARY KEY,
  allotment_no text NOT NULL,
  date text NOT NULL DEFAULT '',
  movement_type text NOT NULL DEFAULT '',
  from_store text NOT NULL DEFAULT '',
  from_plant_code text NOT NULL DEFAULT '',
  division text NOT NULL DEFAULT '',
  plant_code text NOT NULL DEFAULT '',
  material_code text NOT NULL DEFAULT '',
  material_description text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT '',
  present_stock_div double precision,
  source_stock_at_allot double precision,
  zone_stock_at_allot double precision,
  allotted_qty double precision,
  remarks text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_allotments_no_idx ON mzo_insight.stock_allotments (allotment_no);
CREATE INDEX IF NOT EXISTS stock_allotments_date_idx ON mzo_insight.stock_allotments (date DESC);
CREATE INDEX IF NOT EXISTS stock_allotments_material_idx ON mzo_insight.stock_allotments (material_code);

GRANT ALL ON TABLE mzo_insight.stock_allot_seq TO anon, authenticated, service_role;
GRANT ALL ON TABLE mzo_insight.stock_allotments TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE mzo_insight.stock_allotments_id_seq TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
