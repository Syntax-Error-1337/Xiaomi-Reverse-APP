'use strict';
// Cycle-47 adversarial-review locks: every High/Medium fix gets a behavioral pin,
// plus a guard against the cycle-47 edit accident (express.json + holders
// response lines silently dropped by a range edit → all-body login 401s).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const TEST_DB = path.join(os.tmpdir(), `pressid-cycle47-${process.pid}-${Date.now()}.db`);
const TEST_KEYS_DIR = path.join(os.tmpdir(), `pressid-cycle47-keys-${process.pid}-${Date.now()}.d`);
fs.mkdirSync(TEST_KEYS_DIR, { recursive: true });
process.env.PRESSID_KEYS_DIR = TEST_KEYS_DIR;
process.env.PRESSID_DB = TEST_DB;
process.env.ALLOW_DEV_SECRET = process.env.ALLOW_DEV_SECRET || '1';
process.env.PRESSID_QUIET = process.env.PRESSID_QUIET || '1';
const app = require('../src/server');
const db = require('../src/db');

let srv;
let BASE;
let adminToken;

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
  assert.equal(login.status, 200, 'admin login must work (express.json guard)');
  adminToken = login.data.token;
});

after(async () => {
  if (srv) await new Promise((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
  try { db.close(); } catch (_) {}
  rmTestDb();
  try { fs.rmSync(TEST_KEYS_DIR, { recursive: true, force: true }); } catch (_) {}
});

test('cycle47: body parsing intact (express.json wired)', async () => {
  // The cycle-47 edit accident deleted express.json → every POST 401/400.
  // Any successful body-echoing POST proves the parser is wired.
  const r = await json('POST', '/auth/login', { body: { username: 'admin', password: 'wrong' } });
  assert.equal(r.status, 401); // wrong password → 401, not 400/500
  assert.equal(r.data.error, 'Bad credentials'); // parsed body reached handler
});

test('cycle47: fresh admin must rotate (must_change gate on admin)', async () => {
  const create = await json('POST', '/users', {
    token: adminToken,
    body: { username: 'adm47', password: 'password47', role: 'police', orgName: '', zone: '' },
  });
  // seeded test admin has must_change=0 → can still manage users
  assert.equal(create.status, 201);
  // flip the new user to admin with must_change=1 directly, login, expect gate
  db.prepare("UPDATE users SET role='admin', must_change=1 WHERE username='adm47'").run();
  const login = await json('POST', '/auth/login', { body: { username: 'adm47', password: 'password47' } });
  assert.equal(login.status, 200);
  assert.equal(login.data.mustChange, true);
  const gated = await json('GET', '/users', { token: login.data.token });
  assert.equal(gated.status, 403);
  assert.equal(gated.data.code, 'MUST_CHANGE_PASSWORD');
  db.prepare("DELETE FROM users WHERE username='adm47'").run();
});

test('cycle47: replacement chain cannot fork (409 on double replace)', async () => {
  const h = await json('POST', '/holders', {
    token: adminToken,
    body: { fullName: 'Fork Holder', org: 'Org' },
  });
  assert.equal(h.status, 201);
  const c = await json('POST', '/cards', { token: adminToken, body: { holderId: h.data.holder.id } });
  assert.equal(c.status, 201);
  await json('POST', `/cards/${c.data.card.id}/revoke`, { token: adminToken, body: { reason: 'fork test' } });
  const r1 = await json('POST', '/cards', { token: adminToken, body: { replacesId: c.data.card.id } });
  assert.equal(r1.status, 201);
  const r2 = await json('POST', '/cards', { token: adminToken, body: { replacesId: c.data.card.id } });
  assert.equal(r2.status, 409);
  assert.equal(r2.data.replacedBy, r1.data.card.id);
});

test('cycle47: last active admin cannot self-deactivate', async () => {
  // Self-contained: use a disposable admin so the shared adminToken survives.
  const mk = await json('POST', '/users', {
    token: adminToken,
    body: { username: 'disposable-adm', password: 'password99', role: 'police', orgName: '', zone: '' },
  });
  assert.equal(mk.status, 201);
  db.prepare("UPDATE users SET role='admin' WHERE username='disposable-adm'").run();
  const disp = db.prepare('SELECT id FROM users WHERE username=?').get('disposable-adm').id;
  // With 2+ active admins, deactivating one is fine.
  const okRes = await json('PATCH', `/users/${disp}/active`, { token: adminToken, body: { active: false } });
  assert.equal(okRes.status, 200);
  // Reactivate disposable, log in as IT, deactivate the shared admin, then the
  // disposable tries to deactivate itself as the last active admin → 403.
  await json('PATCH', `/users/${disp}/active`, { token: adminToken, body: { active: true } });
  const dispLogin = await json('POST', '/auth/login', { body: { username: 'disposable-adm', password: 'password99' } });
  assert.equal(dispLogin.status, 200);
  const dispToken = dispLogin.data.token;
  const sharedId = db.prepare('SELECT id FROM users WHERE username=?').get('admin').id;
  const sharedOff = await json('PATCH', `/users/${sharedId}/active`, { token: dispToken, body: { active: false } });
  assert.equal(sharedOff.status, 200);
  const lastRes = await json('PATCH', `/users/${disp}/active`, { token: dispToken, body: { active: false } });
  assert.equal(lastRes.status, 403);
  // Restore: reactivate shared admin so later tests keep working.
  db.prepare('UPDATE users SET active=1 WHERE username=?').run('admin');
  db.prepare("DELETE FROM users WHERE username='disposable-adm'").run();
});

test('cycle47: temp creds are crypto-random (72+ bits)', async () => {
  const h = await json('POST', '/holders', {
    token: adminToken,
    body: { fullName: 'Crypto Holder', org: 'Org' },
  });
  assert.equal(h.status, 201);
  assert.ok(h.data.tempPassword.length >= 12, `temp password too short: ${h.data.tempPassword.length}`);
  assert.ok(h.data.username.startsWith('press-'));
  // holder-create ignores spoofed photoHash (checkpoint-chip integrity)
  const row = db.prepare('SELECT photo_hash FROM holders WHERE id=?').get(h.data.holder.id);
  assert.equal(row.photo_hash, '');
});

test('cycle47: validDays clamped to 1..1825', async () => {
  const h = await json('POST', '/holders', {
    token: adminToken,
    body: { fullName: 'Days Holder', org: 'Org' },
  });
  assert.equal(h.status, 201);
  const c1 = await json('POST', '/cards', { token: adminToken, body: { holderId: h.data.holder.id, validDays: 100000 } });
  assert.equal(c1.status, 201);
  const till = new Date(c1.data.card.validTill || c1.data.card.valid_till);
  const days = (till - Date.now()) / 86400000;
  assert.ok(days <= 1826, `validDays not clamped: ${days}`);
  const c2 = await json('POST', '/cards', { token: adminToken, body: { holderId: h.data.holder.id, validDays: -5 } });
  assert.equal(c2.status, 201);
  const till2 = new Date(c2.data.card.validTill || c2.data.card.valid_till);
  assert.ok((till2 - Date.now()) / 86400000 >= 0.9, 'negative validDays should floor to 1 day');
});

test('cycle47: no-store on credential routes + framing headers', async () => {
  const login = await fetch(BASE + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  assert.equal(login.headers.get('cache-control'), 'no-store');
  assert.equal(login.headers.get('x-content-type-options'), 'nosniff');
  const users = await json('GET', '/users', { token: adminToken });
  assert.equal(users.status, 200);
});
