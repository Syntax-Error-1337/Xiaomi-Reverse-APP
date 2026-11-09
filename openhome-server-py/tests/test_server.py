"""Ports of openhome-server/test/server_test.dart + region_free_test.dart.

Stdlib unittest, no dependencies. Mirrors the Dart cases 1:1:
MiioPacket vectors (incl. the pinned known-answer ciphertext), Auth,
API bootstrap->devices->scenes->events->backup, to_local_spec, and the
region-free source/schema sweep.
"""

from __future__ import annotations

import json
import os
import re
import unittest

from openhome_server import Api, Auth, MiioPacket, SpecCache, Store

_HERE = os.path.dirname(os.path.abspath(__file__))
_PKG = os.path.join(os.path.dirname(_HERE), "openhome_server")


def _hex(s: str) -> bytes:
    return bytes.fromhex(s)


def failing_opener(path, params):
    raise AssertionError("offline")


def call(api: Api, method: str, target: str, body=None, token: str = None):
    headers = {}
    if body is not None:
        headers["content-type"] = "application/json"
    if token is not None:
        headers["authorization"] = "Bearer " + token
    raw = json.dumps(body).encode() if body is not None else b""
    status, payload = api.dispatch(method, target, headers, raw)
    return status, json.loads(json.dumps(payload))


def make_api():
    store = Store.memory()
    auth = Auth(store)
    specs = SpecCache(store, opener=failing_opener)
    return store, auth, specs, Api(store, auth, specs)


class TestMiioPacket(unittest.TestCase):
    TOKEN = _hex("00112233445566778899aabbccddeeff")

    def test_hello_shape(self):
        h = MiioPacket.hello()
        self.assertEqual(len(h), 32)
        self.assertEqual(int.from_bytes(h[:2], "big"), 0x2131)
        self.assertEqual(h[16:], b"\xff" * 16)

    def test_round_trip_multi_block(self):
        payload = bytes(i & 0xFF for i in range(200))
        pkt = MiioPacket.encrypt(payload, self.TOKEN, device_id=7, timestamp=9)
        self.assertEqual(MiioPacket.decrypt(pkt, self.TOKEN), payload)
        self.assertEqual(MiioPacket.device_id_of(pkt), 7)
        self.assertEqual(MiioPacket.timestamp_of(pkt), 9)

    def test_known_answer_ciphertext(self):
        # Pinned 2026-10-14 against pointycastle AESEngine. If this changes,
        # the wire format changed and real devices will reject packets.
        pkt = MiioPacket.encrypt(
            "0123456789abcdef".encode(), self.TOKEN,
            device_id=0x01020304, timestamp=0x05060708,
        )
        self.assertEqual(
            pkt.hex(),
            "21310040000000000102030405060708"
            "b4521e067b08e0a7ca3c1d8b3e76d8f8"
            "ce6c659add94d49a13a40a1b3eb5c39"
            "ec5d0fcb8fe39dee43637d0a4aa36fac7",
        )

    def test_rejects_wrong_token_bad_magic_tamper(self):
        pkt = MiioPacket.encrypt(b"\x01\x02\x03", self.TOKEN, device_id=1, timestamp=1)
        with self.assertRaises(ValueError):
            MiioPacket.decrypt(pkt, bytes(16))
        bad = bytearray(pkt)
        bad[0] = 0
        with self.assertRaises(ValueError):
            MiioPacket.decrypt(bytes(bad), self.TOKEN)
        tampered = bytearray(pkt)
        tampered[40] ^= 1
        with self.assertRaises(ValueError):
            MiioPacket.decrypt(bytes(tampered), self.TOKEN)


class TestAuth(unittest.TestCase):
    def test_bootstrap_once_login_revoke(self):
        store = Store.memory()
        auth = Auth(store)
        t0 = auth.bootstrap("admin", "password123")
        self.assertIsNotNone(auth.user_for_token(t0))
        with self.assertRaises(RuntimeError):
            auth.bootstrap("x", "password123")
        t1 = auth.login("admin", "password123")
        self.assertIsNotNone(t1)
        self.assertIsNone(auth.login("admin", "wrong"))
        self.assertIsNone(auth.login("nobody", "password123"))
        auth.revoke(t1)
        self.assertIsNone(auth.user_for_token(t1))


class TestApi(unittest.TestCase):
    def test_bootstrap_devices_scenes_events_backup(self):
        store, auth, specs, api = make_api()

        status, _ = call(api, "GET", "/api/devices")
        self.assertEqual(status, 401)

        status, _ = call(
            api, "POST", "/api/bootstrap",
            {"username": "a", "password": "short"},
        )
        self.assertEqual(status, 400)

        status, body = call(
            api, "POST", "/api/bootstrap",
            {"username": "admin", "password": "password123"},
        )
        self.assertEqual(status, 200)
        token = body["token"]

        status, _ = call(
            api, "POST", "/api/devices",
            {"ip": "192.168.1.2", "token": "zz"}, token=token,
        )
        self.assertEqual(status, 400)

        status, body = call(
            api, "POST", "/api/devices",
            {
                "name": "plug",
                "ip": "192.168.1.2",
                "token": "00" * 16,
                "model": "chuangmi.plug.v3",
            },
            token=token,
        )
        self.assertEqual(status, 200)
        dev_id = body["id"]

        status, body = call(api, "GET", "/api/devices", token=token)
        self.assertEqual(len(body), 1)

        status, body = call(
            api, "POST", "/api/scenes",
            {
                "name": "off",
                "actions": [
                    {"device": dev_id, "op": "set", "siid": 2, "piid": 1,
                     "value": False}
                ],
            },
            token=token,
        )
        self.assertEqual(status, 200)
        scene_id = body["id"]

        status, _ = call(
            api, "POST", "/api/scenes",
            {"name": "bad", "actions": [{"device": dev_id, "op": "explode"}]},
            token=token,
        )
        self.assertEqual(status, 400)

        status, _ = call(api, "POST", "/api/scenes/%s/run" % scene_id, token=token)
        self.assertEqual(status, 200)

        status, body = call(api, "GET", "/api/events", token=token)
        self.assertGreaterEqual(len(body), 2)

        status, body = call(api, "GET", "/api/backup", token=token)
        self.assertEqual(len(body["devices"]), 1)


