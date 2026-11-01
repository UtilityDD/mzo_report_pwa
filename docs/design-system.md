# Design system and pages

The Graphite look, the UI kit (`mzo_theme.css` + `mzo_ui.js`), the workstation shell, and how to build or change a report page.

## Design system (Graphite)

One look across the workstation and every report: neutral greys, one **fill** colour for primary actions and selected pills, one teal **accent** for focus, links and the active marker, the operating-system font (no web fonts), hairline borders, almost no shadows. Light and dark are equal citizens.

- **Tokens** live in `mzo_theme.css` (`--mzo-canvas`, `--mzo-bg`, `--mzo-surface`, `--mzo-surface-2`, `--mzo-border(-strong)`, `--mzo-text`, `--mzo-text-2`, `--mzo-muted`, `--mzo-faint`, `--mzo-fill` / `--mzo-on-fill`, `--mzo-accent`, `--mzo-ok|warn|bad|info(-soft)`, `--mzo-chart(-soft)`). `app.html` inlines the same values; keep the two blocks in sync.
- **Theme:** `mzo_theme.js` paints `html[data-mzo-theme="light|dark"]` before first paint from `localStorage` (`theme`, `mzo_theme`, `collectionDashboardTheme`). The shell also stores `mzo_theme_pref` (`light` / `dark` / `system`) and writes the resolved value to those keys, so pages only ever see `light` or `dark`. Inside the shell, `mzo_theme.js` adds `html.mzo-in-shell` (page theme toggles and the floating home button are hidden).
- **Fonts:** `mzo_theme.css` aliases Inter / Outfit / Roboto / Poppins to local system faces (`@font-face … local()`), so Chart.js canvases and older CSS that name those families render in the system UI font without downloading anything. Do not add Google Fonts links.
- **No:** emojis in UI text, gradients, glows, glass blur, coloured left-accent cards, icon tiles, explanatory paragraphs, Font Awesome / Bootstrap / Chart.js on new pages.

**UI kit (rebuilt pages).** A page opts in with `<html class="ui">` and loads `/mzo_theme.js`, `/mzo_theme.css`, `/mzo_ui.js` (+ `mzo_data_hub.js`, `mzo_scope.js` when it reads data). Structure every report the same way:

1. `.ui-page` → `.ui-head`: `h1` title with the data date as a badge inside it (`<span class="ui-badge ui-date" id="asOn">`), no subtitle; a few `.ui-btn` actions on the right, plus a `.ui-side-toggle` **Filters** button (shown only below 980px).
2. `.ui-layout` → `aside.ui-side#side` (left filter panel) + `.ui-main`. The panel holds, with no field labels: `.ui-side-h` (Filters, “n on”, ghost **Clear**), a `.ui-side-stack` with search, then one `.ui-side-sec` per facet. Offices are not in the panel; they are walked in the detailed report (item 4). Facets are `UI.facet(el, [{value, label, count}], current, onChange)`: radio rows with counts, click again to clear, no “All” row. Count each facet on every other filter but itself (`base(skip)`). Related facets share one section as tabs: `.ui-seg.ui-side-tabs[data-tabs]` with `data-pane="<facet id>"` buttons; a tab whose facet is set shows a dot. `UI.sidePanel({ side, toggle, label, count, clear, onClear })` wires toggle, tabs and Clear and returns `setActive(nOn, { paneId: isSet })`.
3. Inside `.ui-main`: `.ui-stats` (one strip, 3–7 `.ui-stat` buttons; columns fit automatically). A stat toggles a filter on the lists below; the stats themselves count the panel filters only.
4. **Detailed report**: one `.ui-panel` with one table that walks Region → Division → CCC (→ any extra level, e.g. Agency) → the rows themselves. `UI.drill({ el, root: 'Malda Zone', levels?, lists?, onChange })` draws the level tabs and the office trail (“Malda Zone / Raiganj / Islampur”) into `el`; the trail *is* the office filter. Pages filter with `dr.match(row)` (rows carry `_region` / `_divn` / `_supp`), group the current level with `dr.key(row)` / `dr.parent(row)`, open a row with `dr.open(name, row)`, render `APP_COLS` when `dr.isList()`, and call `dr.paint({ list: n })`. A tab lists that level inside the path above it; a crumb goes back up. The login scope pins the levels it covers (shown in the trail, not clickable) and the report starts one level below. Deep links `?region= ?division= ?ccc=` go through `dr.fromParams(params, rows)`. Reset table state (`el.__ui = null`) when the level changes. Export CSV exports the rows under the current path and filters.
5. Anything else (e.g. Recent activity on the disconnection tracker) goes below the report. Distributions that used to be `UI.hist` panels belong in the side panel as facets.

Helpers worth knowing (all on `window.UI`, documented at the top of `mzo_ui.js`): `UI.load(key, render)` paints from IndexedDB at once and re-renders when DataHub has a newer body; `UI.refresh(btn, key, onText)` wires a refresh button (forced version check, spinner always cleared); `UI.office(code, name)` maps a CCC code/name to canonical `{ region, division, ccc }` via `MzoScope`; `UI.offices(rows, label)` and `UI.uniq(rows, key)` fill the region → division → CCC selects on pages that still have them; `UI.drawer(title, sub, pairs, extraHtml, actionsHtml)` opens the row detail drawer; `UI.exportCsv`, `UI.copy`, `UI.toast` do what they say. When a kit page is opened outside the shell, `mzo_ui.js` loads `/auth.js` (login gate); inside the shell the shell checks the session. Reference pages: `pending_load_extension.html` (the side panel and detailed report pattern), `solar.html`, `pending_mc.html` (extra Agency level), `nsc_classic.html` (side panel + analysis tabs), `loss.html` (trend + comparison), `disconnection.html` (follow-ups in the drawer and a Follow-ups list).

