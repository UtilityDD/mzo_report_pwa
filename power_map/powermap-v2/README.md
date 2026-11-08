# PowerMap V2

Professional web GIS for planning electrical transmission & distribution networks.

## Stack

- React + TypeScript + Vite
- Leaflet + Leaflet-Geoman
- Zustand + IndexedDB
- Supabase + PostGIS (optional cloud backend)

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Supabase setup (shared project)

PowerMap uses the **same Supabase credentials** as your other apps, but its own schema:

`powermap.*` (does not mix with `public` tables from other projects)

1. Credentials are in `.env` (gitignored).
2. Run in SQL Editor:

`supabase/migrations/004_powermap_schema.sql`

3. Dashboard → **Settings → API → Exposed schemas** → add `powermap` → Save.

Until then, the app runs offline via IndexedDB with a small demo network.

## Tools

| Tool | Action |
|------|--------|
| Select | Click asset → property panel |
| Add SS | Click map to place substation |
| Connect | Click two substations to create a trunk line |
| Tap | Click a line, then a SS or another line |
| Move | Drag substations (lines/taps update) |
| Delete | Click asset (warns on dependencies) |
| Measure | Draw path for distance |

## Symbology

- 400 kV square · 220 kV diamond · 132 kV hexagon · 66 kV pentagon · 33 kV circle
- Filled = existing · Outline = proposed
- Line color = voltage · Dashed = proposed
