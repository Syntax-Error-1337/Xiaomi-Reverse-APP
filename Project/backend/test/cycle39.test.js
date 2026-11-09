'use strict';
// PressID cycle-39: voluntary press device check-in (signal only).
//
// POST /api/me/check-in stores a client-generated deviceId on the holder row
// (audit holder.checkin); cardView + /verify surface holderCheckedIn with
// zero validity effect. Throwaway DB + keys; the real DB is never touched.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const TEST_DB = path.join(os.tmpdir(), `pressid-cycle39-${process.pid}-${Date.now()}.db`);
const TEST_KEYS_DIR = path.join(os.tmpdir(), `pressid-cycle39-keys-${process.pid}-${Date.now()}.d`);
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
});

after(async () => {
  if (srv) await new Promise((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
  try { db.close(); } catch (_) {}
  rmTestDb();
  try { fs.rmSync(TEST_KEYS_DIR, { recursive: true, force: true }); } catch (_) {}
});

test('cycle39: check-in round-trip — chip true in card view + verify, still valid; bad deviceId 400', async () => {
  const h = await json('POST', '/holders', {
    token: adminToken,
    body: { fullName: 'Checkin Press', org: 'Checkin Org' },
  });
  assert.equal(h.status, 201);
  const c = await json('POST', '/cards', {
    token: adminToken,
    body: { holderId: h.data.holder.id, validDays: 365 },
  });
  assert.equal(c.status, 201);
  const login = await json('POST', '/auth/login', { body: { username: h.data.username, password: h.data.tempPassword } });
  assert.equal(login.status, 200);
  const pressToken = login.data.token;
  const rot = await json('POST', '/auth/change-password', {
    token: pressToken, body: { oldPassword: h.data.tempPassword, newPassword: 'rotatedpw1' },
  });
  assert.equal(rot.status, 200);

  // Before check-in: informational chip off.
  const before = await json('GET', `/cards/${c.data.card.id}`, { token: pressToken });
  assert.equal(before.status, 200);
  assert.equal(before.data.holderCheckedIn, false);

  // Bad deviceId values → 400 (missing, too short, too long).
  for (const body of [{}, { deviceId: 'short' }, { deviceId: 'x'.repeat(65) }]) {
    const bad = await json('POST', '/me/check-in', { token: pressToken, body });
    assert.equal(bad.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }

  const deviceId = '01234567-89ab-cdef-0123-456789abcdef';
  const chk = await json('POST', '/me/check-in', { token: pressToken, body: { deviceId } });
  assert.equal(chk.status, 200);
  assert.equal(chk.data.ok, true);
  assert.ok(chk.data.deviceAt);

  // Card view: chip true; verify: chip true, still valid (zero validity impact).
  const after = await json('GET', `/cards/${c.data.card.id}`, { token: pressToken });
  assert.equal(after.status, 200);
  assert.equal(after.data.holderCheckedIn, true);
  const v = await json('POST', '/verify', { token: adminToken, body: { token: c.data.token } });
  assert.equal(v.data.valid, true);
  assert.equal(v.data.card.holderCheckedIn, true);

  // Audit trail records the check-in.
  const aud = await json('GET', '/audit?limit=200', { token: adminToken });
  assert.ok(aud.data.some((a) => a.action === 'holder.checkin'), 'expected holder.checkin audit entry');
});
