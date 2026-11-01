-- Remove tables that are no longer used: the old SI PIN table and the NSC row tables (NSC rows now live in Google Sheets).
-- Every statement is guarded (IF [NOT] EXISTS), so the file is safe to run more than once.

-- ======================================================================
-- from drop_mzo_insight_nsc_tables.sql
-- ======================================================================
-- Drop NSC row-store tables (data now lives in Google Sheets).
-- Run in Supabase Dashboard → SQL Editor → Run
-- Schema mzo_insight must still exist (portal_users, stock, etc. stay).

DROP TABLE IF EXISTS mzo_insight.nsc_withheld CASCADE;
DROP TABLE IF EXISTS mzo_insight.nsc_pending CASCADE;
DROP TABLE IF EXISTS mzo_insight.nsc_upload_meta CASCADE;

NOTIFY pgrst, 'reload schema';

-- ======================================================================
-- from drop_si_user_access.sql
-- ======================================================================
-- Drop legacy Priority SI Works PIN login table
-- Run in Supabase Dashboard → SQL Editor → Run
-- Only after SI page uses portal_users (si_autho / si_divisions).

DROP TABLE IF EXISTS mzo_insight.user_access;
DROP TABLE IF EXISTS public.user_access;

NOTIFY pgrst, 'reload schema';

-- Verify gone
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_name = 'user_access';
