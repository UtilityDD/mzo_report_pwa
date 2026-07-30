# Move Priority SI → schema `mzo_insight`

Separates Priority SI data tables from Power Map tables in the same Supabase project.

## What lives in `mzo_insight`

| Table | Notes |
|-------|--------|
| `prioritySI` | SI works data |
| `portal_users` | Portal login + module auths (including SI `si_autho` / `si_divisions`) |
| `activity_logs` | Portal activity |

**Removed:** legacy SI PIN table `user_access` — drop with [`drop_si_user_access.sql`](drop_si_user_access.sql) after portal SI auth is live.

**Untouched:** `mzo_power_substations`, `mzo_power_corrections`, and other `public` tables.

## Steps (original schema move)

1. **SQL Editor** — run [`create_mzo_insight_schema.sql`](create_mzo_insight_schema.sql) if SI tables are still in `public`.
2. **Expose schema** — Project Settings → API → **Exposed schemas** → include `mzo_insight`.
3. **App** — `si-works/si.html` uses `db: { schema: 'mzo_insight' }` and portal session auth.
