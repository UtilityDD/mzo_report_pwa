# How India rates power distribution utilities: sources and exact rules

Reference for the office-level rating (`docs/rating/methodology.md`, `lib/rating.js`). Every weight, threshold and formula below was read from the document cited next to it. Anything I could not confirm from a primary document is listed in [section 13](#13-unconfirmed--conflicting) and is not used elsewhere in this file.

As of 1 November 2026.

Page references:
- "PDF p.N" is the page number inside the PDF file.
- "p.N" is the page number printed on the page.
- The REC reports FY25 and DUR FY25 are two-page spreads, so one PDF page carries two printed pages.

---

## 1. Summary

- **There is no separate "CEA rating" of DISCOMs.** The national ratings are Ministry of Power (MoP) frameworks:
  - **Integrated Rating (IR):** PFC is the nodal agency. Latest is the 14th IR, FY 2024-25.
  - **Consumer Service Rating of DISCOMs (CSRD):** REC is the nodal agency. Latest is the 5th edition, FY 2024-25.
  - **Distribution Utilities Ranking (DUR):** the MoP composite, run by REC. Latest is the 2nd edition, FY 2024-25.
- **CEA's part in these:**
  - A CEA Member (E&C) sits on the MoP Integrated Rating Committee.
  - The IR takes its billing and collection efficiency definitions from CEA circulars.
  - The DUR's system-metering and resource-adequacy parameters rest on CEA regulations and frameworks.
  - See [section 7](#7-cea-reliability-indices-loss-definitions-dt-failure-and-ceas-role).
- **IR (14th, FY25):**
  - 15 base metrics plus 9 disincentives, scored out of 100.
  - Pillars for DISCOMs: Financial Sustainability **75**, Performance Excellence **13**, External Environment **12**.
  - Grades A+ (≥85), A (65–85), B (50–65), B- (35–50), C (15–35), C- (<15). D is not a score band: it means the utility is under SMA-2, i.e. in loan default.
  - An ACS-ARR gap condition can override any grade, and there are red-card and regulatory-asset gates.
  - "Proportionate" scoring is linear between the two stated thresholds. I confirmed this by reproducing WBSEDCL's published 14th-IR marks to within 0.01–0.09 points ([section 3.10](#310-worked-check-wbsedcl-in-the-14th-ir)).
- **CSRD (all 5 editions, FY21–FY25), same MoP-approved methodology throughout:**
  - Operational Reliability **45**, Connection and Other Services **10**, Metering, Billing and Collection **35**, Fault Rectification and Grievance Redressal **10**.
  - 23 sub-parameters. Three of them can only subtract marks.
  - Grades A+ ≥90, A 80–90, B+ 70–80, B 60–70, C+ 50–60, C 40–50, D <40.
  - Note the band names: the middle grades are **B+ and C+, not B- and C-**.
  - No consumer survey is scored in any edition. A survey was announced in FY21 only as a future validation input.
- **DUR, the MoP composite (FY24 and FY25):**
  - Weights: IR score **35 %**, CSRD score **35 %**, RPO achievement **5 %**, communicable system metering **5 %**, demand-side response **5 %**, resource adequacy **15 %**.
  - Utilities are ranked within three peer categories. There are no letter grades.
- **For an office (CCC, division or region):** almost all of CSRD, the AT&C/billing/collection parts of IR, DT and feeder metering from DUR, and the WBERC Standards of Performance are applicable. The IR finance and external-environment metrics, RPO, resource adequacy, call-centre and regulation-alignment items are company-level only ([section 11](#11-office-applicability-of-every-parameter-found)).
- **WBSEDCL context:**

  | Framework | Result |
  |---|---|
  | 14th IR (FY25) | A, 65.39, rank 22 of 54 |
  | CSRD FY25 | B+, 76.8 |
  | DUR FY25 | 54.8, category rank 32 of 41 |

  WBSEDCL's weak CSRD pillar is Metering, Billing and Collection (C+). Its weak IR metrics are billing efficiency (84.6 %), days payable and quick ratio.
- **WBERC Standards of Performance:**
  - Notification No. 46/WBERC dated 31.05.2010, amended by 57/WBERC (2013), 61/WBERC (2014), 63/WBERC (2019) and 66/WBERC (2020).
  - They set the West Bengal timelines for new connections, fault restoration, voltage and meter complaints, plus a compensation of Rs 500 per day.
- **WBERC Terms and Conditions of Tariff Regulations, 2026 (82/WBERC):**
  - Schedule 8 gives the SAIFI, SAIDI and MAIFI formulas (interruptions above 5 minutes are sustained) and requires them monthly, separately for rural and urban.
  - Schedule 9 gives the AT&C formula.
  - Regulation 96.3 sets a network-availability norm of 98 %.

---

## 2. Key source documents (URLs; PDFs not committed)

Copies were downloaded to a scratch folder outside the repo and not committed. The SHA-256 prefix lets anyone check they have the same file.

| # | Document | Publisher | URL | Size (bytes) | SHA-256 (first 16) |
|---|---|---|---|---|---|
| 1 | 14th Annual Integrated Rating & Ranking of Power Distribution Utilities (FY 2024-25), 274 pages | MoP / PFC (Deloitte as consultant) | https://jmkresearch.com/wp-content/uploads/2026/03/14th_Annual_Integrated-Rating-and-Ranking-of-Power-Distribution_Utilities.pdf (third-party mirror of the PFC report; pfcindia.com timed out) | 7,420,818 | 20252dccec2865d6 |
| 2 | 13th Annual Integrated Rating & Ranking (FY 2023-24), 200 pages | MoP / PFC | https://jmkresearch.com/wp-content/uploads/2025/02/13th-Annual-Integrated-Rating-and-Ranking-of-Power-Distribution-Utilities-1.pdf (mirror) | 2,880,471 | a3e8c1c04b1ac7ba |
| 3 | CSRD FY 2024-25 (5th edition) | REC | https://recindia.com/uploads/files/co-usri-crsd-report-fy-24-25-dt2003226.pdf | 5,485,829 | b2fe1293a6a5c5b0 |
| 4 | CSRD FY 2023-24 (4th) | REC | https://recindia.com/uploads/files/co-usri-crsd-report-fy-23-24-dt240225.pdf | 22,009,869 | d43160d985cdc408 |
| 5 | CSRD FY 2022-23 (3rd) | REC | https://recindia.com/uploads/files/co-usri-crsd-report-fy-22-23-dt190124.pdf | 24,729,044 | f7e93ffe39e51c8e |
| 6 | CSRD FY 2021-22 (2nd) | REC | https://recindia.com/uploads/files/co-usri-crsd-report-fy-21-22-dt120423.pdf | 12,099,494 | 14fc1562a9de10cf |
| 7 | CSRD FY 2020-21 (1st), Part A | REC | https://recindia.com/uploads/files/CSRD-090922.pdf | 22,582,374 | 1b81ee94fe31e422 |
| 8 | CSRD FY 2020-21, Part B booklet | REC | https://recindia.com/uploads/files/CSRDPart-B-FY-2020-21-Booklet.pdf | 3,275,618 | 86b138f8016d4747 |
| 9 | Distribution Utilities Ranking (DUR) FY 2024-25 (2nd edition) | MoP / REC | https://recindia.com/uploads/files/co-usri-dur-report-fy-24-25-dt200326.pdf | 5,016,220 | ccc2039d2a47dc38 |
| 10 | DUR FY 2023-24 (1st edition) | MoP / REC | https://recindia.com/uploads/files/co-usri-dur-report-fy-23-24-dt240225.pdf | 24,257,011 | 7902488e3fdc01ca |
| 11 | Electricity (Rights of Consumers) Rules, 2020, G.S.R. 818(E), 31.12.2020 (Gazette copy) | MoP (copy hosted by MERC) | https://merc.gov.in/wp-content/uploads/2022/07/1.-Gazette_Electricity-Rights-of-Consumers-Rules-2020-1.pdf | 1,971,362 | afbe1c73b533a8b0 |
| 12 | Electricity (Rights of Consumers) Amendment Rules, 2022, G.S.R. 306(E), 20.04.2022 (Gazette copy) | MoP (copy hosted by MERC) | https://merc.gov.in/wp-content/uploads/2022/07/3.-Electricity_Rights_of_Consumers_Amendment_Rules_2022-1.pdf | 1,357,867 | a1442025a0f71d9e |
| 13 | Electricity (Rights of Consumers) Amendment Rules, 2024, G.S.R. 125(E) | MoP | No Gazette PDF reached. Text read at https://www.legitquest.com/act/electricity-rights-of-consumers-amendment-rules-2024/F72A. Corroborated by MERC Explanatory Memorandum https://merc.gov.in/wp-content/uploads/2024/05/EM-1st-Amendment-Supply-Code-Regulations-2024.pdf (PDF p.8–9) | 308,797 (the MERC memo) | d32e0d3213acab2a |
| 14 | WBERC (Standards of Performance of Licensees Relating to Consumer Services) Regulations, 2010, No. 46/WBERC, 31.05.2010 | WBERC | https://wberc.gov.in/sites/default/files/regulation%2046_0.pdf | 30,666,285 | 126c5dbb4529f9fa |
| 15 | First Amendment, No. 57/WBERC, 26.08.2013 | WBERC | https://wberc.gov.in/sites/default/files/Regulation%20no%2057%20wberc_0.PDF | 1,723,726 | fc9fb3caee40b2d9 |
| 16 | Second Amendment, No. 61/WBERC, 07.01.2014 | WBERC | https://wberc.gov.in/sites/default/files/61_WBERC%2007.01.2014_0.pdf | 474,786 | 7d936883d1657790 |
| 17 | Third Amendment, No. 63/WBERC, 14.11.2019 | WBERC | https://wberc.gov.in/sites/default/files/regu%2063_0.pdf | 1,491,519 | 3e76b6b70a483538 |
| 18 | Fourth Amendment, No. 66/WBERC, 20.02.2020 | WBERC | https://wberc.gov.in/sites/default/files/Regulation66_0.pdf | 22,169 | f11c5972444e2129 |
| 19 | WBERC (Terms and Conditions of Tariff) Regulations, 2026, No. 82/WBERC, 13.07.2026, in force 01.08.2026 | WBERC | https://wberc.gov.in/sites/default/files/Final%20WBERC%20Tariff%20Regulation%202026.pdf (Gazette version: https://wberc.gov.in/sites/default/files/WBERC_Tariff_Regulations_Gazette.pdf) | 1,488,737 | c38bbf75e08c4d90 |
| 20 | RDSS Guidelines, Version 7 (22.09.2023) | MoP (hosted on ipds.gov.in) | https://ipds.gov.in/webappdocs/RDSS_Docs/RDSS_Guidelines_dt_22_Sep_2023.pdf | 8,807,801 | a91462f59de5a6de |
| 21 | CEA Format 54: Reliability Indices (11 kV feeders), from the CEA Furnishing of Statistics, Returns and Information Regulations (Gazette Part III Sec 4) | CEA | http://web.archive.org/web/20140721230824/http://www.cea.nic.in:80/reports/regulation/furnishing_statistics_returns_inf/format%2054.pdf (archived 2014; cea.nic.in now 404) | 54,408 | 5194f1b0f8854de1 |

Index pages:
- REC CSRD list: https://recindia.com/consumer-service-rating-of-discoms
- WBERC current regulations: https://wberc.gov.in/regulations-under-the-electricity-act-2003

The REC "Distribution Utilities Ranking" page links its DUR files to a placeholder PDF. I found the DUR FY25 file by REC's file-naming pattern, and its cover and content confirm it is the DUR FY 2024-25 report.

---

## 3. PFC Annual Integrated Rating & Ranking (IR)

### 3.1 What it is

- **Who runs it:** "Ministry of Power (MoP), Govt. of India has formulated an Integrated Rating Methodology… PFC has been mandated by MoP to serve as the coordinating agency… executed annually… since 2012" (IR14 p.9, PDF p.24).
- **Who reviews it:** the Integrated Rating Committee constituted by MoP. Members:
  - Member (E&C), CEA
  - Director, NIPFP
  - Director (Commercial), PFC
  - Director (Projects), REC
  - Source: IR14 Acknowledgements, PDF p.10.
- **Coverage:**
  - 14th IR: ratings for 65 of 72 utilities (42 state DISCOMs, 12 private DISCOMs, 11 power departments) (IR14 p.9). CESC (Kolkata) did not participate.
  - 13th IR: 63 utilities.
- **Data sources:** annual accounts, tariff and true-up orders, RDSS plans and utility submissions (IR14 PDF p.10).

### 3.2 Structure (14th IR; the 13th is identical except as noted in 3.9)

"15 base rating metrics and 9 disincentives, culminating in a comprehensive score out of 100" (IR14 p.11, PDF p.26).

| Pillar | State and private DISCOMs | Power Departments |
|---|---|---|
| A. Financial Sustainability | 75 | 55 |
| B. Performance Excellence | 13 | 35 |
| C. External Environment | 12 | 10 |
| D. Specific Disincentives | down to −10 (plus uncapped red cards) | down to −5 |

### 3.3 Scoring conventions used in every table below

- **3-year weighted average.** Where marked "3yr", the metric is scored on a weighted average: 60 % FY(T), 25 % FY(T-1), 15 % FY(T-2).
- **"Proportionate"** means linear interpolation between the full-marks threshold and the zero-marks threshold. The report does not print a formula. Section 3.10 shows the linear reading reproduces published marks.
- **Absolute and trajectory split.** For ACS-ARR, billing efficiency and collection efficiency, the maximum is split into an *absolute* part and a *trajectory* part:
  - Trajectory marks go for a 1-year growth rate (AGR) better than 5 % and a 2-year CAGR better than 5 %.
  - Trajectory only counts when the latest value passes an eligibility floor.
  - Hitting the full-marks level outright gives full marks for the whole metric.
- **Cash-adjustment carve-out.** "If the Days Receivable of a utility are equal to or less than 60 days in a year, the negative cash adjustment arising out of increase in net trade receivables, if any, shall not be considered" for ACS-ARR, Leverage and DSCR (IR14 p.11).

### 3.4 Pillar A: Financial Sustainability (DISCOMs, 75)

Source: IR14 Annexure, Scoring Methodology, p.217–218 (PDF p.232–233).

| # | Parameter | Max | Scoring rule | Formula (IR14 Definitions p.229–230) |
|---|---|---|---|---|
| A1 | ACS-ARR gap (cash adjusted), Rs/kWh, 3yr | 35 | Gap ≤ −0.05 → 35 (full). Otherwise:<br>• Absolute (28): >−0.05 to 0.9 proportionate; >0.9 → 0.<br>• Trajectory (7), only if the latest gap ≤ 1.4: 1-yr AGR < −5 % → 3.5; 2-yr CAGR < −5 % → 3.5. | ACS = total pre-tax expenditure ÷ gross input energy. ARR = (revenue from operations + other income + tariff subsidy received + other subsidy received, excluding UDAY capital grants, + net opening receivables − net closing receivables) ÷ gross input energy |
| A2 | Days receivable | 3 | ≤60 days → 3; >60 to 120 proportionate; >120 → 0 | Net trade receivables (current + non-current, incl. electricity duty) × 365 ÷ revenue from operations (incl. ED); DPSC/LPSC receivables excluded |
| A3 | Days payable to GENCOs and TRANSCOs | 10 | ≤60 → 10; >60 to ≤75 → 8; >75 to ≤90 → 6; >90 → 0 (step, not proportionate) | (Power purchase liability + fuel liability + railway coal liability) × 365 ÷ (generation + power purchase + transmission and SLDC cost) |
| A4 | Adjusted quick ratio, 3yr | 10 | ≥1 → 10; <1 to 0.4 proportionate; <0.4 → 0 | (Current assets − inventories − net current tax assets − held-for-sale − current regulatory assets − prepaid and advances − receivables >3 months) ÷ current liabilities |
| A5 | DSCR (cash adjusted), 3yr | 10 | ≥1.1 → 10; <1.1 to 0.6 proportionate; <0.6 → 0 | Cash-adjusted EBITDA ÷ (interest and finance charges + current maturities of LT loans + interest accrued and due) |
| A6 | Debt to asset ratio | 7 | ≤0.80 → 7; >0.80 to <1.30 proportionate; ≥1.30 → 0 | Total outstanding loans ÷ (net fixed assets + CWIP + capital advances) |

### 3.5 Pillar B: Performance Excellence (DISCOMs, 13)

Source: IR14 p.218 (PDF p.233).

| # | Parameter | Max | Scoring rule | Formula |
|---|---|---|---|---|
| B1 | Distribution loss vs SERC-approved | 2 | Ratio actual ÷ approved: ≤1 → 2; >1 to 1.2 proportionate; >1.2 → 0 | (1 − billing efficiency) ÷ SERC-approved distribution loss for the year. The last available tariff order is used if none exists for the year |
| B2 | Billing efficiency, 3yr | 5 | ≥92 % → 5 (full). Otherwise:<br>• Absolute (4): <92 % to 82 % proportionate; <82 % → 0.<br>• Trajectory (1), only if the latest BE ≥ 80 %: AGR > 5 % → 0.5; 2-yr CAGR > 5 % → 0.5. | Net energy sold ÷ net input energy (CEA methodology; see 7.3). Open access and wheeling units excluded |
| B3 | Collection efficiency, 3yr | 5 | ≥99.5 % → 5 (full). Otherwise:<br>• Absolute (4): <99.5 % to 91 % proportionate; <91 % → 0.<br>• Trajectory (1), only if the latest CE ≥ 90 %: "If FY23 Collection Efficiency is ≥95 %, full marks for trajectory", else AGR > 5 % → 0.5 and CAGR > 5 % → 0.5. | (Adjusted revenue on subsidy-received basis + opening debtors − adjusted closing debtors) ÷ revenue from sale of energy (CEA methodology; see 7.3) |
| B4 | Corporate governance | 1 | Board with ≥⅓ independent directors → 1; 2 independent directors (statutory minimum) → 0.75 | n/a |

### 3.6 Pillar C: External Environment (DISCOMs, 12)

Source: IR14 p.218–219 (PDF p.233–234).

| # | Parameter | Max | Scoring rule | Formula |
|---|---|---|---|---|
| C1 | Subsidy realised (last 3 FYs) | 4 | ≥100 % → 4; >80 % to 100 % proportionate; <80 % → 0 | Subsidy received ÷ subsidy booked, 3-year aggregate |
| C2 | Loss takeover by State Government | 3 | Profitable before takeover → 3; ≥50 % of losses taken over → 3; >0 % to 50 % proportionate; 0 % → 0 | Loss taken over ÷ loss before takeover |
| C3 | Government dues (last 3 FYs) | 3 | 0 % → 3; >0 % to 50 % proportionate; >50 % → 0 | Government dues ÷ amount billed to government, 3-year aggregate |
| C4 | Tariff cycle timelines | 1 | Tariff order for T+1 issued by 31 March of T → 0.5; true-up for T-1 issued by 31 March of T → 0.5 | n/a |
| C5 | Auto pass-through of fuel costs | 1 | Fuel costs recovered at least quarterly → 1; otherwise 0 | n/a |

### 3.7 Pillar D: Specific Disincentives (negative marking)

Source: IR14 p.219–221 (PDF p.234–236).

- Cumulative cap of **−10** for all specific disincentives, except the red-card metrics.
- The **red-card metrics** are D1, D2 and D3. Their marks sit outside the −10 cap and make the utility ineligible for A+ and A.

| # | Disincentive | Max | Rule |
|---|---|---|---|
| D1 (red card) | Auditor's adverse opinion | −15 | Overall adverse opinion → −15. It continues if the utility submits provisional accounts and the last audited accounts had an adverse opinion |
| D2 (red card) | Availability of audited accounts | −15 (cap) | After 30 Sep of T+1 without audited accounts for T: −0.5 per month. Only provisional accounts by the rating date: −5 more. No audited accounts for T-1 and T-2: −5 per year (capped at −10). If audited accounts arrive before the rating date, this is not a red card and the normal −10 cap applies |
| D3 (red card) | Default to banks or FIs | −15 | Yearly disincentive: default in T −4, T-1 −3, T-2 −2. It is scaled by the number of lenders in default: 1 lender 25 %, 2 lenders 50 %, 3 or more 100 %. Default to PFC or REC in the last quarter of T+1: −4; if that default exceeds 5 % of the PFC/REC loan: −2. A loan to PFC or REC in SMA-2 (overdue 61 days or more), or SMA-2 with any lender after release, means a **direct downgrade to D** |
| D4 | Audit qualifications | −4 | Employee or statutory dues −1; non-adherence to Ind-AS −1; not a going concern −2 |
| D5 | Governance | −3 | No operational audit committee −1; no exclusive MD and Director Finance −1; no board-approved quarterly accounts −1 |
| D6 | Tariff cycle delays | −4.5 | −0.25 for every 2-month delay in each of: tariff petition for T+2 after 30 Nov of T+1; tariff order for T+1 after 31 Mar of T; true-up order for T-1 after 31 Mar of T |
| D7 | Tariff independent of subsidy | −1 | Regulator considers subsidy while setting tariffs → −1 |
| D8 | Uncovered revenue gap (current year) | −4 | <1 % of approved ARR → 0; 1 % → −1; >1 % to <4 % proportionate; ≥4 % → −4 |
| D9 | Regulatory assets | −5 | Must be liquidated over 7 years from the FY21 baseline, at 1/7 per year. Reduction ≥ target → 0; reduced but short of target → proportionate; no reduction from FY21 → −5 **and not eligible for A+, A or B** |

### 3.8 Grades and overriding conditions

Source: IR14 p.12 (PDF p.27). The 13th IR has the same table at p.16 (PDF p.30), with the gap thresholds written in paisa.

| Grade | Rating score | Extra ACS-ARR gap condition (DISCOMs only) | Definition |
|---|---|---|---|
| A+ | ≥ 85 | Gap ≤ Rs 0/kWh (surplus) | Exceptionally strong financial and operational performance |
| A | ≥ 65 and < 85 | Gap ≤ Rs 0.15/kWh | Very high … |
| B | ≥ 50 and < 65 | Gap ≤ Rs 0.50/kWh | High … |
| B- | ≥ 35 and < 50 | Gap < Rs 1.0/kWh | Moderate … |
| C | ≥ 15 and < 35 | Gap < Rs 1.25/kWh | Below average … |
| C- | < 15 | none | Low … |
| D | Utilities under SMA-2 (not a score band) | none | Very low … |

Overriding conditions (IR14 p.11):
1. Red card means not eligible for A+ or A.
2. An increase in the regulatory-asset balance means not eligible for A+, A or B.
3. The ACS-ARR gap condition above.
4. SMA-2 means grade D (section 3.7, D3).
5. Power departments are graded on score only.

In the 14th IR these overrides capped:
- TPSODL, for the ACS-ARR gap;
- TPDDL, BRPL and BYPL, for regulatory assets;
- APCPDCL, for a red card.

Source: IR14 p.2, PDF p.17.

**Performance trajectory label** (IR14 p.12):
- **Improving:** score up by 5 % or more on the previous IR.
- **Declining:** score down by 5 % or more.
- **Stable:** otherwise.

### 3.9 Power Departments variant and 13th → 14th changes

**Power Departments** (IR14 p.222–223, PDF p.237–238):

| Parameter | Max | Scoring rule |
|---|---|---|
| ACS-ARR gap | 55 | Absolute 44: >−0.05 to 1 proportionate. Trajectory 11 |
| Distribution loss ratio | 10 | Full at ≤1; zero at >1.3 |
| Billing efficiency | 10 | Full at ≥90 %. Absolute 8: 90 to 75 % proportionate. Trajectory 2 when BE ≥ 70 % |
| Collection efficiency | 10 | Full at ≥99.5 %. Absolute 8: 99.5 to 90 % proportionate. Trajectory 2 |
| Separated audited accounts | 5 | n/a |
| Subsidy realised | 6 | n/a |
| Tariff timelines | 2 | n/a |
| Fuel pass-through | 2 | n/a |

Disincentives for Power Departments are capped at −5.

**Changes in the 14th IR**, per IR14 p.11 and checked against the IR13 annex at p.161–166 (PDF p.175–180):

| Item | 13th IR | 14th IR |
|---|---|---|
| ACS-ARR cash adjustment | Gross trade receivables | Net trade receivables |
| Days payable | ≤45 → 10; ≤60 → 8; ≤75 → 6; >75 → 0 | ≤60 → 10; ≤75 → 8; ≤90 → 6; >90 → 0 |
| Leverage metric (7 marks) | Debt/EBITDA (cash adjusted): >0 to 5 → 7; >5 to 15 proportionate; >15 or <0 → 0; year-wise scores weighted 60/25/15 | Debt-to-asset ratio |

Everything else is identical between the two editions.

### 3.10 Worked check: WBSEDCL in the 14th IR

Source: IR14 p.144–145, PDF p.159–160. The table shows that the linear "proportionate" reading and the 3-year weighting reproduce the published marks.

| Metric | Input (as printed) | Computation | Computed | Published |
|---|---|---|---|---|
| Billing efficiency | FY25 84.63 %, FY24 83.75 %, FY23 83.28 % | 0.6×84.63 + 0.25×83.75 + 0.15×83.28 = 84.21 %; 4 × (84.21 − 82)/(92 − 82) + 0 trajectory | 0.88 | 0.88 / 5 |
| Collection efficiency | 97.87 / 98.94 / 99.15 % | Weighted 98.33 %; 4 × (98.33 − 91)/(99.5 − 91) = 3.45, + 1 trajectory (FY23 ≥ 95 %) | 4.45 | 4.45 / 5 |
| DSCR | Weighted 0.90 | 10 × (0.90 − 0.6)/(1.1 − 0.6) | 6.0 | 6.04 / 10 |
| ACS-ARR gap | Weighted 0.07 Rs/kWh | 28 × (0.9 − 0.07)/(0.9 + 0.05) = 24.5, + 7 trajectory | 31.5 | 31.37 / 35 |
| Distribution loss | 15.37 % actual vs 15.50 % approved | Ratio 0.99 ≤ 1 | 2 | 2.00 / 2 |
| Adjusted quick ratio | Weighted 0.27 | Below 0.4 | 0 | 0.00 / 10 |
| Days payable | 162 days | Above 90 | 0 | 0.00 / 10 |

The small differences come from the rounding of the printed inputs.

WBSEDCL totals:
- Pillars: Financial Sustainability 47.41, Performance Excellence 8.33, External Environment 11.14.
- Base score 66.89, less tariff-cycle-delay disincentive −1.50, gives **65.39, grade A**. The ACS-ARR condition for A is ≤0.15, and FY25 was −0.03.
- Rank 22 of 54. Previous editions: 13th IR 55.3 (B), 12th IR 46.9 (B-) (IR13 PDF p.34).
- FY25 AT&C loss 17.17 % (IR14 Appendix 1).

---

## 4. REC Consumer Service Rating of DISCOMs (CSRD), FY21–FY25

### 4.1 Editions and process

| Edition | FY | DISCOMs rated | Methodology note |
|---|---|---|---|
| 1st | 2020-21 | 60 of 70 approached (Part A p.25) | MoP-approved methodology. Grade scale in Part B p.6 |
| 2nd | 2021-22 | 58 | Same 4 pillars and marks. Grade scale and marking table printed p.46–48 (PDF p.48–50); Annexure E printed p.74–76 (PDF p.76–78) |
| 3rd | 2022-23 | 62 (Annex A total, printed p.63, PDF p.87) | Same. Grade scale p.58 (PDF p.82); marking table PDF p.83; Annex E PDF p.103–105 |
| 4th | 2023-24 | 66 of 73 | "The scoring methodology as approved by MoP for the first edition… was adopted for… FY 2021-22 and FY 2022-23 and has been retained for the CSRD FY 2023-24" (p.70, PDF p.80). Annex D p.89–93, Annex E p.94–97, Annex F p.98–100 |
| 5th | 2024-25 | 66 of 76 | "…has been retained for the CSRD FY 2024-25 edition" (printed p.56–57, PDF p.35). Marking table printed p.60–61 (PDF p.37); Annex E printed p.80–83 (PDF p.47–48); Annex F printed p.84–85 (PDF p.49) |

How the data is collected and checked:
- **Collection:** DISCOMs submit about 750 data points each on the RDSS portal, through a three-tier maker/reviewer/approver set-up. Most parameters are collected circle-wise (CSRD24 p.4).
- **Evidence and validation:** evidence is system reports, regulatory filings, SERC orders, or signed manual sheets. REC regional offices validate it.
- **Reliability cross-check:** hours of supply and interruption index are checked against feeder monitoring data:
  - RFMS in FY23;
  - NFMS/NPP in FY24;
  - NFMS in FY25. FY25 blends the two: 60 % NFMS and 40 % DISCOM figure (Annex F).
- **Quality of supply** is "not included as a parameter due to the unavailability of data" (CSRD24 p.72).

### 4.2 Pillars and grade bands

Source: CSRD24 p.72–74 (PDF p.82–84); CSRD25 PDF p.36–37.

| Pillar | Marks |
|---|---|
| 1. Operational Reliability | 45 |
| 2. Connection and Other Services | 10 |
| 3. Metering, Billing and Collection | 35 |
| 4. Fault Rectification and Grievance Redressal | 10 |
| **Total** | **100** |

**Grade bands.** These are identical in all five editions. FY24 and FY25 print the boundaries explicitly:

| A+ | A | B+ | B | C+ | C | D |
|---|---|---|---|---|---|---|
| S ≥ 90 | 90 > S ≥ 80 | 80 > S ≥ 70 | 70 > S ≥ 60 | 60 > S ≥ 50 | 50 > S ≥ 40 | S < 40 |

The band names are A+, A, B+, B, C+, C, D. They are **not** the IR names (B-, C-). This confirms the brief's "A+ >90 … D <40", with the lower boundary inclusive (≥90 is A+).

"Both absolute and relative marking approaches were adopted, with most of the sub-parameters evaluated on an absolute scale… where benchmarking data was unavailable, a relative scale was used" (CSRD24 p.73).

### 4.3 All 23 sub-parameters

The tables below are a verbatim restatement of CSRD24 Annex E (p.94–97, PDF p.104–107). Annex E is identical in CSRD25 (PDF p.47–48). Measurement methods are from Annex D (p.89–93) and Annex F (p.98–100).

"Relative" means: highest value among the DISCOMs rated gets full marks, lowest gets zero, the rest are proportionate.

**1. Operational Reliability (45)**

| # | Sub-parameter | Marks | Type | Scoring | Measurement |
|---|---|---|---|---|---|
| 1.1 | Hours of supply (rural, urban, industrial), hours/day | 34 | Absolute | **Rural** (A marks): >22 h full; <16 h zero; 16–22 proportionate.<br>**Urban** (B): =24 h full; <17 h zero; 17 ≤ HoS < 24 proportionate.<br>**Industrial** (4 marks): =24 h full; <23 h zero; 23 ≤ HoS < 24 proportionate.<br>A + B = 30, split by the share of rural and urban *consumers* (34 if no industrial consumers) | Average daily supply hours on 11 kV feeders by category. Higher-voltage, agricultural and standby feeders excluded. A mixed feeder is classed by its dominant consumer type, by number. Scheduled and unscheduled outages count; interruptions under 5 minutes are ignored. Not weighted by consumers or load |
| 1.2 | Interruption index (II), interruptions per feeder per year | 7 | Absolute | **Rural** (X): <60 full; >720 zero; 60–720 proportionate.<br>**Urban** (Y): <20 full; >420 zero; 20–420 proportionate.<br>**Industrial** (1): <10 full; >280 zero; 10–280 proportionate.<br>X + Y = 6, split by the share of rural and urban *feeders* (7 if no industrial feeders) | Total interruptions on all 11 kV feeders in a category in a year ÷ average number of feeders in that category. **Unscheduled outages only**; interruptions under 5 minutes ignored |
| 1.3 | DT failure rate, % | 4 | Absolute | ≤4 % full; >14 % zero; 4–14 % proportionate | 100 × DTs failed ÷ total DTs. Total DTs = average of the count at the start and end of the period. All voltage levels, **agricultural DTs excluded** |

**2. Connection and Other Services (10)**

| # | Sub-parameter | Marks | Type | Scoring | Measurement |
|---|---|---|---|---|---|
| 2.1 | SERC regulations aligned with industry best practice, 7 items | 0 (−2) | Absolute | All 7 aligned → 0; each non-aligned item → −2/7 | The 7 items and their benchmarks:<br>• connection release: <7 days metro, <15 days other municipal, <30 days rural<br>• meter testing: <30 days<br>• meter replacement: <24 h urban, <72 h rural<br>• no-dues certificate: <7 days<br>• compensation for SoP failures<br>• rooftop-solar feasibility: <20 days<br>• rooftop-solar connection: <30 days |
| 2.2 | Predetermined demand charges for connections up to 150 kW | 0 (−1) | Absolute | Yes → 0; No → −1 | SERC regulation |
| 2.3 | Applications processed through online portal (submission to approval), % | 2 | Relative | Highest full; lowest zero | 100 × connections released via online processing ÷ total connections released. A paper application counts as online if entered and processed online |
| 2.4 | Average deviation from SoP in time to provide a connection, % | 7 | Absolute | Within SoP → full; >20 % deviation → zero; 0–20 % proportionate. Marks are split by category: category full marks = connections in category ÷ total connections × 7 | X = Σ(connections released per month × average days) ÷ connections in year. Y = (X − SoP days) ÷ SoP days. A category is each consumer class with its own SoP timeline |
| 2.5 | Prosumers (net or gross metering) per lakh consumers | 1 | Relative | Highest full; lowest zero | Prosumers × 100,000 ÷ consumers at period end |

**3. Metering, Billing and Collection (35)**

| # | Sub-parameter | Marks | Type | Scoring | Measurement |
|---|---|---|---|---|---|
| 3.1 | Average days to replace defective meters, urban | 1 | Relative | Least days full; most days zero. Purely urban DISCOM: 3.1 gets 2 marks and 3.2 gets 0 | Σ(month's average days × meters replaced that month) ÷ total meters replaced |
| 3.2 | Average days to replace defective meters, rural | 1 | Relative | As 3.1 | As 3.1 |
| 3.3 | Bills generated on actual meter reading, % | 4 | Absolute | >95 % full; <65 % zero; 65–95 % proportionate | 100 × bills on actual readings from working meters ÷ all bills. Provisional, average, flat-rate, unmetered, faulty-meter and locked-premises bills don't count as actual. The denominator includes metered and unmetered |
| 3.4 | Bills generated by non-manual reading (smart, AMR, port/Bluetooth/IR handheld, OCR), % | 7 | Relative | Highest full; lowest zero | 100 × non-manual-read bills ÷ all bills |
| 3.5 | Billing frequency for domestic consumers as per regulations | 0 (−1) | Absolute | All monthly → 0; otherwise proportionate negative marks by the % of non-monthly billing | 100 × domestic consumers billed monthly ÷ domestic consumers |
| 3.6 | Bills generated for domestic consumers in a year | 3 | Absolute | All bills required by SoP generated → full; otherwise proportionate to the % generated | Bills generated ÷ bills required, where bills required = 12 × monthly-billed + 6 × bi-monthly + 4 × quarterly + others × their frequency |
| 3.7 | Consumers receiving billing updates on mobile, % | 3 | Absolute | All consumers → full; some → proportionate | 100 × consumers provisioned for SMS bill alerts ÷ consumers |
| 3.8 | Prepaid consumers, % | 8 | Relative | Highest full; lowest zero. FY22 differed: 4 marks for having ≥1 prepaid consumer, 4 relative | 100 × prepaid consumers ÷ consumers at period end |
| 3.9 | Tariff categories (incl. sub-categories and slabs), number | 2 | Relative | Fewest full; most zero | Count from tariff order |
| 3.10 | Consumers paying digitally, % | 6 | Relative | Highest full; lowest zero | 100 × digital or online payments (prepaid recharges included) ÷ bills generated |

**4. Fault Rectification and Grievance Redressal (10)**

| # | Sub-parameter | Marks | Type | Scoring | Measurement |
|---|---|---|---|---|---|
| 4.1 | 24x7 call centre on common code 1912 | 2 | Absolute | Three equal thirds:<br>(a) coverage, proportionate to % of consumers covered;<br>(b) modern features: ≥5 full, 4 half, <4 zero (IVRS, CTI, ACD, auto escalation, status alerts, closure verification, analytics, chatbots);<br>(c) complaint types: supply + commercial + safety full; two of them half; outages only zero | % consumers covered by the toll-free centre at period end |
| 4.2 | Average call waiting time, seconds | 1 | Absolute | <30 s full; >120 s or no call centre zero; otherwise proportionate | From call connection to start of conversation |
| 4.3 | Consumers receiving outage updates on mobile, % | 2 | Absolute | All consumers → full; otherwise proportionate by bands ≥75–<100, ≥50–<75, ≥25–<50, <25. The marks for each band are not printed (see 13) | 100 × consumers with mobile registered for outage alerts ÷ consumers |
| 4.4 | Deviation from specified time for complaint resolution through the call centre, rural and urban, % | 2 + 2 | Absolute | 100 % within the specified limit → full; >20 % deviation → zero; 0–20 % proportionate. Separately for rural and urban | (Average time to resolve all complaints, within and beyond SoP − SoP time) ÷ SoP time, by complaint category |
| 4.5 | Adequacy of grievance redressal mechanism | 1 (0.5 + 0.5) | Relative and absolute | Two-tier mechanism present → 0.5. CGRFs per lakh consumers relative → 0.5 | SERC regulations; CGRF count |

Pillar sums check:
- Operational Reliability 34 + 7 + 4 = 45.
- Connection and Other Services 2 + 7 + 1 = 10, plus up to −3 in negatives.
- Metering, Billing and Collection 1 + 1 + 4 + 7 + 3 + 3 + 8 + 2 + 6 = 35, plus up to −1.
- Fault Rectification and Grievance Redressal 2 + 1 + 2 + 4 + 1 = 10.

### 4.4 Negative marking in CSRD

Three sub-parameters carry 0 marks with a possible deduction:
- 2.1: up to −2.
- 2.2: −1.
- 3.5: up to −1.

The maximum is therefore still 100, and the minimum can fall below the positive sum. No other negatives exist in CSRD.

### 4.5 Consumer feedback

**Consumer feedback is not a scored input in any edition.**
- FY21: REC's CMD wrote "we aim to expand the ratings in the subsequent editions with a consumer survey to get insights into consumer perception" (CSRD21 Part A, PDF p.8).
- FY22: the Annex D data-source column says "In subsequent years, validation process to include inputs from consumer survey". This appears in Annex D, printed p.68–73 (PDF p.70–75). It applies to connection time, meter replacement, bills, SMS updates, call waiting and outage alerts, and it makes the survey a **validation** input, not a scored one.
- FY24 and FY25: Annex D lists only DISCOM data, evidence documents and FMS/NFMS validation. No survey appears.

### 4.6 Changes across editions (the only ones found)

- **Urban hours of supply:** proportionate band printed "17–23 hrs" in FY22, and "17 ≤ HoS < 24" from FY23.
- **Prepaid consumers (3.8):** FY22 gave half the 8 marks for having at least one prepaid consumer and half relative. FY23 onward it is fully relative.
- **Reliability validation source:** RFMS (FY23), NFMS/NPP (FY24), NFMS with a 60/40 blend (FY25).

### 4.7 WBSEDCL values, CSRD FY25 (calibration only)

Source: CSRD25 Annex B, PDF p.40–43. Grades from CSRD25 PDF p.10.

| Pillar | Grade | Values |
|---|---|---|
| Overall | B+ (76.8; FY24 76.7) | n/a |
| Operational Reliability | A+ | Hours of supply: rural 23.7, urban 23.8, industrial 23.8<br>Interruption index: rural 101.0, urban 42.6, industrial 80.6<br>DT failure 8.3 % |
| Connection and Other Services | A | Regulation alignment: 5 of 7<br>Predetermined charges: Yes<br>Online: 100 %<br>Deviation from SoP: −71 % (faster than SoP)<br>Prosumers: 16 per lakh |
| Metering, Billing and Collection | C+ | Meter replacement 55 days (rural and urban)<br>Actual-reading bills 92 %<br>Non-manual reading 2 %<br>Domestic billed monthly 1 %<br>Domestic bills generated 99 %<br>Mobile bill alerts 96 %<br>Prepaid 0 %<br>Tariff categories 124<br>Paying digitally 68 % |
| Fault Rectification and Grievance Redressal | A | 24x7 coverage 100 %<br>Call waiting 73.1 s<br>Outage alerts 100 %<br>Complaint deviation: rural −83 %, urban −76 %<br>Two-tier mechanism: Yes |

Earlier WBSEDCL grades:
- FY21: B+ (CSRD21 Part A p.25; Part B p.128).
- FY23: B+ (CSRD23 Annex A, printed p.63; one West Bengal DISCOM, in the B+ column).
- FY24: B+ (CSRD24 p.7, PDF p.17).

---

## 5. MoP Distribution Utilities Ranking (DUR): the composite

### 5.1 What it is

- **Purpose:** "Ministry has desired to develop a comprehensive benchmarking exercise building upon existing rankings/ratings" (DUR FY24 p.9).
- **Editions:**
  - 1st edition: FY 2023-24.
  - 2nd edition: FY 2024-25, released with CSRD FY25 in March 2026. The REC files are dated 20.03.2026; the launch at the Bharat Electricity Summit is from PIB and secondary reports.
- **Coverage:** 66 utilities in both years.
- **Peer categories:**
  - **41** "Distribution Utilities", excluding urban and special-category state utilities. WBSEDCL is in this group.
  - **15** Special Category State utilities.
  - **10** Urban utilities. IPCL (West Bengal) is in this group.
  - Source: DUR FY24 p.13–14; DUR FY25 printed p.10–11 (PDF p.7).
- **Ranking:** within category and overall. There are no letter grades.
- **Score slabs:** DUR FY25 groups combined scores as "Concern areas" 0–40, "Scope for improvement" >40–75 and "Top performing" >75–100 (DUR25 PDF p.14).

### 5.2 Parameters and weights

The weights are the same in both editions. Sources: DUR FY24 p.15–19 and table p.21; DUR FY25 printed p.16–21 (PDF p.10–12) and Table 4 (PDF p.9).

| # | Parameter | Weight | Scoring |
|---|---|---|---|
| 1 | IR score (absolute score from the IR edition of the same FY) | 35 % | Not rated in IR → 0 |
| 2 | CSRD score (absolute score from the CSRD edition of the same FY) | 35 % | Not rated in CSRD → 0 |
| 3 | RPO achievement vs MoP source-wise targets | 5 % | Each component scored by achievement vs target: <75 % → 0; ≥75 % and <100 % → half; ≥100 % → full. Components are equally weighted.<br>FY24: 4 components (wind, hydro, other, total), slabs 0 / 12.5 / 25. FY24 targets: wind 1.60 %, HPO 0.66 %, other 24.81 %, total 27.08 %.<br>FY25: 5 components (adds distributed RE), slabs 0 / 10 / 20. FY25 targets: wind 0.67 %, hydro 0.38 %, distributed 1.50 %, other 27.36 %, total 29.91 %.<br>From the next edition, RCO targets (MoP notification of 27.09.2025) replace RPO |
| 4 | Communicable system metering | 5 % | Two sub-parameters, 50 each:<br>• DTs with communicable and functional meter ÷ total DTs: <75 % → 0; ≥75 % and <100 % → 25; 100 % → 50<br>• 11 kV feeders with communicable and functional meter ÷ total 11 kV feeders: same slabs<br>Cut-off date: 31.12.2024 (FY24), 31.12.2025 (FY25) |
| 5 | Demand side response (ToD) | 5 % | (1) ToD applicability, 50 marks:<br>• applicable to the categories → 30<br>• peak tariff ≥ 1.2 × normal → 10<br>• solar-hours tariff ≥ 20 % below normal → 10<br>FY24 covered C&I consumers with MD ≥ 10 kW only; FY25 covers all categories except agriculture.<br>(2) % of consumers with ToD meters × 50 |
| 6 | Resource adequacy | 15 % | (1) RA plan, 50 marks:<br>• plan prepared → 25<br>• contracting plan prepared → 15<br>• contracting plan SERC-approved → 10<br>(2) Arrangement % as per contracting plan × 50, averaged across sources |

Combined score = weighted average of the six parameters, each on 0–100.

### 5.3 WBSEDCL

| Edition | IR | CSRD | RPO | Metering | DSR | RA | Combined | Category rank |
|---|---|---|---|---|---|---|---|---|
| FY24 (DUR24 p.22) | 55.3 | 76.7 | 50.0 | 0.0 | 70.5 | 0.0 | 52.2 | 32 of 41 (overall 46) |
| FY25 (DUR25 PDF p.9) | 65.4 | 76.8 | 0.0 | 50.0 | 50.4 | 0.0 | 54.8 | 32 of 41, unchanged (overall 51) |

### 5.4 "IR 35 % + CSRD 35 % + other parameters": confirmation

The brief describes the newer composite as combining IR at 35 % and CSRD at 35 % with other parameters. That is the DUR, and the other 30 % is RPO 5 + CSM 5 + DSR 5 + RA 15. This is confirmed from both primary DUR reports. Secondary reporting (Powerline, 05.05.2026) describes the same split.

---

## 6. RDSS: national targets and the Result Evaluation Matrix

Source: RDSS Guidelines Version 7, 22.09.2023, ipds.gov.in. Printed page = PDF page − 3.

**Targets:**
- Objectives, clause 2.1.1 (p.6, PDF p.9):
  - "Reduce the AT&C losses to pan-India levels of **12-15 %** by 2024-25."
  - "Reduce ACS-ARR gap to **zero** by 2024-25."
  - AT&C and ACS-ARR are "calculated by Power Finance Corporation as per the latest approved formula" (footnotes 2 and 3).
- Action-plan trajectories, clause 3.1.5.4 (p.12, PDF p.15):
  - "(xv) Collection efficiency trajectory should be worked out to achieve the national target of **at least 98 %**."
  - "(xvi) Billing efficiency trajectory should be worked out to achieve the national target of **at least 85 % – 90 %**."

**Division-level AT&C thresholds** (clause 3.2.2.2, p.13, PDF p.16). RDSS itself uses AT&C at **Electricity Division** level to pick priority areas:
- divisions of AMRUT cities with AT&C > 15 %;
- divisions with more than 50 % urban consumers and AT&C > 15 %;
- other divisions with AT&C > 25 %.

**Feeder metering:**
- "All feeders are to be metered with communicable & AMI/AMR meters… to enable energy accounting and calculation of SAIFI and SAIDI" (clause 3.2.2.7).
- All feeders to be integrated with NFMS (clause 3.2.2.8).

**Result Evaluation Matrix** (clause 4.12, p.21–23, PDF p.24–26). DISCOMs that pass the pre-qualifying criteria are scored on four categories:

| Category | Weight |
|---|---|
| A. Financial Sustainability | 60 (must stay at least 60) |
| B. Operational: outcomes of infrastructure works | 20 |
| C. Infrastructure works | 10 |
| D. Policy and structural reforms, capacity building, IT/OT | 10 |

Illustrative parameters with maximum marks inside each category. Category score = weight × Σscore ÷ Σmax.

| Category | Parameters (max marks) |
|---|---|
| A | ACS-ARR gap (25); AT&C loss (25); outstanding subsidy (15); government dues, receivable days (10); government offices on prepaid meters (10); creditor days (5); debtor days (5); unliquidated regulatory assets (5) |
| B | Hours of supply rural (20); hours of supply urban (20); accurate energy accounts % (20); **SAIFI** (20); data availability in NFMS/NPP % (20) |
| C | Consumer metering (10); DT metering (20); feeder metering (20); agricultural feeder separation (10); LT bare conductor to AB/UG cable (10); % consumers on prepaid smart meters (15); feeders available in NFMS (15) |
| D | SCADA (15); ERP (10); training (5); corporate governance (10); tariff reforms (15); subsidy delivery/DBT (15); consumer rights and grievance redressal (15); PPP (15) |

**REM scoring rule** (clause 4.12.8):
- "If the agreed milestone… is met or exceeded, full marks… If… underachievement… marks shall be proportionately reduced. If the parameter remains the same or deteriorates then no mark shall be given."
- Qualifying score ≥ 60 (clause 4.12.6).
- The matrix is DISCOM-specific and yearly. The table above is the illustrative one.

---

## 7. CEA: reliability indices, loss definitions, DT failure, and CEA's role

### 7.1 CEA's role in the national ratings (what the primaries say)

- **IR:** CEA's Member (E&C) is on the MoP Integrated Rating Committee that reviews draft ratings and utility representations (IR14 PDF p.10).
- **IR:** billing efficiency and collection efficiency follow "CEA Methodology with reference to circular no. CEA-GO-17(11)/1/2018/DP&R Div/408-530 dated 08.08.2018 and CEA-GO-13-25/1/2023-DPM Division/64 dated 08.12.2023" (IR14 p.229–230).
- **DUR:** the communicable system metering parameter rests on the CEA (Installation and Operation of Meters) (Amendment) Regulations, 2022 mandate for feeder and DT meters. Resource adequacy is assessed against the RA framework "notified by the Central Electricity Authority" (DUR25 printed p.19–21).
- **CSRD:** no CEA role is stated. Reliability data is validated against the National Feeder Monitoring System (FY25) or the National Power Portal (FY24).
- **No CEA rating or benchmarking methodology for DISCOMs was found.**
  - CEA issued "Guidelines for Benchmarking of O&M Norms for Distribution Utilities" (Feb 2025). It covers O&M cost norms for tariff, not performance rating. This is from secondary reporting (Powerline 03.02.2025); the PDF was not reached.
  - The user's "how CEA does distribution company rating" is best answered by the MoP/PFC/REC frameworks above.

### 7.2 Reliability indices (SAIFI, SAIDI, CAIDI, CAIFI, MAIFI)

**Definitions in national law.** Electricity (Rights of Consumers) Amendment Rules, 2022, G.S.R. 306(E), inserted into rule 2(1):
- **SAIDI:** "the average duration of the sustained interruptions per Consumer occurring during the reporting period".
- **SAIFI:** "the average frequency of the sustained interruptions per Consumer…".
- **CAIDI:** "the average interruption duration of the sustained interruptions for those who experienced interruptions…".
- **CAIFI:** "the average interruption frequency of the sustained interruptions for those who experienced interruptions…".
- **MAIFI:** "the average number of momentary interruptions per consumer…".

Each is "as specified by the State Commission" (Gazette p.3).

The same 2022 amendment added to rule 10:
- **10(3):** 24x7 supply in metros and cities with population of 100,000 and above, with the SERC to give a SAIFI and SAIDI trajectory for such cities.
- **10(4):** CAIDI, CAIFI and MAIFI are additional indicators; "in case the interruption time is not specified by the State Commission, **three minutes** shall be considered as interruption time" for these.
- **10(5):** the SERC to run an online mechanism for monitoring reliability indices.

The 2020 Rules, rule 10(1), already required the SERC to specify SAIDI, SAIFI and "the minimum outage time (in minutes)… for the calculation of SAIDI or SAIFI" (Gazette p.18).

**Computation in West Bengal**, the operative formula for WBSEDCL. WBERC Tariff Regulations 2026, Regulation 96 and Schedule 8 (p.169–170, 280–281):

| Index | Formula | Terms |
|---|---|---|
| SAIFI | Σᵢ (Aᵢ × Nᵢ) / Nₜ | Aᵢ = number of sustained interruptions (each **longer than 5 minutes**) on feeder i in the month |
| SAIDI | Σᵢ (Bᵢ × Nᵢ) / Nₜ | Bᵢ = total duration of all sustained interruptions on feeder i in the month |
| MAIFI | Σᵢ (Cᵢ × Nᵢ) / Nₜ | Cᵢ = momentary interruptions (each **≤ 5 minutes**) on feeder i |

Shared terms:
- Nᵢ = consumers on feeder i affected by each interruption.
- Nₜ = total consumers in the licensee's supply area.
- n = number of 11 kV feeders, **excluding feeders serving predominantly agricultural load**.

Reporting rules:
- Computed **monthly**, **rural and urban separately**.
- Published feeder-wise on the licensee's website and sent to WBERC monthly. The annual figure is built from the monthly data (Reg 96.1; Schedule 8 para 3).
- Data must come "directly from the feeder monitoring system through automatic remote meter reading… without manual intervention" (Reg 96.6).

Network availability:
- **Network availability = {1 − (SAIDI / 8760)} × 100**, so SAIDI here is in hours per year (Reg 96.2).
- The licensee "shall endeavour to maintain network availability of not less than **98.00 %**" (Reg 96.3).
  - Above 98.50 %: +0.05 % RoE for each 0.25 %, up to +0.25 %.
  - Below 98.00 %: −0.05 % RoE for each 0.25 %, down to −0.25 %.
  - Regulations 96.4 and 96.5. Start date to be notified by WBERC.
- 98 % availability corresponds to SAIDI ≤ 175.2 hours a year. This is my arithmetic, not a WBERC figure.

The tariff order may also set trajectories for distribution loss, SAIFI, SAIDI, AT&C loss and collection efficiency (Reg 6, p.37).

**Older WBERC reliability measure (energy not supplied).** WBERC SoP Regulation 9.7(vi), substituted by 57/WBERC (2013), p.5:

> Reliability of power supply = [100 − {B / (A + B)} × 100]
> A = input = (sale of power to consumers in MU) / (1 − distribution loss % × 0.01)
> B = loss due to interruption in MU = Σ{(input load kW at outage + input load kW at restoration) × 0.5 × (outage minutes / 60) × 10⁻⁶}

Rules that come with it:
- Only interruptions **beyond 15 minutes** are recorded.
- Interruptions are logged with a unique interruption reference number per feeder or DT.
- They are published weekly on the website and kept for at least 15 days (Annexure D format: feeder or DT, outage and restoration times, duration, area, input load at outage and at restoration).
- Reg 9.6: planned load-management interruptions "shall not be taken into consideration for evaluating the reliability of supply".

**CEA feeder reliability index (historical).** CEA Format 54, under the CEA Furnishing of Statistics, Returns and Information Regulations, monthly, for 11 kV feeders by town:

> Monthly Feeder Reliability Index (%) = [{feeders × minutes in month} − total outage feeder-minutes] × 100 / {feeders × minutes in month}

There is a cumulative version from 1 April. The available copy is the 2014 archive; I could not confirm whether it is current.

**CSRD measures** (section 4.3): hours of supply and interruption index (interruptions per feeder per year, unscheduled only, under 5 minutes ignored).

### 7.3 AT&C loss, billing efficiency, collection efficiency (CEA methodology)

I could not reach the CEA circulars themselves (cea.nic.in returns 404 for the old paths). The methodology is reproduced in two primary documents that cite it.

**IR14 Definitions (p.229–230):**
- **Billing efficiency** = net energy sold ÷ net input energy.
  - Net input energy = generation − auxiliary consumption + energy purchased (gross) − traded or inter-state sales − transmission losses.
  - Open access and wheeling units are excluded from both.
- **Collection efficiency** = (adjusted revenue from sale of energy on a subsidy-received basis + opening debtors − adjusted closing debtors) ÷ revenue from sale of energy (including subsidy booked, excluding traded energy).
  - Adjusted revenue = revenue including subsidy booked, less traded revenue, less subsidy booked, plus subsidy received against it (arrears included).
  - Debtors are taken without deducting provisions. Closing debtors add back write-offs.
  - Unbilled revenue is not treated as debtors and is not adjusted.

**WBERC Tariff Regulations 2026, Schedule 9 (p.282–283):**

> AT&C loss (%) = (Energy input − Energy realised) × 100 / Energy input
> Energy input = (EG − AC + EP − ET − EPP − EOC) − TL
> Energy realised = Energy billed × Collection efficiency
> Energy billed = ESC (energy sold to all consumers)
> Collection efficiency (%) = Adjusted revenue realised × 100 / Adjusted revenue billed
> Adjusted revenue billed = RSC + RSB − RT
> Adjusted revenue realised = RSC + RSR − RT + DO − DC

Terms:
- RSC = revenue from consumers, including meter rent and excluding subsidy booked.
- RSB = subsidy booked.
- RSR = subsidy received against subsidy booked.
- RT = traded revenue.
- DO = opening debtors.
- DC = closing debtors plus write-offs.
- Open access is excluded. Unbilled revenue is ignored.

Equivalently: AT&C = 1 − BE × CE.

**Distribution loss**, WBERC definition (Tariff Regs 2026, Reg 2(li)): energy input to the distribution system minus (energy sold + own consumption + open-access energy delivered, including normative wheeling loss).

### 7.4 DT failure rate

- **Primary definition found:** CSRD Annex D and F. DT failure rate = 100 × DTs failed ÷ total DTs, where total DTs is the average of the start and end counts. Agricultural DTs are excluded and all voltage levels are covered.
- **Benchmark:** full marks at ≤4 %, zero at >14 %.
- **CEA:** I found no primary CEA definition or target. The CEA "Guidelines for O&M of DTs" (2023) PDF is 404. A ~10 % national DT failure rate is attributed to CEA only in secondary news (Mercom, 2025).

---

## 8. Electricity (Rights of Consumers) Rules, 2020 and amendments: timelines and compensation

Sources:
- 2020 Rules: Gazette copy, G.S.R. 818(E), 31.12.2020; rule numbers and Gazette pages given in the table.
- 2022 amendment: G.S.R. 306(E).
- 2024 amendment: G.S.R. 125(E). Text from LegitQuest, corroborated by the MERC memorandum (PDF p.8–9).

| Item | Rule | Timeline or standard |
|---|---|---|
| New connection or modification of an existing connection (from a complete application) | 4(11) as substituted in 2024 | **≤ 3 days metropolitan areas, ≤ 7 days other municipal areas, ≤ 15 days rural areas; ≤ 30 days rural areas of hilly states and UTs** (Arunachal, HP, Manipur, Meghalaya, Mizoram, Nagaland, Sikkim, Tripura, Uttarakhand, J&K, Ladakh). Where mains extension or a new substation is needed: ≤ 90 days.<br>The original 2020 text was ≤ 7 metro / ≤ 15 other municipal / ≤ 30 rural (Gazette p.15) |
| Penalty for connection delay | 4(12) | "shall not exceed one thousand rupees for each day of default" |
| Predetermined connection charges | 4(13) | Up to 150 kW, fixed by load and category; no site inspection or estimate |
| Meter testing after a complaint | 5(7) | ≤ 30 days. The 2024 amendment adds a check meter within 5 days when the consumption complaint is disputed |
| Replacement of a defective, burnt or stolen meter | 5(13)(c) | ≤ 24 hours urban, ≤ 72 hours rural |
| Bill delivery | 6(2) | At least 10 days before the due date. Bill on actual reading every cycle |
| First bill after a new connection | 6(7), 6(8) | Within 2 billing cycles. If not received, within 7 days of a complaint |
| Provisional bills | 6(9) | No more than 2 a year |
| Late bill rebate | 6(10) | 2–5 % if delayed (≤ 60 days, as set by SERC) |
| No-dues certificate | 6(12) | ≤ 7 days from final payment |
| Online payment | 7(2) | Mandatory for bills above Rs 1,000 (or as SERC specifies) |
| Security refund on permanent disconnection | 9(1)(b) | ≤ 7 days |
| Reconnection after paying dues | 9(2) | ≤ 6 working hours |
| Reliability | 10(1)–(5) | 24x7 supply; SERC to specify SAIDI, SAIFI and the minimum outage time; trajectory for cities ≥ 100,000; CAIDI, CAIFI and MAIFI with a 3-minute default (section 7.2) |
| Temporary connection | 10(7), added 2022 | ≤ 48 hours; ≤ 7 days if augmentation is needed |
| Rooftop solar | 11(7)–(9) | 2020 text: feasibility ≤ 20 days; commissioning ≤ 30 days from the installation certificate. 2024 amendment: feasibility ≤ 15 days (deemed feasible if no reply); commissioning ≤ 15 days |
| Standards of performance and compensation | 12, 13 | SERC sets standards and compensation amounts. Automatic compensation where remotely monitorable. The list includes: no supply beyond a set duration; interruptions beyond limits; connection, disconnection, reconnection and shifting times; category or load change; consumer-details change; **meter replacement time**; bill service time; voltage complaints; bill complaints |
| Call centre | 14 | Centralised 24x7 toll-free centre; CRM with auto-escalation |
| CGRF decision | 15(2) | Normally 30 days, never more than 45 days |

---

## 9. WBERC Standards of Performance for West Bengal licensees (applies to WBSEDCL)

**Regulation:**
- WBERC (Standards of Performance of Licensees Relating to Consumer Services) Regulations, 2010, Notification **No. 46/WBERC dated 31.05.2010**, Kolkata Gazette Extraordinary 31.05.2010.
- Amended by:
  - No. 57/WBERC, 26.08.2013 (first);
  - No. 61/WBERC, 07.01.2014 (second);
  - No. 63/WBERC, 14.11.2019 (third: online application system, self-certification);
  - No. 66/WBERC, 20.02.2020 (fourth: nil earnest money, online applications).
- The 2019 and 2020 amendments change no timeline.
- The WBERC list of current regulations (checked 01.11.2026) shows no later SoP amendment. In particular, there is none adopting the 2024 Rules' 3/7/15-day connection timelines (see 13).
- Supply Code 2013 (55/WBERC) and its 2026 first amendment (83/WBERC, 21.09.2026) deal with assessment orders. They set no SoP timelines.

### 9.1 Quotation and new connection

Sources: Reg 3.1.1, Reg 4 (p.4–6); 4.2 A–C substituted by 57/WBERC (p.2). All periods run from a complete application in the prescribed form (Annexure-B), with charges paid and formalities complete (Reg 13.8).

| Item | Timeline |
|---|---|
| Quotation, LV and MV | Rural ≤ 28 days; urban ≤ 14 days |
| Quotation, HV and EHV | 11 kV ≤ 30 days; 33 kV ≤ 45 days; 132 kV ≤ 60 days |
| **New connection where distributing main exists** (Reg 4.1) | **≤ 30 days** |
| LV/MV: augmentation, no additional pole | ≤ 60 days (2010: 40) |
| LV/MV: augmentation and/or UG cable up to 100 m | ≤ 60 days (2010: 45) |
| LV/MV: augmentation and/or OH line with additional poles | ≤ 90 days (2010: 60) |
| LV/MV: augmentation and/or UG cable above 100 m | ≤ 90 days |
| HV and EHV supply | ≤ 180 days |
| OH line through paddy land | May extend to 180 days (57/WBERC) |
| New transformer or bay in an existing substation | Distribution substation ≤ 90 days; 33/11 kV ≤ 150 days; 132/33 kV ≤ 270 days (Reg 4.3) |
| Alteration of service | Within premises ≤ 30 days; other ≤ 90 days (Reg 6) |
| Removal of installation on discontinuation | ≤ 7 working days (Reg 12.1) |

### 9.2 Restoration of supply after an unplanned interruption

Source: Reg 9.1 (p.12–13). Time runs from receipt of the complaint. It excludes natural calamities, grid failure, UF tripping and force majeure.

| Fault | Urban | Rural |
|---|---|---|
| (a) Licensee's fuse failure | 3 h | 8 h monsoon (Jun–Sep); 6 h Oct–May |
| (b) Snapping of LT wires | 4 h | 16 h monsoon; 10 h Oct–May |
| (c) Trees on OH line, no pole broken (LT and HT) | 8 h | 24 h |
| (d) LT short circuit, underground cable | 6 h | not specified |
| (d) LT short circuit, overhead line | 3 h | 4 h |
| (e) 11 kV OH breakdown, no pole replacement | 6 h | 18 h |
| (e) 11 kV OH breakdown, pole replacement | 12 h | 24 h |
| (f) HT underground cable fault | 4 h with ring main; 24 h without | same |
| (g) Distribution transformer failure | 12 h | 48 h |
| (h) LT line breakdown, other causes | 6 h | 24 h |
| (i) Service line failure | OH 4 h; UG 12 h | OH 18 h; UG 24 h |

Conditions:
- Theft: the clock starts after FIR and police inspection (9.2).
- Other departments' clearance needed: +12 h (9.3).
- Rural complaints after 8 pm: work starts by 6 am (9.4).
- Rail, highway or P&T crossing permission: the clock starts at permission (9.5).
- Planned outages over 6 h need 3 days' notice (9.6).

### 9.3 Voltage complaints

Source: Reg 10 (p.15).
- Persistent under or over voltage: corrected ≤ 15 days if local; ≤ 6 months if augmentation or re-routing is needed.
- Voltage fluctuations: urban ≤ 4 days; rural ≤ 8 days.

### 9.4 Meter complaints

Source: Reg 11, with 11.1 and 11.3.2 substituted by 57/WBERC (p.6).

| Case | Urban | Rural |
|---|---|---|
| Faulty or burnt meter, **supply not affected** (11.1) | Inspect ≤ 3 working days. Burnt: replace ≤ 7 working days from inspection. Otherwise faulty: test and replace or rectify ≤ 20 days from inspection | Inspect ≤ 7 working days. Burnt: replace ≤ 15 working days. Faulty: ≤ 30 days |
| Faulty or burnt meter, **supply affected** (11.2) | ≤ 24 hours from complaint or detection | ≤ 48 hours |
| Seal broken, no tampering: reseal (11.3.1) | ≤ 24 hours | ≤ 24 hours |
| Seal broken: meter replacement (11.3.2) | ≤ 10 days | ≤ 10 days |

If the consumer caused the defect or tampered with the meter, the clock starts after the cost is deposited (11.4).

### 9.5 Other

- Change of tariff scheme or reduction of load: from the next billing cycle, or the second next if the gap is under 7 working days (Reg 12.2, 12.3).
- Complaint registration: a docket number with time for every complaint, through ZRC, CCC and CRC centres (Reg 8).
- Every written SoP complaint must be acknowledged with a complaint number within 7 working days (Reg 14.1, 57/WBERC).

### 9.6 Compensation

Source: Reg 15.0 substituted by 57/WBERC (p.7–8), with 15.0(e) substituted by 61/WBERC (p.2).

| Failure | Compensation |
|---|---|
| Missing the time limits of Regs 3.0, 4.0, 5.0, 6.0, 9.0 and 12.1 (quotation, connection, load extension, alteration, restoration, removal) | **Rs 500 for each additional day** of delay or part of a day |
| Other standards (Regs 7.0, 10.0, 11.0, 12.2, 12.3) | **Rs 500 per additional slab** of time, urban or rural |
| Delay in reconnection | Rs 500 per day |
| Wrongful disconnection | HT industrial and commercial: Rs 5,000 + reconnection charges + Rs 500/day.<br>LT industrial and commercial: Rs 3,000 + charges + Rs 500/day.<br>Others: Rs 1,000 + charges + Rs 500/day.<br>Payable within 15 days of the GRO order |

How compensation is decided and paid:
- Payable compensation is the consumer's actual loss, capped at the maximum rates above. It is never less than 20 % of the computed maximum per day.
- The penalty under section 43(3) is the difference between Rs 500 per day and the compensation paid, and goes to a WBERC penalty fund (61/WBERC).
- GROs, the CGRO and the Ombudsman decide compensation (Reg 13.19, 61/WBERC).
- Claims must be made within 90 days (15.1).
- No liability for right-of-way, land acquisition or transmission-capacity delays that are properly intimated (15.3), or for areas where substation land is unavailable, after Commission approval (15.4).

---

## 10. Grade bands side by side

| Framework | Bands | Source |
|---|---|---|
| IR (PFC), DISCOMs | A+ ≥85 (and gap ≤ 0); A 65–<85 (≤ 0.15); B 50–<65 (≤ 0.50); B- 35–<50 (< 1.0); C 15–<35 (< 1.25); C- < 15; D = SMA-2 default (not a score band). Gates: red card means no A+/A; regulatory-asset increase means no A+/A/B | IR14 p.11–12 |
| IR, Power Departments | Same score bands, no ACS-ARR condition | IR14 p.12 |
| CSRD (REC) | A+ ≥ 90; A 80–< 90; B+ 70–< 80; B 60–< 70; C+ 50–< 60; C 40–< 50; D < 40 | CSRD24 p.73; CSRD25 PDF p.37 |
| DUR (MoP) | No grades. Ranks within 3 categories; descriptive slabs 0–40 / > 40–75 / > 75–100 | DUR25 PDF p.14 |
| RDSS REM | Pass/fail at 60 | RDSS 4.12.6 |
| IR trajectory label | Improving ≥ +5 %; Declining ≤ −5 %; Stable otherwise, vs the previous edition's score | IR14 p.12 |

The rating contract's bands are A+, A, B, B-, C, C-, D. Those are the **IR** names. In the IR, though, D is a default flag rather than a score band, and the IR has no band below C- (< 15). CSRD uses B+ and C+ with D < 40. Pick one family and state it.

---

## 11. Office-applicability of every parameter found

Key:
- **Office:** a CCC, division or region controls or materially drives it, and it can be computed from that office's own numerators and denominators.
- **Office (adapted):** the concept applies, but the national formula uses company accounts, so the office version needs an operational proxy.
- **Company:** the value only exists or is only controllable at company or regulator level.

| Source | Parameter | Class | Reason |
|---|---|---|---|
| IR A1 | ACS-ARR gap | Company | Needs total cost (power purchase, employee cost, interest) and tariff and subsidy revenue; set by tariff and power purchase, not by offices |
| IR A2 | Days receivable | Office (adapted) | Consumer arrears and billed revenue are booked per CCC. Use arrears ÷ billed revenue × 365 |
| IR A3 | Days payable to GENCOs and TRANSCOs | Company | Power purchase payables are a head-office treasury matter |
| IR A4 | Adjusted quick ratio | Company | Balance-sheet ratio |
| IR A5 | DSCR | Company | Debt service is company-level |
| IR A6 | Debt to asset (13th: Debt/EBITDA) | Company | Borrowing is company-level |
| IR B1 | Distribution loss vs SERC-approved | Office (adapted) | Office loss = (input − billed) ÷ input over the office's feeders. The approved loss is company-level, so it needs a cascaded office target or the company target |
| IR B2 | Billing efficiency | Office | Billed units ÷ input units at the office boundary (feeder or DT meters). Driven by metering, reading and theft control locally |
| IR B3 | Collection efficiency | Office (adapted) | Collection ÷ billing per CCC. The subsidy-received adjustment is company-level (state subsidy), so use the consumer-paid amount |
| IR B4 | Corporate governance (board) | Company | Board composition |
| IR C1 | Subsidy realised | Company | State Government payment |
| IR C2 | Loss takeover | Company | State Government |
| IR C3 | Government dues | Company | State budget, though an office could track government-consumer arrears as a diagnostic |
| IR C4 | Tariff cycle timelines | Company | WBERC and company filing |
| IR C5 | Fuel cost pass-through | Company | Regulatory |
| IR D1–D9 | Adverse opinion, audited accounts, defaults, audit qualifications, governance, tariff delays, tariff independent of subsidy, uncovered gap, regulatory assets | Company | Statutory accounts, lenders, regulator |
| CSRD 1.1 | Hours of supply (rural, urban, industrial) | Office | Feeder-level supply hours aggregate to CCC and division. Restoration speed is local; load shedding is not |
| CSRD 1.2 | Interruption index | Office | Interruptions per feeder from feeder logs |
| CSRD 1.3 | DT failure rate | Office | DT count and failures per division and CCC; maintenance is local |
| CSRD 2.1 | Regulation alignment with best practice | Company | WBERC regulation content |
| CSRD 2.2 | Predetermined demand charges | Company | WBERC regulation |
| CSRD 2.3 | Applications processed online, % | Office | Share of the office's connections released through the portal |
| CSRD 2.4 | Average deviation from SoP in connection time | Office | Days per released connection vs the WBERC SoP, by category |
| CSRD 2.5 | Prosumers per lakh consumers | Office | Rooftop solar connections released by the office. Weak control; relative only |
| CSRD 3.1–3.2 | Average days to replace defective meters (U, R) | Office | Core CCC activity |
| CSRD 3.3 | Bills on actual meter reading, % | Office | Meter-reading discipline per CCC |
| CSRD 3.4 | Bills by non-manual reading, % | Office | Depends on smart/AMR rollout (company programme) and on handheld/OCR use locally |
| CSRD 3.5 | Monthly billing of domestic consumers | Company | Billing cycle is set by company policy and WBERC |
| CSRD 3.6 | Domestic bills generated vs required | Office | Missed or stuck bills per CCC |
| CSRD 3.7 | Consumers with mobile for bill alerts, % | Office | Mobile-number seeding is local work |
| CSRD 3.8 | Prepaid consumers, % | Office | Smart prepaid conversion per office. Company programme, local execution |
| CSRD 3.9 | Number of tariff categories | Company | Tariff order |
| CSRD 3.10 | Consumers paying digitally, % | Office | Payment-mode mix per CCC |
| CSRD 4.1 | 24x7 call centre (1912) | Company | Centralised |
| CSRD 4.2 | Call waiting time | Company | Central call centre |
| CSRD 4.3 | Outage alerts on mobile, % | Office | Same mobile seeding as 3.7. The alert system itself is central |
| CSRD 4.4 | Complaint resolution deviation from SoP (rural, urban) | Office | Docket resolution time per CCC vs the WBERC SoP (section 9.2) |
| CSRD 4.5 | Grievance redressal mechanism (two-tier, CGRF per lakh) | Company | Forum set-up |
| DUR | IR score, CSRD score | n/a | Composites. Their office-applicable parts are listed above |
| DUR | RPO achievement | Company | Power procurement |
| DUR | Communicable DT metering, % | Office | Functional communicating DT meters among the office's DTs |
| DUR | Communicable 11 kV feeder metering, % | Office | Same, for feeders |
| DUR | ToD tariff applicability | Company | Tariff order |
| DUR | % consumers with ToD (smart) meters | Office (adapted) | Smart-meter share per office |
| DUR | Resource adequacy | Company | Power procurement planning |
| RDSS REM A | ACS-ARR, subsidy, creditor days, regulatory assets | Company | Accounts and state |
| RDSS REM A | AT&C loss | Office | RDSS itself uses division-level AT&C (> 15 %, > 25 %) |
| RDSS REM A | Government offices on prepaid meters, % | Office | Conversion of government connections per office |
| RDSS REM A | Debtor days | Office (adapted) | As IR A2 |
| RDSS REM B | Hours of supply (rural, urban); SAIFI | Office | Feeder-based |
| RDSS REM B | Accurate energy accounts, %; NFMS data availability, % | Office | Share of the office's feeders and DTs with valid communicating meter data |
| RDSS REM C | Consumer, DT and feeder metering counts; prepaid smart %; NFMS feeders | Office | Per-office counts |
| RDSS REM C | Agricultural feeder separation; LT AB cable replacement | Office (adapted) | Capex projects sanctioned centrally but executed by divisions. Score progress vs plan only |
| RDSS REM D | SCADA, ERP, training, governance, tariff reforms, DBT, consumer-rights framework, PPP | Company | Corporate programmes |
| CEA / WBERC | SAIFI, SAIDI, MAIFI (Schedule 8) | Office | Nᵢ per feeder and Nₜ = the office's consumers. Monthly, rural and urban separately |
| CEA / WBERC | CAIDI (= SAIDI ÷ SAIFI), CAIFI | Office | Derived from the same feeder data |
| WBERC | Network availability = 1 − SAIDI/8760 | Office | Derived |
| WBERC 9.7(vi) | Reliability % (energy not supplied) | Office | Needs feeder input load at outage and restoration plus office sales and loss |
| CEA Format 54 | Feeder reliability index | Office | Feeders × minutes vs outage feeder-minutes |
| WBERC Sched 9 | AT&C loss | Office (adapted) | Input at the office boundary; billed × collection efficiency. The subsidy terms (RSB, RSR) are company-level, so they drop out at office level |
| WBERC SoP 3–6 | Quotation and connection within SoP | Office | Per-application elapsed days vs the SoP |
| WBERC SoP 9.1 | Restoration within SoP by fault type | Office | Per-docket restoration time vs the 9.1 table |
| WBERC SoP 10 | Voltage complaints within SoP | Office | Per complaint |
| WBERC SoP 11 | Meter inspection and replacement within SoP | Office | Per complaint |
| WBERC SoP 15 | Compensation paid (Rs, cases) | Office | Negative indicator, if data exists |
| Rules 2020 | Reconnection ≤ 6 working hours; NDC ≤ 7 days; first bill ≤ 2 cycles; bill ≥ 10 days before due | Office | Per-case compliance |
| Rules 2020 | Grievance (CGRF) disposal ≤ 30/45 days | Company | Forums sit at circle, zone and company level, though sub-division forums are allowed (15(1)) |

---

## 12. Benchmarks we can use

| Metric | Target or benchmark | Type | Source |
|---|---|---|---|
| AT&C loss | Pan-India 12–15 % by FY 2024-25 | National target | RDSS 2.1.1 (p.6) |
| AT&C loss, division banding | > 15 % (AMRUT or urban-majority divisions) and > 25 % (other divisions) mark priority loss areas | National scheme threshold | RDSS 3.2.2.2 (p.13) |
| AT&C loss, actual | All-India 15.04 % FY25 (15.97 % FY24); WBSEDCL 17.17 % FY25 | Context | IR14 p.3 (PDF p.18), Appendix 1 (p.231 onward) |
| Collection efficiency | National target ≥ 98 % | National target | RDSS 3.1.5.4(xv) (p.12) |
| Collection efficiency, IR scale | Full ≥ 99.5 %; zero < 91 %; linear between | Scoring scale | IR14 p.218 |
| Billing efficiency | National target ≥ 85–90 % | National target | RDSS 3.1.5.4(xvi) (p.12) |
| Billing efficiency, IR scale | Full ≥ 92 %; zero < 82 %; linear between | Scoring scale | IR14 p.218 |
| Distribution loss | Actual ≤ SERC-approved (ratio ≤ 1 full; > 1.2 zero). WBSEDCL FY25 approved 15.50 %, actual 15.37 % | Scoring scale and target | IR14 p.218, p.145 |
| Hours of supply | Rural > 22 h full, < 16 h zero; urban 24 h full, < 17 h zero; industrial 24 h full, < 23 h zero | Scoring scale | CSRD Annex E |
| Hours of supply, legal | 24x7 to all consumers (SERC may allow fewer hours for agriculture) | Rule | Rules 2020, 10(1) |
| Interruption index (per feeder per year, unscheduled, ≥ 5 min) | Rural < 60 full, > 720 zero; urban < 20 full, > 420 zero; industrial < 10 full, > 280 zero | Scoring scale | CSRD Annex E |
| Network availability | ≥ 98.00 % per year (SAIDI ≤ 175.2 h, derived); incentive above 98.50 % | WB regulatory norm | WBERC Tariff Regs 2026, Reg 96.2–96.5 |
| SAIFI, SAIDI | No numeric WB target found. Computed monthly, rural and urban; sustained > 5 min | Method only | WBERC Sched 8; see 13 |
| DT failure rate | ≤ 4 % full; > 14 % zero (agricultural DTs excluded) | Scoring scale | CSRD Annex E |
| New connection, legal maximum | 3 days metro / 7 days other municipal / 15 days rural (30 days hilly rural); 90 days if extension needed | National rule | Rules 4(11) as amended 2024 |
| New connection, WB SoP | 30 days where mains exist; 60, 60, 90, 90 days LV/MV with augmentation; 180 days HV/EHV | WB regulation | WBERC 46/WBERC Reg 4.1, 4.2 (57/WBERC) |
| Connection SoP deviation | Within SoP full; > 20 % over SoP zero | Scoring scale | CSRD 2.4 |
| Online applications | 100 % (relative in CSRD); WBERC mandates an online system | Target | CSRD 2.3; 63/WBERC |
| Meter replacement, supply affected | 24 h urban / 48 h rural (WB); 24 h urban / 72 h rural (national) | WB regulation / Rule | WBERC Reg 11.2; Rules 5(13)(c) |
| Meter replacement, supply not affected | Inspect 3/7 working days (urban/rural); burnt meter 7/15 working days; faulty 20/30 days from inspection | WB regulation | WBERC Reg 11.1 (57/WBERC) |
| Meter testing | ≤ 30 days | Rule | Rules 5(7) |
| Fault restoration | Fault-wise table, e.g. fuse 3 h urban; DT failure 12 h urban / 48 h rural | WB regulation | WBERC Reg 9.1 (section 9.2) |
| Complaint resolution deviation | 100 % within SoP full; > 20 % over SoP zero | Scoring scale | CSRD 4.4 |
| Voltage complaints | Local 15 days; augmentation 6 months; fluctuation 4 days urban / 8 days rural | WB regulation | WBERC Reg 10 |
| Bills on actual reading | > 95 % full; < 65 % zero | Scoring scale | CSRD 3.3 |
| Domestic bills generated vs required | 100 % for full marks | Scoring scale | CSRD 3.6 |
| Mobile alerts (bill, outage) | 100 % of consumers for full marks | Scoring scale | CSRD 3.7, 4.3 |
| Call waiting | < 30 s full; > 120 s zero (company-level) | Scoring scale | CSRD 4.2 |
| Reconnection after payment | ≤ 6 working hours | Rule | Rules 9(2) |
| No-dues certificate | ≤ 7 days | Rule | Rules 6(12) |
| Bill delivery | ≥ 10 days before due date; first bill within 2 cycles | Rule | Rules 6(2), 6(7) |
| CGRF disposal | 30 days, maximum 45 | Rule | Rules 15(2) |
| Communicable DT and feeder meters | 100 % full; 75–< 100 % half; < 75 % zero | Scoring scale | DUR 2.2.4 |
| Compensation for SoP failure | Rs 500 per day (or per slab) | WB regulation | WBERC Reg 15.0 (57/WBERC) |

---

## 13. Unconfirmed / conflicting

1. **The 2024 amendment's Gazette PDF was not reached.**
   - The 3/7/15/30-day connection timelines and the 90-day extension limit come from the LegitQuest text of G.S.R. 125(E).
   - They are corroborated by MERC's Explanatory Memorandum (PDF p.8–9).
   - Sources disagree on the notification date: 22.02.2024 (LegitQuest, MERC) vs 12.02.2024 (TeamLease).
   - Looked at: powermin.gov.in (404), indiaenvironmentportal (PDF 404).
2. **WBERC SoP vs the 2024 Rules (conflict).**
   - WBERC Reg 4.1 still says 30 days where mains exist. The Rules now cap it at 3, 7 or 15 days depending on area.
   - No WBERC SoP amendment after 66/WBERC (20.02.2020) appears on the WBERC current-regulations list, checked 01.11.2026.
   - Decide which one the rating uses: the WBERC figure is the enforceable SoP for WBSEDCL today; the Rules figure is the national ceiling the SERC must adopt.
3. **CEA AT&C circulars not fetched.**
   - CEA-GO-17(11)/1/2018/DP&R Div/408-530 (08.08.2018) and CEA-GO-13-25/1/2023-DPM Division/64 (08.12.2023): cea.nic.in old paths return 404 and the Wayback Machine has no copy.
   - The definitions in 7.3 come from IR14 and the WBERC Tariff Regs 2026, which cite or encode them.
   - The July 2023 revision (collection efficiency on subsidy-received basis) is described only in secondary news (Powerline, Indian Infrastructure, Mercom, July 2023).
4. **No CEA DT failure definition or target.** The CEA "Guidelines for O&M of DTs" (2023) PDF is 404. The "~10 % national DT failure rate (CEA)" figure is secondary (Mercom 2025). Use the CSRD definition.
5. **No numeric SAIFI or SAIDI target for WBSEDCL found.**
   - The WBERC Tariff Regs 2026 allow trajectories in the MYT order (Reg 6). The 2022 Rules require trajectories for cities with population ≥ 100,000.
   - I did not find a WBERC order with numbers.
   - Only the 98 % network-availability norm is confirmed.
6. **Minimum interruption duration differs by source.**

   | Source | Rule |
   |---|---|
   | WBERC Sched 8 | Sustained > 5 min; momentary ≤ 5 min |
   | CSRD | Ignore interruptions < 5 min |
   | Rules 2022 | Default 3 min for CAIDI/CAIFI/MAIFI if the SERC is silent (WBERC isn't silent) |
   | WBERC SoP 9.7 | Records interruptions > 15 min for its energy-based reliability figure |
   | CEA Format 54 | Uses all outage minutes |

   For West Bengal, use the WBERC 5-minute rule for SAIFI and SAIDI.
7. **"Proportionate" is not defined mathematically** in IR or CSRD.
   - IR: linear interpolation reproduces published WBSEDCL IR14 marks (3.10), so treat it as confirmed for IR.
   - CSRD: no per-sub-parameter marks are published, so this is not verified. Linear is the natural reading.
8. **CSRD 4.3 outage alerts:** the band list (≥75–<100, ≥50–<75, ≥25–<50, <25) is printed without marks for each band. The marks per band are unknown.
9. **CSRD typos in the source:**
   - Interruption index, urban, reads "Total marks for Rural = Y"; it means urban.
   - "(A+B) to constitute 7 Marks" in the interruption-index row means X + Y.
10. **IR14 collection-efficiency trajectory clause** still says "If **FY23** Collection Efficiency is ≥ 95 %…", text carried over from the 13th IR, where FY23 was year T.
    - It is unclear whether the 14th means FY(T) = FY25.
    - WBSEDCL passes either way, so the published marks don't settle it.
11. **IR ACS-ARR grade condition:** the report doesn't say whether the latest year's gap or the 3-year weighted gap is used for the override. Irrelevant at office level.
12. **IR14 and IR13 PDFs come from a third-party mirror** (jmkresearch.com). The content is the PFC/MoP report (acknowledgements, committee, Deloitte). pfcindia.com timed out, so the official PFC URL was not captured.
13. **DUR FY25 PDF URL was inferred** from REC's naming pattern. The REC Hindi DUR page links a placeholder file. The PDF's content confirms it is DUR FY 2024-25.
14. **RDSS REM is illustrative.**
    - Each DISCOM's actual matrix and yearly targets differ.
    - WBSEDCL's agreed matrix was not found.
    - Reported FY25 AT&C outcomes conflict between sources: 15.04 % in IR14 (primary) vs 16.16 % in IMPRI (secondary). IR14 is authoritative.
15. **CEA Format 54** is from the 2014 web archive of the CEA (Furnishing of Statistics, Returns and Information) Regulations. I could not confirm whether it is still the prescribed format.
16. **CSRD "industry best practice" connection timelines** (7/15/30 days) predate the 2024 amendment (3/7/15). CSRD FY25 still prints the older values.
17. **History, secondary only:** consumer-service parameters were moved out of the IR into the new CSRD after MoP modifications in May and July 2021 (Powerline, 19.08.2021). Not needed for the design.

---

## 14. Secondary sources used only to locate primaries

- Powerline: 01.03.2025 (CSRD FY24 PDF link), 26.03.2026 (DUR FY24 PDF link), 11.11.2022 (CSRD FY21 PDF links), 05.05.2026 (DUR and CSRD FY25 summary).
- WBSEDCL FY25 DUR figures were read from the primary DUR, not from secondary sources.
- LegitQuest (2024 amendment text).
- MERC Explanatory Memorandum (2024 amendment timelines).
- Mercom (CEA DT failure statistic, not used for any number above).
