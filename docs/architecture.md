# Architecture

How the app is put together: pages, login and office scope, the data cache, the service worker and the server API.

## What this app is

Login-gated **PWA** for Malda Zone (WBSEDCL) operational reports. Most screens are standalone HTML pages with inline CSS/JS, not a SPA framework.

- **Local / Vercel:** Express in `server.js` (login/session/admin, tiny `/api/.../meta` JSON, static HTML/JS). Report CSV/JSON bodies are fetched **in the browser** from Google or Supabase Storage (DataHub). Do not add new Vercel dataset proxies.
- **Data:** Google Sheets CSVs (browser → Google via DataHub), uploaded dumps published to Apps Script or Supabase Storage, and Supabase (`mzo_insight` + Power Map tables). Stock dump bytes must not transit Vercel.
- **Client cache:** IndexedDB via `mzo_data_hub.js`; service worker `sw.js`.

```
npm install
npm run dev          # http://localhost:3000
```

Unauthenticated HTML requests redirect to `/login.html`. Use a real portal user to exercise report pages.

## Layout

| Path | Role |
|------|------|
| `server.js` | Auth cookie, `/api/*`, static hosting |
| `login.html` | Login; a signed-in user goes straight to `app.html` |
| `app.html` | The app: sidebar (a drawer on phones), ⌘K search, report pages in keep-alive iframes. `/` and the old `/index.html` home redirect here (`server.js` and `vercel.json`). See **Workstation shell** in [design-system.md](design-system.md) |
| `mzo_theme.css` / `mzo_theme.js` | Design system: tokens, UI kit (`ui-*`), legacy-page overlay, theme controller. See **Design system** |
| `mzo_ui.js` | `window.UI` helpers for kit pages (CSV, formatting, offices, tables, charts, drawer) |
| `admin_users.html` | Admin panel for portal users, sources, activity, visitors, Power Map, and corrections. Open a section with `?tab=users|sources|activity|visitors|powermap|corrections`. Each user row shows last use within 15 days (`GET /api/admin/logs?days=15`). The user form has **Sheet links** Yes/No for the **Sheet links** item in the sidebar. Structure editing stays on `admin.html`. |
| `auth.js` | Client session check + logout |
| `mzo_scope.js` | Login office scope (`window.MzoScope`) |
| `mzo_data_hub.js` | Dataset registry + IndexedDB (`window.mzoDataHub`) |
| `sw.js` | PWA cache; bump `CACHE_NAME` on UI/JS changes |
| `lib/` | Code shared with the browser: `assistant_catalog.js` (Ask), `sheet_mirror_client.js` (chunked sheet publish), `defective_meter_pipeline.js`; plus the server-only `stock_pipeline.js` |
| `apps-script/` | Google Apps Script sources, deployed by hand as web apps (see [apps-script.md](apps-script.md)); not served |
| `scripts/` | Node/SQL tooling: `sql/`, `sync/`, `migrate/`, `tools/` (see [scripts/README.md](../scripts/README.md)); not served |
| `nsc/`, `stock/`, `power_map/`, `dtr/`, … | Feature folders; each served folder needs a `vercel.json` static build entry |
| `data/` | `costcenter.json` (served) and `structure.csv` (estimate structures, server-only). Everything else in `data/` is git-ignored local data |
| `vercel.json` | Static + `/api` → `server.js` |

## Auth and office scope

