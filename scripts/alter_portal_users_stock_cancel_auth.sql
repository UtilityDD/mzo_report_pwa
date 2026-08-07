-- Separate Stock Allot Cancel permission (independent of create)
-- Run in Supabase SQL Editor
--
-- stock_cancel_autho: '' | 'Y'  → can soft-cancel allotments (cannot revert)

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS stock_cancel_autho text DEFAULT '';

NOTIFY pgrst, 'reload schema';

-- No auto-seed: grant Cancel only via Admin → User Management → Stock Allot Cancel
SELECT username, stock_allot_autho, stock_cancel_autho
FROM mzo_insight.portal_users
WHERE coalesce(nullif(trim(stock_allot_autho), ''), '') <> ''
   OR coalesce(nullif(trim(stock_cancel_autho), ''), '') <> ''
ORDER BY username;
