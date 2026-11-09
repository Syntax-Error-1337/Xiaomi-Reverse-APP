# openhome-server

Your own smart-home server. The Flutter app (`../openhome`) talks to THIS
instead of Xiaomi's cloud; the server talks MIOT to devices on your LAN and
caches `miot-spec.org` so the home works offline.

## Why this shape (from the RE)

| Xiaomi cloud piece | Clonable? | Replacement here |
|---|---|---|
| `account.xiaomi.com` OAuth + device binding | No — devices are bound to their accounts; no public API | Local accounts + bearer tokens (`Auth`) |
| `/v2/device/*`, `/v2/home/*`, `/v2/scene/*` relay | No — account-gated, signed | Direct LAN MIOT execution (`SceneRunner`) |
| `miot-spec.org` model→URN→spec | Yes — public, no auth (verified) | Nightly-cached `SpecCache` in SQLite |
| Server-driven RN bundles (`res.youpin.mi-img.com/.../skytree`) | No — shop storefront, signed manifests | Not replaced; app renders from local specs |
| Push/Siri/Matter/share | No — vendor/entitlement-gated | Out of scope |

## Run

```bash
dart pub get
dart run bin/server.dart            # :8080, ./openhome.db
OPENHOME_PORT=8081 OPENHOME_DB=/data/home.db dart run bin/server.dart
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
