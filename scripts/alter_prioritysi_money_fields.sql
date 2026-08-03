-- Add SI money fields (run in Supabase SQL editor against mzo_insight)
-- Values stored in Rupees (numeric); UI shows Lakh / Crore compact labels.

ALTER TABLE mzo_insight."prioritySI"
  ADD COLUMN IF NOT EXISTS "TAA Value (Rs.)" numeric,
  ADD COLUMN IF NOT EXISTS "Billed Value till date (Rs.)" numeric;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'mzo_insight'
  AND table_name = 'prioritySI'
  AND column_name IN ('TAA Value (Rs.)', 'Billed Value till date (Rs.)');
