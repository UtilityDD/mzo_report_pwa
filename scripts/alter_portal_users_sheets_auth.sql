-- Add Important Sheets manage permission on portal_users
-- Run in Supabase Dashboard → SQL Editor → Run
--
-- sheets_autho: '' | 'list' | 'view' | 'edit'
--   list = can open the home Uploads list of Google Sheet links
--   edit = can Manage unbilled months on important_sheets.html, and can open Uploads
--   admins always can manage and open Uploads regardless of this flag

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS sheets_autho text DEFAULT '';

NOTIFY pgrst, 'reload schema';

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'mzo_insight'
  AND table_name = 'portal_users'
  AND column_name = 'sheets_autho';
