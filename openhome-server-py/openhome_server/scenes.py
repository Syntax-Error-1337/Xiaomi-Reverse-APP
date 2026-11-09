"""Executes validated scene actions as MIOT commands on the LAN.

Port of openhome-server/lib/src/scene_runner.dart (SceneRunner).
Wire format identical to the Flutter app's `MiioPacket`.
"""

from __future__ import annotations

import json

from .miio import MiioSession


class SceneRunner:
    def __init__(self, store) -> None:
        self._store = store

    def run(self, scene_id: str) -> list:
        """Runs scene now. Returns per-action results.

        Raises RuntimeError for unknown/disabled scenes.
        """
        rows = self._store.query("SELECT * FROM scenes WHERE id = ?", (scene_id,))
        if not rows:
            raise RuntimeError("no such scene")
        if rows[0]["enabled"] != 1:
            raise RuntimeError("scene disabled")
        actions = json.loads(rows[0]["actions_json"])
        results = []
        for a in actions:
            try:
                results.append({"ok": True, "result": self._exec(a)})
            except Exception as e:
                results.append({"ok": False, "error": str(e)})
        ok = sum(1 for r in results if r.get("ok"))
        self._store.log_event("scene.run", detail="%s:%d/%d ok" % (scene_id, ok, len(results)))
        return results

    def _exec(self, action: dict):
        rows = self._store.query("SELECT * FROM devices WHERE id = ?", (action["device"],))
        if not rows:
            raise RuntimeError("unknown device")
        dev = rows[0]
        session = MiioSession(ip=dev["ip"], token=bytes.fromhex(dev["token_hex"]))
        session.connect()
        siid = action["siid"]
        if action["op"] == "set":
            return session.call(
                "set_properties",
                [{"siid": siid, "piid": action["piid"], "value": action.get("value")}],
            )
        return session.call(
            "action",
            {"siid": siid, "aiid": action["aiid"], "in": action.get("args") or []},
        )
