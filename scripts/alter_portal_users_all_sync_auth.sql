-- Cloud Sync permissions on portal_users for Disconnection, Pending MC, and Pending Load Extension
-- Run in Supabase Dashboard → SQL Editor → Run
--
-- pending_mc_sync_autho: '' | 'Y' (Master Card 1-click cloud sync)
-- load_ext_sync_autho: '' | 'Y' (Load Extension 1-click cloud sync)
-- disconnection_sync_autho: '' | 'Y' (Disconnection Tracker 1-click cloud sync)

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS disconnection_sync_autho text DEFAULT '',
  ADD COLUMN IF NOT EXISTS pending_mc_sync_autho text DEFAULT '',
  ADD COLUMN IF NOT EXISTS load_ext_sync_autho text DEFAULT '';

-- Authorize default operator 'dm1' if blank
UPDATE mzo_insight.portal_users
SET pending_mc_sync_autho = 'Y'
WHERE lower(username) = 'dm1'
  AND coalesce(nullif(trim(pending_mc_sync_autho), ''), '') = '';

UPDATE mzo_insight.portal_users
SET load_ext_sync_autho = 'Y'
WHERE lower(username) = 'dm1'
  AND coalesce(nullif(trim(load_ext_sync_autho), ''), '') = '';

UPDATE mzo_insight.portal_users
SET disconnection_sync_autho = 'Y'
WHERE lower(username) = 'dm1'
  AND coalesce(nullif(trim(disconnection_sync_autho), ''), '') = '';

NOTIFY pgrst, 'reload schema';

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'mzo_insight'
  AND table_name = 'portal_users'
  AND column_name IN ('disconnection_sync_autho', 'pending_mc_sync_autho', 'load_ext_sync_autho');
