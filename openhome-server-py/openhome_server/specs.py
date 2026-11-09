"""Cache over the PUBLIC miot-spec.org API (verified 2026-10-14: no auth,
`status=released` instance lists, per-URN full spec JSON).

Port of openhome-server/lib/src/spec_cache.dart. Same flow, same `_meta`
keys, so a DB primed by the Dart server is reused as-is.

Offline-first: cached rows serve forever; refresh failures never evict.
"""

from __future__ import annotations

import datetime
import json
import time
import urllib.parse
import urllib.request


def _now_ms() -> int:
    return int(time.time() * 1000)


class FetchError(RuntimeError):
    pass


class SpecCache:
    INSTANCES_HOST = "miot-spec.org"
    META_INDEX_KEY = "spec.model_index_ts"
    META_INDEX_JSON = "spec.model_index"

    def __init__(self, store, opener=None) -> None:
        self._store = store
        self._opener = opener  # injectable for hermetic tests

    def _get(self, path: str, params: dict) -> tuple:
        if self._opener is not None:
            return self._opener(path, params)
        qs = urllib.parse.urlencode(params)
        url = "https://%s%s?%s" % (self.INSTANCES_HOST, path, qs)
        req = urllib.request.Request(url, headers={"user-agent": "openhome-server-py/0.1"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.status, resp.read().decode("utf-8")
        except Exception as e:  # offline: callers serve stale cache
            raise FetchError(str(e))

    def refresh_model_index(self, types: list = None) -> int:
        """Rebuild model->URN map, paginated by device type. Returns count."""
        if types is None:
            types = self.device_types()
        index = {}
        count = 0
        for t in types:
            try:
                status, raw = self._get(
                    "/miot-spec-v2/instances", {"status": "released", "type": t}
                )
            except FetchError:
                continue
            if status != 200:
                continue
            body = json.loads(raw)
            for inst in body.get("instances") or []:
                model = inst.get("model")
                urn = inst.get("type")
                if model and urn:
                    index[model] = urn
                    count += 1
        self._store.meta_set(self.META_INDEX_JSON, json.dumps(index))
        self._store.meta_set(
            self.META_INDEX_KEY, datetime.datetime.now().astimezone().isoformat()
        )
        return count

    def device_types(self) -> list:
        try:
            status, raw = self._get("/miot-spec-v2/spec/devices", {})
        except FetchError as e:
            raise RuntimeError("miot-spec.org unreachable (%s)" % e)
        if status != 200:
            raise RuntimeError("miot-spec.org unreachable (%s)" % status)
        return list(json.loads(raw)["types"])

    def _model_index(self) -> dict:
        raw = self._store.meta_get(self.META_INDEX_JSON)
        if raw is None:
            return {}
        return dict(json.loads(raw))

    def resolve_urn(self, model: str):
        return self._model_index().get(model)

    def spec_for(self, model: str, refresh: bool = False):
        """Full cached spec for model, or None when unknown/offline+uncached."""
        if not refresh:
            rows = self._store.query("SELECT spec_json FROM specs WHERE model = ?", (model,))
            if rows:
                return json.loads(rows[0]["spec_json"])
        urn = self.resolve_urn(model)
        if urn is None:
            return None
        return self.fetch_spec(model, urn)

    def fetch_spec(self, model: str, urn: str):
        try:
            status, raw = self._get("/miot-spec-v2/instance", {"type": urn})
        except FetchError:
            status, raw = None, None
        if status != 200 or raw is None:
            # Serve stale cache rather than failing offline.
            rows = self._store.query("SELECT spec_json FROM specs WHERE model = ?", (model,))
            return None if not rows else json.loads(rows[0]["spec_json"])
        spec = json.loads(raw)
        self._store.execute(
            "INSERT INTO specs (model, urn, spec_json, fetched_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(model) DO UPDATE SET urn = excluded.urn, "
            "spec_json = excluded.spec_json, fetched_at = excluded.fetched_at",
            (model, urn, raw, _now_ms()),
        )
        return spec

    @staticmethod
    def to_local_spec(model: str, full: dict) -> dict:
        """Minimal projection the Flutter app renders from offline.

        Mirrors `LocalSpec` in the app (openhome/lib/models/device.dart).
        """
        services = []
        for s in full.get("services") or []:
            props = []
            for p in s.get("properties") or []:
                prop = {
                    "siid": s["iid"],
                    "piid": p["iid"],
                    "name": p.get("description") or p.get("type"),
                    "format": p.get("format") or "string",
                    "access": p.get("access") or ["read"],
                }
                if p.get("unit") is not None:
                    prop["unit"] = p["unit"]
                if p.get("value-list") is not None:
                    prop["value-list"] = p["value-list"]
                if p.get("value-range") is not None:
                    prop["value-range"] = p["value-range"]
                props.append(prop)
            services.append(
                {
                    "siid": s["iid"],
                    "name": s.get("description") or s.get("type"),
                    "properties": props,
                }
            )
        return {"model": model, "services": services}
