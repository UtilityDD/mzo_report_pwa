-- MZO Power Map tables (distinct names — avoids clash with other "substations" projects/tables)
-- Run in Supabase Dashboard → SQL Editor → Run
-- Then: node scripts/import_mzo_power_map_from_sheet.js

DROP TABLE IF EXISTS public.mzo_power_corrections CASCADE;
DROP TABLE IF EXISTS public.mzo_power_substations CASCADE;

-- 1) Network substations / feeders (22 Google Sheet columns)
CREATE TABLE public.mzo_power_substations (
  id bigserial PRIMARY KEY,
  "Region" text,
  "Division" text,
  "Substation" text NOT NULL,
  "MVA" text,
  "LATITUDE" text,
  "LONGITUDE" text,
  "Connected to" text,
  "Colour" text,
  "RL" text,
  "LineStyle" text,
  "Para-1" text,
  "Para-2" text,
  "Para-3" text,
  "Comment" text,
  "Symbol" text,
  "SymbolSize" text,
  "LegendText" text,
  "LegendSymbol" text,
  "LegendColour" text,
  "Remarks" text,
  "ConductorSize" text,
  "PeakLoad" text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX mzo_power_substations_name_uidx
  ON public.mzo_power_substations ("Substation");

CREATE INDEX mzo_power_substations_division_idx
  ON public.mzo_power_substations ("Division");

CREATE INDEX mzo_power_substations_region_idx
  ON public.mzo_power_substations ("Region");

-- 2) Suggested map corrections (editor approval workflow)
CREATE TABLE public.mzo_power_corrections (
  id bigserial PRIMARY KEY,
  type text NOT NULL,
  substation text,
  column_name text,
  connection_target text,
  proposed_value text,
  suggested_by text,
  suggested_by_name text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mzo_power_corrections_status_idx
  ON public.mzo_power_corrections (status);

-- RLS for app anon/authenticated access
ALTER TABLE public.mzo_power_substations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mzo_power_corrections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mzo_power_substations_anon_all ON public.mzo_power_substations;
CREATE POLICY mzo_power_substations_anon_all
  ON public.mzo_power_substations
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS mzo_power_corrections_anon_all ON public.mzo_power_corrections;
CREATE POLICY mzo_power_corrections_anon_all
  ON public.mzo_power_corrections
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mzo_power_substations TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mzo_power_corrections TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.mzo_power_substations_id_seq TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.mzo_power_corrections_id_seq TO anon, authenticated;
