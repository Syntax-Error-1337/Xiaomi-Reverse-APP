# openhome-server-py

Python port of `../openhome-server` (Dart). Same REST surface, same SQLite
schema — a database file written by either server opens in the other
unchanged. Stdlib only: no `pip install` needed.

## Why this shape (from the RE)

| Xiaomi cloud piece | Clonable? | Replacement here |
|---|---|---|
| `account.xiaomi.com` OAuth + device binding | No — devices are bound to their accounts; no public API | Local accounts + bearer tokens (`auth.py`) |
| `/v2/device/*`, `/v2/home/*`, `/v2/scene/*` relay | No — account-gated, signed | Direct LAN MIOT execution (`scenes.py`) |
| `miot-spec.org` model→URN→spec | Yes — public, no auth (verified) | Nightly-cached `SpecCache` in SQLite (`specs.py`) |
| Server-driven RN bundles (`res.youpin.mi-img.com/.../skytree`) | No — shop storefront, signed manifests | Not replaced; app renders from local specs |
| Push/Siri/Matter/share | No — vendor/entitlement-gated | Out of scope |

## Run (one command: server + tunnel, shared fate)

```bash
./run.sh                 # reads .env, serves LAN; generates .env on first run
./run.sh --tunnel        # + starts the Cloudflare tunnel -> $OPENHOME_HOSTNAME
./run.sh --no-tunnel     # force LAN-only even with a token present
```

Everything lives in `.env` (see `.env.example`; never commit `.env`):
`OPENHOME_PORT`, `OPENHOME_DB`, `OPENHOME_PEPPER`,
`OPENHOME_HOSTNAME=home.himanshu.pro`, `OPENHOME_TUNNEL_TOKEN`.
Real environment variables always win over `.env`.
One Ctrl-C stops the server AND its tunnel child — the tunnel never
outlives the server, and the token travels via the child's environment
(never visible in `ps`).

```bash
python3 -m openhome_server.server            # :8080, ./openhome.db
OPENHOME_PORT=8081 OPENHOME_DB=/data/home.db python3 -m openhome_server.server
```

Bootstrap the first admin (refused once users exist), then log in:

```bash
curl -X POST localhost:8080/api/bootstrap -H 'content-type: application/json' \
  -d '{"username":"admin","password":"change-me-please"}'
# {"token":"…"}
export T=<token>
curl localhost:8080/api/devices -H "Authorization: Bearer $T"
```

## API (all but bootstrap/login/health need `Authorization: Bearer`)

- `POST /api/devices {name, ip, token, model?}` — model triggers opportunistic
  URN attach from the cached index.
- `GET /api/specs/:model` — full upstream spec JSON (cached, `?refresh=1`).
- `GET /api/specs/:model/local` — trimmed projection the app renders from.
- `POST /api/scenes {name, trigger?, actions:[{device, op:set|action,
  siid, piid|aiid, value|args}]}` + `POST /api/scenes/:id/run`.
- `GET /api/rooms`, `POST /api/rooms`, `GET /api/events`, `GET /api/backup`.

Scenes v0 are manual triggers; the runner executes MIOT set/action on the LAN
(device tokens stay server-side — the app never needs to hold them when going
through the server).

To execute a scene for real (not just queue it):

```python
from openhome_server import Store, SceneRunner
print(SceneRunner(Store.open("openhome.db")).run("<scene-id>"))
```

## Layout

| File | Ports |
|---|---|
| `openhome_server/database.py` | `lib/src/database.dart` — same schema/SQL |
| `openhome_server/auth.py` | `lib/src/auth.dart` — identical hash format |
| `openhome_server/specs.py` | `lib/src/spec_cache.dart` — same `_meta` keys |
| `openhome_server/miio.py` | `scene_runner.dart` MiioPacket/MiioSession + pure-Python AES-128 |
| `openhome_server/scenes.py` | `scene_runner.dart` SceneRunner |
| `openhome_server/api.py` | `lib/src/api.dart` — same routes/statuses |
| `openhome_server/server.py` | `bin/server.dart` — same env vars, nightly refresh |

## Tests

```bash
python3 -m unittest discover -s tests   # 9 tests, stdlib only
```

Mirrors `../openhome-server/test/`: the pinned known-answer miIO ciphertext
(byte-identical wire format — real devices accept our packets), auth, the
full bootstrap→devices→scenes→events→backup flow, `to_local_spec`, and the
region-free source/schema sweep.
