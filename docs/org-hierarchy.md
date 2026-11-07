# WBSEDCL office hierarchy (Admin → Organisation)

The **Organisation** tab of the Administration window (`admin_users.html?tab=org`; command palette: *Organisation*) draws WBSEDCL's distribution offices as a chart: Director (Distribution) → chief engineers → zones → regions → divisions → CCCs. The app itself still covers only Malda Zone. The chart shows that zone as **Live in app**, and it is the first step towards scaling the app to all of WBSEDCL.

## Files

| File | What it is |
|---|---|
| `data/org/wbsedcl_hierarchy.json` | The dataset. It holds office names, codes, towns, districts and post titles from public WBSEDCL sources. It holds no personal data (no officer names, phones or e-mails). It is allow-listed in `.gitignore` and `scripts/tools/check_data_files.js`, and like the rest of `data/` it is never served as a static file. |
| `lib/org_hierarchy.js` | `GET /api/admin/org` (admin only: 401 without a session, 403 for a non-admin). It marks the live zone and checks the data's shape. |
| `admin_org.js`, `admin_org.css` | The chart, loaded when the tab first opens (`ensureOrg()` in `admin_users.html`). Plain JS, HTML cards and one SVG layer for the connectors, on the theme tokens, so light, dark and ppt all work. |
| `scripts/tools/build_org_hierarchy.js` | Rebuilds the dataset from a researched `hierarchy.json` (see **Updating the data**). |
| `vm/dev/test-org-api.js` | API and data checks (access, shape, live-zone matching). No network. |
| `vm/dev/org-ui-check.js` | Browser check against a local app (`scripts/qa/serve-local.sh <port>`): expand and collapse, expand a zone, search with path highlight, detail panel, phone list, light / dark / ppt, no console errors. |

## Data shape

```
{ asOf, schema, confidenceKey{confirmed, partial, inferred}, counts, officialCounts{zones, regions, divisions, cccs},
  sources: [{url, title, fetched}],
  root: { level: "director", name, confidence, source: [i…], note,
    children: [ { level: "chief_engineer", zoneConfidence, children: [ { level: "zone", …, children: [
      { level: "region", unplacedCccs: [ccc…], children: [ { level: "division", children: [ { level: "ccc" } ] } ] } ] } ] } ] } }
```

- Every node has `level`, `name`, and optionally `code`, `aliases`, `district`, `town`, `hq`, `head` (a post title such as "Divisional Manager"), `note`, and `source` (indexes into `sources[]`).
- `confidence` is one of three values:
  - `confirmed`: a current WBSEDCL source states the node.
  - `partial`: one source, or only the 2016 CCC list.
  - `inferred`: worked out from a name match or geography.
- The chief engineer level is optional: the root's children may be zones.
- `zoneConfidence: "inferred"` on a chief engineer means no source says which zones report to it. The chart draws those links dashed.
- `region.unplacedCccs[]` lists CCCs known to be in the region whose current division is not public. The chart puts them under a stand-in "Division not published" card. That card is not counted as a division.

The API returns the file with these additions:
- `live: true` on the zone that matches `lib/offices.js` `ZONE`, matched by code, name or alias.
- `inApp: {name, code}` on each office in that zone that the app's office master also has.
- `live: {zone, app, matched, missing}`: how many app offices matched, and which app offices the dataset lacks.
- `warnings`: shape problems found by `check()`.

## The chart

- **Wide screens:** a top-down tree.
  - Click a card to select it (detail panel) and open or close it. CCCs stack under their division.
  - Drag the background to pan. Use Ctrl/⌘ + wheel or the zoom buttons to zoom, and *Fit* for the whole tree.
  - *Expand zone* opens every office in the selected office's zone. *Collapse all* goes back to the zones.
  - Search by name, code or alias. Picking a result opens the path to it, highlights the cards and connectors on the path, and selects the office.
- **Phones (≤ 760 px):** an indented collapsible list.
  - Tap a row to open or close it. The ⓘ button opens the details below the list.
- **Detail panel:**
  - level, code, aliases, parent path (clickable), counts, post title, town / districts, confidence with its meaning
  - whether the app has the office
  - the node's sources (links)
  - its children
- **Footer:** a legend, and "Data as of … from public WBSEDCL sources" with every source link.

## Updating the data

The research notes live outside the repo (`agent-progress/wbsedcl-org/`: `hierarchy.json`, `README.md`, `malda-crosscheck.md`). To refresh the dataset, run:

```
node scripts/tools/build_org_hierarchy.js <path to hierarchy.json>
node vm/dev/test-org-api.js
```

