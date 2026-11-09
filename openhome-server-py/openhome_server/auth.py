"""Local accounts. Port of openhome-server/lib/src/auth.dart.

Deliberately NOT Xiaomi OAuth: devices stay bound to Xiaomi's cloud
account-side, but YOUR server owns who in your home may drive them
over the LAN.

Hash format is identical to Dart (same salts, same hex digests), so
passwords set by the Dart server keep working here. Pepper comes from
the `OPENHOME_PEPPER` environment variable at runtime (Dart read it as
a compile-time define defaulting to '').
"""

from __future__ import annotations

import hashlib
import hmac
import os
import time
import uuid


def _now_ms() -> int:
    import time as _t

    return int(_t.time() * 1000)


class Auth:
    def __init__(self, store) -> None:
        self._store = store

    @staticmethod
    def hash_password(username: str, password: str, pepper: str = None) -> str:
        # Per-user salt keeps two identical passwords distinct. SHA-256 with a
        # strong unique password is adequate for a LAN server; set a pepper
        # via env `OPENHOME_PEPPER` when exposed beyond localhost.
        if pepper is None:
            pepper = os.environ.get("OPENHOME_PEPPER", "")
        salt = hashlib.sha256(("openhome:%s" % username).encode("utf-8")).hexdigest()
        return hashlib.sha256(("%s:%s:%s" % (salt, password, pepper)).encode("utf-8")).hexdigest()

    @property
    def has_users(self) -> bool:
        return self._store.query("SELECT COUNT(*) AS c FROM users")[0]["c"] != 0

    def bootstrap(self, username: str, password: str) -> str:
        """First-run bootstrap. Raises RuntimeError once a user exists."""
        if self.has_users:
            raise RuntimeError("server already has users")
        return self._create_user(username, password)

    def _create_user(self, username: str, password: str) -> str:
        uid = str(uuid.uuid4())
        self._store.execute(
            "INSERT INTO users (id, username, pass_hash, created_at) VALUES (?, ?, ?, ?)",
            (uid, username, self.hash_password(username, password), _now_ms()),
        )
        return self._issue_token(uid, "bootstrap")

    def create_user(self, username: str, password: str) -> str:
        return self._create_user(username, password)

    def _issue_token(self, user_id: str, label: str) -> str:
        token = uuid.uuid4().hex + uuid.uuid4().hex
        self._store.execute(
            "INSERT INTO tokens (token, user_id, created_at, label) VALUES (?, ?, ?, ?)",
            (token, user_id, _now_ms(), label),
        )
        return token

    def login(self, username: str, password: str):
        """Returns a fresh token for valid credentials, else None."""
        rows = self._store.query("SELECT id, pass_hash FROM users WHERE username = ?", (username,))
        if not rows:
            return None
        want = rows[0]["pass_hash"]
        if not hmac.compare_digest(str(want), self.hash_password(username, password)):
            return None
        return self._issue_token(rows[0]["id"], "login")

    def user_for_token(self, bearer) -> str | None:
        if not bearer:
            return None
        rows = self._store.query("SELECT user_id FROM tokens WHERE token = ?", (bearer,))
        return None if not rows else rows[0]["user_id"]

    def revoke(self, token: str) -> None:
        self._store.execute("DELETE FROM tokens WHERE token = ?", (token,))
