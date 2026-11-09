"""REST surface. Port of openhome-server/lib/src/api.dart.

Every route except bootstrap/login/health requires
`Authorization: Bearer <token>`.

Devices:  POST/GET /api/devices, PATCH/DELETE /api/devices/:id
Rooms:    POST/GET /api/rooms
Specs:    GET /api/specs/:model[?refresh=1], GET /api/specs/:model/local
Scenes:   POST/GET /api/scenes, POST /api/scenes/:id/run,
          PATCH/DELETE /api/scenes/:id
Events:   GET /api/events?limit=100
Backup:   GET /api/backup

`Api.dispatch` is the router (returns (status, payload), JSON-serializable)
so tests exercise it without sockets; `Handler` adapts it to HTTP.
"""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.parse
import uuid

from .specs import SpecCache

_TOKEN_HEX = re.compile(r"^[0-9a-fA-F]{32}$")


def _now_ms() -> int:
    return int(time.time() * 1000)


# v0 action schema: {"device": "<id>", "op": "set|action",
# "siid": n, "piid"|"aiid": n, "value"|"args": ...}.
def validate_actions(actions: list):
    for a in actions:
        if not isinstance(a, dict):
            return "each action must be an object"
        if not isinstance(a.get("device"), str):
            return "action.device (id) required"
        if a.get("op") not in ("set", "action"):
            return "action.op must be set|action"
        if not isinstance(a.get("siid"), int) or isinstance(a.get("siid"), bool):
            return "action.siid required"
        if a["op"] == "set" and (
            not isinstance(a.get("piid"), int) or isinstance(a.get("piid"), bool)
        ):
            return "set needs piid"
        if a["op"] == "action" and (
            not isinstance(a.get("aiid"), int) or isinstance(a.get("aiid"), bool)
        ):
            return "action needs aiid"
    return None


