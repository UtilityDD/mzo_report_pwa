#!/usr/bin/env bash
# MZO VM deploy. mzo-deploy.timer runs the pinned copy /opt/mzo/bin/deploy.sh as root every 60 s.
#
#   deploy.sh              deploy the head of develop if it is new (the timer run)
#   deploy.sh --force      redeploy the head even if it is current or was marked failed
#   deploy.sh --to SHA     deploy one exact commit (full 40-character sha)
#   deploy.sh --rollback   go back to the previous release and hold the current commit
#   deploy.sh --self-test  check that this copy can run on this machine; prints "ok"
#
# No git on the VM (dnf does not fit in 500 MB). The head commit comes from GitHub's smart-HTTP
# ref list, the code from a codeload tarball, unpacked into /opt/mzo/releases/<sha>.
# /opt/mzo/app is a symlink to the live release, so a rollback is: repoint it and restart.
# node_modules are shared per lock file in /opt/mzo/deps/<app|sync>-<hash> (npm ci runs only
# for a new package.json + package-lock.json pair).
#
# New commit: unpack, link packages, switch the symlink, install changed systemd units, restart
# the app, health-check it, and switch back on failure. After a good deploy: apply a changed
# Caddyfile (after caddy validate), restart PocketBase when its migrations changed, start or restart
# the stats sampler (vm/stats), refresh the pinned copy of this script, and prune old releases.
# The result goes to /opt/mzo/state/deployed.json, served as /deploy.json.
#
# Optional env (/etc/mzo/deploy.env or the command line):
#   MZO_BRANCH=develop        branch to follow
#   MZO_DEPLOY_TEST_FAIL=1    rollback drill: the new commit's health check is reported as failed
set -uo pipefail
umask 022

