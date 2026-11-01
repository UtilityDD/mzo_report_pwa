# Rating: schema needs

The fields `lib/rating_metrics.js` reads from each dataset's uniform rows, for the owners of the `schema/<key>.json` files (batch table in [uniform-data-inventory.md](../uniform-data-inventory.md)). Field lists are additive: merge these into the owner's file in a separate small commit. The list itself lives in the module (`MzoRatingMetrics.NEEDS`); this page is that list for people.

Check a schema folder at any time (exit 1 when a required field is missing):

```bash
node scripts/rating/check-schema-needs.js            # this repo's schema/
node scripts/rating/check-schema-needs.js --markdown # the table below
```

A dataset whose rows lack a required field does not read zeros: the metrics that read it go to `errors` ("field missing: nsc_pending.delayinqtn (add to schema/<key>.json)") and the engine marks them n/a; the other metrics of that dataset still run. The loss targets are the one soft case: without the target sheet's MU columns AT&C and distribution loss are computed without targets and `warnings` says so. A pinned field whose header vanished from the sheet (`header.missing`) counts as missing too.

## Status (1 Nov 2026, develop b017569)

Every batch has merged its schemas and `node scripts/rating/check-schema-needs.js` prints "every needed field is pinned" (office roles agree too). What the rating added to other owners' files, additively: `loss_targets` gained `cum_input_mu`, `cum_demand_mu`, `cum_collec_mu` (the target loss is recomputed from the target sheet's own MU, which also corrects Harirampur's typed 39.14 %, see data-map.md) and `weekly_report` gained `to_be_disposed_dom/com/ind`; `nsc_pending`'s `delayinqtn` and `delayinwo` came with batch A. Created here because no batch owns them: `schema/important_unbilled_3_months.json`, `schema/important_first_bill_pending.json`, `schema/important_rem_less_unit_billed.json` (report sheets read by position: `header: false`, `offices: { codes: ["col_d"] }`) and `schema/si_works.json` (Supabase prioritySI, VM mirror only; on Vercel `si_works_completed_share` is left out because the browser has no source for it). `costcenter` needs no field: the old SAP cost centres are applied to the canonical office fields when the rows are built (lib/uniform.js loads `data/costcenter.json`).

When a schema changes, run the check: a field it no longer pins stops only the metrics that read it (in the browser) and is listed with the type to pin.

