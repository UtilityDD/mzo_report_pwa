# MZO data portal

A read-only admin console for the PocketBase data mirror on the VM: every mirrored dataset (Google Sheets, Supabase tables, Supabase Storage files, repo files) shown like a database, with its schema, source and sync history.

- **URL:** https://data.130.210.43.11.sslip.io
- **Stack:** static HTML, CSS and JavaScript. No build step, no framework, no CDN. It uses the app's Graphite UI kit (`/kit/mzo_theme.css`, `/kit/mzo_theme.js`, `/kit/mzo_ui.js`) and talks only to the PocketBase REST API on the same origin (`/api/...`).
- Nothing under `vm/` is served by Vercel or by `server.js`.

## Signing in

- Accounts live in the PocketBase auth collection `portal_users_auth` (email and password, no self sign-up). PocketBase superusers can sign in with the same form: the portal tries `portal_users_auth` first, then `_superusers`.
- Provisioning creates one portal account. Its credentials are on the VM in `/etc/mzo/portal-admin.txt` (root only). More accounts can be added from the PocketBase dashboard (`/_/`, superusers only).
- The token is kept in `sessionStorage`, so closing the tab signs out. The portal checks the token's expiry before every request and renews it when the page opens. When it has expired, the portal goes back to the sign-in screen and says why. **Sign out** is in the account menu at the bottom of the sidebar.

## What it shows

- **Sidebar:** every row of `sys_datasets`, grouped by source type or by report area (toggle), with row counts, a freshness dot and a search box (`/` focuses it). On screens narrower than 900px the sidebar becomes a drawer.
- **Freshness:** red for an error and amber for stale. Green means checked within its schedule: 45 minutes for `frequent`, 3 hours for `hourly`, 30 hours for `daily`. Grey means not mirrored or never synced.
- **Overview:**
  - totals, with Fresh, Stale and Errors filtering the dataset table;
  - datasets and rows by source type;
  - what needs attention;
  - the latest `sys_sync_runs`;
  - a table of all datasets with their source links.
- **Dataset page:**
  - **Data:** server-side paging. Sort by clicking a header. The filter builder offers per-type conditions on any column. Search covers the text columns, plus the number columns when the search text is a number. Columns can be shown and hidden. Cells are formatted by type; a number or yes/no field listed in the row's `_nulls` (empty in the source, stored as 0 / No) shows as empty and exports as an empty cell. A row drawer shows every field and the system fields. **Export CSV** downloads the current filter and sort, with the shown columns, fetching 1,000 rows per request.
  - **Schema:** each column's normalised name, source name and type, the primary key, and the system fields.
  - **Source:** source type, reference, a link to the source, schedule, last version, status and the last error.
  - **Sync history:** the runs for that dataset.

## Data quality

The checks in `vm/quality` run after every sync and write `sys_quality_scores` (one score, 0–100, per dataset) and `sys_quality_issues` (one row per dataset, check and column). See `docs/data-quality.md`. The portal shows them read-only:

- **Overview card:** average score, datasets per band (below 80, 80–94, 95 and above), open errors / warnings / notes, last checked, and a link to the page.
- **Data quality page** (`#/quality`):
  - **Tiles:** average score, datasets below 80, open errors, warnings and notes, last checked. The severity tiles and "Below 80" filter the lists.
  - **Filters:** one row above the lists, so the wide tables keep their width (on phones they open in a drawer from **Filters**). Search, status (open, or resolved in the last 7 days), severity, check family, report area, and "fix in the sheet only".
  - **By dataset:** score with a bar coloured by band (`--mzo-ok-mark`, `--mzo-warn-mark`, `--mzo-bad-mark`), counts, rows, the worst issue and when it was checked. Sorted by score, lowest first; a row opens the dataset's Quality tab.
  - **Owner action list** (`#/quality/actions`): open issues that need a fix in the source, grouped by source sheet. A Storage snapshot compared with its Google sheet is listed under that sheet. Each sheet has **Open sheet** and **Copy**; the whole list can be copied as plain text or exported as CSV.
  - **All issues** (`#/quality/issues`): dataset, severity, check, column, count, % of rows, first and last seen, status.
  - **Issue drawer:** the full hint, the examples (a table when they share a shape, a key/value list when they do not), and Open sheet / Open data.
