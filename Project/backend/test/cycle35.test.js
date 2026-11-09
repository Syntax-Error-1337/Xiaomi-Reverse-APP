'use strict';
// PressID cycle-35: graceful JWT secret rotation.
//
// 1. grace — a token minted before rotation still verifies after one rotation
//    (prev-secret fallback); secret-info is exactly {hasPrev, rotatedAt,
//    source} (never values); short secrets are rejected with 400.
// 2. second-rotation-kills-first — after a second rotation the pre-first
//    token dies (401) while a post-first token still verifies; the rotation
//    persists to data/keys/jwt.json (0600) and audits admin.rotate_secret.
//
// Throwaway DB + key dir; the real DB/keys are never touched.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_DB = path.join(os.tmpdir(), `pressid-cycle35-${process.pid}-${Date.now()}.db`);
const TEST_KEYS_DIR = path.join(os.tmpdir(), `pressid-cycle35-keys-${process.pid}-${Date.now()}.d`);
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

const SECRET_A = 'a'.repeat(32);
const SECRET_B = 'b'.repeat(32);

test('cycle35: grace — old token verifies after rotation; secret-info shape; short secret rejected', async () => {
  // Fresh boot: env source, no prev, no rotatedAt.
  const info0 = await json('GET', '/admin/secret-info', { token: adminToken });
  assert.equal(info0.status, 200);
  assert.deepEqual(Object.keys(info0.data).sort(), ['hasPrev', 'rotatedAt', 'source']);
  assert.equal(info0.data.hasPrev, false);
  assert.equal(info0.data.rotatedAt, null);
  assert.equal(info0.data.source, 'env');

  // Short secret rejected, state untouched.
  const bad = await json('POST', '/admin/rotate-secret', { token: adminToken, body: { newSecret: 'too-short' } });
  assert.equal(bad.status, 400);
  const missing = await json('POST', '/admin/rotate-secret', { token: adminToken, body: {} });
  assert.equal(missing.status, 400);

  // Rotate once; the pre-rotation token must survive via the prev fallback.
  const rot = await json('POST', '/admin/rotate-secret', { token: adminToken, body: { newSecret: SECRET_A } });
  assert.equal(rot.status, 200);
  assert.equal(rot.data.ok, true);
  assert.ok(!Number.isNaN(Date.parse(rot.data.rotatedAt)));

  const stillOk = await json('GET', '/admin/key-info', { token: adminToken });
  assert.equal(stillOk.status, 200);

  // Tokens minted now (under the new secret) also verify.
  const login2 = await json('POST', '/auth/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(login2.status, 200);
  assert.ok(login2.data.token);

  // secret-info: source flipped to file, hasPrev true — and no values leak.
  const info = await json('GET', '/admin/secret-info', { token: adminToken });
  assert.equal(info.status, 200);
  assert.deepEqual(Object.keys(info.data).sort(), ['hasPrev', 'rotatedAt', 'source']);
  assert.equal(info.data.hasPrev, true);
  assert.equal(info.data.source, 'file');
  assert.ok(!Number.isNaN(Date.parse(info.data.rotatedAt)));
  const raw = JSON.stringify(info.data);
  assert.ok(!raw.includes(SECRET_A), 'secret-info must never leak secret values');
  assert.ok(!raw.toLowerCase().includes('current'), 'secret-info must not expose a current value');
  assert.ok(!/prev(?!.*hasprev)/i.test(raw.replace(/hasPrev/g, '')), 'secret-info must not expose a prev value');

  // Auth still enforced on both endpoints.
  assert.equal((await json('GET', '/admin/secret-info')).status, 401);
  assert.equal((await json('POST', '/admin/rotate-secret', { body: { newSecret: SECRET_A } })).status, 401);
});

test('cycle35: second rotation kills first-generation tokens; file persists 0600 + audit', async () => {
  // adminToken is a first-generation token (pre-first-rotation). A second
  // rotation drops it from the grace window → 401.
  const rot2 = await json('POST', '/admin/rotate-secret', { token: adminToken, body: { newSecret: SECRET_B } });
  assert.equal(rot2.status, 200);

  const dead = await json('GET', '/admin/key-info', { token: adminToken });
  assert.equal(dead.status, 401);

  // Fresh login under the second secret works and sees file source + prev.
  const login3 = await json('POST', '/auth/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(login3.status, 200);
  const fresh = login3.data.token;
  const info = await json('GET', '/admin/secret-info', { token: fresh });
  assert.equal(info.status, 200);
  assert.equal(info.data.source, 'file');
  assert.equal(info.data.hasPrev, true);

  // jwt.json persists {current, prev, rotatedAt} with 0600 perms.
  const f = path.join(TEST_KEYS_DIR, 'jwt.json');
  const st = fs.statSync(f);
  assert.equal(st.mode & 0o777, 0o600);
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(j.current, SECRET_B);
  assert.equal(typeof j.prev, 'string');
  assert.ok(j.prev.length >= 1);
  assert.ok(!Number.isNaN(Date.parse(j.rotatedAt)));

  // Audit trail records both rotations.
  const audit = await json('GET', '/audit?limit=50', { token: fresh });
  assert.equal(audit.status, 200);
  const actions = audit.data.map((r) => r.action);
  assert.ok(actions.filter((a) => a === 'admin.rotate_secret').length >= 2, `expected 2 admin.rotate_secret audits, got ${JSON.stringify(actions)}`);
});
