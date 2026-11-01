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
| `login.html` / `index.html` | Login + phone home hub |
| `app.html` | Desktop workstation shell: sidebar, ⌘K search, report pages in keep-alive iframes. See **Workstation shell** |
| `mzo_theme.css` / `mzo_theme.js` | Design system: tokens, UI kit (`ui-*`), legacy-page overlay, theme controller. See **Design system** |
| `mzo_ui.js` | `window.UI` helpers for kit pages (CSV, formatting, offices, tables, charts, drawer) |
| `admin_users.html` | Admin panel for portal users, sources, activity, visitors, Power Map, and corrections. Open a section with `?tab=users|sources|activity|visitors|powermap|corrections`. Each user row shows last use within 15 days (`GET /api/admin/logs?days=15`). The user form has **Sheet links** Yes/No for the home-bar table button. Structure editing stays on `admin.html`. |
| `auth.js` | Client session check + logout |
| `mzo_scope.js` | Login office scope (`window.MzoScope`) |
| `mzo_data_hub.js` | Dataset registry + IndexedDB (`window.mzoDataHub`) |
| `sw.js` | PWA cache; bump `CACHE_NAME` on UI/JS changes |
| `puja-newspaper.css` | Durga Puja broadsheet newspaper theme tokens, typography, Kashful badges, and ambient Dhunuchi aura |
| `lib/` | Code shared with the browser: `nsc_rows.js` (NSC rows), `assistant_catalog.js` (Ask), `sheet_mirror_client.js` (chunked sheet publish), `defective_meter_pipeline.js`; plus the server-only `stock_pipeline.js` |
| `apps-script/` | Google Apps Script sources, deployed by hand as web apps (see [apps-script.md](apps-script.md)); not served |
| `scripts/` | Node/SQL tooling: `sql/`, `sync/`, `migrate/`, `tools/` (see [scripts/README.md](../scripts/README.md)); not served |
| `nsc/`, `stock/`, `power_map/`, `dtr/`, … | Feature folders; each served folder needs a `vercel.json` static build entry |
| `data/` | `costcenter.json` (served) and `structure.csv` (estimate structures, server-only). Everything else in `data/` is git-ignored local data |
| `vercel.json` | Static + `/api` → `server.js` |

## Auth and office scope

