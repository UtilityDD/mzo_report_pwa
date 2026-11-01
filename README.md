# MZO Reports

Login-gated reporting app (PWA) for WBSEDCL Malda Zone: new service connections, revenue and losses, consumers and meters, substations and field tools, for every region, division and CCC.

Plain HTML/CSS/JS pages served by a small Express server (`server.js`). No build step. Report data is loaded in the browser from Google Sheets and Supabase Storage and cached in IndexedDB.

**Production:** https://mzo-reports.vercel.app

## Run it

```bash
npm install
npm run dev        # http://localhost:3000 (opens /app.html after sign-in)
```

Optional `.env` (git-ignored, loaded by `npm run dev`): `ANTHROPIC_API_KEY` for **Ask**, plus any of the variables in [docs/deploy.md](docs/deploy.md#deploy).

> There is no separate development database. A local server reads and **writes production** data (login, activity logs, uploads, syncs, follow-ups, allotments). Use a real portal account and do not save, upload, sync or delete anything while testing.

## Repository map

| Path | What |
|---|---|
| `server.js` | Express: session login, `/api/*`, static files |
| `app.html` | The app on desktop and phone: sidebar, ⌘K search, reports in tabs. `/` and the old `/index.html` redirect here |
| `login.html`, `auth.js` | Sign-in and session check |
| `*.html`, `nsc/`, `consumer/`, `rem/`, `docket/`, `smart_meter/`, `Upkeeping/` | Report pages |
| `power_map/`, `si-works/`, `dtr/`, `accident/`, `prt-oil/`, `stock/`, `dd/` | Field tools (maps, forms, stock) |
| `mzo_theme.css`, `mzo_theme.js`, `mzo_ui.js` | Design system: tokens, UI kit, theme, page helpers |
| `mzo_data_hub.js` | Dataset registry and IndexedDB cache |
| `mzo_scope.js` | Login office scope (which offices a user may see) |
| `sw.js`, `version.json`, `mzo_app_update.js` | Service worker and the in-app update notice |
| `lib/` | Modules shared between pages and the server |
| `apps-script/` | Google Apps Script sources (deployed by hand) |
| `scripts/` | SQL, sync, migration and generator scripts ([scripts/README.md](scripts/README.md)) |
| `icons/`, `manifest*.json` | PWA icons and manifests |
| `data/` | Two small lookup files; everything else there is git-ignored |
| `docs/` | Documentation |

## Documentation

| Doc | Read it for |
|---|---|
| [AGENTS.md](AGENTS.md) | Rules for anyone (human or AI) changing this repo. Start here |
| [docs/architecture.md](docs/architecture.md) | Pages, login and office scope, DataHub caching, service worker, server API |
| [docs/design-system.md](docs/design-system.md) | The Graphite look, UI kit, workstation shell, building a report page |
| [docs/reports.md](docs/reports.md) | Per-report rules (data sources, date cells, sync, follow-ups) |
| [docs/database.md](docs/database.md) | Supabase schemas, SQL files, imports, login rules |
| [docs/stock.md](docs/stock.md) | Stock dump, insight project, allotments |
| [docs/apps-script.md](docs/apps-script.md) | Apps Script web apps behind the sheets |
| [docs/assistant.md](docs/assistant.md) | Ask (Claude Haiku via `/api/assistant`) |
| [docs/deploy.md](docs/deploy.md) | Remotes, Vercel, environment variables, releasing |
