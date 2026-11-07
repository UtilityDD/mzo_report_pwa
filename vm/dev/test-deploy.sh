#!/usr/bin/env bash
# Offline test of vm/deploy/deploy.sh: deploys, the health check, rollbacks (app, PocketBase migration,
# pb_data restore), the MZO_DEPLOY_TEST_FAIL drill, a manual --rollback and npm retries.
#
#   bash vm/dev/test-deploy.sh
#
# deploy.sh is sourced (its main does not run), every path points into a temp folder, and systemctl,
# curl, runuser, flock and friends are shell functions that play the app and PocketBase:
#   - the app is healthy unless the live release's server.js says BROKEN (pages answer 500), NODATA
#     (/api/data/manifest answers 404) or FLAKY (it dies a moment after it starts);
#   - PocketBase "applies" the live release's migrations at start and fails on one that says BAD;
#     CORRUPT also damages pb_data, so it then fails on any release until pb_data is restored.
# Needs bash, jq and the usual coreutils (macOS or Linux); no root, no network. Exit 1 on any failure.
# Variables below are read by the sourced deploy.sh.
# shellcheck disable=SC2034
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/mzo-deploy-test.XXXXXX")
trap 'rm -rf "$T"' EXIT

# shellcheck source=../deploy/deploy.sh
source "$HERE/../deploy/deploy.sh"
set +e

MZO=$T/opt
APP_LINK=$MZO/app
RELEASES=$MZO/releases
DEPS=$MZO/deps
STATE=$MZO/state
RECORD=$STATE/deployed.json
BIN_DIR=$MZO/bin
BACKUP_DIR=$MZO/backup
PB_DATA=$MZO/pocketbase/pb_data
PB_BACKUP=$BACKUP_DIR/pb_data.pre-deploy
PB_ENV=$T/no-pocketbase.env
UNIT_DIR=$T/units
LOCK=$T/deploy.lock
JOURNALD_DROPIN=$T/journald.conf.d/mzo.conf
JOURNAL_DIR=$T/journal
APP_USER=$(id -un)
KEEP_RELEASES=100 # prune would remove the fixture releases
RUN=$T/run
CALLS=$T/calls
mkdir -p "$RELEASES" "$DEPS" "$STATE" "$BIN_DIR" "$BACKUP_DIR" "$PB_DATA" "$UNIT_DIR" "$RUN"

