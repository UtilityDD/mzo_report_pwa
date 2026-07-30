-- Move Priority SI tables into schema mzo_insight
-- Run in Supabase Dashboard → SQL Editor → Run
--
-- MOVES ONLY:
--   public."prioritySI" (or prioritysi) → mzo_insight
--
-- LEGACY (optional): public.user_access was the old SI PIN login table.
--   Prefer dropping it with drop_si_user_access.sql after portal SI auth.
--   This script still moves it if present (for old environments).
--
-- DOES NOT TOUCH Power Map or other public tables
--   (mzo_power_substations, mzo_power_corrections, upcomingdd, user_auth, etc.)
--
-- AFTER THIS SCRIPT:
--   Dashboard → Project Settings → API → Exposed schemas
--   Add: mzo_insight  (keep public)

BEGIN;

CREATE SCHEMA IF NOT EXISTS mzo_insight;

-- Move SI tables only
DO $$
BEGIN
  -- prioritySI (mixed-case) or prioritysi (folded)
  IF to_regclass('mzo_insight."prioritySI"') IS NOT NULL
     OR to_regclass('mzo_insight.prioritysi') IS NOT NULL THEN
    RAISE NOTICE 'prioritySI already in mzo_insight — skip';
  ELSIF to_regclass('public."prioritySI"') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public."prioritySI" SET SCHEMA mzo_insight';
  ELSIF to_regclass('public.prioritysi') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.prioritysi SET SCHEMA mzo_insight';
  ELSE
    RAISE EXCEPTION 'Table public.prioritySI / prioritysi not found';
  END IF;

  -- Legacy SI PIN table (optional — may already be dropped)
  IF to_regclass('mzo_insight.user_access') IS NOT NULL THEN
    RAISE NOTICE 'user_access already in mzo_insight — skip';
  ELSIF to_regclass('public.user_access') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.user_access SET SCHEMA mzo_insight';
  ELSE
    RAISE NOTICE 'user_access not found — skip (expected if already dropped)';
  END IF;
END $$;

-- PostgREST / Supabase API roles
GRANT USAGE ON SCHEMA mzo_insight TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA mzo_insight TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA mzo_insight TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA mzo_insight TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA mzo_insight
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mzo_insight
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

COMMIT;

-- ========== Verification (safe read-only) ==========
-- Expect: prioritySI / prioritysi under mzo_insight (user_access only if not dropped)
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema = 'mzo_insight'
ORDER BY table_name;

-- Expect: Power Map tables still in public; SI tables should NOT be in public
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'mzo_power_substations',
    'mzo_power_corrections',
    'prioritySI',
    'prioritysi',
    'user_access'
  )
ORDER BY table_name;
