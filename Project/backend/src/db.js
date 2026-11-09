'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
// PRESSID_DB overrides the sqlite file path (regression tests point it at a throwaway file).
const DB_PATH = process.env.PRESSID_DB || path.join(DATA_DIR, 'pressid.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  org_name TEXT DEFAULT '',
  zone TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS holders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE,
  full_name TEXT NOT NULL,
  org TEXT NOT NULL,
  designation TEXT DEFAULT '',
  id_ref TEXT DEFAULT '',
  photo_hash TEXT DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holder_id INTEGER NOT NULL,
  valid_from TEXT NOT NULL,
  valid_till TEXT NOT NULL,
  zones TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  revoke_reason TEXT DEFAULT '',
  nonce TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  lat REAL,
  lng REAL,
  result TEXT NOT NULL,
  flags TEXT DEFAULT '[]',
  by_user INTEGER
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  by_user INTEGER,
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  prev_hash TEXT,
  entry_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_cards_holder ON cards(holder_id);
CREATE INDEX IF NOT EXISTS idx_scans_card ON scans(card_id);
CREATE INDEX IF NOT EXISTS idx_scans_at ON scans(at);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
`);
// ---- cycle 12: event-scoped press passes (event_name + event_end) ----
(function migrateCycle12() {
  const cols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
  if (!cols.includes('event_name')) db.exec('ALTER TABLE cards ADD COLUMN event_name TEXT');
  if (!cols.includes('event_end')) db.exec('ALTER TABLE cards ADD COLUMN event_end TEXT');
})();
// ---- cycle 14: card replacement chain (replaces_id → old card id) ----
(function migrateCycle14() {
  const cols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
  if (!cols.includes('replaces_id')) db.exec('ALTER TABLE cards ADD COLUMN replaces_id INTEGER');
  // One replacement per old card (cycle 47: prevents chain forks). Partial
  // index — NULLs (normal issues) are unaffected.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_replaces ON cards(replaces_id) WHERE replaces_id IS NOT NULL');
})();

// ---- cycle 11: alert triage (open|acked|resolved) ----
(function migrateCycle11() {
  const cols = db.prepare('PRAGMA table_info(scans)').all().map((c) => c.name);
  if (!cols.includes('triage')) db.exec("ALTER TABLE scans ADD COLUMN triage TEXT DEFAULT 'open'");
  if (!cols.includes('triaged_by')) db.exec('ALTER TABLE scans ADD COLUMN triaged_by INTEGER');
  if (!cols.includes('triaged_at')) db.exec('ALTER TABLE scans ADD COLUMN triaged_at TEXT');
  try { db.exec("UPDATE scans SET triage = 'open' WHERE triage IS NULL"); } catch (_) {}
})();

// ---- cycle 25: scan provenance (officer zone at scan time) ----
(function migrateCycle25() {
  const cols = db.prepare('PRAGMA table_info(scans)').all().map((c) => c.name);
  if (!cols.includes('officer_zone')) db.exec('ALTER TABLE scans ADD COLUMN officer_zone TEXT');
})();
// ---- cycle 29: verify hot-path indexes ----
// Existing DBs keep the legacy single-column idx_scans_card (the base-schema
// IF NOT EXISTS is a no-op for them), so upgrade here to (card_id, id DESC):
// the card-scoped ORDER BY id DESC LIMIT n hot queries then walk one index.
// Also adds the (status, valid_till) touchExpiry sweep index.
// holders.user_id is UNIQUE (autoindex covers it); cards(holder_id) already
// indexed in the base schema — both re-checked here, never duplicated.
(function migrateCycle29() {
  const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index'").all();
  const has = (n) => idx.some((r) => r.name === n);
  if (has('idx_scans_card') && !has('idx_scans_card_id')) {
    db.exec('DROP INDEX idx_scans_card;');
    db.exec('CREATE INDEX idx_scans_card_id ON scans(card_id, id DESC);');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_scans_card_id ON scans(card_id, id DESC);');
  db.exec("CREATE INDEX IF NOT EXISTS idx_cards_status_till ON cards(status, valid_till);");
  if (!has('idx_cards_holder')) db.exec('CREATE INDEX IF NOT EXISTS idx_cards_holder ON cards(holder_id);');
})();

// ---- cycle 39: voluntary press device check-in (signal only, no validity) ----
// holders.device_id = client-generated UUID stored on check-in; device_at =
// ISO timestamp of the last check-in. Printed cards keep working when NULL;
// cardView/verify surface holderCheckedIn (device_id non-null) as an
// informational chip only.
(function migrateCycle39() {
  const cols = db.prepare('PRAGMA table_info(holders)').all().map((c) => c.name);
  if (!cols.includes('device_id')) db.exec('ALTER TABLE holders ADD COLUMN device_id TEXT');
  if (!cols.includes('device_at')) db.exec('ALTER TABLE holders ADD COLUMN device_at TEXT');
})();

 // ---- cycle 5: issuer quotas + forced press password rotation ----
  (function migrateCycle5() {
   const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
   if (!cols.includes('quota')) db.exec('ALTER TABLE users ADD COLUMN quota INTEGER');
   if (!cols.includes('must_change')) db.exec('ALTER TABLE users ADD COLUMN must_change INTEGER DEFAULT 0');
  })();

// ---- hash-chained audit log (cycle 4) ----
const AUDIT_GENESIS = 'GENESIS';
function auditHash(prevHash, at, byUser, action, detail) {
  const by = (byUser === null || byUser === undefined) ? '' : String(byUser);
  const det = (detail === null || detail === undefined) ? '' : String(detail);
  return crypto.createHash('sha256')
    .update(String(prevHash) + '|' + String(at) + '|' + by + '|' + String(action) + '|' + det)
    .digest('hex');
}
db.AUDIT_GENESIS = AUDIT_GENESIS;
db.auditHash = auditHash;

// Migrate pre-chain databases: add the chain columns if missing, then
// backfill hashes for legacy rows oldest→newest (continuing any existing chain).
(function migrateAuditChain() {
  const cols = db.prepare('PRAGMA table_info(audit)').all().map((c) => c.name);
  if (!cols.includes('prev_hash')) db.exec('ALTER TABLE audit ADD COLUMN prev_hash TEXT');
  if (!cols.includes('entry_hash')) db.exec('ALTER TABLE audit ADD COLUMN entry_hash TEXT');
  const last = db.prepare('SELECT entry_hash FROM audit WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1').get();
  let prev = (last && last.entry_hash) || AUDIT_GENESIS;
  const missing = db.prepare('SELECT id, at, by_user, action, detail FROM audit WHERE entry_hash IS NULL ORDER BY id ASC').all();
  if (missing.length > 0) {
    const upd = db.prepare('UPDATE audit SET prev_hash = ?, entry_hash = ? WHERE id = ?');
    for (const r of missing) {
      const h = auditHash(prev, r.at, r.by_user, r.action, r.detail);
      upd.run(prev, h, r.id);
      prev = h;
    }
  }
})();

function touchExpiry() {
  // Cycle 29 fast path: same semantics, but skip the UPDATE write-lock when no
  // active card could be expired. The guard SELECT rides the
  // idx_cards_status_till index; statement order is preserved for tests.
  const iso = new Date().toISOString();
  try {
    const due = db.prepare("SELECT COUNT(*) AS c FROM cards WHERE status = 'active' AND valid_till < ?").get(iso).c;
    if (due > 0) {
      db.prepare("UPDATE cards SET status = 'expired' WHERE status = 'active' AND valid_till < ?")
        .run(iso);
    }
  } catch (_) {}
  try {
    db.prepare("UPDATE cards SET status = 'expired' WHERE status = 'active' AND event_end IS NOT NULL AND event_end != '' AND event_end < ?")
      .run(iso);
  } catch (_) {}
}
db.touchExpiry = touchExpiry;

module.exports = db;
