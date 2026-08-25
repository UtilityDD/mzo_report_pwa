-- Drop NSC row-store tables (data now lives in Google Sheets).
-- Run in Supabase Dashboard → SQL Editor → Run
-- Schema mzo_insight must still exist (portal_users, stock, etc. stay).

DROP TABLE IF EXISTS mzo_insight.nsc_withheld CASCADE;
DROP TABLE IF EXISTS mzo_insight.nsc_pending CASCADE;
DROP TABLE IF EXISTS mzo_insight.nsc_upload_meta CASCADE;

NOTIFY pgrst, 'reload schema';
