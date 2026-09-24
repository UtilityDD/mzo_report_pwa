# MZO Reports PWA — Developer Guide

Living guide for this repo. **Update this file** whenever you add a portal, change auth/scope, data loading, caching, or deploy paths.

Companion notes (topic-specific): `scripts/README_*.md`, `stock/README_ALLOTMENT.md`.

---

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

---

## Layout

| Path | Role |
|------|------|
| `server.js` | Auth cookie, `/api/*`, static hosting |
| `login.html` / `index.html` | Login + home hub |
| `admin_users.html` | Admin panel for portal users, sources, activity, visitors, Power Map, and corrections. Open a section with `?tab=users|sources|activity|visitors|powermap|corrections`. Each user row shows last use within 15 days (`GET /api/admin/logs?days=15`). The user form has **Sheet links** Yes/No for the home-bar table button. Structure editing stays on `admin.html`. |
| `auth.js` | Client session check + logout |
| `mzo_scope.js` | Login office scope (`window.MzoScope`) |
| `mzo_data_hub.js` | Dataset registry + IndexedDB (`window.mzoDataHub`) |
| `sw.js` | PWA cache; bump `CACHE_NAME` on UI/JS changes |
| `lib/` | Shared parsers (NSC, stock, …) |
| `nsc/`, `stock/`, `rem/`, … | Feature folders |
| `data/` | Local JSON/CSV fallbacks |
| `vercel.json` | Static + `/api` → `server.js` |

---

## Auth and office scope

**Server:** `requireAuth` in `server.js`. Session cookie `mzo_session` (HMAC, 24h). Login reads **Supabase** `mzo_insight.portal_users` (not a live Google Sheet).

Production stays on the **old** Supabase project (`unsmtschmcvftfqwabaq`) for login until `INSIGHT_LIVE=1`. Power Map always uses that old project. Stock dump + authorized upload use the new project when `STOCK_USE_STORAGE=1` and `INSIGHT_SUPABASE_URL` / `INSIGHT_SUPABASE_KEY` are set. Then DataHub `CACHE_STOCK` uses Storage `csvUrl`; users with **Stock Raw Upload** (or admin) `PUT` the cleaned CSV with a signed URL that **upserts** `stock/snapshot.csv` (bytes do not go through Vercel). The signed path Supabase returns is `/object/upload/sign/...`; prefix it with `/storage/v1` or the browser PUT 404s. If a publish still posts CSV to `/api/stock/publish`, the server also overwrites that Storage object so the dashboard date cannot lag the upload meta. Do not set `INSIGHT_LIVE` until `npm run copy:insight` has copied `portal_users` and you are ready to switch login. Copy from `scripts/supabase_config.example.json` into gitignored `data/supabase_config.json`. Never put the service_role key in HTML or git.

Companion: `scripts/README_STOCK_SUPABASE.md`.

**Client profile:** `localStorage.mzo_user_profile` (PIN stripped). Scope fields: `role`, `zone_code`, `region_code`, `division_code`, `ccc_code`, plus module flags (`nsc-autho`, `nsc-upload-autho`, `defective-upload-autho`, `stock-upload-autho`, `si-autho`, `sheets-autho`, …). The home bar reads this profile. After an admin changes a flag, the user must sign in again so the stored profile refreshes.

**Sheet links (home-bar table button):** `#uploadListBtn` on `index.html` opens `sheet_links.html` like any other report (`openPage`). Home and back stay on the report viewer (back arrow and title). The page does not add its own home button or a second title. Hidden unless the user is `admin` or `sheets-autho` is `list`, `edit`, `y`, or `all`. The page is a numbered table of Google Sheet links only (not Supabase, JSON, Script, or RSS). Each row opens the spreadsheet and copies that link. **Updated** is filled when a date is already known: DataHub `mzo_hub_ver_*` (`m:` Last-Modified or an ISO time), `/api/hub/versions`, NSC/Withheld meta, defective upload meta, or stock meta. Disconnection Tracker uses the same date as that page’s header: the latest `PAID/DISCON DATE`, shown as `dd/mm/yyyy`. Docket Calls uses the same day as “Upto docket at”: the latest `doc_crn_dt`, shown as `dd/mm/yyyy`. CMO Grievances uses the same “Report as on” value as that page’s header (`Report Date`). Collection Report uses the end of the header period, the latest payment date. Stock Metadata uses the stock page header date, “Stock of Major Materials (dd/mm/yyyy)”, from the stock report date. Every Updated cell uses `dd/mm/yyyy`. Otherwise the cell stays an em dash. Stock and Power Map are omitted while their source is not a Google Sheet. Vendor Map and PMSGY Data 0, 1, and 2 are left off this list. NSC and Withheld use fixed edit URLs when `/api/nsc/meta` is slow. Admin → user form → **Sheet links** = Yes stores `list` (the button only). **Sheets** = Manage stores `edit`, which also shows the button and can manage Important Sheets. `''` shows neither the button nor manage. NSC upload and other report grants do not show the button. Column is existing `mzo_insight.portal_users.sheets_autho` (`scripts/alter_portal_users_sheets_auth.sql`). `canManageImportantSheets` still treats only `edit` / `y` / `all` (and admin) as manage. Network-first: `/sheet_links.html`.

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

