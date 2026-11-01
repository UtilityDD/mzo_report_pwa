# Rating engine contract (`lib/rating.js`)

The interface between the metrics layer (`lib/rating_metrics.js` / `scripts/rating/compute-metrics.js`), the engine (`lib/rating.js`) and the page (`performance_index.html`). The method itself (pillars, thresholds, sources, rules) is in [methodology.md](methodology.md); a real output is in [sample-rating.json](sample-rating.json), made from [sample-metrics.json](sample-metrics.json):

```bash
node -e "const R=require('./lib/rating.js');process.stdout.write(JSON.stringify(R.rate(require('./docs/rating/sample-metrics.json')),null,1)+'\n')" > docs/rating/sample-rating.json
```

## API

```js
// Browser: <script src="/lib/rating.js"></script> → window.MzoRating.   Node: require('./lib/rating.js').
const ratingDoc = MzoRating.rate(metricsDoc, { generatedAt });   // pure, deterministic, ~15 ms for 52 offices
MzoRating.METHOD          // { version, bands, pillars, penalties, penaltyCap, rules, sources }
MzoRating.linear(v, full, zero)   // 0…1 on the national linear scale
MzoRating.gradeOf(score)          // 'A+' … 'D'
MzoRating.fmt(v, unit)            // the display text the engine uses
```

- No clock, locale or randomness inside `rate`. `generatedAt` defaults to `metricsDoc.generatedAt`. The same input gives the same output text (`JSON.stringify`).
- The engine never mutates its input.

## Input: `metricsDoc` (the shape of `sample-metrics.json`, unchanged)

```
{ generatedAt, logic, referenceDate, source,
  metrics: { <metricId>: { pillar, label, unit, direction, levels, datasets, formula, period, asOn, ageDays, maxAgeDays, minBase, flags[], naReason? } },
  offices: { <code>: { level: 'zone'|'region'|'division'|'ccc', name, parent, region?, division?,
                       metrics: { <metricId>: { value, numerator, denominator, asOn,
                                                quality: { status: 'ok'|'warn'|'stale'|'no_data'|'na', flags?[], reason? },
                                                inputs?, ownLevel?, target? } } } } }
```

Metric ids the engine reads (all already in `sample-metrics.json`):

| Pillar | Metric ids |
|---|---|
| Loss & revenue | `atc_loss`, `distribution_loss` (needs `target`), `collection_efficiency`, `receivable_days`, `atc_loss_change_yoy` (needs `inputs.current`, `inputs.yearEarlier`) |
| Reliability | `dtr_weighted_outage_hours`, `feeder_outage_count` |
| Connection services | `nsc_pending_over_30d_share`, `nsc_wo_delay_avg`, `load_ext_pending_over_90d_share`, `pmsgy_net_metering_share` |
| Metering & billing | `defective_meter_share`, `defective_over5y_share`, `unbilled_3m_per_10k`, `first_bill_pending_per_10k`, `mc_pending_over_30d_share` |
| Faults & grievances | `fault_dockets_open_over_24h_per_10k`, `docket_open_per_10k`, `cmo_open_share` |
| Penalties | `accidents_fatal_12m`, `safety_rectification_share`, `live_consumers` |

Rules the engine applies to each entry: `quality.status` `na` → n/a (level); `stale` (or flag `stale`) → n/a (stale); flag `small_base` or `low_match_coverage` → n/a; flag `no_cases` → n/a; `value: null` → n/a (no data). Other flags are shown as notes. A metric missing from an office's `metrics` is n/a ("not in the metrics input"), so a metrics layer that cannot compute something simply leaves it out or sets `value: null` with a `quality.reason`.

## Output: `ratingDoc`

```
{
  engine: 'rating/1',
  generatedAt, referenceDate,
  inputs: { metricsLogic, metricsGeneratedAt, source,
            asOn: { <metricId>: { asOn, period, stale, datasets: [ { key, label, page } ] } } },   // source dataset(s) of each metric:
                                                 // mirror key, label (metricsDoc.datasets[key].label if given, else the engine's
                                                 // list), and the page that shows the same figures
  bands:   [ { grade: 'A+', min: 90, label: 'Excellent' }, … { grade: 'D', min: null, label: 'Very poor' } ],
  pillars: [ { id, label, short, weight, basis } ],               // base weights, sum 100
  penaltyCap: 5,
  rules:   { linear, naParameter, naPillar, minRated, penalties, levels, ranks },   // plain-language strings
  sources: { <sourceKey>: 'document title' },
  methodology: [ MethodRow ],                                    // one row per parameter and penalty (flat table)
  method: Method,                                                // the full methodology as structured data (Methodology tab)
  zone: '6600000',
  levels: { zone|region|division|ccc: { order: [code, …] (rank order, unrated last), of: N (rated offices) } },
  offices: { <code>: Office }
}
```

