#!/usr/bin/env bash
# PocketBase accounts and settings on the MZO VM. Idempotent; run as root.
#   sudo bash pb-setup.sh [--quiet]
#
# 1. /etc/mzo/pocketbase.env (PB_URL, PB_SUPERUSER_EMAIL, PB_SUPERUSER_PASSWORD; 640 root:opc):
#    generated once, then reused. The superuser is upserted from it with the pocketbase CLI.
# 2. Settings: app name/URL, batch API on (the sync uses it), real client IPs from Caddy's
#    X-Forwarded-For, rate limits on (127.0.0.1, i.e. the sync, is exempt). Only switches and
#    lists: the numbers (batch size, timeouts, log days) belong to the settings migration in
#    vm/pocketbase/pb_migrations, and are left as they are.
# 3. Portal admin: once the portal_users_auth collection exists (it comes from the repo
#    migrations), one account is created and written to /etc/mzo/portal-admin.txt (600 root).
# Passwords never go on a command line except the CLI upsert, and are never printed.
set -Eeuo pipefail
umask 077

PB_DIR=/opt/mzo/pocketbase
PB_BIN=$PB_DIR/pocketbase
PB_DATA=$PB_DIR/pb_data
PB_MIGRATIONS=/opt/mzo/app/vm/pocketbase/pb_migrations
PB_ENV=/etc/mzo/pocketbase.env
PORTAL_FILE=/etc/mzo/portal-admin.txt
PORTAL_URL=https://data.130.210.43.11.sslip.io
PB_URL=http://127.0.0.1:8090
SUPERUSER_EMAIL=superuser@mzo.local
PORTAL_ADMIN_EMAIL=admin@mzo.local
QUIET=0
[ "${1:-}" = --quiet ] && QUIET=1

say() { [ "$QUIET" = 1 ] || echo "pb-setup: $*"; }
die() { echo "pb-setup: $*" >&2; exit 1; }
genpass() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-32; }
envval() { sed -n "s/^$2=//p" "$1" | tail -n 1; }

[ "$(id -u)" = 0 ] || die "run as root"
[ -x "$PB_BIN" ] || die "$PB_BIN is missing; run provision.sh"

# 1. Superuser credentials file
install -d -m 750 -o root -g opc /etc/mzo
if [ ! -s "$PB_ENV" ] || [ -z "$(envval "$PB_ENV" PB_SUPERUSER_PASSWORD)" ]; then
  printf 'PB_URL=%s\nPB_SUPERUSER_EMAIL=%s\nPB_SUPERUSER_PASSWORD=%s\n' "$PB_URL" "$SUPERUSER_EMAIL" "$(genpass)" >"$PB_ENV"
  say "wrote $PB_ENV"
fi
chown root:opc "$PB_ENV"
chmod 640 "$PB_ENV"
SU_EMAIL=$(envval "$PB_ENV" PB_SUPERUSER_EMAIL)
SU_PASS=$(envval "$PB_ENV" PB_SUPERUSER_PASSWORD)
PB_URL=$(envval "$PB_ENV" PB_URL)
PB_URL=${PB_URL:-http://127.0.0.1:8090}

for i in $(seq 1 30); do
  curl -fs -o /dev/null --max-time 3 "$PB_URL/api/health" && break
  sleep 1
done
curl -fs -o /dev/null --max-time 3 "$PB_URL/api/health" || die "PocketBase is not answering on $PB_URL"

auth() {
  jq -n --arg i "$SU_EMAIL" --arg p "$SU_PASS" '{identity: $i, password: $p}' |
    curl -fs --max-time 10 -H 'Content-Type: application/json' --data @- \
      "$PB_URL/api/collections/_superusers/auth-with-password" | jq -r '.token // empty'
}
TOKEN=$(auth || true)
if [ -z "$TOKEN" ]; then
  runuser -u pocketbase -- "$PB_BIN" superuser upsert "$SU_EMAIL" "$SU_PASS" \
    --dir="$PB_DATA" --migrationsDir="$PB_MIGRATIONS" --automigrate=false >/dev/null
  say "superuser $SU_EMAIL saved"
  TOKEN=$(auth || true)
fi
[ -n "$TOKEN" ] || die "cannot sign in as the PocketBase superuser"

api() { # api METHOD PATH; the JSON body (not GET) comes on stdin
  if [ "$1" = GET ]; then
    curl -s --max-time 20 -H "Authorization: $TOKEN" "$PB_URL$2"
  else
    curl -s --max-time 20 -X "$1" -H "Authorization: $TOKEN" -H 'Content-Type: application/json' --data @- "$PB_URL$2"
  fi
}

# 2. Settings
DESIRED=$(jq -n -c --arg url "$PORTAL_URL" '{
  meta: {appName: "MZO data mirror", appURL: $url},
  batch: {enabled: true},
  trustedProxy: {headers: ["X-Forwarded-For"], useLeftmostIP: false},
  rateLimits: {enabled: true, excludedIPs: ["127.0.0.1", "::1"]}
}')
if api GET /api/settings | jq -e --argjson d "$DESIRED" 'contains($d)' >/dev/null; then
  say "settings already set"
else
  printf '%s' "$DESIRED" | api PATCH /api/settings | jq -e '.batch.enabled == true' >/dev/null ||
    die "could not update PocketBase settings"
  say "settings updated (batch API on, trusted proxy header, rate limits)"
fi

# 3. Portal admin (needs the portal_users_auth collection from the repo migrations)
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Authorization: $TOKEN" "$PB_URL/api/collections/portal_users_auth")
if [ "$code" != 200 ]; then
  say "portal_users_auth does not exist yet; portal admin skipped (runs again after the migrations deploy)"
  exit 0
fi
if [ -s "$PORTAL_FILE" ]; then
  P_EMAIL=$(envval "$PORTAL_FILE" PORTAL_ADMIN_EMAIL)
  P_PASS=$(envval "$PORTAL_FILE" PORTAL_ADMIN_PASSWORD)
else
  P_EMAIL=$PORTAL_ADMIN_EMAIL
  P_PASS=$(genpass)
fi
filter=$(jq -rn --arg e "$P_EMAIL" '"email=\"\($e)\"" | @uri')
found=$(api GET "/api/collections/portal_users_auth/records?perPage=1&filter=$filter" | jq -r '.totalItems // 0')
if [ "$found" = 0 ]; then
  out=$(jq -n --arg e "$P_EMAIL" --arg p "$P_PASS" \
    '{email: $e, password: $p, passwordConfirm: $p, verified: true, emailVisibility: false, name: "Portal admin"}' |
    api POST /api/collections/portal_users_auth/records)
  if ! printf '%s' "$out" | jq -e '.id' >/dev/null 2>&1; then
    echo "pb-setup: could not create the portal admin: $(printf '%s' "$out" | jq -c '{message, data}' 2>/dev/null)" >&2
    exit 1
  fi
  say "portal admin $P_EMAIL created"
fi
if [ ! -s "$PORTAL_FILE" ]; then
  printf '# MZO data portal sign-in\nPORTAL_URL=%s\nPORTAL_ADMIN_EMAIL=%s\nPORTAL_ADMIN_PASSWORD=%s\n' \
    "$PORTAL_URL" "$P_EMAIL" "$P_PASS" >"$PORTAL_FILE"
  say "wrote $PORTAL_FILE"
fi
chown root:root "$PORTAL_FILE"
chmod 600 "$PORTAL_FILE"
