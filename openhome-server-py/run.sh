#!/usr/bin/env bash
# openhome-server runner: one command boots the server AND its tunnel.
#
#   ./run.sh                 # LAN-only (no token in .env yet)
#   ./run.sh --tunnel        # + Cloudflare tunnel -> $OPENHOME_HOSTNAME
#   ./run.sh --no-tunnel     # force LAN-only even with a token present
#
# Env / .env (see .env.example) controls everything:
#   OPENHOME_PORT  OPENHOME_DB  OPENHOME_PEPPER
#   OPENHOME_HOSTNAME  OPENHOME_TUNNEL_TOKEN  OPENHOME_TUNNEL  CLOUDFLARED_BIN
#
# Shared fate: one Ctrl-C / SIGTERM stops the server and its tunnel child.
# The token travels via the child's environment, never via ps-visible argv.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# --- .env (lowest precedence; real env always wins) ---
ENV_FILE="${OPENHOME_ENV:-$HERE/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

MODE="${1:-}"
case "$MODE" in
  --no-tunnel) export OPENHOME_TUNNEL=off ;;
  --tunnel)
    if [ -z "${OPENHOME_TUNNEL_TOKEN:-}" ]; then
      echo "error: --tunnel needs OPENHOME_TUNNEL_TOKEN (see .env.example)" >&2
      echo "hint: Zero Trust -> Networks -> Tunnels -> <tunnel> -> Configure" >&2
      exit 1
    fi
    ;;
  "") ;;
  *) echo "usage: ./run.sh [--tunnel|--no-tunnel]" >&2; exit 1 ;;
esac

# --- first-run bootstrap: pepper + token, persisted to .env ---
if [ -z "${OPENHOME_PEPPER:-}" ] && [ ! -f "$HERE/.env" ]; then
  PEPPER="$(python3 -c 'import secrets;print(secrets.token_hex(16))')"
  {
    echo "# Generated on first run. NEVER commit this file."
    echo "OPENHOME_PORT=${OPENHOME_PORT:-8080}"
    echo "OPENHOME_DB=${OPENHOME_DB:-openhome.db}"
    echo "OPENHOME_PEPPER=$PEPPER"
    echo "OPENHOME_HOSTNAME=${OPENHOME_HOSTNAME:-home.himanshu.pro}"
    if [ -n "${OPENHOME_TUNNEL_TOKEN:-}" ]; then
      echo "OPENHOME_TUNNEL_TOKEN=${OPENHOME_TUNNEL_TOKEN}"
    else
      echo "# OPENHOME_TUNNEL_TOKEN=<paste from Cloudflare dashboard>"
    fi
  } > "$HERE/.env"
  chmod 600 "$HERE/.env"
  export OPENHOME_PEPPER="$PEPPER"
  echo "run: generated .env with random pepper (mode 600)"
fi

# --- preflight ---
command -v python3 >/dev/null || { echo "error: python3 not found" >&2; exit 1; }
if [ -n "${OPENHOME_TUNNEL_TOKEN:-}" ] && [ "${OPENHOME_TUNNEL:-auto}" != "off" ]; then
  BIN="${CLOUDFLARED_BIN:-cloudflared}"
  command -v "$BIN" >/dev/null || {
    echo "error: $BIN not found; brew install cloudflared, or ./run.sh --no-tunnel" >&2
    exit 1
  }
fi

if [ -z "${OPENHOME_TUNNEL_TOKEN:-}" ]; then
  echo "run: no tunnel token -> LAN-only on :${OPENHOME_PORT:-8080}"
  echo "run: paste OPENHOME_TUNNEL_TOKEN into .env, then ./run.sh --tunnel"
else
  echo "run: public -> https://${OPENHOME_HOSTNAME:-home.himanshu.pro}"
fi

exec python3 -m openhome_server.server
