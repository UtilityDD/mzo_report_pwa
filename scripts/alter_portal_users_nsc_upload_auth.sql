-- NSC raw Excel upload permission on portal_users
-- Run in Supabase Dashboard → SQL Editor → Run
--
-- nsc_upload_autho: '' | 'Y'
--   Y = can upload raw NSC Excel at /nsc/upload.html

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS nsc_upload_autho text DEFAULT '';

-- Keep existing operator working until admin reassigns in portal
UPDATE mzo_insight.portal_users
SET nsc_upload_autho = 'Y'
WHERE lower(username) = 'dm1'
  AND coalesce(nullif(trim(nsc_upload_autho), ''), '') = '';

NOTIFY pgrst, 'reload schema';

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'mzo_insight'
  AND table_name = 'portal_users'
  AND column_name = 'nsc_upload_autho';