The VM precompute (`vm/sync/rating.js`) does not use these files: it builds its own lean rows from the snapshots with `MzoRatingMetrics.schemaFor(key)` (the fields below, the owners' office roles). These page schemas matter for the browser path only.

## Every dataset

The table is the check of develop b017569. "Optional" fields are only used to recognise rows booked at the zone office itself when a row has no canonical office; leave them out of lean schemas. "Only for" fields are needed by those metrics alone (without them the rest of the dataset's metrics still run). "Pinned as another type" is fine: the module reads typed values and raw text alike (a typed `paid_discon_date` gives the same action dates, as every action date in the sheet is dd.mm.yyyy).

| Dataset | Owner | Already pinned | Add (type) | Optional | Pinned as another type |
|---|---|---|---|---|---|
| `loss_report` | B | ccc, year, month, update_on, cum_input_mu, cum_demand_mu, cum_collec_mu | — | — | — |
| `loss_targets` | B | ccc, cum_input_mu, cum_demand_mu, cum_collec_mu | — | — | — |
| `consumers` | C | ccc_code, date, conn_stat, count, osd_lakh, type_of_meter | — | — | — |
| `collection_report` | B | payment_dt, ccc_code, amount_paid | — | — | — |
| `rem_osd` | B | report_date_email_date, ccc_code, ccc_name, division, region_name, total_count, total_amount_in_lakhs | — | — | — |
| `disconnection` | B | ccc_code, con_id, notosd, paid_discon_date, final_paid_amount, dom_base_date, ind_com_base_date | — | — | paid_discon_date date/dmy (read as text) |
| `theft_assessment` | B | location_code, ccc_name, inspection_date, final_bill_amt, provsnl_bill_amt, payment_amt | — | — | — |
| `nsc_pending` | prototype | ccc_code, supp_off, divn_name, reg, today, delayinsc, delayinwo, delayinqtn | — | — | — |
| `withheld` | A | ccc_code, supp_off, divn_name, region, today, scn_witheld_date, scn_witheld_reason | — | — | — |
| `historical_nsc` | C | ccc_code, meter_install_date, d, c, i, a, o | — | — | — |
| `weekly_report` | A | ccc_code, ccc, date_of_report_in_current_week, to_be_disposed_dom, to_be_disposed_com, to_be_disposed_ind, total_disposed_dom, total_disposed_com, total_disposed_ind, conn_eff_dom, conn_eff_com, conn_eff_ind | — | — | — |
| `pending_mc` | A | substr_a_supp_off_7_7, ccc, division, region, report_date, meter_installation_date | — | supp_off: text, divn: text | — |
| `load_extension` | A | ccc_code, report_date, age_months | — | — | — |
| `solar_connections` | prototype | ccc_code, supp_off, solar_appl_no, con_id, replace_status, creation_date, report_date | — | — | — |
| `pmsgy_malda` | D | sl_no, sub_division_name, division_name, installation_status, net_metering_date, last_action_date | — | district: text | — |
| `pmsgy_uttar_dinajpur` | D | sl_no, sub_division_name, division_name, installation_status, net_metering_date, last_action_date | — | district: text | — |
| `pmsgy_dakshin_dinajpur` | D | sl_no, sub_division_name, division_name, installation_status, net_metering_date, last_action_date | — | district: text | — |
| `defective_summary` | D | ccc_code, report_as_on, total, over5, over10, defect_year | — | — | — |
| `smart_meter_status` | C | ccc_final, meter_supply_qty, con_id, meter_installed_qty_in_field_active_in_hes, total_submit_in_ami_portal | — | — | — |
| `smart_meter_work_orders` | C | date | — | — | — |
| `meter_erp` | C | serial_number, entry_date, cost_center | — | — | — |
| `meter_master` | C | meter_no | — | — | — |
| `meter_crm` | C | meter_number | — | — | — |
| `meter_isu` | C | meter_no, replaced_by | — | — | — |
| `important_unbilled_3_months` | rating-metrics | col_a, col_b, col_c, col_d, col_q | — | — | — |
| `important_first_bill_pending` | rating-metrics | col_a, col_b, col_d, col_j | — | — | — |
| `important_rem_less_unit_billed` | rating-metrics | col_a, col_b, col_d, col_f, col_i, col_m | — | — | — |
| `feeder_outage` | D | report_month, division_name, circle_name, substation_name, feeder_name, total_count_of_outage_over_5_min, total_duration_of_outage_over_5_min | — | — | — |
| `dtr_records` | E | supp_off, divn_name, region, ss_name, fdr_name, capa_kv | — | — | — |
| `docket_calls` | C | doc_no, ccc_code, ccc_name, doc_crn_dt, prob_type | — | — | — |
| `docket_kpi` | C | ccc_code, description, count_of_doc_no, sum_of_diff | — | — | — |
| `cmo_grievances` | D | district, report_date, pending_with, grievance_since | — | — | — |
| `accident_reports` | E | name_of_ccc_substation_re_project, name_of_division_re_project, name_of_the_region, date_of_accident, nature_of_injury, type_of_victim, category_of_victim | — | code_of_ccc_substation_re_project: text | — |
| `safety_inspection` | D | site_id, office, entered_on, rectification_done_on | — | — | — |
| `si_works` | rating-metrics | region, division, status, target_date, updated_at | — | — | — |
| `capex_details` | D | reporting_date, cost_centre, net_balance_value, ageing_in_days | — | — | — |
| `onm_advance` | D | creation_date, resp_cctr, plant, mat_balance_value | — | — | — |

## How the module reads a field

| Read as | Typed value in the rows | Text in the rows | `<field>_raw` (typed column, value did not parse) |
|---|---|---|---|
| number | used as is | the script's parser: Indian/Western commas, `%`, `(0.37)` = −0.37; anything else is 0 | parsed the same way, so `22.35%`, `05` or `1,23` mean what they meant |
| date | `YYYY-MM-DD…` → the day | dd/mm/yyyy, dd.mm.yyyy, dd-mm-yy, yyyymmdd, 15-July-26 (month-first only where the metric says so: historical NSC) | parsed the same way |
| text | `String(value)` | as is (trimmed) | the raw text |

Office: the canonical `_ccc_code`, else `_division`, else `_region`. With none of them, the row counts at the zone only when its own office cells name the zone office (6600000, "Malda Zone"); otherwise it is unmapped (`metrics.<id>.unmapped`). The loss sheets are the exception: their CCC column names CCCs, "… Div Total" rows, regions and the zone, and is read by name, as the loss page does.
