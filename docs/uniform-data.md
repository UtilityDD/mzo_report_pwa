# Uniform data

Pages read **uniform rows** instead of raw sheet files: the same snake_case column names everywhere, real numbers, ISO dates, Y/N as true/false, and the canonical office of every row (`_region`, `_division`, `_ccc_code`, `_ccc`). One library makes them from the source bytes, in the browser and on the VM, so the two give the same bytes and pages cannot disagree about offices. Which page reads what today, and the conversion batches: [uniform-data-inventory.md](uniform-data-inventory.md).

| File | Runs in | What |
|---|---|---|
| `lib/uniform.js` | browser, Web Worker, Node | source bytes → uniform rows (`window.MzoUniform`) |
| `lib/offices.js` | browser, Node | the canonical office list and resolver (`window.MzoOffices`; owned by the office work, see `docs/architecture.md`) |
| `mzo_rows.js` | browser | `window.MzoRows`: cache, mirror, local build in a worker; also the worker script |
| `schema/<key>.json` | browser, VM | the fields a dataset's pages rely on: names, types, aliases, source |
| `vm/sync/lib/rows.js`, `vm/sync/rows.js` | VM | `<key>.rows.json` next to each snapshot; `GET /api/data/rows/:key` |
| `scripts/qa/uniform*.js` | dev | unit tests, Node/browser identity, row parity, page parity and timing, local mirror stub |

## How rows reach a page

```
                    schema/<key>.json ─────────────┐
                                                   ▼
VM:      sheet ─▶ sync ─▶ <key>.csv snapshot ─▶ rows.js ─▶ <key>.rows.json(.br) ─▶ GET /api/data/rows/<key> ─┐
                                                 (lib/uniform.js)                                           │
Vercel:  sheet ─▶ DataHub (IndexedDB raw) ─▶ mzo_rows.js worker (lib/uniform.js) ──────────────────────────┤
                                                                                                            ▼
                                                    IndexedDB MZORows/rows (the rows JSON) ─▶ MzoRows.load(key, render)
```

1. **Cache first.** `MzoRows.load` paints from IndexedDB (`MZORows` database, one value per dataset: the rows JSON text and where it came from), then checks for newer rows in the background, exactly like `UI.load`. It reads `schema/<key>.json` in parallel and skips the cached paint when the schema changed since those rows were made (a page that starts using a new field never sees rows without it); offline, the cached rows are painted anyway.
2. **Mirror (VM).** When `/api/data/manifest` lists the dataset, rows come precomputed from `/api/data/rows/<key>` (ETag, 304, brotli). If the server has no current rows for this code and schema (404), the browser builds them itself from `/api/data/file/<key>`.
3. **Original (Vercel, or no mirror).** The raw body comes through DataHub as today (`schema.source.hub`), and `lib/uniform.js` runs in a Web Worker (above 200 KB of text; inline below that). The rows are cached by DataHub version + schema text + code version, so they are rebuilt only when one of those changes.

The output is byte-identical on both paths for the same bytes: same code, no time zone or locale dependence, canonical JSON. Proof: `scripts/qa/uniform-identity.js` builds every one of the 62 local snapshots in Node, on a page's main thread and in the worker (headless Chrome), with and without schema: 64/64 identical sha1 (run of 2026-11-01).

## The rows document

`lib/uniform.js` `stringify(build(...))` and `/api/data/rows/:key` both give:

```json
{"key":"solar_connections","version":"<snapshot sha1 | DataHub version>","logic":"uniform/1+offices/1+cc56","schema":"<hash>",
 "columns":[{"name":"solar_appl_no","type":"text","source_name":"SOLAR_APPL_NO","pinned":true},
            {"name":"load_appl","type":"number","source_name":"LOAD_APPL","pinned":true},
            {"name":"load_appl_raw","type":"text","source_name":"LOAD_APPL","raw_of":"load_appl"},
            {"name":"creation_date","type":"date","source_name":"CREATION_DATE","date_order":"dmy","has_time":true,"pinned":true},
            {"name":"_region","type":"text","source_name":""}, …],
 "issues":[{"check":"type.unparsed","column":"load_appl","count":1,"sample":["03-10-2026 08:21"]}, …],
 "stats":{"rows":6827,"source_rows":6827,"source_columns":44},
 "rows":[["4003177228",2,"","2023-06-13T00:00:00",…,"Balurghat"], …]}
```