---

## DataHub

**Do not send report data through Vercel.** Register the **Google published CSV** (or other origin URL) in `DATASETS`. The browser fetches it; IndexedDB holds the body. Login/session/admin and tiny `/api/.../meta` JSON are the only Vercel APIs involved in data loading. Do not add `/api/.../dataset` proxies that GET a sheet and return CSV. `originHeavy` dumps (NSC, Withheld, Stock) still have a dataset URL as a last-resort fallback — homepage Sync uses `skipVercelBody` and prefers origin `csvUrl` from meta so dump bytes do not transit Vercel.

Datasets are registered in `mzo_data_hub.js` `DATASETS`. IndexedDB holds the CSV/JSON body. `localStorage` key `mzo_hub_ver_<CACHE_KEY>` holds the version.

```js
await window.mzoDataHub.waitForDataset('CACHE_NSC_v5');
const csv = await window.mzoDataHub.get('CACHE_NSC_v5');
```

**Versioned load (required):** `get()` / `waitForDataset` revalidate with a cheap check — `GET /api/hub/versions` during home Sync, then `/api/.../meta` when `versionUrl` is set, otherwise HEAD / Range probe (`Content-Length`, ETag). If the stored version matches and IndexedDB already has a body, **do not download the CSV**. If the version cannot be read cheaply: **lazy** dumps keep the cache; **clerk sheets** (Loss, Collection, …) re-download on header Sync or a new calendar day. Loss page uses `waitForDataset(..., { forceCheck: true })` so a same-day sheet paste (e.g. August) replaces the July cache. Pages should `_peek` (or `peekThenRevalidate`) and paint first, then `waitForDataset` in the background. Replacing a raw dump also deletes its parsed companion (`CACHE_NSC_PARSED_v7`, `CACHE_WITHHELD_PARSED_v4`, `CACHE_PENDING_MC_PARSED`, `CACHE_METER_PARSED_v1`).

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

---

## Service worker

`CACHE_NAME` in `sw.js` is currently `mzo-reports-cache-v154` (`version.json` **1.70**). **Increment both** whenever HTML/CSS/JS that users already cached must update. `version.json` `message` is the “App updated” banner. `mzo_app_update.js` fetches that file network-first and reloads desktop and the installed PWA. Do not add an install-app modal. The app-update banner is separate from dump `REPORT_AS_ON`. Do not intercept `*.supabase.co` in `sw.js` (same as Google Sheet CSVs). Network-first already includes `/index.html`, `/sheet_links.html`, `/admin_users.html`, `/stock/upload.html`, `/mzo_data_hub.js`, `/mzo_present.js`, and `/version.json`. A network-first page is saved on a successful load (query string ignored). Offline navigation uses that saved page. `offline.html` is only for a page that was never saved. `/api/` stays a JSON 503 and is not cached.

**Presentation zoom:** the service worker inserts `/mzo_present.js` into HTML responses (right after `<head>`). `index.html` already includes that script, so the worker must not insert a second copy. Skip login, offline, `/power_map/`, `/sld/`, and `/accident/map.html`. Cache the original HTML, and inject only on the response sent to the page. If the page already has a full-window scroller (the home hub `.page`, nearly the whole viewport and not a side panel or dialog), zoom the content inside it so `html` does not grow a second scrollbar. Other reports, including NSC, zoom the page itself. A report open in the home iframe zooms inside that frame only.

