-- Stock upload + allotment create permissions on portal_users
-- Run in Supabase SQL Editor
--
-- stock_upload_autho: '' | 'Y'  → can upload SAP stock dump
-- stock_allot_autho:  '' | 'Y'  → can create allotments / diversions

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS stock_upload_autho text DEFAULT '';

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS stock_allot_autho text DEFAULT '';

UPDATE mzo_insight.portal_users
SET stock_allot_autho = 'Y'
WHERE lower(username) IN ('zm', 'aritra', 'dm1')
  AND coalesce(nullif(trim(stock_allot_autho), ''), '') = '';

UPDATE mzo_insight.portal_users
SET stock_upload_autho = 'Y'
WHERE lower(username) = 'dm1'
  AND coalesce(nullif(trim(stock_upload_autho), ''), '') = '';

NOTIFY pgrst, 'reload schema';

SELECT username, stock_upload_autho, stock_allot_autho
FROM mzo_insight.portal_users
WHERE lower(username) IN ('zm', 'aritra', 'dm1')
ORDER BY username;