**Server:** `requireAuth` in `server.js`. Session cookie `mzo_session` (HMAC-SHA256 with `JWT_SECRET`, 24h; the server warns on Vercel when `JWT_SECRET` is missing). Login reads **Supabase** `mzo_insight.portal_users` (not a live Google Sheet): Username + PIN, or Google sign-in verified against `GOOGLE_CLIENT_ID` and matched by saved email (details in [database.md](database.md#login-rules)). The local test sign-in only works on localhost. On the VM only, `MZO_LOCAL_ADMINS` adds admin accounts that exist in no database (see [vm.md](vm.md#vm-only-admin-accounts)).

Production stays on the **old** Supabase project (`unsmtschmcvftfqwabaq`) for login until `INSIGHT_LIVE=1`. Power Map always uses that old project. Stock dump + authorized upload use the new project when `STOCK_USE_STORAGE=1` and `INSIGHT_SUPABASE_URL` / `INSIGHT_SUPABASE_KEY` are set. Then DataHub `CACHE_STOCK` uses Storage `csvUrl`; users with **Stock Raw Upload** (or admin) `PUT` the cleaned CSV with a signed URL that **upserts** `stock/snapshot.csv` (bytes do not go through Vercel). The signed path Supabase returns is `/object/upload/sign/...`; prefix it with `/storage/v1` or the browser PUT 404s. If a publish still posts CSV to `/api/stock/publish`, the server also overwrites that Storage object so the dashboard date cannot lag the upload meta. Do not set `INSIGHT_LIVE` until `npm run copy:insight` has copied `portal_users` and you are ready to switch login. Copy from `scripts/supabase_config.example.json` into gitignored `data/supabase_config.json`. Never put the service_role key in HTML or git.

Stock storage and the insight cutover: [stock.md](stock.md).

**PINs:** stored as `scrypt$` hashes. A still-plain PIN is accepted once at login and then replaced with the hash. `GET /api/admin/users` does not include `PIN`. A blank PIN on user update keeps the current one. Remember me stores `mzo_saved_username` only and deletes `mzo_saved_pin`. `/server.js` and `/data/` are not served. Do not put the service role key in HTML.

**Client profile:** `localStorage.mzo_user_profile` (PIN stripped). Scope fields: `role`, `zone_code`, `region_code`, `division_code`, `ccc_code`, plus module flags (`nsc-autho`, `nsc-upload-autho`, `defective-upload-autho`, `stock-upload-autho`, `si-autho`, `sheets-autho`, …). The shell's sidebar and account menu read this profile. After an admin changes a flag, the user must sign in again so the stored profile refreshes.

Sheet links (sidebar **Important → Sheet links**) has its own rules: see [reports.md](reports.md#sheet-links).

**`window.MzoScope`** (client-only; do not slice large CSVs on Vercel):

- Admin or empty jurisdiction → **unscoped** (all offices).
- Grain: **CCC > division > region**.
- `filterRows(rows)` after parse; `lockFilters()` after filling Region/Division/CCC `<select>`s.
- Banner: “Showing {label} — set by admin”.
- **Do not** add per-page “Office Prefs”. Scope comes from login only.

Canonical names in `mzo_scope.js` `HIERARCHY`:

- Regions: **Malda**, **Raiganj**, **Balurghat**
- Divisions: Malda, Chanchal, Gazole, Raiganj, Islampur, Balurghat, Buniadpur. Treat **Div** / **Div.** / **Division** as the same office; UI shows the name without that suffix.

Office codes match `/66[123]\d{4}/` (e.g. `6611108`, `C36611108`). If a dataset’s office columns are missing from `REGION_KEYS` / `DIV_KEYS` / `CCC_KEYS` / `CODE_KEYS`, extend those lists — do not invent a second matcher.

**Locked dropdowns:** when a filter is locked, show the **office name only** (no leftover “All Regions / All Divisions / All CCCs”). Do not cascade-filter empty lists from a mismatched region value. WRIDD (`wridd.html`) is the reference for this.

## DataHub

**Do not send report data through Vercel.** Register the **Google published CSV** (or other origin URL) in `DATASETS`. The browser fetches it; IndexedDB holds the body. Login/session/admin and tiny `/api/.../meta` JSON are the only Vercel APIs involved in data loading. Do not add `/api/.../dataset` proxies that GET a sheet and return CSV. `originHeavy` dumps (NSC, Withheld, Stock) take the origin `csvUrl` from their meta so dump bytes do not transit Vercel.

Datasets are registered in `mzo_data_hub.js` `DATASETS`. IndexedDB holds the CSV/JSON body. `localStorage` key `mzo_hub_ver_<CACHE_KEY>` holds the version.

```js
await window.mzoDataHub.waitForDataset('CACHE_NSC_v5');
const csv = await window.mzoDataHub.get('CACHE_NSC_v5');
```

**Versioned load (required):** `get()` / `waitForDataset` revalidate with a cheap check — `/api/.../meta` when `versionUrl` is set, otherwise HEAD / Range probe (`Content-Length`, ETag). If the stored version matches and IndexedDB already has a body, **do not download the CSV**. If the version cannot be read cheaply: **lazy** dumps keep the cache; **clerk sheets** (Loss, Collection, …) re-download on a forced refresh (`UI.refresh` / `forceCheck`) or a new calendar day. Loss page uses `waitForDataset(..., { forceCheck: true })` so a same-day sheet paste (e.g. August) replaces the July cache. Pages should `_peek` (or `UI.load`) and paint first, then `waitForDataset` in the background. Replacing a raw dump also deletes its parsed companion (`CACHE_NSC_PARSED_v7`, `CACHE_WITHHELD_PARSED_v4`, `CACHE_PENDING_MC_PARSED`, `CACHE_METER_PARSED_v1`).

Version strings are prefixed: `v:` API meta, `e:` ETag, `m:` Last-Modified, `l:` Content-Length, `f:` body fingerprint. Length-prefixed versions can match each other. Ignore `Content-Length: 0` / `l:0` (Google published CSVs often send that on HEAD) and fall through to a Range probe or a full GET; after download store a fingerprint instead of `l:0`. `refresh(key)` clears the stored version and forces a download (use after an upload).

Open a report from IndexedDB immediately if a body exists, then version-check in the background. A page's refresh button (`UI.refresh`) forces the check; there is no bulk "sync everything".

| Flag | Meaning |
|------|---------|
| `originHeavy` | Prefer origin `csvUrl` from `/api/.../meta` (NSC, Withheld, Stock). Dump bodies are never downloaded through Vercel. Stock `csvUrl` is Google until `STOCK_USE_STORAGE` is on, then Supabase Storage. |
| `lazySync` | Multi-MB sheet with no cheap version: a cached body is kept until a forced refresh or a `versionUrl` says it changed (never a full GET just to fingerprint it). |
| `versionUrl` / `versionField` | JSON meta for version (Withheld uses `withheldVersion`) |

Do **not** `fetch()` or `Papa.parse(url, { download: true })` a Google Sheet from a page if a DataHub key exists. Register the URL in `DATASETS`, then `waitForDataset` + `get`. A page that must read a sheet itself (no DataHub key) loads `mzo_data_hub.js` and calls `mzoMirror.fetch(url, init)` instead of `fetch(url, init)` (see below).

**Mirror mode in the browser (VM).** On first use a page asks `GET /api/data/manifest` once (`mirrorManifest()`); the shell asks before its first frame loads, and frames reuse that copy from `sessionStorage` (`mzo_mirror_manifest`) for 20 s or wait for the shell's request in flight. For every dataset listed under some entry's `dataHubKeys`:

- the version is `v:` + the manifest version (sha1 of the bytes). When it equals the stored version and IndexedDB holds a body (checked with `count()`, without reading the body), `waitForDataset` returns `'unchanged'` with no request at all: no meta call, no Google probe;
- otherwise the body comes from `/api/data/file/<key>` (or the entry's same-origin `dataHubUrl`, e.g. Power Map's `/api/power-map/data`), with `cache: 'no-cache'` so the browser revalidates by ETag. An identical body (same fingerprint) keeps the parsed companions; a changed one replaces the body and drops them, as before;
- any failure (network, non-200, HTML, a JSON copy for a CSV dataset, a short NSC/Withheld copy when the response carries the row-count headers) falls back to the original logic for that dataset. 204 or 404 from the manifest means no mirror (Vercel, local): remembered in `localStorage` `mzo_mirror_off` for 30 min, and everything works as before;
- `forceCheck` (refresh buttons, Loss) uses a manifest under 3 s old. `refresh(key)` and `seedDataset()` (after an upload) read the **source**, then hold that body (`mzo_mirror_hold_<key>`) until the manifest version moves past the one it replaced (at most 20 min), so a write is never hidden by an older copy.

| Helper | Use |
|---|---|
| `mzoMirror.fetch(url, init)` | `fetch()` for a page's own sheet URL: the mirror copy when the manifest lists that URL in some entry's `urls` (matched without `#…`, `single=true`, `v=` and query order), else, or on any failure, the source. `no-store` becomes `no-cache` (ETag revalidation). |
| `mzoMirror(url)` | The mapped URL (a promise), or the URL unchanged. |
| `mzoMirror.fresh(url)` | After the page itself wrote that sheet through Apps Script: read the source until the copy changes (at most 2 h). PRT oil and DTR peak load use it. |
| `mzoMirror.refresh(keys, reason)` | Fire and forget `POST /api/data/refresh` after such a write, only when the mirror is on: NSC follow-ups (`nsc_followups`), DTR peak load (`dtr_peak_load`), PRT oil tests (`prt_transformers`, `prt_oil_tests`). |
| `mzoMirror.status()` | `{ mode: 'mirror' \| 'origin', generatedAt }`. |

Pages that read sheets through `mzoMirror.fetch`: accident, consumers, docket KPI, DTR records and peak load, historical NSC, line-highway crossings, PRT oil, smart meter, upcoming DD, O&M and capex advances, and the source fallbacks of defective meter, disconnection, Power Map tap points, sheet links and stock materials. Left on the source on purpose: manpower and DD visit (sensitive, never mirrored), Priority SI works (reads and writes Supabase directly), important data sheets (single-cell range reads, which have no copy), Durga Puja (embedded sheets) and every Apps Script call. Sheet links rebuilds its **Updated** dates in mirror mode from where today's stored versions got them (the dataset meta's `liveVersions`, or the source's `sourceModifiedAt`), never from the mirror's fetch time.

A repeated `_peek` of a large body within 15 s returns the same string without another IndexedDB read (UI.load reads, revalidates, reads again), as long as the stored version has not changed.

DataHub keys in use: `CACHE_NSC_v5`, `CACHE_WITHHELD_v4`, `CACHE_STOCK`, `CACHE_POWER_MAP`, `CACHE_SOLAR`, `CACHE_JJM`, `CACHE_WRIDD`, `CACHE_BHARATNET`, `CACHE_METER_*`, `CACHE_DEFECTIVE`, `CACHE_DEFECTIVE_DETAILS`, plus collection/loss/weekly/docket/REM/capex/etc. in `DATASETS`. `window.MZO_DATASETS` is that same list. Admin → Sources classifies each report as Sheet, Supabase, JSON, Script, or RSS. Sheet rows have a small open control and a copy control for the spreadsheet link only. Stock’s label follows `/api/stock/meta` `source` (Supabase Storage vs Google Sheet).

Bump the **cache key** (`CACHE_FOO_v2`) if the stored row shape changes. Large dumps stay out of git (see `.gitignore` / `.vercelignore`).

## Service worker

`CACHE_NAME` in `sw.js` and `version` in `version.json` move together. **Increment both** whenever HTML/CSS/JS that users already cached must update. `version.json` `message` is the full-screen “App updated” notice: the highlighted note and a Reload button. It shows only in the top window, so a report inside the shell does not open a second notice. `mzo_app_update.js` fetches that file network-first and reloads desktop and the installed PWA. Do not add an install-app modal. The app-update banner is separate from dump `REPORT_AS_ON`. Do not intercept `*.supabase.co` in `sw.js` (same as Google Sheet CSVs). The network-first list (`isNetworkFirstPath`) covers the shell, the kit files and every rebuilt page. Precache is per file: one missing asset does not stop a new worker from installing. A network-first page is saved on a successful load (query string ignored). Offline navigation uses that saved page. `offline.html` is only for a page that was never saved. `/api/` stays a JSON 503 and is not cached.

**Presentation zoom:** the service worker inserts `/mzo_present.js` into HTML responses (right after `<head>`) unless the page already loads it (`puja.html` does). Skip login, offline, `app.html`, `/power_map/`, and `/accident/map.html`. Cache the original HTML, and inject only on the response sent to the page. If the page already has a full-window scroller (nearly the whole viewport and not a side panel or dialog), zoom the content inside it so `html` does not grow a second scrollbar. Other reports, including NSC, zoom the page itself. A report open in the shell zooms inside its frame only.

Add new/changed report URLs to `isNetworkFirstPath()` so an online load still refreshes the page (`/version.json`, `/mzo_app_update.js`). Offline keeps the last saved copy. After activate, the SW posts `MZO_APP_UPDATED`. NSC still paints from IndexedDB first, then `waitForDataset`; if the dump version changed it **reloads** (do not only `console.log`).

## APIs (server.js)

Typical prefixes: `/api/login`, `/api/auth/google`, `/api/session-check`, `/api/logout`, `/api/admin/*`, `/api/nsc/*`, `/api/stock/*`, `/api/withheld/*`, `/api/power-map/*`, `/api/defective/meta`, `/api/hub/versions`. Unauthenticated `/api` returns **401 JSON**, not a login HTML redirect. Do **not** add new `/api/.../dataset` routes that pull a Google sheet through Vercel — put the published CSV URL in `DATASETS` instead (see Bharat Net). `GET /api/hub/versions` returns tiny `{ versions, csvUrls }` for NSC, Withheld, Stock, Defective, and Power Map. `GET /api/power-map/meta` is the Power Map version (Supabase `updated_at`). On the VM in mirror mode these and the other meta endpoints take versions and CSV URLs from the snapshot manifest, and `/api/data/*` serves the snapshots (see **Mirror mode** below). Every report API, including `/api/executive/briefing`, needs a session. `POST /api/dtr/verify-pin` checks a DTR PIN on the server (rate-limited); PINs never reach the browser.

**Not served:** the server and Vercel routes return 404 for `server.js`, `package*.json`, `scripts/`, `apps-script/`, server-only `lib/` files, `data/` (except `costcenter.json`) and `.md/.gs/.sql/.py` files. Browser-loaded `lib/` files are listed in `vercel.json` builds; add a new one there and to the allow-list in `server.js`.

Uploads (NSC, stock, defective meter) process the file **in the browser**, then `MzoSheetMirror.publishTab` posts urlencoded chunks to Apps Script (`ContentService` JSON). Bulk bytes do not go through Vercel. Defective Meter uses the same helper as NSC (`lib/sheet_mirror_client.js`). After Apps Script code changes, deploy a **new version** of the **existing** web app (keep the same `/exec` URL). Do not return HtmlService from `doPost` (that is the `ppConfig` web-page error). Google’s `/macros/echo` URL sometimes 404s with that same HTML; the client retries each POST (8 attempts) and, if the tab still fails, restarts from `begin` (3 tries). NSC upload shows those retries in an orange note — leave the page open. If the sheet write still fails, the page offers sheet links plus processed CSVs and **Activate** after a manual File → Import. Withheld publishes 14 columns in ~600-row chunks; NSC Working stays 43 columns. Split by `SCN_STATUS` only: Working/Accepted stay on NSC even if a withheld date or reason is still on the row. Count each `APPL_NO` once (last row wins) so a repeated consumer in one division is not counted twice. If the file has **zero** Withheld-status rows, skip the Withheld `begin` (do not clear Sheet1) and keep the previous Withheld meta. Do not intercept `script.google.com` in `sw.js`. The `nsc_working` workbook runs `apps-script/nsc_mirror_and_followup.gs`; see [apps-script.md](apps-script.md).

**Who can upload NSC:** `GET /api/nsc/meta` → `canUpload`. True if `role` is `admin` (case-insensitive), or portal flag `nsc-upload-autho` / `nsc_upload_autho` is Y/yes/1/true/upload, or username `dm1`. Admins always can, even if the flag is blank. The Date / Excel / Upload controls stay disabled until that JSON returns true.

**NSC upload UI** (`nsc/upload.html`): Date, Excel, Upload only. Do not add pipeline essays, Apps Script paste notes, or a how-to box. Last live counts may sit on one muted line. Fail UI (sheet link + CSV) appears only after a write error.

## Mirror mode (VM only)

On the VM the app serves report data from local copies instead of Google and Supabase, so a page's data check is one small same-origin request. Vercel and local development are unchanged: mirror mode is off unless `MZO_DATA_MODE=mirror` is set **and** the snapshot folder exists. Design and ownership: `agent-progress/CONTRACT-PHASE2.md`; the sync that writes the copies is `vm/sync` (see [data-mirror.md](data-mirror.md)).

**Snapshots.** `vm/sync/run.js` keeps the untouched source bytes of every non-sensitive dataset in `MZO_SNAPSHOT_DIR` (default `/opt/mzo/data/snapshots`): `<key>.<csv|tsv|json>` plus `.gz` and `.br`, and `manifest.json` (`version` = sha1 of the bytes, `file`, `contentType`, `dataHubKeys`, `urls`, `fetchedAt`, …). Sensitive datasets (`portal_users`, `dd_user_auth`, `activity_logs`, the manpower sheets) never get a snapshot; they stay in PocketBase for the admin portal.

The browser side (manifest sharing, versions, fallbacks, `mzoMirror`) is under **DataHub** above.

**Endpoints** (`lib/mirror.js`, mounted after `requireAuth`, all need a session):

| Endpoint | Mirror on | Mirror off |
|---|---|---|
| `GET /api/data/manifest` | The manifest without sensitive entries and without URLs that carry keys. Read from disk, cached by mtime; `ETag` + 304, `Cache-Control: private, no-cache`, br/gzip by `Accept-Encoding`. Datasets being refreshed after a write are left out, so clients load them live meanwhile. | 204 (also before the first manifest exists) |
| `GET /api/data/file/:key` | Streams the snapshot (or its `.br`/`.gz` copy) from an open file through two reused 64 KB buffers. `ETag` = manifest version, 304 on `If-None-Match`, `Content-Type` from the manifest, `Cache-Control: private, no-cache`. 404 for unknown, sensitive or malformed keys. | 404 |
| `GET /api/data/status` | `{ mode, generatedAt, datasets, ageSeconds, refreshing, lastRefresh }` | 404 |
| `POST /api/data/refresh` | `{ keys, reason }`: the browser asks to refresh a sheet it wrote itself through Apps Script. Allow-list: `nsc_followups`, `dtr_peak_load`, `prt_transformers`, `prt_oil_tests` (a PRT save writes both); 30 per user per 10 min. | 404 |

`requireAuth` lets `*.json`/`*.js` paths through without a session, so these routes check `req.user` themselves. `lib/mirror.js` is in `PRIVATE_PATH` and is never served.

**Server reads switched to the mirror** (each falls back to its live read when the snapshot is missing, unreadable or being refreshed):

| Endpoint | In mirror mode |
|---|---|
| `/api/power-map/data` | The same CSV, built from `power_map_substations.json` (the body of the same `select=*&limit=5000` query). Byte-identical. |
| `/api/stock/allotment` list / get | The same rows from `stock_allotments.json` (the body of the server's own ordered query). Byte-identical. The view's refresh button (`force`) still reads live, because allotments are also made on other hosts. |
| `/api/important-sheets/unbilled` | The same months from `important_unbilled_months.json`. Byte-identical. |
| `/api/nsc/meta`, `/api/stock/meta`, `/api/defective/meta`, `/api/disconnection/meta`, `/api/pending-mc/meta`, `/api/load-extension/meta` | Same shape. `version` / `withheldVersion` are manifest versions and the CSV URLs are `/api/data/file/<key>`. NSC's TODAY comes from the snapshot's first row, the stock as-on date from the snapshot's `Date` column, and stock `source` is `supabase_storage`. The NSC upload meta (Apps Script) and the report `meta.json` files stay live. `liveVersions: { version, withheldVersion }` carries what the live response's version fields would be (they hold report dates and upload times, which Sheet links shows). |
| `/api/power-map/meta` | `version` = manifest version, `rows` from the snapshot, `csvUrl` = `/api/power-map/data` (live, `csvUrl` is the published sheet, which lags the table that edits go to). `liveVersions.version` is the latest `updated_at`, from the snapshot. |
| `/api/hub/versions` | Every DataHub key in the manifest gets its manifest version and URL. The live reads still run (cached; Power Map from its snapshot) and what they give for those keys is returned as `liveVersions: { <CACHE_KEY>: <version> }`; keys without a snapshot keep their live version. |
| `/api/executive/briefing` | Unchanged: its inputs (report `meta.json`, NSC upload meta) have no snapshots. |

Report `meta.json` files are read from `REPORTS_PUBLIC_BASE`, which defaults to the new project's public `reports` bucket when `INSIGHT_SUPABASE_URL` is unset (so localhost and the VM get real numbers too).

**Write-through.** After every successful write the app handles, `refreshMirror(keys, reason)` runs `node vm/sync/run.js --only <keys> --reason "write-through: …"` detached, with the app's environment, at nice 10 and OOM score +500. Calls within 2 s are coalesced, one run at a time; later writes queue behind it. Until a dataset's run finishes (at most 3 min, 10 min after a failed run) the server reads it live and the manifest leaves it out, so users see their own change immediately. Without `vm/sync/run.js` it logs once and does nothing.

| Write | Datasets refreshed |
|---|---|
| `POST /api/nsc/publish/complete` | `nsc_pending`, `withheld` |
| `POST /api/stock/publish` | `stock_snapshot`, `stock_upload_meta` (+ `stock_snapshot_db` for a server-side publish) |
| `POST /api/stock/allotment` create / migrate; cancel | `stock_allotments`, `stock_allot_seq`; `stock_allotments` |
| `POST /api/defective/sync`, `/api/disconnection/sync`, `/api/pending-mc/sync`, `/api/load-extension/sync` | `defective_summary` + `defective_details`, `disconnection`, `pending_mc`, `load_extension` |
| Power Map: `edit-sheet-row`, `append-sheet-row`, `add-connection` (admin) | `power_map_substations` |
| Power Map suggestions (non-admin), `reject-correction`; `approve-correction` | `power_map_corrections`; both |
| `POST`/`PATCH`/`DELETE /api/important-sheets/unbilled` | `important_unbilled_months` |
| `POST /api/admin/users/create`, `update`, `delete`, `approve`, `reject` | `portal_users` (PocketBase only) |
| `POST /api/structures/update` | `structure` |
| `POST /api/data/refresh` (browser writes through Apps Script) | the allow-listed keys |

Not wired, on purpose: login and Google sign-in (PIN-hash upgrades and last-login updates in `portal_users`), activity logs (every page visit) and `POST /api/admin/sync` (a read). Writes that skip the app, such as `si-works/si.html` straight to Supabase or edits on Vercel, reach the mirror at the next scheduled sync.

**On the VM.** `provision.sh` creates `/opt/mzo/data/snapshots` (owner `opc`) and `mzo-sync.service` sets `MZO_SNAPSHOT_DIR`. The app unit (`mzo-reports.service`) also needs:

```
EnvironmentFile=-/etc/mzo/pocketbase.env
Environment=MZO_DATA_MODE=mirror
Environment=MZO_SNAPSHOT_DIR=/opt/mzo/data/snapshots
Environment=SYNC_TMP_DIR=/opt/mzo/data/sync-tmp
```

and `mzo-sync.service` the same `SYNC_TMP_DIR` line, with `/opt/mzo/data/sync-tmp` created (owner `opc`) next to the snapshots. `pocketbase.env` gives the write-through run its PocketBase login. The shared `SYNC_TMP_DIR` gives the timer's sync and the write-through sync one lock file across releases (without it the lock sits in each release's `vm/sync/.tmp`, so two syncs could overlap around a deploy). `MZO_DATA_MODE=off` in `/etc/mzo/app.env` turns mirror mode off without a commit (an `EnvironmentFile` value wins over `Environment=`). A restart of the app also stops a write-through run in progress; the next scheduled sync catches up.

**Local test.** Build a snapshot folder from the live sources (GET only, never Apps Script), then run the app against it:

```
PORT=3400 npm run dev                                   # original mode, for the NSC/Withheld redirects
node vm/dev/make-snapshots.js --out /tmp/mzo-snapshots  # about 60 MB, 20 s; --only key,CACHE_KEY; --skip-big
MZO_DATA_MODE=mirror MZO_SNAPSHOT_DIR=/tmp/mzo-snapshots PORT=3400 npm run dev
```

Switched responses carry `X-Mzo-Data: mirror`. `liveVersions` appears only in mirror mode; original-mode responses are unchanged.

**Test.** `node vm/dev/test-mirror-server.js` runs `server.js` in both modes with every upstream request answered from fixtures (no network; any upstream write fails it) and checks the byte parity, the manifest versions, `liveVersions` and that original mode has no mirror fields.