Add new/changed report URLs to `isNetworkFirstPath()` so an online load still refreshes the page (`/version.json`, `/mzo_app_update.js`). Offline keeps the last saved copy. After activate, the SW posts `MZO_APP_UPDATED`. NSC still paints from IndexedDB first, then `waitForDataset`; if the dump version changed it **reloads** (do not only `console.log`).

---

## Git remotes and production

Two GitHub remotes, **one** production URL. Keep both GitHub copies on the same `main` commit. Do not deploy to the old Dipankar project.

| Remote | URL | Role |
|--------|-----|------|
| `origin` | https://github.com/UtilityDD/mzo_report_pwa.git | Mirror / backup |
| `smartlineman` | https://github.com/smartlinemanapp/mzo-reports.git | Source for Vercel (Git connected) |

On a new machine:

```
git remote add origin https://github.com/UtilityDD/mzo_report_pwa.git
git remote add smartlineman https://github.com/smartlinemanapp/mzo-reports.git
```

**Production (users and PWA):** https://mzo-reports.vercel.app  
Vercel project: [smart-linemans-projects/mzo-reports](https://vercel.com/smart-linemans-projects/mzo-reports). Unique hostnames such as `mzo-reports-xxxx.vercel.app` are the same deployment — do not share them and do not delete that deployment.

**Retired:** https://mzo-report-pwa.vercel.app (Dipankar / `mzo-report-pwa`). Do **not** auto-redirect that host and do **not** allow login there. `mzo_origin_redirect.js` (login, home, and via `auth.js` on report pages) freezes the page with the new URL, a **Copy** button, and steps to open https://mzo-reports.vercel.app/login.html in Chrome/Safari and tap **Install app**. The new origin uses a **gold MZO icon** (`icons/icon-*-v2.png` + `manifest.json`); the retired host keeps the navy icon (`manifest-legacy.json`, chosen by `mzo_pwa_icons.js`) so both can sit on a home screen. The freeze is a no-op on the new origin. Do not add a `vercel.json` catch-all redirect. After changing the freeze, deploy **once** to the old project (`npx vercel --prod --yes --scope dipankar-das-projects-1592747b`) if it is not Git-connected. Then leave that project idle.

---

## Deploy

There is no webpack/vite build. Local run is `npm run dev`. Production is **only** https://mzo-reports.vercel.app

1. Leave one-off `scripts/analyze_*` / `scripts/patch_*` and dataset dumps untracked. Do not commit `.env`, `consumer/*.csv`, or root CSVs such as `bharatnet.csv`.
2. Bump `CACHE_NAME` in `sw.js` and `version` + `message` in `version.json` when users must receive HTML/JS changes.
3. Commit product files, then push **both** remotes so GitHub stays in sync:
   ```
   git push origin main
   git push smartlineman main
   ```
4. Vercel builds from the **smartlineman** GitHub repo. After the `smartlineman` push, confirm the change on https://mzo-reports.vercel.app (login-gated pages need a real portal user). A unique `mzo-reports-….vercel.app` URL is not the public link.
5. Manual CLI only if the Git deploy did not run, and only while logged into the **Smart Lineman** Vercel team: `npx vercel --prod --yes --scope smart-linemans-projects`. `npx vercel --prod --yes` without that scope can hit the wrong account or return Not authorized. Env vars (`JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_KEY`, `INSIGHT_SUPABASE_URL`, `INSIGHT_SUPABASE_KEY` / `SUPABASE_SERVICE_ROLE_KEY`, `STOCK_USE_STORAGE`, sheet `/exec` URLs) live on the Smart Lineman project; the retired Dipankar project had none (code fallbacks in `server.js`). Stock Storage is already on (`STOCK_USE_STORAGE` plus the insight URL and service key). Do not set `INSIGHT_LIVE` until `npm run copy:insight` has copied `portal_users` and login should move to the new project.

---

## Adding a report page

1. Create `feature.html` (or `feature/index.html`). Register it on the home hub in `index.html` with `data-dataset="CACHE_…"` when it uses DataHub.
2. Include `mzo_data_hub.js` and `mzo_scope.js?v=N` (bump `N` when `mzo_scope.js` changes).
3. Add the **Google** (or other origin) URL to `DATASETS` in `mzo_data_hub.js`. Load with `waitForDataset` then `get` — never a raw sheet `fetch` if a hub key exists, and never an `/api/.../dataset` body proxy.
4. After load: `raw = MzoScope.filterRows(raw)` then populate filters; if selects are locked, fill from scoped unique values / `getScope()`, then `lockFilters()`.
5. Add the path to `sw.js` `isNetworkFirstPath` and bump `CACHE_NAME`.
6. If the folder is new, add it to `vercel.json` `builds`.
7. **Mobile:** do not stick a stacked filter block. Keep a **single ~42–48px** sticky bar; put search/filters behind a toggle overlay (`meter_utilization.html` is the pattern). Date strips should stay one scrolling row, not a column of cards.
8. Verify on a **phone width** (and ~900px tablet). Login-gated pages cannot be checked with anonymous `curl` of the HTML.

---

## UI conventions

- Prefer existing page look (Outfit/Inter, cards, KPI grids). Do not introduce a new CSS framework on one page.
- Sticky chrome must stay thin on mobile; overlays must not grow the sticky box (`position: absolute` / `fixed`, not in-flow). Pending NSC (`nsc.html`) keeps the 42px header and opens search and filters from the sliders button on a phone. Desktop still shows that filter block in the page.
- Clicking a status KPI (e.g. Disconnection Tracker Fully paid / Disconnected) must filter **charts and table only**. Other KPI totals stay on the broader filter set (office, class, search, breadcrumb) and must not shrink each other. Each status card shows the count with its percent of the total on the same line (`5,182 · 26%`), and the amount on the line below (paid for fully and partly paid, outstanding for disconnected and no action). **Follow-ups** is consumers with a follow-up in the last 7 days, shown the same way (`1 · <0.1%`). It opens the Follow-ups tab and does not filter the other KPIs. The Follow-ups tab is a table in the same style as the consumer table. A row shows the consumer only and opens a follow-up modal with that consumer’s notes, latest first. Each note shows the author and the date in small secondary text. Only an admin (`mzo_user_profile.role` is `admin`) sees the delete control on Disconnection Tracker and Pending NSC follow-ups.
- `home-button.js` injects a floating Home control — do not duplicate a second home bar in the header. The home hub’s back arrow sits at the bottom-left of a report. The report frame stops about 88px above the screen bottom so the last line is not covered.
- **Presentation zoom** (`mzo_present.js`): desktop only (width ≥ 900px), fixed bottom-right. Steps are 100 / 125 / 150 / 175, stored in `localStorage` key `mzo_present_zoom`. `+` / `-` step the size and `0` resets, when focus is not in a field. Do not add a second zoom control on report pages. Zoom stays inside the page’s existing scroller so the window does not gain a second vertical scrollbar. Power Map, SLD, and the accident map keep their own pan/zoom. Phones stay at 100% and the control stays hidden.
- When a dashboard mixes **counts-only** KPIs and **named-row** KPIs, split them into two labeled bands (Count vs Names). Use one card style. Count-only rows must not open a names modal. Defective Meter is the reference.
- Home hub (`index.html`): **Often used** (`#favoritesCard`, class `always-open`) sits above New Service Connection and stays expanded on mobile. Each page tile has a star (`.fav-btn`); pins are stored per login in `localStorage` key `mzo_page_favorites_<Username>`. Do not collapse `always-open` groups in `initCollapsibleCards`. There is no admin icon in the home bar. Admins open **Administration** on the home hub: Users, Sources, Activity, Visitors, Power Map, and Corrections (`admin_users.html?tab=`) plus Structure (`admin.html`). The header **Sheet links** button (`#uploadListBtn`, table icon) is the only sheet-list entry. Do not put a sheet icon on each report tile. Authorization is Admin → **Sheet links**, not NSC upload or other report grants. See **Sheet links** under Auth.

---

## APIs (server.js)

Typical prefixes: `/api/login`, `/api/session-check`, `/api/logout`, `/api/admin/*`, `/api/nsc/*`, `/api/stock/*`, `/api/withheld/*`, `/api/power-map/*`, `/api/defective/meta`, `/api/hub/versions`. Unauthenticated `/api` returns **401 JSON**, not a login HTML redirect. Do **not** add new `/api/.../dataset` routes that pull a Google sheet through Vercel — put the published CSV URL in `DATASETS` instead (see Bharat Net). `GET /api/hub/versions` returns tiny `{ versions, csvUrls }` for NSC, Withheld, Stock, Defective, and Power Map. `GET /api/power-map/meta` is the Power Map version (Supabase `updated_at`).

Uploads (NSC, stock, defective meter) process the file **in the browser**, then `MzoSheetMirror.publishTab` posts urlencoded chunks to Apps Script (`ContentService` JSON). Bulk bytes do not go through Vercel. Defective Meter uses the same helper as NSC (`lib/sheet_mirror_client.js`). After Apps Script code changes, deploy a **new version** of the **existing** web app (keep the same `/exec` URL). Do not return HtmlService from `doPost` (that is the `ppConfig` web-page error). Google’s `/macros/echo` URL sometimes 404s with that same HTML; the client retries each POST (8 attempts) and, if the tab still fails, restarts from `begin` (3 tries). NSC upload shows those retries in an orange note — leave the page open. If the sheet write still fails, the page offers sheet links plus processed CSVs and **Activate** after a manual File → Import. Withheld publishes 14 columns in ~600-row chunks; NSC Working stays 43 columns. Split by `SCN_STATUS` only: Working/Accepted stay on NSC even if a withheld date or reason is still on the row. Count each `APPL_NO` once (last row wins) so a repeated consumer in one division is not counted twice. If the file has **zero** Withheld-status rows, skip the Withheld `begin` (do not clear Sheet1) and keep the previous Withheld meta. Do not intercept `script.google.com` in `sw.js`. NSC script to paste is `lib/sheet_mirror_publish.gs` (not the defective-meter file).

**Who can upload NSC:** `GET /api/nsc/meta` → `canUpload`. True if `role` is `admin` (case-insensitive), or portal flag `nsc-upload-autho` / `nsc_upload_autho` is Y/yes/1/true/upload, or username `dm1`. Admins always can, even if the flag is blank. The Date / Excel / Upload controls stay disabled until that JSON returns true.

**NSC upload UI** (`nsc/upload.html`): Date, Excel, Upload only. Do not add pipeline essays, Apps Script paste notes, or a how-to box. Last live counts may sit on one muted line. Fail UI (sheet link + CSV) appears only after a write error.

---

## Bharat Net

Page: `bharatnet.html` (home hub New Service Connection, `data-dataset="CACHE_BHARATNET"`). DataHub URL is the published Google CSV (`pub?gid=0&single=true&output=csv`). The browser fetches it; do not proxy through Vercel or commit a fallback CSV. After load: `MzoScope.filterRows`. Rows have `CCC NAME` / `CCC CODE` only — map Region / Division from `MzoScope`. **Connected** = `METER NUMBER` is non-empty.

## Disconnection tracker

Page: `disconnection.html` (DataHub `CACHE_DISCONNECTION`). On a phone the sticky bar keeps the title and a quiet DOM and IND/COM date line. Search and office filters open from the sliders button. Follow-ups live in the consumer modal and on the **Follow-ups** tab, newest first, matched on the trimmed consumer number (`CON_ID` / `c.id`). Each note stores the signed-in user's **Name** (`mzo_user_profile.Name`, or Username if Name is blank) and the save time. Replacing the consumer dump does not clear them.

Save paints the new note at the top of the open list and clears the box in the same click, into `localStorage` (`mzo_discon_followups`). The sheet write (`mzo_discon_followup_outbox`) starts only after that paint. A slow or failed write retries in the background. A row with no consumer number cannot save a follow-up. Pending NSC uses the same order: the note appears and the box clears before `mzo_nsc_followup_outbox` is sent.

Shared copy is a **Followups** tab via `lib/disconnection_followup.gs` (append and soft-delete, not a republish of the consumer dump). Soft-delete is an admin action on the page. `GET /api/disconnection/meta` returns `sheetScriptUrl` from `DISCONNECTION_FOLLOWUP_SCRIPT_URL` (the Followups web app; env overrides the default `/exec` URL). The open page pulls the comment list about every 15 seconds, when the tab becomes visible, and when a consumer modal opens. That pull refreshes the follow-up list only. It does not reload the disconnection CSV. Do not proxy the comment sheet through Vercel.

Pending NSC (`nsc.html`) uses the same follow-up rule on the trimmed application number (`APPL_NO`), in its own store `mzo_nsc_followups` and outbox `mzo_nsc_followup_outbox`. Paste `lib/nsc_mirror_and_followup.gs` over the existing nsc_working Apps Script and deploy a new version of that same web app. `lib/nsc_followup.gs` is the follow-up portion only; do not paste it over the dump script. `GET /api/nsc/followup-meta` returns `sheetScriptUrl` from `NSC_FOLLOWUP_SCRIPT_URL` (the same nsc_working `/exec` URL; env overrides the default). A new NSC upload keeps a note when the same application number is still in the file. The Follow-ups pill lists those applications in the current filters as a table in the same style as the application list. A row opens the note list, latest first, with the author and date in small text. The delete control is shown only when the signed-in role is admin.

## Defective Meter

Page: `consumer/defective_meter.html` (home hub `data-dataset="CACHE_DEFECTIVE"`). Summary is DataHub `CACHE_DEFECTIVE` (Google export CSV); details is `CACHE_DEFECTIVE_DETAILS`. Publish uses `GET /api/defective/meta` → `sheetScriptUrl`, then `MzoSheetMirror.publishTab` to Apps Script (same as NSC). After publish, `mzoDataHub.refresh` both keys.

**Who can upload:** `GET /api/defective/meta` → `canUpload`. True if `role` is `admin` (case-insensitive), or portal flag `defective-upload-autho` / `defective_upload_autho` is Y/yes/1/true/upload, or username `dm1`. Admins always can, even if the flag is blank. The page also shows upload from `/api/session-check` / `mzo_user_profile` so a stale cookie without `role` does not hide the button.

**Admin UI:** User Administration → **Def. meter upload** Yes/No. Persist column `mzo_insight.portal_users.defective_upload_autho` (`scripts/alter_portal_users_defective_upload_auth.sql` if the table already exists, then `NOTIFY pgrst, 'reload schema'`). Mapped in `portalUserToClient` / `clientUserToPortal`.

**Upload UI:** file picker + Publish only. Do **not** add setup copy (summary vs details, “processed in this browser”, Open sheet, Apps Script URL). Pipeline: `lib/defective_meter_pipeline.js` → `lib/defective_meter_publish.gs`. Network-first: `/consumer/defective_meter.html`, `/lib/defective_meter_pipeline.js`, `/lib/sheet_mirror_client.js`, `/mzo_data_hub.js`, and `/admin_users.html`.

**KPI UI (two data kinds):** Summary tab is counts for every meter; details tab stores names only for priority groups (`DETAILS_FLAG` / `isPriorityMetric()`). Split the dashboard into two bands with one card style (no mixed Bootstrap tints): **All meters / Count** — Total, Agri, >5 yrs, Load 0.5–1, Load <0.5 — tables only, no consumer modal. **Priority / Names** — >10 yrs, 3-Ph, Industrial, Smart, Load >6 / 3–6 / 1–3 — By CCC or By Load drills to the consumer list. Count-only CCC rows must not open the names modal.

Upload the **consumer dump** (one row per meter), not a summary. The parser accepts comma / tab / pipe / semicolon and maps aliases (`CCC CODE` → `CCC_CODE`, `CONS_ID` → `CON_ID`, …). If office columns do not map, every row collapses into one blank-office total — the pipeline rejects that instead of publishing it. Agri = BASE_CLASS `A` (not Rural `R`). Industrial = `I`. Smart = meter no `IJ`/`IL`/`IT` or type SMART — not `ELECTRONIC`. The last dump stored Rural/Urban as class and `ELECTRIONIC` as meter no, so those KPIs were zero; re-upload after this parser.

Portal user SQL/import notes: `scripts/README_PORTAL_USERS.md`.

---

## Keep this guide current

When a change affects how the next developer (or agent) should work, update **this file in the same PR/change**:

- New portal, dataset key, API, or auth field
- DataHub versioning / `waitForDataset` behaviour
- Scope matching / filter-lock behaviour
- SW cache or `vercel.json` paths
- Git remotes, production URL, or Vercel team/project
- A new UI pattern that other pages should copy (or stop using)

Companion: `scripts/README_PORTAL_USERS.md` (Supabase `portal_users` columns and ALTER scripts) and `scripts/README_STOCK_SUPABASE.md` (new insight project cutover). Do not let topic READMEs contradict this guide; link them from here instead of duplicating.