REPO=smartlinemanapp/mzo-reports
MZO=/opt/mzo
APP_LINK=$MZO/app
RELEASES=$MZO/releases
DEPS=$MZO/deps
STATE=$MZO/state
RECORD=$STATE/deployed.json
BIN_DIR=$MZO/bin
BACKUP_DIR=$MZO/backup
KEEP_RELEASES=4
APP_USER=opc
APP_UNIT=mzo-reports.service
UNIT_DIR=/etc/systemd/system
CADDY=/usr/local/bin/caddy
CADDYFILE=/etc/caddy/Caddyfile
LOCK=/run/lock/mzo-deploy.lock
HEALTH_URLS=(http://127.0.0.1:3000/login.html http://127.0.0.1:3000/app.html)
PB_HEALTH=http://127.0.0.1:8090/api/health
PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin
export PATH

if [ -z "${MZO_BRANCH:-}" ] && [ -r /etc/mzo/deploy.env ]; then
  MZO_BRANCH=$(sed -n 's/^MZO_BRANCH=//p' /etc/mzo/deploy.env | tail -n 1)
fi
BRANCH=${MZO_BRANCH:-develop}
TEST_FAIL=${MZO_DEPLOY_TEST_FAIL:-0}
WARN=()
PB_UNIT_CHANGED=0
STATS_UNIT_CHANGED=0

log() {
  echo "$*"
  # Manual runs also reach the journal (journalctl -t mzo-deploy); timer runs already do.
  if [ -z "${INVOCATION_ID:-}" ]; then logger -t mzo-deploy -- "$*" 2>/dev/null || true; fi
}
warn() { WARN+=("$*"); log "warning: $*"; }
short() { printf '%s' "${1:0:7}"; }
as_app() { runuser -u "$APP_USER" -- env HOME="/home/$APP_USER" PATH="$PATH" "$@"; }
rel() { printf '%s/%s' "$RELEASES" "$1"; }
current() { local t; t=$(readlink "$APP_LINK" 2>/dev/null) && basename "$t"; }
rec_get() { jq -r --arg k "$1" '.[$k] // empty' "$RECORD" 2>/dev/null || true; }

remote_head() { # sha of refs/heads/$BRANCH from the smart-HTTP ref list (no API rate limit)
  curl -fsS --max-time 30 "https://github.com/$REPO.git/info/refs?service=git-upload-pack" |
    grep -ao "[0-9a-f]\{40\} refs/heads/$BRANCH\$" | head -n 1 | cut -d' ' -f1
}

# changed FROM TO PATH: true when PATH differs between two releases (or FROM is unknown).
changed() {
  local a b
  b=$(rel "$2")/$3
  [ -n "$1" ] || { [ -e "$b" ]; return; }
  a=$(rel "$1")/$3
  [ -e "$a" ] || [ -e "$b" ] || return 1
  ! diff -rq "$a" "$b" >/dev/null 2>&1
}

# write_record STATUS COMMIT PREVIOUS [FAILED] [TARGET]
write_record() {
  local status=$1 commit=$2 previous=$3 failed=${4:-} target=${5:-} version='' warnings tmp
  [ -n "$commit" ] && version=$(jq -r '.version // empty' "$(rel "$commit")/version.json" 2>/dev/null || true)
  if [ ${#WARN[@]} -gt 0 ]; then
    warnings=$(printf '%s\n' "${WARN[@]}" | jq -R . | jq -s -c .)
  else
    warnings='[]'
  fi
  install -d -m 755 "$STATE"
  tmp=$(mktemp "$STATE/.deployed.json.XXXXXX") || return 1
  jq -n \
    --arg commit "$commit" --arg branch "$BRANCH" --arg status "$status" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg previous "$previous" \
    --arg failed "$failed" --arg target "$target" --arg version "$version" \
    --argjson warnings "$warnings" '
    def nz: if . == "" then null else . end;
    {commit: ($commit | nz), branch: $branch, deployedAt: $at, status: $status,
     previous: ($previous | nz), failedCommit: ($failed | nz), target: ($target | nz),
     version: ($version | nz), warnings: $warnings}' >"$tmp" &&
    chmod 644 "$tmp" && mv -f "$tmp" "$RECORD"
}

self_test() {
  local c
  for c in curl jq tar gzip diff flock runuser systemctl systemd-analyze install cmp mktemp \
    logger sha256sum readlink "$CADDY"; do
    command -v "$c" >/dev/null 2>&1 || { echo "missing command: $c" >&2; return 1; }
  done
  id "$APP_USER" >/dev/null 2>&1 || { echo "no user $APP_USER" >&2; return 1; }
  [ -d "$RELEASES" ] && [ -d "$DEPS" ] || { echo "missing $RELEASES or $DEPS; run provision.sh" >&2; return 1; }
  echo ok
}

health() { # health [FORCE_FAIL]: two good rounds in a row within ~40 s
  local i url='' code='' good=0
  for i in $(seq 1 40); do
    code=''
    if systemctl is-active -q "$APP_UNIT"; then
      for url in "${HEALTH_URLS[@]}"; do
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null)
        [ "$code" = 200 ] || break
      done
    fi
    if [ "$code" = 200 ]; then
      good=$((good + 1))
      if [ "$good" -ge 2 ]; then
        if [ "${1:-0}" = 1 ]; then
          log "health check passed, but MZO_DEPLOY_TEST_FAIL=1 reports it as failed (rollback drill)"
          return 1
        fi
        return 0
      fi
    else
      good=0
    fi
    sleep 1
  done
  log "health check failed: ${url:-$APP_UNIT} answered ${code:-nothing}"
  return 1
}

fetch_release() { # unpack the commit's tarball into releases/<sha> (atomic: .tmp then rename)
  local sha=$1 dir tmp
  dir=$(rel "$sha")
  [ -d "$dir" ] && return 0
  tmp=$dir.tmp
  rm -rf "$tmp"
  install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$tmp"
  log "downloading $(short "$sha")"
  if ! curl -fsSL --max-time 300 "https://codeload.github.com/$REPO/tar.gz/$sha" |
      as_app tar -xzf - -C "$tmp" --strip-components=1 --no-same-owner; then
    rm -rf "$tmp"
    return 1
  fi
  if [ ! -f "$tmp/server.js" ] || [ ! -f "$tmp/package.json" ]; then
    rm -rf "$tmp"
    return 2
  fi
  mv "$tmp" "$dir"
}

link_deps() { # link_deps SHA SUBDIR NAME: node_modules -> deps/NAME-<hash of package.json + lock>
  local dir=$(rel "$1")${2:+/$2} name=$3 hash target
  [ -f "$dir/package.json" ] || return 0
  if [ ! -f "$dir/package-lock.json" ]; then
    warn "${2:-.}/package.json has no package-lock.json, so its packages were not installed"
    return 0
  fi
  hash=$(cat "$dir/package.json" "$dir/package-lock.json" | sha256sum | cut -c1-16)
  target=$DEPS/$name-$hash
  if [ ! -d "$target/node_modules" ]; then
    log "npm ci --omit=dev (${2:-app})"
    rm -rf "$target.tmp"
    install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$target.tmp"
    as_app cp "$dir/package.json" "$dir/package-lock.json" "$target.tmp/" &&
      as_app env -C "$target.tmp" npm ci --omit=dev --no-audit --no-fund --loglevel=error || {
        rm -rf "$target.tmp"
        return 1
      }
    mv "$target.tmp" "$target"
  fi
  rm -rf "$dir/node_modules"
  as_app ln -s "$target/node_modules" "$dir/node_modules"
}

prepare() { # prepare FROM TO: packages and runtime data for a fresh release
  link_deps "$2" '' app || return 1
  link_deps "$2" vm/sync sync || return 1
  # Files the app writes at run time under data/ (activity log cache, upload meta) carry over.
  if [ -n "$1" ] && [ "$1" != "$2" ] && [ -d "$(rel "$1")/data" ]; then
    as_app mkdir -p "$(rel "$2")/data"
    as_app cp -an "$(rel "$1")/data/." "$(rel "$2")/data/" 2>/dev/null || true
  fi
}

switch_to() { # point /opt/mzo/app at a release, atomically
  ln -sfn "$(rel "$1")" "$APP_LINK.new" && mv -Tf "$APP_LINK.new" "$APP_LINK"
}

apply_units() { # apply_units SHA: install the release's changed unit files and drop-ins
  local src f name list=()
  src=$(rel "$1")/vm/deploy/systemd
  [ -d "$src" ] || return 0
  for f in "$src"/*.service "$src"/*.timer "$src"/*.service.d/*.conf; do
    [ -f "$f" ] || continue
    name=${f#"$src"/}
    cmp -s "$f" "$UNIT_DIR/$name" && continue
    if [ "${name%/*}" = "$name" ] && ! systemd-analyze verify "$f" >/dev/null 2>&1; then
      warn "systemd unit $name does not verify; kept the installed one"
      continue
    fi
    install -D -m 644 "$f" "$UNIT_DIR/$name" || return 1
    list+=("$name")
    [ "$name" = pocketbase.service ] && PB_UNIT_CHANGED=1
    [ "$name" = mzo-stats.service ] && STATS_UNIT_CHANGED=1
  done
  if [ ${#list[@]} -gt 0 ]; then
    log "installed units: ${list[*]}"
    systemctl daemon-reload || return 1
  fi
  for f in "$src"/*.timer; do
    [ -f "$f" ] || continue
    name=${f##*/}
    systemctl is-enabled -q "$name" 2>/dev/null || systemctl enable --now "$name" || warn "could not enable $name"
  done
  return 0
}

apply_caddyfile() { # apply_caddyfile SHA
  local src out stamp
  src=$(rel "$1")/vm/deploy/Caddyfile
  [ -f "$src" ] || return 0
  cmp -s "$src" "$CADDYFILE" && return 0
  if ! out=$("$CADDY" validate --config "$src" --adapter caddyfile 2>&1); then
    warn "Caddyfile does not validate; kept the current one"
    printf '%s\n' "$out" | tail -n 5
    return 0
  fi
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  install -m 644 "$CADDYFILE" "$BACKUP_DIR/Caddyfile.$stamp"
  install -m 644 "$src" "$CADDYFILE"
  if systemctl reload caddy.service; then
    log "Caddyfile updated (old copy in $BACKUP_DIR/Caddyfile.$stamp)"
  else
    install -m 644 "$BACKUP_DIR/Caddyfile.$stamp" "$CADDYFILE"
    systemctl reload caddy.service || true
    warn "Caddy reload failed; restored the previous Caddyfile"
  fi
}

after_pocketbase() { # after_pocketbase FROM TO
  local i
  systemctl is-enabled -q pocketbase.service 2>/dev/null || return 0
  if [ "$PB_UNIT_CHANGED" = 1 ] || changed "$1" "$2" vm/pocketbase/pb_migrations; then
    log "restarting PocketBase (unit or migrations changed)"
    systemctl restart pocketbase.service
    for i in $(seq 1 30); do
      curl -fs -o /dev/null --max-time 3 "$PB_HEALTH" && break
      sleep 2
    done
    curl -fs -o /dev/null --max-time 3 "$PB_HEALTH" || { warn "PocketBase is not healthy after restart (journalctl -u pocketbase)"; return 0; }
  fi
  # Accounts that need collections from the migrations (the portal admin) are created once they exist.
  if [ ! -f /etc/mzo/portal-admin.txt ] && [ -f "$(rel "$2")/vm/deploy/pb-setup.sh" ]; then
    bash "$(rel "$2")/vm/deploy/pb-setup.sh" --quiet || warn "pb-setup.sh failed (run it by hand: sudo bash $APP_LINK/vm/deploy/pb-setup.sh)"
  fi
}

after_stats() { # after_stats FROM TO: start the stats sampler once; restart it when its code or unit changed
  [ -f "$UNIT_DIR/mzo-stats.service" ] || return 0
  if ! systemctl is-enabled -q mzo-stats.service 2>/dev/null; then
    if systemctl enable --now mzo-stats.service; then log "started mzo-stats"; else warn "could not start mzo-stats (journalctl -u mzo-stats)"; fi
    return 0
  fi
  if [ "$STATS_UNIT_CHANGED" = 1 ] || changed "$1" "$2" vm/stats/sampler.py; then
    log "restarting mzo-stats (sampler or unit changed)"
    systemctl restart mzo-stats.service || warn "could not restart mzo-stats (journalctl -u mzo-stats)"
  fi
}

pin_self() { # refresh /opt/mzo/bin/deploy.sh from the release, only if it parses and self-tests
  local src dst=$BIN_DIR/deploy.sh out
  src=$(rel "$1")/vm/deploy/deploy.sh
  [ -f "$src" ] || return 0
  cmp -s "$src" "$dst" && return 0
  if ! bash -n "$src" 2>/dev/null; then
    warn "vm/deploy/deploy.sh has a syntax error; kept the pinned copy"
    return 0
  fi
  out=$(bash "$src" --self-test 2>&1 | tail -n 1)
  if [ "$out" != ok ]; then
    warn "vm/deploy/deploy.sh failed --self-test ($out); kept the pinned copy"
    return 0
  fi
  [ -f "$dst" ] && cp -p "$dst" "$dst.prev"
  install -m 755 "$src" "$dst.new" && mv -f "$dst.new" "$dst" && log "pinned the new deploy.sh (old copy: $dst.prev)"
}

prune() { # keep the live and previous releases plus the newest few; drop unused package sets
  local keep=("$@") d n=0 name k used
  for d in $(ls -1dt "$RELEASES"/*/ 2>/dev/null); do
    name=$(basename "$d")
    n=$((n + 1))
    for k in "${keep[@]}"; do [ "$name" = "$k" ] && continue 2; done
    [ "$n" -le "$KEEP_RELEASES" ] && continue
    rm -rf "$d"
  done
  rm -rf "$RELEASES"/*.tmp "$DEPS"/*.tmp
  used=$(readlink "$RELEASES"/*/node_modules "$RELEASES"/*/vm/sync/node_modules 2>/dev/null | xargs -r -n1 dirname | sort -u)
  [ -n "$used" ] || return 0
  for d in "$DEPS"/*/; do
    d=${d%/}
    [ -d "$d" ] || continue
    grep -qxF "$d" <<<"$used" || rm -rf "$d"
  done
}

start_release() { # start_release FROM TO: everything up to a running app on TO
  prepare "$1" "$2" || return 1
  switch_to "$2" || return 1
  apply_units "$2" || return 1
  systemctl restart "$APP_UNIT"
}

deploy() { # deploy CURRENT TARGET
  local cur=$1 target=$2 previous=$1 rc saved
  if [ "$cur" = "$target" ]; then previous=$(rec_get previous); fi
  log "deploying $BRANCH $(short "$target") (live: $(short "${cur:-none}"))"
  saved=$(cat "$RECORD" 2>/dev/null || true)
  write_record deploying "$cur" "$(rec_get previous)" "" "$target"

  fetch_release "$target"
  rc=$?
  if [ "$rc" = 1 ]; then
    log "download of $(short "$target") failed (network?); trying again next round"
    if [ -n "$saved" ]; then printf '%s\n' "$saved" >"$RECORD.tmp" && mv -f "$RECORD.tmp" "$RECORD"; fi
    return 0
  fi
  if [ "$rc" != 0 ]; then
    warn "the tarball of $(short "$target") has no server.js or package.json"
    write_record rolled_back "$cur" "$cur" "$target"
    return 1
  fi

  if start_release "$cur" "$target" && health "$TEST_FAIL"; then
    apply_caddyfile "$target"
    after_pocketbase "$cur" "$target"
    after_stats "$cur" "$target"
    pin_self "$target"
    write_record ok "$target" "$previous"
    prune "$target" "$previous"
    log "deployed $(short "$target")$([ ${#WARN[@]} -gt 0 ] && echo " with ${#WARN[@]} warning(s)")"
    return 0
  fi

  if [ -z "$cur" ] || [ ! -d "$(rel "$cur")" ]; then
    write_record failed "$target" "" "$target"
    log "DEPLOY FAILED: $(short "$target") is not healthy and there is no earlier release to go back to"
    return 1
  fi
  log "deploy of $(short "$target") failed; rolling back to $(short "$cur")"
  if start_release "$target" "$cur" && health 0; then
    write_record rolled_back "$cur" "$cur" "$target"
    log "rolled back to $(short "$cur"); $(short "$target") is skipped until a newer commit or --force"
  else
    write_record failed "$cur" "$cur" "$target"
    log "ROLLBACK FAILED: the app is not healthy on $(short "$cur"); check journalctl -u $APP_UNIT"
  fi
  return 1
}

rollback() { # manual: back to the previous release, and hold the current commit
  local cur prev
  cur=$(current)
  prev=$(rec_get previous)
  [ -n "$prev" ] && [ "$prev" != "$cur" ] && [ -d "$(rel "$prev")" ] ||
    { log "no previous release to roll back to"; return 1; }
  log "manual rollback from $(short "$cur") to $(short "$prev")"
  if start_release "$cur" "$prev" && health 0; then
    write_record rolled_back "$prev" "$prev" "$cur"
    log "rolled back to $(short "$prev"); $(short "$cur") is held until a newer commit or --force"
    return 0
  fi
  log "the previous release is not healthy either; redeploying $(short "$cur")"
  start_release "$prev" "$cur" && health 0 && write_record ok "$cur" "$prev"
  return 1
}

main() {
  local mode=auto to='' cur head
  case "${1:-}" in
    --self-test) self_test; return ;;
    --force) mode=force ;;
    --rollback) mode=rollback ;;
    --to)
      mode=to
      to=${2:-}
      [[ "$to" =~ ^[0-9a-f]{40}$ ]] || { echo "--to needs a full 40-character commit sha" >&2; return 2; }
      ;;
    '') ;;
    *) echo "usage: deploy.sh [--force | --to SHA | --rollback | --self-test]" >&2; return 2 ;;
  esac
  [ "$(id -u)" = 0 ] || { echo "run as root" >&2; return 1; }
  install -d -m 755 "$RELEASES" "$DEPS" "$STATE"

  exec 9>"$LOCK"
  if ! flock -n 9; then
    log "another deploy is still running; skipping this round"
    return 0
  fi

  cur=$(current)
  if [ "$mode" = rollback ]; then rollback; return; fi
  if [ "$mode" = to ]; then deploy "$cur" "$to"; return; fi

  head=$(remote_head)
  if [ -z "$head" ]; then
    log "could not read the $BRANCH head from GitHub (network?); trying again next round"
    return 0
  fi
  if [ "$mode" = auto ]; then
    if [ "$head" = "$cur" ] && [ "$(rec_get commit)" = "$cur" ]; then return 0; fi
    if [ "$head" = "$(rec_get failedCommit)" ]; then return 0; fi
  fi
  deploy "$cur" "$head"
}

main "$@"