Keys always in this order; `rows` is row-major arrays in `columns` order. `version` is opaque (where the input came from) and is the only field that differs between the VM and the browser for the same bytes.

| Type | Value | Empty | Notes |
|---|---|---|---|
| text | trimmed string | `''` | `(null)`, `NA`, `#N/A`, `-` stay as written in text columns |
| number | JS number | `null` | Western `1,234,567` and Indian `12,34,567` grouping; a leading zero or > 15 digits is not a number |
| date | `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM:SS` (the sheet's wall clock, no zone) | `null` | dd/mm/yyyy, dd.mm.yyyy, dd-mm-yyyy, m/d/yyyy, yyyy-mm-dd, ISO, 1-Oct-2026, Oct 1, 2026, AM/PM. A value with a zone (Supabase) becomes UTC `…T…:..sssZ`. `UI.date()` reads all of these as local dates, as before |
| bool | `true` / `false` | `null` | Y/N, Yes/No, true/false |
| json | the value | `null` | Supabase json columns |
| `<name>_raw` | the original text where a typed value did not parse, else `''` | | the typed value is `null` there; listed in `issues` as `type.unparsed` |
| `_region`, `_division`, `_ccc_code`, `_ccc` | canonical names / code from `lib/offices.js` | `''` when unknown | office problems are listed in `issues` (`office.*`), with `office.coverage` = [CCC, division, region, none] row counts |

**Names** are the mirror's (`vm/sync/lib/normalise.js`): lowercase ASCII, every run of other characters → `_`, `c_` before a leading digit, empty header → `col_<letter>`, duplicates `_2`, `_3` (first copy keeps the plain name), PocketBase names (`id`, `created`, …) get `_2`. **Rows**: values trimmed, all-blank rows dropped, padding columns (no header, no value) dropped, cells beyond the header kept as `col_<letter>`.

**Types** (when the schema does not pin them): number or date when ≥ 98 % of the non-empty values parse (the mirror's threshold), dd/mm vs mm/dd by which reading parses more values (ties: dd/mm, or the dataset's `date_order`), bool when every value is Y/N-like. Two rules on top of the mirror's: placeholders (`(null)`, `NA`, `#N/A`, `-`, `NIL`, …) do not count against a typed column, and **identifier columns stay text** (`…_no`, `…_id`, `…_code`, `…_number`, `phone`, `mobile`, `mru`, `won`, `pin`, …; `no_of_poles` is still a number) so leading zeros, search and joins keep working. On the 62 snapshots 1,299 of 1,443 columns get the same type as the mirror's inference; the other 144 are these two rules (125 identifier columns, 19 columns with placeholders).

## API

### `lib/uniform.js` (`window.MzoUniform`, `require('./lib/uniform.js')`)

| Function | |
|---|---|
| `build(input, opts)` | `input`: CSV/TSV text, a JSON array of objects, or `string[][]`. `opts`: `key`, `version`, `format` (`csv` \| `tsv` \| `json`), `schema` (the parsed schema file), `offices` (a module, `null` to skip; default `lib/offices.js`), `header` (`false`: no header row), `dateOrder`, `columnTypes` ({ header or name: type }). Returns `{ key, version, logic, schema, columns, issues, stats, rows }` with the values per column in `res.data` (`rows` is built on first use) |
| `stringify(res, onChunk?)` | the canonical JSON text; with `onChunk` it is handed out in pieces (the VM writer streams it) |
| `objects(res)` · `fromJSON(doc)` | rows as objects · a parsed document back into a result |
| `useOffices(mod, costCentres)` | the office module and the old SAP cost centres (`data/costcenter.json`); both sides load the same list, which is part of `logic` (`+cc56`) |
| `parseText` · `eachRow` · `fieldNames` · `baseName` · `parseNumber` · `parseDate` · `isIdName` · `schemaHash` · `hash32` | the pieces, for tests and tools |
| `VERSION` | `uniform/1`; bump on any output change, together with `?v=` of `/lib/uniform.js` in `mzo_rows.js` |

### `mzo_rows.js` (`window.MzoRows`)

Load it after the kit: `<script src="/mzo_rows.js?v=1" defer></script>` (with `mzo_data_hub.js` and `mzo_scope.js`; it loads `lib/offices.js` and `lib/uniform.js` itself, only when it has to build rows).

| | |
|---|---|
| `MzoRows.load(key, render, opts)` | `render(t, info)` from the cache at once, then again when newer rows arrive; `render(null, { error: true })` when nothing could be loaded. `opts.scope` (default `true`): `t.rows` holds only the login's offices; `opts.forceCheck`; `opts.hub` / `opts.url` / `opts.format` override the schema's source |
| `t` | `{ key, version, columns, rows, all, first(field), issues, stats, source: 'cache' \| 'mirror' \| 'local', ms }`. `rows` are objects keyed by field name (scoped); `all` is every row; `first(field)` the first non-empty value in sheet order over every row |
| `MzoRows.get(key, opts)` | Promise of the checked, current `t` (no early paint) |
| `MzoRows.refresh(btn, key, onRows, opts)` | wires a refresh button (forced check, spinner always cleared), like `UI.refresh` |
| `MzoRows.reload(key, opts)` | drops the cached rows and the raw DataHub body, downloads again (after an upload) |
| `MzoRows.scope(rows)` | the login-scope filter on uniform rows (canonical fields first; a row without a canonical office is matched on its own cells, as `MzoScope.filterRows` does) |
| `MzoRows.levels` | `UI.drill` levels on `_region` / `_division` / `_ccc` |
| `MzoRows.last[key]` | timings of the last delivery: `idb`, `fetch`, `build`, `where` (worker \| main), `parse`, `objects`, `bytes`, `total` (ms) |

A missing pinned column (header renamed in the sheet and not covered by an alias) logs `[MzoRows] <key>: missing columns …` and arrives as empty values; it is in `t.issues` as `header.missing`.

### `GET /api/data/rows/:key` (VM mirror mode)

Session required (`req.user`), key must match `^[a-z][a-z0-9_]{0,48}$`, must be in the manifest and not sensitive, must have `schema/<key>.json`, and the rows must be current: built from the manifest's snapshot version, with this process's `lib/uniform.js` + `lib/offices.js` + `data/costcenter.json` (hash) and the current schema text. Otherwise 404 with a `reason` (`off`, `unknown`, `no schema`, `stale`, `missing`), and the browser builds the rows itself from `/api/data/file/<key>`. A current file is served with `ETag` (hash of the rows bytes), 304 on `If-None-Match`, `Content-Encoding: br|gzip` from the precompressed copies, `Cache-Control: private, no-cache`, `Content-Type: application/json`.

The handler is `require('./vm/sync/lib/rows').handler({ dir, app, on, manifest })`; serve-api mounts it next to `/api/data/file/:key`:

```js
// server.js, after mirror.mount(app): uniform rows next to the snapshots (docs/uniform-data.md)
if (String(process.env.MZO_DATA_MODE || '').toLowerCase() === 'mirror') {
    try {
        app.get('/api/data/rows/:key', require('./vm/sync/lib/rows').handler({ dir: mirror.dir, app: __dirname, on: mirror.on, manifest: mirror.manifest }));
    } catch (err) { console.warn('[Mirror] uniform rows unavailable:', err.message); }
}
```

(`mirror.manifest()` resolves to `{ data, entries }` as in `lib/mirror.js`. On Vercel the route is never mounted and `vm/` is not deployed.)

### `vm/sync/rows.js` (VM)

`node --max-old-space-size=256 --max-semi-space-size=4 vm/sync/rows.js [--dir <snapshotDir>] [--only a,b] [--force] [--prune]` rebuilds the stale rows of every dataset that has a schema file, one at a time: `<key>.rows.json` + `.gz` + `.br` (temp files, then rename) and `<key>.rows.meta.json` (`snapshot`, `code`, `schemaFile`, `logic`, `rows`, `bytes`, `sha1`, `etag`, `builtAt`, `ms`). `--prune` removes rows of datasets that lost their schema or snapshot. The sync calls it at the end of each run, inside its lock, so a deploy that changes the code or a schema is picked up by the next sync run (5 minutes); until then the browser builds those rows itself. In `vm/sync/run.js`, right after the final `manifest();`:

```js
    // Uniform rows next to the snapshots (docs/uniform-data.md): rebuild the stale ones in a child
    // process with its own small heap, inside this run's lock. Never fails the sync.
    if (snapshotDir && !args.dryRun) {
        const rows = require('child_process').spawnSync(process.execPath, ['--max-old-space-size=256', '--max-semi-space-size=4',
            path.join(__dirname, 'rows.js'), '--dir', snapshotDir, '--prune'], { stdio: 'inherit', timeout: 10 * 60000 });
        if (rows.status) log('uniform rows: exit ' + rows.status);
    }
```

### `schema/<key>.json`

One file per dataset that pages read through `MzoRows`, named by the mirror's dataset key. It is the contract between the sheet and the pages: the pages rely only on the fields listed here.

```json
{
  "key": "solar_connections",
  "label": "Solar connections",
  "source": { "hub": "CACHE_SOLAR", "format": "csv" },
  "pages": ["solar.html"],
  "keep": "pinned",
  "fields": {
    "solar_appl_no": { "type": "text" },
    "load_appl": { "type": "number" },
    "creation_date": { "type": "date", "order": "dmy" },
    "ccc_code": { "type": "text", "aliases": ["CCC CODE (HES)", "ccc_code_hes"] }
  }
}
```

| Field | |
|---|---|
| `source` | where the browser gets the raw body: `hub` (a `CACHE_*` key in `mzo_data_hub.js`) or `url` (a direct sheet URL, registered with DataHub at run time as `ROWS_<KEY>`), and `format` |
| `fields` | every field the pages read, with `type` (`text`, `number`, `date`, `bool`, `json`), `order` for dates (`dmy` / `mdy`), `aliases` (older or alternative headers, as written or as snake_case) |
| `keep` | `pinned`: only the listed fields (+ their `_raw` columns + offices) are in the rows; `all` (default): every column, inferred types for the unlisted ones |
| `header` · `header_row` · `skip_rows` · `date_order` | `header: false` for report sheets read by position (`col_a`, `col_b`, …); `header_row` (0-based) when title rows sit above the header; `skip_rows` (0-based, after the header: the PM Surya Ghar glossary row) |
| `offices` | optional office columns by role, `{ "codes": ["ccc_code"], "cccs": ["supp_off"], "divisions": [], "regions": [] }`, when `lib/offices.js`'s header rules pick the wrong ones; `false` for none |
| `label` · `pages` · `notes` | for people; not part of the schema hash |

**Header drift.** When a sheet renames a header, the field keeps its name if an alias matches (`header.alias` issue), else it arrives empty (`header.missing`): the page shows zeros or blanks and the console names the column, instead of breaking. The mirror's data-quality checks can report both from the rows meta (`issues`), next to `header.drift`.

## Performance budget

| | Budget | Measured (2026-11-01, M-series laptop, headless Chrome) |
|---|---|---|
| Rows payload vs raw (brotli) | not larger | solar 261.6 KB vs 320.2 KB raw (−18 %); nsc 262.7 KB vs 284.4 KB (−8 %), with `keep: pinned`. With `keep: all` it is 0–12 % larger than raw (the office columns): pin fields on big datasets |
| Build in a worker | < 1 s for a 10 MB sheet on a laptop | nsc 51 ms, solar 58 ms; largest: meter_erp (18.7 MB) 610 ms, meter_master (282k rows) 1.9 s, withheld (11 MB) 450 ms. Phones: ×3–5 |
| Warm paint (cached rows) | no slower than today | 20–30 % faster (timing table below) |
| VM build | one dataset at a time, ≤ 300 MB RSS | meter_erp, all columns, Node with the sync's heap flags: 265 MB peak RSS, 0.47 s; nsc + solar together 0.32 s |
| IndexedDB | one value per dataset | the rows JSON text (2.0–2.1 MB for nsc / solar); DataHub keeps its raw copy until every page of that dataset is converted |

### Prototype timing (first data paint)

From navigation start to the moment the stat cards hold numbers and the table shows a row; median of 5 loads, headless Chrome on an M-series laptop, local app. *Cold*: empty browser storage. *Warm*: the second load in the same browser. "×4 CPU" throttles the CPU four times (roughly a mid-range phone). Before = develop, after = this branch.

| Page | Mode | Cold before → after | Warm before → after |
|---|---|---|---|
| solar | original, live Google | 3,925 → 4,202 ms | 113 → 91 ms |
| nsc | original, live Google | 1,656 → 1,562 ms | 107 → 96 ms |
| solar | original, local bytes, ×4 CPU | 569 → 528 ms | 314 → 213 ms |
| nsc | original, local bytes, ×4 CPU | 525 → 491 ms | 362 → 250 ms |
| solar | mirror | 239 → 122 ms | 115 → 84 ms |
| nsc | mirror | 170 → 128 ms | 101 → 85 ms |
| solar | mirror, ×4 CPU | 533 → 372 ms | 313 → 211 ms |
| nsc | mirror, ×4 CPU | 535 → 413 ms | 323 → 251 ms |

"Live Google" cold loads are dominated by the 2–3 MB download (individual runs 3.5–4.5 s for solar, before and after alike). In mirror mode "before" is the old page with its Google requests answered from the same local snapshot bytes (what DataHub's mirror mode does through `/api/data/file/<key>`), "after" is MzoRows reading `/api/data/rows/<key>` through the local stub. Warm loads are 20–30 % faster everywhere (no CSV parsing: one IndexedDB read and `JSON.parse`); the gain grows on slower CPUs.

Payload (bytes on the wire for the dataset, brotli):

| Dataset | Raw CSV | Raw, br | Rows JSON (schema) | Rows, br |
|---|---|---|---|---|
| solar_connections | 2,737,501 | 320,187 | 2,115,454 | 261,584 (−18 %) |
| nsc_pending | 2,140,781 | 284,368 | 2,039,872 | 262,719 (−8 %) |

Without a schema (`keep: all`) rows are 0–12 % larger than the raw sheet after brotli (withheld 1.44 MB vs 1.41 MB, meter_erp 472 KB vs 422 KB): pin the fields of big datasets.

## Conversion recipe (one page)

1. **Read the page's inventory section** ([uniform-data-inventory.md](uniform-data-inventory.md)): datasets, raw columns, quirks. Check the batch owns the dataset's schema (else add fields to the owner's file in a separate commit).
2. **Write or extend `schema/<key>.json`.** `source.hub` = the page's `CACHE_*` key (or `source.url` for a direct fetch). List every raw column the page reads under its snake_case name with its type: identifiers, codes, phones and anything compared as a string → `text`; amounts and counts → `number`; dates → `date` with `order`; Y/N flags → `bool` only if the page tests them as flags; a column the page only tests for presence → `text`. Use `keep: pinned`. Check the names against the data: `node -e "…build(…)"` or the row parity tool prints them.
3. **Load rows instead of text.** Add `<script src="/mzo_rows.js?v=1" defer></script>`. Replace `UI.load(KEY, fn)` with `MzoRows.load('<key>', fn)` and `UI.refresh(btn, KEY, fn)` with `MzoRows.refresh(btn, '<key>', fn)`; `hub.refresh(KEY)` + `_peek` becomes `MzoRows.reload('<key>')`. The callback gets `t` (or `null` + `info.error`).
4. **Map fields, keep the page's own rules.** In the parse/prepare function, `UI.csv(text)` → `t.rows`; `d['CCC CODE']` → `d.ccc_code`; drop `parseFloat/parseInt/Number/replace(/,/g)` (`d.load_appl || 0`; keep `Math.trunc` where `parseInt` truncated); `UI.date(d.X)` stays (it reads the ISO strings); `String(x||'').trim()` is not needed for text fields (always trimmed strings); `x === 'Y'` → `x === true` for bool fields. Status, bucket and label rules stay exactly as they are.
5. **Offices.** Use `d._region`, `d._division`, `d._ccc` (and `d._ccc_code`) instead of `UI.office`/`MzoScope.*NameOf`/custom maps. Keep the page's display fallback for unknown offices from the raw column (`d._ccc || d.supp_off`), so unmapped rows still show as before; an office the canonical list should know goes to `lib/offices.js` as an alias, not into the page. Pages still on `_divn`/`_supp` keep those keys in their own row objects (`_divn: d._division`), or pass `MzoRows.levels` to `UI.drill`.
6. **Scope.** Default: `t.rows` is already scoped; remove the page's `MzoScope.filterRows` on those rows. If the page dedupes before scoping (NSC: last row per `APPL_NO`), load with `{ scope: false }`, dedupe, then scope as before. **Values that live in one row of the sheet** (report dates, "cell N2") come from `t.first('field')` or `t.all`, never from scoped rows: a scoped user may not have that row.
7. **Check row parity** (below) until every difference is either zero or explained in the page's `known` list, then page parity in the browser, as admin and as a scoped user, in both modes. Fix scope leaks you find (inventory, cross-cutting finding 1).
8. **Ship.** `node --check` the inline script, light/dark/phone as AGENTS.md says. Bump the page's entries only; leave `sw.js` `CACHE_NAME` and `version.json` to the release.

## Parity method

Three levels, cheapest first. All of them use the same local snapshot folder, so the old and the new page see the same bytes (build one GET-only: serve-api's `vm/dev/make-snapshots.js`, or copy a sync run's `MZO_SNAPSHOT_DIR`).

1. **Rows, in Node** — `node scripts/qa/uniform-rowparity.js <page> --snap <dir>`: runs the page's old parse code (from `git show HEAD:<page>`, on `UI.csv` of the raw snapshot) and its new parse code (on uniform rows from `lib/uniform.js`) in one context with the real `mzo_ui.js`, `mzo_scope.js` and `mzo_rows.js`, as admin and as a region, a division and a CCC user, and compares every row object the page builds and the header text it writes (as-on dates). A page is described in its `PAGES` table: the code region (from/to markers), how to call it, which fields are shown through `UI.fmtDate` (compare what is shown), and the **known differences** with the reason. Exit 1 on anything unexplained.
2. **Pages, in the browser** — `node scripts/qa/uniform-pages.js parity --old <base> --new <base>,<base> --snap <dir>`: the old page (a copy of develop) and the new page in original mode and in mirror mode, Google and Storage requests answered from the snapshot folder, as admin and as a division user. It records stat cards, facet counts, level tabs, table rows and totals and the as-on date on load, after each stat card, each tab, each drill level (first row opened at every level) and each deep link, and diffs them. the app-wide parity harness (`scripts/qa/parity.js`) then covers the rest of the app the same way (`--pages <key>`), plus phone width and console errors.
3. **Bytes, Node vs browser** — `node scripts/qa/uniform-identity.js --snap <dir> --base <app>` after any change to `lib/uniform.js` or `lib/offices.js`.

Local setup used for the prototype (no PocketBase needed): the app under test on 3801 and a copy of develop on 3802, both with parity-qa's write guard plus an Apps Script block; `scripts/qa/uniform-stub.js --port 3800 --app http://127.0.0.1:3801 --mirror <snapshotDir>` (mirror mode: manifest, files and rows from the folder, everything else proxied) and the same without `--mirror` on 3804 (original mode: 204 manifest, like Vercel). `node vm/sync/rows.js --dir <snapshotDir>` builds the rows files first.

### Prototype parity (solar.html, nsc.html; 2026-11-01 snapshots)

| Check | solar.html | nsc.html |
|---|---|---|
| Rows, Node: admin / region / division / CCC user | 6,827 / 1,778 / 881 / 161 rows, same as before; every field equal except 2 known differences | 5,140 / 2,574 / 737 / 41 rows; **0 differences** in any field |
| Browser, admin, original mode and mirror mode | 21 states (load, 4 stat cards, 4 level tabs, 4 drill levels, 8 deep links): equal except the "kW applied" total and the load facet (known difference 2) | 35 states (load, 7 stat cards, 12 tabs, 4 drill levels, 12 deep links incl. every `?kpi=`): **0 differences** |
| Browser, division user (Gazole), both modes | 17 states: **0 differences** (after the as-on fix below) | 35 states: **0 differences** |
| Console errors | none new | the same 15 as before (Apps Script requests blocked by the test, one 404) |

Known differences, both in the source data:

1. solar: 76 applications with `QUOTATION_DUE_DATE` = `(null)`: the old drawer showed "Quotation due —", the new one leaves the line out.
2. solar: one broken sheet row (a line break inside a cell shifted its columns) has `03-10-2026 08:21` in `LOAD_APPL`. `parseFloat` read it as 3 kW; uniform rows keep it in `load_appl_raw` and count 0. Applied load: 55,418 kW before, 55,415 kW now; one application moves from the "2–3 kW" to the "Up to 2 kW" facet. The row is a `type.unparsed` issue for the sheet owner.

Found and fixed during the prototype: a division user lost solar's "As on" date, because the only `Report Date` cell is in a row outside that division and the first version read it from scoped rows. `t.first()` / `t.all` exist for this (recipe step 6), and the row parity tool now compares the header text too.

## Design decisions

The lead's proposal (one isomorphic module, columnar rows, VM precompute + browser fallback in a worker, IndexedDB by version, per-dataset alias map) is what was built. Where it differs, and why:

1. **The parser follows `UI.csv`, not the mirror's csv-parse.** Pages' numbers must not move. Both give identical cells on every local snapshot, but where malformed quotes appear, `UI.csv` is what pages showed until now. The VM writer uses the same parser, so the rows file and PocketBase can only differ in types and empties, not in cells.
2. **Empty is `null` (typed) or `''` (text); dates keep the sheet's wall clock.** PocketBase stores 0 and UTC instants; pages need "no value" to stay distinguishable (NSC falls back to the paid date when `DelayInSC` is empty) and `UI.date()` to give the same local date as before in any time zone.
3. **Two inference rules beyond the mirror** (placeholders ignored, identifiers stay text; 144 of 1,443 columns). Without them a phone column with a few landlines, or a date column with `(null)` cells, would change type from one day to the next. Proposed to sync-core: use `lib/uniform.js`'s `build`/`chooseType` for PocketBase too, so the portal and the pages show the same types (open question 1).
4. **Pages read only pinned fields, and rows exist only for datasets with a schema.** The schema doubles as the alias map and as the list of columns to ship (`keep: pinned` makes rows smaller than the raw sheet) and to watch for drift. The VM builds no rows nobody reads.
5. **Rows are built after the sync, not inside it.** `vm/sync/rows.js` runs from the sync's lock in its own capped process, keyed by snapshot sha1 + code hash + schema text hash. The server never serves rows built by other code or another schema; the browser then builds its own. This keeps sync-core's framework untouched apart from a 7-line hook.
6. **The browser caches the rows JSON text, in its own IndexedDB database.** One read + `JSON.parse` is faster than structured clone of millions of cells, and a separate database leaves DataHub's store and version untouched while other pages still read raw bodies.
7. **Objects, not accessors.** Pages build their own row objects anyway; one object per row with a fixed key order costs 10–30 ms for 5–7k rows. Dictionary-encoded columns (smaller JSON, shared strings) are a later option for the 200k-row meter sheets.
8. **Scoping moved into `MzoRows`** (canonical office fields), with `t.all` / `t.first()` for single-cell values; a page that needs unscoped rows says `scope: false`.
9. **Offices come from `lib/offices.js`** (one isomorphic module owned by the office work), loaded with the same cost-centre list on both sides; its version and the cost-centre count are part of `logic`.

## Risks and open questions

1. **Types in PocketBase vs rows.** Until the sync uses `lib/uniform.js` for type inference, the portal shows `con_id` as a number and the rows as text (144 columns). Decide whether sync-core adopts `build()`'s inference (changes PocketBase field types once).
2. **Single-cell values.** Report dates and base dates live in one row; a page that reads them from scoped rows shows nothing to scoped users (caught on solar). The recipe and `t.first()` cover it; an `as_on` field per dataset in the rows document (from the sheet cell, the meta, or the manifest's `sourceModifiedAt`) would also serve sheet_links and the briefing.
3. **Raw body still cached twice** (DataHub raw + rows) on the original path until all pages of a dataset are converted; then DataHub could stop keeping the raw body for those keys.
4. **Memory on the VM.** Rows for the 18.7 MB meter_erp take ~265 MB RSS in a child process while the sync process waits; with `keep: pinned` far less. Watch `free -m` on the first deploy; the hook can skip datasets above a size until pruned.
5. **Phone CPU.** meter_master (282k rows) takes ~2 s in a laptop worker, so 6–10 s on a mid phone on the first visit after a change in original mode; mirror mode avoids it. Dictionary encoding or pruning helps.
6. **Deploy-time staleness.** After a deploy that touches `lib/uniform.js`, `lib/offices.js`, `data/costcenter.json` or a schema, rows are rebuilt at the next sync run (≤ 5 min); meanwhile browsers build their own (slower first paint, same numbers).
7. **Compact dates** (`yyyymmdd`, `yyyymm`) stay numbers, as in the mirror; a schema `format` hint could turn them into dates (uniform/2).
8. **`version` differs by path** (snapshot sha1 vs DataHub version string); everything else is byte-identical. Anything comparing rows across paths must ignore it.
