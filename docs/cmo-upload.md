# CMO grievance upload (VM only)

The CMO grievances report (`cmo.html`, dataset `cmo_grievances`) used to be copied every 5 minutes from a published Google Sheet that a clerk kept up to date by pasting the CMO portal's export and five formula columns. Since 8 Nov 2026 the export is uploaded on the VM instead: an admin (or a user granted `cmo-upload-autho`) opens the report, clicks **Upload**, picks the portal file, checks the preview and confirms. The VM is the only source; nothing is written to Google.

| Where | What |
|---|---|
| `lib/cmo_upload.js` | Pure parser and checks: reads the .xlsx (`lib/xlsx_lite.js`) or .csv, finds the header, derives the 5 formula columns, blocks and warnings, the comparison with the list now served, the snapshot CSV. Runs in a worker thread with a heap cap and a time limit |
| `lib/cmo_routes.js` | The endpoints, the one-time preview tokens, the lock, the stored list, its versions and the audit trail |
| `vm/sync/sources/files.js` | The mirror source `cmo_grievances` (moved from `google.js`): reads `cmo_grievances.csv` from the data folder |
| `cmo.html` | The **Upload** button and drawer, the "Last updated … by …" line and **Undo** |
| `vm/dev/test-cmo-upload.js` | The tests (`npm test`), synthetic data only |

## The file

The CMO portal's *Registered grievance list* export, as downloaded: one sheet, a title row `REGISTERD GRIEVANCE LIST AS ON dd-mm-yyyy` (sic), a blank row, the header (`S.No` and the 12 portal columns), a blank row, then one row per grievance. A .csv saved from it works too.

- **Header**: the row among the first 30 that names the most portal columns. Names are matched without regard to case or spaces (`Block /municipality` is `Block/ Municipality`); `S.No` is optional; other extra columns are ignored with a note; the columns may be in any order.
- **Rows**: every non-blank row under the header. `Received Date & Time` is read as `yyyy-mm-dd` text (the portal's), an Excel date serial, or `dd-mm-yyyy` / `dd/mm/yyyy`, and stored as `yyyy-mm-dd` (a time, if any, is kept after it).

The stored list has the snapshot's 17 columns in this order, the 12 portal columns as exported and 5 derived ones (what the sheet's formulas computed, checked against all 288 rows of the last Google copy):

| Column | Rule |
|---|---|
| `Name`, `Phone` | The applicant cell (`Name⏎9xxxxxxxxx`) split into the name and its trailing 10-digit mobile (a `+91` or `0` before it is dropped). No such number: the whole cell is the name and Phone is blank (a warning) |
| `Pending With` | When `Assign To` names a post of `Malda Zone, WBSEDCL`: the officer, the text before ` [`. Otherwise exactly `Disposed / pending with HQ`. cmo.html and the rating (`cmo_open_share`) read this column; its meaning is unchanged |
| `Report Date` | The upload date in India, `dd/mm/yyyy`, the same on every row (the page's "As on") |
| `Grievance Since` | Whole days from the received date to the report date |

## Checks

**Blocked** (nothing is kept; each reason is shown in plain words, e.g. "The file is missing the column 'Assign To'."):

- not an .xlsx or .csv (the old binary .xls gets "save it as .xlsx or .csv"), or larger than 10 MB;
- no header row with the portal's columns, or any of the 12 columns missing;
- a header but no grievances;
- more than 5% of rows with an unreadable or future received date, or no district;
- more than 20,000 rows.

**Warnings** (the uploader must tick each one before **Replace the list** works; the server checks the ticks again):

| Code | When |
|---|---|
| `row_drop` | More than 30% fewer rows than the list now served |
| `unknown_district` | A district other than Malda, Dakshin Dinajpur, Uttar Dinajpur, Not Known (kept; the page shows only the three districts) |
| `unknown_status` | A status other than Disposed, ATR Submitted to CMO, Assign to SO, Forwarded to HoSO, ATR Submitted to HoSO, ATR Submitted to HoD |
| `duplicates` | A row that repeats an earlier row cell for cell |
| `title_date` | The title's `AS ON` date is more than 2 days from the upload date, or there is no such title. The report date is still the upload date |
| `no_mobile` | An applicant cell without a 10-digit mobile |
| `bad_rows` | Up to 5% of rows with an unreadable or future received date or no district (their Grievance Since is blank) |

**The comparison** (preview only): there is no grievance ID, so a grievance is matched on a hash of the applicant cell, the received date, the category and the description (a second grievance with the same four gets `:1`, and so on). The preview shows new grievances, those no longer listed, status changes (with the most common moves, e.g. *ATR Submitted to CMO → Disposed*), pending with MZO before and after, and counts by district and status.

## Endpoints

All need a signed-in session; the POSTs also pass the app's global Origin check (a request without this site's `Origin`/`Referer` gets 403). Who may upload is checked on the server for every call; the page only hides the button.

