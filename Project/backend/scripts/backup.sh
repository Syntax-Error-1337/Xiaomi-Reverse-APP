#!/bin/sh
# PressID backup: sqlite snapshot + Ed25519 keys tarball into ./backups/.
# Usage: ./scripts/backup.sh [db_path] [keys_dir]
# Defaults: backend/data/pressid.db + backend/data/keys (or PRESSID_DB / PRESSID_KEYS_DIR).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DB="${1:-${PRESSID_DB:-$ROOT/data/pressid.db}}"
KEYS="${2:-${PRESSID_KEYS_DIR:-$ROOT/data/keys}}"
OUT="$ROOT/backups"
mkdir -p "$OUT"
TS=$(date +%Y%m%d-%H%M%S)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
[ -f "$DB" ] || { echo "backup: no DB at $DB" >&2; exit 1; }
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" ".backup '$TMP/pressid.db'"
else
  cp "$DB" "$TMP/pressid.db"
  echo "backup: sqlite3 CLI missing, used file copy (stop the server first for consistency)" >&2
fi
if [ -d "$KEYS" ]; then
  cp -r "$KEYS" "$TMP/keys"
fi
tar -czf "$OUT/pressid-backup-$TS.tar.gz" -C "$TMP" .
echo "backup: $OUT/pressid-backup-$TS.tar.gz"
