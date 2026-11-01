# Deploy

GitHub remotes, the production URL and how a change reaches users.

## Git remotes and production

Two GitHub remotes, **one** production URL. Keep both GitHub copies on the same `main` commit. Do not deploy to the old Dipankar project.

| Remote | URL | Role |
|--------|-----|------|
| `origin` | https://github.com/UtilityDD/mzo_report_pwa.git | Mirror / backup |
| `smartlineman` | https://github.com/smartlinemanapp/mzo-reports.git | Source for Vercel (Git connected) |

On a new machine:

```
git remote add origin https://github.com/UtilityDD/mzo_report_pwa.git
git remote add smartlineman https://github.com/smartlinemanapp/mzo-reports.git
```

**Production (users and PWA):** https://mzo-reports.vercel.app  
Vercel project: [smart-linemans-projects/mzo-reports](https://vercel.com/smart-linemans-projects/mzo-reports). Unique hostnames such as `mzo-reports-xxxx.vercel.app` are the same deployment — do not share them and do not delete that deployment.

**Retired:** https://mzo-report-pwa.vercel.app (Dipankar / `mzo-report-pwa`). Do **not** auto-redirect that host and do **not** allow login there. `mzo_origin_redirect.js` (login, home, and via `auth.js` on report pages) freezes the page with the new URL, a **Copy** button, and steps to open https://mzo-reports.vercel.app/login.html in Chrome/Safari and tap **Install app**. The new origin uses a **gold MZO icon** (`icons/icon-*-v2.png` + `manifest.json`); the retired host keeps the navy icon (`manifest-legacy.json`, chosen by `mzo_pwa_icons.js`) so both can sit on a home screen. The freeze is a no-op on the new origin. Do not add a `vercel.json` catch-all redirect. After changing the freeze, deploy **once** to the old project (`npx vercel --prod --yes --scope dipankar-das-projects-1592747b`) if it is not Git-connected. Then leave that project idle.

## Deploy

There is no webpack/vite build. Local run is `npm run dev`. Production is **only** https://mzo-reports.vercel.app

1. Leave one-off analysis scripts and dataset dumps untracked. Do not commit `.env`, `consumer/*.csv`, or root CSVs such as `bharatnet.csv`.
2. Bump `CACHE_NAME` in `sw.js` and `version` + `message` in `version.json` when users must receive HTML/JS changes.
3. Commit product files, then push **both** remotes so GitHub stays in sync:
   ```
   git push origin main
   git push smartlineman main
   ```
4. Vercel builds from the **smartlineman** GitHub repo. After the `smartlineman` push, confirm the change on https://mzo-reports.vercel.app (login-gated pages need a real portal user). A unique `mzo-reports-….vercel.app` URL is not the public link.
5. Manual CLI only if the Git deploy did not run, and only while logged into the **Smart Lineman** Vercel team: `npx vercel --prod --yes --scope smart-linemans-projects`. `npx vercel --prod --yes` without that scope can hit the wrong account or return Not authorized. Environment variables live on the Smart Lineman Vercel project (table below); the retired Dipankar project had none.

## Environment variables

Set on Vercel (Smart Lineman project); locally in the git-ignored `.env`. `server.js` has a fallback for most sheet and script URLs, so only the secrets are required.

| Variable | Used for |
|---|---|
| `JWT_SECRET` | Signs the session cookie. Required in production (the server logs a warning on Vercel when it is missing) |
| `GOOGLE_CLIENT_ID` | Audience check for Google sign-in; without it `/api/auth/google` returns 503 |
| `ANTHROPIC_API_KEY` | Ask (`/api/assistant`); without it Ask says it is not configured |
| `SUPABASE_URL`, `SUPABASE_KEY` / `SUPABASE_ANON_KEY` | Old project: login (until `INSIGHT_LIVE`), activity logs |
| `POWERMAP_SUPABASE_URL`, `POWERMAP_SUPABASE_KEY` | Power Map tables (default to the old project) |
| `INSIGHT_SUPABASE_URL`, `INSIGHT_SUPABASE_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | New insight project: stock Storage, allotments, report snapshots |
| `INSIGHT_LIVE` | `1` moves login to the insight project. Leave unset until `npm run copy:insight` has run |
| `STOCK_USE_STORAGE`, `STOCK_STORAGE_BUCKET`, `STOCK_STORAGE_OBJECT` | Stock dump in Supabase Storage instead of the Google Sheet |
| `REPORTS_STORAGE_BUCKET` | Bucket for the synced report snapshots (disconnection, defective, pending MC, load extension) |
| `*_SCRIPT_URL` (`NSC_SHEET`, `NSC_WITHHELD_SHEET`, `NSC_FOLLOWUP`, `STOCK_SHEET`, `STOCK_ALLOTMENT`, `DEFECTIVE_SHEET`, `DISCONNECTION_FOLLOWUP`, `METADATA`) | Apps Script web apps, see [apps-script.md](apps-script.md) |
| `*_CSV_URL` (`DISCONNECTION_SHEET`, `PENDING_MC_SHEET`, `LOAD_EXT_SHEET`, `DEFECTIVE_SUMMARY`, `DEFECTIVE_DETAILS`, `STOCK_ALLOTMENTS`) | Override the published sheet a sync job or the allotment list reads |
| `PORT` | Local port (default 3000) |

