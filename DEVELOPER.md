# MZO Reports PWA — Developer Guide

Living guide for this repo. **Update this file** whenever you add a portal, change auth/scope, data loading, caching, or deploy paths.

Companion notes (topic-specific): `scripts/README_*.md`, `stock/README_ALLOTMENT.md`.

---

## What this app is

Login-gated **PWA** for Malda Zone (WBSEDCL) operational reports. Most screens are standalone HTML pages with inline CSS/JS, not a SPA framework.

- **Local / Vercel:** Express in `server.js` (auth, APIs, static files).
- **Data:** Google Sheets CSVs, uploaded dumps, and Supabase (`mzo_insight` + Power Map tables).
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
| `admin_users.html` | Portal users (Supabase `portal_users`) |
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

**Client profile:** `localStorage.mzo_user_profile` (PIN stripped). Scope fields: `role`, `zone_code`, `region_code`, `division_code`, `ccc_code`, plus module flags (`nsc-autho`, `nsc-upload-autho`, `defective-upload-autho`, `si-autho`, …).

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

Datasets are registered in `mzo_data_hub.js` `DATASETS`. IndexedDB holds the CSV/JSON body. `localStorage` key `mzo_hub_ver_<CACHE_KEY>` holds the version.

```js
await window.mzoDataHub.waitForDataset('CACHE_NSC_v5');
const csv = await window.mzoDataHub.get('CACHE_NSC_v5');
```

**Versioned load (required):** `get()` / `waitForDataset` revalidate once per page load with a cheap check — `/api/.../meta` when `versionUrl` is set, otherwise `HEAD` plus `If-None-Match` / `If-Modified-Since`. If the stored version matches and IndexedDB already has a body, **do not download the CSV**. If the version changed, fetch, then store the new body and version. Replacing a raw dump also deletes its parsed companion (`CACHE_NSC_PARSED_v7`, `CACHE_WITHHELD_PARSED_v4`, `CACHE_PENDING_MC_PARSED`).

Version strings are prefixed: `v:` API meta, `e:` ETag, `m:` Last-Modified, `f:` body fingerprint. `refresh(key)` clears the stored version and forces a download (use after an upload).

**Sync Data** (home header refresh) is a version check, not a wipe and not a blind re-download:

- Daily/auto (first visit of the day): `forceCheck` on every non-`lazySync` dataset, including NSC / stock / withheld. Download only if the version or body fingerprint changed.
- Manual Sync: version-check `lazySync` dumps (meter, defective, PMSGY, safety) without downloading the body unless a `versionUrl` says it changed. Overlay shows remaining checks, then **Checked N · Updated M**.
- Opening a report page still skips a same-day Google GET when there is no ETag (`!forceCheck`). Non-lazy sheets on Sync still fingerprint; lazy dumps wait for the page.
- Do not skip a dataset because `syncStatus === 'done'` when `forceCheck` is set.

| Flag | Meaning |
|------|---------|
| `originHeavy` | Prefer Google `csvUrl` from `/api/.../meta` (NSC, Withheld, Stock). Included in Sync for version checks. Dump bodies are never downloaded through Vercel. |
| `lazySync` | Skip daily homepage sync. Manual Sync cheap-checks only (no multi-MB GET). Version-check on page open. |
| `versionUrl` / `versionField` | JSON meta for version (Withheld uses `withheldVersion`) |

Do **not** `fetch()` or `Papa.parse(url, { download: true })` a Google Sheet from a page if a DataHub key exists. Register the URL in `DATASETS`, then `waitForDataset` + `get`. On the home hub, set `data-dataset="CACHE_…"`.

Hub keys in use: `CACHE_NSC_v5`, `CACHE_WITHHELD_v4`, `CACHE_STOCK`, `CACHE_POWER_MAP`, `CACHE_SOLAR`, `CACHE_JJM`, `CACHE_WRIDD`, `CACHE_METER_*`, `CACHE_DEFECTIVE`, `CACHE_DEFECTIVE_DETAILS`, plus collection/loss/weekly/docket/REM/capex/etc. in `DATASETS`.

Bump the **cache key** (`CACHE_FOO_v2`) if the stored row shape changes. Large dumps stay out of git (see `.gitignore` / `.vercelignore`).

---

## Service worker

`CACHE_NAME` in `sw.js` is currently `mzo-reports-cache-v92`. **Increment it** whenever HTML/CSS/JS that users already cached must update. Also bump `version` + `message` in `version.json` (shown as “App updated”). `mzo_app_update.js` fetches that file network-first and reloads desktop and the installed PWA. Do not add an install-app modal. The app-update banner is separate from dump `REPORT_AS_ON`.

