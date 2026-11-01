# Rating data map

What we can measure per office for a national-style DISCOM rating, from the data the app already has. For each candidate parameter: the dataset and columns, the formula, the office levels it works at, its period and freshness, its quality caveats, any benchmark in the data, its direction and its scale. The official methodology (pillars, weights, grade bands) is in [sources.md](sources.md); this page is the data side.

- **Script:** `scripts/rating/compute-metrics.js` computes every metric below for all 52 offices and writes [sample-metrics.json](sample-metrics.json). It reads the VM mirror (GET only) or a local snapshot folder:

  ```bash
  node scripts/rating/compute-metrics.js --mirror https://130.210.43.11.sslip.io --cookie-file <cookie file> --out docs/rating/sample-metrics.json
  node scripts/rating/compute-metrics.js --snapshots <folder with manifest.json and <key>.csv/.tsv/.json> --out out.json
  ```

  `--save <dir>` keeps the downloaded snapshots, `--as-of YYYY-MM-DD` fixes the reference date for freshness, `--only id,id` limits the metrics. A run takes about 3 s locally (about 12 s from the mirror, mostly download). The compute part (`compute({ read, manifest, offices, asOf })`) uses no Node APIs, so it can move into the rating engine's input layer.
- **Data used:** the mirror's snapshots of 1 November 2026, about 14:00 IST (manifest `generatedAt` 2026-11-01T08:30Z). Freshness is measured against **1 November 2026**.
- **Offices:** `lib/offices.js` (zone 6600000, regions 66R0000, divisions 66RD000, 41 CCCs 66RD1CC). Every row is placed with `MzoOffices.resolve()` on its code, CCC, division and region cells; old SAP cost centres go through `data/costcenter.json` (`addCostCentres`).
- **Privacy:** the JSON holds office aggregates only (counts, sums, ratios). No consumer, applicant, victim or staff field leaves the script.

## How each level is computed

Every metric is a ratio (or count) of **summed inputs**. The script adds each row's inputs to the office the row names, then rolls up: an office's inputs = the rows that sit at that office itself + the inputs of all its children. The value is then computed from those sums. A division's AT&C loss is therefore the division's input, demand and collection put through the formula, never an average of its CCCs' losses. Ranks among peers at each level follow from that.

Rows that sit at a division, region or zone itself (bulk / HT consumers billed at the region, division store bookings, division cost centres) count for that office and its parents, but for no CCC. The JSON marks them: `quality.flags` has `includes_own_level_rows` and `ownLevel` gives their numerator and denominator.

| Metric | Office | Rows only at that office | Share of the office's figure |
|---|---|---|---|
| `atc_loss`, `distribution_loss`, `collection_efficiency` | Regions | Region row − Σ its divisions (HT input) | Malda 313.29 MU of 1,873.13 input (16.7 %), Raiganj 334.48 of 1,256.27 (26.6 %), Balurghat 77.62 of 664.12 (11.7 %). Zone = Σ regions (±0.01 MU) |
| `receivable_days` | Regions | Collections booked at 6610000 / 6620000 / 6630000 (HT): ₹33,568 lakh in 12 months | Left out at every level, because the consumer OSD sheet has no HT rows |
| `load_ext_pending_over_90d_share` | Regions | 48 HT applications on region codes | 4–8 % of each region's pending |
| `smart_meter_*` | Divisions, zone | Meters on division or zone stores | Raiganj division 436 of 1,683 supplied (26 %), Buniadpur 274 (30 %), zone store 519 |
| `meter_utilization_share` | Divisions | 15 ERP meters on division cost centres | under 0.1 % |
| `pmsgy_net_metering_share` | Divisions | Applications with a division but no sub-division (incl. 5 rows of other DISCOMs: Abohar, Dibrugarh) | 2–12 % |
| `capex_balance_aged_share` | Divisions | Division cost centres (C366RD0000) | 18–60 % of the balance value |
| `safety_rectification_share` | Divisions | Inspections booked on the division office | 17–52 % of sites |
| `docket_closure_days_avg` | Regions | Bulk (region-code) closed dockets | 0.6–4.5 % of dockets |
| `accidents_fatal_12m` | Divisions, Malda region | Accidents booked on a division / region office or substation | 0–50 % of a division's count |
| `cmo_open_share` | Zone | 2 grievances with district "Not Known" | 0.7 % |

**Additivity checks.** Loss report: every "… Div Total" row equals the sum of its CCC rows (no difference above 0.05 MU in any component), so CCC → division adds up exactly. Region rows do **not** equal the sum of their divisions (the HT input above), and the zone row equals the sum of the three region rows. Every other metric is built bottom-up by construction, so division = Σ CCCs + division-only rows, region = Σ divisions + region-only rows.

**Levels a metric cannot reach** (`quality.status: 'na'`, `naReason` in the JSON): the feeder-only metrics at CCC (no CCC column), CMO grievances below region (district only), SI works and O&M advances at CCC (division lists). The rating should mark these n/a and re-weight within the pillar, not penalise the office.

## Metric catalogue

Dir: ↓ lower is better, ↑ higher is better, · context (not scored). Status: **use** = fresh and sound; **care** = usable with the stated caveat; **stale** = older than its limit on 1 Nov 2026 (exclude or cap until refreshed); **context** = for scale only.

### Loss & revenue

