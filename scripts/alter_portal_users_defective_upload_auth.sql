-- Defective meter CSV upload permission on portal_users
-- Run in Supabase Dashboard → SQL Editor → Run
-- Then NOTIFY so PostgREST exposes the new column.
--
-- defective_upload_autho: '' | 'Y'
--   Y = can publish defective-meter CSV on /consumer/defective_meter.html
-- Admins can always upload (server-side), even if this flag is blank.

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS defective_upload_autho text DEFAULT '';

UPDATE mzo_insight.portal_users
SET defective_upload_autho = 'Y'
WHERE lower(username) = 'dm1'
  AND coalesce(nullif(trim(defective_upload_autho), ''), '') = '';

NOTIFY pgrst, 'reload schema';

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'mzo_insight'
  AND table_name = 'portal_users'
  AND column_name = 'defective_upload_autho';
