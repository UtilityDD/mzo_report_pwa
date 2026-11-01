# The VM

A small Oracle Cloud VM runs a second copy of the app and the data mirror (PocketBase plus the admin portal). It deploys `develop` by itself: a push reaches it within about a minute, and GitHub Actions reports whether it did. Production for users is still https://mzo-reports.vercel.app ([deploy.md](deploy.md)).

> The app on the VM talks to the **production** Supabase project and Google Sheets, exactly like a local `npm run dev`. Do not sign in and save, upload or sync anything there while testing; health checks are GET requests only.

## URLs

| URL | Serves |
|---|---|
| https://130.210.43.11.sslip.io | The app (Caddy → `node server.js` on 127.0.0.1:3000). `http://130.210.43.11` redirects here |
| https://130.210.43.11.sslip.io/deploy.json | The deploy record (below); no cache, CORS `*` |
| https://data.130.210.43.11.sslip.io | Admin portal: static files from `vm/portal/` of the live release |
| https://data.130.210.43.11.sslip.io/api/, `/_/` | PocketBase API and dashboard (127.0.0.1:8090) |
| https://data.130.210.43.11.sslip.io/kit/ | Only `mzo_theme.css`, `mzo_theme.js` and `mzo_ui.js` from the app, so the portal uses the same UI kit |

Certificates are issued by Let's Encrypt automatically (sslip.io names resolve to the IP in them). The data site returns 404 for `/dev`, `*.md` and dot-files, and serves the portal with a strict CSP; PocketBase's own headers are left alone. Only ports 22, 80 and 443 are open in firewalld.

## Layout on the VM

| Path | What |
|---|---|
| `/opt/mzo/releases/<sha>/` | One folder per deployed commit (GitHub tarball, owned by `opc`). The newest four plus the live and previous ones are kept |
| `/opt/mzo/app` | Symlink to the live release. Services, Caddy and PocketBase use this path |
| `/opt/mzo/deps/<app\|sync>-<hash>/node_modules` | Packages, one set per `package.json` + `package-lock.json` pair; each release's `node_modules` (and `vm/sync/node_modules`) links to its set |
| `/opt/mzo/state/deployed.json` | The deploy record, served as `/deploy.json` |
| `/opt/mzo/bin/deploy.sh` | The pinned deploy script the timer runs (`deploy.sh.prev` is the one before) |
| `/opt/mzo/pocketbase/` | `pocketbase` binary (root-owned) and `pb_data/` (user `pocketbase`) |
| `/opt/mzo/backup/` | Pre-provision tarball of the old 2.67 copy, old Caddyfiles, provision logs (root only) |
| `/etc/mzo/` | Credentials and env files (below) |
| `/home/opc/mzo-reports` | Symlink to `/opt/mzo/app`; the old hand-copied 2.67 app is in `/home/opc/mzo-reports.old-2.67` |

In the repo, `vm/` holds everything the VM runs; none of it is served by Vercel or `server.js`.

| Repo path | What |
|---|---|
| `vm/deploy/provision.sh` | One-time (and repeatable) setup, run as root |
| `vm/deploy/deploy.sh` | The deploy (copied to `/opt/mzo/bin/deploy.sh`) |
| `vm/deploy/pb-setup.sh` | PocketBase superuser, settings and the portal admin account |
| `vm/deploy/Caddyfile` | Both sites |
| `vm/deploy/systemd/` | Units, timers and drop-ins, installed into `/etc/systemd/system/` |
| `vm/sync/`, `vm/pocketbase/`, `vm/portal/` | Data mirror sync, PocketBase version and migrations, admin portal ([data-mirror.md](data-mirror.md)) |

## Services and timers

| Unit | Does |
|---|---|
| `mzo-reports.service` | The app, as `opc`, from `/opt/mzo/app`, env from `/etc/mzo/app.env` |
| `pocketbase.service` | `pocketbase serve --http=127.0.0.1:8090`, data in `/opt/mzo/pocketbase/pb_data`, migrations from `/opt/mzo/app/vm/pocketbase/pb_migrations` (applied at start), `--automigrate=false` so dashboard or API schema changes never write migration files |
| `mzo-deploy.timer` → `mzo-deploy.service` | Runs `/opt/mzo/bin/deploy.sh` 60 s after the previous run finished |
| `mzo-sync.timer` → `mzo-sync.service` | Every 15 min: `node vm/sync/run.js --due` as `opc` with `/etc/mzo/pocketbase.env`. Skipped (condition not met, not failed) while `vm/sync/run.js` is not deployed |

## How a deploy works

Every 60 s `deploy.sh`:

