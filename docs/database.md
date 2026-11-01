# Database (Supabase)

Login, activity logs, Priority SI works, stock allotments and the Power Map live in Supabase. Report data does not: it comes from Google Sheets or Supabase Storage through the DataHub (see [architecture.md](architecture.md#datahub)).

> Local development talks to the **production** project. Running a migration, import or sync script writes to production. Ask before running one.

## Schemas and tables

| Schema / table | Holds |
|---|---|
| `mzo_insight.portal_users` | Portal login (Username, scrypt-hashed PIN) and every module flag (`nsc_upload_autho`, `si_autho` / `si_divisions`, `sheets_autho`, `stock_*_autho`, `defective_upload_autho`, sync flags, optional `email` for Google sign-in) |
| `mzo_insight.activity_logs` | Portal activity (Admin → Activity) |
| `mzo_insight.prioritySI` | Priority SI works (`si-works/si.html`) |
| `mzo_insight.stock_allotments` | Stock allotment ledger (see [stock.md](stock.md)) |
| `mzo_insight.important_unbilled_months` | Important Sheets unbilled months |
| `public.mzo_power_substations` | Power Map substations and feeders |
| `public.mzo_power_corrections` | Power Map edit suggestions awaiting admin approval |

`mzo_insight` must be listed under Project Settings → API → **Exposed schemas**. After adding a column, run `NOTIFY pgrst, 'reload schema'`.

Production login stays on the old project (`unsmtschmcvftfqwabaq`) until `INSIGHT_LIVE=1`; the new insight project and its cutover are described in [stock.md](stock.md#new-insight-project).

## SQL files (`scripts/sql/`)

Run in the Supabase SQL Editor.

| File | Run it when |
|---|---|
| `create_insight_project_gmasnqeb.sql` | Setting up an empty insight project: portal users, logs, unbilled months and stock tables in one go |
| `create_mzo_insight_schema.sql` | Creating the `mzo_insight` schema and the Priority SI tables |
| `create_mzo_insight_portal_users.sql`, `create_mzo_insight_activity_logs.sql`, `create_important_unbilled_months.sql` | Creating those tables one by one in an existing project |
| `create_mzo_insight_stock_snapshot.sql`, `create_mzo_insight_stock_allotments.sql`, `create_stock_storage_policies.sql` | Adding the stock tables and the Storage policies |
| `create_mzo_power_map_tables.sql` | Creating the Power Map tables (drops and recreates them) |
| `upgrade_existing_tables.sql` | Bringing an older project up to date: every column added since (module flags, Google sign-in fields, SI money fields, allotment cancel, stock category). Guarded, safe to re-run |
| `drop_legacy_tables.sql` | Removing the old SI PIN table and the NSC row tables (keep the `nsc_upload_autho` flag) |

## Moving to the new insight project

`npm run copy:insight` (`scripts/migrate/copy_insight_to_new_supabase.js`) copies users, logs, unbilled months, allotments and the stock snapshot into the new project without switching production; see [stock.md](stock.md#new-insight-project). The one-off imports from the old Google Sheets (users, activity logs, Power Map, stock) were run during earlier migrations and removed from the repo; git history has them.

## Login rules

- PINs are stored as `scrypt$` hashes. A still-plain PIN is accepted once and then replaced with its hash. `GET /api/admin/users` never returns `PIN`; a blank PIN on update keeps the current one.
- Google sign-in verifies the ID token with Google (audience = `GOOGLE_CLIENT_ID`, issuer, expiry, verified email) and signs in the portal user whose `email` equals the token's email exactly. An email no user has registers a new account with `user_status = pending` until an admin approves it (root-admin emails are provisioned directly). Existing PIN users are linked to Google by an admin setting their email in User Management; there is no match on the part before the @.
- After an admin changes a module flag, the user signs in again so the stored profile refreshes.
- Power Map tables and Priority SI data are untouched by the login import.
