#!/bin/bash
# Start this checkout's app for a parity run, with the upstream write guard.
#   scripts/qa/serve-local.sh <port> [<snapshotDir>]     (a snapshot dir turns on MZO_DATA_MODE=mirror)
# Logs to $QA_LOG_DIR (default /tmp)/mzo-qa-<port>.log; pid in mzo-qa-<port>.pid. Stop: kill $(cat …pid).
# The absolute script path keeps the process out of broad `pkill -f "node server.js"` matches.
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT_ARG="${1:?usage: serve-local.sh <port> [snapshotDir]}"
SNAP="${2:-}"
LOGDIR="${QA_LOG_DIR:-/tmp}"
PIDF="$LOGDIR/mzo-qa-$PORT_ARG.pid"
if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then kill "$(cat "$PIDF")"; sleep 1; fi
export PORT="$PORT_ARG"
export NODE_OPTIONS="--require $ROOT/scripts/qa/guard-writes.js"
if [ -n "$SNAP" ]; then export MZO_DATA_MODE=mirror MZO_SNAPSHOT_DIR="$SNAP"; else unset MZO_DATA_MODE MZO_SNAPSHOT_DIR; fi
cd "$ROOT"
nohup node "$ROOT/server.js" > "$LOGDIR/mzo-qa-$PORT_ARG.log" 2>&1 &
echo $! > "$PIDF"
for i in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT_ARG/login.html" && break; sleep 0.2; done
echo "app on :$PORT_ARG pid $(cat "$PIDF") mode ${MZO_DATA_MODE:-original}${SNAP:+ snapshots $SNAP}"
