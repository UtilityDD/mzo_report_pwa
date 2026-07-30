# Portal login → `mzo_insight.portal_users`

Replaces the Google Sheet as the **source of truth** for MZO portal Username/PIN login.

## Steps

1. **SQL Editor** — run [`create_mzo_insight_portal_users.sql`](create_mzo_insight_portal_users.sql)  
   (schema `mzo_insight` must already be in **Exposed schemas**)

2. **Import once from the old sheet** (local terminal):
   ```bash
   npm run migrate:portal-users
   ```
   Re-import wipe: `FORCE=1 npm run migrate:portal-users`

3. **Deploy** server changes — `/api/login` and admin user CRUD read/write Supabase only.

## Notes

- Admin UI (`admin_users.html`) keeps working; create/update/delete persist to `portal_users`.
- Google Sheet is no longer used for live login after deploy.
- Power Map tables and SI `prioritySI` data are untouched.
- Priority SI Works auth uses portal fields `si_autho` / `si_divisions` (run `alter_portal_users_si_auth.sql` if the table already exists).
- Legacy SI PIN table can be removed with `drop_si_user_access.sql`.
- Important Sheets unbilled months: run `create_important_unbilled_months.sql` (admins manage via page Manage button).
- Grant non-admin Manage access with `sheets_autho` (run `alter_portal_users_sheets_auth.sql`, set in Admin → Sheets Manage Access).
