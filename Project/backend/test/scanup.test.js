'use strict';
// Scan-upgrade backend: holder photo round-trip, SAME_POST_RESCAN, risk
// scoring (unit + via /verify). Throwaway DB/keys/photos; real data untouched.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const TEST_DB = path.join(os.tmpdir(), `pressid-scanup-${process.pid}-${Date.now()}.db`);
const TEST_KEYS_DIR = path.join(os.tmpdir(), `pressid-scanup-keys-${process.pid}-${Date.now()}.d`);
fs.mkdirSync(TEST_KEYS_DIR, { recursive: true });
process.env.PRESSID_KEYS_DIR = TEST_KEYS_DIR;
process.env.PRESSID_DB = TEST_DB;
process.env.ALLOW_DEV_SECRET = process.env.ALLOW_DEV_SECRET || '1';
process.env.PRESSID_QUIET = process.env.PRESSID_QUIET || '1';
const app = require('../src/server');
const db = require('../src/db');
const { scoreRisk } = require('../src/risk');

let srv;
let BASE;
let adminToken;
let policeToken;

// 1x1 PNG + minimal JPEG (magic bytes only matter for content-type sniffing).
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fakejpegbytes')]);

async function json(method, p, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  return { status: res.status, headers: res.headers, data };
}

async function rawGet(p, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf };
}

