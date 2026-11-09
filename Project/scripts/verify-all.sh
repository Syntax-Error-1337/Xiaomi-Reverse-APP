#!/bin/bash
# PressID full verification (cycle 23): backend tests + frontend tests + frontend build + readiness drill.
# Usage: ./scripts/verify-all.sh
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
START=$(date +%s)

stage() { # stage <num> <name> <cmd...>
  n="$1"; name="$2"; shift 2
  t0=$(date +%s)
  echo "=== [$n/4] $name ==="
  "$@"
  t1=$(date +%s)
  echo "PASS [$n/4] $name ($((t1 - t0))s)"
}

stage 1 "backend tests" npm test --prefix "$ROOT/backend"
stage 2 "frontend tests" npm test --prefix "$ROOT/frontend"
stage 3 "frontend build" npm run build --prefix "$ROOT/frontend"
stage 4 "readiness drill" bash "$ROOT/backend/scripts/drill.sh"

END=$(date +%s)
TOTAL=$((END - START))
echo "verify-all: 4 passed (total ${TOTAL}s)"
if [ "$TOTAL" -gt 60 ]; then echo "verify-all slow — check machine load" >&2; fi
