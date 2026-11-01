# Data quality

What is wrong in the data behind the reports, who should fix it, and how the mirror keeps checking it.

The checks live in `vm/quality/` and run on the VM after every successful sync of a dataset (the hook in `vm/sync/run.js`). Results go to two PocketBase collections that only signed-in portal users can read:

- `sys_quality_issues`: one row per dataset, check and column, with severity, count, up to 10 masked examples, a plain-language hint, `source_fix` (the fix belongs in the source sheet), `first_seen`, `last_seen` and `status` (`open` or `resolved`).
- `sys_quality_scores`: one row per dataset with its score (0–100), its open issue count and when it was checked.

The findings below use dq-offices' canonical office list (`lib/offices.js`) for the `office.unknown_*`, `code_name_mismatch`, `parent_mismatch`, `legacy_division` and `outside_zone` checks, as the integrated sync will. Without that list, `vm/quality` falls back to its own checks against `mzo_scope.js`; these report about 20 more office warnings, mostly spellings that `mzo_scope.js` does not know (a local test sync on that path stored 256 open issues and an average score of 94).

They come from a full read of every source on **2026-11-01 around 12:00 IST**: 109 datasets, about 1.2 million rows. A second full read at 12:41–12:55 IST gave the same results. Both reads used GET requests only, through the same published-CSV, gviz and PostgREST URLs that the mirror uses. Examples are masked: names show their first letter, phone, e-mail, PIN, bank, Aadhaar and PAN values are hidden, and consumer, application and meter numbers keep only their first two and last two characters. Row numbers are sheet rows (row 1 is the header), so they lead straight to the cell.

## Summary

The average score is 95. Forty-nine datasets score 100, and nine score below 80. The checks found 235 issues: 8 errors, 97 warnings and 130 notes. Most of the problems come from a few habits in the source sheets:

1. **Old data left in place.** Six reports have not been refreshed for months, and three mix rows from two different report dates.
2. **Copies that drifted apart.** Some applications are in both the Pending NSC list and the Withheld list. The Pending MC Google Sheet is newer than the copy the app reads. The Defective Meter details do not add up to the summary.
3. **Duplicates.** There are whole blocks pasted twice (Loss report, meter master), repeated IDs (highway crossings) and copied rows (safety inspections).
4. **Office names and codes that disagree.** In DD summary, 977 rows carry Itahar's code but the Islampur name. Some sheets have total rows inside the data, and two sheets use names that the app maps to the wrong office.
5. **Dates and numbers in mixed formats.** Some columns write dates both as ISO and as dd-mm-yyyy. Some cells use 1900/1912 placeholder dates, accounting-style "(0.37)" numbers, or coordinates without a decimal point.

### Scores

Datasets that are not listed here scored 100. Each row shows up to three of the heaviest errors and warnings; "×" is the number of rows or cells affected.

