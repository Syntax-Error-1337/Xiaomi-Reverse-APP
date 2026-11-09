'use strict';
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const db = require('./db');

// JWT secret rotation (cycle 35): graceful rotation with a grace window.
// Like the Ed25519 rotation, verify tries current then falls back to prev
// so sessions minted before a rotation keep working. signUser always uses
// current. Precedence: data/keys/jwt.json ({current, prev, rotatedAt}, 0600)
// if present, else JWT_SECRET / JWT_PREV_SECRET env.
const KEYS_DIR = process.env.PRESSID_KEYS_DIR || path.join(__dirname, '..', 'data', 'keys');
const JWT_FILE = path.join(KEYS_DIR, 'jwt.json');

const DEV_DEFAULT = 'dev-secret-change-me';

let current;
let prev = null;
let rotatedAt = null;
let source = 'env';

function loadSecrets() {
  try {
    const j = JSON.parse(fs.readFileSync(JWT_FILE, 'utf8'));
    if (typeof j.current === 'string' && j.current.length > 0) {
      current = j.current;
      prev = typeof j.prev === 'string' && j.prev.length > 0 ? j.prev : null;
      rotatedAt = typeof j.rotatedAt === 'string' ? j.rotatedAt : null;
      source = 'file';
      return;
    }
  } catch (_) {}
  current = process.env.JWT_SECRET || DEV_DEFAULT;
  prev = process.env.JWT_PREV_SECRET || null;
  rotatedAt = null;
  source = 'env';
}

loadSecrets();

if (source === 'env' && !process.env.JWT_SECRET) {
  console.warn('[auth] WARNING: JWT_SECRET not set, using dev default. Set JWT_SECRET in production.');
}

function getSecrets() {
  return { current, prev, rotatedAt, source };
}

function hasJwtFile() {
  try {
    const j = JSON.parse(fs.readFileSync(JWT_FILE, 'utf8'));
    return typeof j.current === 'string' && j.current.length > 0;
  } catch (_) {
    return false;
  }
}

// Never leaks values — shape only.
function secretInfo() {
  return { hasPrev: !!prev, rotatedAt, source };
}

// newSecret must be >= 32 chars (validated here and at the route).
function rotateSecret(newSecret) {
  if (typeof newSecret !== 'string' || newSecret.length < 32) {
    throw new Error('newSecret must be a string >= 32 chars');
  }
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  prev = current;
  current = newSecret;
  rotatedAt = new Date().toISOString();
  source = 'file';
  fs.writeFileSync(JWT_FILE, JSON.stringify({ current, prev, rotatedAt }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(JWT_FILE, 0o600); } catch (_) {}
  return { rotatedAt };
}

function signUser(user) {
  return jwt.sign({ id: user.id, role: user.role }, current, { expiresIn: '12h' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, current);
  } catch (_) {}
  if (prev) {
    try {
      return jwt.verify(token, prev);
    } catch (_) {}
  }
  return null;
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: 'Missing token' });
  const decoded = verifyToken(m[1]);
  if (!decoded) return res.status(401).json({ error: 'Invalid token' });
  const row = db.prepare('SELECT id, username, role, org_name AS orgName, zone, active, must_change FROM users WHERE id = ?').get(decoded.id);
  if (!row || !row.active) return res.status(401).json({ error: 'User inactive or deleted' });
  req.user = { id: row.id, username: row.username, role: row.role, orgName: row.orgName || '', zone: row.zone || '' };
  // Forced rotation: temp creds (press) + fresh-seeded admin carry must_change=1
  // and may only call login + change-password until they rotate. This gate lives
  // here (not per-route) so every current and future guarded route is covered.
  if (row.must_change && (row.role === 'press' || row.role === 'admin') && req.path !== '/api/auth/change-password') {
    return res.status(403).json({ error: 'Password change required', code: 'MUST_CHANGE_PASSWORD' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

module.exports = {
  authMiddleware,
  requireRole,
  signUser,
  verifyToken,
  secretInfo,
  rotateSecret,
  hasJwtFile,
};