`MethodRow`:

```
{ kind: 'parameter'|'penalty', pillar, pillarLabel, pillarWeight, id, metric, label, unit, direction,
  max (negative for penalties), full, zero, fullDisplay, zeroDisplay, formula, source, sourceText, ref, stretch }
```

`full` is the value that earns full marks (for a penalty: no deduction), `zero` the value that earns none (for a penalty: the full deduction). `ref` is the exact clause; `stretch` is the national 2024 timeline shown alongside but not scored.

`Method` (everything `docs/rating/methodology.md` says, generated from the same data; the page renders it):

```
{ version, title,
  intro: [paragraph], formula,                        // what this is, what it is modelled on, what is left out
  bands: [ { grade, min, label } ], bandsNote,
  pillars: [ { id, label, short, weight, national, basis,       // national = the national weights it is set against
               params: [ { id, metric, label, unit, direction, max, formula, full, zero, fullDisplay, zeroDisplay,
                           source: { key, short, label, url }, ref, stretch, levels: ['zone',…], notes: [string],
                           datasets: [ { key, label, page } ] } ] } ],
  penalties: [ { id, metric, label, unit, max, formula, none, worst, noneDisplay, worstDisplay, source, ref, levels } ], penaltyCap,
  levelsRule: [paragraph], naRule: [paragraph], qualityRule: [paragraph], penaltyRule: [paragraph], rankRule, whyRule,
  caveats: [ { id, text } ],                         // from this run's data: HT rows at regions, the swapped loss month,
                                                     // reliability coverage, stale inputs, mixed dates
  excluded: [ { item, reason } ], gaps: [string],
  sources: [ { key, short, label, url, ref } ],
  example: { code, name, level, score, grade, rank, of, penaltyTotal,             // one CCC (opts.example, else the median-ranked CCC)
             pillars: [ { id, label, weight, max, marks, note,
                          params: [ { id, label, display, full, zero, fraction, max, effMax, marks, status, naReason } ] } ] } }
```

`rate(doc, { example: '<code>' })` picks the worked-example office.

`Office`:

```
{
  code, name, level, parent, children: [code],
  region, division,                       // names, as in the metrics input
  path: { zone, region?, division?, ccc? } // codes up the chain (highlighting the signed-in office and its parents)
  score: 0…100 | null, grade: 'A+'…'D' | null, rated: bool,
  band: { grade, min, max, label } | null,
  rank: n | null, of: N | null,           // within its level; ties share a rank
  base, penaltyTotal, measurable,         // marks before penalties, penalties (≤ 0), base marks measurable (of 100)
  pillars: [ {
    id, label, short, weight,             // base weight
    effWeight, max,                       // weight after a whole pillar elsewhere is n/a (max = effWeight)
    marks, na: bool, note | null,
    params: [ {
      id, pillar, metric, label, unit, direction,
      value, display, detail | null,      // value in `unit`; display text; e.g. '25.28 % vs target 21.13 %'
      numerator, denominator, asOn,
      full, zero, source,                 // thresholds (texts in methodology rows)
      max, effMax, marks, fraction,       // base marks, marks after re-weighting, marks earned, 0…1
      status: 'scored'|'na', naCode, naReason,   // naCode: level | stale | small_base | coverage | no_cases | no_data | missing
      quality: { status, flags[] }, notes: [ { flag, text } ],
      reweight: string | null             // what re-weighting did to this parameter
    } ]
  } ],
  penalties: [ { id, metric, label, unit, value, display, detail, asOn, none, worst, max, source, applied, marks, naCode, naReason } ],
  why: [string],                          // "why this grade", 3–6 sentences
  improve: [ { param, pillar, label, unit, from, fromDisplay, toFull, toFullDisplay, gain, nextGrade, toNext, toNextDisplay, text } ],
                                          // top 4 by marks to gain; toNext = the value of this one parameter that alone reaches the next grade
  contributions: { <paramId>: { label, unit, parentExcess, note,
                                rows: [ { code, name, value, display, excess, share, own? } ] } }
                                          // for the office's weak parameters (under half marks): each child's excess over the
                                          // full-marks level, in the numerator's unit; rows add up to parentExcess, with an
                                          // 'own' row for inputs booked at the office itself (e.g. HT input at a region);
                                          // share = the row's part of the positive excesses (0 for rows under the level)
}
```

Numbers are rounded: marks and scores to 2 decimals, values to 3. The page shows scores to 1 decimal.

## Stability

The shape above is fixed. Values (weights, thresholds, which metrics feed a parameter) can change with the method; any change of shape is announced as `CONTRACT-CHANGE` in `agent-progress/rating-build.log`.
