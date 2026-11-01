-- New insight project (gmasnqebdogtavoudbke)
-- Run once in Supabase SQL Editor BEFORE copying rows.
-- Then: Settings → API → Exposed schemas → include mzo_insight
-- Live production is NOT switched by this file.

CREATE SCHEMA IF NOT EXISTS mzo_insight;

GRANT USAGE ON SCHEMA mzo_insight TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS mzo_insight.portal_users (
  id bigserial PRIMARY KEY,
  username text NOT NULL,
  pin text NOT NULL DEFAULT '',
  name text DEFAULT '',
  role text DEFAULT '',
  last_login text DEFAULT '',
  dtr_autho text DEFAULT '',
  ss_autho text DEFAULT '',
  dd_autho text DEFAULT '',
  nsc_autho text DEFAULT '',
  nsc_upload_autho text DEFAULT '',
  stock_upload_autho text DEFAULT '',
  stock_allot_autho text DEFAULT '',
  stock_cancel_autho text DEFAULT '',
  defective_upload_autho text DEFAULT '',
  si_autho text DEFAULT '',
  si_divisions text DEFAULT '',
  sheets_autho text DEFAULT '',
  zone_code text DEFAULT '',
  region_code text DEFAULT '',
  division_code text DEFAULT '',
  ccc_code text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_users_username_unique UNIQUE (username)
);

CREATE INDEX IF NOT EXISTS portal_users_username_lower_idx
  ON mzo_insight.portal_users (lower(username));

CREATE TABLE IF NOT EXISTS mzo_insight.activity_logs (
  id bigserial PRIMARY KEY,
  timestamp timestamptz NOT NULL DEFAULT now(),
  username text DEFAULT '',
  name text DEFAULT '',
  type text DEFAULT '',
  details text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS activity_logs_timestamp_idx
  ON mzo_insight.activity_logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS activity_logs_username_idx
  ON mzo_insight.activity_logs (username);
CREATE INDEX IF NOT EXISTS activity_logs_type_idx
  ON mzo_insight.activity_logs (type);

CREATE TABLE IF NOT EXISTS mzo_insight.important_unbilled_months (
  id bigserial PRIMARY KEY,
  label text NOT NULL,
  sheet_id text NOT NULL,
  gid text NOT NULL DEFAULT '0',
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS important_unbilled_months_sort_idx
  ON mzo_insight.important_unbilled_months (sort_order ASC, id ASC);

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
  category text,
  date text
);

CREATE INDEX IF NOT EXISTS stock_snapshot_upload_id_idx ON mzo_insight.stock_snapshot (upload_id);
CREATE INDEX IF NOT EXISTS stock_snapshot_material_idx ON mzo_insight.stock_snapshot (material);

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
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active',
  cancelled_at timestamptz,
  cancelled_by text NOT NULL DEFAULT '',
  cancel_reason text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS stock_allotments_no_idx ON mzo_insight.stock_allotments (allotment_no);
CREATE INDEX IF NOT EXISTS stock_allotments_date_idx ON mzo_insight.stock_allotments (date DESC);
CREATE INDEX IF NOT EXISTS stock_allotments_material_idx ON mzo_insight.stock_allotments (material_code);
CREATE INDEX IF NOT EXISTS stock_allotments_status_idx ON mzo_insight.stock_allotments (status);

-- Server uses service_role. Do not let anon read PINs.
REVOKE ALL ON ALL TABLES IN SCHEMA mzo_insight FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA mzo_insight FROM anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA mzo_insight TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA mzo_insight TO service_role;

ALTER TABLE mzo_insight.portal_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE mzo_insight.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mzo_insight.important_unbilled_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE mzo_insight.stock_upload_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE mzo_insight.stock_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE mzo_insight.stock_allot_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE mzo_insight.stock_allotments ENABLE ROW LEVEL SECURITY;

ALTER DEFAULT PRIVILEGES IN SCHEMA mzo_insight
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mzo_insight
  GRANT ALL ON SEQUENCES TO service_role;

-- If this ALTER fails, set Exposed schemas in the dashboard instead.
DO $$
BEGIN
  BEGIN
    ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, mzo_insight';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Could not ALTER ROLE authenticator; add mzo_insight in API Exposed schemas.';
  END;
END $$;

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';

SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema = 'mzo_insight'
ORDER BY table_name;
