-- Important Sheets: Unbilled months catalog (managed by portal admins)
-- Run in Supabase Dashboard → SQL Editor → Run

CREATE TABLE IF NOT EXISTS mzo_insight.important_unbilled_months (
  id bigserial PRIMARY KEY,
  label text NOT NULL,
  sheet_id text NOT NULL,
  gid text NOT NULL DEFAULT '0',
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS important_unbilled_months_sort_idx
  ON mzo_insight.important_unbilled_months (sort_order ASC, id ASC);

GRANT ALL ON TABLE mzo_insight.important_unbilled_months TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE mzo_insight.important_unbilled_months_id_seq TO anon, authenticated, service_role;

-- Seed current months (skip if already seeded)
INSERT INTO mzo_insight.important_unbilled_months (label, sheet_id, gid, sort_order, active)
SELECT v.label, v.sheet_id, v.gid, v.sort_order, true
FROM (VALUES
  ('Jan-2026', '1ujR9e1olZKeu1uIgzSsIl2XXK-fN6YWI-1Z_E6xyOTs', '979760067', 1),
  ('Feb-2026', '1cYIV5Uk5Wa0CPkFMPFdeIUwJ3262o6tNJTbxTe7Lelk', '827560931', 2),
  ('Mar-2026', '1iRAE1fXfCbkb7mtRIjYIGYdbMLUga-bmhlHgKm1ZorE', '0', 3),
  ('Apr-2026', '1u3x_XJ_re_MJvkDbGmcE4iwweRk5xe89Qib2p9JxAGc', '801371725', 4),
  ('May-2026', '1c9I7Ng3OCqMik4jyRqO7WZn6ysdVXAFsm93va1Z1PFk', '0', 5),
  ('Jun-2026', '1rgHVfi2Z-8lKPCBl6byXCHfJ_QVCbQcB-7awggyDa1M', '0', 6),
  ('Jul-2026', '1Pw1mSp8x7b5DxgjQMu8WfVfX2dY0UkF836p4YXva1ko', '1573581583', 7),
  ('Aug-2026', '1SazJY-ohGvhTji5zN-mfrCTbaEUvfvGGKh6XWlRn76s', '903839015', 8)
) AS v(label, sheet_id, gid, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM mzo_insight.important_unbilled_months LIMIT 1
);

NOTIFY pgrst, 'reload schema';

SELECT id, label, sheet_id, gid, sort_order, active
FROM mzo_insight.important_unbilled_months
ORDER BY sort_order, id;