- **Dataset page, Quality tab:** the score, the open issues and the last 20 resolved.

Check ids are shown by friendly name (`freshness.stale` is "Report out of date", `key.duplicate` is "Repeated key"); the test fails if vm/quality gains an id without one. Severity is sorted in the page (error, warning, note), because PocketBase sorts select fields alphabetically. Dates are IST, dd/mm/yyyy. The samples are masked by vm/quality and are still shown as text only. Before the first run, every quality view says "Results appear after the next sync".

## Security

- All data is treated as untrusted. It reaches the page only through `textContent` and attributes, never as markup. Links are opened only if they are `http(s)`. The code has no `innerHTML` and no inline scripts or handlers.
- `index.html` carries a strict Content Security Policy (`script-src 'self'`, `connect-src 'self'`). Inline styles are allowed only because the UI kit injects its icon sprite with a `style` attribute.
- No records are stored in the browser:
  - the token is in `sessionStorage`;
  - API requests use `cache: 'no-store'`;
  - `localStorage` holds only the theme and the sidebar grouping;
  - column choices are in `sessionStorage`.
- PocketBase rules do the real access control. Every `ds_*` and `sys_*` collection is readable only by `portal_users_auth` accounts and superusers.

## Serving it on the VM (Caddy)

The site block for `data.130.210.43.11.sslip.io` must:

1. Reverse-proxy `/api/*` and `/_/*` to PocketBase on `127.0.0.1:8090`, with `Cache-Control: no-store` on `/api/*` responses.
2. Serve `/kit/mzo_theme.css`, `/kit/mzo_theme.js` and `/kit/mzo_ui.js` from the app checkout's root (`/opt/mzo/app/`). Every other `/kit/*` path returns 404.
3. Return 404 for `/dev/*` and `*.md`.
4. Serve everything else from `/opt/mzo/app/vm/portal/`.
5. Send these headers on the portal's static files only (not on `/_/`, which has its own scripts):

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
Cache-Control: no-cache
```

`dev/serve.js` does the same locally and is the reference.

## Local development

You need Node 22 or later. From the repo root:

1. Download the PocketBase darwin build, the version in `vm/pocketbase/VERSION`, into `vm/portal/dev/pb/`. That folder is git-ignored.
2. Run `vm/portal/dev/pb/pocketbase serve --dir vm/portal/dev/pb/data --http 127.0.0.1:8093`.
3. Run `node vm/portal/dev/seed.js`. It creates the contract collections and a test account, and fills about 15 fake datasets, including two with 50,000 rows, an erroring one, a stale one and one that is not mirrored, plus their sync runs and data quality results (scores from vm/quality's own formula, open and resolved issues, a Storage snapshot compared with its sheet). The test logins are written to `vm/portal/dev/pb/dev-credentials.json`, which is git-ignored.
4. Run `node vm/portal/dev/serve.js` and open http://127.0.0.1:3300. It serves `vm/portal`, maps `/kit/*` to the repo-root kit files, and proxies `/api/*` and `/_/*` to `:8093`.
5. Run `node vm/portal/dev/test.js [screenshots-dir]` for the browser test. It needs `playwright-core` (from `node_modules` or `NODE_PATH`) and Google Chrome. It covers:
   - sign-in, the overview and a 50,000-row dataset (sort, filters, paging, drawer, export);
   - the Schema and Source tabs and token expiry;
   - markup probes, which must render as text (also in quality samples and hints);
   - the Data quality card, page, filters, owner action list (copy and CSV), issue drawer and dataset Quality tab, checked against the API, plus the empty state;
   - light and dark themes at desktop width and at 390px.

   Only GET requests and the two local sign-in POSTs are allowed. The run fails on any other request and on any console error.

`seed.js` refuses to seed anything but a local PocketBase.
