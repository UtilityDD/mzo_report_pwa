# Working on MZO Reports

Rules for anyone changing this repo, human or AI agent. Read this first, then the doc for the area you touch (index in [README.md](README.md#documentation)).

## Never

- **Write to production while testing.** Local dev uses the production Supabase project, Google Sheets and Apps Script web apps. Do not save, upload, sync, allot, cancel, approve, delete or post follow-ups from localhost, and do not run `scripts/sync`, `scripts/migrate` or SQL without the owner's go-ahead. That includes GET requests with a write `action`.
- **Commit secrets.** `.env` and `data/supabase_config.json` are git-ignored; keep keys (Supabase service role, Anthropic, session secret) in env vars. Never put a key in HTML or client JS.
- **Rename or move a served page.** URLs are bookmarked, shared and linked from Ask; deleting or moving one breaks them. If a page must move, leave a redirect (see `/performance_index` in `vercel.json` and `server.js`).
- **Send report data through Vercel.** Register the published CSV in `mzo_data_hub.js` `DATASETS` and let the browser fetch it. Only login, admin and tiny `/api/.../meta` JSON go through the server.
- **Add a framework, build step or CSS library.** Pages are plain HTML/JS on the UI kit.
- **Add per-page office preferences.** Office scope comes from the login only (`mzo_scope.js`).

## Always

- **Scope rows** with `MzoScope.filterRows(rows)` right after parsing. Office lists, counts and links must never show offices outside the user's scope.
- **Use the kit** for new or rebuilt pages: `<html class="ui">`, `mzo_theme.css`, `mzo_ui.js` (`UI.load`, `UI.table`, `UI.facet`, `UI.sidePanel`, `UI.drill`, `UI.offices`, `UI.refresh`, `UI.drawer`, …). Follow the page structure in [docs/design-system.md](docs/design-system.md): left filter panel, stat strip, one Detailed report table.
- **Keep line endings** the file already uses (some are CRLF).
- **Ship cache changes together:** when users must receive changed HTML/CSS/JS, bump `CACHE_NAME` in `sw.js` and `version` + `message` in `version.json`, and add new page paths to `isNetworkFirstPath` in `sw.js`. A new folder also needs a static build entry in `vercel.json`.
- **Bump `?v=` on a shared file** (`mzo_ui.js`, `mzo_theme.css`, `mzo_scope.js`, `mzo_data_hub.js`) in every page that loads it when its behaviour changes; use one value per file across the repo.
- **Update the docs** in the same change when you add a page, dataset, API, env var, auth flag, scope rule or a pattern others should copy.

## Check your change

There are no automated tests. Before calling something done:

1. `node --check` every JS file you touched (for big inline scripts, extract and check them too).
2. Load each page you touched in a browser, signed in, in light and dark, at desktop width and at phone width (~390px), inside `app.html` and on its own. The console must show no new errors.
3. For filters and drill-downs, click through them and confirm the counts match the unfiltered totals.
4. For server changes, restart `npm run dev` and exercise the read-only endpoints you changed.

Login-gated pages cannot be checked with an anonymous `curl` of the HTML.

## Commits and releases

Small, focused commits with a plain description of what changed and why. Production deploys from `main` on the `smartlinemanapp/mzo-reports` remote; see [docs/deploy.md](docs/deploy.md).
