-- NSC Withheld dashboard dataset (cleaned Witheld/Withheld rows)
-- Run AFTER create_mzo_insight_nsc_pending.sql
-- Supabase Dashboard → SQL Editor → Run
-- Settings → API → Exposed schemas → ensure `mzo_insight` is included

CREATE TABLE IF NOT EXISTS mzo_insight.nsc_withheld (
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

CREATE INDEX IF NOT EXISTS nsc_withheld_upload_id_idx
  ON mzo_insight.nsc_withheld (upload_id);

CREATE INDEX IF NOT EXISTS nsc_withheld_appl_no_idx
  ON mzo_insight.nsc_withheld (appl_no);

CREATE INDEX IF NOT EXISTS nsc_withheld_region_ccc_idx
  ON mzo_insight.nsc_withheld (region, ccc_code);

GRANT ALL ON TABLE mzo_insight.nsc_withheld TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE mzo_insight.nsc_withheld_id_seq TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
