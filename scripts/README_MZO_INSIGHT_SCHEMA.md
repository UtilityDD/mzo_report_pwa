# Move Priority SI → schema `mzo_insight`

Separates Priority SI tables from Power Map tables in the same Supabase project.

## What moves

| Table | From | To |
|-------|------|----|
| `prioritySI` | `public` | `mzo_insight` |
| `user_access` | `public` | `mzo_insight` |

**Untouched:** `mzo_power_substations`, `mzo_power_corrections`, and all other `public` tables.

## Steps

1. **SQL Editor** — open Supabase Dashboard → SQL Editor → paste and run  
   [`create_mzo_insight_schema.sql`](create_mzo_insight_schema.sql)  
   Check the verification queries at the bottom.

2. **Expose schema** — Project Settings → API → **Exposed schemas**  
   Add `mzo_insight` (keep `public`). Save.

3. **App** — `si-works/si.html` already uses `db: { schema: 'mzo_insight' }`.  
   Deploy / hard-refresh, then smoke-test Priority SI Works and Power Map.