1. Reads the head of `develop` from GitHub's git ref list (`https://github.com/smartlinemanapp/mzo-reports.git/info/refs?service=git-upload-pack`; not rate-limited like the API). Nothing new: it exits quietly.
2. Downloads `https://codeload.github.com/smartlinemanapp/mzo-reports/tar.gz/<sha>` into `/opt/mzo/releases/<sha>`.
3. Links packages: `npm ci --omit=dev` runs only for a `package.json` + `package-lock.json` pair it has not seen (the app's, and `vm/sync/`'s). Runtime files the app wrote under `data/` are copied from the previous release.
4. Points `/opt/mzo/app` at the new release, installs changed units and drop-ins from `vm/deploy/systemd/` (after `systemd-analyze verify`) with a `daemon-reload`, and restarts the app. Caddy retries the upstream for up to 10 s, so the ~2 s restart shows as a short wait, not an error.
5. Health check: `http://127.0.0.1:3000/login.html` and `/app.html` must both answer 200, twice in a row, within 40 s.
6. Healthy: applies a changed `vm/deploy/Caddyfile` (only after `caddy validate`; a failed reload restores the old file), restarts PocketBase if its unit or `vm/pocketbase/pb_migrations` changed, creates the portal admin once its collection exists, refreshes the pinned `deploy.sh`, writes `status: ok` and prunes old releases.
7. Unhealthy: points the symlink back to the previous release, restores its units, restarts and checks again. The record says `rolled_back` with `failedCommit`; that commit is not retried until a newer one arrives or someone runs `--force`.

Runs never overlap (`flock` on `/run/lock/mzo-deploy.lock`). A failed download is retried next round.

### deploy.json

```json
{ "commit": "<sha now serving>", "branch": "develop", "deployedAt": "2026-11-01T06:21:25Z",
  "status": "ok", "previous": "<sha before>", "failedCommit": null, "target": null,
  "version": "2.71", "warnings": [] }
```

`status`: `ok`, `deploying` (`target` is the commit on its way), `rolled_back` (`failedCommit` failed and `commit` is serving), or `failed` (even the rollback is unhealthy: look now). `warnings` lists things that did not stop the deploy, such as a Caddyfile that did not validate.

### Why a pinned deploy.sh

The timer never runs `deploy.sh` straight from the release it is deploying. It runs `/opt/mzo/bin/deploy.sh`, which is replaced only after a deploy that passed its health check, and only if the new file passes `bash -n` and its own `--self-test`. A `deploy.sh` with a syntax error on develop therefore never runs; the app still deploys with the old script and `deploy.json` carries a warning. A script that parses but misbehaves can still be pinned: then put the previous copy back (`sudo cp /opt/mzo/bin/deploy.sh.prev /opt/mzo/bin/deploy.sh`) or re-run `provision.sh` from a good checkout.

### By hand

```bash
sudo /opt/mzo/bin/deploy.sh               # same as the timer
sudo /opt/mzo/bin/deploy.sh --force       # redeploy the head, even a commit marked failed
sudo /opt/mzo/bin/deploy.sh --to <sha>    # deploy one exact commit (full sha; the timer moves back to the head next round)
sudo /opt/mzo/bin/deploy.sh --rollback    # back to the previous release; holds the current commit until a newer one
sudo MZO_DEPLOY_TEST_FAIL=1 /opt/mzo/bin/deploy.sh --force   # rollback drill: the health check is reported as failed
```

Stop the timer (`sudo systemctl stop mzo-deploy.timer`) before a `--to` drill and start it again afterwards. Do not edit files under `/opt/mzo/app`; the next release replaces them. A unit deleted from `vm/deploy/systemd/` is not removed from the VM; disable and delete it by hand.

## Credentials (paths only)

| File | Holds | Mode |
|---|---|---|
| `/etc/mzo/app.env` | `JWT_SECRET` for the app's session cookies (random, generated once by provisioning; sessions on the VM are not valid on Vercel or locally) | 640 root:opc |
| `/etc/mzo/pocketbase.env` | `PB_URL`, `PB_SUPERUSER_EMAIL`, `PB_SUPERUSER_PASSWORD` (the PocketBase dashboard login) | 640 root:opc |
| `/etc/mzo/portal-admin.txt` | The first portal account (`portal_users_auth`), created once the portal migrations are deployed | 600 root |
| `/etc/mzo/deploy.env` | Optional, e.g. `MZO_BRANCH=develop` | |

SSH: `ssh -i ssh-key-2026-11-01.key opc@130.210.43.11` (the key is not in the repo).

PocketBase settings set by `pb-setup.sh`: batch API on, client IP from Caddy's `X-Forwarded-For`, rate limits on with 127.0.0.1 exempt (the sync talks to it directly), app URL `https://data.130.210.43.11.sslip.io`. Batch size, timeouts and log retention come from the settings migration in `vm/pocketbase/pb_migrations/`.

## VM-only admin accounts

Admin accounts that exist only on the VM: never in Supabase, never on Vercel. They are listed in `MZO_LOCAL_ADMINS` in `/etc/mzo/app.env`, which holds password hashes only (systemd reads the file as root, so `chmod 600` is enough). One entry per account, separated by `;`:

```
username|Display Name|scrypt$N$r$p$saltBase64$hashBase64
```

How they behave (`lib/local_admins.js`, tests in `vm/dev/test-local-admin.js`):