class Api:
    def __init__(self, store, auth, specs) -> None:
        self._store = store
        self._auth = auth
        self._specs = specs

    # -- router ---------------------------------------------------------

    def dispatch(self, method: str, target: str, headers: dict, raw_body: bytes):
        """Route one request. Returns (status_code, jsonable_payload)."""
        parts = urllib.parse.urlsplit(target)
        path = parts.path
        query = urllib.parse.parse_qs(parts.query)
        try:
            body = json.loads(raw_body.decode("utf-8")) if raw_body else {}
        except ValueError:
            body = {}
        if not isinstance(body, dict):
            body = {}

        if method == "GET" and path == "/health":
            return 200, {"ok": True}

        if method == "POST" and path == "/api/bootstrap":
            username = body.get("username")
            password = body.get("password")
            if (
                not isinstance(username, str)
                or not isinstance(password, str)
                or len(password) < 8
            ):
                return 400, {"error": "username + password (8+ chars) required"}
            try:
                return 200, {"token": self._auth.bootstrap(username, password)}
            except RuntimeError:
                return 409, {"error": "already bootstrapped"}

        if method == "POST" and path == "/api/login":
            token = self._auth.login(
                body.get("username") or "", body.get("password") or ""
            )
            if token is None:
                return 401, {"error": "invalid credentials"}
            return 200, {"token": token}

        # ---- authenticated below ----
        authz = ""
        for k, v in headers.items():
            if k.lower() == "authorization":
                authz = v
                break
        bearer = authz[7:] if authz.startswith("Bearer ") else ""
        if self._auth.user_for_token(bearer) is None:
            return 401, {"error": "unauthorized"}

        store, specs = self._store, self._specs

        if method == "GET" and path == "/api/devices":
            return 200, store.query(
                "SELECT d.*, r.name AS room FROM devices d "
                "LEFT JOIN rooms r ON r.id = d.room_id"
            )

        if method == "POST" and path == "/api/devices":
            ip = body.get("ip")
            token_hex = body.get("token")
            if not isinstance(ip, str) or not isinstance(token_hex, str):
                return 400, {"error": "ip + token required"}
            if not _TOKEN_HEX.match(token_hex):
                return 400, {"error": "token must be 32 hex chars"}
            model = body.get("model") if isinstance(body.get("model"), str) else None
            dev_id = str(uuid.uuid4())
            # Opportunistic URN attach: exact-model hit in the cached index.
            urn = specs.resolve_urn(model) if model else None
            if urn is not None:
                threading.Thread(
                    target=_fetch_quietly,
                    args=(specs, model, urn),
                    daemon=True,
                ).start()
            store.execute(
                "INSERT INTO devices (id, name, ip, token_hex, model, urn, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    dev_id,
                    body.get("name") or ip,
                    ip,
                    token_hex.lower(),
                    model,
                    urn,
                    _now_ms(),
                ),
            )
            store.log_event("device.added", device_id=dev_id, detail=ip)
            return 200, {"id": dev_id, "urn": urn}

        m = re.fullmatch(r"/api/devices/([^/]+)", path)
        if m:
            dev_id = urllib.parse.unquote(m.group(1))
            if method == "PATCH":
                sets, args = [], []
                for k in ("name", "ip", "token_hex", "model", "room_id"):
                    if k in body:
                        if k == "token_hex" and (
                            not isinstance(body[k], str) or not _TOKEN_HEX.match(body[k])
                        ):
                            return 400, {"error": "token must be 32 hex chars"}
                        sets.append("%s = ?" % k)
                        args.append(body[k])
                if not sets:
                    return 400, {"error": "nothing to update"}
                args.append(dev_id)
                store.execute(
                    "UPDATE devices SET %s WHERE id = ?" % ", ".join(sets), tuple(args)
                )
                return 200, {"ok": True}
            if method == "DELETE":
                store.execute("DELETE FROM devices WHERE id = ?", (dev_id,))
                store.log_event("device.removed", device_id=dev_id)
                return 200, {"ok": True}

        if method == "GET" and path == "/api/rooms":
            return 200, store.query("SELECT * FROM rooms")

        if method == "POST" and path == "/api/rooms":
            name = body.get("name")
            if not isinstance(name, str) or not name:
                return 400, {"error": "name required"}
            room_id = str(uuid.uuid4())
            store.execute("INSERT INTO rooms (id, name) VALUES (?, ?)", (room_id, name))
            return 200, {"id": room_id}

        m = re.fullmatch(r"/api/specs/(.+)/local", path)
        if m and method == "GET":
            model = urllib.parse.unquote(m.group(1))
            spec = specs.spec_for(model)
            if spec is None:
                return 404, {"error": "unknown model"}
            return 200, SpecCache.to_local_spec(model, spec)

        m = re.fullmatch(r"/api/specs/(.+)", path)
        if m and method == "GET":
            model = urllib.parse.unquote(m.group(1))
            refresh = query.get("refresh") == ["1"]
            spec = specs.spec_for(model, refresh=refresh)
            if spec is None:
                return 404, {"error": "unknown model (index not yet synced?)"}
            return 200, spec

        if method == "GET" and path == "/api/scenes":
            return 200, store.query("SELECT * FROM scenes")

        if method == "POST" and path == "/api/scenes":
            name = body.get("name")
            actions = body.get("actions")
            if (
                not isinstance(name, str)
                or not isinstance(actions, list)
                or not actions
            ):
                return 400, {"error": "name + non-empty actions required"}
            err = validate_actions(actions)
            if err is not None:
                return 400, {"error": err}
            scene_id = str(uuid.uuid4())
            trigger = body.get("trigger")
            if not isinstance(trigger, dict):
                trigger = {"type": "manual"}
            store.execute(
                "INSERT INTO scenes (id, name, enabled, trigger_json, actions_json) "
                "VALUES (?, ?, 1, ?, ?)",
                (scene_id, name, json.dumps(trigger), json.dumps(actions)),
            )
            return 200, {"id": scene_id}

        m = re.fullmatch(r"/api/scenes/([^/]+)/run", path)
        if m and method == "POST":
            scene_id = urllib.parse.unquote(m.group(1))
            rows = store.query("SELECT * FROM scenes WHERE id = ?", (scene_id,))
            if not rows:
                return 404, {"error": "no such scene"}
            # Execution happens in scenes.py (needs UDP); the API validates +
            # records intent so a headless scheduler can pick it up.
            store.log_event("scene.run", detail=scene_id)
            return 200, {
                "ok": True,
                "note": "queued — requires the runner (scenes.py)",
            }

        m = re.fullmatch(r"/api/scenes/([^/]+)", path)
        if m:
            scene_id = urllib.parse.unquote(m.group(1))
            if method == "PATCH":
                if "enabled" in body:
                    store.execute(
                        "UPDATE scenes SET enabled = ? WHERE id = ?",
                        (1 if body["enabled"] is True else 0, scene_id),
                    )
                if isinstance(body.get("actions"), list):
                    err = validate_actions(body["actions"])
                    if err is not None:
                        return 400, {"error": err}
                    store.execute(
                        "UPDATE scenes SET actions_json = ? WHERE id = ?",
                        (json.dumps(body["actions"]), scene_id),
                    )
                return 200, {"ok": True}
            if method == "DELETE":
                store.execute("DELETE FROM scenes WHERE id = ?", (scene_id,))
                return 200, {"ok": True}

        if method == "GET" and path == "/api/events":
            try:
                limit = int(query.get("limit", ["100"])[0])
            except (ValueError, IndexError):
                limit = 100
            limit = max(1, min(1000, limit))
            return 200, store.query(
                "SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)
            )

        if method == "GET" and path == "/api/backup":
            return 200, store.export_all()

        return 404, {"error": "not found"}


def _fetch_quietly(specs, model: str, urn: str) -> None:
    try:
        specs.fetch_spec(model, urn)
    except Exception:
        pass
