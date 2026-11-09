'use strict';
// PressID cycle-4 regression tests: full issue→verify→revoke flow, tampered
// token, revocation, zone enforcement, hash-chained audit verify (+ tamper
// detection), and login rate limiting.
//
// Uses a throwaway sqlite file via PRESSID_DB (set before requiring the app)
// and boots the Express app on an ephemeral port. The real DB is never touched.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const TEST_DB = path.join(os.tmpdir(), `pressid-cycle4-${process.pid}-${Date.now()}.db`);
// Throwaway key dir: rotation tests must never touch the real data/keys.
// keys.js generates a fresh pair here on first require (PRESSID_KEYS_DIR
// is read at module load, so this must precede requiring the app).
const TEST_KEYS_DIR = path.join(os.tmpdir(), `pressid-cycle5-keys-${process.pid}-${Date.now()}.d`);
fs.mkdirSync(TEST_KEYS_DIR, { recursive: true });
process.env.PRESSID_KEYS_DIR = TEST_KEYS_DIR;
process.env.PRESSID_DB = TEST_DB;
// server.js fail-fast boot requires JWT_SECRET unless dev override is set.
process.env.ALLOW_DEV_SECRET = process.env.ALLOW_DEV_SECRET || '1';
// Silence the request logger: the suite boots the app in-process.
process.env.PRESSID_QUIET = process.env.PRESSID_QUIET || '1';
const app = require('../src/server');
const db = require('../src/db');

let srv;
let BASE;
let adminToken;
let cardToken;
let cardId;

async function json(method, p, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  return { status: res.status, data };
}

