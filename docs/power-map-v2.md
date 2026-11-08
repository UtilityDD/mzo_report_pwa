# Power Map V2 (DISHA)

The Power Map page is the DRO **PowerMapV2** React app, hosted inside DISHA.

| Path | Role |
|---|---|
| `power_map/v2/` | Built static assets (committed; the VM serves these as-is) |
| `power_map/powermap-v2/` | Source (Vite + React). Rebuild when the map changes |
| `power_map/map.html` | Legacy CSV / Leaflet map (rollback URL) |
| `GET /api/powermap/config` | Session-only: anon URL/key after a live probe of `pm_*` / `powermap.*` |
| `GET /api/powermap/me` | Session identity: portal **admin** → map `super`; others view-only for now |

## Rebuild

```bash
cd power_map/powermap-v2
npm ci
npm run build
```

Output lands in `power_map/v2/`. Commit that folder with the source change. The VM deploy has no Vite; it only unpacks the release tarball.

## UI

The host (`src/mzo-host.tsx`) hides the standalone Power Map chrome, maps `--mzo-*` tokens onto the map, and uses **Shift+/** for network search so shell ⌘K stays for reports.

## Auth

Do not bake Supabase keys into the bundle. Credentials come from `/api/powermap/config` after login. Editor grants via `pm_editors` are stubbed for a later phase.