| Dataset | Rows | Score | Errors / warnings / notes | Top issues |
|---|---:|---:|---|---|
| `dd_summary` | 47,332 | 45 | 2 / 4 / 4 | office.code_name_mismatch (CCC) ×996; freshness.stale (Date of Visit, 291 days); number.text_in_numeric (OSD) ×1,414 |
| `solar_connections` | 6,827 | 56 | 1 / 11 / 8 | key.blank (SOLAR_APPL_NO) ×1; date.mixed_formats (COLL_DATE) ×3,336; date.mixed_formats (QUOTATION_ISSUE_DATE) ×3,325 |
| `weekly_report` | 2,911 | 59 | 1 / 1 / 2 | freshness.stale (last report 23/02/2026); header.duplicate (Division, columns B and AB) |
| `safety_inspection` | 6,137 | 62 | 1 / 2 / 1 | freshness.stale (last entry 25/03/2026); date.mixed_formats (Rectification done on) ×1,205; key.duplicate_row ×160 |
| `onm_advance` | 3,252 | 66 | 1 / 2 / 0 | freshness.stale (latest Creation Date 31/07/2025); value.sheet_error (Resp. CCtr, Description) ×8 |
| `defective_details` | 55,997 | 69 | 0 / 3 / 2 | freshness.mixed_as_on (REPORT_AS_ON) ×27,778; cross.report_date ×27,778; cross.total_mismatch ×539 |
| `historical_nsc` | 53,381 | 70 | 1 / 0 / 0 | freshness.stale (latest METER_INSTALL_DATE 08/03/2026) |
| `smart_meter_work_orders` | 17,863 | 70 | 1 / 0 / 0 | freshness.stale (as on 12/11/2025) |
| `capex_details` | 41,608 | 78 | 0 / 2 / 3 | freshness.mixed_as_on (Reporting Date) ×296; freshness.stale (28/09/2026) |
| `dtr_peak_load` | 91 | 84 | 0 / 3 / 0 | row.ghost ×3; key.duplicate_row ×2; freshness.stale (06/05/2026) |
| `pending_mc` | 2,153 | 85 | 0 / 2 / 4 | cross.snapshot_mismatch (Storage 28/10 vs sheet 30/10) ×488; date.mixed_formats (Meter Installation Date) ×56 |
| `rem_defaulters_ind_com` | 3,027 | 86 | 0 / 2 / 1 | date.too_old (DATE_OF_CO) ×26; header.blank (column V) |
| `pmsgy_malda` | 3,674 | 87 | 0 / 5 / 6 | value.geo_out_of_area (Latitude) ×69, (Longitude) ×68; office.parent_mismatch (Division Name) ×37 |
| `disconnection` | 19,906 | 88 | 0 / 1 / 6 | freshness.stale (latest paid/disconnection date 04/10/2026) |
| `loss_report` | 2,863 | 88 | 0 / 3 / 1 | key.duplicate_row ×560; row.total_row ×523; office.ambiguous_name (CCC: "MALDA REGION") ×45 |
| `pmsgy_uttar_dinajpur` | 1,665 | 88 | 0 / 4 / 5 | value.geo_out_of_area (Latitude) ×13, (Longitude) ×12; office.unknown_ccc (Sub-Division Name) ×3 |
| `puja_hourly_load_2025` | 14 | 88 | 0 / 9 / 0 | value.sheet_error (#DIV/0! in nine columns) ×2 each |
| `pmsgy_dakshin_dinajpur` | 1,075 | 89 | 0 / 4 / 4 | number.text_in_numeric (Module Quantity) ×10; office.parent_mismatch (District) ×6 |
| `icds_a_plus` | 630 | 91 | 0 / 1 / 11 | office.unknown_code (CCC CODE 662101040) ×14 |
| `substation_upkeeping` | 21 | 91 | 0 / 2 / 0 | office.blank (Division) ×7; number.negative ×1 |
| `accident_reports` | 1,631 | 92 | 0 / 3 / 2 | office.parent_mismatch (Division) ×15; office.outside_zone ×1,135 (note) |
| `dd_user_auth` | 65 | 92 | 0 / 2 / 0 | office.unknown_ccc (office) ×8; number.text_in_numeric (dd_view) ×7 |
| `highway_crossings` | 5,266 | 92 | 0 / 3 / 2 | key.duplicate (ID) ×245; value.geo_out_of_area (Lat) ×9; value.geo_out_of_area (Long) ×8 |
| `loss_targets` | 51 | 92 | 0 / 2 / 1 | row.total_row ×10; office.ambiguous_name ×1 |
| `icds_a` | 3,538 | 94 | 0 / 1 / 5 | date.mixed_formats (METER INSTALL DATE) ×27 |
| `important_unbilled_aug_2026` | 56 | 94 | 0 / 3 / 0 | value.sheet_error (#DIV/0!) ×6 in three columns |
| `powermap_v_lines` | 209 | 94 | 0 / 4 / 1 | value.geo_out_of_area (from/to lat/lng) ×6–11 |
| `costcenter` | 239 | 95 | 0 / 1 / 3 | office.unknown_code (Cost Cen_Code C366000100) ×1; office.outside_zone ×124 (note) |
| `meter_crm` | 10,843 | 95 | 0 / 1 / 4 | date.future (SERV_CONN_DATE 27/09/2027) ×1 |
| `powermap_v_substations` | 165 | 95 | 0 / 2 / 0 | value.geo_out_of_area (lat) ×24, (lng) ×9 |
| `smart_meter_status` | 9,541 | 95 | 0 / 1 / 4 | office.ambiguous_name (CCC Name "MALDA") ×10 |
| `withheld` | 66,589 | 95 | 0 / 1 / 3 | cross.overlap (APPL_NO also in Pending NSC) ×12 |
| `dd_visit` | 10,251 | 96 | 0 / 1 / 2 | date.too_old (DATE_OF_CO) ×147 |
| `manpower_staff` | 818 | 96 | 0 / 1 / 1 | value.sheet_error (Cost Center Name) ×6 |
| `nsc_pending` | 5,140 | 96 | 0 / 1 / 3 | date.mixed_formats (DS_FORM_DATE) ×7 |
| `portal_users` | 122 | 96 | 0 / 1 / 2 | cross.portal_unknown_office (an nsc_autho grant of 6622000) ×1 |
| `power_map_substations` | 98 | 96 | 0 / 1 / 1 | number.text_in_numeric (MVA "2x6.3") ×9 |
| `powermap_substations` | 263 | 96 | 0 / 2 / 0 | value.geo_out_of_area (lat) ×24, (lng) ×9 |
| `rem_osd` | 2,664 | 96 | 0 / 1 / 3 | office.parent_mismatch (Division) ×1 |
| `meter_master` | 282,303 | 97 | 0 / 1 / 0 | key.duplicate_row ×6,057 |
| `rem_defaulters_agri` | 5,519 | 97 | 0 / 1 / 0 | date.too_old (DATE_OF_CO) ×21 |
| `rem_defaulters_dom` | 8,027 | 97 | 0 / 1 / 0 | date.too_old (DATE_OF_CO) ×65 |
| `upcoming_dd` | 18,668 | 97 | 0 / 1 / 0 | date.too_old (DATE_OF_CO) ×47 |

Datasets that score 97–99 have notes (spelling variants, codes of division or region offices, outliers) or a single small warning. The 49 datasets that score 100 include Pending NSC follow-ups, the defective summary, docket calls, CMO grievances, feeder outage, DTR records, Bharat Net, JJM, the materials list, vendor map, the activity log and the Important-sheets unbilled reports.

### Headline findings

| # | Finding | Dataset | Count |
|---:|---|---|---:|
| 1 | Defective meter details mix two report dates: 28,215 rows are from 16/10/2026 and 27,778 from 23/10/2026, while the summary is all 16/10. Their totals disagree too: the >10-year count is 23,066 names against 23,219 counted (load 1–3 kW: 17,443 against 17,730). | `defective_details` | 27,778 rows; 539 meters |
| 2 | DD summary: 977 rows have Office Code 6621101 (Itahar CCC, Raiganj division) but say CCC = Islampur and Division = Islampur. 976 of them copy Islampur rows (6622101) under the wrong code, so they are a pasted duplicate block. Another 19 rows have 6612103 (Paranpur) but say Chanchal. | `dd_summary` | 996 |
| 3 | 12 applications are in both the Pending NSC list (as on 30/10) and the Withheld list (as on 29/10). One upload puts each application in only one of them, so one copy is from an older upload. | `withheld` | 12 |
| 4 | The Pending Master Card Google Sheet is newer (30/10, 2,147 rows) than its Supabase Storage copy that the app shows (28/10, 2,153 rows): 247 applications differ. "Sync sheet" was not run after the last paste. | `pending_mc` | 488 |
| 5 | Loss report: a block of 560 rows is an exact copy of earlier rows (every value the same, including MONTH and YEAR), and 523 total rows ("Raiganj Div Total", "MALDA REGION", "South Malda Div Total") sit inside the data. | `loss_report` | 560 + 523 |
| 6 | Six reports have not been refreshed for months: weekly deposit vs disposal (last 23/02/2026), DD summary (last visit 14/01/2026), safety inspections (last entry 25/03/2026), O&M advance (last creation 31/07/2025), smart meter work orders (as on 12/11/2025) and historical NSC (last install 08/03/2026). | several | 6 datasets |
| 7 | Meter master data has 6,057 rows that exactly copy an earlier row (rows 224,511–280,935 repeat rows from 223,375–273,567). Meter ERP has 103 meter serial numbers entered twice in a block (rows 230,238 onward repeat 219,460 onward). | `meter_master`, `meter_erp` | 6,057 + 103 |
| 8 | Solar connections: eight date columns hold two formats ("2024-01-10 00:00:00" and "24-01-2024 00:00"). COLL_DATE alone has 3,336 rows in the second format. Row 6267 is broken (a time in DIVN_CODE, "(null)" office, a 2027 creation date), and APPL_NO appears three times as a header (columns V, AE, AM). | `solar_connections` | 3,336 (max) |
| 9 | Highway crossings: 245 rows repeat an ID used by an earlier row (one ID appears 15 times). Some coordinates have lost their decimal point (Lat 25636413 instead of 25.636413, Long 88770708), and some lie outside the zone. | `highway_crossings` | 245 + 17 |
| 10 | Safety inspections: 160 rows are exact copies of an earlier row (usually the one above), and "Rectification done on" mixes dd/mm/yyyy (2,658) with dd-mm-yyyy (1,205). | `safety_inspection` | 160 + 1,205 |
| 11 | CAPEX details: 296 rows are left over from the 19/08/2026 report under the 28/09/2026 one, and 8,030 rows belong to cost centres of other zones (C3346…, C3343…). | `capex_details` | 296 + 8,030 |
| 12 | DD summary OSD is written in accounting style, so "(0.37)" means −0.37 (1,414 cells). Its Dis Date mixes yyyymmdd (559) with dd/mm/yyyy, and contains #NUM! (27), years such as 0204 or 8013 (8) and 12/12/1912 (5). | `dd_summary` | 1,414 |
| 13 | PM Surya Ghar (national portal export): latitude and longitude are swapped or junk (latitude 88.27, latitude 130, longitude 400) in 69 + 68 Malda rows. Rows from other DISCOMs also appear (sub-division "ABOHAR", Punjab; "Dibrugarh-I", Assam). | `pmsgy_*` | 69 / 68 |
| 14 | Placeholder connection dates (19121212, 19000504, 19010101) in DATE_OF_CO: 147 in DD visit, 65 + 26 + 21 in the REM defaulter lists, 47 in Upcoming DD. Connection-age figures built from them are wrong. | `dd_visit`, `rem_defaulters_*`, `upcoming_dd` | 306 |
| 15 | The stock Google Sheet1 fallback is six weeks old (9/17/2026, 3,541 rows including plants of other zones), while the Storage dump that the app reads is from 10/30/2026 (950 rows). The fallback is used only when Storage is down, but then it would show September stock. | `stock_snapshot` | note |

Also checked, with nothing to report: the stock dump against the materials list (all 950 rows have a known material once leading zeros are ignored), the allotments against the materials list, the Storage meta.json totals against the snapshots (disconnection: 19,906 consumers and total OSD; defective: 525,508 meters; pending MC; load extension), and the disconnection, defective and load-extension Storage copies against their Google sheets.

## 1. Fix in the source sheet (owner action list)

Each item names the sheet, the columns, and example rows. Fix the source; the mirror and the app pick it up on the next sync. "Row" is the sheet row number.

### Defective Meter (consumer dump → `reports/defective/summary.csv` and `details.csv`)

Sheet: [Defective meter workbook](https://docs.google.com/spreadsheets/d/1dMLSX2bZBqZMPooh7_CrniCjqgy4MijaFW62GKJJldA/edit) (published to Storage by **Sync sheet** on Defective Meter).

- **Details tab, `REPORT_AS_ON`:** 28,215 rows say 20261016 and 27,778 rows (the first in row 629) say 20261023. The summary tab is all 20261016. Publish summary and details again from one consumer dump.
- **Totals:** after that, the details flags (`over10`, `ph3`, `industrial`, `smart`, `load_gt6`, `load_3_6`, `load_1_3`) must add up to the summary columns. Today they differ by −153 (over10), −287 (load_1_3), −80 (load_3_6), −8 (ph3), −6 (load_gt6), −3 (industrial) and −2 (smart).
- **4 incomplete rows** in details (rows 6,308, 7,321, 8,072 and 8,891) have only 3 cells filled.

### DD summary

Sheet: [DD summary](https://docs.google.com/spreadsheets/d/e/2PACX-1vRawhIW9ICZmzuThsL5opfI40WY6upCg5kFzoFXi2UJPR-svO6_cByXy5Y3u_p-2La_tH8SxhFfl29B/pubhtml?gid=220026293&single=true).

- **`Office Code` vs `CCC` / `Division`:** 977 rows from row 23,647 have code 6621101 (Itahar) with CCC "Islampur", Division "Islampur". 976 of them are exact copies of Islampur rows coded 6622101 apart from the code, so this is a pasted duplicate block: delete it. Separately, 19 rows from row 324 have 6612103 (Paranpur) with CCC "Chanchal": correct the code or the name.
- **`OSD`:** 1,414 cells in accounting format, e.g. "(0.37)" in row 4,060 and "(120.00)" in row 4,133. Write −0.37 or format the column as a plain number.
- **`Dis Date`:** 559 cells as yyyymmdd from row 46,460 (e.g. 20231228), #NUM! in rows 41,678, 42,554, 42,652 and 24 more, impossible years in rows 5,038 (15/02/0204), 7,145, 7,682, 8,161 and 8,742 (31/01/8013), and 12/12/1912 in rows 4,275, 4,696, 41,751, 41,808 and 45,086. Use dd/mm/yyyy, and leave the cell blank when there is no date.
- **`Date of Visit`:** the latest visit is 14/01/2026. If the sheet is still in use, it needs the newer visits.
- `CCC` "Kushmandi" (2,442 rows) and "Bamongola" (1,000) are spelling variants of Kusmandi and Bamongola (the mirror maps them; the standard spelling avoids two spellings in exports).

### Pending Master Card

Sheet: [Pending MC (Google)](https://docs.google.com/spreadsheets/d/e/2PACX-1vQmOUW4jxUtEGWhPHaoNBsvpBcGzhHJZRUx_9mxFBp91sfg4yD8WIqIK_xv0vlFs2yP-Ljz09JW1U2c/pubhtml).

- **Press "Sync sheet"** on Pending Master Card: the sheet is as on 30/10/2026, but the Storage copy that the page reads is from 28/10/2026.
- `Meter Installation Date`: 56 cells as "04-Jul-15" (from row 110) among dd-mm-yyyy. Use one format.
- `COLL_DATE` "(null)" in 62 rows and `CON_ID` "(null)" in 7 (from row 409): an export placeholder; leave the cell empty.
- `DIVN` "MALDA DIVISIOIN" (315 rows, typo) and `SUPP_OFF` "GAZOL CCC" (47).

### Pending NSC and Withheld (NSC upload)

Sheets: [nsc_working](https://docs.google.com/spreadsheets/d/1QnmPKSAtwmW-m1-gn4qmZBWanx9_Vwbk63XhwyQBiKU/edit) and [Withheld Sheet1](https://docs.google.com/spreadsheets/d/12nS8GAQ1weIMWoEIeydcdKTKd-XwHNu9W07DKudGuOg/edit).

- **12 applications in both lists** (e.g. 60······14, 60······15, 40······63). Pending NSC is as on 30/10, Withheld as on 29/10: the last upload had no Withheld rows, so the Withheld sheet was kept. Upload a SAP file that contains both statuses, so both lists come from the same file.
- `SCN_WITHELD_DATE` "26/07/0201" in Withheld row 48,211: a mistyped year in SAP.
- `DS_FORM_DATE` in nsc_working mixes "5-Feb-25" (13 rows, from row 2,904) with dd/mm/yyyy (7 rows).

### Loss report

Sheet: [Loss report](https://docs.google.com/spreadsheets/d/e/2PACX-1vSYyqn0urGdbqXarhELRbSCeRvgUCSHID_1Z4E_kptBTR5u69R0HHX0Jk23n6KseriNct2q9XwXu04E/pubhtml) (Sheet1 and the Loss Targets tab).

- **560 rows between rows 567 and 1,132 repeat rows 3–565 exactly**, including MONTH and YEAR. Delete the copy.
- Total rows inside the data: "South Malda Div Total" (row 13), "North Malda Div Total" (row 24), "Raiganj Div Total" (row 31), "MALDA REGION", "MALDA ZONE", and 10 such rows in Loss Targets. loss.html expects them (it reads them by name), so keep them, but keep every name exactly as loss.html lists it. Old months use "South/North Malda Div Total", but the page reads "Malda/Gazole/Chanchal Div Total", so division totals for those months are missing.
- CCC names that differ from the office list: MOKDAMPUR, BAISNABNAGAR, KARANDEGHI, KUMARGUNJ, KUSHMUNDI, GOALPOKHAR, KALIAGANJ, H.C. PUR, and MATHURAPUR, a CCC that loss.html knows but `mzo_scope.js` does not (see section 3).

### Weekly deposit vs disposal

Sheet: [Weekly report](https://docs.google.com/spreadsheets/d/e/2PACX-1vSMuO-ddereEG6J2s2Bmqp-HXo85ky4S4R5Yt-0HdoNHHa5r8xOEK4MJ1Syhyqzjpm2lTI4sT85nR4N/pubhtml?gid=0&single=true).

- **Latest "Date of report in Current Week" is 23/02/2026**, 251 days old. Paste the new weeks, or retire the page.
- Header **"Division" appears twice** (column B holds the old names SOUTH/NORTH MALDA; column AB holds today's divisions). Rename column B to "Old division". The page happens to read AB only because it is the later column.

### Safety app inspections

Sheet: [Safety inspections](https://docs.google.com/spreadsheets/d/1A2fjKboWKnw10iaOs1wcXDrdg9jhhDGfzF9OagPjA5s/edit).

- **160 rows are copies of an earlier row**, usually the one above (rows 38, 61, 67, 72, 79, 91, 92, 96, …). Delete the copies.
- `Rectification done on`: 1,205 cells written dd-mm-yyyy (e.g. row 2: 21-04-2025) and 2,658 written dd/mm/yyyy. Use one format.
- The latest `Entered on` is 25/03/2026. Check that the safety app still writes to this sheet.

### O&M advance

Sheet: [O&M advance](https://docs.google.com/spreadsheets/d/e/2PACX-1vQPBYq0ZQpaAnu0Mp_qN5oGvklgIpjolyRPf3LfSojRaN-GBBBXKHslR9ue1DOv1432oP2PzYznUUmn/pubhtml?gid=512034300&single=true).

- The latest `Creation Date` is 31/07/2025. Paste the current report.
- `Resp. CCtr` and `Description` are #N/A in rows 1,045, 1,272, 1,276, 1,277, 1,322, 1,723, 2,250 and 2,760: the cost-centre lookup does not find the order's cost centre. Add it to the lookup range.

### CAPEX details

Sheet: [CAPEX](https://docs.google.com/spreadsheets/d/e/2PACX-1vQI2neSVbvMR4fF910Q0AWUcq02leP-sob8q4f9goT46hgLutCpxCjSL6y6X3s2vYBJRNN7WrFCjE0R/pubhtml?gid=439685010&single=true).

- **296 rows from row 41,314 are still dated 19.08.2026** under the 28.09.2026 report. Clear the old rows before pasting.
- 8,030 rows belong to other zones' cost centres (C334621020 ×1,070, C334323010 ×687, …). Filter the SAP export to Malda zone, or keep them if the page filters by plant (it does today).

### Solar connections

Sheet: [Solar](https://docs.google.com/spreadsheets/d/e/2PACX-1vR5Vnb9TxymVIcBZsUBWZ-21Frkn77O4IyNus3Zo42qPm09N6MlJ3E0Vh3tHywcMAiy2y0uRm5XfIdk/pubhtml?gid=0&single=true).

- **Row 6267 is broken:** DIVN_CODE holds "-03 03:02:41", CCC CODE holds "03-10-2026 03:02", SOLAR_APPL_NO is "(null)" and CREATION_DATE is 2027-01-01. A line break inside a cell split the record. Fix or delete the row.
- Eight date columns mix "2024-01-10 00:00:00" with "24-01-2024 00:00" (COLL_DATE 3,336 rows, QUOTATION_ISSUE_DATE / DUE_DATE 3,325, EM_DATE 522, CREATION_DATE 462, WORK_ORDER_DATE 159, INSP_DATE 39). Paste the export as plain values, or use one export.
- **APPL_NO appears three times** as a header (columns V, AE, AM). Rename them (e.g. APPL_NO_EM, APPL_NO_WO).
- 44 consumers appear twice (CON_ID), e.g. rows 12 and 8.

### Highway crossings

Sheet: [Line–highway crossings](https://docs.google.com/spreadsheets/d/e/2PACX-1vQTy_LCddlFuzZx9ZyJQTLbqrQ8sb76DG4jyw8ys-s_w6LDxOYhnTTY49eddhqxb9RnTAbksh32y1bH/pubhtml?gid=870376934&single=true).

- **`ID` repeats on 245 rows** (e.g. rows 6/5, 14/13, 18/15, 20/19). "RAI-HEM-5930-4250" is used 15 times. Give each crossing its own ID.
- **`Lat` / `Long` without a decimal point:** rows 3,278 (25636413), 3,327, 4,888, 1,630, 1,653, 340 and 1,635, and Long in rows 4,139 (88770708), 4,177, 4,739, 4,795, 2,291, 1,640 and 1,546. Swapped or wrong values: row 73 (Lat 88.18), row 3,045 (Lat 22.86) and rows 30, 31 and 19 (Long 87.0).

### PM Surya Ghar (Malda, Uttar Dinajpur, Dakshin Dinajpur tabs)

Sheet: [PMSGY workbook](https://docs.google.com/spreadsheets/d/e/2PACX-1vRcFPRu1ywimetADU-XYIZ_x3McWUhR5ZbPUIIySO6_V8VJTyU9Vhw8DD-1RBEPFj0q2pUFMvutYV30/pubhtml). This is the national-portal export; these are portal data errors to raise with the portal, or to correct in the copy.

- `Latitude` / `Longitude`: in Malda, 69 latitudes outside 24–27 °N (e.g. row 3,624: 88.27, longitude in the latitude column; row 3,361: 130) and 68 longitudes (row 3,597: 400; row 162: 92.86). 162 rows in Uttar Dinajpur have 0, 0.
- Rows of other DISCOMs: Sub-Division "DS S/D NO.3 ABOHAR" (Punjab, 3 rows in UD, 1 in Malda) and "Dibrugarh-I Electrical Sub-Division" (Assam).
- `Division Name` "MALDA" on Chanchal, Gazole and Samsi applications (37 rows in the Malda tab); `District` "Uttar Dinajpur" on Balurghat and Hili applications (6 rows in the DD tab).

### DD visit, Upcoming DD and the REM defaulter lists

Sheets: [DD visit consumers](https://docs.google.com/spreadsheets/d/e/2PACX-1vSCKEl95dh4kyG-QPJbFJ5x7U7yo7h5bJGuMewsMr2hjMAlCj7UWxqvL_a-2hdyQd-laI8BAX3hU5_T/pubhtml?gid=0&single=true), [Upcoming DD](https://docs.google.com/spreadsheets/d/1aUeVnSc-OmFqqrUdoZxv8v8659u52zlIWddnpJgU9Uk/edit#gid=487034861), [REM Dom / Agri](https://docs.google.com/spreadsheets/d/e/2PACX-1vRFk-wa_x-dsthFXNsWa9wRxWOQrMD-yEiucvA2FtJIbwnTiGqVs3OT_eXxqyAOBqvGSDRiG-Hr0hK1/pubhtml), [REM Ind/Com](https://docs.google.com/spreadsheets/d/e/2PACX-1vQOynlOrqc0iXUKYDgqh-tTjIgDA5WidJDcDhYM7MhfKIZzZ7iduFD2LN4fYRXmVvcLCz1X-OJfcmRx/pubhtml?gid=0&single=true).

- **`DATE_OF_CO` placeholder dates** 19121212, 19000503/04 and 19010101: DD visit 147 rows (from row 160), REM Dom 65, REM Ind/Com 26 (rows 525, 528 (19470630), 529, …), REM Agri 21 and Upcoming DD 47 (rows 49, 2,022, 2,063, …). These come from SAP. Ask for a blank date instead, or the pages show 100+-year-old connections.
- REM Ind/Com: column V has a value but no header. Add the header (RANK, as in the other two lists).

### ICDS connections (A and A+)

Sheet: [ICDS workbook](https://docs.google.com/spreadsheets/d/e/2PACX-1vRoJd2-uQ5XxKjJ8LO1kDPpN76DepB_COmXyIg8qtO7fA7DBU0cydL27t87tj7upjxoC_F7JSBdPkvJ/pubhtml).

- Headers with a trailing space: "CCC CODE ", "APPL_NO ", "METER INSTALL DATE ", "METER NUMBER ", "UPDATE DATE " (both tabs). Remove the spaces.
- `CCC CODE` 662101040 in 14 rows of A+ (from row 594) is a 9-digit code: probably 6621104 (Raiganj CCC) typed with extra digits.
- `METER INSTALL DATE` mixes 20260804 (71 cells in A) with 13.10.2026; in A+ "12.10.20256" (row 281) and "13.10.206" (row 285).
- A+ has 369 empty rows (from row 631) before row 1,000, which holds only a CCC code; 6 rows repeat an earlier row (e.g. 244 = 227).

### Smaller items

| Sheet | What to fix |
|---|---|
| [Meter master / ERP / CRM](https://docs.google.com/spreadsheets/d/e/2PACX-1vSmzya-jypjfu9nN5QWuRJ6sbIgrqQ7Wa1eAx6Wfoepft2UpNwBC4a_rd4uJ6VpLhNu7FnjDBa8mJxW/pubhtml) | Meter master: 6,057 rows between rows 224,511 and 280,935 copy earlier rows. Meter ERP: 103 `Serial Number`s repeat a block from row 219,460 at rows 230,238 onward. Meter CRM: `SERV_CONN_DATE` 2027-09-27 in row 6,862. |
| [Smart meter work orders](https://docs.google.com/spreadsheets/d/e/2PACX-1vSWjwUI4EUgEABlcggpdOS-WSPKY8my-5T0cLxT4h8tNz_IreQy6jUYKBnB5yc0n-fcs8FpVbwo6Qay/pubhtml?gid=958431052&single=true) | As on 12/11/2025 (the only `Date` cell); latest RECORD_DATE October 2025. Refresh. |
| [Smart meter utilization](https://docs.google.com/spreadsheets/d/e/2PACX-1vSWjwUI4EUgEABlcggpdOS-WSPKY8my-5T0cLxT4h8tNz_IreQy6jUYKBnB5yc0n-fcs8FpVbwo6Qay/pubhtml?gid=327926255&single=true) | `CCC Name` "MALDA" (10 rows from row 5,233): the app reads it as Old Malda; write "MALDA ZONE" or the CCC. "MALDA DIVISIOIN" (2,352 rows) is a typo. "GOALPOKHAR CCC" (428) differs from Goalpokher. Two headers have double spaces (columns C, F). |
| [Historical NSC](https://docs.google.com/spreadsheets/d/e/2PACX-1vT1VYUaMC92oZPb3f452Q2b5WJf3Zhm02JdVq2Hsykt-_ipAcIIYaFdgYm4qZdZ8heGcrDon5eQA7nk/pubhtml?gid=2021450441&single=true) | Latest METER_INSTALL_DATE 08/03/2026; dates are m/d/yy ("6/13/25 0:00"). Refresh, and use dd/mm/yyyy. |
| [DTR peak load](https://docs.google.com/spreadsheets/d/e/2PACX-1vRZPPnIF-T7wgii6J35a-3Wz7RC86Zq-eMSQud795CVJV-92Vy9oJjO6TDpjpgiLNAVPcVn6X_keILV/pubhtml?gid=1835924766&single=true) | Rows 11, 21 and 24 hold only zero loads (21 and 24 copy 11). Latest measurement 06/05/2026. |
| [Manpower staff](https://docs.google.com/spreadsheets/d/e/2PACX-1vRRXojudL5q-ln7pXOcbLaGsBqznppnvsINcp8xEFvpJUWRCiC7bjii9eZYSu0istzyM91m4yybd5g-/pubhtml?gid=2110628491&single=true) | `Cost Center Name` #N/A in rows 234, 450, 510, 569, 631 and 706 (cost centre missing from the lookup). |
| [Accident reports](https://docs.google.com/spreadsheets/d/e/2PACX-1vRrrGeyElvh8i8QzTl25Ej7_RJZ9FJ0jicG3tAhguLEvky178oKZ8-QADKcBceUQ5CFjn7hd9eECVJ6/pubhtml) | 1,135 rows of other zones (C333…, C334… codes); "MALDA (D) (O&M) DIVISION" on Aiho and Old Malda accidents (15, both Gazole); "Raiganj (D) Region" on Balurghat (3); "NORTH MALDA DIVISION" (31); "GOPALGANJ CCC" (1). |
| [Unbilled Aug-2026](https://docs.google.com/spreadsheets/d/1SazJY-ohGvhTji5zN-mfrCTbaEUvfvGGKh6XWlRn76s/edit#gid=903839015) and [Puja hourly load 2025](https://docs.google.com/spreadsheets/d/1lkQlOv4sWzSTIOKAkem-oJmEvA7RNTLT0w-tsKi-_kI/edit#gid=0) | #DIV/0! in columns K, N and Q (rows 38–43) and in nine columns (rows 9, 11). Wrap the formulas in IFERROR(…, ""). |
| [Substation upkeeping](https://docs.google.com/spreadsheets/d/e/2PACX-1vSHoWw-c-KCfsYrkQs67uWaKdag1WXVQobLkngEK-bvbky_LMF6RWg-BwgVYA-5f3RcR4u6rQA5XWhH/pubhtml?gid=422662764&single=true) | 7 form responses without a Division (rows 2–8); a score of −5 in row 15. |
| [REM OSD](https://docs.google.com/spreadsheets/d/18y_nHZngDDO13nlluN9qba7AfgDe5dKGGHnXRYUU-b8/edit) | Row 2,374: Patiram (6631105) under Division BUNIADPUR (Patiram is Balurghat). Region names "U. DINAJPUR" / "D. DINAJPUR" (1,300 rows) are not in `mzo_scope.js` aliases (the mirror maps them). |
| Disconnection tracker (Google sheet behind Storage) | The latest PAID/DISCON DATE in the 29/10 sync is 04/10/2026. Refresh the payment and disconnection columns before syncing. PAID DATE / PAID AMOUNT are #N/A for 12,036 unpaid consumers, which is the lookup's "not found"; the page reads it as unpaid, but =IFERROR(…, "") is cleaner. |
| Power Map substations (Supabase, Admin → Power Map) | `MVA` holds "2x6.3", "3x10", "1x6.3+1x10" (9 rows): the transformer layout, not a number. `Region` "TCL" (14 rows). |
| Portal users (Admin → User Management) | One user's `nsc_autho` is 6622000: the Islampur division office code, which matches no CCC rows. Use the CCC codes or the division. |
| [Stock Google Sheet1](https://docs.google.com/spreadsheets/d/1wDvPuAxNfdO9QzUaIUubg2JnkFM5ZleFNXQdi8s5uh0/edit) | Six weeks old (9/17/2026) and includes other zones' plants. It is only the fallback, so either refresh it with each stock upload or point the fallback at nothing. |

## 2. Fixed by the mirror normalisation (no action needed)

The mirror stores every value; these differences are smoothed out in the `ds_` collections and the canonical office fields, so the portal and the checks see one form:

- **Spaces:** leading and trailing spaces in cells are trimmed (e.g. "MALDAH " in ICDS, "Hili " in office columns). Header spaces, line breaks and a byte-order mark are cleaned ("CCC CODE " becomes `ccc_code`).
- **Empty rows and padding columns** are skipped (369 empty rows in ICDS A+, the empty columns of the disconnection sheet).
- **Headers:** repeated headers become `name_2`, `name_3` (APPL_NO in solar, Division in weekly); empty headers become `col_<letter>`; "id" becomes `id_2`. The original header is kept in `sys_datasets.columns`.
- **Numbers:** Indian and Western grouping commas are removed ("5,293.69" → 5293.69). A column is a number column only when 98 % of its cells are numbers; the other cells keep their exact text in a `<column>_raw` companion. Codes with leading zeros stay text.
- **Dates:** dd/mm/yyyy, dd.mm.yyyy, dd-mm-yyyy, yyyy-mm-dd, ISO and "1-Oct-2026" are read. The column's day/month order is detected (stock is m/d/yyyy), and date-only values are stored as UTC midnight. Values that do not parse go to `_raw`.
- **Offices** (dq-offices, `lib/offices.js`): every row with office columns gets `_region`, `_division`, `_ccc_code` and `_ccc`. Known variants are mapped: Gazol/GAJOL/GAZOL CCC → Gazole, Kushmandi/KUSHMUNDI → Kusmandi, MALDA DIVISIOIN → Malda, U/DINAJPUR, U. DINAJPUR and DINAJPUR DAKSHIN → the region, "… CUSTOMER CARE CENTER" → the CCC, SAP cost centres C366111050 → 6611105, and old plant codes (3342, 3432, …) → their division.
- **Repeated primary keys** are kept, with an occurrence suffix on the row key, so no row is lost (safety inspections, highway crossings).
- **Supabase values:** json columns stay objects, microsecond timestamps are cut to milliseconds, and PINs and codes stay text (leading zeros kept).

Not normalised on purpose (they are visible in the portal and listed above): "(null)", "-", "NA" and "#N/A" stay as text; a column with mixed day/month order is read with one order; total rows and duplicate rows stay rows.

## 3. App and page bugs (handed to dq-offices and the lead)

These were sent as `NOTE` lines in `agent-progress/dq-audit.log`.

1. **`MzoScope.cccNameOf()` matches substrings,** so aggregate names turn into CCCs. "Malda" or "MALDA REGION" in a CCC column resolves to **Old Malda**, and "Raiganj Div Total" to the Raiganj CCC (and the same for Islampur, Balurghat, Buniadpur, Chanchal and Gazole). A CCC-scoped user filtered with `filterRows` therefore also gets these total rows. It affects smart meter utilization (10 "MALDA" rows) and any page that runs `filterRows` over a sheet with total rows. loss.html avoids it with its own TREE.
2. **`MzoScope.matchRow()` returns true for a row with no office value at all,** so rows whose office cells are empty are shown to every scoped user (e.g. 7 substation-upkeeping responses without a Division).
3. **Mathurapur is a CCC in loss.html's TREE** (Malda division) and in the loss, loss-target, weekly and JJM sheets, but it is missing from `mzo_scope.js` `HIERARCHY` and `CODE_TO_CCC`. Either it is a real 10th Malda-division CCC, or the sheets should name its successor.
4. **Pages that read sheets with `UI.csv()` keep only the last of two same-named columns.** Weekly reads `Division` from column AB (correct only by luck of order). Solar reads `APPL_NO` from column AM. A header rename in the sheet would silently switch them.
5. **Defective Meter shows one "as on" date for a details list that mixes 16/10 and 23/10,** and its count cards (summary) and name lists (details) disagree by up to 287 meters per metric. The page should show the details' own date, or refuse a mixed publish (the pipeline can check that `REPORT_AS_ON` has one value).
6. **Pending MC shows the 28/10 Storage copy while the sheet is at 30/10.** There is no prompt that a newer sheet exists. The mirror's write-through refresh (phase 2) covers the "Sync sheet" button, but nothing detects a sheet that was pasted without syncing; the `cross.snapshot_mismatch` issue now does.
7. **The stock fallback (Google Sheet1, used when Storage is down) is six weeks old** and includes other zones' plants. A Storage outage would silently show September stock for every plant.
8. **DD summary rows with code 6621101 and name Islampur:** pages that filter by code count them under Itahar, and pages that filter by name count them under Islampur, so a by-code page and a by-name page give different Islampur and Itahar totals. dq-offices found that 976 of the 977 rows duplicate real Islampur rows, so the fix is in the sheet: delete the block.

## How the checks work

| Family | Checks | What it means |
|---|---|---|
| Office | `office.unknown_region`, `unknown_division`, `unknown_ccc`, `unknown_code`, `code_name_mismatch`, `parent_mismatch`, `legacy_division`, `outside_zone` (from dq-offices' enrichment when it runs); `office.ambiguous_name`, `variant_spelling`, `non_ccc_unit`, `blank` (always) | Office names and codes against `lib/offices.js` / `mzo_scope.js`, and against each other in the same row |
| Date | `date.unparseable`, `mixed_formats`, `mixed_order`, `future`, `too_old`, `excel_serial` | Date columns (by header or ≥ 50 % date values) |
| Number | `number.text_in_numeric`, `negative`, `placeholder`; `value.outlier`, `geo_out_of_area`, `geo_zero`, `sheet_error`, `whitespace` | Number columns (≥ 80 % numbers). Outliers use the robust z-score (median and MAD) on physical measures only (counts, loads, capacities, lengths, days), on a log scale for skewed columns, and also need more than 20 × the 95th percentile, so only typo-size values stand out. |
| Key | `key.duplicate`, `key.blank`, `key.duplicate_row`, `key.not_unique` | The declared primary key, keys from `lib/rules.js`, and key-like headers (APPL_NO, CON_ID, …) that are unique in 99 % of rows |
| Row | `row.blank`, `row.ghost`, `row.repeated_header`, `row.total_row` | Empty rows inside the data, rows with one real value where a normal row has several, the header pasted again, and Total / Div Total / Region rows |
| Header | `header.blank`, `duplicate`, `whitespace`, `drift` | Drift compares the source headers with the previous sync (renamed, added, removed) |
| Freshness | `freshness.stale`, `future`, `missing`, `mixed_as_on`, `as_on_behind` | The "as on" cell or column of each report (`lib/rules.js`) against the age it may reach |
| Cross-dataset | `cross.overlap`, `report_date`, `unknown_material`, `total_mismatch`, `snapshot_mismatch`, `meta_mismatch`, `portal_unknown_office` | Pending NSC vs Withheld; stock dump and allotments vs the materials list; defective summary vs details; each Storage snapshot vs its Google sheet; Storage meta.json totals vs the snapshot; portal users' office grants |

**Severity.** An `error` breaks a count or a key (a duplicate primary key, a code/name mismatch, a report more than three times past its age). A `warn` needs a fix in the source. An `info` is worth knowing but changes no figure.

**Score.** Each open issue takes off `10 + 20·share` points for an error, `3 + 7·share` for a warning and `0.5 + 0.5·share` for a note. Here, `share` is the share of the dataset's rows the issue touches, and 1 for header, freshness and cross-source totals. When one check fires in several columns, the worst counts in full and the others at a quarter. The score is `100 − penalties`, never below 0.

**Running it.**

```
node vm/quality/audit.js --sources [--only nsc_pending,withheld] [--out report.json]   # read the sources (GET only), no PocketBase
node vm/quality/audit.js --pb [--only …]                                                # the sync hook for every dataset (PB_* env)
```

`--sources` prints a score line per dataset and writes the full JSON report with `--out`. The hook needs no setup: after each successful sync, `run.js` calls `require('../quality').check(key, 'ds_' + key, ctx)`. It reads the dataset's raw snapshot, or the `ds_` records for sensitive datasets that have no snapshot. One pass keeps memory flat: the 282,000-row meter master runs in about 2 s with a peak of about 140 MB, and most datasets take well under a second. It writes the two collections, resolves issues that did not come back, and never fails the sync. When a source is unchanged, the hook only re-ages its stored report date, once a day, so a sheet that nobody updates still turns stale. That state, and the previous headers for `header.drift`, sit in `headers.json` under `MZO_QUALITY_STATE_DIR` (default: the service's cache directory, else `vm/quality/.state/`).

**Masking.** `vm/quality/lib/mask.js` masks every sample before it is stored: PIN, password and token columns, phone, e-mail, bank, PAN and Aadhaar values, and person names and addresses. Consumer, application and meter numbers keep their first two and last two characters. Office names, codes, dates and amounts stay readable, because the sheet owner needs them to find the row.
