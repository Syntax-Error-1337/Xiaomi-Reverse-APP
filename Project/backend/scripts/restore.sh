#!/bin/sh
# PressID restore: unpack a backup.sh tarball over data/.
# Usage: ./scripts/restore.sh <backup.tar.gz>
# Refuses if the server answers /health on $PORT (stop it first).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
FILE="${1:-}"
[ -n "$FILE" ] || { echo "usage: restore.sh <backup.tar.gz>" >&2; exit 1; }
[ -f "$FILE" ] || { echo "restore: not found: $FILE" >&2; exit 1; }
PORT="${PORT:-4000}"
if (command -v curl >/dev/null 2>&1 && curl -fs -m 3 "http://localhost:$PORT/api/health" >/dev/null 2>&1) || \
   (command -v wget >/dev/null 2>&1 && wget -qO- --timeout=3 "http://localhost:$PORT/api/health" >/dev/null 2>&1); then
  echo "restore: server appears LIVE on port $PORT — stop it first, then retry." >&2
  exit 1
fi
printf 'This will OVERWRITE the DB + keys. Continue? [y/N] '
read -r ans
case "$ans" in
  y|Y|yes|YES) ;;
  *) echo "restore: aborted."; exit 1 ;;
esac
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$FILE" -C "$TMP"
DB="${PRESSID_DB:-$ROOT/data/pressid.db}"
KEYS="${PRESSID_KEYS_DIR:-$ROOT/data/keys}"
mkdir -p "$(dirname "$DB")"
cp "$TMP/pressid.db" "$DB"
if [ -d "$TMP/keys" ]; then
  rm -rf "$KEYS"
  cp -r "$TMP/keys" "$KEYS"
  chmod 600 "$KEYS"/ed25519*.json "$KEYS"/jwt.json 2>/dev/null || true
fi
echo "restore: done from $FILE"
