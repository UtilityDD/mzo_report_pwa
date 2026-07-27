-- Portal login users in schema mzo_insight (replaces Google Sheet as source of truth)
-- Run in Supabase Dashboard → SQL Editor → Run
-- Then: npm run migrate:portal-users
--
-- Does NOT touch Power Map tables or prioritySI / user_access.

CREATE SCHEMA IF NOT EXISTS mzo_insight;

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

-- API roles (mzo_insight must already be in Exposed schemas)
GRANT USAGE ON SCHEMA mzo_insight TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA mzo_insight TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA mzo_insight TO anon, authenticated, service_role;
GRANT ALL ON TABLE mzo_insight.portal_users TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE mzo_insight.portal_users_id_seq TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA mzo_insight
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mzo_insight
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

-- Fix PGRST106: Dashboard "Exposed schemas" can disagree with authenticator role.
-- API currently allows public/graphql_public/powermap — force-include mzo_insight.
ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, powermap, mzo_insight';
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';

-- Verify
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema = 'mzo_insight'
ORDER BY table_name;
