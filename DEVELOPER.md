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

**Client profile:** `localStorage.mzo_user_profile` (PIN stripped). Scope fields: `role`, `zone_code`, `region_code`, `division_code`, `ccc_code`, plus module flags (`nsc-autho`, `si-autho`, …).

**`window.MzoScope`** (client-only; do not slice large CSVs on Vercel):

- Admin or empty jurisdiction → **unscoped** (all offices).
- Grain: **CCC > division > region**.
- `filterRows(rows)` after parse; `lockFilters()` after filling Region/Division/CCC `<select>`s.
- Banner: “Showing {label} — set by admin”.
- **Do not** add per-page “Office Prefs”. Scope comes from login only.

Canonical names in `mzo_scope.js` `HIERARCHY`:

- Regions: **Malda**, **Raiganj**, **Balurghat**
- Divisions: Malda, Chanchal, Gazole, Raiganj, Islampur, Balurghat, Buniadpur

Office codes match `/66[123]\d{4}/` (e.g. `6611108`, `C36611108`). If a dataset’s office columns are missing from `REGION_KEYS` / `DIV_KEYS` / `CCC_KEYS` / `CODE_KEYS`, extend those lists — do not invent a second matcher.

**Locked dropdowns:** when a filter is locked, show the **office name only** (no leftover “All Regions / All Divisions / All CCCs”). Do not cascade-filter empty lists from a mismatched region value. WRIDD (`wridd.html`) is the reference for this.

---

## DataHub

Datasets are registered in `mzo_data_hub.js` `DATASETS`. IndexedDB holds the CSV/JSON body. `localStorage` key `mzo_hub_ver_<CACHE_KEY>` holds the version.

```js
await window.mzoDataHub.waitForDataset('CACHE_NSC_v5');
const csv = await window.mzoDataHub.get('CACHE_NSC_v5');
```

**Versioned load (required):** `get()` revalidates once per page load with a cheap check — `/api/.../meta` when `versionUrl` is set, otherwise `HEAD` plus `If-None-Match` / `If-Modified-Since`. If the stored version matches and IndexedDB already has a body, **do not download the CSV**. If the version changed, fetch, then store the new body and version.

Version strings are prefixed: `v:` API meta, `e:` ETag, `m:` Last-Modified, `f:` body fingerprint. `refresh(key)` clears the stored version and forces a download (use after an upload).

| Flag | Meaning |
|------|---------|
| `originHeavy` | Prefer `/api/...` dump; version from `versionUrl` (NSC, Withheld, Stock) |
| `lazySync` | Skip homepage daily sync; version-check when the page opens (meter dumps, safety, PMSGY) |
| `versionUrl` / `versionField` | JSON meta for version (Withheld uses `withheldVersion`) |

Do **not** `fetch()` or `Papa.parse(url, { download: true })` a Google Sheet from a page if a DataHub key exists. Register the URL in `DATASETS`, then `waitForDataset` + `get`. On the home hub, set `data-dataset="CACHE_…"`.

Hub keys in use: `CACHE_NSC_v5`, `CACHE_WITHHELD_v4`, `CACHE_STOCK`, `CACHE_POWER_MAP`, `CACHE_SOLAR`, `CACHE_JJM`, `CACHE_WRIDD`, `CACHE_METER_*`, plus collection/loss/weekly/docket/REM/capex/etc. in `DATASETS`.

Bump the **cache key** (`CACHE_FOO_v2`) if the stored row shape changes. Large dumps stay out of git (see `.gitignore` / `.vercelignore`).

---

## Service worker

`CACHE_NAME` in `sw.js` is currently `mzo-reports-cache-v47`. **Increment it** whenever HTML/CSS/JS that users already cached must update.

Add new/changed report URLs to `isNetworkFirstPath()` so the SW does not keep a stale copy. After deploy, users may still need a hard refresh until `skipWaiting` + `clients.claim` run.

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
- `home-button.js` injects a floating Home control — do not duplicate a second home bar in the header.

---

## APIs (server.js)

Typical prefixes: `/api/login`, `/api/session-check`, `/api/logout`, `/api/admin/*`, `/api/nsc/*`, `/api/stock/*`, `/api/withheld/*`, `/api/power-map/*`. Unauthenticated `/api` returns **401 JSON**, not a login HTML redirect.

Uploads (NSC, stock) are size-limited on Vercel; prefer chunked publish where it already exists.

---

## Keep this guide current

When a change affects how the next developer (or agent) should work, update **this file in the same PR/change**:

- New portal, dataset key, API, or auth field
- DataHub versioning / `waitForDataset` behaviour
- Scope matching / filter-lock behaviour
- SW cache or `vercel.json` paths
- A new UI pattern that other pages should copy (or stop using)

Do not let topic READMEs contradict this guide; link them from here instead of duplicating.
