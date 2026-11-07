# MZO Reports: start here

A guide for a developer taking over or joining the project. It covers what the app is, where every number comes from, how the two hosts are set up, and how to work on it without touching production data. Details live in the existing docs; this page links to them rather than repeating them.

Read these next, in this order:

1. [Repository rules](../AGENTS.md): the never/always rules everyone follows.
2. [README.md](../README.md): repository map and the documentation index.
3. [architecture.md](architecture.md): pages, sign-in and office scope, DataHub, service worker, server API, mirror mode.
4. [vm.md](vm.md) and [data-mirror.md](data-mirror.md) if you will touch the VM.

## 1. What it is

**MZO Reports** is a sign-in-only progressive web app for the **Malda Zone of WBSEDCL** (West Bengal State Electricity Distribution Company Ltd). Zone, region, division and CCC officers use it on desktop and phone to follow new service connections, revenue and losses, consumers and meters, substations and field work for the zone's 3 regions, 7 divisions and 41 CCCs.

- Plain HTML/CSS/JS pages (about 66) served by a small Express server, `server.js`. No framework, no build step.
- Report data mostly comes from **Google Sheets** that office staff keep up to date, plus **Supabase** (Postgres and Storage) for sign-in, logs, stock, Power Map and uploaded dumps.
- The browser fetches and caches the data itself (IndexedDB); the server handles sign-in, admin and small JSON endpoints.

### The main pages (the sidebar, `NAV` in `app.html`)

`app.html` is the shell: sidebar (a drawer on phones), Ctrl/⌘K search, favourites, and report pages in keep-alive iframes. The home item is **Briefing** (`executive_briefing.html`); **Ask** (`assistant.html`) answers questions in plain language and opens filtered reports.

| Group | Pages |
|---|---|
| New service connection | Pending NSC (`nsc.html`), Historical analysis, NSC KPIs (`nsc/kpi.html`), Weekly deposit vs disposal, Pending master card, Withheld, Pending load extension, Solar, JJM, Meter utilization, WRIDD schemes, Bharat Net, ICDS |
| Revenue | Losses, Performance index, Collection, Disconnection tracker, Theft assessment, REM OSD > ₹5,000, REM defaulters (`rem/defaulters.html`) |
| DD visit | Upcoming DD (`dd/upcomingDD.html`), DD visit (`dd/dd_visit.html`) |
| Consumers & meters | Defective meter, Unbilled & exceptions (`consumer/unbilled.html`), Consumers, Docket calls, Docket KPI, Smart meter utilization |
| Vendor advances | Capex summary (`capex_all.html`), O&M summary (`advance_onm.html`) |
| Substation & network | Power map (`power_map/map.html`), Line–highway crossings, PRT / transformer records (`prt-oil/`), Feeder outage |
| Important | Performance index, CMO grievance, PM Surya Ghar, Priority SI works (`si-works/si.html`), JJM report, Accident reports, Safety app reports, Manpower report, Substation upkeeping, DTR records, Peak load measurements, Health check-up, Durga Puja 2026, Stock, Important data sheets, Sheet links |
| Media | Power news hub |
| Administration (admins only) | Users, Sources, Activity, Visitors, Power map edits, Corrections (all `admin_users.html?tab=…`), Structure (`admin.html`) |

URLs are bookmarked and shared: never rename or move a served page; leave a redirect if one must move.

## 2. Architecture in one page

```
 browser (page in app.html)                         server.js (Express)
 ├─ auth.js / mzo_scope.js  ── session, office scope ─▶ /api/auth/*, /api/session-check
 ├─ mzo_data_hub.js (DataHub) ── fetch CSV/JSON ─────▶ Google Sheets (published CSV, gviz, export)
 │    IndexedDB cache + cheap version checks          Supabase Storage (public CSV + meta.json)
 │                         └── small meta JSON ──────▶ /api/<report>/meta, /api/hub/versions
 ├─ uploads: processed in the browser ──────────────▶ Apps Script web apps (chunked POST) / Supabase Storage (signed PUT)
 └─ sw.js (service worker), mzo_app_update.js (update notice from /version.json)
```