| Id | Metric | Formula | Dataset: columns | Levels | As on / period | Dir | Benchmark | Status |
|---|---|---|---|---|---|---|---|---|
| `atc_loss` | AT&C loss | 100 × (input − min(collection, demand)) ÷ input | `loss_report`: CCC, CUM. INPUT (MU), CUM. DEMAND(MU), CUM. COLLEC. (MU), MONTH, YEAR | all | 12 months to Sep 2026 (sheet updated 30/10) | ↓ | `loss_targets`, every CCC, division, region (zone from Σ regions) | **use** |
| `atc_loss_change_yoy` | AT&C change vs a year earlier | AT&C (Sep 2026) − AT&C (Sep 2025), from summed inputs | `loss_report` | all | Sep 2025 → Sep 2026 | ↓ | none (0 = no change) | **care**: 4 CCCs use a median base |
| `distribution_loss` | Distribution loss (100 − billing efficiency) | 100 × (input − demand) ÷ input | `loss_report` | all | as AT&C | ↓ | `loss_targets` | **use** (or BE) |
| `collection_efficiency` | Collection efficiency | 100 × collection ÷ demand, capped at 100 | `loss_report` | all | as AT&C | ↑ | target derivable from `loss_targets` | **use** |
| `receivable_days` | Receivables in days of collection | OSD of live consumers ÷ (12-month collection ÷ 365) | `consumers`: CONN_STAT, OSD_LAKH; `collection_report`: PAYMENT_DT, CCC_CODE, AMOUNT PAID (₹ lakh) | all | OSD 30/09/2026; collections 01/10/2025–30/09/2026 | ↓ | none | **use** (LT only) |
| `rem_defaulters_per_1000` | Defaulters with OSD > ₹5,000 per 1,000 live consumers | Total-Count ÷ live consumers × 1,000 | `rem_osd`: Report Date, CCC Code, Total-Count, Total-Amount in Lakhs; `consumers` | all | week of 28/10/2026 | ↓ | none | **use** |
| `rem_osd_change_13w` | Change in that OSD over 13 weeks | 100 × (amount now − amount 13 weeks ago) ÷ amount then | `rem_osd` | all | 29/07 → 28/10/2026 | ↓ | 0 | **care**: small CCC bases swing |
| `disconnection_action_share` | Disconnection list acted on | 100 × (fully paid + part paid + disconnected) ÷ listed | `disconnection`: CCC_CODE, NOTOSD, PAID/DISCON DATE, FINAL PAID AMOUNT | all | lists of 06/08 (DOM) and 07/09 (IND/COM); latest action 04/10/2026 | ↑ | none | **stale** (28 days without an action date) |
| `theft_realisation` | Theft assessment realised | 100 × PAYMENT AMT ÷ (Final Bill Amt, else Provsnl Bill Amt), cases inspected in 12 months | `theft_assessment`: Location Code, CCC Name, Inspection Date, amounts | all | 29/09/2025–28/09/2026 | ↑ | none | **care**: 6 CCCs under 10 cases |

### Connection services