function rmTestDb() {
  for (const f of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`, `${TEST_DB}-journal`]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
}

before(async () => {
  const hash = bcrypt.hashSync('admin123', 4);
  db.prepare('INSERT INTO users (username, password_hash, role, org_name, zone, active, created_at) VALUES (?,?,?,?,?,?,?)')
    .run('admin', hash, 'admin', '', '', 1, new Date().toISOString());
  srv = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => srv.once('listening', resolve));
  BASE = `http://127.0.0.1:${srv.address().port}/api`;
  const login = await json('POST', '/auth/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(login.status, 200);
  adminToken = login.data.token;
  const po = await json('POST', '/users', {
    token: adminToken,
    body: { username: 'scanup-police', password: 'longenough1', role: 'police', zone: 'north' },
  });
  assert.equal(po.status, 201);
  const plogin = await json('POST', '/auth/login', { body: { username: 'scanup-police', password: 'longenough1' } });
  assert.equal(plogin.status, 200);
  policeToken = plogin.data.token;
});

after(async () => {
  if (srv) await new Promise((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
  try { db.close(); } catch (_) {}
  rmTestDb();
  try { fs.rmSync(TEST_KEYS_DIR, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(path.join(path.dirname(TEST_DB), 'photos'), { recursive: true, force: true }); } catch (_) {}
});

async function mkCard({ org = 'Photo Org', zones = ['north'] } = {}) {
  const h = await json('POST', '/holders', { token: adminToken, body: { fullName: 'Scan Holder', org } });
  assert.equal(h.status, 201);
  const c = await json('POST', '/cards', { token: adminToken, body: { holderId: h.data.holder.id, validDays: 365, zones } });
  assert.equal(c.status, 201);
  return { holderId: h.data.holder.id, cardId: c.data.card.id, cardToken: c.data.token };
}

test('scanup: photo round-trip (upload PNG, GET bytes match + content-type)', async () => {
  const { holderId } = await mkCard();
  const dataUrl = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
  const up = await json('POST', `/holders/${holderId}/photo`, { token: adminToken, body: { dataUrl } });
  assert.equal(up.status, 200);
  assert.equal(up.data.photoHash, crypto.createHash('sha256').update(PNG_BYTES).digest('hex'));
  const get = await rawGet(`/holders/${holderId}/photo`, policeToken);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('content-type'), 'image/png');
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.deepEqual(get.buf, PNG_BYTES);
  // JPEG magic → image/jpeg.
  const jUp = await json('POST', `/holders/${holderId}/photo`, {
    token: adminToken, body: { dataUrl: `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}` },
  });
  assert.equal(jUp.status, 200);
  const jGet = await rawGet(`/holders/${holderId}/photo`, adminToken);
  assert.equal(jGet.status, 200);
  assert.equal(jGet.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(jGet.buf, JPEG_BYTES);
});

test('scanup: photo 404s (no photo; missing file; issuer cross-org 403)', async () => {
  const { holderId } = await mkCard();
  const none = await rawGet(`/holders/${holderId}/photo`, policeToken);
  assert.equal(none.status, 404);
  // Hash set but file missing → 404.
  db.prepare('UPDATE holders SET photo_hash = ? WHERE id = ?')
    .run('a'.repeat(64), holderId);
  const missing = await rawGet(`/holders/${holderId}/photo`, policeToken);
  assert.equal(missing.status, 404);

  // Cross-org issuer → 403; police cross-org → 200 path (404 here, not 403).
  const iss = await json('POST', '/users', {
    token: adminToken, body: { username: 'scanup-issuer', password: 'longenough1', role: 'issuer', orgName: 'Other Org' },
  });
  assert.equal(iss.status, 201);
  const ilogin = await json('POST', '/auth/login', { body: { username: 'scanup-issuer', password: 'longenough1' } });
  const otherGet = await rawGet(`/holders/${holderId}/photo`, ilogin.data.token);
  assert.equal(otherGet.status, 403);
  const own = await mkCard({ org: 'Other Org' });
  const ownUp = await json('POST', `/holders/${own.holderId}/photo`, {
    token: ilogin.data.token, body: { dataUrl: `data:image/png;base64,${PNG_BYTES.toString('base64')}` },
  });
  assert.equal(ownUp.status, 200);
  const ownGet = await rawGet(`/holders/${own.holderId}/photo`, ilogin.data.token);
  assert.equal(ownGet.status, 200);
  assert.deepEqual(ownGet.buf, PNG_BYTES);
});

test('scanup: SAME_POST_RESCAN (two scans same zone, different coords → flag, still valid)', async () => {
  const { cardId, cardToken } = await mkCard();
  // Seed a prior scan 5 min ago from the same post (officer zone 'north'):
  // back-to-back verifies with distinct coords would trip IMPOSSIBLE_TRAVEL
  // (near-zero dt), so the prior scan is backdated instead.
  db.prepare('INSERT INTO scans (card_id, at, lat, lng, result, flags, by_user, officer_zone) VALUES (?,?,?,?,?,?,?,?)')
    .run(cardId, new Date(Date.now() - 5 * 60000).toISOString(), 28.61, 77.2, 'valid', '[]', 1, 'north');
  const v = await json('POST', '/verify', { token: policeToken, body: { token: cardToken, lat: 28.62, lng: 77.21 } });
  assert.equal(v.data.valid, true, `rescan must stay valid: ${JSON.stringify(v.data.reasons)}`);
  assert.ok(v.data.reasons.includes('SAME_POST_RESCAN'), `expected SAME_POST_RESCAN, got ${JSON.stringify(v.data.reasons)}`);
  // Persisted into the scan row so timeline/history surface it (iteration B).
  const tl = await json('GET', `/scans/${cardId}/timeline`, { token: policeToken });
  const latest = tl.data[tl.data.length - 1];
  const tlFlags = latest.flags || latest.alerts || [];
  assert.ok(tlFlags.includes('SAME_POST_RESCAN'), `timeline must carry rescan flag, got ${JSON.stringify(tlFlags)}`);
  // lastScans rows carry flags + result for the gate table (iteration G).
  const ls = v.data.lastScans;
  assert.ok(Array.isArray(ls) && ls.length > 0, 'expected lastScans rows');
  assert.ok(ls[0].flags.includes('SAME_POST_RESCAN'), 'latest lastScans row must carry rescan flag');
  assert.equal(v.data.risk.score, 75);
});

test('scanup: verify shape gains risk + photoUrl (holder id from card)', async () => {
  const { holderId, cardToken } = await mkCard();
  const v = await json('POST', '/verify', { token: policeToken, body: { token: cardToken } });
  assert.equal(v.data.valid, true);
  assert.deepEqual(v.data.risk, { score: 100, level: 'low', drivers: [] });
  assert.equal(v.data.card.holderId, holderId, 'verify card must carry holderId (photo pane depends on it)');
  assert.equal(v.data.photoUrl, `/api/holders/${holderId}/photo`);
  const bad = await json('POST', '/verify', { token: policeToken, body: { token: 'bogus' } });
  assert.equal(bad.data.valid, false);
  assert.equal(bad.data.photoUrl, null);
  assert.equal(bad.data.risk.level, 'high');
});

test('scanup: risk vectors via verify (forged→0, revoked→5, expired→20, impossible-travel→watch)', async () => {
  // Forged signature → INVALID_SIGNATURE → 0/high.
  const forged = await json('POST', '/verify', { token: policeToken, body: { token: 'P1.AA.BB' } });
  assert.equal(forged.data.valid, false);
  assert.ok(forged.data.reasons.includes('INVALID_SIGNATURE'));
  assert.equal(forged.data.risk.score, 0);
  assert.equal(forged.data.risk.level, 'high');
  assert.deepEqual(forged.data.risk.drivers, ['INVALID_SIGNATURE']);
  // Revoked → 5/high.
  const rc = await mkCard();
  await json('POST', `/cards/${rc.cardId}/revoke`, { token: adminToken, body: { reason: 'risk test' } });
  const rv = await json('POST', '/verify', { token: policeToken, body: { token: rc.cardToken } });
  assert.ok(rv.data.reasons.includes('REVOKED'));
  assert.equal(rv.data.risk.score, 5);
  assert.equal(rv.data.risk.level, 'high');
  // Expired (status flip, not valid_till edit — the token cross-checks
  // signed validTill vs DB, so a direct valid_till edit reads as tamper) → 20/high.
  const ec = await mkCard();
  db.prepare("UPDATE cards SET status = 'expired' WHERE id = ?").run(ec.cardId);
  const ev = await json('POST', '/verify', { token: policeToken, body: { token: ec.cardToken } });
  assert.ok(ev.data.reasons.includes('STATUS_EXPIRED'));
  assert.equal(ev.data.risk.score, 20);
  assert.equal(ev.data.risk.level, 'high');
  // Impossible travel alone: prior scan 30 min ago far away (speed >500km/h
  // consecutive, but the pair is >10 min apart so no SIMULTANEOUS_FAR) → 70/watch.
  const tc = await mkCard({ zones: [] });
  db.prepare('INSERT INTO scans (card_id, at, lat, lng, result, flags, by_user, officer_zone) VALUES (?,?,?,?,?,?,?,?)')
    .run(tc.cardId, new Date(Date.now() - 30 * 60000).toISOString(), 19.07, 72.87, 'valid', '[]', 1, 'far-zone');
  const tv = await json('POST', '/verify', { token: policeToken, body: { token: tc.cardToken, lat: 28.61, lng: 77.23 } });
  assert.ok(tv.data.alerts.includes('IMPOSSIBLE_TRAVEL'), `expected IMPOSSIBLE_TRAVEL, got ${JSON.stringify(tv.data.alerts)}`);
  assert.equal(tv.data.risk.score, 70);
  assert.equal(tv.data.risk.level, 'watch');
  assert.deepEqual(tv.data.risk.drivers, ['IMPOSSIBLE_TRAVEL']);
});

test('scanup: scoreRisk unit vectors', async () => {
  assert.deepEqual(scoreRisk({ reasons: [], alerts: [] }), { score: 100, level: 'low', drivers: [] });
  assert.equal(scoreRisk({ reasons: ['OUT_OF_ZONE'], alerts: [] }).score, 40);
  assert.equal(scoreRisk({ reasons: ['OUT_OF_ZONE'], alerts: [] }).level, 'high');
  assert.equal(scoreRisk({ reasons: ['REVOKED', 'OUT_OF_ZONE'], alerts: [] }).score, 5);
  assert.deepEqual(
    scoreRisk({ reasons: ['OUT_OF_ZONE'], alerts: ['IMPOSSIBLE_TRAVEL', 'VELOCITY_BURST'] }).drivers,
    ['OUT_OF_ZONE', 'IMPOSSIBLE_TRAVEL', 'VELOCITY_BURST'],
  );
  assert.equal(scoreRisk({ reasons: ['OUT_OF_ZONE'], alerts: ['IMPOSSIBLE_TRAVEL', 'VELOCITY_BURST'] }).score, 0);
  assert.equal(scoreRisk({ reasons: ['UNKNOWN_ZONE', 'DUPLICATE_SCAN', 'EVENT_ACTIVE'], alerts: [] }).score, 100);
});

test('scanup: flushed offline scan keeps client time within bounds (iteration V)', async () => {
  const { cardId, cardToken } = await mkCard();
  const backdated = new Date(Date.now() - 2 * 3600000).toISOString();
  const v = await json('POST', '/verify', { token: policeToken, body: { token: cardToken, lat: 1, lng: 2, at: backdated } });
  assert.equal(v.data.valid, true);
  const row = db.prepare('SELECT at FROM scans WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(cardId);
  assert.equal(row.at, backdated, 'server must honor bounded client scan time');
  const ancient = new Date(Date.now() - 48 * 3600000).toISOString();
  await json('POST', '/verify', { token: policeToken, body: { token: cardToken, lat: 3, lng: 4, at: ancient } });
  const row2 = db.prepare('SELECT at FROM scans WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(cardId);
  assert.ok(Date.parse(row2.at) > Date.now() - 60000, 'out-of-bounds client time must fall back to server time');
});

test('scanup: scan reads order by scan time, not insert id (iteration W)', async () => {
  const { cardId, cardToken } = await mkCard();
  // New scan now, then a backdated flush: chrono order must put the
  // backdated row after (older than) the fresh one in DESC reads.
  await json('POST', '/verify', { token: policeToken, body: { token: cardToken, lat: 10, lng: 20 } });
  const old = new Date(Date.now() - 3600000).toISOString();
  await json('POST', '/verify', { token: policeToken, body: { token: cardToken, lat: 11, lng: 21, at: old } });
  const v = await json('POST', '/verify', { token: policeToken, body: { token: cardToken, lat: 12, lng: 22 } });
  const ats = v.data.lastScans.map((s) => s.at);
  const sorted = [...ats].sort().reverse();
  assert.deepEqual(ats, sorted, `lastScans must be chrono-DESC, got ${JSON.stringify(ats)}`);
  const list = await json('GET', `/scans?cardId=${cardId}`, { token: policeToken });
  const lats = list.data.map((s) => s.at);
  assert.deepEqual(lats, [...lats].sort().reverse(), 'GET /scans must be chrono-DESC');
});