| Route | Who | Does |
|---|---|---|
| `GET /api/cmo/upload/meta` | signed in | `{ enabled, canUpload, canUndo, isAdmin, source: upload\|snapshot\|google, last: { at, by, rows, pendingMzo, reportDate, action }, versions, limits }` (no-store) |
| `POST /api/cmo/upload/preview` | uploaders | multipart `file`. 200 `{ token, expiresAt, summary, diff, warnings, notes }`; 422/413/400 `{ status: 'blocked', blocks: [{ code, message }] }`; 429 while another upload runs |
| `POST /api/cmo/upload/commit` | the uploader who made the preview | `{ token, confirmWarnings: [codes] }`. 409 `confirm` with `missing` until every warning is ticked; 410 for an expired or used token; 409 when the list changed after the preview (another upload or an undo) |
| `POST /api/cmo/upload/undo` | admins | Puts the previous version back; 409 when there is none |
| `GET /api/cmo/dataset` | signed in | The list for pages that cannot use the mirror (DataHub `CACHE_CMO`): the uploaded CSV, else the mirror's last snapshot, else a 302 to the old published sheet (Vercel, a local checkout) |

**Uploaders**: admins (role `admin`, including `MZO_LOCAL_ADMINS`, re-checked like `requireAdmin`: a demoted admin stops at once) and users with the flag `cmo_upload_autho` (profile `cmo-upload-autho` = `Y`). The flag is in `FLAG_KEYS` and in `UPLOAD_FLAGS` as the word `cmo` (`lib/users_store.js`), so admins carry it and Admin → Users can grant it once the approval workbench has a tick box for it. Note: the workbench sends the whole `upload_permissions` list on save, so until it has that box, saving a user there clears a CMO grant made by other means. The legacy `dm1` bypass of other uploads does not apply. **Undo** is for admins only.

Preview tokens are random, kept in memory for 15 minutes, used once and tied to the user who made them; a restart forgets them (choose the file again). One preview, commit or undo runs at a time (429 for the others). Off on Vercel (`VERCEL` set): meta says `enabled: false`, the POSTs answer 404.

## Storage

In the app's data folder (`MZO_FILES_DIR`, `/opt/mzo/data/files` on the VM: outside the releases, `opc` only, never in git):

| File | What |
|---|---|
| `cmo_grievances.csv` | The list: the 17 columns, RFC 4180, written atomically, mode 600 |
| `cmo_grievances_meta.json` | Who and when (`by`, `byName`, `at`), `rows`, `pendingMzo`, `reportDate`, `titleDate`, the uploaded file's `fileSha256` and size, `warningsAccepted`, `action` (`upload` / `undo`) |
| `cmo_versions/<stamp>.csv` + `.json` | The previous 5 lists with their meta. The first upload keeps the last Google copy here, so undo can go back to it |
| `cmo_upload_audit.jsonl` | One line per commit or undo: when, who, rows, pending with MZO, file sha256, CSV sha1, warnings accepted |

The uploaded file is never kept (only its sha256). Applicant names, mobiles and grievance text are never logged: the journal gets `[CMO upload] <username> replaced the list: N rows (M pending with MZO)`, the activity log the counts.

