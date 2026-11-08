# Users on the VM (PocketBase user store)

On the VM, users, sign-in and the activity log live in the VM's own PocketBase instead of Supabase `mzo_insight.portal_users` / `activity_logs`. The database starts empty: nothing is copied from Supabase. Vercel (`main`) and a local checkout keep the Supabase path exactly as before ([database.md](database.md#login-rules)).

| Where | What |
|---|---|
| `MZO_USER_STORE=pocketbase` | Turns the store on. Set in `vm/deploy/systemd/mzo-reports.service`; never on Vercel |
| `lib/users_store.js` | The store: PocketBase client, sign-in, sessions, admin routes, activity log, seeding |
| `lib/google_auth.js` | Google token checks, shared with the Supabase path |
| `lib/report_modules.js` | Report keys for `modules`, read from the NAV registry in `app.html` |
| `vm/pocketbase/pb_migrations/1794000000`–`1794000002` | The three collections below |
| `vm/pocketbase/pb_migrations/1794200000` | `app_assistant_usage`: Ask usage per model call (below; owned by `lib/assistant/usage.js`) |
| `admin_users_pb.js` | Admin → Users additions (only active when the server says `store: pocketbase`) |
| `vm/dev/test-users-store.js` | Tests against a throwaway local PocketBase |

`server.js` only hands over to the store: the routes it mounts (`/api/auth/google`, `/api/auth/pending-status`, `/api/session-check`, `/api/admin/users*`, `/api/admin/logs`, `/api/admin/sync`) are registered before the Supabase ones, and `logActivity`, `getLoginCredentials` and the session reader call the store when it is on.

## Collections

All three are base collections with every API rule `null`: only the app reads and writes them, signed in as the PocketBase superuser (`PB_URL`, `PB_SUPERUSER_EMAIL`, `PB_SUPERUSER_PASSWORD` from `/etc/mzo/pocketbase.env`). The admin portal and anonymous API callers cannot see them.

### `app_users`

