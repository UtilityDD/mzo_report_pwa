# Data editor

A spreadsheet-style editor for the datasets in the VM's PocketBase, at **https://130.210.43.11.sslip.io/editor/**. Users see the datasets an admin shared with them, and edit, add, delete or paste rows (from Google Sheets or Excel) as their rights allow. Saved changes reach the report pages at once.

It runs only on the VM (it needs the PocketBase superuser login the app already has there). On Vercel and on a plain local checkout every `/api/editor/*` route answers 503.

## For users

### Signing in and finding a dataset

Open `/editor/` with the same login as the reports (no separate sign-in). The home page lists the datasets you may see, grouped like the app's menu, with their row counts, when they last changed and what you may do. **Editable only** hides the ones you can only read.

Each dataset is one of two kinds:

| Badge | Meaning |
|---|---|
| **Copy · read-only** | The original is a Google Sheet or Supabase table; the sync copies it every 5 minutes, hourly or daily. Change it in the original (**Open original**); a change made here would be overwritten by the next sync, so the editor does not allow one. |
| **Edited here** | The VM is the source of this dataset. The sync no longer copies it; changes are made in this editor. |

An admin decides which datasets are edited here ([below](#for-admins)).

### Editing

The sheet loads rows as you scroll, so even the largest datasets (290,000 rows) open at once. Column headers show each column's name and type (`text`, `number`, `date`, `bool`).

| Do | How |
|---|---|
| Select | click a cell; drag or Shift+click for a range; Shift+arrows; Ctrl/Cmd+A for everything |
| Move | arrows, Tab / Shift+Tab, Enter / Shift+Enter, Page Up / Down, Ctrl/Cmd+arrows to the edges |
| Edit a cell | type, or double-click, Enter or F2. Enter saves the cell and moves down, Tab moves right, Esc cancels, Alt+Enter is a line break inside the cell |
| Clear cells | Delete or Backspace |
| Copy | Ctrl/Cmd+C copies the selection as cells you can paste into a sheet |
| Paste | Ctrl/Cmd+V (or **Paste**) |
| Add rows | **Add row**, or paste past the last row |
| Delete rows | select cells in the rows, **Delete rows** (they show struck through until saved) |
| Undo on the page | Ctrl/Cmd+Z, or **Undo** in the bar |
| Search, filter, sort | the search box (text columns, and numbers when you type a number), **Filter** (per type: contains, is, >, before…), click a header to sort |
| Download | **Export CSV**: the rows that match the search and filters |

On a phone the sheet scrolls with a finger; tap a cell to select it and tap it again to edit it in a box at the bottom.

**Changes stay on your page until you save them.** Changed cells are highlighted, new rows are marked *new*, and the bar under the sheet counts them. **Review and save** (or Ctrl/Cmd+S) opens the review.

### Pasting from Google Sheets or Excel

Copy cells in the sheet, click the cell where the top-left one should go, and paste.

- The block fills cells to the right and down from there. Rows past the end become new rows. Values past the last column are left out (the message says how many).
- One copied value pasted onto a selected range fills the whole range.
- If the first pasted row names the columns (pasted at the first column, or into an empty dataset), it is taken as the header and the columns are matched **by name**, whatever their order; columns the dataset does not have are listed and left out.
- Cells with line breaks, tabs and quotes come through intact. When the clipboard has no plain text, the HTML copy is read instead.
- The review opens by itself after a paste.

**Import file** reads a CSV or TSV file (up to 4 MB, first row the column names) the same way into new rows.

### The review

Before anything is saved the server checks every change and shows:

- the counts of rows added, changed and deleted;
- each change: the old value struck out and the new one, or the values of an added or deleted row;
- **values that do not fit their column**: a number column only takes numbers (Indian or Western commas are fine), a date column dates (dd/mm/yyyy, or the column's own order), a yes/no column Y/N, Yes/No or true/false. Placeholders such as `NA`, `-` or `(null)` count as empty. Save stays blocked until you fix them on the page, or tick **Hold these rows back and save the rest**;
- a **repeated key**: in a dataset with a unique column (such as an application number) two rows cannot share a value;
- **rows someone else changed** since you loaded them. For each, **Keep mine** (your version replaces theirs) or **Use theirs** (your change to that row is dropped).

**Save to the VM** applies everything as one batch: either every change is saved or none is. If the connection drops while saving, **Save again** is safe: a save that already went through is not applied twice.

### History and undo

**History** lists every save to the dataset: when (IST), who, what and how many rows. **Details** shows each row's old and new values. **Undo** reverts a whole save, as long as none of its rows changed since (otherwise it says which rows block it). You can undo your own saves; an admin can undo anyone's. Right after a save the bar offers **Undo this save** too.

## For admins

### Who may do what

**Permissions** (top bar, or `/editor/#/permissions?email=<email>`, the link the user admin uses) shows one user's rights per dataset:

| Right | Allows |
|---|---|
| View | seeing the dataset and its rows |
| Add | new rows (pasting past the end, import) |
| Edit | changing cells of existing rows |
| Delete | deleting rows |
| Own office only | only rows whose office (region, division or CCC, worked out from the row's office columns) is inside the office of the user's login. A user whose login covers the whole zone sees everything. In a dataset with no office columns, such a user cannot write at all |

The row **Every dataset (default)** applies to every dataset that has no row of its own. **Tick view on shown** / **Tick edit on shown** / **Clear shown** work on the datasets the search shows, so one user can be given many datasets at once. Admins can do everything everywhere and need no rows. Datasets holding PINs, bank or identity numbers (manpower, portal users, DD lists, activity logs, Power Map accounts) stay admin-only whatever is ticked. Users are listed from the VM user list when it is installed; otherwise type an email.

Write rights only matter in datasets edited here; in copies everyone with View can read.

### Making a dataset editable here

On a copy, **Edit on the VM instead…** first checks that the reports would read the dataset exactly as before (see [Format parity](#format-parity)) and says why when they would not. Then, after you type the dataset key:

1. The VM takes one last fresh copy from the original.
2. From then on the sync skips the dataset, and it is edited here.
3. The switch is logged in its history.

Tell the people who maintain the original sheet to stop editing it: their changes no longer reach the reports.

**Return to the original…** does the opposite. **Every change made on the VM is then replaced by the original** within minutes (the sync starts at once). Export what you need first. The edit history stays.

These datasets cannot be edited here: sensitive ones (no snapshot), Supabase tables and the Power Map (JSON snapshots; Supabase is their source), report-style sheets without a header row (Puja, the Important sheets: pages read their cells by position), and datasets over 100,000 rows or 40 MB.

### A new dataset

**New dataset** creates a dataset that exists only on the VM: a key (permanent), a name, a menu group, and the columns, typed one per line or pasted with rows from a sheet (first row the names). Types are guessed from the pasted values and can be changed; one column can be marked as the unique key. Pasted rows are added through the normal review. The dataset gets a CSV snapshot like any other (`/api/data/file/<key>`), ready for a report page to read. Columns cannot be added or renamed later yet.

## Architecture

| Where | What |
|---|---|
| `editor/` | The site: `index.html`, `editor.css`, `clipboard.js` (paste parsing, also used by the tests), `js/app.js` (helpers, API client, dialogs, router), `js/grid.js` (sheet and review), `js/pages.js` (home, dataset page, history, mode switch, new dataset, permissions). Plain JS on the UI kit; every value is set with `textContent` |
| `lib/editor/index.js` | `/api/editor/*` routes, the request gate (session, CSRF, rate limits), post-save hooks. Mounted by two lines in `server.js` |
| `lib/editor/native.js` | Native mode: eligibility and parity, take-over, return, new datasets, snapshot regeneration |
| `lib/editor/commit.js` | Batches: plan and checks, all-or-nothing apply, rollback and recovery, idempotency, undo |
| `lib/editor/records.js` | Cells → records exactly as the sync builds them |
| `lib/editor/format.js` | Snapshot bytes ↔ cells (detect, parse, serialise) |
| `lib/editor/perms.js`, `query.js`, `env.js` | Rights and office scope; grid queries and cell display; PocketBase client, folders and source definitions |
| `vm/sync/lib/lock.js` | The sync lock and the manifest lock, shared by the sync and the editor |
| `vm/pocketbase/pb_migrations/17941000*` | `sys_datasets.mode`, `native_since`, `native_by`, `native_format`; `app_dataset_permissions`; `app_edit_batches`, `app_edit_log` |
| `vm/dev/test-editor.js`, `vm/dev/editor-ui-check.js` | Tests (local PocketBase) and the browser check |

### Source of truth: `sys_datasets.mode`

`''` or `mirror` (default): the original is the source; the sync copies it. `native`: the VM is the source; `vm/sync/run.js` skips the dataset in `--due`, `--all` and `--only` (it never reads the original, nor touches the rows, the snapshot or the registry row), logs `native … skipped` for targeted runs and counts the skips in its summary line. The app's write-through refreshes (`refreshMirror`) of a native key are therefore no-ops.

### Rows

Native rows are ordinary `ds_<key>` records. The editor writes them through `lib/editor/records.js`, which uses the sync's own pieces (`Converter` from `infer.js` and so `lib/uniform.js`, `office_enrich`, `rowKeyFn`, `recordId`, the same `_hash` recipe): typed fields, `_raw` companions, `_region` / `_division` / `_ccc_code` / `_ccc`, `_nulls`, `_hash`, `_row_key` and the record id derived from it are exactly what the sync would write for the same cells. So the portal, the quality checks and a later return to mirror mode agree with every edited row (the tests rebuild every record from the snapshot and compare). One consequence: a dataset keyed by row content (most sheets have no unique column) gives an edited row a new key and id, as the sync does; the editor replaces the record in the same transaction.

Native records also have `_src`: the row's exact source cells (untrimmed, in source column order). The grid shows and edits `_src`; the typed fields serve filters, sort, search and the portal. New rows append at the end (`_row_no` = max + 1); `_row_no` keeps the source order.

Column names, types and the source column of each field are frozen at take-over in `sys_datasets.native_format` (`buildColumns` output plus the snapshot format and header cells). Values are validated against those types; types are never re-inferred while native.

### Saving a batch

`POST /api/editor/datasets/:key/commit` with `{ idempotencyKey, ops: [{op: 'create', cells} | {op: 'update', id, hash, cells} | {op: 'delete', id, hash}], skipInvalid, kind }`, `cells` keyed by field name (only the changed ones for an update). The server, one batch per dataset at a time:

1. Answers a known idempotency key from the stored batch (`replayed: true`).
2. Reverts any batch of this dataset left half-applied by a crash.
3. Plans: loads the current records, refuses rights and office-scope violations (403), stale `hash`es (409, with the current cells), cells that do not fit their type and repeated keys (422, or held back with `skipInvalid`); rows that would not change are dropped.
4. Applies through PocketBase's batch API. Each row change goes with its `app_edit_log` row (op, before, after, who, when, client IP and browser), and the `app_edit_batches` row (id from the idempotency key) goes in the first part. PocketBase allows 1,000 requests per batch (settings migration), so a batch of more than a few hundred rows is sent in parts of 900 requests: the batch row is `applying` until the last part marks it `committed`. If a part fails, the parts already applied are reverted from their audit rows (`rolled_back`); if the server dies meanwhile, the next start (or the next save to that dataset) reverts it. Readers may briefly see the parts of a big batch in PocketBase; the report pages never do, because the snapshot is written only after the last part. If PocketBase applied a part but its answer was lost, the server checks the part's last audit row instead of guessing.
5. Rewrites the snapshot (below), updates `row_count`, `last_synced_at` and the snapshot fields, and starts the post-save hooks. If the snapshot cannot be written, the save stands and the snapshot is retried every minute.

Limits: 5,000 rows per save, 50,000 characters per cell, 4 MB import files, 5 MB request bodies (the app's JSON limit), 40 writes and 900 reads a minute per user, 6 mode switches or new datasets an hour.

Undo (`POST …/batches/:id/undo`) checks that every row of the batch is still as it left it (by `_hash`, and that deleted rows were not added again), then applies the inverse as a new batch of kind `undo` and marks the original `undone`, in the same transaction.

### Snapshots and the reports

After every save the editor writes `<key>.<csv|tsv>` from `_src` in `_row_no` order (header first) in the source's own format: delimiter, quoting (Google pub/export CSV quotes only cells with `,` `"` or line breaks; gviz quotes every cell; TSV never quotes), line ending, final line ending and BOM. It uses the sync's `SnapshotWriter` (temp file, `.gz` and `.br`, renames), then updates the dataset's `manifest.json` entry (version = sha1, bytes, `snapshotAt`, rows) inside the manifest lock. Pages pick the new version up from the manifest like any sync change. Then, 5 s later and coalesced: `vm/sync/rows.js --only <keys>` (uniform rows) and `vm/sync/rating.js --min-minutes 5` (performance index), each in its own capped child process, and the Briefing cache refresh for the datasets it reads.

The sync's `writeManifest` (end of every run) keeps the entry the editor last wrote for a native dataset, since its registry rows may be older than the editor's latest save, and lists editor-made datasets, which have no source file.

### Format parity

A dataset may go native only if its snapshot passes, on the current bytes:

- **Bytes:** `serialize(parse(snapshot)) === snapshot` (`lib/editor/format.js`).
- **Parsing:** the cells parse to the same rows as the source's own `rows()` (via the sync's `spool`), and give the same columns as `sys_datasets.columns`.
- **Records:** the records built from those cells have the same ids, `_hash` and `_row_no` as the ones the sync wrote, row for row.

On the VM's 77 CSV/TSV snapshots (copied 2026-11-06), the byte round trip is exact for all 77. The one documented difference: rows whose every cell is empty are dropped at take-over. The sync never stores them and `lib/uniform.js` (the uniform rows) skips them; a page that parses the CSV itself with `UI.csv` gets one empty row object fewer per such row, which matters only if it counts rows without looking at them. `icds_a_plus` has 369 such rows, `important_rem_stw_osd` 2, and five Important unbilled months 1 each. The take-over writes the snapshot from the rows straight away and the tests check the bytes (for the fixtures: identical).

### API

| Route | Who | |
|---|---|---|
| `GET /api/editor/me` | signed in | user, admin flag, office |
| `GET /api/editor/datasets` | signed in | datasets the user may view, with rights |
| `GET /api/editor/datasets/:key` | view | columns, mode, rights |
| `GET …/rows?offset&limit&sort&q&filters` | view | one page of rows (`filters`: JSON `[{field, op, value}]`, built into a PocketBase filter on the server) |
| `GET …/export.csv?…` | view | CSV of the filtered rows |
| `POST …/preview`, `POST …/commit` | add / edit / delete | the review; the save |
| `GET …/history`, `GET …/batches/:id` | view | saves; one save's rows |
| `POST …/batches/:id/undo` | the author or an admin | undo a save |
| `GET …/native-check`, `POST …/mode` `{mode, confirm}` | admin | parity check; take over / return |
| `POST /api/editor/datasets` | admin | new dataset |
| `GET/POST /api/editor/permissions`, `POST …/permissions/revoke`, `GET /api/editor/users` | admin | rights |

### Security

- **Rights are enforced on the server** for every request; the page only hides what the server refuses. A user is identified by the lowercase email of the session profile; a VM-only admin without an email by `local:<username>`. Admin: `isAdmin === true` or `role === 'admin'`.
- **CSRF:** writes need `Content-Type: application/json` and `X-MZO-Editor: 1`, which a page on another site cannot send without a CORS preflight that this server never grants, and an `Origin` (when sent) of this host. The session cookie is also `SameSite=Lax`, so other sites' POSTs carry no session.
- Filters are built on the server from structured conditions on known columns; values are escaped. Nothing from the browser reaches PocketBase as filter text.
- Every cell is shown with `textContent`; the HTML clipboard is parsed to text.
- The three editor collections have no API rules (`null`): only the app (a PocketBase superuser on 127.0.0.1) reads or writes them. `lib/editor/*.js` is not served as static files.
- The editor never writes to Google Sheets, Supabase or Apps Script. The only outside request it causes is the GET-only final copy at take-over (the sync's own source code).

## Deploying

Everything comes with a normal `develop` deploy:

- PocketBase applies the three new migrations at its next restart (deploy.sh restarts it when `pb_migrations` changes).
- The app already has `PB_URL` and the superuser login (`EnvironmentFile=/etc/mzo/pocketbase.env`) and `SYNC_TMP_DIR`, so the editor turns on by itself. No Caddy change: `/editor/` is a path of the app's own site.
- No `sw.js` or `version.json` change is needed for the editor itself (it is not a page of the app shell). Add a link to `/editor/` from the app (admin menu) when it should be offered.

Then: give users rights on the Permissions page, and switch the first datasets to native.

## Testing

```bash
# a local PocketBase with the repo's migrations (docs/data-mirror.md, "Running a sync by hand")
node vm/dev/test-editor.js --env <file with PB_URL, PB_SUPERUSER_EMAIL, PB_SUPERUSER_PASSWORD>
# browser check: a local app in mirror mode on that PocketBase, with one native dataset
QA_LOG_DIR=<dir> scripts/qa/serve-local.sh 3633 <snapshot dir>     # PB_URL etc. in the environment
node vm/dev/editor-ui-check.js http://localhost:3633 <native key> <screenshot dir>
```

`test-editor.js` uses fixture sources (no network), the sync's own code to load them, and an in-process app with fault injection; it removes everything it created. See the header of each file for what is covered.

## Known gaps

- Columns cannot be added, renamed or retyped while a dataset is native (the source sheet's columns are frozen at take-over). Return it to the original, change the sheet, and take it over again; or for a dataset made here, create a new one.
- Rows are appended at the end; there is no "insert row here" and no row reordering.
- Saves of more than a few hundred rows go in parts (see above): all or nothing for the reports, but PocketBase readers (the portal) can see a big save half-way for a few seconds.
- Undo works per save; a save whose rows were changed later cannot be undone as a whole.
- The editor has no live updates: someone else's save shows after a reload or a conflict.
- One app process: the per-dataset save queue is in memory (the VM runs one).
