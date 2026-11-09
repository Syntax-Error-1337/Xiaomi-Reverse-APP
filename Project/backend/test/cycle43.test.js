'use strict';
// PressID cycle-43: lock cycle-42 behavior changes (regression).
//
// 1. role-allowlist — POST /users rejects press-admin (400) + short
//    password (400); accepts issuer/police (201).
// 2. scans-gate — GET /scans as police without cardId → 403/400 (never
//    a 200 dump); with cardId → 200; admin without cardId → 200.
// 3. active-validation — PATCH unknown id → 404 with NO audit row
//    written; active:"false" string → 400 (not a deactivation).
// 4. quota-shape — GET /users includes quota (null default); quota
//    round-trip via PATCH shows in GET.
// 5. csv-injection — holder named `=cmd|'/c calc` → export cell starts
//    with `'` (neutralized).
//
// Throwaway DB + key dir; the real DB/keys are never touched.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_DB = path.join(os.tmpdir(), `pressid-cycle43-${process.pid}-${Date.now()}.db`);
const TEST_KEYS_DIR = path.join(os.tmpdir(), `pressid-cycle43-keys-${process.pid}-${Date.now()}.d`);
fs.mkdirSync(TEST_KEYS_DIR, { recursive: true });
process.env.PRESSID_KEYS_DIR = TEST_KEYS_DIR;
process.env.PRESSID_DB = TEST_DB;
process.env.ALLOW_DEV_SECRET = process.env.ALLOW_DEV_SECRET || '1';
process.env.PRESSID_QUIET = process.env.PRESSID_QUIET || '1';

const app = require('../src/server');
const db = require('../src/db');
const bcrypt = require('bcryptjs');

let srv;
let BASE;
let adminToken;
let policeToken;
let issuerId;

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
  return { status: res.status, data };
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
  assert.ok(adminToken);
});

after(async () => {
  if (srv) await new Promise((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
  try { db.close(); } catch (_) {}
  rmTestDb();
  try { fs.rmSync(TEST_KEYS_DIR, { recursive: true, force: true }); } catch (_) {}
});

test('cycle43: role allowlist — press-admin + short password rejected, issuer/police accepted', async () => {
  const pa = await json('POST', '/users', {
    token: adminToken,
    body: { username: 'u-pressadmin', password: 'longenough1', role: 'press-admin' },
  });
  assert.equal(pa.status, 400, `press-admin must be rejected, got ${pa.status} ${JSON.stringify(pa.data)}`);

  const short = await json('POST', '/users', {
    token: adminToken,
    body: { username: 'u-shortpw', password: 'short', role: 'issuer' },
  });
  assert.equal(short.status, 400, `short password must be rejected, got ${short.status}`);

  const iss = await json('POST', '/users', {
    token: adminToken,
    body: { username: 'u-issuer43', password: 'longenough1', role: 'issuer', orgName: 'Org43' },
  });
  assert.equal(iss.status, 201);
  issuerId = iss.data.id;

  const pol = await json('POST', '/users', {
    token: adminToken,
    body: { username: 'u-police43', password: 'longenough1', role: 'police', zone: 'Z1' },
  });
  assert.equal(pol.status, 201);

  const plogin = await json('POST', '/auth/login', { body: { username: 'u-police43', password: 'longenough1' } });
  assert.equal(plogin.status, 200);
  policeToken = plogin.data.token;
  assert.ok(policeToken);
});

test('cycle43: scans cardId gate — police needs cardId, admin keeps oversight', async () => {
  const bare = await json('GET', '/scans', { token: policeToken });
  assert.ok(bare.status === 403 || bare.status === 400, `police w/o cardId must not dump, got ${bare.status}`);

  const withId = await json('GET', '/scans?cardId=1', { token: policeToken });
  assert.equal(withId.status, 200);
  assert.ok(Array.isArray(withId.data));

  const adminBare = await json('GET', '/scans', { token: adminToken });
  assert.equal(adminBare.status, 200);
  assert.ok(Array.isArray(adminBare.data));
});

test('cycle43: active validation — unknown id 404 writes no audit; string "false" 400', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM audit').get().n;
  const miss = await json('PATCH', '/users/999999/active', { token: adminToken, body: { active: false } });
  assert.equal(miss.status, 404);
  const afterMiss = db.prepare('SELECT COUNT(*) AS n FROM audit').get().n;
  assert.equal(afterMiss, before, 'unknown-id PATCH must not write an audit row');

  const str = await json('PATCH', `/users/${issuerId}/active`, { token: adminToken, body: { active: 'false' } });
  assert.equal(str.status, 400);
  const row = db.prepare('SELECT active FROM users WHERE id = ?').get(issuerId);
  assert.equal(row.active, 1, 'string "false" must not deactivate the user');
});

test('cycle43: quota shape — null default, PATCH round-trips into GET', async () => {
  const list = await json('GET', '/users', { token: adminToken });
  assert.equal(list.status, 200);
  const me = list.data.find((u) => u.id === issuerId);
  assert.ok(me, 'issuer must appear in GET /users');
  assert.ok(Object.hasOwn(me, 'quota'), 'GET /users entries must include quota');
  assert.equal(me.quota, null);

  const set = await json('PATCH', `/users/${issuerId}/quota`, { token: adminToken, body: { quota: 7 } });
  assert.equal(set.status, 200);
  assert.equal(set.data.quota, 7);

  const list2 = await json('GET', '/users', { token: adminToken });
  assert.equal(list2.data.find((u) => u.id === issuerId).quota, 7);
});

test('cycle43: CSV injection — formula holder name is neutralized in export', async () => {
  const evil = "=cmd|'/c calc";
  const h = await json('POST', '/holders', {
    token: adminToken,
    body: { fullName: evil, org: 'Evil Org' },
  });
  assert.equal(h.status, 201);
  const c = await json('POST', '/cards', {
    token: adminToken,
    body: { holderId: h.data.holder.id },
  });
  assert.equal(c.status, 201);
  const cardId = c.data.card.id;
  db.prepare("INSERT INTO scans (card_id, at, lat, lng, result, flags, by_user) VALUES (?,?,?,?,?,?,?)")
    .run(cardId, new Date().toISOString(), null, null, 'valid', '[]', null);

  const res = await fetch(`${BASE}/scans/export`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  const csv = await res.text();
  const evilLine = csv.split('\n').find((l) => l.includes('calc'));
  assert.ok(evilLine, `export must contain the evil holder row, got:\n${csv}`);
  const cells = evilLine.split(',');
  const holderCell = cells.find((x) => x.includes('cmd'));
  assert.ok(holderCell && holderCell.trimStart().startsWith("'"), `formula cell must be '-prefixed, got: ${holderCell}`);
});
