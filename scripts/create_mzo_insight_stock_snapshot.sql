-- Stock dashboard snapshot (SAP dump after upload)
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS mzo_insight.stock_upload_meta (
  id bigserial PRIMARY KEY,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by text NOT NULL DEFAULT '',
  original_name text NOT NULL DEFAULT '',
  sheet_name text NOT NULL DEFAULT '',
  published_rows integer NOT NULL DEFAULT 0,
  report_date text NOT NULL DEFAULT '',
  stats jsonb,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS mzo_insight.stock_snapshot (
  id bigserial PRIMARY KEY,
  upload_id bigint REFERENCES mzo_insight.stock_upload_meta(id) ON DELETE CASCADE,
  plant text,
  name_1 text,
  material_type text,
  material text,
  material_description text,
  material_group text,
  storage_location text,
  descr_of_storage_loc text,
  base_unit_of_measure text,
  unrestricted text,
  stock_in_transit text,
  transit_and_transfer text,
  store text,
  date text
);

CREATE INDEX IF NOT EXISTS stock_snapshot_upload_id_idx ON mzo_insight.stock_snapshot (upload_id);
CREATE INDEX IF NOT EXISTS stock_snapshot_material_idx ON mzo_insight.stock_snapshot (material);

GRANT ALL ON TABLE mzo_insight.stock_upload_meta TO anon, authenticated, service_role;
GRANT ALL ON TABLE mzo_insight.stock_snapshot TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE mzo_insight.stock_upload_meta_id_seq TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE mzo_insight.stock_snapshot_id_seq TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