**Legacy pages** (not yet rebuilt) still load `mzo_theme.css` last. Its overlay (scoped to `html:not(.ui)`) re-points the variables those pages already use (`--primary`, `--card-bg`, `--text-muted`, Bootstrap `--bs-*` for the field tools that load Bootstrap) and normalises headers, cards, buttons, tabs, forms, tables, badges and modals. Page CSS colours were mapped onto tokens with the original colour kept as the `var()` fallback.

## Workstation shell (`app.html`)

The only home: login opens it, and `/` and the old phone hub URL `/index.html` redirect to it. It is the same app on desktop and phone.

- One registry (`NAV` in `app.html`) drives the sidebar, ⌘K / Ctrl K / `/` search, and `#hash` routes (`#nsc`, `#loss`, … — keys kept from the old shell). Administration shows only for `role: admin`; **Sheet links** only with `sheets-autho` list/edit/y/all.
- Pages open in iframes that stay alive (5 on desktop, 2 on phones / low-memory devices), so switching back is instant. Hovering a link prefetches its HTML. A thin top progress bar shows while a page loads; the page paints underneath.
- Pages can call `parent.openPage(url, title)` to jump to another report (the briefing does). If a page navigates itself to another report the shell follows it; if it lands on `/login.html` the shell signs out to the login page; a Home link (`/app.html`, or the old `/index.html`) goes to **Briefing** instead of loading the shell inside itself.
- Sidebar collapses to a rail (⌘B / Ctrl B, remembered in `mzo_ws_rail`); on phones it is a drawer. Account menu: theme (Light / Dark / System), sign out (`POST /api/logout`). Recent reports: `mzo_ws_recent`.
- The service worker does not inject `mzo_present.js` into `app.html`; each report keeps its own zoom control.

## Adding a report page

1. Build it on the UI kit (see **Design system**): `<html class="ui">`, kit structure, `UI.*` helpers. Register it in the shell `NAV` in `app.html`; that is the only place a page is listed.
2. Include `/mzo_data_hub.js` and `/mzo_scope.js` with the same `?v=` the other pages use (bump it everywhere when the file changes).
3. Add the **Google** (or other origin) URL to `DATASETS` in `mzo_data_hub.js`. Load with `UI.load` (or `waitForDataset` then `_peek`) — never a raw sheet `fetch` if a DataHub key exists, and never an `/api/.../dataset` body proxy.
4. After load: `rows = MzoScope.filterRows(rows)`. Office navigation is the detailed report's trail (`UI.drill`), which pins the login scope itself; pages that still have office selects fill them with `UI.offices` and pin them with `UI.lockScope()`.
5. Add the path to `sw.js` `isNetworkFirstPath` and bump `CACHE_NAME`.
6. If the folder is new, add it to `vercel.json` `builds`.
7. **Mobile:** below 980px the side panel stacks above the content and opens from the **Filters** button; stats drop to two columns at phone width. Keep the header to one title line.
8. Verify light, dark, inside `app.html`, and at phone width (~390px). Login-gated pages cannot be checked with anonymous `curl` of the HTML.

## UI conventions

- New and rebuilt pages use the UI kit (see **Design system**). Do not introduce a new CSS framework on one page.
- Sticky chrome stays thin on phones; overlays must not grow the sticky box (`position: absolute` / `fixed`, not in-flow). Kit pages use the kit header, the left filter panel (opened from **Filters** below 980px) and one stat strip.
- A stat card filters the detailed report below it, never the other stat cards: every card counts within the panel filters and the office path. Status cards show the count with its share on one line (`5,182 · 26%`) and an amount on the next where one exists (Disconnection Tracker is the reference). Follow-up notes (Disconnection Tracker, Pending NSC) live in the row drawer and in a **Follow-ups** tab of the detailed report: one row per consumer or application, opening the notes newest first with author and date. Only an admin (`mzo_user_profile.role` is `admin`) sees the delete control.
- **Presentation zoom** (`mzo_present.js`): desktop only (width ≥ 900px), fixed bottom-right. Steps are 100 / 125 / 150 / 175, stored in `localStorage` key `mzo_present_zoom`. `+` / `-` step the size and `0` resets, when focus is not in a field. Do not add a second zoom control on report pages. Zoom stays inside the page’s existing scroller so the window does not gain a second vertical scrollbar. Power Map and the accident map keep their own pan/zoom. Phones stay at 100% and the control stays hidden.
- When a dashboard mixes **counts-only** KPIs and **named-row** KPIs, split them into two labeled bands (Count vs Names). Use one card style. Count-only rows must not open a names modal. Defective Meter is the reference.
- **Durga Puja (`puja.html`)**: sidebar **Important → Durga Puja 2026**. A compact selector for *Format-I*, *Format-II* and *Hourly Load* (2025 / 2026) that opens the chosen sheet in an embedded viewer; *Format-I 2026* opens first.
