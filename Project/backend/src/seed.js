'use strict';
const bcrypt = require('bcryptjs');
const db = require('./db');

if (!process.env.JWT_SECRET) {
  console.warn('[seed] WARNING: JWT_SECRET not set, using dev default (ALLOW_DEV_SECRET=1). Set JWT_SECRET in production.');
}

const now = () => new Date().toISOString();

function ensureAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password_hash, role, org_name, zone, active, created_at, must_change) VALUES (?,?,?,?,?,?,?,1)')
      .run('admin', hash, 'admin', '', '', 1, now());
    console.log('Seeded admin / admin123 (must-change: rotate on first login)');
  }
}

ensureAdmin();

// ---- cycle 7: one-command demo (PRESSID_DEMO=1) ----
// Only when the DB holds just the admin: create a demo issuer (Demo Press),
// a demo police officer (zone north), one holder + one active card
// (org Demo Press, zones [north]). Idempotent: skipped if demo users exist.
if (process.env.PRESSID_DEMO === '1') {
  const demoExists = db.prepare("SELECT COUNT(*) AS c FROM users WHERE username IN ('issuer-demo','officer-demo')").get().c;
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (demoExists > 0) {
    console.log('[demo] demo users already exist, skipping.');
  } else if (userCount !== 1) {
    console.log('[demo] DB already has non-admin users, skipping demo seed (delete them or use a fresh DB for the demo).');
  } else {
    const crypto = require('node:crypto');
    const issuerHash = bcrypt.hashSync('pass1234', 10);
    const officerHash = bcrypt.hashSync('pass1234', 10);
    const issuer = db.prepare('INSERT INTO users (username, password_hash, role, org_name, zone, active, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('issuer-demo', issuerHash, 'issuer', 'Demo Press', '', 1, now());
    const issuerId = Number(issuer.lastInsertRowid);
    db.prepare('INSERT INTO users (username, password_hash, role, org_name, zone, active, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('officer-demo', officerHash, 'police', '', 'north', 1, now());
    const holder = db.prepare('INSERT INTO holders (user_id, full_name, org, designation, id_ref, photo_hash, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(null, 'Demo Reporter', 'Demo Press', 'Reporter', 'DEMO-001', '', issuerId, now());
    const holderId = Number(holder.lastInsertRowid);
    const from = new Date();
    const till = new Date(from.getTime() + 365 * 86400000);
    const nonce = crypto.randomBytes(12).toString('hex');
    const card = db.prepare('INSERT INTO cards (holder_id, valid_from, valid_till, zones, status, revoke_reason, nonce, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(holderId, from.toISOString(), till.toISOString(), JSON.stringify(['north']), 'active', '', nonce, issuerId, now());
    const cardId = Number(card.lastInsertRowid);
    console.log(`[demo] seeded card ${cardId} for holder ${holderId} (Demo Press, zones [north])`);
    console.log('');
    console.log('Demo credentials:');
    console.log('  admin        / admin123  (admin)');
    console.log('  issuer-demo  / pass1234  (issuer, org Demo Press)');
    console.log('  officer-demo / pass1234  (police, zone north)');
    console.log('');
    console.log('Demo flow:');
    console.log('  1. Login as officer-demo, verify the demo card: POST /api/verify {token} → valid:true');
    console.log('  2. Login as issuer-demo, issue another card: POST /api/cards {holderId}');
    console.log('  3. Revoke it: POST /api/cards/:id/revoke → verify again → REVOKED');
    console.log('');
    console.log('Sample:');
    console.log('  BASE=http://localhost:4000/api');
    console.log('  TOKEN=$(curl -s -X POST $BASE/auth/login -H \'Content-Type: application/json\' \\');
    console.log('    -d \'{"username":"officer-demo","password":"pass1234"}\' | node -pe "JSON.parse(require(\'fs\').readFileSync(0,\'utf8\')).token")');
    console.log(`  curl -s $BASE/cards/${cardId} -H "Authorization: Bearer $TOKEN"`);
  }
}

// ---- cycle 22: protest-day scenario out of the box ----
// Ensure the demo holder owns a live event card (event_name 'Demo Bandh',
// zones [north], event_end = now + 48h). Runs whenever PRESSID_DEMO=1 —
// including re-runs where the demo users already exist. Idempotent: skipped
// when a 'Demo Bandh' card already exists for the demo holder.
if (process.env.PRESSID_DEMO === '1') {
  try {
    const demoHolder = db.prepare("SELECT * FROM holders WHERE full_name = 'Demo Reporter' AND org = 'Demo Press' ORDER BY id LIMIT 1").get();
    if (!demoHolder) {
      console.log('[demo] no demo holder found, skipping event card.');
    } else {
      const existing = db.prepare('SELECT id FROM cards WHERE holder_id = ? AND event_name = ? LIMIT 1').get(demoHolder.id, 'Demo Bandh');
      if (existing) {
        console.log(`[demo] event card ${existing.id} ('Demo Bandh') already exists, skipping.`);
      } else {
        const crypto = require('node:crypto');
        const issuerRow = db.prepare("SELECT id FROM users WHERE username = 'issuer-demo' LIMIT 1").get();
        const from = new Date();
        const till = new Date(from.getTime() + 365 * 86400000);
        const eventEnd = new Date(from.getTime() + 48 * 3600000).toISOString();
        const nonce = crypto.randomBytes(12).toString('hex');
        const card = db.prepare('INSERT INTO cards (holder_id, valid_from, valid_till, zones, status, revoke_reason, nonce, created_by, created_at, event_name, event_end) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(demoHolder.id, from.toISOString(), till.toISOString(), JSON.stringify(['north']), 'active', '', nonce, issuerRow ? issuerRow.id : null, now(), 'Demo Bandh', eventEnd);
        console.log(`[demo] seeded event card ${Number(card.lastInsertRowid)} ('Demo Bandh', zones [north], event_end ${eventEnd})`);
      }
    }
  } catch (e) {
    console.log('[demo] event card seed skipped:', e.message);
  }
}

const admin = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get('admin');
console.log('Users in DB:', db.prepare('SELECT COUNT(*) AS c FROM users').get().c);
if (admin) console.log('Login with: admin / admin123');
