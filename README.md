# MZO Reports PWA

Login-gated reporting dashboard for Malda Zone (WBSEDCL). Vanilla HTML/JS PWA with Express (`server.js`), IndexedDB data cache, and Supabase-backed login.

```
npm install
npm run dev
```

Open http://localhost:3000 — unauthenticated pages redirect to `/login.html`.

**Developer guide:** [DEVELOPER.md](DEVELOPER.md) (architecture, auth/scope, DataHub, service worker, how to add a page).

Topic notes:

- `scripts/README_PORTAL_USERS.md` — login users
- `scripts/README_MZO_INSIGHT_SCHEMA.md` — Supabase schemas
- `scripts/README_STOCK_SUPABASE.md` / `stock/README_ALLOTMENT.md` — stock
- `scripts/README_NSC_PENDING.md` — NSC
- `scripts/README_POWER_MAP_MIGRATION.md` — power map
- `scripts/README_ACTIVITY_LOGS.md` — activity logs
