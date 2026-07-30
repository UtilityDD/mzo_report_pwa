-- Add Priority SI Works auth columns to mzo_insight.portal_users
-- Run in Supabase Dashboard → SQL Editor → Run
--
-- si_autho: '' | 'view' | 'edit'   (blank/view = view-only; edit = can mutate)
-- si_divisions: '' | 'ALL' | 'Malda,Chanchal,...'  (comma-separated; only used when si_autho=edit)
-- Viewers see all divisions. Editors are limited to listed divisions (or ALL).

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS si_autho text DEFAULT '';

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS si_divisions text DEFAULT '';

NOTIFY pgrst, 'reload schema';

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'mzo_insight'
  AND table_name = 'portal_users'
  AND column_name IN ('si_autho', 'si_divisions');
