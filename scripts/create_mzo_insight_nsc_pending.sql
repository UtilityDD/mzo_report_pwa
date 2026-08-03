-- NSC Pending dashboard dataset (cleaned Working/Accepted rows)
-- Run in Supabase Dashboard → SQL Editor → Run
-- Then: Project Settings → API → Exposed schemas → ensure `mzo_insight` is included

CREATE TABLE IF NOT EXISTS mzo_insight.nsc_upload_meta (
  id bigserial PRIMARY KEY,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by text NOT NULL DEFAULT '',
  original_name text NOT NULL DEFAULT '',
  sheet_name text NOT NULL DEFAULT '',
  published_rows integer NOT NULL DEFAULT 0,
  withheld_rows integer NOT NULL DEFAULT 0,
  report_date text NOT NULL DEFAULT '',
  stats jsonb,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS mzo_insight.nsc_pending (
  id bigserial PRIMARY KEY,
  upload_id bigint REFERENCES mzo_insight.nsc_upload_meta(id) ON DELETE CASCADE,
  reg text,
  divn_name text,
  supp_off text,
  ccc_code text,
  appl_no text,
  creation_date text,
  con_id text,
  name text,
  phone_no text,
  address text,
  applicant_type text,
  load_watts text,
  applied_phase text,
  conn_class text,
  conn_cat text,
  inspection_date text,
  no_of_poles text,
  conn_type text,
  inspection_dispute_reason text,
  inspection_comment text,
  turn_key text,
  quotation_issue_date text,
  coll_date text,
  wo_issued text,
  won text,
  wo_creation_date text,
  agency_name text,
  meter_number text,
  scn_status text,
  scn_witheld_date text,
  scn_witheld_reason text,
  is_duare_sarkar text,
  ds_number text,
  ds_form_date text,
  is_portal_appl text,
  region text,
  today text,
  delay_in_wo text,
  delay_in_sc text,
  delay_in_qtn text,
  delay_range text,
  delay_serial text,
  pole_non_pole text
);

CREATE INDEX IF NOT EXISTS nsc_pending_upload_id_idx
  ON mzo_insight.nsc_pending (upload_id);

CREATE INDEX IF NOT EXISTS nsc_pending_appl_no_idx
  ON mzo_insight.nsc_pending (appl_no);

CREATE INDEX IF NOT EXISTS nsc_pending_region_ccc_idx
  ON mzo_insight.nsc_pending (region, ccc_code);

GRANT ALL ON TABLE mzo_insight.nsc_upload_meta TO anon, authenticated, service_role;
GRANT ALL ON TABLE mzo_insight.nsc_pending TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE mzo_insight.nsc_upload_meta_id_seq TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE mzo_insight.nsc_pending_id_seq TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
