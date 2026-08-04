-- Add Category (LOCAL / CENTRAL) to existing stock_snapshot
-- Run in Supabase SQL Editor if table was created before Category support

ALTER TABLE mzo_insight.stock_snapshot
  ADD COLUMN IF NOT EXISTS category text;

NOTIFY pgrst, 'reload schema';
