# Rating: the metrics layer

`lib/rating_metrics.js` computes the 46 metrics of [data-map.md](data-map.md) for all 52 offices (zone, 3 regions, 7 divisions, 41 CCCs) from **uniform rows** ([uniform-data.md](../uniform-data.md)) and returns the metrics document `lib/rating.js` rates ([engine-contract.md](engine-contract.md); the shape of [sample-metrics.json](sample-metrics.json), unchanged). It is a port of `scripts/rating/compute-metrics.js`, which reads raw snapshots; both give the same document (identity below). On the VM the rating is precomputed after each sync and served at `GET /api/data/rating`; elsewhere (Vercel, or before the first precompute) the page computes it in the browser from the cached rows.

| File | Runs in | What |
|---|---|---|
| `lib/rating_metrics.js` | browser (`window.MzoRatingMetrics`), Node | rows → metrics document; no dependencies besides `lib/offices.js` |
| `vm/sync/lib/rating.js`, `vm/sync/rating.js` | VM | precompute after each sync (`rating.json`, `rating-metrics.json`, `rating.meta.json`) and the `/api/data/rating` handler |
| `schema/important_*.json`, `schema/si_works.json` | browser, VM | schemas for the four datasets no batch owns |
| `scripts/qa/rating-metrics-identity.js` | dev | the module against compute-metrics.js on the same snapshots |
| `scripts/qa/rating-metrics-test.js` | dev | unit tests (aggregation rules, flags, inputs) |
| `scripts/rating/check-schema-needs.js` | dev | do the schema files pin every field the rating reads ([schema-needs.md](schema-needs.md)) |
| `vm/sync/run.js`, `server.js` | VM | the hook (after the rows step) and the `/api/data/rating` mount, applied by the lead from `agent-progress/rating-vm-hooks.patch` |

## API

```js
// Browser: <script src="/lib/offices.js?v=2" defer></script>, mzo_rows.js (its current ?v=), then
//          <script src="/lib/rating_metrics.js?v=1" defer></script> and <script src="/lib/rating.js?v=1" defer></script>
const metrics = await MzoRatingMetrics.compute(source, opts);   // → Promise<metricsDoc>
const rating = MzoRating.rate(metrics);                          // → ratingDoc

// Node / VM: synchronous, no loading
const M = require('./lib/rating_metrics.js');
const metrics = M.computeSync(source, opts);
```

