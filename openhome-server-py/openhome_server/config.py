"""Config + .env loading. Stdlib only.

`Config.from_env()` reads (lowest to highest precedence):
  1. `openhome-server-py/.env` (or `OPENHOME_ENV` path / `./.env`)
  2. real environment variables (never overridden by the .env file)

So `export OPENHOME_PORT=8081` always wins over the file.
"""

from __future__ import annotations

import os

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_dotenv(path: str | None = None) -> dict:
    """Load KEY=VALUE lines into os.environ without overriding real env.

    Returns the dict of keys actually set. Supports `#` comments,
    `export KEY=...` prefixes, and single/double-quoted values.
    """
    candidates = []
    if path:
        candidates.append(path)
    if os.environ.get("OPENHOME_ENV"):
        candidates.append(os.environ["OPENHOME_ENV"])
    candidates.append(os.path.join(os.getcwd(), ".env"))
    candidates.append(os.path.join(PACKAGE_ROOT, ".env"))
    loaded = {}
    for c in candidates:
        if not c or not os.path.isfile(c):
            continue
        with open(c, encoding="utf-8") as fh:
            for line in fh.read().splitlines():
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                if s.startswith("export "):
                    s = s[len("export ") :].strip()
                k, v = s.split("=", 1)
                k, v = k.strip(), v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
                    v = v[1:-1]
                if k and k not in os.environ:
                    os.environ[k] = v
                    loaded[k] = v
        break  # first existing file wins
    return loaded


class Config:
    """Server + tunnel config. See `.env.example` for every knob."""

    def __init__(
        self,
        port: int = 8080,
        db_path: str = "openhome.db",
        hostname: str = "",
        tunnel_mode: str = "auto",
        tunnel_token: str = "",
        cloudflared_bin: str = "cloudflared",
    ) -> None:
        self.port = port
        self.db_path = db_path
        self.hostname = hostname
        self.tunnel_mode = tunnel_mode
        self.tunnel_token = tunnel_token
        self.cloudflared_bin = cloudflared_bin

    @classmethod
    def from_env(cls) -> "Config":
        load_dotenv()
        try:
            port = int(os.environ.get("OPENHOME_PORT") or 8080)
        except ValueError:
            port = 8080
        return cls(
            port=port,
            db_path=os.environ.get("OPENHOME_DB", "openhome.db"),
            hostname=os.environ.get("OPENHOME_HOSTNAME", ""),
            tunnel_mode=(os.environ.get("OPENHOME_TUNNEL", "auto") or "auto").lower(),
            tunnel_token=os.environ.get("OPENHOME_TUNNEL_TOKEN", ""),
            cloudflared_bin=os.environ.get("CLOUDFLARED_BIN", "cloudflared"),
        )

    @property
    def tunnel_enabled(self) -> bool:
        return self.tunnel_mode != "off" and bool(self.tunnel_token)

    @property
    def public_url(self) -> str:
        return ("https://%s" % self.hostname) if self.hostname else ""
