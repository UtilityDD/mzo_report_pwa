#!/usr/bin/env bash
# Set up (or repair) the MZO VM. Idempotent: safe to run again at any time.
#   sudo bash /opt/mzo/app/vm/deploy/provision.sh [--keep-pcp]
#
# Uses the unit files, Caddyfile and scripts next to this file, so a copy of vm/deploy can
# provision a fresh VM before it is on develop. Never runs dnf: its package metadata needs
# more memory than this 1 GB VM can spare (it froze the VM on 2026-11-01). See docs/vm.md.
#   1. memory first: Performance Co-Pilot off (unless --keep-pcp), no kdump crash-kernel
#      reservation on later boots (it took 448 MB), OOM priorities for sshd, Caddy and the app,
#      swap raised to about 3.5 GB
#   2. /opt/mzo/{releases,deps,state,bin,backup,pocketbase}, /etc/mzo, the pocketbase user
#   3. /etc/mzo/app.env with a random JWT_SECRET (created once, never overwritten)
#   4. PocketBase (vm/pocketbase/VERSION, else PB_VERSION, else 0.40.6), checksum-verified
#   5. systemd units and drop-ins; the pinned /opt/mzo/bin/deploy.sh
#   6. first release of develop through deploy.sh (/opt/mzo/app -> /opt/mzo/releases/<sha>);
#      if it is unhealthy, the old service is put back
#   7. pocketbase.service on 127.0.0.1:8090, superuser and settings (pb-setup.sh)
#   8. Caddyfile (validated); firewalld port 3000 closed once Caddy serves the app over HTTPS
#   9. deploy and sync timers
set -Eeuo pipefail
umask 022

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_USER=opc
MZO=/opt/mzo
APP=$MZO/app
PB_DIR=$MZO/pocketbase
BACKUP=$MZO/backup
OLD_APP=/home/opc/mzo-reports
HOST=130.210.43.11.sslip.io
CADDY=/usr/local/bin/caddy
DEFAULT_PB_VERSION=0.40.6
SWAP_TARGET_MB=3400
KEEP_PCP=0
for a in "$@"; do
  case "$a" in
    --keep-pcp) KEEP_PCP=1 ;;
    *) echo "usage: provision.sh [--keep-pcp]" >&2; exit 2 ;;
  esac
done

step() { echo; echo "== $*"; }
set_oom() { # set_oom UNIT SCORE: apply now to the running main process (the drop-in covers restarts)
  local pid
  pid=$(systemctl show -p MainPID --value "$1" 2>/dev/null || echo 0)
  [ -n "$pid" ] && [ "$pid" != 0 ] && echo "$2" >"/proc/$pid/oom_score_adj" 2>/dev/null || true
}

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
for f in Caddyfile deploy.sh pb-setup.sh systemd/mzo-reports.service systemd/pocketbase.service; do
  [ -f "$SRC/$f" ] || { echo "missing $SRC/$f" >&2; exit 1; }
done
for c in curl jq unzip openssl tar gzip diff sha256sum flock runuser "$CADDY" /usr/local/bin/node /usr/local/bin/npm; do
  command -v "$c" >/dev/null || { echo "missing $c (install it without dnf, or on a bigger machine)" >&2; exit 1; }
done

step "memory"
install -d -m 700 -o root -g root "$MZO" "$BACKUP"
chmod 755 "$MZO"
# kdump reserves 448 MB for a crash kernel at boot (crashkernel=1G-64G:448M): half the VM.
if grubby --info=ALL 2>/dev/null | grep 'crashkernel=' >/dev/null; then
  grubby --update-kernel=ALL --remove-args=crashkernel
  echo "removed crashkernel= from the boot entries (takes effect at the next boot)"
fi
for f in /etc/default/grub /etc/kernel/cmdline; do
  if [ -f "$f" ] && grep -q 'crashkernel=' "$f"; then
    [ -f "$BACKUP/${f##*/}.pre-provision" ] || cp -p "$f" "$BACKUP/${f##*/}.pre-provision"
    sed -i -E 's/ ?crashkernel=[^" ]*//' "$f"
    echo "removed crashkernel= from $f"
  fi
