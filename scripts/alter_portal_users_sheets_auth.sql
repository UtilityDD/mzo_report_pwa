-- Add Important Sheets manage permission on portal_users
-- Run in Supabase Dashboard → SQL Editor → Run
--
-- sheets_autho: '' | 'list' | 'view' | 'edit'
--   list = home-bar Sheet links button (Google Sheet list only)
--   edit = Manage unbilled months on important_sheets.html, and the Sheet links button
--   admins always can manage and open Sheet links regardless of this flag

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS sheets_autho text DEFAULT '';

NOTIFY pgrst, 'reload schema';

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'mzo_insight'
  AND table_name = 'portal_users'
  AND column_name = 'sheets_autho';
