# MZO Power Map → Supabase (new table names)

Creates **separate** table names so they do not clash with a project/table named `substations`.

| New table | Purpose |
|-----------|---------|
| `mzo_power_substations` | Network SS + feeders (22 sheet columns) |
| `mzo_power_corrections` | Suggested edits for admin approval |

## Steps

1. Supabase → **SQL Editor** → run [`create_mzo_power_map_tables.sql`](./create_mzo_power_map_tables.sql)
2. From repo root:

```bash
npm run migrate:power-map
```

3. Restart the server and open Power Map