Add new/changed report URLs to `isNetworkFirstPath()` so the SW does not keep a stale copy (`/version.json`, `/mzo_app_update.js`). After activate, the SW posts `MZO_APP_UPDATED`. NSC still paints from IndexedDB first, then `waitForDataset`; if the dump version changed it **reloads** (do not only `console.log`).

---

## Deploy

There is no webpack/vite build. Local run is `npm run dev`. Production is Vercel: https://mzo-report-pwa.vercel.app

1. Leave one-off `scripts/analyze_*` / `scripts/patch_*` and dataset dumps untracked. Do not commit `.env` or `consumer/*.csv`.
2. Bump `CACHE_NAME` in `sw.js` and `version` + `message` in `version.json` when users must receive HTML/JS changes.
3. Commit product files, then `git push origin main`.
4. Production deploy from the repo root: `npx vercel --prod --yes --scope dipankar-das-projects-1592747b`. Confirm the changed page after deploy. `npx vercel --prod --yes` without `--scope` can return Not authorized.

---

## Adding a report page

1. Create `feature.html` (or `feature/index.html`). Register it on the home hub in `index.html` with `data-dataset="CACHE_…"` when it uses DataHub.
2. Include `mzo_data_hub.js` and `mzo_scope.js?v=N` (bump `N` when `mzo_scope.js` changes).
3. Add the source to `DATASETS` in `mzo_data_hub.js`. Load with `waitForDataset` then `get` — never a raw sheet `fetch` if a hub key exists.
4. After load: `raw = MzoScope.filterRows(raw)` then populate filters; if selects are locked, fill from scoped unique values / `getScope()`, then `lockFilters()`.
5. Add the path to `sw.js` `isNetworkFirstPath` and bump `CACHE_NAME`.
6. If the folder is new, add it to `vercel.json` `builds`.
7. **Mobile:** do not stick a stacked filter block. Keep a **single ~42–48px** sticky bar; put search/filters behind a toggle overlay (`meter_utilization.html` is the pattern). Date strips should stay one scrolling row, not a column of cards.
8. Verify on a **phone width** (and ~900px tablet). Login-gated pages cannot be checked with anonymous `curl` of the HTML.

---

## UI conventions

- Prefer existing page look (Outfit/Inter, cards, KPI grids). Do not introduce a new CSS framework on one page.
- Sticky chrome must stay thin on mobile; overlays must not grow the sticky box (`position: absolute` / `fixed`, not in-flow).
- Clicking a status KPI (e.g. Disconnection Tracker Fully Paid / Disconnected) must filter **charts and table only**. Other KPI totals stay on the broader filter set (office, class, search, breadcrumb) and must not shrink each other.
- `home-button.js` injects a floating Home control — do not duplicate a second home bar in the header.
- When a dashboard mixes **counts-only** KPIs and **named-row** KPIs, split them into two labeled bands (Count vs Names). Use one card style. Count-only rows must not open a names modal. Defective Meter is the reference.
- Home hub (`index.html`): **Often used** (`#favoritesCard`, class `always-open`) sits above New Service Connection and stays expanded on mobile. Each page tile has a star (`.fav-btn`); pins are stored per login in `localStorage` key `mzo_page_favorites_<Username>`. Do not collapse `always-open` groups in `initCollapsibleCards`.

---

## APIs (server.js)

Typical prefixes: `/api/login`, `/api/session-check`, `/api/logout`, `/api/admin/*`, `/api/nsc/*`, `/api/stock/*`, `/api/withheld/*`, `/api/power-map/*`, `/api/defective/meta`. Unauthenticated `/api` returns **401 JSON**, not a login HTML redirect.

Uploads (NSC, stock, defective meter) process the file **in the browser**, then `MzoSheetMirror.publishTab` posts urlencoded chunks to Apps Script (`ContentService` JSON). Bulk bytes do not go through Vercel. Defective Meter uses the same helper as NSC (`lib/sheet_mirror_client.js`). After Apps Script code changes, deploy a **new version** of the **existing** web app (keep the same `/exec` URL). Do not return HtmlService from `doPost` (that is the `ppConfig` web-page error).

---

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
- A new UI pattern that other pages should copy (or stop using)

Companion: `scripts/README_PORTAL_USERS.md` (Supabase `portal_users` columns and ALTER scripts). Do not let topic READMEs contradict this guide; link them from here instead of duplicating.