- Sign in on the normal page with the username and the password in the PIN field. The username is case-insensitive.
- Such a username is checked against its hash only, never against Supabase. A Supabase user with the same name cannot sign in on the VM, so pick a username that is not in `portal_users`.
- The session carries the full admin profile (the same fields as the Google root admin) with `auth_provider: 'local'`. Session checks and permission checks never look it up in Supabase, so it is never demoted.
- Five failed attempts for one username, or from one client IP, lock that username or IP for a minute. A locked attempt gets the ordinary "Invalid Username or PIN." answer; the journal records each failure and lockout (`journalctl -u mzo-reports | grep 'Local admin'`).
- Its activity (sign-in, admin actions) goes to the journal (`grep Activity`), not to Supabase's activity log. What the admin changes (users, Power Map, uploads, syncs) still goes to production, like any admin's changes.
- Changing or removing an entry ends that account's open sessions once the app restarts.

**Add an account.** Hash the password (typed twice, never shown, never on the command line), add the entry, restart:

```bash
node /opt/mzo/app/scripts/tools/hash-password.js roumak "Roumak Das"   # or from a local checkout
# → roumak|Roumak Das|scrypt$32768$8$1$…
sudo vi /etc/mzo/app.env
#   MZO_LOCAL_ADMINS='roumak|Roumak Das|scrypt$32768$8$1$…'
#   (several: 'entry1;entry2'; keep the single quotes so nothing in the hash is expanded)
sudo systemctl restart mzo-reports
journalctl -u mzo-reports -n 30 | grep 'Local admin'   # "1 VM-only admin account(s): roumak"
```

A malformed entry is skipped with a warning that names its position, never its contents. The helper refuses passwords shorter than 10 characters or starting or ending with a space (the sign-in page trims what is typed).

**Change a password.** Run the helper again for the same username, replace that entry in `/etc/mzo/app.env`, and run `sudo systemctl restart mzo-reports`. Sessions signed in with the old password end.

**Remove an account.** Delete its entry (or the whole `MZO_LOCAL_ADMINS` line), then `sudo systemctl restart mzo-reports`. Its sessions end. With the variable unset the app behaves exactly as on Vercel.

## Logs

```bash
journalctl -u mzo-deploy -u mzo-reports -u pocketbase -u mzo-sync -f
journalctl -t mzo-deploy          # also includes deploy.sh runs started by hand
cat /opt/mzo/state/deployed.json
systemctl list-timers 'mzo-*'
```

## Memory

The VM has 1 GB of RAM and about 3.4 GB of swap. On 2026-11-01 a `dnf install` used up all of it and froze the VM until a reboot, so:

- Nothing on the VM uses dnf: deploys use GitHub tarballs instead of git, and `provision.sh` stops if a tool is missing rather than installing it.
- Performance Co-Pilot (`pmcd`, `pmlogger`, `pmie`, the `*_farm` services and their timers) is stopped and disabled: about 60 MB. `provision.sh --keep-pcp` leaves it alone.
- kdump is disabled and `crashkernel=` is removed from the boot entries, `/etc/default/grub` and `/etc/kernel/cmdline` (`auto_reset_crashkernel no`): it reserved 448 MB at boot.
- OOM order: sshd, Caddy and the app `OOMScoreAdjust=-500` (drop-ins in `vm/deploy/systemd/*.service.d/`); PocketBase `MemoryMax=200M`, `GOMEMLIMIT=150MiB`, `OOMScoreAdjust=100`; deploy `MemoryMax=350M`; the sync `MemoryMax=220M`, node heap 150 MB, `OOMScoreAdjust=500`, `Nice=10`, so it is the first thing to go.
- Swap: `/swapfile` (2 GB), `/.swapfile` (0.5 GB) and `/swapfile2` (about 0.85 GB, added by provisioning).

## Re-provision

`provision.sh` is idempotent and uses the files next to it, so re-running it repairs units, the Caddyfile, the pinned deploy script, PocketBase settings and the firewall without touching credentials that exist:

```bash
sudo bash /opt/mzo/app/vm/deploy/provision.sh
```

For a new VM, copy `vm/deploy/` (and `vm/pocketbase/VERSION`) over and run it from there. It needs `curl`, `jq`, `unzip`, `openssl`, `tar`, Node 22 at `/usr/local/bin` and Caddy at `/usr/local/bin/caddy`. PocketBase comes from GitHub releases at the version in `vm/pocketbase/VERSION` (default 0.40.6), checked against `checksums.txt`; an upgrade backs up `pb_data` first.

## GitHub Actions

| Workflow | Runs on | Checks |
|---|---|---|
| `.github/workflows/ci.yml` | push and PR to `develop` and `main` | `node scripts/tools/check_syntax.js` (`node --check` on every JS file and inline `<script>`, JSON parse), `vercel.json` / `version.json` / `manifest.json` parse, `sw.js` `CACHE_NAME` equals `version.json` `cache`, `bash -n` on `vm/deploy/*.sh` |
| `.github/workflows/vm-deploy.yml` | push to `develop` (smartlinemanapp repo only) | Polls `/deploy.json` for up to 5 min until `commit` is this push and `status` is `ok`; fails at once if the VM rolled the commit back. A newer push cancels the older check |

Actions never connect to the VM; the VM pulls. Run the syntax check locally with `node scripts/tools/check_syntax.js`. Pushing a change under `.github/workflows/` needs a GitHub token with the `workflow` scope.