function rmTestDb() {
  for (const f of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`, `${TEST_DB}-journal`]) {
    try {
      fs.unlinkSync(f);
    } catch (_) {}
  }
}

before(async () => {
  // fresh admin (mirrors src/seed.js default admin / admin123)
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

test('health check', async () => {
  const { status, data } = await json('GET', '/health');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

test('issue → verify → revoke flow', async () => {
  const login = await json('POST', '/auth/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(login.status, 200);
  adminToken = login.data.token;
  assert.ok(adminToken);

  const h = await json('POST', '/holders', {
    token: adminToken,
    body: { fullName: 'Casey Press', org: 'Cycle Times', designation: 'Reporter', idRef: 'EMP-7' },
  });
  assert.equal(h.status, 201);
  const holderId = h.data.holder.id;

  const c = await json('POST', '/cards', {
    token: adminToken,
    body: { holderId, validDays: 365, zones: ['north'] },
  });
  assert.equal(c.status, 201);
  cardId = c.data.card.id;
  cardToken = c.data.token;
  assert.ok(cardToken);

  const v = await json('POST', '/verify', { token: adminToken, body: { token: cardToken, lat: 28.61, lng: 77.23 } });
  assert.equal(v.data.valid, true);

  const r = await json('POST', `/cards/${cardId}/revoke`, { token: adminToken, body: { reason: 'lost card' } });
  assert.equal(r.data.ok, true);

  const v2 = await json('POST', '/verify', { token: adminToken, body: { token: cardToken } });
  assert.equal(v2.data.valid, false);
  assert.ok(v2.data.reasons.includes('REVOKED'), `expected REVOKED in ${JSON.stringify(v2.data.reasons)}`);
});

test('tampered token → INVALID_SIGNATURE', async () => {
  const p = cardToken.split('.');
  const tampered = `P1.${p[1][0] === 'A' ? 'B' : 'A'}${p[1].slice(1)}.${p[2]}`;
  const v = await json('POST', '/verify', { token: adminToken, body: { token: tampered } });
  assert.equal(v.data.valid, false);
  assert.ok(v.data.reasons.includes('INVALID_SIGNATURE'), `expected INVALID_SIGNATURE in ${JSON.stringify(v.data.reasons)}`);
});

test('out-of-zone card flagged', async () => {
  const u = await json('POST', '/users', {
    token: adminToken,
    body: { username: 'officer-south', password: 'pw123456', role: 'police', zone: 'south' },
  });
  assert.equal(u.status, 201);
  const login = await json('POST', '/auth/login', { body: { username: 'officer-south', password: 'pw123456' } });
  assert.equal(login.status, 200);
  const v = await json('POST', '/verify', { token: login.data.token, body: { token: cardToken } });
  assert.equal(v.data.valid, false);
  assert.ok(v.data.reasons.includes('OUT_OF_ZONE'), `expected OUT_OF_ZONE in ${JSON.stringify(v.data.reasons)}`);
});

test('audit chain verifies', async () => {
  const a = await json('GET', '/audit?limit=100', { token: adminToken });
  assert.equal(a.status, 200);
  assert.ok(a.data.length >= 3, `expected audit rows, got ${a.data.length}`);
  for (const row of a.data) {
    assert.ok(row.prevHash, 'prevHash present');
    assert.ok(row.entryHash, 'entryHash present');
  }
  const oldest = a.data[a.data.length - 1];
  assert.equal(oldest.prevHash, 'GENESIS');
  for (let i = 0; i + 1 < a.data.length; i++) {
    assert.equal(a.data[i].prevHash, a.data[i + 1].entryHash, 'chain links newest→oldest');
  }
  const v = await json('GET', '/audit/verify', { token: adminToken });
  assert.equal(v.data.ok, true);
  assert.equal(v.data.entries, a.data.length);
});

test('audit verify detects tampering', async () => {
  const target = db.prepare('SELECT id, detail FROM audit ORDER BY id DESC LIMIT 1').get();
  db.prepare('UPDATE audit SET detail = ? WHERE id = ?').run('tampered-detail', target.id);
  const bad = await json('GET', '/audit/verify', { token: adminToken });
  assert.equal(bad.data.ok, false);
  assert.equal(bad.data.brokenAt, target.id);
  db.prepare('UPDATE audit SET detail = ? WHERE id = ?').run(target.detail, target.id);
  const good = await json('GET', '/audit/verify', { token: adminToken });
  assert.equal(good.data.ok, true);
});

test('issuer quota blocks at cap, unlimited ok', async () => {
  const u = await json('POST', '/users', {
    token: adminToken,
    body: { username: 'issuer-quota', password: 'pw123456', role: 'issuer', orgName: 'Quota Org' },
  });
  assert.equal(u.status, 201);
  const issuerId = u.data.id;
  const login = await json('POST', '/auth/login', { body: { username: 'issuer-quota', password: 'pw123456' } });
  assert.equal(login.status, 200);
  const issuerToken = login.data.token;
  const mkHolder = async () => {
    const h = await json('POST', '/holders', {
      token: issuerToken,
      body: { fullName: 'Quota Holder', org: 'Quota Org' },
    });
    assert.equal(h.status, 201);
    return h.data.holder.id;
  };
  const h1 = await mkHolder();
  const h2 = await mkHolder();
  // quota 0 → even the first card is refused
  const q0 = await json('PATCH', `/users/${issuerId}/quota`, { token: adminToken, body: { quota: 0 } });
  assert.equal(q0.status, 200);
  assert.equal(q0.data.quota, 0);
  const blocked = await json('POST', '/cards', { token: issuerToken, body: { holderId: h1 } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error, 'Org quota exceeded');
  // quota 1 → one card ok, second refused
  const q1 = await json('PATCH', `/users/${issuerId}/quota`, { token: adminToken, body: { quota: 1 } });
  assert.equal(q1.status, 200);
  const c1 = await json('POST', '/cards', { token: issuerToken, body: { holderId: h1 } });
  assert.equal(c1.status, 201);
  const c2 = await json('POST', '/cards', { token: issuerToken, body: { holderId: h2 } });
  assert.equal(c2.status, 403);
  assert.equal(c2.data.error, 'Org quota exceeded');
  // bad quota rejected
  const bad = await json('PATCH', `/users/${issuerId}/quota`, { token: adminToken, body: { quota: -1 } });
  assert.equal(bad.status, 400);
  // unlimited (null) → second card ok
  const qn = await json('PATCH', `/users/${issuerId}/quota`, { token: adminToken, body: { quota: null } });
  assert.equal(qn.status, 200);
  const c3 = await json('POST', '/cards', { token: issuerToken, body: { holderId: h2 } });
  assert.equal(c3.status, 201);
});

test('press mustChange → change-password clears flag', async () => {
  const h = await json('POST', '/holders', {
    token: adminToken,
    body: { fullName: 'Temp Press', org: 'Cycle Times' },
  });
  assert.equal(h.status, 201);
  const { username, tempPassword } = h.data;
  const login = await json('POST', '/auth/login', { body: { username, password: tempPassword } });
  assert.equal(login.status, 200);
  assert.equal(login.data.mustChange, true);
  const pressToken = login.data.token;
  // wrong old password → 403
  const wrong = await json('POST', '/auth/change-password', {
    token: pressToken, body: { oldPassword: 'not-the-temp', newPassword: 'newpass123' },
  });
  assert.equal(wrong.status, 403);
  // too-short new password → 400
  const short = await json('POST', '/auth/change-password', {
    token: pressToken, body: { oldPassword: tempPassword, newPassword: 'short' },
  });
  assert.equal(short.status, 400);
  const ch = await json('POST', '/auth/change-password', {
    token: pressToken, body: { oldPassword: tempPassword, newPassword: 'newpass123' },
  });
  assert.equal(ch.status, 200);
  assert.equal(ch.data.ok, true);
  const relogin = await json('POST', '/auth/login', { body: { username, password: 'newpass123' } });
  assert.equal(relogin.status, 200);
  assert.equal(relogin.data.mustChange, false);
});

test('cycle24: mustChange press blocked from /me + /cards until rotation', async () => {
  const h = await json('POST', '/holders', {
    token: adminToken,
    body: { fullName: 'Frozen Press', org: 'Frozen Org' },
  });
  assert.equal(h.status, 201);
  const c = await json('POST', '/cards', {
    token: adminToken,
    body: { holderId: h.data.holder.id, validDays: 30, zones: [] },
  });
  assert.equal(c.status, 201);
  const login = await json('POST', '/auth/login', { body: { username: h.data.username, password: h.data.tempPassword } });
  assert.equal(login.status, 200);
  assert.equal(login.data.mustChange, true);
  const pressToken = login.data.token;
  // every press surface except login + change-password → 403 MUST_CHANGE_PASSWORD
  for (const req of [
    { method: 'GET', path: '/me/scans' },
    { method: 'POST', path: '/me/report-loss', body: { cardId: c.data.card.id } },
    { method: 'GET', path: '/cards' },
    { method: 'GET', path: `/cards/${c.data.card.id}` },
  ]) {
    const r = await json(req.method, req.path, { token: pressToken, body: req.body });
    assert.equal(r.status, 403, `expected 403 for ${req.method} ${req.path}, got ${r.status}`);
    assert.equal(r.data.code, 'MUST_CHANGE_PASSWORD');
  }
  // rotate → surfaces unlock
  const ch = await json('POST', '/auth/change-password', {
    token: pressToken, body: { oldPassword: h.data.tempPassword, newPassword: 'rotatedpw1' },
  });
  assert.equal(ch.status, 200);
  const scans = await json('GET', '/me/scans', { token: pressToken });
  assert.equal(scans.status, 200);
  const cards = await json('GET', '/cards', { token: pressToken });
  assert.equal(cards.status, 200);
  assert.ok(cards.data.some((x) => x.id === c.data.card.id && x.hasPhoto === false), 'expected own card with hasPhoto=false');
});

test('cycle24: issuer velocity cap 20/hr → 429; admin exempt', async () => {
  const u = await json('POST', '/users', {
    token: adminToken,
    body: { username: 'issuer-velocity', password: 'pw123456', role: 'issuer', orgName: 'Velocity Org' },
  });
  assert.equal(u.status, 201);
  const login = await json('POST', '/auth/login', { body: { username: 'issuer-velocity', password: 'pw123456' } });
  assert.equal(login.status, 200);
  const issuerToken = login.data.token;
  const mkHolder = async (n) => {
    const h = await json('POST', '/holders', { token: issuerToken, body: { fullName: `Vel Holder ${n}`, org: 'Velocity Org' } });
    assert.equal(h.status, 201);
    return h.data.holder.id;
  };
  let last = null;
  for (let i = 0; i < 21; i++) {
    last = await json('POST', '/cards', { token: issuerToken, body: { holderId: await mkHolder(i) } });
    if (i < 20) assert.equal(last.status, 201, `issue ${i} should succeed, got ${last.status}`);
  }
  assert.equal(last.status, 429, `expected 429 on 21st issue, got ${last.status}`);
  // admin path uncapped: 21 more issues fine
  for (let i = 0; i < 21; i++) {
    const h = await json('POST', '/holders', { token: adminToken, body: { fullName: `Vel Admin ${i}`, org: 'Velocity Admin Org' } });
    assert.equal(h.status, 201);
    const r = await json('POST', '/cards', { token: adminToken, body: { holderId: h.data.holder.id } });
    assert.equal(r.status, 201);
    assert.equal(r.data.card.hasPhoto, false);
  }
});

test('cycle24: verify payload carries hasPhoto; true after photo upload', async () => {
  const h = await json('POST', '/holders', { token: adminToken, body: { fullName: 'Photo Press', org: 'Photo Org' } });
  assert.equal(h.status, 201);
  const c = await json('POST', '/cards', { token: adminToken, body: { holderId: h.data.holder.id, zones: ['north'] } });
  assert.equal(c.status, 201);
  const v0 = await json('POST', '/verify', { token: adminToken, body: { token: c.data.token } });
  assert.equal(v0.data.valid, true);
  assert.equal(v0.data.card.hasPhoto, false);
  const tiny = 'data:image/png;base64,' + Buffer.from('fakepng-bytes').toString('base64');
  const up = await json('POST', `/holders/${h.data.holder.id}/photo`, { token: adminToken, body: { dataUrl: tiny } });
  assert.equal(up.status, 200);
  const v1 = await json('POST', '/verify', { token: adminToken, body: { token: c.data.token } });
  assert.equal(v1.data.valid, true);
  assert.equal(v1.data.card.hasPhoto, true);
  assert.ok(v1.data.card.photoHash, 'expected photoHash present');
});

test('admin login has mustChange=false', async () => {
  const login = await json('POST', '/auth/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(login.status, 200);
  assert.equal(login.data.mustChange, false);
});

test('key rotation keeps old token valid, new cards carry current kid', async () => {
  const before = await json('GET', '/admin/key-info', { token: adminToken });
  assert.equal(before.status, 200);
  const oldKid = before.data.currentKid;
  assert.ok(oldKid);
  assert.equal(before.data.hasPrev, false);
  // mint a pre-rotation card via admin (admin issues bypass quota)
  const h = await json('POST', '/holders', {
    token: adminToken,
    body: { fullName: 'Rotation Holder', org: 'Rotation Org' },
  });
  assert.equal(h.status, 201);
  const c = await json('POST', '/cards', { token: adminToken, body: { holderId: h.data.holder.id } });
  assert.equal(c.status, 201);
  const oldToken = c.data.token;
  const rot = await json('POST', '/admin/rotate-keys', { token: adminToken });
  assert.equal(rot.status, 200);
  assert.ok(rot.data.currentKid);
  assert.notEqual(rot.data.currentKid, oldKid);
  assert.ok(rot.data.rotatedAt);
  const after = await json('GET', '/admin/key-info', { token: adminToken });
  assert.equal(after.status, 200);
  assert.equal(after.data.currentKid, rot.data.currentKid);
  assert.equal(after.data.hasPrev, true);
  assert.equal(after.data.rotatedAt, rot.data.rotatedAt);
  // old token still verifies (prev-key fallback) …
  const { verifyTokenLocal } = require('../src/cards');
  const vOld = verifyTokenLocal(oldToken);
  assert.equal(vOld.ok, true);
  // … and the full /verify path agrees
  const full = await json('POST', '/verify', { token: adminToken, body: { token: oldToken } });
  assert.equal(full.data.valid, true);
  // new cards verify and carry kid=current
  const c2 = await json('POST', '/cards', { token: adminToken, body: { holderId: h.data.holder.id } });
  assert.equal(c2.status, 201);
  const vNew = verifyTokenLocal(c2.data.token);
  assert.equal(vNew.ok, true);
  assert.equal(vNew.payload.kid, rot.data.currentKid);
});

test('verify-bundle returns JWK matching current kid (public only)', async () => {
  const keys = require('../src/keys');
  const b = await json('GET', '/admin/verify-bundle', { token: adminToken });
  assert.equal(b.status, 200);
  assert.equal(b.data.kid, keys.currentKid());
  assert.deepEqual(b.data.publicKeyJwk, keys.publicJwk());
  assert.equal(b.data.publicKeyJwk.kty, 'OKP');
  assert.equal(b.data.publicKeyJwk.crv, 'Ed25519');
  assert.ok(b.data.exportedAt);
  assert.equal(b.data.verifyHint, 'offline signature check only — confirm status/revocation online');
  assert.ok(!('privateKey' in b.data) && !('d' in (b.data.publicKeyJwk || {})));
});

test('offline script: exit 0 on real token, exit 2 on flipped sig', async () => {
  const { execFileSync, execFile } = require('node:child_process');
  const b = await json('GET', '/admin/verify-bundle', { token: adminToken });
  assert.equal(b.status, 200);
  const bundlePath = path.join(os.tmpdir(), `pressid-bundle-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(bundlePath, JSON.stringify(b.data));
  // Mint a fresh card so the token matches the CURRENT key (an earlier test rotated keys).
  const h = await json('POST', '/holders', {
    token: adminToken,
    body: { fullName: 'Offline Holder', org: 'Offline Org' },
  });
  assert.equal(h.status, 201);
  const c = await json('POST', '/cards', { token: adminToken, body: { holderId: h.data.holder.id } });
  assert.equal(c.status, 201);
  const freshToken = c.data.token;
  try {
    const out = execFileSync('node', ['scripts/offline-verify.js', freshToken, '--key', bundlePath], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    });
    assert.match(out, /signature: OK/);
    assert.match(out, /cardId/);
    const parts = freshToken.split('.');
    const sig = parts[2];
    const bad = `${parts[0]}.${parts[1]}.${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
    await new Promise((resolve, reject) => {
      execFile('node', ['scripts/offline-verify.js', bad, '--key', bundlePath], { cwd: path.join(__dirname, '..') }, (err, stdout) => {
        try {
          assert.ok(err, 'expected non-zero exit for bad signature');
          assert.equal(err.code, 2);
          assert.match(String(stdout), /signature: FAIL/);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  } finally {
    try { fs.unlinkSync(bundlePath); } catch (_) {}
  }
});

test('CORS preflight OPTIONS /auth/login → 204 + ACAO header', async () => {
  const res = await fetch(`${BASE}/auth/login`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.ok((res.headers.get('access-control-allow-origin') || '').includes('*'));
  await res.text().catch(() => null);
});

test('GET /cards/:id returns token+qrDataUrl+card.holder.fullName (as issuer)', async () => {
  const u = await json('POST', '/users', {
    token: adminToken,
    body: { username: 'c9issuer', password: 'issuerpass1', role: 'issuer', orgName: 'C9 Org' },
  });
  assert.equal(u.status, 201);
  const login = await json('POST', '/auth/login', { body: { username: 'c9issuer', password: 'issuerpass1' } });
  assert.equal(login.status, 200);
  const issuerToken = login.data.token;
  assert.ok(issuerToken);
  const h = await json('POST', '/holders', {
    token: issuerToken,
    body: { fullName: 'C9 Holder', org: 'C9 Org', designation: 'Anchor', idRef: 'C9-1' },
  });
  assert.equal(h.status, 201);
  const c = await json('POST', '/cards', { token: issuerToken, body: { holderId: h.data.holder.id, validDays: 30, zones: [] } });
  assert.equal(c.status, 201);
  assert.ok(c.data.card.holder && c.data.card.holder.fullName === 'C9 Holder', `POST /cards missing embedded holder: ${JSON.stringify(c.data.card)}`);
  const g = await json('GET', `/cards/${c.data.card.id}`, { token: issuerToken });
  assert.equal(g.status, 200);
  assert.ok(g.data.token, 'expected token in GET /cards/:id');
  assert.ok(g.data.qrDataUrl && String(g.data.qrDataUrl).startsWith('data:'), 'expected qrDataUrl in GET /cards/:id');
  assert.equal(g.data.card && g.data.card.holder && g.data.card.holder.fullName, 'C9 Holder');
});

 test('login sends Cache-Control: no-store', async () => {
   const res = await fetch(`${BASE}/auth/login`, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ username: 'admin', password: 'admin123' }),
   });
   assert.equal(res.status, 200);
   assert.equal(res.headers.get('cache-control'), 'no-store');
   await res.json().catch(() => null);
 });
test('alert triage flow (open → acked → resolved)', async () => {
  const h = await json('POST', '/holders', {
    token: adminToken,
    body: { fullName: 'Triage Holder', org: 'Triage Org' },
  });
  assert.equal(h.status, 201);
  const c = await json('POST', '/cards', { token: adminToken, body: { holderId: h.data.holder.id } });
  assert.equal(c.status, 201);
  const tok = c.data.token;
  const tCardId = c.data.card.id;
  // impossible-travel pair (Delhi → Chennai in seconds) → flagged second scan
  await json('POST', '/verify', { token: adminToken, body: { token: tok, lat: 28.61, lng: 77.23 } });
  const v2 = await json('POST', '/verify', { token: adminToken, body: { token: tok, lat: 13.08, lng: 80.27 } });
  assert.ok((v2.data.alerts || []).length > 0, `expected clone flags, got ${JSON.stringify(v2.data)}`);
  const recent = await json('GET', '/scans/recent?limit=200', { token: adminToken });
  assert.equal(recent.status, 200);
  const flagged = recent.data.find((s) => s.cardId === tCardId && (s.flags || []).length > 0);
  assert.ok(flagged, 'expected flagged scan in recent');
  assert.equal(flagged.triage, 'open');
  const scanId = flagged.id;
  // GET /scans carries the same triage fields
  const all = await json('GET', `/scans?cardId=${tCardId}`, { token: adminToken });
  assert.equal(all.status, 200);
  const viaScans = all.data.find((s) => s.id === scanId);
  assert.ok(viaScans, 'expected scan in GET /scans');
  assert.equal(viaScans.triage, 'open');
  // ack
  const ack = await json('PATCH', `/scans/${scanId}/triage`, { token: adminToken, body: { state: 'acked' } });
  assert.equal(ack.status, 200);
  assert.equal(ack.data.triage, 'acked');
  assert.equal(ack.data.triagedBy, 'admin');
  assert.ok(ack.data.triagedAt);
  const recent2 = await json('GET', '/scans/recent?limit=200', { token: adminToken });
  const afterAck = recent2.data.find((s) => s.id === scanId);
  assert.equal(afterAck.triage, 'acked');
  assert.equal(afterAck.triagedBy, 'admin');
  assert.ok(afterAck.triagedAt);
  // audit trail records the triage action
  const aud = await json('GET', '/audit?limit=500', { token: adminToken });
  assert.ok(aud.data.some((a) => a.action === 'scan.triage' && String(a.detail).includes(`scan ${scanId} state=acked`)), 'expected scan.triage audit entry');
  // resolve
  const res2 = await json('PATCH', `/scans/${scanId}/triage`, { token: adminToken, body: { state: 'resolved' } });
  assert.equal(res2.status, 200);
  assert.equal(res2.data.triage, 'resolved');
  // bad state → 400
  const bad = await json('PATCH', `/scans/${scanId}/triage`, { token: adminToken, body: { state: 'bogus' } });
  assert.equal(bad.status, 400);
  // unknown scan → 404
  const nf = await json('PATCH', '/scans/99999999/triage', { token: adminToken, body: { state: 'acked' } });
  assert.equal(nf.status, 404);
  // non-admin → 403
  const u = await json('POST', '/users', {
    token: adminToken,
    body: { username: 'triage-police', password: 'pw123456', role: 'police', zone: 'north' },
  });
  assert.equal(u.status, 201);
  const login = await json('POST', '/auth/login', { body: { username: 'triage-police', password: 'pw123456' } });
  assert.equal(login.status, 200);
  const forb = await json('PATCH', `/scans/${scanId}/triage`, { token: login.data.token, body: { state: 'acked' } });
  assert.equal(forb.status, 403);
});

test('stats.alertsOpen counts open flagged scans', async () => {
  const s0 = await json('GET', '/stats', { token: adminToken });
  assert.equal(s0.status, 200);
  assert.ok(Number.isInteger(s0.data.alertsOpen), `expected alertsOpen int, got ${JSON.stringify(s0.data)}`);
  const n0 = s0.data.alertsOpen;
  const h = await json('POST', '/holders', {
    token: adminToken,
    body: { fullName: 'AlertsOpen Holder', org: 'AlertsOpen Org' },
  });
  assert.equal(h.status, 201);
  const c = await json('POST', '/cards', { token: adminToken, body: { holderId: h.data.holder.id } });
  assert.equal(c.status, 201);
  const tok = c.data.token;
  const tCardId = c.data.card.id;
  // clean scan (no flags) leaves the open-alert count unchanged
  await json('POST', '/verify', { token: adminToken, body: { token: tok, lat: 28.61, lng: 77.23 } });
  const s1 = await json('GET', '/stats', { token: adminToken });
  assert.equal(s1.data.alertsOpen, n0);
  // impossible-travel pair flags exactly one new scan → +1
  await json('POST', '/verify', { token: adminToken, body: { token: tok, lat: 13.08, lng: 80.27 } });
  const s2 = await json('GET', '/stats', { token: adminToken });
  assert.equal(s2.data.alertsOpen, n0 + 1);
  const recent = await json('GET', '/scans/recent?limit=200', { token: adminToken });
  const flagged = recent.data.find((s) => s.cardId === tCardId && (s.flags || []).length > 0 && s.triage === 'open');
  assert.ok(flagged, 'expected one open flagged scan');
  const r = await json('PATCH', `/scans/${flagged.id}/triage`, { token: adminToken, body: { state: 'resolved' } });
  assert.equal(r.status, 200);
  const s3 = await json('GET', '/stats', { token: adminToken });
  assert.equal(s3.data.alertsOpen, n0);
});

test('event card: zones required 400; happy path valid with EVENT_ACTIVE note', async () => {
  const h = await json('POST', '/holders', {
    token: adminToken,
    body: { fullName: 'Event Reporter', org: 'Event Org' },
  });
  assert.equal(h.status, 201);
  const bad = await json('POST', '/cards', {
    token: adminToken,
    body: { holderId: h.data.holder.id, eventName: 'Protest X', eventEnd: new Date(Date.now() + 48 * 3600e3).toISOString() },
  });
  assert.equal(bad.status, 400);
  const good = await json('POST', '/cards', {
    token: adminToken,
    body: { holderId: h.data.holder.id, zones: ['north'], eventName: 'Protest X', eventEnd: new Date(Date.now() + 48 * 3600e3).toISOString() },
  });
  assert.equal(good.status, 201);
  assert.equal(good.data.card.eventName, 'Protest X');
  const v = await json('POST', '/verify', { token: adminToken, body: { token: good.data.token } });
  assert.equal(v.data.valid, true);
  assert.ok(v.data.reasons.includes('EVENT_ACTIVE'), `expected EVENT_ACTIVE in ${JSON.stringify(v.data.reasons)}`);
  assert.equal(v.data.card.eventName, 'Protest X');
  const list = await json('GET', '/cards?event=protest&active=1', { token: adminToken });
  assert.equal(list.status, 200);
  assert.ok(list.data.some((c) => c.id === good.data.card.id), 'expected event card in filtered list');
});

test('expiry by event_end flips card to expired', async () => {
  const h = await json('POST', '/holders', {
    token: adminToken,
    body: { fullName: 'Expired Event Reporter', org: 'Event Org 2' },
  });
  assert.equal(h.status, 201);
  const c = await json('POST', '/cards', {
    token: adminToken,
    body: { holderId: h.data.holder.id, zones: ['north'], eventName: 'Past Protest', eventEnd: new Date(Date.now() + 48 * 3600e3).toISOString() },
  });
  assert.equal(c.status, 201);
  // backdate event_end into the past → touchExpiry (via GET /cards) flips to expired
  db.prepare('UPDATE cards SET event_end = ? WHERE id = ?').run(new Date(Date.now() - 3600e3).toISOString(), c.data.card.id);
  const list = await json('GET', `/cards?active=1`, { token: adminToken });
  assert.ok(!list.data.some((x) => x.id === c.data.card.id), 'expected expired-by-event card excluded from active list');
  const one = await json('GET', `/cards/${c.data.card.id}`, { token: adminToken });
  assert.equal(one.data.status, 'expired');
  const v = await json('POST', '/verify', { token: adminToken, body: { token: c.data.token } });
  assert.equal(v.data.valid, false);
});

test('press sees own scans only (my-scans cross-check)', async () => {
  const mk = async (name, org) => {
    const h = await json('POST', '/holders', { token: adminToken, body: { fullName: name, org } });
    assert.equal(h.status, 201);
    const c = await json('POST', '/cards', { token: adminToken, body: { holderId: h.data.holder.id, validDays: 30, zones: [] } });
    assert.equal(c.status, 201);
    const login = await json('POST', '/auth/login', { body: { username: h.data.username, password: h.data.tempPassword } });
    assert.equal(login.status, 200);
    // cycle 24: mustChange press must rotate before /me/* unlocks
    const ch = await json('POST', '/auth/change-password', {
      token: login.data.token, body: { oldPassword: h.data.tempPassword, newPassword: 'rotatedpw1' },
    });
    assert.equal(ch.status, 200);
    return { holder: h.data.holder, card: c.data.card, token: c.data.token, pressToken: login.data.token };
  };
  const a = await mk('Self A', 'Self Org A');
  const b = await mk('Self B', 'Self Org B');
  const v = await json('POST', '/verify', { token: adminToken, body: { token: a.token, lat: 28.61, lng: 77.23 } });
  assert.equal(v.data.valid, true);
  const sa = await json('GET', '/me/scans', { token: a.pressToken });
  assert.equal(sa.status, 200);
  assert.ok(sa.data.length >= 1, 'expected own scan');
  assert.ok(sa.data.every((s) => s.cardId === a.card.id), `expected only own scans, got ${JSON.stringify(sa.data)}`);
  assert.ok(sa.data[0].flags !== undefined && sa.data[0].result !== undefined);
  const sb = await json('GET', '/me/scans', { token: b.pressToken });
  assert.equal(sb.status, 200);
  assert.equal(sb.data.length, 0);
});

test('report-loss flips status; verify CARD_REPORTED; issuer sees reported', async () => {
  const h = await json('POST', '/holders', { token: adminToken, body: { fullName: 'Loss Reporter', org: 'Loss Org' } });
  assert.equal(h.status, 201);
  const other = await json('POST', '/holders', { token: adminToken, body: { fullName: 'Loss Other', org: 'Loss Org 2' } });
  assert.equal(other.status, 201);
  const c = await json('POST', '/cards', { token: adminToken, body: { holderId: h.data.holder.id, validDays: 30, zones: [] } });
  assert.equal(c.status, 201);
  const login = await json('POST', '/auth/login', { body: { username: h.data.username, password: h.data.tempPassword } });
  const pressToken = login.data.token;
  const ologin = await json('POST', '/auth/login', { body: { username: other.data.username, password: other.data.tempPassword } });
  const otherPressToken = ologin.data.token;
  // cycle 24: rotate both temp creds before exercising report-loss guards
  for (const [tok, tmp] of [[pressToken, h.data.tempPassword], [otherPressToken, other.data.tempPassword]]) {
    const ch = await json('POST', '/auth/change-password', { token: tok, body: { oldPassword: tmp, newPassword: 'rotatedpw1' } });
    assert.equal(ch.status, 200);
  }
  const no = await json('POST', '/me/report-loss', { token: otherPressToken, body: { cardId: c.data.card.id } });
  assert.equal(no.status, 403);
  const miss = await json('POST', '/me/report-loss', { token: pressToken, body: { cardId: 99999999 } });
  assert.equal(miss.status, 404);
  const r = await json('POST', '/me/report-loss', { token: pressToken, body: { cardId: c.data.card.id } });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  const one = await json('GET', `/cards/${c.data.card.id}`, { token: pressToken });
  assert.equal(one.data.status, 'reported');
  const v = await json('POST', '/verify', { token: adminToken, body: { token: c.data.token } });
  assert.equal(v.data.valid, false);
  assert.ok(v.data.reasons.includes('CARD_REPORTED'), `expected CARD_REPORTED in ${JSON.stringify(v.data.reasons)}`);
  const list = await json('GET', '/cards', { token: adminToken });
  assert.ok(list.data.some((x) => x.id === c.data.card.id && x.status === 'reported'), 'expected issuer view to show reported');
});

test('replace reported card: inheritance + lineage both directions', async () => {
  const h = await json('POST', '/holders', { token: adminToken, body: { fullName: 'Replace Reporter', org: 'Replace Org' } });
  assert.equal(h.status, 201);
  const holderId = h.data.holder.id;
  const evEnd = new Date(Date.now() + 72 * 3600e3).toISOString();
  const c = await json('POST', '/cards', {
    token: adminToken,
    body: { holderId, validDays: 30, zones: ['north', 'central'], eventName: 'Summit', eventEnd: evEnd },
  });
  assert.equal(c.status, 201);
  const oldId = c.data.card.id;
  // holder reports loss → terminal (cycle 24: rotate temp creds first)
  const login = await json('POST', '/auth/login', { body: { username: h.data.username, password: h.data.tempPassword } });
  const rot = await json('POST', '/auth/change-password', {
    token: login.data.token, body: { oldPassword: h.data.tempPassword, newPassword: 'rotatedpw1' },
  });
  assert.equal(rot.status, 200);
  const rep = await json('POST', '/me/report-loss', { token: login.data.token, body: { cardId: oldId } });
  assert.equal(rep.status, 200);
  // replace without holderId: inherits holder/zones/event
  const r = await json('POST', '/cards', { token: adminToken, body: { replacesId: oldId, validDays: 60 } });
  assert.equal(r.status, 201);
  const newId = r.data.card.id;
  assert.equal(r.data.card.holderId, holderId);
  assert.equal(r.data.card.replacesId, oldId);
  assert.deepEqual(r.data.card.zones, ['north', 'central']);
  assert.equal(r.data.card.eventName, 'Summit');
  assert.ok(r.data.card.eventEnd, 'expected inherited eventEnd');
  // link both directions
  const oldView = await json('GET', `/cards/${oldId}`, { token: adminToken });
  assert.equal(oldView.data.replacedBy, newId);
  assert.equal(oldView.data.card.replacedBy, newId);
  const newView = await json('GET', `/cards/${newId}`, { token: adminToken });
  assert.equal(newView.data.replacesId, oldId);
  const list = await json('GET', '/cards', { token: adminToken });
  assert.ok(list.data.some((x) => x.id === newId && x.replacesId === oldId));
  assert.ok(list.data.some((x) => x.id === oldId && x.replacedBy === newId));
  // explicit body wins over inheritance
  const rep2 = await json('POST', '/me/report-loss', { token: login.data.token, body: { cardId: newId } });
  assert.equal(rep2.status, 200);
  const r2 = await json('POST', '/cards', {
    token: adminToken,
    body: { replacesId: newId, holderId, zones: ['south'], eventName: 'Other', eventEnd: evEnd, validDays: 10 },
  });
  assert.equal(r2.status, 201);
  assert.deepEqual(r2.data.card.zones, ['south']);
  assert.equal(r2.data.card.eventName, 'Other');
  // audit card.replace links old→new
  const a = await json('GET', '/audit?limit=200', { token: adminToken });
  assert.ok(a.data.some((x) => x.action === 'card.replace' && String(x.detail).includes(`old ${oldId} new ${newId}`)),
    'expected card.replace audit row');
});

test('replace guards: active card 400, cross-org 403', async () => {
  // active card cannot be replaced
  const h = await json('POST', '/holders', { token: adminToken, body: { fullName: 'Replace Active', org: 'Replace Org A' } });
  assert.equal(h.status, 201);
  const c = await json('POST', '/cards', { token: adminToken, body: { holderId: h.data.holder.id, validDays: 30 } });
  assert.equal(c.status, 201);
  const bad = await json('POST', '/cards', { token: adminToken, body: { replacesId: c.data.card.id } });
  assert.equal(bad.status, 400);
  // unknown replacesId → 400
  const miss = await json('POST', '/cards', { token: adminToken, body: { replacesId: 99999999 } });
  assert.equal(miss.status, 400);
  // cross-org: issuer in another org cannot replace
  const u = await json('POST', '/users', {
    token: adminToken,
    body: { username: 'issuer-replace', password: 'pw123456', role: 'issuer', orgName: 'Replace Org B' },
  });
  assert.equal(u.status, 201);
  const login = await json('POST', '/auth/login', { body: { username: 'issuer-replace', password: 'pw123456' } });
  const otherToken = login.data.token;
  const hb = await json('POST', '/holders', { token: otherToken, body: { fullName: 'Replace B Holder', org: 'Replace Org B' } });
  assert.equal(hb.status, 201);
  const cb = await json('POST', '/cards', { token: otherToken, body: { holderId: hb.data.holder.id } });
  assert.equal(cb.status, 201);
  db.prepare("UPDATE cards SET status = 'reported' WHERE id = ?").run(cb.data.card.id);
  const cross = await json('POST', '/cards', { token: adminToken, body: { replacesId: cb.data.card.id } });
  // admin is not org-scoped, so admin replacing a foreign-org card is allowed;
  // the issuer from org A attempting it must get 403 — use a second issuer:
  const ua = await json('POST', '/users', {
    token: adminToken,
    body: { username: 'issuer-replace-a', password: 'pw123456', role: 'issuer', orgName: 'Replace Org A' },
  });
  assert.equal(ua.status, 201);
  const logina = await json('POST', '/auth/login', { body: { username: 'issuer-replace-a', password: 'pw123456' } });
  const forbidden = await json('POST', '/cards', { token: logina.data.token, body: { replacesId: cb.data.card.id } });
  assert.equal(forbidden.status, 403);
  assert.equal(cross.status, 201);
});

test('cycle25: old card first scan → FIRST_SCAN_LATE note, still valid', async () => {
  const h = await json('POST', '/holders', { token: adminToken, body: { fullName: 'Late First', org: 'Late Org' } });
  assert.equal(h.status, 201);
  const c = await json('POST', '/cards', { token: adminToken, body: { holderId: h.data.holder.id, validDays: 30, zones: [] } });
  assert.equal(c.status, 201);
  // backdate issue >1h ago (valid_from drives the age check)
  db.prepare('UPDATE cards SET valid_from = ? WHERE id = ?')
    .run(new Date(Date.now() - 48 * 3600e3).toISOString(), c.data.card.id);
  const v = await json('POST', '/verify', { token: adminToken, body: { token: c.data.token } });
  assert.equal(v.data.valid, true);
  assert.ok(v.data.reasons.includes('FIRST_SCAN_LATE'), `expected FIRST_SCAN_LATE in ${JSON.stringify(v.data.reasons)}`);
  // second scan: no longer the first → note absent
  const v2 = await json('POST', '/verify', { token: adminToken, body: { token: c.data.token } });
  assert.ok(!v2.data.reasons.includes('FIRST_SCAN_LATE'), `unexpected FIRST_SCAN_LATE in ${JSON.stringify(v2.data.reasons)}`);
});

test('cycle25: young card first scan → no FIRST_SCAN_LATE; officer_zone recorded + in timeline', async () => {
  // officer with a zone, so provenance is non-empty
  const u = await json('POST', '/users', {
    token: adminToken,
    body: { username: 'officer-zone25', password: 'pw123456', role: 'police', orgName: '', zone: 'central' },
  });
  assert.equal(u.status, 201);
  const login = await json('POST', '/auth/login', { body: { username: 'officer-zone25', password: 'pw123456' } });
  assert.equal(login.status, 200);
  const officerToken = login.data.token;
  const h = await json('POST', '/holders', { token: adminToken, body: { fullName: 'Fresh First', org: 'Fresh Org' } });
  assert.equal(h.status, 201);
  const c = await json('POST', '/cards', { token: adminToken, body: { holderId: h.data.holder.id, validDays: 30, zones: [] } });
  assert.equal(c.status, 201);
  const v = await json('POST', '/verify', { token: officerToken, body: { token: c.data.token } });
  assert.equal(v.data.valid, true);
  assert.ok(!v.data.reasons.includes('FIRST_SCAN_LATE'), `unexpected FIRST_SCAN_LATE in ${JSON.stringify(v.data.reasons)}`);
  const row = db.prepare('SELECT officer_zone FROM scans WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(c.data.card.id);
  assert.equal(row && row.officer_zone, 'central');
  const tl = await json('GET', `/scans/${c.data.card.id}/timeline`, { token: adminToken });
  assert.equal(tl.status, 200);
  assert.ok(tl.data.length >= 1 && tl.data[tl.data.length - 1].officerZone === 'central',
    `expected officerZone central in timeline, got ${JSON.stringify(tl.data)}`);
});

test('login rate limiting → 429', async () => {
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const r = await json('POST', '/auth/login', { body: { username: 'nosuchuser', password: 'wrong' } });
    statuses.push(r.status);
  }
  assert.ok(statuses.includes(429), `expected a 429, got ${JSON.stringify(statuses)}`);
});

test('reason codes coverage: INVALID_FORMAT, CARD_NOT_FOUND, TAMPER_MISMATCH, STATUS_EXPIRED, UNKNOWN_ZONE, DUPLICATE_SCAN', async () => {
  // INVALID_FORMAT: garbage token → invalid, documented code.
  const bad = await json('POST', '/verify', { token: adminToken, body: { token: 'not-a-token' } });
  assert.equal(bad.data.valid, false);
  assert.ok(bad.data.reasons.includes('INVALID_FORMAT'), `expected INVALID_FORMAT in ${JSON.stringify(bad.data.reasons)}`);
  // CARD_NOT_FOUND: valid signature over a card id absent from the DB.
  const { mintCard } = require('../src/cards');
  const ghost = mintCard(
    { id: 424242, valid_from: new Date().toISOString(), valid_till: new Date(Date.now() + 86400e3).toISOString(), nonce: 'ghost-nonce' },
    { id: 424243, full_name: 'Ghost Reporter', org: 'Ghost Org' },
  ).token;
  const nf = await json('POST', '/verify', { token: adminToken, body: { token: ghost } });
  assert.equal(nf.data.valid, false);
  assert.ok(nf.data.reasons.includes('CARD_NOT_FOUND'), `expected CARD_NOT_FOUND in ${JSON.stringify(nf.data.reasons)}`);
  // TAMPER_MISMATCH + STATUS_EXPIRED + UNKNOWN_ZONE + DUPLICATE_SCAN on fresh cards.
  const h = await json('POST', '/holders', { token: adminToken, body: { fullName: 'Code Cover Reporter', org: 'Code Cover Org' } });
  assert.equal(h.status, 201);
  const c = await json('POST', '/cards', { token: adminToken, body: { holderId: h.data.holder.id, validDays: 30, zones: [] } });
  assert.equal(c.status, 201);
  db.prepare('UPDATE holders SET full_name = ? WHERE id = ?').run('Renamed Reporter', h.data.holder.id);
  const tm = await json('POST', '/verify', { token: adminToken, body: { token: c.data.token } });
  assert.equal(tm.data.valid, false);
  assert.ok(tm.data.reasons.includes('TAMPER_MISMATCH'), `expected TAMPER_MISMATCH in ${JSON.stringify(tm.data.reasons)}`);
  db.prepare('UPDATE holders SET full_name = ? WHERE id = ?').run('Code Cover Reporter', h.data.holder.id);
  db.prepare("UPDATE cards SET valid_till = ? WHERE id = ?").run(new Date(Date.now() - 3600e3).toISOString(), c.data.card.id);
  const ex = await json('POST', '/verify', { token: adminToken, body: { token: c.data.token, lat: 1.5, lng: 2.5 } });
  assert.equal(ex.data.valid, false);
  assert.ok(ex.data.reasons.includes('STATUS_EXPIRED'), `expected STATUS_EXPIRED in ${JSON.stringify(ex.data.reasons)}`);
  // Admin has no zone → UNKNOWN_ZONE informational; second identical scan → DUPLICATE_SCAN, both still valid on a fresh card.
  const h2 = await json('POST', '/holders', { token: adminToken, body: { fullName: 'Dupe Reporter', org: 'Dupe Org' } });
  assert.equal(h2.status, 201);
  const c2 = await json('POST', '/cards', { token: adminToken, body: { holderId: h2.data.holder.id, validDays: 30, zones: [] } });
  assert.equal(c2.status, 201);
  // backdate valid_from so FIRST_SCAN_LATE does not pollute this check... it is informational anyway; just assert validity + codes.
  const v1 = await json('POST', '/verify', { token: adminToken, body: { token: c2.data.token, lat: 3.25, lng: 4.75 } });
  assert.equal(v1.data.valid, true);
  assert.ok(v1.data.reasons.includes('UNKNOWN_ZONE'), `expected UNKNOWN_ZONE in ${JSON.stringify(v1.data.reasons)}`);
  const v2 = await json('POST', '/verify', { token: adminToken, body: { token: c2.data.token, lat: 3.25, lng: 4.75 } });
  assert.equal(v2.data.valid, true);
  assert.ok(v2.data.reasons.includes('DUPLICATE_SCAN'), `expected DUPLICATE_SCAN in ${JSON.stringify(v2.data.reasons)}`);
  assert.ok(v2.data.reasons.includes('UNKNOWN_ZONE'), `expected UNKNOWN_ZONE in ${JSON.stringify(v2.data.reasons)}`);
});