# ---- stubs ---------------------------------------------------------------------------------------
log() { echo "    | $*" >>"$T/log"; }
sleep() { :; }
logger() { :; }
flock() { :; }
systemd-analyze() { :; }
runuser() { while [ "$1" != -- ]; do shift; done; shift; "$@"; }
switch_to() { rm -f "$APP_LINK" && ln -s "$(rel "$1")" "$APP_LINK"; }
prepare() { [ ! -f "$(rel "$2")/NPMFAIL" ]; }
id() { if [ "${1:-}" = -u ]; then echo 0; else command id "$@"; fi; }
remote_head() { cat "$T/head"; }
install() { # drop -o/-g (no root here); emulate -D (macOS install has none)
  local a=() mk=''
  while [ $# -gt 0 ]; do
    case $1 in -o | -g) shift 2 ;; -D) mk=1; shift ;; *) a+=("$1"); shift ;; esac
  done
  [ -n "$mk" ] && mkdir -p "$(dirname "${a[${#a[@]}-1]}")"
  command install "${a[@]}"
}
live_has() { grep -qs "$1" "$APP_LINK/server.js"; }
start_app() { rm -f "$RUN/app.calls"; touch "$RUN/app"; }
start_pb() {
  rm -f "$RUN/pb"
  [ -f "$PB_DATA/corrupt" ] && return 1
  local f
  for f in "$APP_LINK"/vm/pocketbase/pb_migrations/*.js; do
    [ -f "$f" ] || continue
    if grep -q CORRUPT "$f"; then touch "$PB_DATA/corrupt"; return 1; fi
    grep -q BAD "$f" && return 1
    grep -qxF "${f##*/}" "$PB_DATA/applied" 2>/dev/null || echo "${f##*/}" >>"$PB_DATA/applied"
  done
  touch "$RUN/pb"
}
systemctl() {
  echo "$*" >>"$CALLS"
  local unit=${*: -1}
  case "$1 $unit" in
    "is-active $APP_UNIT") [ -f "$RUN/app" ] ;;
    "is-active $PB_UNIT") [ -f "$RUN/pb" ] ;;
    "is-active "*) return 1 ;;
    "is-enabled "*) return 0 ;;
    "restart $APP_UNIT") start_app ;;
    "restart $PB_UNIT") start_pb; return 0 ;; # like systemd: the unit starts, then fails on its own
    "stop $PB_UNIT") rm -f "$RUN/pb" ;;
    *) return 0 ;;
  esac
}
curl() {
  local url=${*: -1} n
  case "$url" in
    "$APP_URL"/*)
      if [ ! -f "$RUN/app" ]; then echo 000; return 7; fi
      if live_has FLAKY; then
        n=$(($(cat "$RUN/app.calls" 2>/dev/null || echo 0) + 1))
        echo "$n" >"$RUN/app.calls"
        [ "$n" -gt 3 ] && { rm -f "$RUN/app"; echo 000; return 7; }
      fi
      if live_has BROKEN; then echo 500
      elif [ "$url" = "$APP_URL/api/data/manifest" ]; then if live_has NODATA; then echo 404; else echo 401; fi
      else echo 200
      fi ;;
    "$PB_HEALTH") if [ -f "$RUN/pb" ]; then echo 200; else echo 000; return 7; fi ;;
    "$PB_URL"/api/collections/sys_datasets/*) if [ -f "$RUN/pb" ]; then echo 403; else echo 000; return 7; fi ;;
    *) echo "unexpected curl $url" >&2; return 7 ;;
  esac
}

# ---- fixtures ------------------------------------------------------------------------------------
sha() { printf '%s' "$1" | shasum | cut -c1-40; }
# release NAME SERVER_TEXT MIGRATION...: a release folder with these migration files (name=content)
release() {
  local d m
  d=$(rel "$(sha "$1")")
  mkdir -p "$d/vm/pocketbase/pb_migrations"
  echo "$2" >"$d/server.js"
  echo '{}' >"$d/package.json"
  printf '{"version":"%s"}\n' "$1" >"$d/version.json"
  shift 2
  for m in "$@"; do printf '%s\n' "${m#*=}" >"$d/vm/pocketbase/pb_migrations/${m%%=*}.js"; done
}
release A ok 001_base=base
release B ok 001_base=base 002_users=users
release C BROKEN 001_base=base 002_users=users
release D ok 001_base=base 002_users=users 003_bad=BAD
release E ok 001_base=base 002_users=users 003_corrupt=CORRUPT
release F ok 001_base=base 002_users=users 003_fine=fine
release G ok 001_base=base 002_users=users
touch "$(rel "$(sha G)")/NPMFAIL"
release H FLAKY 001_base=base 002_users=users
release I NODATA 001_base=base 002_users=users
A=$(sha A) B=$(sha B) C=$(sha C) D=$(sha D) E=$(sha E) F=$(sha F) G=$(sha G) H=$(sha H) I=$(sha I)

# ---- checks --------------------------------------------------------------------------------------
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; sed 's/^/     /' "$T/log" | tail -n 25; }
check() { local name=$1; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
rec() { jq -r ".$1 // empty" "$RECORD"; }
live() { basename "$(readlink "$APP_LINK")"; }
not() { ! "$@"; }
calls_has() { grep -qxF "$1" "$CALLS"; }
# order A B: the first "A" call comes before the last "B" call
order() { local a b; a=$(grep -nxF "$1" "$CALLS" | head -n 1 | cut -d: -f1); b=$(grep -nxF "$2" "$CALLS" | tail -n 1 | cut -d: -f1); [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; }
step() { : >"$CALLS"; : >"$T/log"; WARN=(); PB_UNIT_CHANGED=0; PB_RESTARTED=0; TEST_FAIL=0; }

# Start: A is live and healthy.
switch_to "$A"; start_pb; start_app; write_record ok "$A" ""

step; deploy "$A" "$B"; rc=$?
check "A -> B (new migration) deploys" [ "$rc" = 0 ] && [ "$(rec status)" = ok ] && [ "$(rec commit)" = "$B" ] && [ "$(live)" = "$B" ]
check "A -> B: PocketBase stops for the pb_data copy, restarts, then the app restarts" order "stop $PB_UNIT" "restart $APP_UNIT"
check "A -> B: PocketBase restarted before the app" order "restart $PB_UNIT" "restart $APP_UNIT"
check "A -> B: pb_data copied before the migrations" [ -d "$PB_BACKUP" ]
check "A -> B: the new migration was applied" grep -qx 002_users.js "$PB_DATA/applied"

step; deploy "$B" "$C"; rc=$?
check "B -> C (app answers 500) rolls back" [ "$rc" = 1 ] && [ "$(rec status)" = rolled_back ] && [ "$(rec commit)" = "$B" ] && [ "$(rec failedCommit)" = "$C" ] && [ "$(live)" = "$B" ]
check "B -> C: PocketBase untouched (same migrations)" not calls_has "restart $PB_UNIT"

step; deploy "$B" "$D"; rc=$?
check "B -> D (failing migration) rolls back" [ "$rc" = 1 ] && [ "$(rec status)" = rolled_back ] && [ "$(rec failedCommit)" = "$D" ] && [ "$(live)" = "$B" ]
check "B -> D: the app never ran D (restarted once, on B)" [ "$(grep -cxF "restart $APP_UNIT" "$CALLS")" = 1 ]
check "B -> D: PocketBase runs again on B's migrations" [ -f "$RUN/pb" ] && [ -f "$RUN/app" ]
check "B -> D: no pb_data restore needed" [ ! -f "$PB_DATA/corrupt" ] && ! grep -q 'restored' "$T/log"

step; deploy "$B" "$E"; rc=$?
check "B -> E (migration that breaks pb_data) restores the copy and rolls back" [ "$rc" = 1 ] && [ "$(rec status)" = rolled_back ] && [ "$(live)" = "$B" ] && [ -f "$RUN/pb" ] && [ ! -f "$PB_DATA/corrupt" ]
check "B -> E: the broken pb_data is kept aside and a warning recorded" [ -f "$PB_DATA.failed/corrupt" ] && [ "$(jq '.warnings | length' "$RECORD")" -ge 1 ]

step; TEST_FAIL=1; deploy "$B" "$F"; rc=$?
check "MZO_DEPLOY_TEST_FAIL drill on a good commit rolls back" [ "$rc" = 1 ] && [ "$(rec status)" = rolled_back ] && [ "$(rec failedCommit)" = "$F" ] && [ "$(live)" = "$B" ] && [ -f "$RUN/app" ]
check "drill: PocketBase restarted on F, then again on B" [ "$(grep -cxF "restart $PB_UNIT" "$CALLS")" = 2 ]

step; echo "$F" >"$T/head"; main; rc=$?
check "auto mode skips the commit that failed" [ "$rc" = 0 ] && [ ! -s "$CALLS" ] && [ "$(live)" = "$B" ]

step; deploy "$B" "$H"; rc=$?
check "B -> H (app dies a moment after it starts) rolls back" [ "$rc" = 1 ] && [ "$(rec failedCommit)" = "$H" ] && [ "$(live)" = "$B" ]

step; deploy "$B" "$I"; rc=$?
check "B -> I (data API answers 404) rolls back" [ "$rc" = 1 ] && [ "$(rec failedCommit)" = "$I" ] && [ "$(live)" = "$B" ]

step; write_record ok "$B" "$A"; deploy "$B" "$G"; rc1=$?; deploy "$B" "$G"; rc2=$?
check "npm failure: tried again next round, record unchanged" [ "$rc1" = 0 ] && [ "$rc2" = 0 ] && [ "$(rec status)" = ok ] && [ "$(rec commit)" = "$B" ] && [ "$(live)" = "$B" ]
deploy "$B" "$G"; rc3=$?
check "npm failure: marked failed after $PREPARE_TRIES tries, nothing switched" [ "$rc3" = 1 ] && [ "$(rec failedCommit)" = "$G" ] && [ "$(live)" = "$B" ] && ! calls_has "restart $APP_UNIT"

step; write_record ok "$B" "$A"; main --rollback; rc=$?
check "--rollback B -> A" [ "$rc" = 0 ] && [ "$(rec status)" = rolled_back ] && [ "$(rec commit)" = "$A" ] && [ "$(live)" = "$A" ]
check "--rollback restarts PocketBase on A's migrations (they differ)" calls_has "restart $PB_UNIT"
check "--rollback does not touch pb_data" not grep -q 'copied pb_data' "$T/log"

step; echo "$B" >"$T/head"; main; rc=$?
check "auto mode deploys a new head again (A -> B)" [ "$rc" = 0 ] && [ "$(rec status)" = ok ] && [ "$(live)" = "$B" ]

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
