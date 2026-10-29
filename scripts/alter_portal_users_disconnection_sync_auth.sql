-- Disconnection Sheet Cloud Sync permission on portal_users
-- Run in Supabase Dashboard → SQL Editor → Run
-- Then NOTIFY so PostgREST exposes the new column.
--
-- disconnection_sync_autho: '' | 'Y'
--   Y = can trigger 1-click cloud sync on /disconnection.html
-- Admins can always sync (server-side), even if this flag is blank.

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS disconnection_sync_autho text DEFAULT '';

NOTIFY pgrst, 'reload schema';

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'mzo_insight'
  AND table_name = 'portal_users'
  AND column_name = 'disconnection_sync_autho';