class TestToLocalSpec(unittest.TestCase):
    def test_projects_full_spec_to_app_shape(self):
        local = SpecCache.to_local_spec("chuangmi.plug.v3", {
            "services": [
                {
                    "iid": 2,
                    "description": "switch",
                    "properties": [
                        {
                            "iid": 1,
                            "description": "on",
                            "format": "bool",
                            "access": ["read", "write", "notify"],
                        },
                        {
                            "iid": 2,
                            "description": "power-consumption",
                            "format": "float",
                            "unit": "watt",
                            "access": ["read"],
                        },
                    ],
                }
            ],
        })
        self.assertEqual(local["model"], "chuangmi.plug.v3")
        props = local["services"][0]["properties"]
        self.assertEqual(len(props), 2)
        self.assertEqual(props[0]["siid"], 2)
        self.assertEqual(props[0]["piid"], 1)
        self.assertEqual(props[0]["format"], "bool")
        self.assertEqual(props[-1]["unit"], "watt")


class TestRegionFree(unittest.TestCase):
    """The registry, spec cache, and scene runner must accept devices of ANY
    origin. The original app binds devices to a per-country server shard;
    this server has no country/shard column, no allowlist, no geo branch."""

    _PAT = re.compile(
        r"region|country|locale|serverCode|isChina|oversea|chinaOnly|CN_ONLY",
        re.IGNORECASE,
    )

    def test_no_region_symbols_in_package(self):
        hits = []
        for root, _, files in os.walk(_PKG):
            for f in files:
                if not f.endswith(".py"):
                    continue
                with open(os.path.join(root, f), encoding="utf-8") as fh:
                    for line in fh.read().splitlines():
                        stripped = line.split("#", 1)[0]
                        if '"""' in line or stripped.strip().startswith(("'", '"')):
                            continue  # docstrings/comments, not geo branches
                        if self._PAT.search(stripped):
                            hits.append("%s: %s" % (f, stripped.strip()))
        self.assertEqual(hits, [])

    def test_schema_has_no_region_column(self):
        with open(os.path.join(_PKG, "database.py"), encoding="utf-8") as fh:
            self.assertFalse(
                re.compile(r"region|shard|country|locale", re.IGNORECASE).search(
                    fh.read()
                )
            )

class TestConfig(unittest.TestCase):
    def test_env_wins_over_file(self):
        import tempfile
        from openhome_server import Config
        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False) as f:
            f.write("OPENHOME_PORT=9999\nOPENHOME_HOSTNAME=home.himanshu.pro\n")
            path = f.name
        try:
            os.environ["OPENHOME_ENV"] = path
            os.environ.pop("OPENHOME_PORT", None)
            c = Config.from_env()
            self.assertEqual(c.port, 9999)
            self.assertEqual(c.public_url, "https://home.himanshu.pro")
            self.assertFalse(c.tunnel_enabled)  # token absent -> LAN-only
            os.environ["OPENHOME_PORT"] = "1234"
            self.assertEqual(Config.from_env().port, 1234)
            os.environ["OPENHOME_TUNNEL_TOKEN"] = "tok"
            self.assertTrue(Config.from_env().tunnel_enabled)
        finally:
            for k in ("OPENHOME_ENV", "OPENHOME_PORT", "OPENHOME_TUNNEL_TOKEN"):
                os.environ.pop(k, None)
            os.unlink(path)


class TestTunnelSupervisor(unittest.TestCase):
    def test_shared_fate_stop_kills_child(self):
        import sys
        from openhome_server import TunnelSupervisor
        sup = TunnelSupervisor(
            8080, token="secret", bin=sys.executable,
            argv=["-c", "import time; time.sleep(60)"],
            logger=lambda *a: None,
        )
        self.assertTrue(sup.start())
        self.assertTrue(sup.running)
        child = sup._proc.pid
        sup.stop()
        self.assertFalse(sup.running)
        # child actually reaped, and token never leaked into argv
        self.assertRaises(OSError, os.kill, child, 0)
        self.assertNotIn("secret", " ".join(sup._argv))

    def test_no_token_no_child(self):
        from openhome_server import TunnelSupervisor
        sup = TunnelSupervisor(8080, token="", logger=lambda *a: None)
        self.assertFalse(sup.start())
        self.assertFalse(sup.running)


if __name__ == "__main__":
    unittest.main()
