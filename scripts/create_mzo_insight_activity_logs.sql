-- Activity logs in schema mzo_insight (replaces Google Sheet / Apps Script logs)
-- Run in Supabase Dashboard → SQL Editor → Run
-- Then optional: npm run migrate:activity-logs
--
-- Does NOT touch Power Map, prioritySI, or portal_users data.

CREATE SCHEMA IF NOT EXISTS mzo_insight;

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

GRANT USAGE ON SCHEMA mzo_insight TO anon, authenticated, service_role;
GRANT ALL ON TABLE mzo_insight.activity_logs TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE mzo_insight.activity_logs_id_seq TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA mzo_insight
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mzo_insight
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

-- Keep API schema list in sync (include existing + mzo_insight)
ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, powermap, mzo_insight';
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';

SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema = 'mzo_insight'
ORDER BY table_name;