| Id | Metric | Formula | Dataset: columns | Levels | As on / period | Dir | Benchmark | Status |
|---|---|---|---|---|---|---|---|---|
| `nsc_pending_over_30d_share` | Paid NSC pending > 30 days | 100 × (DelayInSC > 30) ÷ pending | `nsc_pending`: CCC_CODE, SUPP_OFF, DIVN_NAME, REG, DelayInSC, TODAY | all | 30/10/2026 | ↓ | timeline from the Rights of Consumers Rules / WBERC (see sources.md); counts ≤ 7, ≤ 15, ≤ 30, > 180, > 365 days are in `inputs` | **use** |
| `nsc_pending_avg_days` | Average age since payment | Σ DelayInSC ÷ pending | `nsc_pending` | all | 30/10/2026 | ↓ | — | **use** |
| `nsc_qtn_delay_avg` | Average quotation delay | Σ DelayInQtn ÷ pending | `nsc_pending` | all | 30/10/2026 | ↓ | — | **care**: median CCC is 0.2 days, little spread |
| `nsc_wo_delay_avg` | Average work-order delay | Σ DelayInWO ÷ pending with a WO | `nsc_pending`: DelayInWO, WO_ISSUED | all | 30/10/2026 | ↓ | — | **use** |
| `nsc_pending_per_10k` | Pending NSC per 10,000 consumers | pending ÷ live × 10,000 | `nsc_pending`, `consumers` | all | 30/10/2026 | ↓ | — | **care**: also reflects demand |
| `nsc_withheld_network_share` | Withheld for want of network | 100 × withheld in 365 days for LT infrastructure / way leave for LT infrastructure / WBSEDCL unable / techno-economically not feasible / transformer location ÷ all withheld in 365 days | `withheld`: SCN_WITHELD_DATE, SCN_WITHELD_REASON, office cells, TODAY | all | 30/10/2025–29/10/2026 | ↓ | — | **care**: reason codes typed by staff |
| `nsc_released_12m` | Connections released in 12 months | Σ D + C + I + A + O | `historical_nsc`: CCC CODE, METER_INSTALL_DATE (m/d/yy) | all | 09/03/2025–08/03/2026 | · | — | **stale** (latest install 08/03/2026) |
| `weekly_disposal_share` | Weekly applications disposed | 100 × Σ Total disposed ÷ Σ To be disposed, last 4 weeks | `weekly_report` | all | 02/02–23/02/2026 | ↑ | — | **stale** (251 days) |
| `mc_pending_over_30d_share` | Master cards pending > 30 days after meter installation | 100 × (Report Date − Meter Installation Date > 30) ÷ pending | `pending_mc` (Storage copy): SUBSTR(A.SUPP_OFF,-7,7), CCC, Division, Region, dates | all | 28/10/2026 | ↓ | 30 days (the page's own band) | **care**: Storage copy 2 days behind the sheet; 19 CCCs under 20 cases |
| `load_ext_pending_over_90d_share` | Load extensions pending ≥ 3 months | 100 × (AGE_MONTHS ≥ 3) ÷ pending | `load_extension`: CCC CODE, AGE_MONTHS | all | 28/10/2026 | ↓ | — | **care**: 17 CCCs under 10 cases |
| `solar_pending_over_30d_share` | Rooftop solar applications > 30 days old not connected | 100 × (created > 30 days ago, REPLACE_STATUS not success) ÷ created > 30 days ago | `solar_connections`: CCC CODE, SUPP_OFF, CREATION_DATE, REPLACE_STATUS, Report Date | all | 28/10/2026 | ↓ | — | **use** |
| `pmsgy_net_metering_share` | PM Surya Ghar installations net-metered | 100 × installed with a Net Metering Date ÷ installation completed | `pmsgy_*` (3 tabs): Sub-Division Name, Division Name, District, Installation Status, Net Metering Date | all | latest action 27/10/2026 | ↑ | — | **care**: 21 CCCs under 10 installations |

### Metering, billing & collection

| Id | Metric | Formula | Dataset: columns | Levels | As on / period | Dir | Benchmark | Status |
|---|---|---|---|---|---|---|---|---|
| `defective_meter_share` | Defective meters per live consumer | 100 × Σ total ÷ live consumers | `defective_summary`: CCC_CODE, total, REPORT_AS_ON; `consumers` | all | 16/10/2026 (consumers 30/09) | ↓ | — | **use** (summary only) |
| `defective_over5y_share` | Defective for over 5 years | 100 × Σ over5 ÷ Σ total | `defective_summary`: over5, over10, DEFECT_YEAR | all | 16/10/2026 | ↓ | — | **use** |
| `unmetered_share` | Live consumers without a meter | 100 × LIVE "NO METER" ÷ LIVE | `consumers`: TYPE_OF_METER | all | 30/09/2026 | ↓ | 0 | **exclude**: 277 consumers zone-wide (0.01 %), no spread |
| `smart_meter_installed_share` | Supplied smart meters installed | 100 × installed ÷ supplied | `smart_meter_status`: ccc_final, Meter Installed Qty. In Field_Active In Hes_ | all | 12/11/2025 (work-order tab date) | ↑ | — | **stale** |
| `smart_meter_ami_push_share` | Installed meters submitted to AMI | 100 × pushed ÷ installed | `smart_meter_status`: Total Submit In Ami Portal | all | 12/11/2025 | ↑ | — | **stale** |
| `meter_utilization_share` | Issued meters put to use | 100 × ERP meters found in master (new connection) or CRM/ISU (replacement) ÷ meters issued ≥ 30 days earlier | `meter_erp`: Serial Number, Cost Center, Entry Date; `meter_master`, `meter_crm`, `meter_isu` | all | ERP to 30/09/2026 | ↑ | — | **use** |
| `unbilled_3m_per_10k` | Existing consumers unbilled for 3 months | column Q ÷ live × 10,000 | `important_unbilled_3_months` (code in column D) | all | report of 09/10/2026 | ↓ | 0 | **use** |
| `first_bill_pending_per_10k` | Live connections without a first bill | column J ÷ live × 10,000 | `important_first_bill_pending` | all | 09/10/2026 | ↓ | 0 | **use** |
| `low_unit_bill_share` | Bills under 10 units a month (incl. zero) | 100 × column I ÷ column F (live consumers, same sheet) | `important_rem_less_unit_billed` | all | schedule to 15/09/2026 | ↓ | — | **care**: columns follow the page's labels (merged headers lost); low use is also genuine |

### Reliability

| Id | Metric | Formula | Dataset: columns | Levels | As on / period | Dir | Benchmark | Status |
|---|---|---|---|---|---|---|---|---|
| `feeder_outage_hours` | Outage hours per 11 kV feeder per month (SAIDI proxy) | Σ TOTAL DURATION OF OUTAGE OVER 5 MIN ÷ 60 ÷ feeder-months | `feeder_outage`: REPORT MONTH, CIRCLE NAME, DIVISION NAME | division, region, zone | Sep 2025–Aug 2026 | ↓ | — | **use** |
| `feeder_outage_count` | Outages per feeder per month (SAIFI proxy) | Σ TOTAL COUNT OF OUTAGE OVER 5 MIN ÷ feeder-months | `feeder_outage` | division+ | Sep 2025–Aug 2026 | ↓ | — | **use** |
| `feeder_concern_share` | Feeder-months of concern | 100 × feeder-months with ≥ 1 h/day or ≥ 30 outages ÷ feeder-months | `feeder_outage` | division+ | Sep 2025–Aug 2026 | ↓ | — | **care**: overlaps the two above |
| `dtr_weighted_outage_hours` | Outage hours a DTR saw per month | Σ over DTRs of their feeder's outage hours ÷ DTR-months | `feeder_outage` + `dtr_records`: SUPP_OFF, DIVN NAME, SS_NAME, FDR_NAME | all | Sep 2025–Aug 2026 | ↓ | — | **care**: name match, 84 % of DTRs covered |

### Grievance & fault redressal

| Id | Metric | Formula | Dataset: columns | Levels | As on / period | Dir | Benchmark | Status |
|---|---|---|---|---|---|---|---|---|
| `fault_dockets_open_over_24h_per_10k` | Fault dockets open > 24 h per 10,000 consumers | technical open ≥ 24 h before the latest docket ÷ live × 10,000 | `docket_calls`: ccc_code, prob_type, doc_crn_dt | all | 01/11/2026 07:20 | ↓ | fault timelines (SoP, see sources.md) | **use** |
| `docket_open_over_48h_share` | Open dockets older than 48 h | 100 × open ≥ 48 h ÷ open | `docket_calls` | all | 01/11/2026 | ↓ | — | **care**: 98 % everywhere (an unclosed backlog back to 2017) |
| `docket_open_per_10k` | Open dockets per 10,000 consumers | open ÷ live × 10,000 | `docket_calls`, `consumers` | all | 01/11/2026 | ↓ | — | **care**: measures closing in the system as much as service |
| `docket_closure_days_avg` | Average time to close a docket | Σ Sum of Diff (days) ÷ Σ Count of doc_no | `docket_kpi`: ccc_code, DESCRIPTION, Count of doc_no, Sum of Diff | all | closed Jan 2023–Jun 2025 | ↓ | — | **stale** |
| `cmo_open_share` | CMO grievances pending with an MZO officer | 100 × Pending With ≠ "Disposed / pending with HQ" ÷ grievances | `cmo_grievances`: District, Pending With, Grievance Since, Report Date | region, zone | 28/10/2026 | ↓ | — | **use** (regions only) |

### Safety & financial discipline

| Id | Metric | Formula | Dataset: columns | Levels | As on / period | Dir | Benchmark | Status |
|---|---|---|---|---|---|---|---|---|
| `accidents_fatal_12m` | Fatal electrical accidents (people) in 12 months | count Nature of Injury = Fatal, Type of Victim = Human | `accident_reports`: Code/Name of CCC/Substation, Division, Region, Date of Accident | all | 22/06/2024–21/06/2025 | ↓ | 0 | **stale** (latest accident on the export 21/06/2025) |
| `safety_rectification_share` | Unsafe sites rectified | 100 × sites with Rectification done on ÷ inspected sites (first row per Site ID) | `safety_inspection`: Office, Site ID, Rectification done on, Entered on | all | to 10/03/2026 | ↑ | — | **stale** |
| `si_works_completed_share` | Priority SI works completed | 100 × Status Completed ÷ works | `si_works` (Supabase): Region, Division, Status, Target Date, updated_at | division+ | last edit 24/09/2026 | ↑ | Target Date (overdue count in `inputs`) | **care**: 49 of 291 works have no status |
| `capex_balance_aged_share` | Capex material with contractors > 90 days | 100 × Net Balance Value with Ageing in Days > 90 ÷ Net Balance Value | `capex_details`: Reporting Date, Cost Centre, Net Balance Value, Ageing in Days; `costcenter` | all | 28/09/2026 | ↓ | — | **use** |
| `onm_advance_aged_share` | O&M material advance > 90 days | 100 × Mat Balance(Value) of orders > 90 days old ÷ Mat Balance(Value) | `onm_advance`: Creation Date, Resp. CCtr, Plant | division+ | to 31/07/2025 | ↓ | — | **stale** |

### Context (not scored)

| Id | What | Source | As on |
|---|---|---|---|
| `live_consumers` | Σ COUNT where CONN_STAT = LIVE; `inputs` also has OSD of live and of deemed-disconnected consumers | `consumers` | 30/09/2026 |
| `dtr_count` | DTR records and Σ CAPA_KV | `dtr_records` | no date (inventory) |

## Sample values (1 November 2026)

Zone, then the three regions (Malda · Raiganj · Balurghat), the division range, and the CCC lowest · median · highest. Every office's value with its numerator and denominator is in [sample-metrics.json](sample-metrics.json).

| Id | Unit | Zone | Regions | Divisions | CCCs |
|---|---|---:|---|---|---|
| `atc_loss` | % | 22.4 | 21.4 · 22.4 · 24.9 | 22.2 (Gazole) – 33.2 (Islampur) | 8.18 (Bamongola) · 26.4 · 49.3 (Tapan) |
| `atc_loss_change_yoy` | pts | −2.23 | −3.02 · −1.15 · −2.19 | −8.21 (Gazole) – −0.01 (Raiganj) | −12.7 (Paranpur) · −2.01 · 7.53 (Balurghat) |
| `distribution_loss` | % | 21.6 | 21.0 · 21.0 · 24.3 | 20.4 (Gazole) – 31.8 (Islampur) | 7.31 (Balurghat) · 25.0 · 49.3 (Tapan) |
| `collection_efficiency` | % | 99.0 | 99.4 · 98.3 · 99.2 | 97.7 (Gazole) – 100 (Buniadpur) | 91.7 (Birnagar) · 99.7 · 100 |
| `receivable_days` | days | 105 | 79 · 159 · 92 | 71 (Chanchal) – 220 (Islampur) | 35.5 (Sujapur) · 90.8 · 313 (Chopra) |
| `rem_defaulters_per_1000` | per 1,000 | 60.0 | 40.7 · 106.7 · 29.7 | 15.1 (Balurghat) – 160 (Islampur) | 1.79 (Hili) · 37.5 · 236 (Chopra) |
| `rem_osd_change_13w` | % | 1.87 | 8.59 · −0.10 · −6.76 | −13.8 (Buniadpur) – 18.7 (Balurghat) | −21.7 (Gangarampur) · 8.83 · 81.1 (Hemtabad) |
| `disconnection_action_share` | % | 52.4 | 65.8 · 41.4 · 55.9 | 34.7 (Raiganj) – 86.1 (Chanchal) | 17.0 (Birnagar) · 60.4 · 95.7 (Harishchandrapur) |
| `theft_realisation` | % | 68.2 | 80.9 · 57.5 · 56.8 | 43.4 (Balurghat) – 87.9 (Malda) | 36.1 (Islampur) · 76.6 · 100 (Bamongola) |
| `nsc_pending_over_30d_share` | % | 67.7 | 53.3 · 78.5 · 66.5 | 41.3 (Malda) – 80.0 (Raiganj) | 14.1 (Sujapur) · 63.9 · 90.9 (Mokdumpur) |
| `nsc_pending_avg_days` | days | 117 | 81 · 151 · 92 | 70 (Balurghat) – 154 (Raiganj) | 13.2 (Rathbari) · 95.6 · 243 (Itahar) |
| `nsc_qtn_delay_avg` | days | 1.97 | 2.27 · 1.56 · 2.68 | 0.17 (Malda) – 5.22 (Gazole) | 0 (Mothabari) · 0.23 · 17.8 (Old Malda) |
| `nsc_wo_delay_avg` | days | 28.0 | 18.0 · 36.7 · 19.4 | 11.9 (Chanchal) – 38.0 (Raiganj) | 1.23 (Kaliachak) · 19.5 · 89.9 (Fulbari) |
| `nsc_pending_per_10k` | per 10,000 | 22.6 | 17.3 · 34.7 · 15.4 | 13.1 (Malda) – 35.2 (Islampur) | 7.03 (Kaliachak) · 18.1 · 48.6 (Dalkhola) |
| `nsc_withheld_network_share` | % | 18.8 | 22.2 · 14.0 · 27.5 | 8.47 (Gazole) – 41.8 (Malda) | 0 (Golapganj) · 19.0 · 61.3 (Rathbari) |
| `nsc_released_12m` (stale) | count | 94,058 | 46,201 · 30,655 · 17,202 | 8,148 – 19,991 | 663 (Hili) · 2,237 · 4,243 (Islampur) |
| `weekly_disposal_share` (stale) | % | 47.8 | 51.4 · 31.4 · 70.2 | 27.3 – 84.8 | 14.5 · 45.9 · 92.5 |
| `mc_pending_over_30d_share` | % | 30.9 | 43.3 · 26.7 · 14.6 | 11.3 (Balurghat) – 55.7 (Chanchal) | 0 · 33.8 · 100 (Kumarganj, 1 case) |
| `load_ext_pending_over_90d_share` | % | 85.1 | 71.1 · 94.2 · 86.1 | 52.2 (Malda) – 95.7 (Raiganj) | 0 · 75.0 · 100 |
| `solar_pending_over_30d_share` | % | 78.4 | 83.8 · 75.3 · 71.7 | 68.5 (Buniadpur) – 92.3 (Chanchal) | 59.7 (Balurghat) · 80.0 · 100 (Bhaluka) |
| `pmsgy_net_metering_share` | % | 76.6 | 76.8 · 76.2 · 77.2 | 65.0 (Chanchal) – 93.0 (Islampur) | 0 (Bhaluka) · 78.7 · 100 |
| `defective_meter_share` | % | 23.1 | 25.4 · 22.5 · 18.6 | 16.2 (Raiganj) – 35.5 (Chanchal) | 5.80 (Hili) · 23.2 · 46.4 (Paranpur) |
| `defective_over5y_share` | % | 53.4 | 62.7 · 43.6 · 43.1 | 34.2 (Raiganj) – 66.6 (Chanchal) | 7.88 (Hili) · 52.1 · 73.0 (Kushida) |
| `unmetered_share` | % | 0.01 | 0.01 · 0.01 · 0.01 | 0.01 – 0.02 | 0 · 0.01 · 0.04 |
| `smart_meter_installed_share` (stale) | % | 62.6 | 63.9 · 64.9 · 73.7 | 56.6 (Malda) – 89.2 (Balurghat) | 35.9 (Manikchak) · 78.8 · 98.8 (Tapan) |
| `smart_meter_ami_push_share` (stale) | % | 91.9 | 93.6 · 94.7 · 85.1 | 79.8 (Buniadpur) – 96.8 (Gazole) | 57.4 (Buniadpur) · 96.0 · 100 |
| `meter_utilization_share` | % | 93.2 | 93.9 · 91.2 · 94.7 | 90.6 (Islampur) – 97.0 (Buniadpur) | 86.4 (Raiganj) · 93.7 · 99.2 (Kaliachak) |
| `unbilled_3m_per_10k` | per 10,000 | 5.54 | 2.40 · 9.61 · 6.29 | 1.11 (Chanchal) – 11.7 (Raiganj) | 0 · 3.05 · 21.6 (Raiganj) |
| `first_bill_pending_per_10k` | per 10,000 | 6.48 | 6.24 · 8.16 · 4.34 | 2.97 (Balurghat) – 9.78 (Raiganj) | 0 (Pandua) · 5.84 · 19.2 (Raiganj) |
| `low_unit_bill_share` | % | 9.12 | 6.75 · 10.0 · 13.2 | 4.81 (Malda) – 13.6 (Buniadpur) | 0.61 (Golapganj) · 9.23 · 14.7 (Kusmandi) |
| `feeder_outage_hours` | h / feeder-month | 11.9 | 10.5 · 12.3 · 13.9 | 7.93 (Malda) – 14.3 (Balurghat) | n/a |
| `feeder_outage_count` | / feeder-month | 20.1 | 20.0 · 21.5 · 18.8 | 14.9 (Malda) – 23.5 (Raiganj) | n/a |
| `feeder_concern_share` | % | 25.3 | 22.8 · 27.3 · 27.1 | 14.3 (Malda) – 31.0 (Raiganj) | n/a |
| `dtr_weighted_outage_hours` | h / DTR-month | 14.4 | 12.0 · 15.1 · 17.6 | 9.83 (Malda) – 17.7 (Balurghat) | 3.93 (Fulbari) · 12.8 · 24.3 (Kusmandi) |
| `fault_dockets_open_over_24h_per_10k` | per 10,000 | 2.65 | 1.62 · 0.63 · 8.31 | 0.39 (Raiganj) – 8.49 (Balurghat) | 0 (10 CCCs) · 1.29 · 14.8 (Kusmandi) |
| `docket_open_over_48h_share` | % | 97.7 | 97.6 · 89.1 · 98.6 | 81.4 (Raiganj) – 98.9 (Buniadpur) | 0 · 97.7 · 100 |
| `docket_open_per_10k` | per 10,000 | 19.0 | 17.2 · 2.97 · 49.1 | 1.70 (Raiganj) – 52.4 (Buniadpur) | 0 · 11.1 · 82.3 (Balurghat) |
| `docket_closure_days_avg` (stale) | days | 1.49 | 1.14 · 0.77 · 3.33 | 0.60 (Raiganj) – 3.39 (Buniadpur) | 0.13 · 1.03 · 4.73 (Patiram) |
| `cmo_open_share` | % | 13.6 | 14.9 · 10.4 · 15.0 | n/a | n/a |
| `accidents_fatal_12m` (stale) | count | 61 | 23 · 14 · 24 | 2 (Malda) – 17 (Balurghat) | 0 · 1 · 8 (Tapan) |
| `safety_rectification_share` (stale) | % | 84.4 | 75.1 · 73.5 · 92.5 | 27.3 (Raiganj) – 94.7 (Buniadpur) | 0 · 95.5 · 100 |
| `si_works_completed_share` | % | 9.97 | 13.3 · 8.93 · 6.00 | 3.85 (Chanchal) – 22.2 (Gazole) | n/a |
| `capex_balance_aged_share` | % | 61.4 | 59.2 · 55.5 · 69.2 | 37.7 (Islampur) – 71.3 (Buniadpur) | 0 · 52.5 · 80.7 (Buniadpur) |
| `onm_advance_aged_share` (stale) | % | 95.8 | 93.7 · 98.3 · 95.0 | 47.6 (Gazole) – 99.9 (Islampur) | n/a |
| `live_consumers` | count | 22,74,998 | 10,73,089 · 7,41,133 · 4,60,776 | 2,18,234 (Buniadpur) – 4,71,766 (Malda) | 25,132 (Hili) · 54,467 · 90,910 (Islampur) |
| `dtr_count` | count | 40,429 | 18,365 · 11,452 · 10,612 | 4,602 – 7,389 | 390 (Kaliachak) · 896 · 2,571 (Gazole) |

### Checked against the pages

The script's zone totals were compared with the live pages on the VM (mirror mode, same snapshots, GET-only browser with every other request blocked), 1 November 2026:

| Page | Page shows | Script |
|---|---|---|
| Pending NSC | 5,140 pending | 5,140 (`nsc_*` denominator) |
| Loss | AT&C 22.35 %, distribution 21.57 %, CE 99.00 %, input 3,793.51 MU | 22.35 / 21.57 / 99.00, 3,793.51 MU; every Div Total row = Σ its CCCs |
| Pending MC | 2,153 pending, 1,487 within 30 days, 427 at 90+ days | 2,153; 666 over 30 days; 427 |
| Load extension | 821 pending, 574 over a year | 821; 574 (`yearOrMore`) |
| Disconnection | 7,372 paid + 498 part paid + 2,558 disconnected, 9,478 no action (19,906) | 10,428 acted on of 19,906 |
| Docket calls | 4,326 open, 671 technical | 4,326; 671. The page's "over 48 h" (4,238) ages against the viewing time; the script ages against the latest docket (4,226) so the figure does not drift |
| Defective meter | 5,25,508 meters, 2,80,799 over 5 years | 525,508; 280,799 |
| Smart meters | 9,541 supplied, 5,972 installed, 5,489 pushed; "As on 12 Nov 2025" | same; same date |
| REM OSD > ₹5,000 | 1,36,513 consumers, ₹185 Cr (28/10) | 136,513; ₹18,542.32 lakh |
| Solar | 727 connected of 6,827 | 727 of 6,826 (one broken row, sheet row 6,267, has no office) |
| PM Surya Ghar | 732 installed, 553 connected | 732; 561: the page misses 8 Net Metering Dates written with the full month ("15-July-26") |
| Feeder outage | yearly average 14.2 h (2026, 8 months), monthly range 2.8–33.1 h | 14.25 h; 2.8–33.1 h (the metric itself pools the 12 months: 11.9 h) |
| CMO grievances | 38 pending of 278 | 38 of 280 (2 have district "Not Known") |
| Safety inspections | 828 sites, 699 rectified (84 %) | 828; 699 (84.4 %) |
| Meter utilization | 2,40,525 issued, 90 % used | 228,187 issued at least 30 days before the last ERP entry (a repeated serial counted once), 93.2 % used |
| Theft | provisional ₹75.09 Cr, recovered ₹40.03 Cr (all years) | ₹75.09 Cr; ₹40.06 Cr (the metric uses the last 12 months) |

## Per-metric notes

**AT&C, distribution loss, collection efficiency.** The loss sheet's "CUM." figures are a 12-month total that does not reset in April (zone input 3,706 MU in Apr 2025, 3,793 MU in Sep 2026), so each month is a rolling year. The sheet caps collection efficiency at 100 % (Tapan collected 100.45 % of demand and shows 100.00 %), and AT&C = 1 − BE × min(CE, 1); the script reproduces every CCC, division, region and zone figure of Sep 2026 from the three MU columns. CCC names are mapped through `lib/offices.js` (MATHURAPUR = Manikchak, MOKDAMPUR, BAISNABNAGAR, KARANDEGHI, KUMARGUNJ, KUSHMUNDI, GOALPOKHAR, KALIAGANJ, H.C. PUR). The pasted duplicate block (2023 months) is skipped by month + name. Targets: `loss_targets` has input, demand and collection per CCC, division and region with no period stated (treat as the current-year target); the script recomputes the target loss from its components, which corrects Harirampur's typed target distribution loss (39.14 % written, 29.14 % from its own MU). The zone target comes from Σ regions (no zone row). Scale: CCC input 23.9 MU (Hili) to 126.5 MU (Gangarampur); AT&C 8 % to 49 %, so a loss scale needs a wide band. Tapan (49 %, target 48.5 %) is a structural outlier.

**AT&C change vs a year earlier.** In Sep 2025 the sheet has two pairs of swapped CCC rows: Tapan ↔ Kumarganj and Bamongola ↔ Old Malda (Kumarganj shows 110.81 MU input, its usual is 47–50). Both pairs swap inside one division, so division and higher figures are unaffected. For an office whose year-earlier value is more than 10 pts from the median of Aug, Sep and Oct of that year, the script uses that median and flags `base_month_outlier` (exactly those four CCCs). Without the fix Kumarganj would show −37 pts and Tapan +28 pts.

**Receivable days.** The consumer sheet (`consumers`, one row per CCC × status × class, as on 30/09/2026) has OSD for live consumers only through LT billing (one row at a division code); collections booked at region codes (HT, ₹336 Cr a year, 19.5 % of all collections) are therefore left out on both sides. OSD of deemed-disconnected consumers (₹175 Cr) is in `inputs` of `live_consumers`, not in the metric. Islampur division's CCCs (Chopra 313 days, Kanki 242, Islampur 225) stand far above the median (91): a long-tail scale.

**REM OSD > ₹5,000.** Weekly report (65 report dates since 05/02/2025, 41 CCC rows each). Counts are non-govt, non-STW consumers on the disconnection list. The 13-week change uses the report closest to 91 days before the latest (29/07/2026). Small CCCs swing (Hemtabad +81 % on ₹31 lakh), so a cap or a minimum base is advisable.

**Disconnection tracker.** Status rules are the page's: no valid PAID/DISCON DATE = no action; a date without FINAL PAID AMOUNT = disconnected; paid ≥ OSD = fully paid, else part paid. The list was set on 06/08 (DOM) and 07/09 (IND/COM) and the latest action date is 04/10/2026, so the follow-through stops a month ago: refresh before scoring.

**Theft.** 8,013 cases since 2011; the metric takes the 1,316 cases inspected in the 12 months to 28/09/2026 (₹11.83 Cr assessed, ₹8.07 Cr paid). Recent cases have had less time to pay, uniformly for all offices. Case counts per CCC run from 3 to 94, so 6 CCCs fall under the 10-case minimum.

**Pending NSC.** All 5,140 rows are paid (COLL_DATE filled) and Working; DelayInSC = days from payment to TODAY (30/10), DelayInWO = payment → work order (blank for the 714 without a WO), DelayInQtn = inspection → quotation. Every row maps to a CCC. A share over a fixed timeline is fairer than the old index's raw count, which grows with office size. A true "released within timeline" rate needs released connections with dates, which only `historical_nsc` (stale since March) has.

**Withheld.** 66,589 withheld applications since 2014; 6,131 withheld in the last 365 days. Most reasons are on the consumer's side (documents 1,669, dues 743, existing connection 731); the network reasons (LT infrastructure 595, way leave for LT infrastructure 440, WBSEDCL unable 84, not feasible 28, transformer location 4) are the part an office controls. 12 applications are in both lists (DQ finding 3).

**Pending MC and load extension.** Both are Supabase Storage copies as on 28/10. The MC sheet is newer (30/10, 247 applications differ, DQ finding 4): press Sync sheet before a rating run. MC ages have a long tail (average 557 days because of 2015 installation dates), so use the share, not the mean. 39 of 41 CCCs have MC cases; 2 have none (`no_cases`), likewise load extension.

**Solar and PM Surya Ghar.** 3,533 of 6,826 solar applications were created in the last 30 days (the PM Surya Ghar drive), so "connected of all applications" (11 %) mostly measures the surge; the metric looks only at applications older than 30 days. PM Surya Ghar is the national portal export; Sub-Division Name gives the CCC, and 5 rows of other DISCOMs (Abohar, Dibrugarh) land on the division they name. The step the office controls is net metering after installation (561 of 732).

**Defective meters.** Uses only the summary (all rows as on 16/10/2026, total 525,508 = the page and the Storage meta). The details tab mixes the 16/10 and 23/10 dumps (DQ finding 1) and is not used. "Over 5 years" is the defect age (defect before Oct 2021 ≈ 280k). Defective meters are 23 % of live consumers zone-wide (5.8 % Hili to 46 % Paranpur). Rectification cannot be measured from one snapshot; it needs two summaries a month apart (see gaps).

**Meter utilization.** Mirrors the page (master = new connection; CRM burnt-meter list and ISU replacements = replacement; else in hand) but counts only meters issued at least 30 days before the latest ERP entry, so a fresh issue does not count against an office, and counts a repeated serial once (DQ finding 7: 103 serials entered twice). Spread is narrow (86–99 %).

**Billing sheets (Important data).** These are report-style sheets with merged headers; office rows carry the CCC code in column D, total rows have none and are skipped (11 per sheet). Column meaning: 3-months unbilled total = Q, first bill pending total = J (as the sums show), less-unit sheet F = live consumers, I = bills under 10 units including zero, M = zero-unit bills (the labels important_sheets.html uses for I56 and M56). The monthly "Unbilled report" sheets change layout from month to month and the latest (Aug-2026) is as on 29/07/2026, so they are not used.

**Feeder outage and the DTR-weighted proxy.** 462–489 feeders a month, all 11 kV, division and substation only. True SAIFI/SAIDI are consumer-weighted; we have no consumers per feeder, so the division metrics are per feeder. For CCCs, each 11 kV feeder is tied to the DTRs it feeds in `dtr_records` (by division + substation name + feeder name, falling back to division + feeder name): 4,426 of 5,730 feeder-months match, covering 33,802 of 40,429 DTRs (84 %). Each DTR then "sees" its feeder's outage hours, and the metric is the average over DTR-months, a DTR-weighted SAIDI proxy that also works at CCC level. Coverage per CCC is in `inputs`; Pandua (29 %), Aiho (47 %) and Gangarampur (54 %) are flagged `low_match_coverage`. A feeder → CCC table maintained in the sheet would remove the name matching.

**Dockets.** `docket_calls` is the open-docket list (4,326, back to 2017); 98 % are older than 48 h because most are commercial dockets that were never closed in the system, so the age share does not discriminate. The fault part is small and current: 671 technical open dockets (docket.html's technical list), 604 of them older than 24 h. Raiganj division has only 70 open dockets against 1,121–1,143 in Balurghat and Buniadpur: either it closes them in the system or it logs fewer. Ages are measured against the latest docket time in the sheet, not the clock. `docket_kpi` (closure times) has no date and the page labels it Jan 2023 – Jun 2025.

**CMO grievances.** 280 grievances, by district only; "pending" follows cmo.html (Pending With is an officer, 38) rather than Status, because ATR-submitted grievances wait on the CMO, not the office.

**Accidents.** The export holds 1,631 accidents, 1,135 of other zones; the latest MZO accident is 21/06/2025, so the export itself is 16 months old (not flagged in data-quality.md). Not rateable until refreshed.

**Safety inspections, SI works, advances.** Safety follows the page (first row per Site ID, rectified = a Rectification done on date; 5,309 repeat rows of a site dropped); the last entry is 10/03/2026. SI works are a live Supabase list (291 works, 29 completed, 49 without a status), division only. Capex material balance (₹48.6 Cr with contractors, 61 % older than 90 days) maps every Malda-zone cost centre once `data/costcenter.json` maps the old SAP cost centres (the 8,030 "other zone" rows in data-quality.md are old Malda cost centres such as C334621020 = Kusmandi); the 296 rows left over from the 19/08 report are dropped. O&M advance is 15 months old.

## Coverage per level

Offices with a value; "nil" = the office has no cases on a list (zero cases, not missing data); "small" = under the metric's minimum base (`small_base`, status warn).

| Id | CCCs (41) | Divisions (7) | Regions (3) | Zone |
|---|---|---|---|---|
| Loss metrics, `receivable_days`, `rem_*`, `disconnection_action_share`, `nsc_*`, `solar_*`, `defective_*`, `unmetered_share`, `smart_meter_*`, `meter_utilization_share`, billing sheets, `docket_open_per_10k`, `fault_dockets_open_over_24h_per_10k`, `docket_closure_days_avg`, `accidents_fatal_12m`, `capex_balance_aged_share`, context | 41 | 7 | 3 | 1 |
| `theft_realisation` | 41 (6 small) | 7 | 3 | 1 |
| `nsc_wo_delay_avg`, `nsc_withheld_network_share` | 41 (2 small) | 7 | 3 | 1 |
| `mc_pending_over_30d_share` | 39 + 2 nil (19 small) | 7 | 3 | 1 |
| `load_ext_pending_over_90d_share` | 39 + 2 nil (17 small) | 7 | 3 | 1 |
| `pmsgy_net_metering_share` | 41 (21 small) | 7 | 3 | 1 |
| `docket_open_over_48h_share` | 39 + 2 nil (10 small) | 7 | 3 | 1 |
| `dtr_weighted_outage_hours` | 41 (3 low coverage) | 7 | 3 | 1 |
| `safety_rectification_share` | 27 + 14 nil (18 small) | 7 | 3 | 1 |
| `feeder_*`, `si_works_completed_share`, `onm_advance_aged_share` | n/a | 7 | 3 | 1 |
| `cmo_open_share` | n/a | n/a | 3 | 1 |

## Period alignment

| As on | Datasets (metrics) |
|---|---|
| 01/11/2026 (live) | docket calls |
| 27–30/10/2026 | pending NSC (30/10), withheld (29/10), REM OSD (28/10), pending MC, load extension, solar, CMO (28/10), PM Surya Ghar (27/10) |
| 09–16/10/2026 | defective summary (16/10), 3-months unbilled and first bill pending (09/10) |
| 28/09–04/10/2026 | disconnection actions (04/10), theft (28/09), capex (28/09), loss (month of Sep, updated 30/10), consumers and OSD (30/09), collections (to 29/10; the receivable window ends 30/09), meter ERP (30/09) |
| 15/09/2026 | low-unit bills (billing schedule to 15/09) |
| 31/08/2026 | feeder outage (12 months to Aug) |
| older | SI works last edit 24/09/2026 (live list), safety 10/03/2026, historical NSC 08/03/2026, weekly 23/02/2026, smart meters 12/11/2025, accidents 21/06/2025, docket KPI Jun 2025, O&M advance 31/07/2025 |

The rateable set spans about two months: the loss, OSD and collection figures are September month-end, the operational lists are the last week of October, and feeder outages end in August. Mixing them is acceptable for a monthly rating if the page states each "as on"; the per-consumer rates divide late-October counts by the 30/09 consumer base (one month of growth, under 0.5 %).

## Quality flags and recommended exclusions

Flags in the JSON (`flags` at the top explains each): `stale`, `small_base`, `no_cases`, `no_rows`, `level_not_available`, `includes_own_level_rows`, `low_match_coverage`, `base_month_outlier`, plus dataset caveats (`details_mixed_as_on_not_used`, `storage_copy_behind_sheet`, `pending_withheld_overlap_12`, `ht_region_collections_excluded`, `no_date_in_sheet`, `as_on_from_work_order_tab`, `columns_inferred_from_page_labels`, `feeder_name_match`).

Recommended:

1. **Exclude until the source is refreshed:** `weekly_disposal_share` (Feb 2026), `nsc_released_12m` (Mar 2026), `smart_meter_*` (Nov 2025), `docket_closure_days_avg` (Jun 2025), `accidents_fatal_12m` (Jun 2025), `safety_rectification_share` (Mar 2026), `onm_advance_aged_share` (Jul 2025). Each has a maxAgeDays in the JSON; the engine can apply the rule automatically.
2. **Exclude as non-discriminating:** `unmetered_share` (0.01 % everywhere), `docket_open_over_48h_share` (98 % everywhere).
3. **Cap or shrink small bases:** `mc_pending_over_30d_share`, `load_ext_pending_over_90d_share`, `pmsgy_net_metering_share`, `theft_realisation` at CCC level (many CCCs have under 10–20 cases). Score these at CCC with a minimum base (e.g. treat under-base offices as n/a and re-weight), or pool them into a "connection backlog" sub-parameter so the counts add up.
4. **Refresh first:** disconnection tracker (no action date after 04/10) and pending MC (Storage copy behind the sheet).
5. **Use with the stated caveat:** `atc_loss_change_yoy` (four CCC bases replaced), `dtr_weighted_outage_hours` (name match, 84 % coverage), `low_unit_bill_share` (column meaning from the page), `docket_open_per_10k` (system hygiene as much as service), `nsc_withheld_network_share` (staff-typed reasons).

## Biggest data gaps

Against the national frameworks (PFC integrated rating; REC consumer service rating), these parameters have no usable data at office level today:

1. **Reliability by consumers.** No consumers per feeder and no DTR failures: SAIFI/SAIDI are feeder- or DTR-weighted proxies, and DTR failure rate (a CSRD parameter) is missing entirely. `dtr_peak_load` has 91 readings (last 06/05/2026) and `prt_oil_tests` is empty. Wanted: a DTR failure register (DTR_CODE, date failed, date replaced) and the feeder → CCC table.
2. **Connections released within timeline.** Only pending lists are current; released connections with application and release dates stopped in March (`historical_nsc`) and the weekly deposit/disposal in February. Wanted: the NSC released dump each month (APPL_NO, COLL_DATE, release date, CCC).
3. **Fault rectification time.** Closed-docket times stop in June 2025 and carry no date; the open list has no closure time. Wanted: the closed-docket dump with created and closed times per month.
4. **Billing in money.** Loss is in MU; there is no ₹ billed per CCC, so receivables are measured in days of *collection* rather than revenue, and collection efficiency is in MU only.
5. **Meter rectification.** One defective snapshot at a time; rectification needs two consecutive summaries (keep each month's summary).
6. **Safety and accidents.** Both exports are many months old; the safety app last wrote on 10/03/2026.
7. **CMO below region.** Grievances name a block, not a CCC; a block → CCC table would bring them to CCC level.

## Recommended pillar structure (data view)

Pillars and parameters that the data supports today at all four levels, with a weight split that follows where the data is solid. Final weights belong to the methodology.

| Pillar | Weight | Parameters (fresh, all levels unless noted) |
|---|---:|---|
| A. Loss & revenue | 35 | AT&C loss vs target (20), AT&C change vs a year earlier (5), receivable days (5), defaulters per 1,000 and their 13-week trend (5) |
| B. Connection services | 20 | Paid NSC pending > timeline (8), work-order delay (3), master cards > 30 days (3), load extension ≥ 3 months (2), solar > 30 days and PM Surya Ghar net metering (4) |
| C. Metering & billing | 20 | Defective meters per consumer (6) and over 5 years (3), unbilled 3 months (4), first bill pending (3), low-unit bills (2), meter utilization (2) |
| D. Reliability | 15 | DTR-weighted outage hours (8, all levels), outages per feeder (4, division+), feeder-months of concern (3, division+) |
| E. Grievance & fault redressal | 7 | Fault dockets open > 24 h per 10,000 (5), CMO pending (2, region+) |
| F. Safety & discipline | 3 | Capex material > 90 days (3); accidents and safety inspections when refreshed |

Theft realisation and the disconnection follow-through fit Pillar A once the tracker is refreshed and the small CCC bases are handled. In every pillar a parameter that is n/a at a level (feeder metrics at CCC, CMO below region) gives its weight to the others in the same pillar.

## JSON format

```
{ generatedAt, logic, referenceDate, source,
  metrics: { <id>: { pillar, label, unit, direction, levels, datasets, formula, period, asOn, ageDays, maxAgeDays, minBase, flags, naReason?, unmapped } },
  flags: { <flag>: explanation }, checks: { <id>: [ … ] }, errors: { },
  offices: { <code>: { level, name, parent, region?, division?,
    metrics: { <id>: { value, numerator, denominator, asOn, quality: { status, flags?, reason? }, inputs?, ownLevel?, target?, targetInputs? } } } } }
```

- `value` is in the metric's unit (%, days, per 10,000, …); `numerator` and `denominator` are the summed inputs behind it at that office (for a percentage, value = 100 × numerator ÷ denominator). `atc_loss_change_yoy` has no single ratio: its `inputs` hold the two AT&C values.
- `quality.status`: `ok`, `warn` (small base, low match coverage, replaced base), `stale`, `no_data`, `na` (level not available).
- `target` (AT&C and distribution loss) is the office's target loss from `loss_targets`.
- `unmapped` counts rows no office could be found for (one solar row today).