The build makes three changes and copies everything else as it is:
- It uses the app's canonical region names (Uttar Dinajpur and Dakshin Dinajpur, with Raiganj and Balurghat kept as aliases).
- It fills Malda Zone codes and any missing Malda division or CCC from `lib/offices.js`. Filled nodes cite the office master as their source.
- It recomputes `counts`.

`test-org-api.js` fails if any app office is missing from the dataset.

## Scaling beyond Malda Zone

This tab only shows the structure. The app's scoping and data are still single-zone. The sections below cover where "zone" appears today and what would have to change.

### Where zone appears today

- **Office master: `lib/offices.js`.**
  - It defines one `ZONE` (Malda Zone, `6600000`), 3 `REGIONS`, 7 `DIVISIONS` and 41 `CCCS`.
  - Codes are `66 R D 1 CC`. The leading `66` is Malda Zone's prefix, and the regexes assume it: `66[0-3]\d{4}` in `parseCode` and `key()`, and `66[123]\d{4}` in `mzo_scope.js`.
  - `OUTSIDE` lists other zones' districts, so statewide sheets report those rows as "outside the zone".
- **Browser scope: `mzo_scope.js`.**
  - `HIERARCHY` and `CODE_TO_CCC` duplicate the 41 CCCs.
  - `buildScope()` reads the profile fields `zone_code`, `region_code`, `division_code` and `ccc_code`. A zone login (or an admin) is **unscoped** ("All offices"). That is only correct while the app holds one zone.
  - `filterRows()` drops rows outside the user's region, division or CCC. It never filters by zone.
- **UI kit: `mzo_ui.js`.**
  - `REGION_ALIAS` and the `661/662/663` region prefixes are hard-coded.
  - `UI.offices()` builds Region → Division → CCC filters. Its top level is the region, and it has no zone level.
- **Users: `lib/users_store.js` and `server.js`.**
  - `zone_code` is stored, but on the VM it is always written as `'MZO'`.
  - `LEVEL_TIER` maps zone → CE.
  - Scope levels are region, division and CCC.
- **Data:**
  - Every report dataset (Google Sheets, Supabase tables, the VM mirror's `ds_` collections) holds Malda Zone rows only.
  - The mirror's enrichment (`vm/sync/lib/office_enrich.js`, `dim_offices`) writes `_region`, `_division`, `_ccc_code` and `_ccc`, but no `_zone` field.
  - `lib/briefing_cccs.json` and the Briefing's precomputed figures cover the 41 CCCs.
- **Text:**
  - Ask's system prompt (`lib/assistant/prompt.js`) and `lib/assistant_catalog.js` describe "WBSEDCL Malda Zone" and its office tree.
  - The app name (MZO) and page titles say Malda Zone.

### What would need to change

1. **One statewide office master.**
   - Grow `lib/offices.js` from one `ZONE` to a `ZONES` list: zone → region → division → CCC, with codes and aliases, seeded from `data/org/wbsedcl_hierarchy.json`.
   - Office codes for other zones are not public. They come from SAP or the CRM, where each zone has its own two-digit prefix.
   - Every regex that hard-codes `66` must take the zone prefixes from the list.
   - `mzo_scope.js` `HIERARCHY` and `CODE_TO_CCC` should be generated from the master, not kept by hand.
2. **Zone as a scope level.**
   - `buildScope()` must treat a zone login as scoped to its zone, and only admins (or a new "state" level) as unscoped.
   - `filterRows()` needs a `_zone` resolution, from the code prefix or the region.
   - The user editor (`/editor/` permissions, `admin_users.html`) needs a zone picker in place of the fixed `'MZO'`.
3. **Zone in filters and drill-downs.**
   - `UI.offices()` and `UI.drill` gain a Zone level above Region, shown only when the user's scope spans more than one zone.
   - Counts and roll-ups (Briefing, rating, loss) need a zone total.
4. **Data per zone.**
   - Each dataset must say which zone a row belongs to: either a zone column, or separate sources per zone registered in `mzo_data_hub.js` `DATASETS` and the VM sync.
   - The mirror adds `_zone` to its enrichment and `dim_offices`.
   - Sheet-per-zone sources need the sync and the Sources tab to list one source per zone.
5. **Copy and assistant.**
   - Ask's prompt and catalog take the zone from the user's scope.
   - Page titles drop "Malda Zone" where they show other zones.

Until then, the chart's **Live in app** badge and the "In this app" line in the detail panel show which part of the structure the app already covers.
