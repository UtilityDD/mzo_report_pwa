# Offices: data quality findings

What the office check found in the mirrored data (1 November 2026) and what changed in the app. The canonical list and how to extend it are in [architecture.md](architecture.md#offices). The full issue list per dataset is in the mirror's `sys_quality_issues` (`office.*` checks) and in [data-quality.md](data-quality.md).

## The canonical list

52 offices in `lib/offices.js` (mirrored as `dim_offices`): Malda Zone, 3 regions, 7 divisions, 41 CCCs. `mzo_scope.js` lists the same 41 CCCs with the same codes. Every dataset with office columns now resolves to it; what does not resolve is listed below.

Aliases found in the data, all mapped:

| Kind | Spellings |
|---|---|
| Region / district | `MALDAH`, `MALDAH ` (trailing space), `Maldah`, `MALDA REGION`; `UTTAR DINAJPUR REGION`, `U/DINAJPUR REGION`, `U. DINAJPUR`, `UTTAR DINAJPUR REGIO`, `Raiganj (D) Region`, LGD `311`; `DINAJPUR DAKSHIN`, `DAKHSIN DINAJPUR`, `D. DINAJPUR`, `D/DINAJPUR REGION`, `DAKSHIN DINAJPUR REG`, LGD `310` |
| Division | `RAIGANJ (D) Division`, `RAIGUNJ`, `UTTARDINAJPUR (D) DIVISION`, `MALDA DIVISIOIN`, `MALDA (D) (O&M) DIVISION`, `GAZOL`, `ISLAMPUR Division`, plant codes `3342 3343 3432 3433 3434 3461 3462`, prefixes `6611`…`6632`; old **North Malda** / **South Malda** (each covers two of today's divisions) |
| CCC | `MATHURAPUR` (Manikchak, code 6611101), `MOKDAMPUR`, `BAISNABNAGAR`, `H.C. PUR`, `GAZOL`, `GAJOL`, `AIHO.`, `PANDUA-I`, `BAMANGOLA`, `KALIAGANJ`, `KARANDEGHI`, `GOALPOKHAR`, `KUMARGUNJ`, `KUSHMANDI`, `KUSHMUNDI`, `Golapgang`, `Sujpur`, `Pa` (Pandua, pending MC); suffixes ` CCC`, `CCC-6612102`, `(6612102)`, ` CUSTOMER CARE CENTER/CENTRE` |
| Code | `C3` + code + `0` (meter ERP, CAPEX), `66211010`/`66211020` (padded, ICDS), typos `66111609`, `66131101`, old cost centres `C333…`/`C334…` (costcenter.json), division and region office codes `66RD000`, `66R0000`, zone `6600000` |

Mathurapur is not a separate CCC: the weekly sheet writes code 6611101 with CCC name MATHURAPUR and lookup CCC Manikchak on every row, and the Loss and JJM sheets list MATHURAPUR where every other sheet has Manikchak.

## Fix in the source sheet

| Sheet | Rows | Problem | Fix |
|---|---|---|---|
| DD summary (`dd_summary`) | 977 | Office Code 6621101 (Itahar) with CCC and Division Islampur; 976 are exact copies of the 6622101 Islampur rows | Delete the pasted block |
| DD summary | 19 | Code 6612103 (Paranpur) with CCC Chanchal | Correct the code or the name |
| ICDS A+ | 14 | CCC CODE `662101040` (9 digits, not a code) | Enter the 7-digit CCC code |
| Solar | 1 | A date in DIVN_CODE / CCC CODE (`03-10-2026 03:02`) | Delete the stray row |
| PM Surya Ghar, Malda tab | 37 | Division Name does not contain the CCC (e.g. MALDA for Samsi, CHANCHAL for Rathbari) | Correct Division Name |
| PM Surya Ghar, all tabs | 9 + 5 | District from the wrong region (Uttar Dinajpur rows in the Dakshin Dinajpur tab); sub-divisions from other states (`DS S/D NO.3 ABOHAR`, `Dibrugarh-I`) | Correct or remove |
| REM OSD | 1 | Division BUNIADPUR for Patiram (Balurghat division) | Correct Division |
| Smart meter status | 10 | Division `MALDA` with CCC `MALDA` (not a CCC); 140 rows `MALDA DIVISIOIN` | Use the CCC name and the division's spelling |
| Defective meter details | 27,778 | Rows from the 23 Oct dump next to the 16 Oct summary, so Rathbari, Fulbari and Mokdumpur list fewer names than the summary counts (e.g. Rathbari over 10 years: 751 in the summary, 674 names) | Re-upload one dump so summary and details share a date |
| Substation upkeeping | 7 | No division | Fill Division |
| Accident reports | 1 | `GOPALGANJ CCC` (code C333421030 is Golapganj) | Spelling |

## Fixed in the app (before → after, same data)

Measured with each page loaded on a local app (writes blocked) and the canonical counts computed from the same CSV.

| Page | Before | After |
|---|---|---|
| Withheld NSC | Gazole listed as “Gazol” (4,856 applications) | Gazole; 41 canonical CCCs |
| Weekly report | “Gazol” (71 rows) | Gazole |
| JJM | “Mathurapur” (1 CCC) instead of Manikchak | Manikchak |
| CAPEX | Old cost centres counted under the old division: Malda 4,790 lines, Chanchal 2,545, Gazole 1,250; CCCs spelt Kaliaganj (1,884 lines), Goalpokhar (915), Bamangola (82), Gajol (2) | Malda 4,569, Chanchal 2,541, Gazole 1,475; one name per CCC (50 units, was 51) |
| CAPEX, Kaliyaganj CCC login | 0 lines, ₹0 | 1,884 lines, ₹1.15 Cr |
| O&M advance | Balurghat 807, Buniadpur 55, 13 orders “Unknown” division; Kushmandi, Bamangola | Balurghat 781, Buniadpur 84, Unknown 0 |
| Loss, CCC login for Kaliyaganj, Manikchak, Goalpokher or Kusmandi | Empty page (every figure “—”) | That CCC's row (Kaliyaganj: AT&C loss 18.83%) |
| PM Surya Ghar | “RAIGUNJ” as an eighth division (44 applications) | Raiganj (961 → 1,005) |
| All pages using `UI.office` / `MzoScope` names | Names only partly matched (“Malda” read as Old Malda, North/South Malda and Malda Zone as Malda division, Raiganj Div Total as Raiganj CCC); SAP and padded codes unread | Exact canonical matching |
| Safety inspections, Old Malda CCC login | 47 sites: its own 10 plus 37 Malda division-office inspections (“Malda” is part of “Old Malda”) | 10 |
| Meter utilization, Old Malda CCC login | 8,330 meters (2 Malda division store meters) | 8,328 |
| Collection, Malda division login | 9,892 rows, including Malda region's 574 bulk rows | 9,318 |
| Bharat Net / ICDS, Kaliachak CCC login (no rows there) | Every office: 52 applications / 4,167 centres | 0 / 0 (admin and a Bhaluka login unchanged: 52 / 4,167 and 8 / 19) |
| JJM, Manikchak CCC login on develop | All 44 CCCs (the sheet says Mathurapur) | 1 |
| Performance index, Balurghat region login | Regions named by district, so the login's own region was never highlighted | Malda / Raiganj / Balurghat; 1 highlighted; every score unchanged |
| `UI.csv` with a repeated header | The last column silently replaced the others (weekly “Division”, solar “APPL_NO”) | Kept as Division, Division_2…; Weekly reads Division_2 (the column it read before); stats and tables identical on 7 pages |

## Same metric on different pages

| Metric | Pages | Result |
|---|---|---|
| Pending NSC | NSC, Performance index, Ask | Same: 5,140, and the same per division (Malda 620, Chanchal 499, Gazole 737, Raiganj 1,420, Islampur 1,154, Balurghat 322, Buniadpur 388). Over 30 days: 3,482 on NSC (“More than 1 month”) and Ask |
| Pending NSC | Briefing | The Briefing shows NSC only when the upload meta has `delayed30` (local tool); production's meta has no NSC pending figure. Withheld on the Briefing is the count at the last upload, not the Withheld sheet today |
| Stock | Stock, Briefing | The Briefing has no stock figure |
| Disconnection | Page, Briefing | Same: 19,906; no action 9,478, disconnected 2,558, fully paid 7,372, partly paid 498 |
| Pending master card | Page, Briefing | Same on the Storage snapshot: 2,153, 90+ days 427, industrial 20 |
| Load extension over a year | Page 574, Briefing 569 | The sync script behind the Briefing counted more than 12 months, the page (where the Briefing links) 12 and more. The script now uses the page's rule (569 → 574; 6 months 620 → 631) from its next run |
| Defective meters | Summary, details | Summary totals match the Briefing (525,508 meters, 23,219 over 10 years); details differ for 3 CCCs (see above) |
| Collection / Loss office lists | Collection, Loss | Same 41 CCCs under the same names; Collection adds three region “bulk” rows (region office codes 6610000/6620000/6630000) |
