# Power Map V2 (DISHA)

The Power Map page is the DRO **PowerMapV2** React app, hosted inside DISHA.

| Path | Role |
|---|---|
| `power_map/v2/` | Built static assets (committed; the VM serves these as-is) |
| `power_map/powermap-v2/` | Source (Vite + React). Rebuild when the map changes |
| `power_map/map.html` | Legacy CSV / Leaflet map (rollback URL) |
| `GET /api/powermap/config` | Session-only: after a live probe of `pm_*` / `powermap.*`, the proxy path and schema. No URL or key |
| `GET /api/powermap/me` | Session identity: portal **admin** → map `super`; others view-only for now |
| `/api/powermap/rest/v1/*` | PostgREST proxy the map's supabase-js client talks to (see Data access) |

## Rebuild

```bash
cd power_map/powermap-v2
npm ci
npm run build
```

Output lands in `power_map/v2/`. Commit that folder with the source change. The VM deploy has no Vite; it only unpacks the release tarball.

Build without `VITE_ADMIN_PIN` and `VITE_BUNDLE_LEGACY_SEED`: `power_map/v2/` is served to anyone (static files need no login), so the DISHA build carries no PIN and no network data. `power_map/powermap-v2/` itself (source, seed JSON, import script, SQL) is never served (`PRIVATE_PATH` in `server.js`, `.vercelignore`).

## UI

The host (`src/mzo-host.tsx`) hides the standalone Power Map chrome, maps `--mzo-*` tokens onto the map, and uses **Shift+/** for network search so shell ⌘K stays for reports.

## Auth

Do not bake Supabase keys into the bundle, and do not hand one to the browser. Edit rights come from the portal session (`/api/powermap/me`); there is no PIN unlock inside DISHA. Editor grants via `pm_editors` are stubbed for a later phase.

## Data access

The browser holds no Supabase key. `src/lib/supabase.ts` points supabase-js at `/api/powermap` on this host, and `server.js` (`powerMapProxy_`) forwards to the Power Map project:

- **Reads** (GET/HEAD): any signed-in user, the map tables and views only (`POWERMAP_PROXY_READ`), with `POWERMAP_SUPABASE_KEY` (the anon key is enough).
- **Writes** (POST/PATCH/DELETE) and **RPC** (`pm_admin_update_substation_bundle`): portal admins only (the `requireAdmin` test), from this host's Origin (the usual API write check), tables in `POWERMAP_PROXY_WRITE`, with `POWERMAP_SUPABASE_SERVICE_KEY`.
- **Editor accounts and suggestions** (`pm_editors`, `pm_edit_suggestions`): admins only, both ways; `pin_hash` is stripped and cannot be filtered on.
- Only allow-listed headers go upstream (Accept/Content-Profile `public` or `powermap`, Prefer, Range); the client's apikey is ignored. Tests: `vm/dev/test-powermap-proxy.js`.

On the database, `supabase/migrations/010_lock_down_anon.sql` makes the public keys read-only: no anon writes in `powermap` or on `public.pm_*`, no anon access to editors / suggestions / profiles, SELECT-only policies, and SECURITY DEFINER functions for service_role only. Order for the owner: set `POWERMAP_SUPABASE_SERVICE_KEY` on the server and restart, deploy this build, then run 010. The anon key can still read the map tables after 010; to close that too, set `POWERMAP_SUPABASE_READ_KEY=service` and run the optional block at the end of 010.
