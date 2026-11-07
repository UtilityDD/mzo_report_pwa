# MZO Reports

Login-gated reporting app (PWA) for WBSEDCL Malda Zone: new service connections, revenue and losses, consumers and meters, substations and field tools, for every region, division and CCC.

Plain HTML/CSS/JS pages served by a small Express server (`server.js`). No build step. Report data is loaded in the browser from Google Sheets and Supabase Storage and cached in IndexedDB.

**Production:** https://mzo-reports.vercel.app

## Run it

```bash
npm install
npm run dev        # http://localhost:3000 (opens /app.html after sign-in)
```

Optional `.env` (git-ignored, loaded by `npm run dev`): `GOEDEL_API_KEY` or `ANTHROPIC_API_KEY` for **Ask** (see [docs/assistant.md](docs/assistant.md)), plus any of the variables in [docs/deploy.md](docs/deploy.md#deploy).

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
| [docs/HANDOFF.md](docs/HANDOFF.md) | Start here if you are new: the project, data sources, hosting, the VM, safe local runs, workflow |
| [AGENTS.md](AGENTS.md) | Rules for anyone (human or AI) changing this repo. Start here |
| [docs/architecture.md](docs/architecture.md) | Pages, login and office scope, DataHub caching, service worker, server API |
| [docs/uniform-data.md](docs/uniform-data.md) | Uniform rows (`MzoRows`, `lib/uniform.js`, `schema/`), converting a page; [page inventory](docs/uniform-data-inventory.md) |
| [docs/design-system.md](docs/design-system.md) | The Graphite look, UI kit, workstation shell, building a report page |
| [docs/reports.md](docs/reports.md) | Per-report rules (data sources, date cells, sync, follow-ups) |
| [docs/database.md](docs/database.md) | Supabase schemas, SQL files, imports, login rules |
| [docs/users.md](docs/users.md) | Users on the VM: the PocketBase user store (`app_users`, activity, audit), sign-in, built-in admins, modules |
| [docs/data-mirror.md](docs/data-mirror.md) | The VM's PocketBase copy of every dataset: sources, storage structure, schedules, raw snapshots, running a sync |
| [docs/data-editor.md](docs/data-editor.md) | The data editor at `/editor/` on the VM: editing, pasting and permissions; datasets the VM owns (native mode) |
| [docs/data-quality.md](docs/data-quality.md) | Data quality checks on the mirror: findings, the owner action list per sheet, scores, how the checks work |
| [docs/org-hierarchy.md](docs/org-hierarchy.md) | Admin → Organisation: WBSEDCL's office hierarchy chart, its dataset and API, and what scaling beyond Malda Zone would change |
| [docs/stock.md](docs/stock.md) | Stock dump, insight project, allotments |
| [docs/apps-script.md](docs/apps-script.md) | Apps Script web apps behind the sheets |
| [docs/assistant.md](docs/assistant.md) | Ask (`/api/assistant`; DeepSeek V4.1 Flash on Gödel Machines or Claude Haiku, chosen by env) |
| [docs/deploy.md](docs/deploy.md) | Remotes, Vercel, environment variables, releasing |
| [docs/vm.md](docs/vm.md) | The VM: auto-deploy from `develop`, rollback, PocketBase, timers, logs, GitHub Actions checks |
