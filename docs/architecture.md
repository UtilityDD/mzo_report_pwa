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
| `login.html` | Google sign-in page with DISHA app icon and theme switcher; a signed-in user goes straight to `app.html` |
| `app.html` | The app: sidebar (a drawer on phones), ⌘K search, report pages in keep-alive iframes. `/` and the old `/index.html` home redirect here (`server.js` and `vercel.json`). See **Workstation shell** in [design-system.md](design-system.md) |
| `mzo_theme.css` / `mzo_theme.js` | Design system: tokens, UI kit (`ui-*`), legacy-page overlay, theme controller. See **Design system** |
| `mzo_ui.js` | `window.UI` helpers for kit pages (CSV, formatting, offices, tables, charts, drawer) |
| `admin_users.html` | Admin panel for portal users, sources, activity, visitors, Power Map, and corrections. Open a section with `?tab=users|sources|activity|visitors|powermap|corrections`. Each user row shows last use within 15 days (`GET /api/admin/logs?days=15`). The user form has **Sheet links** Yes/No for the **Sheet links** item in the sidebar. Structure editing stays on `admin.html` (the Structure tab), which no longer has a user editor of its own. The window uses the UI kit (`<html class="ui">`, an `adminKit` style block mapping the older tabs onto the kit's tokens). |
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

**Server:** `requireAuth` in `server.js`. Session cookie `mzo_session` (HMAC-SHA256 with `JWT_SECRET`, 24h; the server warns on Vercel when `JWT_SECRET` is missing). Login reads **Supabase** `mzo_insight.portal_users` (not a live Google Sheet) via Google sign-in verified against `GOOGLE_CLIENT_ID` and matched by saved email (details in [database.md](database.md#login-rules)). Legacy PIN and localhost demo sign-in options have been retired.

Production stays on the **old** Supabase project (`unsmtschmcvftfqwabaq`) for login until `INSIGHT_LIVE=1`. Power Map always uses that old project. Stock dump + authorized upload use the new project when `STOCK_USE_STORAGE=1` and `INSIGHT_SUPABASE_URL` / `INSIGHT_SUPABASE_KEY` are set. Then DataHub `CACHE_STOCK` uses Storage `csvUrl`; users with **Stock Raw Upload** (or admin) `PUT` the cleaned CSV with a signed URL that **upserts** `stock/snapshot.csv` (bytes do not go through Vercel). The signed path Supabase returns is `/object/upload/sign/...`; prefix it with `/storage/v1` or the browser PUT 404s. If a publish still posts CSV to `/api/stock/publish`, the server also overwrites that Storage object so the dashboard date cannot lag the upload meta. Do not set `INSIGHT_LIVE` until `npm run copy:insight` has copied `portal_users` and you are ready to switch login. Copy from `scripts/supabase_config.example.json` into gitignored `data/supabase_config.json`. Never put the service_role key in HTML or git.

Stock storage and the insight cutover: [stock.md](stock.md).

**On the VM** (`MZO_USER_STORE=pocketbase`) users, sign-in and the activity log live in the VM's PocketBase instead (`app_users`; the same profile fields, plus `email`, `isAdmin` and per-user report `modules`): see [users.md](users.md).

**Sign-in:** Google only (`POST /api/auth/google`); there is no username + PIN sign-in. ID tokens are verified against Google's signing keys and access tokens through Google's tokeninfo (`lib/google_auth.js`). A user signs in once an admin has saved their Google email. VM-only admin accounts (`MZO_LOCAL_ADMINS`, the VM only) sign in with a password through `POST /api/auth/local` ([vm.md](vm.md)). Old PINs stay in `portal_users` as `scrypt$` hashes and are never returned by `GET /api/admin/users`. `/server.js` and `/data/` are not served. Do not put the service role key in HTML.

**Client profile:** `localStorage.mzo_user_profile` (PIN stripped). Scope fields: `role`, `zone_code`, `region_code`, `division_code`, `ccc_code`, plus module flags (`nsc-autho`, `nsc-upload-autho`, `defective-upload-autho`, `stock-upload-autho`, `si-autho`, `sheets-autho`, …). The shell's sidebar and account menu read this profile. After an admin changes a flag, the user must sign in again so the stored profile refreshes.

Sheet links (sidebar **Important → Sheet links**) has its own rules: see [reports.md](reports.md#sheet-links).

**`window.MzoScope`** (client-only; do not slice large CSVs on Vercel):

- Admin or empty jurisdiction → **unscoped** (all offices).
- Grain: **CCC > division > region**.
- `filterRows(rows)` after parse; `lockFilters()` after filling Region/Division/CCC `<select>`s.
- A row whose usual office fields are empty is first resolved through every office-type column `lib/offices.js` knows (Office Code, Location Code, DISTRICT, CIRCLE NAME, Sub-Division Name, …). A row that still names no office is shown only to zone and admin logins.
- Banner: “Showing {label} — set by admin”.
- **Do not** add per-page “Office Prefs”. Scope comes from login only.

Canonical names in `mzo_scope.js` `HIERARCHY`:

- Regions: **Malda**, **Uttar Dinajpur**, **Dakshin Dinajpur** (named after their districts; the app used to call the last two the Raiganj and Balurghat regions)
- Divisions: Malda, Chanchal, Gazole, Raiganj, Islampur, Balurghat, Buniadpur. Treat **Div** / **Div.** / **Division** as the same office; UI shows the name without that suffix.

Office codes match `/66[123]\d{4}/` (e.g. `6611108`, `C366111080`). If a dataset’s office columns are missing from `REGION_KEYS` / `DIV_KEYS` / `CCC_KEYS` / `CODE_KEYS`, extend those lists. Names and codes resolve through `lib/offices.js` (see **Offices**); do not add a page-level alias table.

**Locked dropdowns:** when a filter is locked, show the **office name only** (no leftover “All Regions / All Divisions / All CCCs”). Do not cascade-filter empty lists from a mismatched region value. WRIDD (`wridd.html`) is the reference for this.

## Offices

`lib/offices.js` is the one canonical office list. It loads in the browser as `window.MzoOffices` (every page that loads `mzo_scope.js` loads it just before) and in Node with `require` (the mirror's `vm/sync/lib/offices.js` wraps it and adds the old cost centres from `data/costcenter.json`). `MzoScope.regionNameOf` / `divisionNameOf` / `cccNameOf`, `UI.office` and `UI.regionName` ask it first and fall back to their older matching only when it is missing. Matching is exact on normalised names and aliases, never “one name contains the other”: `Malda` is not Old Malda, and total rows (`Raiganj Div Total`, `MALDA REGION`) are never a CCC.

| Level | Offices | Code |
|---|---|---|
| Zone | Malda Zone | `6600000` (plants `6600`, `7201`) |
| Region (3) | Malda, Uttar Dinajpur, Dakshin Dinajpur | `66R0000` (`6610000`…) |
| Division (7) | Malda, Chanchal, Gazole · Raiganj, Islampur · Balurghat, Buniadpur | `66RD000`, prefix `66RD` |
| CCC (41) | listed in `CCCS` with their division | `66RD1CC` (`6611101` = Manikchak) |

**Codes it reads:** `6611101`, `6611101.0`, ` 6611101 `; SAP cost centres `C3` + code + `0` (`C366111050` = Mothabari); 8-digit padded codes (`66211010` = Itahar); codes inside names (`SAMSI CCC-6612102`, `BALURGHAT CCC (6631101)`); division prefixes (`6611`) and old SAP plants (`3342` Malda, `3343` Chanchal, `3432` Raiganj, `3433` and `3461` Balurghat, `3434` Islampur, `3462` Buniadpur); division offices `66RD000` and their other units `66RD0xx`/`66RD3xx` (stores, sub-stations); old cost centres `C333…`/`C334…` through `data/costcenter.json` (`MzoOffices.addCostCentres(list)` in the browser); the known mistyped codes `66111609` and `66131101`.

**Names it reads** (case, spaces, dots, `CCC`, `Customer Care Center/Centre`, `(D)`, `Division`/`Divisioin`/`Div`, `Region`, `(O&M)` and a trailing code are ignored):
- Regions by district: Malda / Maldah / `MALDAH ` → Malda; Uttar Dinajpur / U. Dinajpur / U/Dinajpur / Dinajpur Uttar / Raiganj / Raigunj / `Raiganj (D) Region` / `Raiganj (R)` → Uttar Dinajpur; Dakshin Dinajpur / Dakhsin / D. Dinajpur / D/Dinajpur / Dinajpur Dakshin / Balurghat / `Balurghat Region` → Dakshin Dinajpur; region office codes `66R0000` and LGD district codes 316 / 311 / 310.
- **Region names are canonical in one place.** `MzoOffices.canonRegion(value)` (and `MzoScope.canonRegion`, `UI.regionName` in pages) turns any region spelling or old name into `Malda`, `Uttar Dinajpur` or `Dakshin Dinajpur` ('' when it is not a region); `REGION_NAMES` is the list and order; `regionNames(name)` adds the legacy names (`Raiganj`, `Balurghat`) for matching data written before the rename. Use them only where a region is meant: **Raiganj and Balurghat are still division and CCC names**, and `parseDivision` / `parseCccName` keep them. A login scoped to an old name (`region_code` "Raiganj" or "Balurghat Region") sees exactly its region; the banner shows the current name. Records saved with an old name (PocketBase `app_users.region`, Supabase `portal_users.region_code`) are read alias-aware and were left as they are; re-saving the user in Admin → Users stores the current name.
- Divisions: Raigunj and Uttar Dinajpur (D) Division → Raiganj; Dakshin Dinajpur (D) Division → Balurghat; Gazol / Gajol → Gazole. **North Malda** and **South Malda** are the two old Malda divisions; each covers parts of two current divisions, so a row with only that name keeps its region and takes the division from its CCC.
- CCCs: Mathurapur = Manikchak; Mokdampur = Mokdumpur; Baisnabnagar = Baishnabnagar; H.C. Pur = Harishchandrapur; Gazol / Gajol = Gazole; Pandua-I = Pandua; Bamangola = Bamongola; Kaliaganj = Kaliyaganj; Karandeghi = Karandighi; Goalpokhar = Goalpokher; Kumargunj = Kumarganj; Kushmandi / Kushmundi = Kusmandi; Golapgang = Golapganj; Sujpur = Sujapur; `Pa` = Pandua inside Gazole division.
- Statewide sheets (WRIDD, accidents, PM Surya Ghar) also hold other zones' offices; those are recognised as outside the zone, not as unknown MZO offices.

**Adding an office or an alias:** add the spelling to that office's aliases in `lib/offices.js` (a new CCC also goes into `mzo_scope.js` `HIERARCHY` and `CODE_TO_CCC`, which must list the same 41 CCCs), bump `VERSION` there so the mirror rewrites its office fields, and bump `lib/offices.js?v=` on every page. The mirror's `dim_offices` collection is rewritten from the list on the next sync.

**Other zones:** WBSEDCL's full hierarchy (6 zones, 23 regions, 79 divisions, about 500 CCCs from public sources) is a separate, admin-only dataset for Admin → Organisation (`data/org/wbsedcl_hierarchy.json`, `GET /api/admin/org`). It does not change scope or reports. Where zone sits in scope and data today, and what multi-zone support would need: [org-hierarchy.md](org-hierarchy.md#scaling-beyond-malda-zone).

**In the mirror** every `ds_` collection with office columns gets `_region`, `_division`, `_ccc_code` and `_ccc` (empty when unknown), and unknown or contradictory values go to `sys_quality_issues` as `office.*` checks. Findings: [data-quality-offices.md](data-quality-offices.md).

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

DataHub keys in use: `CACHE_NSC_v5`, `CACHE_WITHHELD_v4`, `CACHE_STOCK`, `CACHE_POWER_MAP`, `CACHE_SOLAR`, `CACHE_JJM`, `CACHE_WRIDD`, `CACHE_BHARATNET`, `CACHE_METER_*`, `CACHE_DEFECTIVE`, `CACHE_DEFECTIVE_DETAILS`, plus collection/loss/weekly/docket/REM/capex/etc. in `DATASETS`. `window.MZO_DATASETS` is that same list. Admin → Sources lists every dataset and live feature with its origin, refresh schedule and freshness, by dataset and by report (`GET /api/admin/sources-info`; see [data-mirror.md](data-mirror.md#admin--sources-where-each-dataset-comes-from)).

Bump the **cache key** (`CACHE_FOO_v2`) if the stored row shape changes. Large dumps stay out of git (see `.gitignore` / `.vercelignore`).

**Uniform rows.** Converted pages read `MzoRows.load('<dataset key>', render)` (`mzo_rows.js`) instead of a DataHub body: snake_case fields, numbers, ISO dates and the canonical office of every row, built by `lib/uniform.js` from the same DataHub body (or precomputed on the VM), described by `schema/<key>.json`. See [uniform-data.md](uniform-data.md); which pages read what: [uniform-data-inventory.md](uniform-data-inventory.md).

**Page views (VM).** Meter utilization, Smart meter and Sheet links first ask `/api/data/view/<name>` (`mzo_view.js`) for what they would otherwise compute from several whole datasets; the sync precomputes it with the page's own rules. A 204 (Vercel, local, or a view not rebuilt yet) means: load and compute as before. See [uniform-data.md → Page views](uniform-data.md#page-views).

## Service worker

`CACHE_NAME` in `sw.js` and `version` in `version.json` move together. **Increment both** whenever HTML/CSS/JS that users already cached must update. `version.json` `message` is the full-screen “App updated” notice: the highlighted note and a Reload button. It shows only in the top window, so a report inside the shell does not open a second notice. `mzo_app_update.js` fetches that file network-first and reloads desktop and the installed PWA. Do not add an install-app modal. The app-update banner is separate from dump `REPORT_AS_ON`. Do not intercept `*.supabase.co` in `sw.js` (same as Google Sheet CSVs). The network-first list (`isNetworkFirstPath`) covers the shell, the kit files and every rebuilt page. Precache is per file: one missing asset does not stop a new worker from installing. A network-first page is saved on a successful load (query string ignored). Offline navigation uses that saved page. `offline.html` is only for a page that was never saved. `/api/` stays a JSON 503 and is not cached.

**Presentation zoom:** the service worker inserts `/mzo_present.js` into HTML responses (right after `<head>`) unless the page already loads it (`puja.html` does). Skip login, offline, `app.html`, `/power_map/`, and `/accident/map.html`. Cache the original HTML, and inject only on the response sent to the page. If the page already has a full-window scroller (nearly the whole viewport and not a side panel or dialog), zoom the content inside it so `html` does not grow a second scrollbar. Other reports, including NSC, zoom the page itself. A report open in the shell zooms inside its frame only.

**HTTP caching (server.js, `lib/static_cache.js`).** Static text files go out brotli- or gzip-compressed (each file version compressed once and kept in memory). A request with `?v=` for anything but an HTML page is `public, max-age=31536000, immutable`; everything else is `max-age=0` and revalidates by ETag. So a changed shared file **must** get a new `?v=` in every page that loads it, or browsers keep the old copy for a year. On Vercel the CDN serves static files and these headers do not apply.

Add new/changed report URLs to `isNetworkFirstPath()` so an online load still refreshes the page (`/version.json`, `/mzo_app_update.js`). Offline keeps the last saved copy. After activate, the SW posts `MZO_APP_UPDATED`. NSC still paints from IndexedDB first, then `waitForDataset`; if the dump version changed it **reloads** (do not only `console.log`).

## APIs (server.js)

Typical prefixes: `/api/auth/google`, `/api/session-check`, `/api/logout`, `/api/admin/*`, `/api/nsc/*`, `/api/stock/*`, `/api/withheld/*`, `/api/power-map/*`, `/api/defective/meta`, `/api/hub/versions`. Unauthenticated `/api` returns **401 JSON**, not a login HTML redirect. Do **not** add new `/api/.../dataset` routes that pull a Google sheet through Vercel — put the published CSV URL in `DATASETS` instead (see Bharat Net). `GET /api/hub/versions` returns tiny `{ versions, csvUrls }` for NSC, Withheld, Stock, Defective, and Power Map. `GET /api/power-map/meta` is the Power Map version (Supabase `updated_at`). On the VM in mirror mode these and the other meta endpoints take versions and CSV URLs from the snapshot manifest, and `/api/data/*` serves the snapshots (see **Mirror mode** below). Every report API, including `/api/executive/briefing`, needs a session.

**Not served:** the server and Vercel routes return 404 for `server.js`, `package*.json`, `scripts/`, `apps-script/`, server-only `lib/` files, `data/` (except `costcenter.json`) and `.md/.gs/.sql/.py` files. Browser-loaded `lib/` files are listed in `vercel.json` builds; add a new one there and to the allow-list in `server.js`.

Uploads (NSC, stock, defective meter) process the file **in the browser**, then `MzoSheetMirror.publishTab` posts urlencoded chunks to Apps Script (`ContentService` JSON). Bulk bytes do not go through Vercel. Defective Meter uses the same helper as NSC (`lib/sheet_mirror_client.js`). After Apps Script code changes, deploy a **new version** of the **existing** web app (keep the same `/exec` URL). Do not return HtmlService from `doPost` (that is the `ppConfig` web-page error). Google’s `/macros/echo` URL sometimes 404s with that same HTML; the client retries each POST (8 attempts) and, if the tab still fails, restarts from `begin` (3 tries). NSC upload shows those retries in an orange note — leave the page open. If the sheet write still fails, the page offers sheet links plus processed CSVs and **Activate** after a manual File → Import. Withheld publishes 14 columns in ~600-row chunks; NSC Working stays 43 columns. Split by `SCN_STATUS` only: Working/Accepted stay on NSC even if a withheld date or reason is still on the row. Count each `APPL_NO` once (last row wins) so a repeated consumer in one division is not counted twice. If the file has **zero** Withheld-status rows, skip the Withheld `begin` (do not clear Sheet1) and keep the previous Withheld meta. Do not intercept `script.google.com` in `sw.js`. The `nsc_working` workbook runs `apps-script/nsc_mirror_and_followup.gs`; see [apps-script.md](apps-script.md).

**Safety Inspection upload** (VM): `POST /api/safety/upload` takes the safety app's export (.xlsx, CSV, or the HTML table some sites save as ".xls"; at most 20 MB, one upload at a time) from an admin or a user with `safety-sync-autho`. The server reads it in a worker thread with memory and time limits (`lib/safety_parser.js`, `lib/xlsx_lite.js`; no `xlsx` package on the server) and stores canonical CSV as `safety_inspection.csv` in the data folder, served to signed-in users by `GET /api/safety/dataset` (private). The page's bookmarklet posts from the safety app's site with a **short-lived upload token** from `GET /api/safety/meta` (`uploadToken`, 15 minutes, `SAFETY_UPLOAD_TOKEN_MINUTES` up to 720): an HMAC over the scope, expiry and session that only this route accepts, only from `SAFETY_UPLOAD_ORIGINS` (default `https://safetyinsp.wbsedcl.in` and its `http://` form) and without cookies. Never return the session cookie in JSON or accept it as a Bearer token for a browser flow.

**CMO grievance upload** (VM): the CMO portal's export goes through a preview (`POST /api/cmo/upload/preview`: parsed in a worker, blocks and warnings, what changes, a one-time token for 15 minutes) and a commit (`POST /api/cmo/upload/commit` with every warning confirmed); admins can undo (`POST /api/cmo/upload/undo`). Admins and `cmo-upload-autho` only, checked on the server for every call; one upload at a time; off on Vercel. Pages read `CACHE_CMO` from the mirror or `GET /api/cmo/dataset`. See [cmo-upload.md](cmo-upload.md).

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
| `/api/executive/briefing` | Its inputs (report `meta.json`, NSC upload meta) have no snapshots and take 1–2 s to read, so the last Briefing is kept in memory: answered at once while under 10 min old, refreshed in the background once over 2 min (one refresh at a time), computed before answering on a cold start or when older, and refreshed right after a write-through on `nsc_pending`, `withheld`, `pending_mc`, `load_extension`, `disconnection` or the defective datasets. Same response as live. |

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
| `POST /api/admin/users/create`, `update`, `delete`, `approve`, `reject` | `portal_users` (PocketBase only); not with `MZO_USER_STORE=pocketbase`, where users are in `app_users` ([users.md](users.md)) |
| `POST /api/structures/update` | `structure` |
| `POST /api/data/refresh` (browser writes through Apps Script) | the allow-listed keys |

Not wired, on purpose: Google sign-in (last-login and email updates in `portal_users`), activity logs (every page visit) and `POST /api/admin/sync` (a read). Writes that skip the app, such as `si-works/si.html` straight to Supabase or edits on Vercel, reach the mirror at the next scheduled sync.

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

**Tests.** `node vm/dev/test-briefing-cache.js` checks the Briefing cache (simulated clock, slow fixtures, a sync button run end to end). `node vm/dev/test-mirror-server.js` runs `server.js` in both modes with every upstream request answered from fixtures (no network; any upstream write fails it) and checks the byte parity, the manifest versions, `liveVersions` and that original mode has no mirror fields.
