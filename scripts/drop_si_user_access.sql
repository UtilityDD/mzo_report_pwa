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
