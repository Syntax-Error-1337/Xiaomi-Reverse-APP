'use strict';
// Cycle 29 throwaway benchmark for the /api/verify SQL hot path.
// Uses a throwaway DB via PRESSID_DB (never touches the real DB).
// Seeds 1 card + 5000 scans, then times 100 iterations of the exact query
// sequence from POST /api/verify in src/server.js:
//   touchExpiry guard + card/holder lookups + COUNT (first-scan) +
//   dup-scan window select + scan INSERT + last-20 + last-id + last-5.
// Also prints EXPLAIN QUERY PLAN for the 3 hot SELECTs.
// Exits non-zero if p95 >= 50ms.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_DB = path.join(os.tmpdir(), `pressid-bench-${process.pid}-${Date.now()}.db`);
process.env.PRESSID_DB = TEST_DB;
process.env.ALLOW_DEV_SECRET = process.env.ALLOW_DEV_SECRET || '1';
process.env.PRESSID_QUIET = '1';
const db = require('../src/db');

function rmDb() {
  for (const f of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`, `${TEST_DB}-journal`]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
}

// ---- seed ----
const nowMs = Date.now();
const iso = (ms) => new Date(ms).toISOString();
db.prepare(
  "INSERT INTO users (username, password_hash, role, org_name, zone, active, created_at) VALUES ('bench-officer','x','police','','south',1,?)"
).run(iso(nowMs));
const officerId = db.prepare('SELECT id FROM users WHERE username = ?').get('bench-officer').id;
db.prepare(
  'INSERT INTO holders (user_id, full_name, org, designation, id_ref, photo_hash, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)'
).run(null, 'Bench Holder', 'Bench Org', 'Reporter', 'ID-1', '', null, iso(nowMs));
const holderId = db.prepare("SELECT id FROM holders WHERE full_name = 'Bench Holder'").get().id;
db.prepare(
  "INSERT INTO cards (holder_id, valid_from, valid_till, zones, status, nonce, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)"
).run(holderId, iso(nowMs - 86400000), iso(nowMs + 30 * 86400000), '["south"]', 'active', 'n0', null, iso(nowMs));
const cardId = db.prepare('SELECT id FROM cards WHERE holder_id = ?').get(holderId).id;

const N_SEED = 5000;
const ins = db.prepare('INSERT INTO scans (card_id, at, lat, lng, result, flags, by_user, officer_zone) VALUES (?,?,?,?,?,?,?,?)');
db.exec('BEGIN');
for (let i = 0; i < N_SEED; i++) {
  // spread over the last 10 days so the 60s dup-scan window is selective
  const at = iso(nowMs - Math.floor(Math.random() * 10 * 86400000));
  ins.run(cardId, at, 10 + Math.random(), 20 + Math.random(), 'valid', '[]', officerId, 'south');
}
db.exec('COMMIT');

// ---- one verify-hot-path iteration (mirrors src/server.js) ----
function verifyIteration(lat, lng) {
  const t0 = process.hrtime.bigint();
  db.touchExpiry();
  const cardDb = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  db.prepare('SELECT * FROM holders WHERE id = ?').get(cardDb.holder_id);
  db.prepare('SELECT zone FROM users WHERE id = ?').get(officerId);
  db.prepare('SELECT COUNT(*) AS c FROM scans WHERE card_id = ?').get(cardId);
  const cutoff = new Date(nowMs - 60000).toISOString();
  db.prepare('SELECT lat, lng FROM scans WHERE card_id = ? AND at >= ?').all(cardId, cutoff);
  db.prepare('INSERT INTO scans (card_id, at, lat, lng, result, flags, by_user, officer_zone) VALUES (?,?,?,?,?,?,?,?)')
    .run(cardId, new Date().toISOString(), lat, lng, 'valid', '[]', officerId, 'south');
  db.prepare('SELECT lat, lng, at FROM scans WHERE card_id = ? ORDER BY id DESC LIMIT 20').all(cardId);
  const lastId = db.prepare('SELECT id FROM scans WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(cardId).id;
  db.prepare('SELECT at, lat, lng, officer_zone FROM scans WHERE card_id = ? ORDER BY id DESC LIMIT 5').all(cardId);
  void lastId;
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6; // ms
}

// warmup (page cache, wal)
for (let i = 0; i < 5; i++) verifyIteration(10.5, 20.5);

const N = 100;
const times = [];
for (let i = 0; i < N; i++) times.push(verifyIteration(11 + i * 1e-4, 21 + i * 1e-4));
times.sort((a, b) => a - b);
const median = times[Math.floor(N / 2)];
const p95 = times[Math.floor(N * 0.95) - 1] ?? times[N - 1];
const mean = times.reduce((a, b) => a + b, 0) / N;
console.log(`seed_scans=${N_SEED} iters=${N}`);
console.log(`median_ms=${median.toFixed(3)} p95_ms=${p95.toFixed(3)} mean_ms=${mean.toFixed(3)} min_ms=${times[0].toFixed(3)} max_ms=${times[N - 1].toFixed(3)}`);

console.log('--- EXPLAIN QUERY PLAN ---');
const explained = [
  ['count_first_scan', 'SELECT COUNT(*) AS c FROM scans WHERE card_id = ?', [cardId]],
  ['recent20', 'SELECT lat, lng, at FROM scans WHERE card_id = ? ORDER BY id DESC LIMIT 20', [cardId]],
  ['dup_window', 'SELECT lat, lng FROM scans WHERE card_id = ? AND at >= ?', [cardId, new Date(nowMs - 60000).toISOString()]],
  ['touch_guard', "SELECT COUNT(*) AS c FROM cards WHERE status = 'active' AND valid_till < ?", [iso(nowMs)]],
];
for (const [name, sql, params] of explained) {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
  console.log(`${name}: ${rows.map((r) => r.detail).join(' | ')}`);
}
console.log('--- indexes ---');
for (const r of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('scans','cards','holders') ORDER BY name").all()) {
  console.log(`${r.name}: ${r.sql}`);
}

rmDb();
if (p95 >= 50) {
  console.error(`FAIL: p95 ${p95.toFixed(3)}ms >= 50ms`);
  process.exit(1);
}
console.log('PASS: p95 < 50ms');
