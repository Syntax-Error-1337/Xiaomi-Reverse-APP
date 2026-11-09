"""openhome_server: your own smart-home server (Python port).

Replaces the Xiaomi-cloud pieces a local app actually needs, grounded in
the Mi Home 11.8.203 RE (see `../openhome/docs/RE_FINDINGS.md`):

* Identity: Xiaomi uses `account.xiaomi.com` OAuth + device binding to
  THEIR accounts — not clonable, and deliberately not cloned. This server
  issues its own local accounts + bearer tokens.
* Device relay: Xiaomi's `/v2/device/*`, `/v2/home/*`, `/v2/scene/*` are
  account-gated and request-signed. Instead the server executes MIOT
  commands directly on your LAN (same protocol as the Flutter app).
* Specs: `miot-spec.org` is PUBLIC (no auth). The server caches
  model -> URN -> full spec JSON in SQLite with nightly refresh, so your
  whole home keeps working offline and any LAN client can fetch specs.
"""

from .api import Api, validate_actions
from .auth import Auth
from .config import Config, load_dotenv
from .database import Store
from .miio import MiioPacket, MiioSession
from .scenes import SceneRunner
from .server_http import make_handler
from .specs import SpecCache
from .tunnel import TunnelSupervisor

__all__ = [
    "Api",
    "Auth",
    "Config",
    "MiioPacket",
    "MiioSession",
    "SceneRunner",
    "SpecCache",
    "Store",
    "TunnelSupervisor",
    "load_dotenv",
    "make_handler",
    "validate_actions",
]

__version__ = "0.2.0"