| | |
|---|---|
| `source` | omitted / `null`: `compute()` loads the datasets itself with `MzoRows.get(key, { scope: false })` (every office: peer ranks need all of them). Or `{ <datasetKey>: rows }`, or a function `key → rows` (may return a promise in `compute()`). `rows`: an MzoRows `t` (its `all` is used), an array of uniform row objects, a `lib/uniform.js` `build()` result, or a rows document (parsed or JSON text). A key missing from a map, or that fails to load, puts the metrics that need it in `errors` ("dataset missing: …"), as compute-metrics.js does. |
| `opts.rated` | `true` (uses `window.MzoRating.METHOD`) or a METHOD: only the metrics lib/rating.js scores (22, from 17 datasets instead of 37). `compute()` only. |
| `opts.only` | metric ids to compute (and so the datasets to load) |
| `opts.asOf` | `YYYY-MM-DD` reference date for staleness. Default: the manifest's `generatedAt` date, else today (UTC) |
| `opts.manifest` | the mirror manifest (`asOf`, `dtr_count`'s snapshot date). `compute()` default: `GET /api/data/manifest` (204 on Vercel = none) |
| `opts.offices` | the `lib/offices.js` module. Default `window.MzoOffices` (`compute()` loads `/lib/offices.js?v=2` when absent) or `require('./offices.js')` |
| `opts.generatedAt`, `opts.mode` | stamped into the document (`source.mode`: `browser`, `vm`, …) |
| `opts.release` | `computeSync()`: forget each dataset's rows after the last metric that lists it (the VM uses it; output unchanged) |

Also exported: `DATASETS` (the 37 keys), `NEEDS` (fields read per dataset, with types), `schemaFor(key)` (the rating's own lean schema), `SCHEMA_OPTS`, `METRICS`, `FLAGS`, `datasetsFor(ids)`, `ratedIds(METHOD)`, `loadRows(keys)`, `asTable(x)`, `num`, `date`, `officeTree`. `compute.last` holds `{ loadMs, computeMs, datasets }` of the last browser run.

The document is the sample-metrics.json shape. Two additions, present only when they apply: `warnings` (`{ atc_loss: "field missing: loss_targets.cum_input_mu …; targets left out" }`) and the messages in `errors` for fields a dataset lacks ("field missing: nsc_pending.delayinqtn (add to schema/<key>.json)": the module never reads a missing field as zeros).

### How the page uses it

```js
// Performance index: the VM's precomputed rating when there is one, else compute it here.
async function loadRating() {
  const res = await fetch('/api/data/rating', { credentials: 'same-origin', cache: 'no-cache' });
  if (res.status === 200) return res.json();                                  // VM (mirror mode), ETag/304, brotli
  const metrics = await MzoRatingMetrics.compute(null, { rated: true });      // 204: Vercel, or no precompute yet
  return MzoRating.rate(metrics);
}
```

`compute(null, { rated: true })` equals `compute(await MzoRatingMetrics.loadRows(MzoRatingMetrics.datasetsFor(ids)), { only: ids })` with `ids = MzoRatingMetrics.ratedIds(MzoRating.METHOD)`. The rows come unscoped (every office) because ranks compare every office of a level; the metrics document holds office aggregates only, and which offices the page shows to a login is the page's rule (AGENTS.md: office lists follow the login scope). `GET /api/data/rating?part=metrics` gives the metrics document the VM rated, for a page that shows inputs the rating does not carry.

## Rules (as compute-metrics.js)

- **Office of a row:** its canonical office fields (`_ccc_code`, else `_division`, else `_region`), so the rating places every row where every page does. A row with none of them counts at the zone only when its own office cells name the zone office (6600000, "Malda Zone"); otherwise it is unmapped (`metrics.<id>.unmapped`). The loss sheets are read by name instead (CCC rows, "… Div Total" rows, region rows, the zone row), as the loss page does. CMO grievances with no region ("Not Known") count at the zone, as in the script.
- **Levels:** each office's inputs are the rows booked at the office itself plus the summed inputs of its children; the value comes from those sums (numerator ÷ denominator), never from averaging children. Rows at a division, region or zone office are flagged `includes_own_level_rows` with their `ownLevel` numerator and denominator.
- **Loss:** a region's own input is its row minus the sum of its divisions (HT input); the zone row minus the regions is the zone's own (±0.01 MU today). Targets are recomputed from the target sheet's MU. The year-earlier AT&C uses the median of the three months around it when the month itself is more than 10 pts away (the Sep-2025 swapped rows; flag `base_month_outlier`).
- **CCC reliability proxy:** feeders are tied to CCCs through the DTR list by division + substation + feeder name, else division + feeder name; each DTR sees its feeder's outage hours; under 60 % DTR coverage is `low_match_coverage`.
- **Quality flags and statuses:** `stale` (age over `maxAgeDays`), `small_base` (under `minBase`), `no_cases` (nothing on a list), `no_rows` / `no_data`, `na` + `level_not_available` (feeder metrics at CCCs, CMO below regions, SI works and O&M at CCCs), dataset caveats, exactly as data-map.md describes.
- **Values:** typed values are read as they are; text and the `<field>_raw` text of values a typed column could not parse go through the script's own parsers (Indian/Western commas, `%`, `(0.37)`, dd.mm.yyyy, dd-mm-yy, yyyymmdd, 15-July-26 …), so a schema's choice of types never changes a number ([schema-needs.md](schema-needs.md)).

## Identity with compute-metrics.js

`node scripts/qa/rating-metrics-identity.js --snap <snapshot folder> [mode]` runs the script on the raw snapshot bytes (its own process) and the module on uniform rows built from the same bytes, and compares the two documents field by field (generatedAt and `source.mode` aside): every metric's metadata, checks and errors, every office entry's value, numerator, denominator, asOn, quality, inputs, ownLevel and target. Each difference must match an explained entry (with a check of its own, e.g. totals unchanged) or the run fails (exit 1).

| Mode | Rows built with | Result |
|---|---|---|
| default `--schemas <dir>` | the schema files + the fields the module needs | **identical**: 46 metrics × 52 offices (2,392 entries), 0 differences |
| `--vm --lean-check` | `MzoRatingMetrics.schemaFor` through vm/sync/lib/rating.js's lean build (the VM precompute) | identical; every lean build equals the plain lib/uniform.js build in all pinned and office fields |
| `--exact` | the repo's schema files as they are; no schema = keep all (MzoRows on the VM) | identical |
| `--exact --vercel` | as `--exact`, no schema = unavailable (MzoRows on Vercel) | identical: all 46 metrics compute on Vercel |

Runs of 1 Nov 2026 on develop b017569 (every batch's schemas merged), snapshots of 08:30 and 08:55 UTC. `scripts/rating/check-schema-needs.js` prints "every needed field is pinned".

Two differences were found and are fixed; the harness keeps their checks (`KNOWN`), which apply only when they recur:

1. **Old SAP cost centres in accidents.** 21 accident rows (2 fatal in the 12-month window) are booked on cost centre `C333430000`, "CHANCHAL DIV" in `data/costcenter.json`. Uniform rows always place them in Chanchal division; compute-metrics.js used to resolve accidents before loading the cost centres (it did so only inside the capex metric) and put them at Malda region's own level (region and zone totals were the same). compute-metrics.js now loads them before every metric.
2. **`onm_advance` without a schema** (`--exact`, before batch D merged): lib/offices.js's header rules see `Plant` but not `Resp. CCtr`, so a few orders sat in another division. `schema/onm_advance.json` names both roles, as `schemaFor` does.

## VM precompute

`vm/sync/rating.js` (run by the sync after `vm/sync/rows.js`, in its lock, in its own process) reads the **raw snapshots** of the 37 datasets, builds lean uniform rows in-process with `MzoRatingMetrics.schemaFor(key)` (only the fields the rating reads; the owners' office roles), computes the metrics, rates them and writes, each with `.gz` and `.br`, temp file then rename:

| File | What |
|---|---|
| `rating.json` | the rating document (`MzoRating.rate`) |
| `rating-metrics.json` | the metrics document it was rated from |
| `rating.meta.json` (last) | `inputs` (hash of the code, the reference date and every input snapshot version), `code`, `asOf`, `builtAt`, `ms`, `maxRssMb`, per-dataset rows and build time, `errors`, `warnings`, each file's bytes, sha1 and ETag |

It never reads the page schemas or the page rows files, so a field a page does not pin cannot affect it. It rebuilds only when the code (lib/rating_metrics.js, lib/rating.js, lib/uniform.js, lib/offices.js, data/costcenter.json), the reference date or an input snapshot changed, and changed inputs at most every 15 minutes (`--min-minutes 15`; the docket sheet changes at almost every sync); a code change rebuilds at once. Columns are cut down to the needed ones before lib/uniform.js runs (exactness checked by `--lean-check`), and the four meter sheets are loaded one at a time.

`GET /api/data/rating[?part=metrics]` (server.js): 401 without a session; **204** when mirror mode is off (Vercel, local default), before the first build, or when the files were built by other code than the server runs (after a deploy, until the next sync); otherwise 200 with `ETag`, 304 on `If-None-Match`, `Content-Encoding: br|gzip` from the precompressed copies, `Cache-Control: private, no-cache`.

| Measured (laptop, 08:55 snapshots) | |
|---|---|
| Time | 3.3–4.2 s per build (metrics 3.2 s, rate 7 ms, files 0.1 s); unchanged inputs: 10–20 ms. The VM ran the rows step about 5–10× slower than this laptop, so expect 20–40 s of CPU per build there |
| Memory | about 128 MB of JS heap at the peak (the meter sheets; fails at 112 MB); max RSS 245–267 MB on macOS at a 128–160 MB heap cap, 386 MB with no cap. The hook gives it 160 MB (`--max-old-space-size=160`) inside the sync service (MemoryMax 400 MB since develop 5636f0d); the script logs its own max RSS in the sync journal |
| Output | rating.json 825 KB (46 KB br), rating-metrics.json 464 KB (44 KB br) |

## Browser fallback timing

`node scripts/qa/rating-metrics-bench.js` (headless Chrome on an M-series laptop; local app through `scripts/qa/serve-local.sh 3970 <snapshots>` in mirror mode, rows precomputed by `vm/sync/rows.js` with the schemas as they will be after batches C, D and E merge; 08:55 snapshots; median of 5). *Cold*: a fresh browser profile, rows downloaded from `/api/data/rows`. *Warm*: the page reloaded, rows from MzoRows' IndexedDB cache (304 from the server). *Compute*: `computeSync` on the loaded rows, the first call in the page (cold JIT) and a second one. "×4 CPU" throttles the CPU four times (roughly a mid-range phone).

| What | CPU | Rows: datasets, rows | Rows load cold → warm | Compute first → again | Rate | `compute()` end to end, warm |
|---|---|---|---:|---:|---:|---:|
| `rated: true` (22 metrics) | desktop | 17, 138,076 | 188 → 109 ms | 152 → 141 ms | 6 ms | 264 ms |
| `rated: true` | ×4 | | 630 → 434 ms | 620 → 573 ms | 21 ms | 1,049 ms |
| all 46 metrics | desktop | 37, 967,789 | 738 → 602 ms | 1,024 → 901 ms | 5 ms | 1,546 ms |
| all 46 metrics | ×4 | | 2,654 → 2,296 ms | 4,018 → 3,598 ms | 21 ms | 5,960 ms |

Without precomputed rows (the first visit on Vercel, or rows stale on the VM) MzoRows builds them in the browser, in its Web Worker, from the raw files (`/api/data/file/<key>` here; on Vercel the Google download comes on top). Median of 3, same setup, no rows files: rows load cold 558 ms (`rated: true`) and 1,826 ms (all) on desktop, 800 ms and 3,004 ms with ×4 CPU; once built they are cached and the warm figures above apply. The CPU throttle is applied to the page; MzoRows' worker does not appear to be throttled, so the ×4 cold figures are a lower bound for a phone.

Payload (brotli) of the rows: 2.5 MB for the 17 rated datasets, 11.7 MB for all 37 (the meter sheets and withheld are most of it; raw CSV 17.7 MB and 82.8 MB). So the fallback should compute `rated: true`: about 0.3 s on a desktop and 1 s on a phone-class CPU once the rows are cached, against 1.5 s and 6 s for every metric. On the VM the page does neither: `/api/data/rating` is one 46 KB request. Every run gave the same document from `compute()` and `computeSync()` (`sameDocument`), and the zone score 51.83 as the VM's `rating.json`.

## Tests

```bash
node scripts/qa/rating-metrics-test.js                                         # 16 unit tests
node scripts/qa/rating-metrics-identity.js --snap <dir> --vm --lean-check      # the VM path
node scripts/qa/rating-metrics-identity.js --snap <dir> --exact [--vercel]     # the browser path with this repo's schemas
node scripts/rating/check-schema-needs.js                                      # schema files vs the fields the rating reads
```

A snapshot folder (manifest.json + `<key>.csv|tsv|json`) comes from `node scripts/rating/compute-metrics.js --mirror https://130.210.43.11.sslip.io --cookie-file <cookie file> --save <dir>` (GET only).
