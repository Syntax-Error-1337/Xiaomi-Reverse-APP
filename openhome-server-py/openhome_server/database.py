"""SQLite store. Port of openhome-server/lib/src/database.dart.

Same schema and SQL, so a database file written by the Dart server opens
here unchanged and vice versa. Thread-safe: one RLock guards the single
connection (the HTTP server is threaded; Dart is single-isolate).
"""

from __future__ import annotations

import datetime
import sqlite3
import threading
import time

_SCHEMA = """
CREATE TABLE IF NOT EXISTS _meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ip TEXT NOT NULL,
  token_hex TEXT NOT NULL,
  model TEXT,
  urn TEXT,
  room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS specs (
  model TEXT PRIMARY KEY,
  urn TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger_json TEXT NOT NULL,
  actions_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  device_id TEXT,
  detail TEXT NOT NULL DEFAULT ''
);
"""


def _now_ms() -> int:
    return int(time.time() * 1000)


class Store:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db
        self._lock = threading.RLock()
        with self._lock:
            self._db.executescript(_SCHEMA)
            self._db.commit()

    @classmethod
    def open(cls, path: str) -> "Store":
        db = sqlite3.connect(path, check_same_thread=False)
        return cls(db)

    @classmethod
    def memory(cls) -> "Store":
        db = sqlite3.connect(":memory:", check_same_thread=False)
        return cls(db)

    def query(self, sql: str, args: tuple = ()) -> list:
        with self._lock:
            cur = self._db.execute(sql, args)
            cols = [d[0] for d in cur.description] if cur.description else []
            return [dict(zip(cols, row)) for row in cur.fetchall()]

    def execute(self, sql: str, args: tuple = ()) -> None:
        with self._lock:
            self._db.execute(sql, args)
            self._db.commit()

    def log_event(self, kind: str, device_id=None, detail: str = "") -> None:
        self.execute(
            "INSERT INTO events (ts, kind, device_id, detail) VALUES (?, ?, ?, ?)",
            (_now_ms(), kind, device_id, detail),
        )

    def meta_get(self, k: str):
        rows = self.query("SELECT v FROM _meta WHERE k = ?", (k,))
        return None if not rows else rows[0]["v"]

    def meta_set(self, k: str, v: str) -> None:
        self.execute(
            "INSERT INTO _meta (k, v) VALUES (?, ?) "
            "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            (k, v),
        )

    def export_all(self) -> dict:
        out = {}
        for t in ("users", "rooms", "devices", "specs", "scenes", "events"):
            out[t] = self.query("SELECT * FROM %s" % t)
        out["exported_at"] = datetime.datetime.now().astimezone().isoformat()
        return out

    def export_json(self) -> str:
        import json

        return json.dumps(self.export_all())

    def close(self) -> None:
        with self._lock:
            self._db.close()
