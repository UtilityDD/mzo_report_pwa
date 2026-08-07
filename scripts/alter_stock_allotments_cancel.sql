-- Soft-cancel support for stock allotments (keep rows; mark cancelled)
-- Run in Supabase SQL Editor AFTER using Cancel in the portal

ALTER TABLE mzo_insight.stock_allotments
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

ALTER TABLE mzo_insight.stock_allotments
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

ALTER TABLE mzo_insight.stock_allotments
  ADD COLUMN IF NOT EXISTS cancelled_by text NOT NULL DEFAULT '';

ALTER TABLE mzo_insight.stock_allotments
  ADD COLUMN IF NOT EXISTS cancel_reason text NOT NULL DEFAULT '';

-- Backfill any nulls from older rows
UPDATE mzo_insight.stock_allotments
SET status = 'active'
WHERE status IS NULL OR trim(status) = '';

CREATE INDEX IF NOT EXISTS stock_allotments_status_idx
  ON mzo_insight.stock_allotments (status);

NOTIFY pgrst, 'reload schema';