- **DataHub** (`mzo_data_hub.js`, `DATASETS`): every report dataset is registered with its origin URL. A page paints from IndexedDB at once, then revalidates cheaply (meta JSON, HEAD/Range probe, ETag) and downloads only when the version changed. Report bodies must not pass through the server on Vercel. See [architecture.md → DataHub](architecture.md#datahub).
- **Uniform rows** (`mzo_rows.js`, `lib/uniform.js`, `schema/*.json`): converted pages get typed snake_case rows with a canonical office per row. See [uniform-data.md](uniform-data.md).
- **UI kit** (`mzo_theme.css`, `mzo_theme.js`, `mzo_ui.js`): the "Graphite" design system; new pages use it. See [design-system.md](design-system.md). Values from sheets and tables go into HTML only through `UI.esc` or, on pages without the kit, `mzoEsc` (`mzo_esc.js`); values for inline handlers go in `data-*` attributes.
- **Server** (`server.js`, about 5,200 lines): session cookie `mzo_session` (HMAC with `JWT_SECRET`, 24 h), Google sign-in, admin APIs, small meta endpoints, upload helpers, Power Map edits, stock allotments, the Briefing, news and Ask. Static files are public; pages gate themselves with `auth.js`, and `/api/*` needs a session. A list of non-served paths is in `PRIVATE_PATH` (matched on the decoded path). API writes (any method but GET, HEAD and OPTIONS) must carry this host's `Origin`, or its `Referer` when there is no `Origin`; only the CRM upload routes also take a key or token header instead. The session cookie is `SameSite=Strict`.
- **Uploads**: NSC, Withheld, Stock and Defective meter files are processed **in the browser** and posted in chunks to Apps Script web apps (`lib/sheet_mirror_client.js`, sources in `apps-script/`, see [apps-script.md](apps-script.md)); the stock dump goes to Supabase Storage through a signed URL ([stock.md](stock.md)). The four "synced" reports (disconnection, defective meter, pending MC, load extension) are copied from their Google sheet to the Supabase `reports` bucket by `scripts/sync/*` (also triggered from the page by authorised users).
- **Office scope**: comes only from the signed-in profile (`role`, `zone_code`, `region_code`, `division_code`, `ccc_code`). Pages call `MzoScope.filterRows(rows)` right after parsing; office names and codes resolve through `lib/offices.js`. Admins and zone users are unscoped. No per-page office preferences. See [architecture.md → Auth and office scope](architecture.md#auth-and-office-scope).
- **Sign-in**: Google only (`POST /api/auth/google`, token checked with Google's tokeninfo against `GOOGLE_CLIENT_ID`), matched by saved email to `mzo_insight.portal_users` in Supabase; new emails wait for admin approval. On the VM there are also password-only "VM-only admin" accounts (`MZO_LOCAL_ADMINS`). See [database.md → Login rules](database.md#login-rules) and [vm.md → VM-only admin accounts](vm.md#vm-only-admin-accounts).

## 3. Where the data comes from

There are two hosts (section 4). **On Vercel every page reads the original sources live.** On the VM the app runs in **mirror mode**: a sync copies the sources into PocketBase and keeps raw snapshots, and pages read those copies from the VM itself (`/api/data/*`), falling back to the original on any failure. Schedules are the mirror's: `frequent` = every 5 minutes, `hourly`, `daily` (once per India day after 02:00 IST). Keys in `code` are the mirror's dataset keys (`node vm/sync/run.js --list` prints all 109).

### VM copies of Google Sheets

| Report | Mirror keys | Refresh |
|---|---|---|
| Pending NSC, NSC KPIs | `nsc_pending` | 5 min |
| Withheld | `withheld` | 5 min |
| Historical NSC | `historical_nsc` | daily |
| Weekly deposit vs disposal | `weekly_report` | hourly |
| Solar | `solar_connections` | hourly |
| JJM | `jjm_connections` | 5 min |
| Meter utilization (4 sheets) | `meter_erp`, `meter_master`, `meter_crm`, `meter_isu` | daily |
| WRIDD | `wridd_schemes` | hourly |
| Bharat Net | `bharatnet_connections` | 5 min |
| ICDS (A and A+) | `icds_a`, `icds_a_plus` | hourly |
| Losses + targets | `loss_report`, `loss_targets` | 5 min |
| Collection | `collection_report` | hourly |
| Theft assessment | `theft_assessment` | daily |
| REM OSD > ₹5,000 | `rem_osd` | hourly |
| REM defaulters (Ind/Com, Agri, Dom) | `rem_defaulters_*` | hourly |
| Consumers | `consumers` | hourly |
| Docket calls / Docket KPI | `docket_calls`, `docket_kpi` | 5 min |
| Smart meter | `smart_meter_status` hourly, `smart_meter_work_orders` daily | hourly / daily |
| Capex | `capex_details` | daily |
| O&M | `onm_advance` | hourly |
| Vendor map (capex and O&M) | `vendor_map` | daily |
| Feeder outage | `feeder_outage` | hourly |
| Line–highway crossings | `highway_crossings` | hourly |
| PRT records | `prt_transformers`, `prt_oil_tests` | 5 min |
| Power map tap points | `power_map_taps` | hourly |
| CMO grievances | `cmo_grievances` | 5 min |
| PM Surya Ghar (3 districts) | `pmsgy_*` | daily |
| Accident reports | `accident_reports` | hourly |
| Safety app reports | `safety_inspection` | daily |
| DTR records | `dtr_records` | daily |
| Peak load measurements | `dtr_peak_load` | 5 min |
| Stock materials (rates, categories) | `stock_materials` | hourly |
| Important data sheets (17 tabs: 8 monthly unbilled reports and 9 others) | `important_*` | daily |

Also copied, but only for the admin data portal (the pages read elsewhere): `nsc_followups`, `dd_summary`, `substation_upkeeping` and the six Durga Puja sheets.

### VM copies of Supabase

| What | Mirror keys | Refresh |
|---|---|---|
| Storage CSVs: pending master card, load extension, disconnection, defective meter (summary and details), stock dump | `pending_mc`, `load_extension`, `disconnection`, `defective_summary`, `defective_details`, `stock_snapshot` | 5 min |
| Stock allotments | `stock_allotments` (+ `stock_allot_seq` hourly) | 5 min |
| Power map substations | `power_map_substations` (+ corrections hourly) | hourly |
| Important data sheets month list | `important_unbilled_months` | 5 min |

The report `meta.json` files next to the Storage CSVs (report date, KPIs) are still read live. The full Supabase list, including tables only the portal shows, is in [vm/sync/sources/supabase.md](../vm/sync/sources/supabase.md).

### VM-only, repo files, and computed

- **Uploaded datasets (unbilled & exceptions, disconnection list and payments)**: `/api/unbilled/*` and `/api/disconnection/{dataset,payments,meta}` serve `unbilled_outsort.csv`, `unbilled_chronic.csv`, `unbilled_summary.csv`, `disconnection.csv`, `disconnection_payments.json` and their meta from the server's data folder (`MZO_FILES_DIR`: `/opt/mzo/data/files` on the VM, outside the releases; the git-ignored `data/` locally). The owner's CRM (DB2) syncs write them and upload them to the VM with `x-sync-key` (`npm run sync:unbilled:crm`, the disconnection and payment syncs), which needs the office network. They need a signed-in session (or the sync key on these read routes) and are never in git. Off the VM, a server with the sync key fetches the VM's copy server-side; pages always call their own origin.
- **Repo files**: `data/structure.csv` (estimate structures) and `data/costcenter.json` (old cost centres), mirrored daily.
- **Performance index**: on the VM the sync computes the rating from the snapshots after a run (at most every 15 minutes, `vm/sync/rating.js`) and serves it at `/api/data/rating`. Anywhere else, and as the VM's fallback, the browser computes it from the report data (`lib/rating_metrics.js`, `lib/rating.js`). See [reports.md → Performance index](reports.md#performance-index) and `docs/rating/`.

### Live Google, never copied as snapshots (sensitive or embedded)

- **Manpower** (staff bank, PF and pay details; page PINs): mirrored into PocketBase for the portal only, no snapshot; the page reads Google.
- **Upcoming DD** (consumer Aadhaar and PAN) and **DD visit** (PAN): the same; DD visit history goes through Apps Script.
- **Durga Puja**: the page embeds the published sheet in an iframe.

### Live Supabase

- Sign-in, users, activity logs and the admin tabs (the insight project when `INSIGHT_LIVE` is on, as on the VM; otherwise the old project).
- **Priority SI works**: the page talks to the old Supabase project directly with supabase-js (reads and writes). The mirror copies the table hourly for the portal only.
- **Briefing**: the server reads the report `meta.json` files from public Storage (cached 60 s each) and the NSC upload meta through Apps Script. In mirror mode the result is kept in memory: answered at once while under 10 minutes old, refreshed in the background after 2 minutes and right after a relevant write.

### Live Apps Script (the mirror never calls Apps Script)

NSC follow-ups list and posting, disconnection follow-ups, DD visit history and entry forms, the PRT "Map" tab, the DTR load search, every upload, and the report-dates metadata script used by Sheet links.

### Other

- **Power news hub**: Google News RSS, fetched by the server (`/api/news`).
- **Ask**: the server holds the key and calls the model: Gödel Machines (DeepSeek V4.1 Flash, OpenAI-compatible, `GOEDEL_API_KEY`) or the Anthropic Messages API (Claude Haiku, `ANTHROPIC_API_KEY`), chosen by `ASSISTANT_PROVIDER` (`lib/assistant/`); tools run in the browser on already-scoped data. See [assistant.md](assistant.md).
- **Substation upkeeping**: a link to a separate app (`mzowbsedcl-dev.github.io/Upkeeping`).
- **Health check-up**: placeholder, no data yet.

## 4. Hosting

| | Production | VM (staging and data mirror) |
|---|---|---|
| Branch | `main` | `develop` |
| App | https://mzo-reports.vercel.app | https://130.210.43.11.sslip.io |
| Other | | Admin data portal https://data.130.210.43.11.sslip.io (PocketBase API at `/api/`, dashboard at `/_/`), VM stats https://stats.130.210.43.11.sslip.io |
| Deploys | Vercel Git integration (Smart Lineman team project); the owner merges into `main` | the VM pulls `develop` by itself every 60 s |
| What is live | https://mzo-reports.vercel.app/version.json | https://130.210.43.11.sslip.io/deploy.json and `/version.json` |
| Data | originals, live | mirror mode (section 3) |

Note: production currently runs an older baseline (version 2.66.1, a deliberate rollback on 2026-11-04) while `develop` is at 3.2x. `main` is several hundred commits behind and still has pages `develop` has removed (the old `index.html` home, the `adv_*`, `estimate-generator/`, `election.html` pages and others), so the next promotion to `main` needs a check of which old URLs need redirects. Vercel details: [deploy.md](deploy.md).

### The VM

Oracle Cloud VM (Oracle Linux, 1 GB RAM plus swap, user `opc`). Everything it runs is in `vm/` in the repo; none of `vm/` is served by Vercel or `server.js`. Full reference: [vm.md](vm.md).

**systemd units and timers**

| Unit | Does |
|---|---|
| `mzo-reports.service` | the app: `node server.js` on 127.0.0.1:3000 as `opc`, from `/opt/mzo/app`, with `MZO_DATA_MODE=mirror`, `MZO_SNAPSHOT_DIR=/opt/mzo/data/snapshots`, `SYNC_TMP_DIR=/opt/mzo/data/sync-tmp`; env from `/etc/mzo/pocketbase.env` and `/etc/mzo/app.env` |
| `pocketbase.service` | PocketBase 0.40.6 on 127.0.0.1:8090 as user `pocketbase`, data in `/opt/mzo/pocketbase/pb_data`, migrations from the live release, `--automigrate=false` |
| `mzo-sync.timer` → `mzo-sync.service` | every 5 minutes: `node vm/sync/run.js --due` (each source's schedule decides if it is due), then the data quality checks and the rating |
| `mzo-deploy.timer` → `mzo-deploy.service` | 60 s after the previous run finished: `/opt/mzo/bin/deploy.sh` |
| `mzo-stats.service` | `vm/stats/sampler.py`: CPU, memory, disk, services every 5 s for the stats site |
| `caddy.service` | Caddy with `/etc/caddy/Caddyfile` (from `vm/deploy/Caddyfile`): TLS for the three sslip.io names, reverse proxy to the app and PocketBase |

Unit files and drop-ins are in `vm/deploy/systemd/`; deploys install changed ones.

**Paths**

| Path | What |
|---|---|
| `/opt/mzo/app` | symlink to the live release |
| `/opt/mzo/releases/<sha>/` | one folder per deployed commit (a few kept) |
| `/opt/mzo/deps/` | `node_modules` sets shared between releases |
| `/opt/mzo/bin/deploy.sh` (+ `.prev`) | the pinned deploy script the timer runs |
| `/opt/mzo/state/deployed.json` | the deploy record, served as `/deploy.json` |
| `/opt/mzo/data/snapshots/` | raw snapshots and `manifest.json` |
| `/opt/mzo/data/sync-tmp/`, `/opt/mzo/data/quality/` | sync spool and lock; quality-check state |
| `/opt/mzo/pocketbase/` | binary and `pb_data/` |
| `/opt/mzo/backup/` | provisioning backups (root only) |

**Credentials (names only; values are on the VM and with the owner)**

| File | Keys |
|---|---|
| `/etc/mzo/app.env` | `JWT_SECRET`, `GOOGLE_CLIENT_ID`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `INSIGHT_SUPABASE_URL`, `INSIGHT_SUPABASE_KEY`, `INSIGHT_LIVE`, `STOCK_USE_STORAGE`, `MZO_LOCAL_ADMINS`, `UNBILLED_SYNC_SECRET` and `DISCONNECTION_SYNC_SECRET` (the CRM upload key, 32+ characters; the owner's `scripts/sync/sync_*_from_crm.js` set the same value; unset: off) |
| `/etc/mzo/pocketbase.env` | `PB_URL`, `PB_SUPERUSER_EMAIL`, `PB_SUPERUSER_PASSWORD` |
| `/etc/mzo/portal-admin.txt` | the first data-portal account (root only) |
| `/etc/mzo/deploy.env` | optional, `MZO_BRANCH` (not present: the VM follows `develop`) |

**Deploy flow.** Every 60 s `deploy.sh` reads the head of `develop` from GitHub's ref list; if it is new, it downloads the codeload tarball into `/opt/mzo/releases/<sha>`, links packages, switches `/opt/mzo/app`, installs changed units, restarts the app and health-checks `/login.html` and `/app.html`. Healthy: applies a changed Caddyfile, restarts PocketBase if its migrations changed, records `status: ok`. Unhealthy: rolls back to the previous release and records `rolled_back` with `failedCommit`. GitHub Actions (`vm-deploy.yml`) waits for `/deploy.json` to show the pushed commit. Manual commands (`--force`, `--to <sha>`, `--rollback`) are in [vm.md → How a deploy works](vm.md#how-a-deploy-works). Never edit files under `/opt/mzo/app`; the next deploy replaces them.

**Access.** `ssh -i <key> opc@130.210.43.11`. The key is **not** in this package or the repo: ask the owner for access. Only ports 22, 80 and 443 are open. Logs: `journalctl -u mzo-reports -u mzo-sync -u mzo-deploy -u pocketbase -f`.

**Memory.** The VM froze once when a package install used all its memory. Do not run `dnf` on it; see [vm.md → Memory](vm.md#memory) for the OOM order and limits.

## 5. The data mirror

Full reference: [data-mirror.md](data-mirror.md), Supabase part [vm/sync/sources/supabase.md](../vm/sync/sources/supabase.md), portal [vm/portal/README.md](../vm/portal/README.md), quality checks [data-quality.md](data-quality.md).

- **Sources**: `vm/sync/sources/google.js` (Google Sheets), `supabase.js` (tables and Storage files), `files.js` (repo files). 109 sources. The sync only sends GET/HEAD requests and never calls Apps Script.
- **Storage**: one PocketBase collection `ds_<key>` per source, with types inferred by `lib/uniform.js` and system fields (`_row_key`, `_hash`, `_nulls`, office fields); `sys_datasets` is the registry, `sys_sync_runs` the run log, `sys_quality_*` the checks. Only portal accounts and superusers can read anything.
- **Schedules**: `frequent` 5 min, `hourly`, `daily` after 02:00 IST; failed sources retry within the hour; a full download is forced every 6 to 24 h.
- **Snapshots**: the exact source bytes as `<key>.csv|tsv|json` plus `.gz`/`.br` in `/opt/mzo/data/snapshots`, with `manifest.json` (sha1 version, URLs, DataHub keys, times). The app serves them at `/api/data/manifest` and `/api/data/file/<key>` (session required).
- **Fallbacks**: any failure in the browser (network, non-200, wrong type, short file) falls back to the original source for that dataset; a source that suddenly returns no rows, or stops being public, keeps its last copy. After a write the app does, a targeted "write-through" sync runs and the dataset is read live until it finishes.
- **Sensitive sources never get a snapshot** and are not in the manifest: `manpower_staff`, `manpower_pins`, `upcoming_dd`, `dd_visit`, `portal_users`, `activity_logs`, `dd_user_auth` and some Power Map staff tables. They are only in PocketBase, behind the portal sign-in.
- **Running a sync by hand** on the VM: `sudo systemctl start mzo-sync`, or one source as `opc`: `cd /opt/mzo/app/vm/sync && node --env-file=/etc/mzo/pocketbase.env run.js --only <key>`. Locally against your own PocketBase: [data-mirror.md → Running a sync by hand](data-mirror.md#running-a-sync-by-hand-vm).

## 6. Running locally, safely

> There is no development database. A local `server.js` with the real keys reads **and writes** production Supabase, Google Sheets and Apps Script.

**Use the guarded runner:**

```bash
npm ci
scripts/qa/serve-local.sh 3600                       # original mode on :3600
scripts/qa/serve-local.sh 3601 /path/to/snapshots    # mirror mode against a snapshot folder
kill "$(cat /tmp/mzo-qa-3600.pid)"                   # stop it (only your own process)
```

`serve-local.sh` preloads `scripts/qa/guard-writes.js`, which blocks every outbound request from the server that is not GET/HEAD/OPTIONS (for example the `page_visit` rows that every signed-in page view writes to Supabase). It starts `node server.js` directly, so it does **not** load `.env`. What it does not stop: writes the **browser** makes itself (Apps Script uploads and follow-ups, Priority SI through supabase-js, signed Storage uploads) and Apps Script GET calls with a write `action`. So even with the guard, do not save, upload, sync, allot, approve or delete anything from a local page.

A local snapshot folder for mirror mode: `node vm/dev/make-snapshots.js --out /tmp/mzo-snapshots` (GET only, about 60 MB).

**Why a plain `npm run dev` is risky.** `npm run dev` runs `node --env-file-if-exists=.env server.js`. With the owner's `.env` (service-role key, Google client ID, `INSIGHT_LIVE`), it signs real users in against the production user table, logs every page visit to production, and every button that writes goes to production sheets and tables. Use it only with a `.env` you understand, and never to "try" an upload or an admin action.

**Environment variables** (names only; full meaning in [deploy.md → Environment variables](deploy.md#environment-variables)):

- Session and sign-in: `JWT_SECRET`, `GOOGLE_CLIENT_ID`, `MZO_LOCAL_ADMINS` (VM only)
- Supabase, old project: `SUPABASE_URL`, `SUPABASE_KEY` / `SUPABASE_ANON_KEY`; Power Map: `POWERMAP_SUPABASE_URL`, `POWERMAP_SUPABASE_KEY`
- Supabase, insight project: `INSIGHT_SUPABASE_URL`, `INSIGHT_SUPABASE_KEY` / `SUPABASE_SERVICE_ROLE_KEY`, `INSIGHT_LIVE`, `REPORTS_PUBLIC_BASE`, `REPORTS_STORAGE_BUCKET`
- Stock: `STOCK_USE_STORAGE`, `STOCK_STORAGE_BUCKET`, `STOCK_STORAGE_OBJECT`
- Apps Script URLs: `NSC_SHEET_SCRIPT_URL`, `NSC_WITHHELD_SHEET_SCRIPT_URL`, `NSC_FOLLOWUP_SCRIPT_URL`, `STOCK_SHEET_SCRIPT_URL`, `STOCK_ALLOTMENT_SCRIPT_URL`, `DEFECTIVE_SHEET_SCRIPT_URL`, `DISCONNECTION_FOLLOWUP_SCRIPT_URL`, `METADATA_SCRIPT_URL`
- Sheet overrides for sync jobs: `DISCONNECTION_SHEET_CSV_URL`, `PENDING_MC_SHEET_CSV_URL`, `LOAD_EXT_SHEET_CSV_URL`, `DEFECTIVE_SUMMARY_CSV_URL`, `DEFECTIVE_DETAILS_CSV_URL`, `STOCK_SHEET_CSV_URL`, `STOCK_ALLOTMENTS_CSV_URL`
- Ask: `ASSISTANT_PROVIDER` (`goedel` | `anthropic`; unset: goedel when its key is set, else anthropic), `GOEDEL_API_KEY` (`GODEL_API_KEY` also accepted), `ANTHROPIC_API_KEY`, `ASSISTANT_MODEL`, `ASSISTANT_BASE_URL`, `ASSISTANT_MAX_CONCURRENCY`. Switching provider is an env change and a restart; see [assistant.md](assistant.md#providers-libassistant)
- VM / mirror: `MZO_DATA_MODE`, `MZO_SNAPSHOT_DIR`, `SYNC_TMP_DIR`, `MZO_QUALITY_STATE_DIR`, `PB_URL`, `PB_SUPERUSER_EMAIL`, `PB_SUPERUSER_PASSWORD`, `SYNC_BATCH_SIZE`, `SYNC_DEBUG`
- QA: `QA_COOKIE`, `QA_COOKIE_FILE`, `QA_JWT_SECRET`, `QA_OUT`, `PLAYWRIGHT_CORE_PATH`, `UNIFORM_SNAP`
- Other: `PORT`, `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`

Signed-in pages cannot be checked with an anonymous `curl`; use a real account, or the QA scripts, which sign a development session on localhost.

## 7. Tests and QA

There is no single test command. What exists:

| Command | Checks | Network |
|---|---|---|
| `node scripts/tools/check_syntax.js` | `node --check` on every JS file and inline `<script>`, JSON parse. CI runs it with `vercel.json`/`version.json`/`manifest.json` parsing, `sw.js` `CACHE_NAME` = `version.json` `cache`, and `bash -n` on `vm/deploy/*.sh` (`.github/workflows/ci.yml`) | none |
| `node vm/dev/test-mirror-server.js` | the server in both modes with every upstream answered from fixtures; any upstream write fails it | none |
| `node vm/dev/test-briefing-cache.js` | the Briefing cache in mirror mode | none |
| `node vm/dev/test-local-admin.js` | VM-only admin accounts | none |
| `node vm/dev/test-assistant-provider.js` | Ask's provider layer: translation to and from the OpenAI format, retries, errors, the concurrency gate, env settings, the Anthropic path, `server.js` end to end against a local mock | none |
| `node scripts/qa/assistant-live.js --env <file>` | Ask: tool-call accuracy and latency of the configured model on 15 typical questions, with made-up tool results only | the model API |
| `node --test scripts/qa/uniform.test.js`, `node --test scripts/qa/rating.test.js`, `node scripts/qa/rating-metrics-test.js` | uniform rows, rating engine and metrics | none (`UNIFORM_SNAP` adds snapshot checks) |
| `cd vm/sync && npm ci && npm run check` | sync syntax | none |
| `scripts/qa/parity.js`, `diff.js`, `timing.js`, `uniform-pages.js`, `legacy-pages.js`, `sheet-links-pages.js`, `rating-page.js` | browser parity of original vs mirror mode, page by page (Chrome and `playwright-core`) | GET only, against `serve-local.sh` instances |
| `scripts/qa/mirror-types.js` | the mirror's column types match `lib/uniform.js` | needs a PocketBase env file |
| `scripts/qa/speed.js <base>[,<base2>] <label>[,<label2>]`, `--compare <a> <b>` | page speed: cold and warm, 1440 px and 390 px with the CPU 4× slower, over an emulated VM link; bytes, requests, time to settled content, and whether the numbers shown are identical | GET only, against `serve-local.sh` instances |
| `scripts/qa/view-parity.js --snap <dir>` | every number a page view (`vm/sync/lib/views`) feeds equals the old page logic, row by row, for three logins | none (a snapshot folder with views built) |

Parity workflow and options: [vm.md → Parity checks](vm.md#parity-checks-mirror-mode-shows-the-same-numbers). By hand, for any page you change: load it signed in, light and dark, desktop and about 390 px wide, inside `app.html` and alone, with no new console errors (the checklist in the [repository rules](../AGENTS.md)).

## 8. Releasing

When users must receive changed HTML/CSS/JS, bump **together** in one commit:

- `version.json`: `version` (e.g. `3.23` → `3.24`), `cache` (e.g. `mzo-reports-cache-v317` → `-v318`), and `message` (the one-line "App updated" note users see; `force_update` stays `false` unless the owner asks);
- `sw.js`: `CACHE_NAME`, the same string as `version.json` `cache` (CI fails otherwise).

New pages also go into `isNetworkFirstPath` in `sw.js`; a new folder needs a static build entry in `vercel.json`; a changed shared file (`mzo_ui.js`, `mzo_theme.css`, `mzo_scope.js`, `mzo_data_hub.js`, `lib/offices.js`) gets a new `?v=` in every page that loads it. See [architecture.md → Service worker](architecture.md#service-worker).

## 9. Git workflow

- The repository is **`smartlinemanapp/mzo-reports`** on GitHub; ask the owner for collaborator access. Vercel builds from it and the VM pulls from it. Some checkouts also have a personal fork remote; [deploy.md](deploy.md) describes an older layout with a backup mirror (`UtilityDD/mzo_report_pwa`). Ask the owner which remotes to keep in step.
- **Work on a branch from `develop` and merge or push to `develop`.** A push to `develop` is live on the VM within about a minute (with automatic rollback on a failed health check). Check `/deploy.json`.
- **`main` is production on Vercel** and is merged by the owner only. Do not push to `main`.
- Small, focused commits with a plain description of what changed and why.
- **Keep each file's line endings.** Most files are LF; a few are CRLF (`admin.html`, `weekly.html`, `stock/script.js`). Check with `git ls-files --eol <file>`; do not let an editor convert them.
- Never commit `.env`, `data/supabase_config.json`, dumps (`consumer/*.csv`, `data/*` other than the two tracked files) or keys.
- Pushing changes under `.github/workflows/` needs a token with the `workflow` scope.

## 10. Rules that matter most

- **No test writes to production**: Google Sheets, Supabase (both projects) and Apps Script are all production. Do not save, upload, sync, allot, cancel, approve, delete or post follow-ups from a local or VM page while testing, and do not run `scripts/sync`, `scripts/migrate` or SQL without the owner's go-ahead. GET requests with a write `action` count as writes.
- **Never snapshot, copy or store sensitive data** (Aadhaar, PAN, bank and PF details, PINs, user tables) outside where it already lives. Mark such a mirror source `sensitive: true`; never add it to a snapshot, a log, a test fixture or an export.
- **Kill only your own processes.** Stop a local server with its pid file (`kill "$(cat /tmp/mzo-qa-<port>.pid)"`), never `pkill node` or `killall`; others may be running servers on the same machine. On the VM, use `systemctl` for the services and never kill PocketBase or a sync run by hand.
- No secrets in HTML or client JS; keys stay in env files.
- No framework, build step or CSS library. Scope rows with `MzoScope`. Use the UI kit for new pages.
- Update the docs in the same change when you add a page, dataset, API, env var, permission flag or scope rule.

## 11. Work in progress

<!-- handoff:wip:start — update this section when the features below are merged -->

> **Status (6 Nov 2026):** all three are live on the VM: the user system and the Sources tab since release 3.24, the data editor since 3.25.

- **VM user system on PocketBase (live).** VM only, behind `MZO_USER_STORE=pocketbase` (set in `vm/deploy/systemd/mzo-reports.service`). A fresh start: no Supabase users were imported. The built-in admins (`lib/users_store.js`, or `MZO_ADMIN_EMAILS`) are seeded at every start. Everyone else signs in with Google, lands on the waiting-for-approval screen, and an admin approves them with a role, office scope and report list in Admin → Users. Vercel keeps the Supabase sign-in. Schema and flows: [users.md](users.md).
- **Admin → Sources (live).** For every dataset and every menu report: where the data comes from, how often it refreshes, when it was last checked, copied and changed, whether it is overdue, and sync errors. Endpoint `GET /api/admin/sources-info` (`lib/sources_info.js`, live-only items in `lib/sources_live.js`). See [data-mirror.md](data-mirror.md).
- **Data editor at `/editor/` (live).** View and edit datasets with per-user, per-dataset permissions, paste from Google Sheets with a preview, history and undo. Datasets are *mirror* (read-only, the master is the Google sheet or Supabase) until an admin switches one to *native* (the master copy lives in PocketBase and the sync stops refreshing it). No dataset is native yet; an admin chooses which to take over. Limits, eligibility and architecture: [data-editor.md](data-editor.md).

<!-- handoff:wip:end -->

## 12. Known open issues

- **Unbilled & exceptions is empty on the VM.** Its `data/unbilled_*.csv` files come from the owner's CRM (DB2) sync on an office machine and are not on the VM (nor in a Git-built Vercel deploy). Needs a decision: publish them to Supabase Storage and mirror them like the other synced reports, or drop the page from the VM.
- **Ask does not work on the VM** until a key is in `/etc/mzo/app.env`: `GOEDEL_API_KEY` (DeepSeek V4.1 Flash on Gödel Machines) or `ANTHROPIC_API_KEY`. Without one it answers "not configured". A free Gödel key keeps prompts (aggregate numbers and questions) and may train on them; a paid key keeps nothing.
- **Production is far behind `develop`** (2.66.1 vs 3.2x) and still serves pages `develop` removed; plan redirects before the next promotion (section 4).
- **Stale numbers in the docs:** `vm/sync/sources/supabase.md` and a comment in `vm/sync/sources/google.js` say `frequent` is 15 minutes; the code (`vm/sync/lib/schedule.js`) and the timer run it every 5 minutes. [architecture.md](architecture.md) says Important data sheets have no mirror copy; the page now reads whole-tab copies on the VM. The repository rules say there are no automated tests; the tests in section 7 exist. [deploy.md](deploy.md) describes an older remote layout.
- **Health check-up** is a placeholder and **Substation upkeeping** only links to a separate app.
- The Power Map `powermap` schema (a second data model) is mirrored but no page reads it.
- The DD visit and Durga Puja sheets, and Priority SI, bypass the mirror by design; their freshness on the VM is the source's.
- Data quality findings for the source sheets (owner action list): [data-quality.md](data-quality.md) and the portal's Data quality page.

## 13. Glossary

| Term | Meaning |
|---|---|
| WBSEDCL | West Bengal State Electricity Distribution Company Ltd |
| MZO | Malda Zone (Office): the zone this app serves; regions Malda, Raiganj, Balurghat |
| CE | Chief Engineer level, i.e. the whole zone |
| Region / Division / CCC | the office hierarchy below the zone (3 regions, 7 divisions, 41 CCCs) |
| CCC | Customer Care Centre, the local office that serves consumers; codes `66RD1CC` |
| SM / DM / RM | Station Manager (CCC), Divisional Manager, Regional Manager |
| NSC | New Service Connection: an application for a new electricity connection |
| Withheld | NSC applications put on hold, with a reason |
| LE | Load extension: a consumer's request for more sanctioned load |
| MC | Master card: the consumer's billing master record, created after the meter is installed; "pending MC" = meter in but no master card yet |
| DD | Disconnection drive: defaulting consumers due for a disconnection visit (Upcoming DD, DD visit) |
| REM | the revenue reports on dues and defaulters (REM OSD, REM defaulters); the sheets do not spell the acronym out |
| OSD | Outstanding dues |
| AT&C loss | Aggregate technical and commercial loss; with distribution loss and collection efficiency on the Losses page |
| DTR | Distribution transformer |
| PRT / PTR | Power transformer (at a substation); the PRT page tracks transformers and their oil tests |
| Feeder | an outgoing line from a substation; feeder outage = interruption hours |
| NH / SH crossing | a power line crossing a national or state highway |
| SI | System improvement (Priority SI works); also Safety inspection in the Safety app |
| JJM | Jal Jeevan Mission: drinking-water scheme connections |
| ICDS / AWC | Integrated Child Development Services; Anganwadi centres that need connections |
| WRIDD | Water Resources Investigation and Development Department: irrigation scheme connections |
| Bharat Net / GP | the rural broadband programme; gram panchayat connections |
| PM Surya Ghar (PMSGY) | the national rooftop-solar scheme; WBREDA and Aloshree are other solar schemes on the Solar page |
| CMO | Chief Minister's Office: grievances forwarded from it |
| Capex | capital expenditure; the Capex page tracks advances to vendors and their ageing |
| O&M | operation and maintenance; O&M advances to vendors |
| Docket | a consumer complaint ticket |
| AMI / smart meter | advanced metering infrastructure; "pushed" = the meter reports to the AMI head end |
| CRM / ISU / ERP | the utility's SAP-based systems: customer relations, billing (IS-U), and ERP stores; meter utilization compares them |
| MRU | Meter reading unit |
| Outsort | a meter reading held back from billing by a validation check |
| DataHub | `mzo_data_hub.js`: the browser's dataset registry and cache |
| Mirror mode | the VM app serving the sync's local copies (`MZO_DATA_MODE=mirror`) |
| Snapshot | the exact source bytes of a dataset kept by the sync |
| Insight project | the newer Supabase project (`gmasnqebdogtavoudbke`); the old one is `unsmtschmcvftfqwabaq` |