**Server:** `requireAuth` in `server.js`. Session cookie `mzo_session` (HMAC-SHA256 with `JWT_SECRET`, 24h; the server warns on Vercel when `JWT_SECRET` is missing). Login reads **Supabase** `mzo_insight.portal_users` (not a live Google Sheet): Username + PIN, or Google sign-in verified against `GOOGLE_CLIENT_ID` and matched by saved email (details in [database.md](database.md#login-rules)). The local test sign-in only works on localhost.

Production stays on the **old** Supabase project (`unsmtschmcvftfqwabaq`) for login until `INSIGHT_LIVE=1`. Power Map always uses that old project. Stock dump + authorized upload use the new project when `STOCK_USE_STORAGE=1` and `INSIGHT_SUPABASE_URL` / `INSIGHT_SUPABASE_KEY` are set. Then DataHub `CACHE_STOCK` uses Storage `csvUrl`; users with **Stock Raw Upload** (or admin) `PUT` the cleaned CSV with a signed URL that **upserts** `stock/snapshot.csv` (bytes do not go through Vercel). The signed path Supabase returns is `/object/upload/sign/...`; prefix it with `/storage/v1` or the browser PUT 404s. If a publish still posts CSV to `/api/stock/publish`, the server also overwrites that Storage object so the dashboard date cannot lag the upload meta. Do not set `INSIGHT_LIVE` until `npm run copy:insight` has copied `portal_users` and you are ready to switch login. Copy from `scripts/supabase_config.example.json` into gitignored `data/supabase_config.json`. Never put the service_role key in HTML or git.

Stock storage and the insight cutover: [stock.md](stock.md).

**PINs:** stored as `scrypt$` hashes. A still-plain PIN is accepted once at login and then replaced with the hash. `GET /api/admin/users` does not include `PIN`. A blank PIN on user update keeps the current one. Remember me stores `mzo_saved_username` only and deletes `mzo_saved_pin`. `/server.js` and `/data/` are not served. Do not put the service role key in HTML.

**Client profile:** `localStorage.mzo_user_profile` (PIN stripped). Scope fields: `role`, `zone_code`, `region_code`, `division_code`, `ccc_code`, plus module flags (`nsc-autho`, `nsc-upload-autho`, `defective-upload-autho`, `stock-upload-autho`, `si-autho`, `sheets-autho`, …). The home bar reads this profile. After an admin changes a flag, the user must sign in again so the stored profile refreshes.

Sheet links (the hub's table button) has its own rules: see [reports.md](reports.md#sheet-links).

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

**Do not send report data through Vercel.** Register the **Google published CSV** (or other origin URL) in `DATASETS`. The browser fetches it; IndexedDB holds the body. Login/session/admin and tiny `/api/.../meta` JSON are the only Vercel APIs involved in data loading. Do not add `/api/.../dataset` proxies that GET a sheet and return CSV. `originHeavy` dumps (NSC, Withheld, Stock) still have a dataset URL as a last-resort fallback — homepage Sync uses `skipVercelBody` and prefers origin `csvUrl` from meta so dump bytes do not transit Vercel.

Datasets are registered in `mzo_data_hub.js` `DATASETS`. IndexedDB holds the CSV/JSON body. `localStorage` key `mzo_hub_ver_<CACHE_KEY>` holds the version.

```js
await window.mzoDataHub.waitForDataset('CACHE_NSC_v5');
const csv = await window.mzoDataHub.get('CACHE_NSC_v5');
```

**Versioned load (required):** `get()` / `waitForDataset` revalidate with a cheap check — `GET /api/hub/versions` during home Sync, then `/api/.../meta` when `versionUrl` is set, otherwise HEAD / Range probe (`Content-Length`, ETag). If the stored version matches and IndexedDB already has a body, **do not download the CSV**. If the version cannot be read cheaply: **lazy** dumps keep the cache; **clerk sheets** (Loss, Collection, …) re-download on header Sync or a new calendar day. Loss page uses `waitForDataset(..., { forceCheck: true })` so a same-day sheet paste (e.g. August) replaces the July cache. Pages should `_peek` (or `UI.load`) and paint first, then `waitForDataset` in the background. Replacing a raw dump also deletes its parsed companion (`CACHE_NSC_PARSED_v7`, `CACHE_WITHHELD_PARSED_v4`, `CACHE_PENDING_MC_PARSED`, `CACHE_METER_PARSED_v1`).

Version strings are prefixed: `v:` API meta, `e:` ETag, `m:` Last-Modified, `l:` Content-Length, `f:` body fingerprint. Length-prefixed versions can match each other. Ignore `Content-Length: 0` / `l:0` (Google published CSVs often send that on HEAD) and fall through to a Range probe or a full GET; after download store a fingerprint instead of `l:0`. `refresh(key)` clears the stored version and forces a download (use after an upload).

**Sync Data** (home header refresh) is a version check, not a wipe and not a blind re-download:

- Daily/auto (first visit of the day): `forceCheck` on every non-`lazySync` dataset, including NSC / stock / withheld. Download only if the cheap version differs.
- Manual Sync: version-check `lazySync` dumps (meter, CAPEX, disconnection, defective, PMSGY, safety) without downloading the body unless the version changed. Overlay shows remaining checks, then **Checked N · Updated M**.
- Open a report from IndexedDB immediately if a body exists; do not wait on home Sync.
- Do not skip a dataset because `syncStatus === 'done'` when `forceCheck` is set.

| Flag | Meaning |
|------|---------|
| `originHeavy` | Prefer origin `csvUrl` from `/api/.../meta` (NSC, Withheld, Stock). Included in Sync for version checks. Dump bodies are never downloaded through Vercel. Stock `csvUrl` is Google until `STOCK_USE_STORAGE` is on, then Supabase Storage. |
| `lazySync` | Skip daily homepage sync. Manual Sync cheap-checks only (no multi-MB GET). Version-check on page open. |
| `versionUrl` / `versionField` | JSON meta for version (Withheld uses `withheldVersion`) |

Do **not** `fetch()` or `Papa.parse(url, { download: true })` a Google Sheet from a page if a DataHub key exists. Register the URL in `DATASETS`, then `waitForDataset` + `get`. On the home hub, set `data-dataset="CACHE_…"`.

Hub keys in use: `CACHE_NSC_v5`, `CACHE_WITHHELD_v4`, `CACHE_STOCK`, `CACHE_POWER_MAP`, `CACHE_SOLAR`, `CACHE_JJM`, `CACHE_WRIDD`, `CACHE_BHARATNET`, `CACHE_METER_*`, `CACHE_DEFECTIVE`, `CACHE_DEFECTIVE_DETAILS`, plus collection/loss/weekly/docket/REM/capex/etc. in `DATASETS`. `window.MZO_DATASETS` is that same list. Admin → Sources classifies each report as Sheet, Supabase, JSON, Script, or RSS. Sheet rows have a small open control and a copy control for the spreadsheet link only. Stock’s label follows `/api/stock/meta` `source` (Supabase Storage vs Google Sheet).

Bump the **cache key** (`CACHE_FOO_v2`) if the stored row shape changes. Large dumps stay out of git (see `.gitignore` / `.vercelignore`).

## Service worker

`CACHE_NAME` in `sw.js` and `version` in `version.json` move together. **Increment both** whenever HTML/CSS/JS that users already cached must update. `version.json` `message` is the full-screen “App updated” notice: the highlighted note and a Reload button. It shows only in the top window, so a report inside the home frame does not open a second notice. `mzo_app_update.js` fetches that file network-first and reloads desktop and the installed PWA. Do not add an install-app modal. The app-update banner is separate from dump `REPORT_AS_ON`. Do not intercept `*.supabase.co` in `sw.js` (same as Google Sheet CSVs). The network-first list (`isNetworkFirstPath`) covers the shell, the hub, the kit files and every rebuilt page. Precache is per file: one missing asset does not stop a new worker from installing. A network-first page is saved on a successful load (query string ignored). Offline navigation uses that saved page. `offline.html` is only for a page that was never saved. `/api/` stays a JSON 503 and is not cached.

**Presentation zoom:** the service worker inserts `/mzo_present.js` into HTML responses (right after `<head>`). `index.html` already includes that script, so the worker must not insert a second copy. Skip login, offline, `app.html`, `/power_map/`, and `/accident/map.html`. Cache the original HTML, and inject only on the response sent to the page. If the page already has a full-window scroller (the home hub `.page`, nearly the whole viewport and not a side panel or dialog), zoom the content inside it so `html` does not grow a second scrollbar. Other reports, including NSC, zoom the page itself. A report open in the home iframe zooms inside that frame only.

Add new/changed report URLs to `isNetworkFirstPath()` so an online load still refreshes the page (`/version.json`, `/mzo_app_update.js`). Offline keeps the last saved copy. After activate, the SW posts `MZO_APP_UPDATED`. NSC still paints from IndexedDB first, then `waitForDataset`; if the dump version changed it **reloads** (do not only `console.log`).

## APIs (server.js)

Typical prefixes: `/api/login`, `/api/auth/google`, `/api/session-check`, `/api/logout`, `/api/admin/*`, `/api/nsc/*`, `/api/stock/*`, `/api/withheld/*`, `/api/power-map/*`, `/api/defective/meta`, `/api/hub/versions`. Unauthenticated `/api` returns **401 JSON**, not a login HTML redirect. Do **not** add new `/api/.../dataset` routes that pull a Google sheet through Vercel — put the published CSV URL in `DATASETS` instead (see Bharat Net). `GET /api/hub/versions` returns tiny `{ versions, csvUrls }` for NSC, Withheld, Stock, Defective, and Power Map. `GET /api/power-map/meta` is the Power Map version (Supabase `updated_at`). Every report API, including `/api/executive/briefing`, needs a session. `POST /api/dtr/verify-pin` checks a DTR PIN on the server (rate-limited); PINs never reach the browser.

**Not served:** the server and Vercel routes return 404 for `server.js`, `package*.json`, `scripts/`, `apps-script/`, server-only `lib/` files, `data/` (except `costcenter.json`) and `.md/.gs/.sql/.py` files. Browser-loaded `lib/` files are listed in `vercel.json` builds; add a new one there and to the allow-list in `server.js`.

Uploads (NSC, stock, defective meter) process the file **in the browser**, then `MzoSheetMirror.publishTab` posts urlencoded chunks to Apps Script (`ContentService` JSON). Bulk bytes do not go through Vercel. Defective Meter uses the same helper as NSC (`lib/sheet_mirror_client.js`). After Apps Script code changes, deploy a **new version** of the **existing** web app (keep the same `/exec` URL). Do not return HtmlService from `doPost` (that is the `ppConfig` web-page error). Google’s `/macros/echo` URL sometimes 404s with that same HTML; the client retries each POST (8 attempts) and, if the tab still fails, restarts from `begin` (3 tries). NSC upload shows those retries in an orange note — leave the page open. If the sheet write still fails, the page offers sheet links plus processed CSVs and **Activate** after a manual File → Import. Withheld publishes 14 columns in ~600-row chunks; NSC Working stays 43 columns. Split by `SCN_STATUS` only: Working/Accepted stay on NSC even if a withheld date or reason is still on the row. Count each `APPL_NO` once (last row wins) so a repeated consumer in one division is not counted twice. If the file has **zero** Withheld-status rows, skip the Withheld `begin` (do not clear Sheet1) and keep the previous Withheld meta. Do not intercept `script.google.com` in `sw.js`. The `nsc_working` workbook runs `apps-script/nsc_mirror_and_followup.gs`; see [apps-script.md](apps-script.md).

**Who can upload NSC:** `GET /api/nsc/meta` → `canUpload`. True if `role` is `admin` (case-insensitive), or portal flag `nsc-upload-autho` / `nsc_upload_autho` is Y/yes/1/true/upload, or username `dm1`. Admins always can, even if the flag is blank. The Date / Excel / Upload controls stay disabled until that JSON returns true.

**NSC upload UI** (`nsc/upload.html`): Date, Excel, Upload only. Do not add pipeline essays, Apps Script paste notes, or a how-to box. Last live counts may sit on one muted line. Fail UI (sheet link + CSV) appears only after a write error.
