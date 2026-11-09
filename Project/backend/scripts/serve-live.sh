#!/bin/sh
# PressID live demo server (cycle 77, fixed iteration P): detached, survives
# the launching shell.
# Usage: ./scripts/serve-live.sh [port]   (default 4000)
# Logs: /tmp/pressid-live.log   Stop: kill $(cat /tmp/pressid-live.pid)
set -eu
BACKEND=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PORT="${1:-4000}"
export PORT
export ALLOW_DEV_SECRET=1
if curl -s -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "serve-live: already answering on :$PORT, refusing to double-boot"
  exit 1
fi
cd "$BACKEND"
# setsid detaches on Linux; plain nohup backgrounding works on macOS too.
if command -v setsid >/dev/null 2>&1; then
  setsid node src/server.js > /tmp/pressid-live.log 2>&1 < /dev/null &
else
  nohup node src/server.js > /tmp/pressid-live.log 2>&1 < /dev/null &
fi
echo $! > /tmp/pressid-live.pid
sleep 2
if curl -s -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "serve-live: up on :$PORT (pid $(cat /tmp/pressid-live.pid), log /tmp/pressid-live.log)"
else
  echo "serve-live: FAILED to boot — see /tmp/pressid-live.log"
  sed -n '1,10p' /tmp/pressid-live.log
  exit 1
fi