done
if [ -f /etc/kdump.conf ] && grep -q '^auto_reset_crashkernel yes' /etc/kdump.conf; then
  sed -i 's/^auto_reset_crashkernel yes/auto_reset_crashkernel no/' /etc/kdump.conf
fi
systemctl disable -q --now kdump.service 2>/dev/null || true
systemctl reset-failed kdump.service 2>/dev/null || true
echo "kdump: $(systemctl is-enabled kdump.service 2>/dev/null || true)"
if [ "$KEEP_PCP" = 0 ]; then
  for u in pmcd pmlogger pmie pmie_farm pmlogger_farm pmproxy pmfind \
    pmlogger_check.timer pmlogger_daily.timer pmlogger_farm_check.timer \
    pmie_check.timer pmie_daily.timer pmie_farm_check.timer pmfind.timer; do
    systemctl disable -q --now "$u" 2>/dev/null || true
  done
  echo "Performance Co-Pilot stopped and disabled (pmcd: $(systemctl is-active pmcd || true))"
fi
for d in "$SRC"/systemd/*.service.d; do
  [ -d "$d" ] || continue
  for f in "$d"/*.conf; do install -D -m 644 "$f" "/etc/systemd/system/${d##*/}/${f##*/}"; done
done
systemctl daemon-reload
set_oom sshd.service -500
set_oom caddy.service -500
set_oom mzo-reports.service -500
echo "OOM priority: sshd, caddy and the app protected"
if ! grep -q '^/swapfile2 ' /proc/swaps; then
  swap_mb=$(awk '/^SwapTotal:/ {print int($2 / 1024)}' /proc/meminfo)
  add_mb=$((SWAP_TARGET_MB - swap_mb))
  free_mb=$(df -Pm / | awk 'NR == 2 {print $4}')
  if [ "$add_mb" -ge 256 ] && [ "$free_mb" -gt $((add_mb + 8192)) ]; then
    if [ ! -f /swapfile2 ] || [ "$(stat -c %s /swapfile2)" -lt $((add_mb * 1048576)) ]; then
      dd if=/dev/zero of=/swapfile2 bs=1M count="$add_mb" oflag=direct status=none
    fi
    chmod 600 /swapfile2
    mkswap /swapfile2 >/dev/null
    semanage fcontext -a -t swapfile_t /swapfile2 2>/dev/null || true
    restorecon /swapfile2 2>/dev/null || true
    swapon /swapfile2
    grep -q '^/swapfile2 ' /etc/fstab || echo '/swapfile2 none swap sw 0 0' >>/etc/fstab
    echo "added /swapfile2 ($(( $(stat -c %s /swapfile2) / 1048576 )) MB)"
  fi
fi
free -m

step "directories and users"
install -d -m 755 -o root -g root "$MZO" "$MZO/bin" "$MZO/releases" "$MZO/deps" "$MZO/state" "$PB_DIR"
install -d -m 700 -o root -g root "$BACKUP"
install -d -m 750 -o root -g "$APP_USER" /etc/mzo
id pocketbase >/dev/null 2>&1 ||
  useradd --system --home-dir "$PB_DIR" --no-create-home --shell /sbin/nologin pocketbase
install -d -m 750 -o pocketbase -g pocketbase "$PB_DIR/pb_data"
# Raw snapshots written by the sync (opc) and served by the app in mirror mode.
install -d -m 755 -o root -g root "$MZO/data"
install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$MZO/data/snapshots" "$MZO/data/sync-tmp" "$MZO/data/quality"
if [ -e "$APP" ] && [ ! -L "$APP" ]; then
  mv "$APP" "$BACKUP/app-dir-$(date -u +%Y%m%dT%H%M%SZ)"
  echo "moved an old $APP folder into $BACKUP"
fi
for u in mzo-reports.service caddy.service; do
  if [ -f "/etc/systemd/system/$u" ] && [ ! -f "$BACKUP/$u.pre-provision" ]; then
    cp -p "/etc/systemd/system/$u" "$BACKUP/$u.pre-provision"
  fi
done
if [ -f /etc/caddy/Caddyfile ] && [ ! -f "$BACKUP/Caddyfile.pre-provision" ]; then
  cp -p /etc/caddy/Caddyfile "$BACKUP/Caddyfile.pre-provision"
fi

step "app env (/etc/mzo/app.env)"
if [ ! -f /etc/mzo/app.env ]; then
  printf '# Extra environment for mzo-reports.service (not in git). One KEY=value per line.\n' >/etc/mzo/app.env
fi
if ! grep -q '^JWT_SECRET=.' /etc/mzo/app.env; then
  printf 'JWT_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" >>/etc/mzo/app.env
  echo "JWT_SECRET set (new random value)"
else
  echo "JWT_SECRET already set (kept)"
fi
chown root:"$APP_USER" /etc/mzo/app.env
chmod 640 /etc/mzo/app.env

step "PocketBase binary"
want=
for vf in "$SRC/../pocketbase/VERSION" "$APP/vm/pocketbase/VERSION"; do
  if [ -s "$vf" ]; then want=$(tr -d ' \t\r\nv' <"$vf"); break; fi
done
want=${want:-${PB_VERSION:-$DEFAULT_PB_VERSION}}
if [ "$want" = latest ]; then
  want=$(curl -fsS "https://api.github.com/repos/pocketbase/pocketbase/releases?per_page=30" |
    jq -r '.[] | select(.draft == false and .prerelease == false) | .tag_name | ltrimstr("v")' | sort -V | tail -n 1)
fi
have=$("$PB_DIR/pocketbase" --version 2>/dev/null | awk '{print $NF}' || true)
echo "wanted $want, installed ${have:-none}"
if [ "$have" != "$want" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  zip=pocketbase_${want}_linux_amd64.zip
  base=https://github.com/pocketbase/pocketbase/releases/download/v$want
  curl -fsSL -o "$tmp/$zip" "$base/$zip"
  curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt"
  (cd "$tmp" && grep " $zip\$" checksums.txt | sha256sum -c -)
  unzip -q -o "$tmp/$zip" pocketbase -d "$tmp/x"
  if [ -n "$have" ] && [ -n "$(ls -A "$PB_DIR/pb_data")" ]; then
    systemctl stop pocketbase.service || true
    tar -czf "$BACKUP/pb_data-$have-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" -C "$PB_DIR" pb_data
    echo "pb_data backed up before the upgrade"
  fi
  install -m 755 -o root -g root "$tmp/x/pocketbase" "$PB_DIR/pocketbase.new"
  mv -f "$PB_DIR/pocketbase.new" "$PB_DIR/pocketbase"
  "$PB_DIR/pocketbase" --version
fi

step "systemd units and the pinned deploy script"
changed_units=()
for f in "$SRC"/systemd/*.service "$SRC"/systemd/*.timer; do
  n=${f##*/}
  cmp -s "$f" "/etc/systemd/system/$n" && continue
  install -m 644 "$f" "/etc/systemd/system/$n"
  changed_units+=("$n")
done
echo "installed: ${changed_units[*]:-nothing changed}"
systemctl daemon-reload
bash -n "$SRC/deploy.sh"
install -m 755 "$SRC/deploy.sh" "$MZO/bin/deploy.sh.new"
mv -f "$MZO/bin/deploy.sh.new" "$MZO/bin/deploy.sh"
restorecon -R "$MZO" /etc/mzo /etc/systemd/system >/dev/null 2>&1 || true
[ "$("$MZO/bin/deploy.sh" --self-test)" = ok ]
systemctl enable -q mzo-reports.service pocketbase.service

step "app release (develop)"
status=$(jq -r '.status // empty' "$MZO/state/deployed.json" 2>/dev/null || true)
if [ ! -L "$APP" ] || [ "$status" != ok ] || [[ " ${changed_units[*]:-} " == *" mzo-reports.service "* ]]; then
  if ! "$MZO/bin/deploy.sh" --force; then
    echo "the first release is not healthy" >&2
    if [ -f "$BACKUP/mzo-reports.service.pre-provision" ] && [ -d "$OLD_APP" ] && [ ! -L "$OLD_APP" ]; then
      install -m 644 "$BACKUP/mzo-reports.service.pre-provision" /etc/systemd/system/mzo-reports.service
      systemctl daemon-reload
      systemctl restart mzo-reports.service
      echo "put the old service from $OLD_APP back; fix the problem and run provision.sh again" >&2
    fi
    exit 1
  fi
fi
jq -c '{commit, status, version}' "$MZO/state/deployed.json"
if [ -d "$OLD_APP" ] && [ ! -L "$OLD_APP" ]; then
  old_ver=$(jq -r '.version // "old"' "$OLD_APP/version.json" 2>/dev/null || echo old)
  mv "$OLD_APP" "$OLD_APP.old-$old_ver"
  ln -s "$APP" "$OLD_APP"
  chown -h "$APP_USER:$APP_USER" "$OLD_APP"
  echo "old copy kept at $OLD_APP.old-$old_ver; $OLD_APP now links to $APP"
fi

step "PocketBase service"
if [[ " ${changed_units[*]:-} " == *" pocketbase.service "* ]] || ! systemctl is-active -q pocketbase.service; then
  systemctl restart pocketbase.service
fi
bash "$SRC/pb-setup.sh"

step "Caddy"
if ! cmp -s "$SRC/Caddyfile" /etc/caddy/Caddyfile; then
  if ! "$CADDY" validate --config "$SRC/Caddyfile" --adapter caddyfile >/dev/null 2>&1; then
    "$CADDY" validate --config "$SRC/Caddyfile" --adapter caddyfile 2>&1 | tail -n 5
    exit 1
  fi
  install -m 644 /etc/caddy/Caddyfile "$BACKUP/Caddyfile.$(date -u +%Y%m%dT%H%M%SZ)"
  install -m 644 "$SRC/Caddyfile" /etc/caddy/Caddyfile
  systemctl reload caddy.service || systemctl restart caddy.service
  echo "Caddyfile installed"
fi
https_ok=0
for i in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$HOST:443:127.0.0.1" "https://$HOST/login.html")" = 200 ]; then
    https_ok=1
    break
  fi
  sleep 2
done
if [ "$https_ok" = 1 ]; then echo "https://$HOST serves the app"; else echo "WARNING: https://$HOST does not answer yet"; fi

step "firewall"
if [ "$https_ok" = 1 ] && firewall-cmd -q --query-port=3000/tcp; then
  firewall-cmd -q --permanent --remove-port=3000/tcp
  firewall-cmd -q --reload
  echo "closed 3000/tcp (Caddy fronts the app)"
fi
echo "services: $(firewall-cmd --list-services); ports: $(firewall-cmd --list-ports)"

step "timers"
for t in "$SRC"/systemd/*.timer; do systemctl enable -q --now "${t##*/}"; done
systemctl list-timers --no-pager 'mzo-*'

step "summary"
echo "app:        $(jq -r '"\(.commit[0:7]) version \(.version) (\(.status))"' "$MZO/state/deployed.json")"
echo "pocketbase: $("$PB_DIR/pocketbase" --version)"
for u in mzo-reports pocketbase caddy mzo-deploy.timer mzo-sync.timer; do printf '%-18s %s\n' "$u" "$(systemctl is-active "$u")"; done
echo "credentials: /etc/mzo/pocketbase.env, /etc/mzo/app.env, /etc/mzo/portal-admin.txt (once the portal migrations exist)"
free -m
