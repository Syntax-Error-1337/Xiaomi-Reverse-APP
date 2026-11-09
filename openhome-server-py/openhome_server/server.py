"""openhome-server entry point: local HTTP server + server-owned tunnel.

Run modes (everything from env / `.env` — see `.env.example`):

    python -m openhome_server.server            # :8080, ./openhome.db
    OPENHOME_PORT=8081 OPENHOME_DB=/data/home.db python -m openhome_server.server

With `OPENHOME_TUNNEL_TOKEN` set the server also spawns cloudflared as its
child, pointed at `home.himanshu.pro` via the dashboard's ingress config.
Shared fate: Ctrl-C / SIGTERM / crash kills the tunnel too, and the tunnel
never outlives the server. Without a token it serves the LAN only.
"""

from __future__ import annotations

import os
import signal
import threading
from http.server import ThreadingHTTPServer

from .api import Api
from .auth import Auth
from .config import Config
from .database import Store
from .server_http import make_handler
from .specs import SpecCache
from .tunnel import TunnelSupervisor


def _refresh_loop(specs: SpecCache) -> None:
    import time

    while True:
        time.sleep(24 * 3600)
        try:
            n = specs.refresh_model_index()
            print("spec index refreshed: %d models" % n, flush=True)
        except Exception as e:  # never evict the cache
            print("spec refresh failed (cache kept): %s" % e, flush=True)


def _prime(specs: SpecCache) -> None:
    try:
        n = specs.refresh_model_index()
        print("spec index primed: %d models" % n, flush=True)
    except Exception as e:
        print("spec prime failed (will retry nightly): %s" % e, flush=True)


def main() -> None:
    cfg = Config.from_env()
    store = Store.open(cfg.db_path)
    auth = Auth(store)
    specs = SpecCache(store)
    api = Api(store, auth, specs)

    if not auth.has_users:
        print("No users yet. Bootstrap:")
        print(
            "  curl -X POST localhost:%d/api/bootstrap "
            "-H 'content-type: application/json' "
            '\'{"username":"admin","password":"…"}\'' % cfg.port
        )

    # Nightly spec-index refresh. Failures log, never evict the cache.
    threading.Thread(target=_refresh_loop, args=(specs,), daemon=True).start()
    # Prime the index once in the background at startup.
    threading.Thread(target=_prime, args=(specs,), daemon=True).start()

    tunnel = TunnelSupervisor(
        cfg.port,
        token=cfg.tunnel_token,
        enabled=cfg.tunnel_enabled,
        bin=cfg.cloudflared_bin,
    )
    tunnel_started = tunnel.start()
    if not cfg.tunnel_enabled:
        print("tunnel: disabled (set OPENHOME_TUNNEL_TOKEN to expose publicly)")
    elif not tunnel_started:
        print("tunnel: not started, serving LAN-only")

    server = ThreadingHTTPServer(("0.0.0.0", cfg.port), make_handler(api))
    print("openhome-server on http://0.0.0.0:%d" % cfg.port, flush=True)
    if cfg.public_url:
        print("public: %s" % cfg.public_url, flush=True)

    def _shutdown(*_args) -> None:
        # Shared fate: the tunnel never outlives the server.
        tunnel.stop()
        try:
            store.close()
        except Exception:
            pass
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _shutdown()


if __name__ == "__main__":
    main()
