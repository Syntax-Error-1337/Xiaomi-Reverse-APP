'use strict';
// Cycle-18 rate-limit tests: verify 61st → 429, export 11th → 429,
// authed backstop via direct middleware unit test (fast, no 300 HTTP calls).
//
// Reuses the cycle-4 harness shape: throwaway sqlite via PRESSID_DB + fresh
// key dir, app booted on an ephemeral port. Fresh users isolate windows.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const TEST_DB = path.join(os.tmpdir(), `pressid-cycle18-${process.pid}-${Date.now()}.db`);
const TEST_KEYS_DIR = path.join(os.tmpdir(), `pressid-cycle18-keys-${process.pid}-${Date.now()}.d`);
fs.mkdirSync(TEST_KEYS_DIR, { recursive: true });
process.env.PRESSID_KEYS_DIR = TEST_KEYS_DIR;
process.env.PRESSID_DB = TEST_DB;
process.env.ALLOW_DEV_SECRET = process.env.ALLOW_DEV_SECRET || '1';
process.env.PRESSID_QUIET = process.env.PRESSID_QUIET || '1';
const app = require('../src/server');
const db = require('../src/db');
const { makeLimiter } = require('../src/rateLimit');

let srv;
let BASE;

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

// Fresh user with a given role + token, bypassing the login limiter.
function mkUser(username, role) {
  const hash = bcrypt.hashSync('pw123456', 4);
  const r = db.prepare(
    'INSERT INTO users (username, password_hash, role, org_name, zone, active, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(username, hash, role, role === 'issuer' ? 'OrgA' : '', role === 'police' ? 'north' : '', 1, new Date().toISOString());
  const { signUser } = require('../src/auth');
  const token = signUser({ id: Number(r.lastInsertRowid), role });
  return { id: Number(r.lastInsertRowid), token };
}

before(async () => {
  const hash = bcrypt.hashSync('admin123', 4);
  db.prepare('INSERT INTO users (username, password_hash, role, org_name, zone, active, created_at) VALUES (?,?,?,?,?,?,?)')
    .run('admin', hash, 'admin', '', '', 1, new Date().toISOString());
  srv = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => srv.once('listening', resolve));
  BASE = `http://127.0.0.1:${srv.address().port}/api`;
});

after(async () => {
  if (srv) await new Promise((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
  try { db.close(); } catch (_) {}
  rmTestDb();
  try { fs.rmSync(TEST_KEYS_DIR, { recursive: true, force: true }); } catch (_) {}
});

test('verify 61st rapid call → 429 + Retry-After', async () => {
  const { token } = mkUser('rl-police-1', 'police');
  let last = null;
  for (let i = 0; i < 61; i++) {
    last = await json('POST', '/verify', { token, body: { token: 'bogus' } });
  }
  assert.equal(last.status, 429, `expected 429 on 61st, got ${last.status}`);
  assert.ok(last.headers.get('retry-after'), 'expected Retry-After header');
  assert.equal(last.headers.get('access-control-expose-headers'), 'Retry-After', 'browsers must be able to read Retry-After');
  assert.ok(last.data && last.data.error, 'expected {error} body');
});

test('export 11th rapid call → 429 + Retry-After', async () => {
  const { token } = mkUser('rl-admin-1', 'admin');
  // The 10 export hits also count toward the 300 backstop — nowhere near it.
  let last = null;
  for (let i = 0; i < 11; i++) {
    last = await json('GET', '/scans/export', { token });
  }
  assert.equal(last.status, 429, `expected 429 on 11th, got ${last.status}`);
  assert.ok(last.headers.get('retry-after'), 'expected Retry-After header');
});

test('backstop limiter trips on fast loop (direct middleware unit test)', async () => {
  const lim = makeLimiter({ windowMs: 60 * 1000, max: 5, key: () => 'unit-user' });
  let nexts = 0;
  const next = () => { nexts += 1; };
  let blocked = null;
  for (let i = 0; i < 6; i++) {
    const req = {};
    let status = null;
    const res = {
      set: () => {},
      status: (s) => { status = s; return res; },
      json: () => res,
    };
    lim(req, res, next);
    if (status === 429) blocked = i;
  }
  assert.equal(blocked, 5, `expected 6th call blocked, got index ${blocked}`);
  assert.equal(nexts, 5);
});

test('backstop limiter sets Retry-After + {error} on 429', async () => {
  const lim = makeLimiter({ windowMs: 60 * 1000, max: 1, key: () => 'unit-user-2' });
  const noop = () => {};
  lim({}, { set: noop, status: (s) => ({ json: () => { assert.equal(s, 200); } }) }, noop);
  let retryAfter = null;
  let body = null;
  const res = {
    set: (k, v) => { if (k === 'Retry-After') retryAfter = v; },
    status: (s) => { assert.equal(s, 429); return { json: (b) => { body = b; } }; },
  };
  lim({}, res, () => { throw new Error('next must not run on 429'); });
  assert.ok(retryAfter, 'expected Retry-After header');
  assert.ok(body && body.error, 'expected {error} body');
});