**Why the files pattern, not the editor's native mode.** The list is replaced whole from one file, like the Safety Inspection upload, so it uses the same pattern: a CSV in the data folder read by `vm/sync/sources/files.js`, then `refreshMirror(['cmo_grievances'])`. The snapshot bytes stay exactly what pages, `lib/uniform.js`, the quality rules and the rating already read; versions and undo are plain file copies; nothing depends on PocketBase being up to accept an upload; and it needs no `sys_datasets.mode` switch. Native mode (`lib/editor/native.js`) suits datasets edited cell by cell in `/editor/`; making this one native would let editor edits and uploads overwrite each other and would put the derived columns in two places.

### After a commit

The commit writes the file and calls `refreshMirror(['cmo_grievances'], …, { now: true })`: within about 2 seconds the app starts `vm/sync/run.js --only cmo_grievances --now`. Until that run finishes the dataset is *dirty*: the manifest leaves it out and `/api/data/file` refuses it, so pages load `CACHE_CMO` from `/api/cmo/dataset`, which already serves the new file; the page that uploaded reloads its rows at once. The run copies the file into PocketBase and the snapshot, rewrites the manifest, rebuilds the uniform rows, the `sheet_links_dates` view and the data quality of `cmo_grievances`, and, because of `--now`, the rating at once instead of at most every 15 minutes (typically well under a minute on the VM). The source has `holdBack: false`, since a much shorter list was confirmed by the uploader.

## First deploy: no data gap

Nothing has to be done on the VM. What happens:

1. The deploy brings `google.js` without `cmo_grievances` and `files.js` with it. `/opt/mzo/data/files/cmo_grievances.csv` does not exist yet, so the source has `skip: 'no CMO export uploaded yet …'`.
2. Every sync run rewrites `manifest.json` from the source list and `sys_datasets`. The registry row still points at the snapshot the Google sheet last produced (`cmo_grievances.csv` in `/opt/mzo/data/snapshots`), so the manifest keeps that entry, now with `urls: ['/api/cmo/dataset', <old sheet URL>]`. When the source next falls due (hourly), it is recorded as `skipped` with that reason; a skip never touches the snapshot, the PocketBase rows or the registry's snapshot fields.
3. cmo.html, sheet_links, the quality checks and the rating keep reading that snapshot exactly as before. If a page cannot use the mirror, `/api/cmo/dataset` serves the same snapshot.
4. The first upload archives that snapshot as the first version (undo returns to it) and from then on the uploaded file is the source.

Optional, to have Admin → Sources show the new source at once instead of within the hour (as `opc`, harmless; it records the skip and rewrites the manifest):

```bash
cd /opt/mzo/app/vm/sync
node --env-file=/etc/mzo/pocketbase.env run.js --only cmo_grievances --reason "cmo_grievances moved to the VM upload"
journalctl -u mzo-reports -n 50 | grep 'CMO upload'   # after an upload
```

On Vercel nothing changes for users: there is no upload there, and `CACHE_CMO` (`/api/cmo/dataset`) redirects to the old published sheet, which no longer receives new data.

## Tests

`node vm/dev/test-cmo-upload.js` (in `npm test`): header detection under the title and blank rows, every derivation (including *Forwarded to HoSO* to the Zonal Manager, and Grievance Since), every block and warning, the comparison, the worker, the token flow, permissions (viewer 403, admin, the flag, no `dm1` bypass), the Origin check, the lock, undo through the versions back to the Google copy, 5 kept versions, the no-data-gap fallback (the source skips, the manifest keeps the entry, `/api/cmo/dataset` serves the snapshot), and that no name, mobile or grievance text reaches the logs, the audit, the meta or the activity log. Fixtures are generated in the test with fake names and numbers (`90000000xx`). On a machine with the real export at `CMO_REAL_SAMPLE` (default `~/Desktop/cbse-thingy/GRIEVANCE_REGISTER_08_11_2026.xlsx`) it also checks aggregates only (304 grievances, 19 pending with MZO, district counts); elsewhere that part is skipped. Never commit the real file or anything read from it.