| Field | Type | Notes |
|---|---|---|
| `email` | text, required | The identity. Lowercase only (pattern), unique ignoring case |
| `username` | text, required | Short handle shown as `Username` (pages, activity, Visitors). From the email's local part, unique ignoring case, never a VM-only admin's name. Cannot change |
| `google_sub` | text | Google account id, linked at the first sign-in; unique when set. A later sign-in from another Google account with the same email is refused. Cleared when an admin changes the email |
| `name`, `photo_url` | text | From Google at registration (`name` only when empty afterwards; the photo is refreshed) |
| `phone`, `designation`, `employee_id`, `notes` | text | Set by admins |
| `role` | select `admin` \| `editor` \| `viewer` | `editor` is for the data editor; in the report pages it behaves like `viewer` |
| `status` | select `pending` \| `active` \| `disabled` \| `rejected` | Only `active` can sign in |
| `scope_level` | select `zone` \| `region` \| `division` \| `ccc` | Empty while pending. Admins are always `zone` |
| `region`, `division` | text | Canonical names from `lib/offices.js` (`Malda`, `Uttar Dinajpur`, `Dakshin Dinajpur`; `Chanchal`, …). A region saved under its old name (`Raiganj`, `Balurghat`) is shown and scoped under the current one; saving the user again stores the current name |
| `ccc_code` | text | 7-digit CCC code (`6612102` = Samsi), only at `ccc` level |
| `modules` | json | Report keys from `app.html`'s NAV the user may open; `null` = every report. Ignored for admins |
| `feature_flags` | json | The per-feature grants the pages already read, by snake_case name: `nsc_autho`, `dd_autho`, `ss_autho`, `dtr_autho`, `nsc_upload_autho`, `stock_upload_autho`, `stock_allot_autho`, `stock_cancel_autho`, `defective_upload_autho`, `disconnection_sync_autho`, `pending_mc_sync_autho`, `load_ext_sync_autho`, `unbilled_sync_autho`, `si_autho`, `si_divisions`, `sheets_autho`, `cmo_upload_autho` (the CMO grievance upload, [cmo-upload.md](cmo-upload.md); `upload_permissions` word `cmo`), plus `can_comment` (bool). Admins get every upload flag regardless |
| `session_version` | number | In every session cookie; bumping it ends all of the user's sessions |
| `requested_at`, `approved_by`, `approved_at` | date / text | Registration and activation (approved_by is the admin's email, or `seed`) |
| `disabled_reason` | text | Why the account was disabled or rejected |
| `last_login_at`, `last_seen_at`, `login_count` | date / number | Sign-ins; `last_seen_at` moves at most every 5 minutes |
| `created`, `updated` | autodate | |

Indexes: unique `email` (NOCASE), unique `username` (NOCASE), unique `google_sub` where set, `(status, role)`, `(scope_level, region, division, ccc_code)`.

The scope is checked in the app, not the schema: `zone` takes no office; `region` needs a region; `division` needs a division (its region is filled in, and a different region given is an error); `ccc` needs a CCC by code or name (division and region are filled in and must agree). An active non-admin must have a scope.

### `app_activity`

`user_email`, `username`, `user_name` (snapshots, so rows still read correctly after a rename or delete), `action` (`login`, `login_refused`, `page_visit`, `user_management`, and the server's other activity types), `page`, `details` (json, `{ text, … }`), `ip`, `user_agent`, `created`. Indexed on `created` and on `user_email`, `username` and `action` with `created`.

Rows are queued and written in batches about once a second. Rows older than `MZO_ACTIVITY_RETENTION_DAYS` (default 180, minimum 7) are deleted two minutes after start and then every 6 hours, up to 10,000 per run.

### `app_user_audit`

Every change to an account: `user_email`, `username`, `actor_email`, `actor_name`, `action` (`register`, `seed`, `create`, `approve`, `reject`, `update`, `disable`, `enable`, `delete`, `link_google`), `changes` (list of `{ field, from, to }`; feature flags as `feature_flags.<name>`), `reason`, `ip`, `created`. Never pruned. Shown as **Change history** in the user form (`GET /api/admin/users/audit?username=`).

### `app_assistant_usage`

One row per Ask model call (a question takes 2–4: the browser runs the tool loop and posts each turn), for **Admin → Ask usage** (`admin_users.html?tab=asks`, `GET /api/admin/assistant-usage`). Metadata only, never the question, the answer or tool results:

| Field | Type | Notes |
|---|---|---|
| `user_email`, `user_name` | text | Who asked (snapshots, from the session) |
| `provider`, `model` | text | `goedel` / `anthropic`, and the model the provider named |
| `turn` | number | 0 for the call that starts a question, 1, 2… for the calls after its tool results. Questions = rows with `turn` 0 |
| `input_tokens`, `cached_input_tokens` | number | Every input token (cached included) and the cached part; new input = the difference |
| `output_tokens`, `reasoning_tokens` | number | Every output token (reasoning included) and the reasoning part when reported |
| `latency_ms` | number | Time at the provider (queue wait excluded) |
| `status` | text | `ok`, the provider's HTTP status (`401`, `402`, `429`, `502`…) or `timeout`, `network`, `queue` (the local queue was full: never reached the provider), `upstream`, `error` |
| `tool_calls_count`, `retries` | number | Tool calls in the answer; retries after a 429 / 5xx (each is one more request against the RPM limit) |
| `data_policy` | text | The provider's `X-Data-Policy` header (`retained` on a free Gödel key) |
| `created` | autodate | Indexed, as is (`user_email`, `created`) |

Written by the app (`PB_URL` and the superuser login, like the data editor) in small batches about once a second; a failed write is logged at most every 10 minutes and never affects Ask. Not pruned (a few thousand small rows a day). Without PocketBase the panel reads an in-memory ring buffer of the last 2,000 calls instead.

Per-dataset edit rights for the data editor are a separate collection, `app_dataset_permissions`, owned by the data editor (`/editor/#/permissions?email=…`; the user row's **Data permissions** button links there).

## Built-in admins

`DEFAULT_ADMIN_EMAILS` at the top of `lib/users_store.js` (`dipnkr.das@gmail.com`) plus `ROOT_ADMIN_EMAILS` in `server.js` (`smartlinemanapp@gmail.com`). `MZO_ADMIN_EMAILS` (comma-separated, in `/etc/mzo/app.env`) **replaces** the default list; the root admins are always added. At every start the app makes each of them an active admin with zone scope, creating the account if needed and auditing only what it changed (so a re-run changes nothing). It never touches any other account. Through the API a built-in admin cannot be demoted, disabled, deleted or have its email changed; remove it from the list first. No admin can change their own role, disable or delete themselves.

The VM-only password admins (`MZO_LOCAL_ADMINS`, [vm.md](vm.md#vm-only-admin-accounts)) stay as break-glass access: they are not in `app_users`, their sessions work as before, and their activity goes to `app_activity` too.

## Sign-in

Google only (`POST /api/auth/google`); there is no PIN sign-in in this store.

1. The token is checked by `lib/google_auth.js` (both stores): an **ID token** (Sign-In button, One Tap) by its RS256 signature against Google's keys (`https://www.googleapis.com/oauth2/v3/certs`, cached per `Cache-Control`, refetched for an unknown key id), `iss` = accounts.google.com, `aud` = `GOOGLE_CLIENT_ID`, `exp` in the future, `iat` not in the future and `email_verified`. An **access token** (the popup `login.html` uses) can only be checked by Google, so it goes to Google's tokeninfo; then `aud`/`azp` must be `GOOGLE_CLIENT_ID`, it must be unexpired with a verified email, and userinfo must name the same account.
2. Unknown email: an account is created with `status: pending`, role `viewer`, no scope. The answer is the existing "waiting for approval" screen, with an HttpOnly `mzo_pending` cookie (signed with `JWT_SECRET`, 30 days, path `/api/auth`). `GET /api/auth/pending-status?email=` answers only for the email in that cookie, so it cannot be used to probe other emails.
3. `pending` → the pending screen again; `rejected` → 403 `rejected`; `disabled` → 403 `suspended`; a different Google account for a linked email → 403. These are logged as `login_refused`.
4. `active` → session cookie `mzo_session` (24 h, as before) carrying the account id (`uid`) and `session_version` (`sv`); `last_login_at`, `login_count` and the photo are updated.

## Sessions and the profile

On every request the session's account is looked up in an in-memory copy of `app_users` (updated on every write the app makes, reloaded every 30 s for changes made in the PocketBase dashboard). The session is void when the account is gone, not `active`, or its `session_version` differs. Admin changes to **role, status, scope or email** bump `session_version`, so the user is signed out everywhere at once. Other changes (modules, flags, profile fields) apply on the next request without signing out.

`req.user` and the profile `login.html` stores are built from the current account. Besides the new fields (`email` lowercase, `role`, `isAdmin`, `uid`, `status`, `scope_level`, `scope_ccc_code`, `modules`, `designation`, `photo_url`) it keeps the legacy fields every page and `server.js` read:

| Legacy field | From |
|---|---|
| `Username`, `Name` | `username`, `name` |
| `user_status` | `status`, with `disabled` shown as `suspended` |
| `zone_code` | `MZO` once a scope is set |
| `region_code`, `division_code`, `ccc_code` | Region, division and **CCC name** (not the code), as the admin page always saved them; `mzo_scope.js` resolves them |
| `office_level` | `CE` zone, `SE` region, `DE` division, `CCC` |
| `nsc-autho`, `nsc-upload-autho`, … `sheets-autho` | `feature_flags`, kebab-case |
| `upload_permissions`, `can_comment` | From the upload flags and `can_comment` |
| `LastLogin`, `requested_at`, `approved_by`, `approved_at`, `auth_provider: 'google'` | Tracking fields |

## Modules

`modules` limits which reports a non-admin can open. Keys are the NAV item keys in `app.html` (`nsc`, `loss`, `collection`, …; the Administration group is not listed). With a list:

- the shell's sidebar and ⌘K search show only those reports (one line in `app.html` `index()`);
- the server refuses those report pages with 403 (`reportPageGate_` in `server.js`, ahead of the static files). Pages that are not in the NAV (Briefing, Ask, upload pages) stay open.

It is a visibility control for report pages, not data security: the data APIs (`/api/data/*`, meta endpoints) are not filtered by module. Office scope still comes from the login only.

## Activity

`logActivity()` in `server.js` writes to `app_activity` (with the request's IP and user agent). Page visits are recorded from `/api/session-check`, which `auth.js` and the shell call on every page: the same-origin `Referer` is the page, at most once a minute per user and page (`/login.html` and `/admin_users.html` are not counted). Before, page visits were logged only for HTML requests that reached `requireAuth`, which static pages never do.

`GET /api/admin/logs` returns the last 2,000 rows in the old shape (`timestamp`, `username`, `name`, `type`, `details`, plus `email`, `page`, `ip`); `?days=N` (max 30) returns up to 5,000 `{ timestamp, username }` for **Last active** and Visitors.

## Admin routes

Same paths and request shapes as before, so Admin → Users, Approvals, Activity and Visitors work unchanged; users are found by `Username`.

| Route | In this store |
|---|---|
| `GET /api/admin/users` | Every account (legacy profile + `phone`, `employee_id`, `notes`, `disabled_reason`, `login_count`, `last_seen_at`, `google_linked`, `seeded`), plus `store: 'pocketbase'`, the `modules` catalogue and `builtInAdmins` |
| `POST /api/admin/users/create` | Needs a valid email. Username optional (derived). Active by default, so a non-admin needs an office |
| `POST /api/admin/users/update` | Any of role, status (`suspended` = `disabled`), email, scope (legacy `zone_code`/`region_code`/`division_code`/`ccc_code` names, or `scope_level`/`region`/`division`/`ccc_code`), modules, flags (kebab or snake), profile fields |
| `POST /api/admin/users/approve` | Activates. Needs an office (Quick approve without one gets a 400 asking for it); the workbench's office tier must match the office chosen |
| `POST /api/admin/users/reject` | `status: rejected`, the reason in `disabled_reason` |
| `POST /api/admin/users/delete` | Deletes the account (its audit rows and activity stay) |
| `GET /api/admin/users/audit?username=` | The account's change history |
| `POST /api/admin/sync` | Reloads the in-memory list from PocketBase |

Each change writes `app_user_audit` and a `user_management` activity row.

## The old Supabase tables

`mzo_insight.portal_users` and `activity_logs` are not read or written by the VM app in this mode (production on Vercel still uses them). The mirror still copies them read-only into PocketBase as `ds_portal_users` and `ds_activity_logs` (`vm/sync/sources/supabase.js`) for the admin portal; once Vercel no longer signs anyone in from Supabase, those two sources can be dropped.

## Deploying (first time)

1. Merge to `develop`. The deploy installs the changed unit (`MZO_USER_STORE=pocketbase`), restarts the app, then restarts PocketBase because migrations changed. Until PocketBase has the new collections the app retries every 10 s (`journalctl -u mzo-reports | grep Users`): `[Users] PocketBase user store ready: 2 users, built-in admins: …`.
2. Optional, in `/etc/mzo/app.env`: `MZO_ADMIN_EMAILS=…` (replaces the default list), `MZO_ACTIVITY_RETENTION_DAYS=…`. Then `sudo systemctl restart mzo-reports`.
3. The Google OAuth client (`GOOGLE_CLIENT_ID`) must list `https://130.210.43.11.sslip.io` under **Authorized JavaScript origins**.
4. Every existing VM session ends (old cookies have no account id). Only the built-in admins and the VM-only admins can use the VM until an admin approves the others.

Turning it off: `MZO_USER_STORE=off` in `/etc/mzo/app.env` and a restart puts the VM back on Supabase (the `app_*` data stays).

## Tests

```bash
node vm/dev/test-users-store.js     # needs vm/pocketbase/local/pocketbase (v0.40.6, git-ignored) or PB_BIN; uses port 8191 (TEST_PB_PORT)
```

It starts PocketBase on a temporary folder with the repo migrations and runs `server.js` in-process with the store on. Google is a stand-in fetch with a test RSA key and a tokeninfo fixture (nothing in the app can be told to skip verification); any other upstream request fails the test. Covered: migrations, idempotent seeding and restoring a built-in admin, token checks, pending registration and the pending-status ticket, approval with scope validation, the legacy profile (resolved through the real `mzo_scope.js`), modules, revocation on role, scope and status changes, reject, create, delete, the audit trail, the activity log and its prune, the VM-only admin, and the Supabase path without the flag.
