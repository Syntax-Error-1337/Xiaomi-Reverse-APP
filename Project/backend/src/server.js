'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const db = require('./db');
const keys = require('./keys');
const { authMiddleware, requireRole, signUser, verifyToken, secretInfo, rotateSecret, hasJwtFile } = require('./auth');
const { makeLimiter } = require('./rateLimit');
const { mintCard, verifyTokenLocal, randomNonce } = require('./cards');
const { statusReasons, cloneFlags } = require('./antiClone');
const { scoreRisk } = require('./risk');
// Photo bytes live on disk (never in sqlite): data/photos/<sha256hex>.bin.
// PRESSID_DATA overrides the data dir (tests); PRESSID_DB throwaways keep
// photos beside the temp DB so the real data/ is never touched; else backend/data.
const PHOTOS_DIR = process.env.PRESSID_DATA
  ? path.join(process.env.PRESSID_DATA, 'photos')
  : process.env.PRESSID_DB
    ? path.join(path.dirname(process.env.PRESSID_DB), 'photos')
    : path.join(__dirname, '..', 'data', 'photos');
const app = express();
app.disable('x-powered-by');
// Behind compose/nginx all clients share the socket peer — trust the proxy
// (single hop) so req.ip honors X-Forwarded-For and per-IP login/anon
// limiters bucket real clients instead of one global bucket.
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.set('Access-Control-Expose-Headers', 'Retry-After');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
// Tiny request logger: method path status ms. Never logs bodies or tokens.
// Silenced under test / PRESSID_QUIET=1 (regression suite is noisy otherwise).
const QUIET_LOGS = !!process.env.PRESSID_QUIET || process.env.NODE_ENV === 'test';
app.use((req, res, next) => {
  if (QUIET_LOGS) return next();
  const t0 = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t0}ms`);
  });
  next();
});
// helmet-lite: sensitive endpoints must never be cached.
// Covers credential-bearing routes: /auth (tokens), /cards (tokens+QR),
// /me (scan history), /holders (tempPassword mint), /users (account creds),
// POST /verify (scan results).
app.use((req, res, next) => {
  if (req.path.startsWith('/api/auth/') || req.path.startsWith('/api/cards') || req.path.startsWith('/api/me/') || req.path.startsWith('/api/holders') || req.path.startsWith('/api/users') || (req.path === '/api/verify' && req.method === 'POST')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

const now = () => new Date().toISOString();
function audit(byUserId, action, detail) {
  try {
    const at = now();
    const by = byUserId || null;
    const det = detail || '';
    const prev = db.prepare('SELECT entry_hash FROM audit ORDER BY id DESC LIMIT 1').get()?.entry_hash || db.AUDIT_GENESIS || 'GENESIS';
    const h = db.auditHash(prev, at, by, action, det);
    db.prepare('INSERT INTO audit (at, by_user, action, detail, prev_hash, entry_hash) VALUES (?,?,?,?,?,?)')
      .run(at, by, action, det, prev, h);
  } catch (_) {}
}

const loginFails = new Map();
// Fixed dummy hash for timing-equalized misses (computed once at boot).
const DUMMY_HASH = bcrypt.hashSync('pressid-dummy-oracle-guard', 10);
function loginBlocked(ip) {
  const e = loginFails.get(ip);
  if (!e) return false;
  if (Date.now() - e.firstAt > 5 * 60 * 1000) { loginFails.delete(ip); return false; }
  return e.fails >= 10;
}
function loginFail(ip) {
  const e = loginFails.get(ip);
  if (!e || Date.now() - e.firstAt > 5 * 60 * 1000) loginFails.set(ip, { fails: 1, firstAt: Date.now() });
  else { e.fails += 1; loginFails.set(ip, e); }
}
// ---- authed rate limits (cycle 18) ----
// Sliding window per (user.id + route group). Per-group limiters are wired
// AFTER auth on the expensive routes so the key is the authenticated user.
// Admins obey the same limits (uniform, simpler). Login limiter above is
// untouched (separate IP-based fail counter).
const byUser = (group) => (req) => `${req._backstopUid ?? (req.user && req.user.id) ?? req.ip ?? 'anon'}:${group}`;
const verifyLimiter = makeLimiter({ windowMs: 60 * 1000, max: 60, key: byUser('verify') });
const exportLimiter = makeLimiter({ windowMs: 60 * 1000, max: 10, key: byUser('export') });
const auditVerifyLimiter = makeLimiter({ windowMs: 60 * 1000, max: 20, key: byUser('auditVerify') });

// Issuance velocity cap (cycle 24): a compromised issuer account can flood
// cards before anyone notices — cap at 20 issues/hour per issuer (429 after).
// Admins are exempt (trusted root; bulk/quota flows stay uncapped).
const issueLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, max: 20, key: byUser('issue') });
const issueVelocityGuard = (req, res, next) => {
  if (req.user && req.user.role === 'admin') return next();
  return issueLimiter(req, res, next);
};
// Forced rotation (cycle 24, extended 47): logins created with must_change=1
// (press temp creds, fresh-seeded admin) may only call login + change-password
// until they rotate. Everything else → 403.
function requireFreshPassword(req, res, next) {
  if (req.user && (req.user.role === 'press' || req.user.role === 'admin')) {
    const row = db.prepare('SELECT must_change FROM users WHERE id = ?').get(req.user.id);
    if (row && row.must_change) {
      return res.status(403).json({ error: 'Password change required', code: 'MUST_CHANGE_PASSWORD' });
    }
  }
  next();
};
const authedBackstop = makeLimiter({ windowMs: 60 * 1000, max: 300, key: byUser('default') });
// Backstop covers every authed /api call except /health. It must run globally
// (before per-route auth), so it keys off the verified JWT id directly: valid
// tokens land in the owner's bucket, garbage tokens in an IP bucket (a forged
// "id" claim can never burn someone else's window).
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/auth/login') return next();
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return next();
  const d = verifyToken(m[1]);
  const uid = d ? d.id : null;
  req._backstopUid = (uid !== null && uid !== undefined) ? uid : (req.ip || 'anon');
  return authedBackstop(req, res, next);
});

function parseFlags(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch (_) {
    return String(s).split(',').map((x) => x.trim()).filter(Boolean);
  }
}
// Reasons that are informational only: kept in `reasons` but excluded from the
// validity decision. UNKNOWN_ZONE = officer has no zone assigned; DUPLICATE_SCAN
// = identical lat/lng for the same card within the last 60s; EVENT_ACTIVE = live
// event assignment; FIRST_SCAN_LATE = card's first scan ever landed >1h after
// issue (possible pre-shared screenshot photographed later); SAME_POST_RESCAN =
// same card re-scanned from the same officer zone within 10 min at different
// coords (possible pass-back through a crowd; DUPLICATE_SCAN covers identical
// coords <60s, this covers the same-post wider window).
const INFORMATIONAL_REASONS = new Set(['UNKNOWN_ZONE', 'DUPLICATE_SCAN', 'EVENT_ACTIVE', 'FIRST_SCAN_LATE', 'SAME_POST_RESCAN']);


function cardView(cardId) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) return null;
  const holder = db.prepare('SELECT * FROM holders WHERE id = ?').get(card.holder_id);
  if (!holder) return null;
  let zones = [];
  try { zones = JSON.parse(card.zones || '[]'); } catch (_) { zones = []; }
  // Reverse lookup: latest card whose replaces_id points at this one (or null).
  let replacedBy = null;
  try {
    const row = db.prepare('SELECT id FROM cards WHERE replaces_id = ? ORDER BY id DESC LIMIT 1').get(cardId);
    replacedBy = row ? row.id : null;
  } catch (_) { replacedBy = null; }
  return {
    id: card.id,
    holderId: card.holder_id,
    fullName: holder.full_name,
    org: holder.org,
    designation: holder.designation,
    status: card.status,
    validFrom: card.valid_from,
    validTill: card.valid_till,
    zones,
    eventName: card.event_name || null,
    eventEnd: card.event_end || null,
    replacesId: card.replaces_id ?? null,
    replacedBy,
    photoHash: holder.photo_hash,
    hasPhoto: !!holder.photo_hash,
    holderCheckedIn: !!holder.device_id,
    holder: { id: holder.id, fullName: holder.full_name, org: holder.org, designation: holder.designation },
  };
}

// ---- health ----
app.get('/api/health', (req, res) => {
  let keyKid = 'unknown';
  try {
    keyKid = keys.currentKid();
  } catch (_) {}
  let version = 'unknown';
  try {
    version = require('../package.json').version || 'unknown';
  } catch (_) {}
  res.json({ ok: true, version, time: new Date().toISOString(), db: 'sqlite', keyKid });
});

// ---- auth ----
app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (loginBlocked(ip)) return res.status(429).json({ error: 'Too many attempts' });
  const { username, password } = req.body || {};
  if (!username || !password) { loginFail(ip); return res.status(401).json({ error: 'Bad credentials' }); }
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // Dummy compare on miss: equalize timing so username existence isn't oracle-readable.
  if (!row || !row.active) { bcrypt.compareSync(password || 'x', DUMMY_HASH); loginFail(ip); return res.status(401).json({ error: 'Bad credentials' }); }
  if (!bcrypt.compareSync(password, row.password_hash)) { loginFail(ip); return res.status(401).json({ error: 'Bad credentials' }); }
  loginFails.delete(ip);
  const token = signUser(row);
  res.json({ token, user: { id: row.id, username: row.username, role: row.role, orgName: row.org_name || '' }, mustChange: !!row.must_change });
});
// Any authenticated user can rotate their own password. Press users created
// via /api/holders get must_change=1 and should call this with their temp creds.
app.post('/api/auth/change-password', authMiddleware, (req, res) => {
  const { oldPassword, newPassword } = (req.body || {});
  if (typeof oldPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'oldPassword and newPassword (>= 8 chars) required' });
  }
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!row) return res.status(401).json({ error: 'User inactive or deleted' });
  if (!bcrypt.compareSync(oldPassword, row.password_hash)) return res.status(403).json({ error: 'Wrong password' });
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_change = 0 WHERE id = ?').run(hash, req.user.id);
  res.json({ ok: true });
});
function pubUser(r) {
  return { id: r.id, username: r.username, role: r.role, orgName: r.org_name || '', zone: r.zone || '', active: !!r.active, quota: r.quota ?? null };
}

// ---- users (admin) ----
app.get('/api/users', authMiddleware, requireRole('admin'), (req, res) => {
  const rows = db.prepare('SELECT id, username, role, org_name, zone, active, quota FROM users ORDER BY id').all();
  res.json(rows.map((r) => ({ id: r.id, username: r.username, role: r.role, orgName: r.org_name || '', zone: r.zone || '', active: !!r.active, quota: r.quota ?? null })));
});

app.post('/api/users', authMiddleware, requireRole('admin'), (req, res) => {
  const { username, password, role, orgName, zone } = req.body || {};
  if (!username || !password || !role) return res.status(400).json({ error: 'username, password, role required' });
  if (!['issuer', 'police'].includes(role)) {
    return res.status(400).json({ error: 'role must be issuer or police' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 chars' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const r = db.prepare('INSERT INTO users (username, password_hash, role, org_name, zone, active, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(username, hash, role, orgName || '', zone || '', 1, now());
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid));
    audit(req.user.id, 'user.create', `${row.username} (${row.role})`);
    res.status(201).json(pubUser(row));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Username taken' });
    throw e;
  }
});

app.patch('/api/users/:id/active', authMiddleware, requireRole('admin'), (req, res) => {
  const { active } = req.body || {};
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active must be a boolean' });
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!active && row.role === 'admin') {
    const others = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id != ?").get(row.id).c;
    if (others === 0) return res.status(403).json({ error: 'Cannot deactivate the last active admin' });
  }
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
  audit(req.user.id, 'user.set_active', `${row.username} active=${active ? 1 : 0}`);
  res.json(pubUser(row));
});
// Admin-set cap on active cards per issuer org (NULL = unlimited).
app.patch('/api/users/:id/quota', authMiddleware, requireRole('admin'), (req, res) => {
  const { quota } = (req.body || {});
  if (quota !== null && !(Number.isInteger(quota) && quota >= 0)) {
    return res.status(400).json({ error: 'quota must be an integer >= 0 or null' });
  }
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE users SET quota = ? WHERE id = ?').run(quota, req.params.id);
  audit(req.user.id, 'user.quota', `${row.username} quota=${quota === null ? 'null' : quota}`);
  res.json({ id: row.id, username: row.username, quota: quota === null ? null : quota });
});

// ---- holders ----
function holderRow(id) { return db.prepare('SELECT * FROM holders WHERE id = ?').get(id); }
function holderPublic(h) {
  return { id: h.id, userId: h.user_id, fullName: h.full_name, org: h.org, designation: h.designation, idRef: h.id_ref, photoHash: h.photo_hash, createdBy: h.created_by, createdAt: h.created_at };
}

app.post('/api/holders', authMiddleware, requireRole('issuer', 'admin'), (req, res) => {
  const { fullName, org, designation, idRef, photoHash } = req.body || {};
  if (!fullName || !org) return res.status(400).json({ error: 'fullName and org required' });
  const effOrg = req.user.role === 'issuer' ? req.user.orgName : org;
  if (req.user.role === 'issuer' && org !== req.user.orgName) {
    return res.status(403).json({ error: 'Issuers can only create holders in their own org' });
  }
  const username = 'press-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const tempPassword = crypto.randomBytes(9).toString('base64url');
  const hash = bcrypt.hashSync(tempPassword, 10);
  const u = db.prepare('INSERT INTO users (username, password_hash, role, org_name, zone, active, created_at, must_change) VALUES (?,?,?,?,?,?,?,1)')
    .run(username, hash, 'press', effOrg, '', 1, now());
  const userId = Number(u.lastInsertRowid);
  // photoHash is issuer-uploaded only (POST /holders/:id/photo) — ignore any
  // client-supplied value here so holder-create can't spoof the checkpoint chip.
  const h = db.prepare('INSERT INTO holders (user_id, full_name, org, designation, id_ref, photo_hash, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(userId, fullName, effOrg, designation || '', idRef || '', '', req.user.id, now());
  res.status(201).json({ holder: holderPublic(holderRow(Number(h.lastInsertRowid))), username, tempPassword });
});

app.get('/api/holders', authMiddleware, requireRole('issuer', 'admin'), (req, res) => {
  let rows;
  if (req.user.role === 'admin') rows = db.prepare('SELECT * FROM holders ORDER BY id').all();
  else rows = db.prepare('SELECT * FROM holders WHERE org = ? ORDER BY id').all(req.user.orgName);
  res.json(rows.map(holderPublic));
});

// ---- cards ----
app.post('/api/cards', authMiddleware, requireRole('issuer', 'admin'), issueVelocityGuard, async (req, res) => {
  const { holderId, validDays, zones, eventName, eventEnd, replacesId } = req.body || {};
  // Replacement path: replacesId must reference an own-org terminal card
  // (reported|revoked|expired). The new card inherits holder/zones/event from
  // the old one unless the body explicitly overrides them.
  let oldCard = null;
  let oldHolder = null;
  let replacesIdNum = null;
  if (replacesId !== undefined && replacesId !== null && String(replacesId).trim() !== '') {
    replacesIdNum = Number(replacesId);
    if (!Number.isInteger(replacesIdNum)) return res.status(400).json({ error: 'replacesId must be a card id' });
    db.touchExpiry();
    oldCard = db.prepare('SELECT * FROM cards WHERE id = ?').get(replacesIdNum);
    if (!oldCard) return res.status(400).json({ error: 'replacesId: card not found' });
    oldHolder = holderRow(oldCard.holder_id);
    if (!oldHolder) return res.status(400).json({ error: 'replacesId: holder missing' });
    if (req.user.role === 'issuer' && oldHolder.org !== req.user.orgName) {
      return res.status(403).json({ error: 'Replaced card not in your org' });
    }
    if (!['reported', 'revoked', 'expired'].includes(oldCard.status)) {
      return res.status(400).json({ error: 'replacesId: card must be reported, revoked, or expired' });
    }
    const fork = db.prepare('SELECT id FROM cards WHERE replaces_id = ? LIMIT 1').get(replacesIdNum);
    if (fork) return res.status(409).json({ error: 'replacesId: card already replaced', replacedBy: fork.id });
  }
  let oldZones = [];
  if (oldCard) { try { oldZones = JSON.parse(oldCard.zones || '[]'); } catch (_) { oldZones = []; } }
  const hasHolder = holderId !== undefined && holderId !== null && String(holderId).trim() !== '';
  const effHolderId = hasHolder ? Number(holderId) : (oldCard ? oldCard.holder_id : null);
  if (!effHolderId) return res.status(400).json({ error: 'holderId required' });
  const holder = holderRow(effHolderId);
  if (!holder) return res.status(404).json({ error: 'Holder not found' });
  if (req.user.role === 'issuer' && holder.org !== req.user.orgName) {
    return res.status(403).json({ error: 'Holder not in your org' });
  }
  if (oldCard && holder.id !== oldCard.holder_id) {
    return res.status(400).json({ error: 'Replacement must use the same holder' });
  }
  // Event-scoped passes: event name requires zones; event_end must be a valid ISO date.
  // On replacement, explicit body wins; otherwise inherit from the old card.
  const bodyHasEventName = eventName !== undefined && eventName !== null && String(eventName).trim() !== '';
  const bodyHasEventEnd = eventEnd !== undefined && eventEnd !== null && String(eventEnd).trim() !== '';
  const evName = bodyHasEventName ? String(eventName).trim()
    : (oldCard && oldCard.event_name ? String(oldCard.event_name) : '');
  let evEnd = null;
  const evEndRaw = bodyHasEventEnd ? eventEnd : (oldCard ? oldCard.event_end : null);
  if (evEndRaw !== undefined && evEndRaw !== null && String(evEndRaw).trim() !== '') {
    const d = new Date(evEndRaw);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'eventEnd must be ISO date' });
    evEnd = d.toISOString();
  }
  const zoneArr = Array.isArray(zones) ? zones
    : (typeof zones === 'string' && zones.trim() !== '' ? zones.split(',').map((z) => z.trim()).filter(Boolean)
    : (oldCard ? oldZones : []));
  if (evName && zoneArr.length === 0) return res.status(400).json({ error: 'zones required when eventName set' });
  // Issuer org quota: active cards across all holders in the issuer's org.
  // quota NULL = unlimited. Admin issues are not quota-limited.
  if (req.user.role === 'issuer') {
    const me = db.prepare('SELECT quota FROM users WHERE id = ?').get(req.user.id);
    if (me && me.quota !== null && me.quota !== undefined) {
      const count = db.prepare(
        "SELECT COUNT(*) AS c FROM cards JOIN holders ON holders.id = cards.holder_id " +
        "WHERE cards.status = 'active' AND holders.org = ?"
      ).get(req.user.orgName).c;
      if (count >= me.quota) return res.status(403).json({ error: 'Org quota exceeded' });
    }
  }
  const days = Number.isFinite(Number(validDays)) ? Math.min(Math.max(Math.floor(Number(validDays)), 1), 1825) : 365;
  const from = new Date();
  const till = new Date(from.getTime() + days * 86400000);
  const c = db.prepare('INSERT INTO cards (holder_id, valid_from, valid_till, zones, status, revoke_reason, nonce, created_by, created_at, event_name, event_end, replaces_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(holder.id, from.toISOString(), till.toISOString(), JSON.stringify(zoneArr), 'active', '', randomNonce(), req.user.id, now(), evName || null, evEnd, replacesIdNum);
  const cardId = Number(c.lastInsertRowid);
  audit(req.user.id, 'card.issue', `card ${cardId} holder ${holder.id}`);
  if (oldCard) audit(req.user.id, 'card.replace', `old ${oldCard.id} new ${cardId}`);
  const cardDb = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  const { token } = mintCard(cardDb, holder);
  const qrDataUrl = await QRCode.toDataURL(token);
  res.status(201).json({ card: cardView(cardId), token, qrDataUrl });
});

app.get('/api/cards', authMiddleware, requireRole('issuer', 'admin', 'press'), requireFreshPassword, (req, res) => {
  db.touchExpiry();
  const evFilter = typeof req.query.event === 'string' ? req.query.event.trim().toLowerCase() : '';
  const activeOnly = req.query.active === '1' || req.query.active === 'true';
  const applyFilters = (views) => views.filter((v) => {
    if (activeOnly && v.status !== 'active') return false;
    if (evFilter && !String(v.eventName || '').toLowerCase().includes(evFilter)) return false;
    return true;
  });
  if (req.user.role === 'press') {
    const h = db.prepare('SELECT * FROM holders WHERE user_id = ?').get(req.user.id);
    if (!h) return res.json([]);
    const cards = db.prepare('SELECT id FROM cards WHERE holder_id = ? ORDER BY id').all(h.id);
    return res.json(applyFilters(cards.map((c) => cardView(c.id))));
  }
  if (req.user.role === 'admin') {
    const cards = db.prepare('SELECT id FROM cards ORDER BY id').all();
    return res.json(applyFilters(cards.map((c) => cardView(c.id))));
  }
  // issuer: own org → holders of org
  const holders = db.prepare('SELECT id FROM holders WHERE org = ?').all(req.user.orgName);
  const ids = holders.map((h) => h.id);
  if (!ids.length) return res.json([]);
  const cards = db.prepare(`SELECT id FROM cards WHERE holder_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
  res.json(applyFilters(cards.map((c) => cardView(c.id))));
});

app.get('/api/cards/:id', authMiddleware, requireRole('issuer', 'admin', 'press'), requireFreshPassword, async (req, res) => {
  db.touchExpiry();
  const v = cardView(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'issuer') {
    const holder = holderRow(v.holderId);
    if (holder.org !== req.user.orgName) return res.status(403).json({ error: 'Forbidden' });
  }
  if (req.user.role === 'press') {
    const h = db.prepare('SELECT * FROM holders WHERE user_id = ?').get(req.user.id);
    if (!h || h.id !== v.holderId) return res.status(403).json({ error: 'Forbidden' });
  }
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(req.params.id));
  const holder = db.prepare('SELECT * FROM holders WHERE id = ?').get(v.holderId);
  const { token } = mintCard(card, holder);
  const qrDataUrl = await QRCode.toDataURL(token);
  res.json({ ...v, card: v, token, qrDataUrl });
});

app.post('/api/cards/:id/revoke', authMiddleware, requireRole('issuer', 'admin'), (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'issuer') {
    const holder = holderRow(card.holder_id);
    if (!holder || holder.org !== req.user.orgName) return res.status(403).json({ error: 'Forbidden' });
  }
  db.prepare("UPDATE cards SET status = 'revoked', revoke_reason = ? WHERE id = ?")
    .run((req.body && req.body.reason) || '', card.id);
  audit(req.user.id, 'card.revoke', `card ${card.id}`);
  res.json({ ok: true });
});
// ---- press self-service (cycle 13) ----
app.get('/api/me/scans', authMiddleware, requireRole('press'), requireFreshPassword, (req, res) => {
  const h = db.prepare('SELECT * FROM holders WHERE user_id = ?').get(req.user.id);
  if (!h) return res.json([]);
  const rows = db.prepare(
    'SELECT s.card_id, s.at, s.lat, s.lng, s.result, s.flags, s.officer_zone FROM scans s ' +
    // Chrono order (iteration W): flushed offline scans carry old `at` with
    // new ids — id-DESC would sort them as newest. Same for lastScans + GET.
    'JOIN cards c ON c.id = s.card_id WHERE c.holder_id = ? ORDER BY s.at DESC, s.id DESC LIMIT 100'
  ).all(h.id);
  res.json(rows.map((s) => ({ cardId: s.card_id, at: s.at, lat: s.lat, lng: s.lng, result: s.result, flags: parseFlags(s.flags), officerZone: s.officer_zone || '' })));
});
app.post('/api/me/report-loss', authMiddleware, requireRole('press'), requireFreshPassword, (req, res) => {
  const cardId = Number((req.body || {}).cardId);
  if (!Number.isFinite(cardId)) return res.status(400).json({ error: 'cardId required' });
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) return res.status(404).json({ error: 'Not found' });
  const h = db.prepare('SELECT * FROM holders WHERE user_id = ?').get(req.user.id);
  if (!h || h.id !== card.holder_id) return res.status(403).json({ error: 'Forbidden' });
  db.prepare("UPDATE cards SET status = 'reported' WHERE id = ?").run(card.id);
  audit(req.user.id, 'card.report_loss', `card ${card.id}`);
  res.json({ ok: true });
});
// ---- cycle 39: voluntary press device check-in (signal only) ----
// Stores a client-generated device UUID on the holder row. Informational:
// printed cards verify VALID with or without it. Surfaced as holderCheckedIn
// on card views + verify; audited as holder.checkin.
app.post('/api/me/check-in', authMiddleware, requireRole('press'), requireFreshPassword, (req, res) => {
  const deviceId = (req.body || {}).deviceId;
  if (typeof deviceId !== 'string' || deviceId.length < 8 || deviceId.length > 64) {
    return res.status(400).json({ error: 'deviceId required (8-64 chars)' });
  }
  const h = db.prepare('SELECT * FROM holders WHERE user_id = ?').get(req.user.id);
  if (!h) return res.status(404).json({ error: 'Holder not found' });
  const at = now();
  db.prepare('UPDATE holders SET device_id = ?, device_at = ? WHERE id = ?').run(deviceId, at, h.id);
  audit(req.user.id, 'holder.checkin', `holder ${h.id}`);
  res.json({ ok: true, deviceAt: at });
});

// ---- verify ----
app.post('/api/verify', authMiddleware, requireRole('police', 'admin'), verifyLimiter, (req, res) => {
  db.touchExpiry();
  const { token, lat, lng } = req.body || {};
  const nowMs = Date.now();
  const v = verifyTokenLocal(token);
  if (!v.ok) {
    const risk = scoreRisk({ reasons: [v.error], alerts: [], valid: false });
    return res.json({ valid: false, reasons: [v.error], card: null, lastScans: [], alerts: [], risk, photoUrl: null });
  }
  const p = v.payload;
  const cardDb = db.prepare('SELECT * FROM cards WHERE id = ?').get(p.cardId);
  const holder = cardDb ? holderRow(cardDb.holder_id) : null;

  let cardOut = null;
  if (cardDb && holder) {
    let zones = [];
    try { zones = JSON.parse(cardDb.zones || '[]'); } catch (_) {}
    cardOut = {
      id: cardDb.id, holderId: holder.id, fullName: holder.full_name, org: holder.org,
      designation: holder.designation, status: cardDb.status,
      validTill: cardDb.valid_till, photoHash: holder.photo_hash, hasPhoto: !!holder.photo_hash, holderCheckedIn: !!holder.device_id, zones,
      eventName: cardDb.event_name || null, eventEnd: cardDb.event_end || null,
    };
  }

  const reasons = [];
  let cardZones = [];
  if (!cardDb || !holder) {
    reasons.push('CARD_NOT_FOUND');
  } else {
    // cross-check signed fields vs DB
    if (p.holderId !== holder.id || p.name !== holder.full_name || p.org !== holder.org ||
        p.validTill !== cardDb.valid_till || p.nonce !== cardDb.nonce) {
      reasons.push('TAMPER_MISMATCH');
    }
    reasons.push(...statusReasons(cardDb, nowMs));
    try { cardZones = JSON.parse(cardDb.zones || '[]'); } catch (_) { cardZones = []; }
    if (!Array.isArray(cardZones)) cardZones = [];
    const officerRow = db.prepare('SELECT zone FROM users WHERE id = ?').get(req.user.id);
    const officerZone = (officerRow && officerRow.zone) || '';
    if (!officerZone) {
      // Informational: officer has no zone assigned — kept in reasons, does not block.
      reasons.push('UNKNOWN_ZONE');
    } else if (cardZones.length > 0 && !cardZones.includes(officerZone)) {
      reasons.push('OUT_OF_ZONE');
    }
    // EVENT_ACTIVE: informational context — live event assignment (touchExpiry flips first).
    if (cardDb.event_name) {
      const ee = cardDb.event_end ? Date.parse(cardDb.event_end) : NaN;
      if (!cardDb.event_end || Number.isNaN(ee) || nowMs < ee) reasons.push('EVENT_ACTIVE');
    }
    // FIRST_SCAN_LATE: first scan ever for this card landing >1h after issue.
    // Fresh event passes scan within minutes at the gate; a screenshot
    // photographed days later trips this. Informational only — never blocks.
    try {
      const priorCount = db.prepare('SELECT COUNT(*) AS c FROM scans WHERE card_id = ?').get(cardDb.id).c;
      if (priorCount === 0) {
        const issuedMs = Date.parse(cardDb.valid_from);
        if (Number.isFinite(issuedMs) && nowMs - issuedMs > 3600000) reasons.push('FIRST_SCAN_LATE');
      }
    } catch (_) {}
    // DUPLICATE_SCAN: identical lat/lng (tolerance 1e-6) for this card within last 60s.
    // Informational only — kept in reasons, does not block.
    if (typeof lat === 'number' && typeof lng === 'number') {
      const cutoff = new Date(nowMs - 60000).toISOString();
      const prior = db.prepare('SELECT lat, lng FROM scans WHERE card_id = ? AND at >= ?').all(cardDb.id, cutoff);
      for (const s of prior) {
        if (typeof s.lat === 'number' && typeof s.lng === 'number' &&
            Math.abs(s.lat - lat) <= 1e-6 && Math.abs(s.lng - lng) <= 1e-6) {
          reasons.push('DUPLICATE_SCAN');
          break;
        }
      }
    }
    // SAME_POST_RESCAN: same card + same non-empty officer zone, 1+ prior
    // scans within 10 min (any coords — pass-back through a crowd).
    // Informational only — kept in reasons, does not block.
    try {
      const ozRow = db.prepare('SELECT zone FROM users WHERE id = ?').get(req.user.id);
      const oz = (ozRow && ozRow.zone) || '';
      if (oz) {
        const cutoff10 = new Date(nowMs - 10 * 60000).toISOString();
        const priorSame = db.prepare(
          'SELECT COUNT(*) AS c FROM scans WHERE card_id = ? AND officer_zone = ? AND at >= ?',
        ).get(cardDb.id, oz, cutoff10).c;
        if (priorSame >= 1) reasons.push('SAME_POST_RESCAN');
      }
    } catch (_) {}
  }
  // Informational reasons (UNKNOWN_ZONE, DUPLICATE_SCAN, EVENT_ACTIVE,
  // FIRST_SCAN_LATE) are kept in `reasons` but excluded from validity.
  const valid = reasons.filter((r) => !INFORMATIONAL_REASONS.has(r)).length === 0;

  // log scan (only if card exists)
  let lastScans = [];
  let alerts = [];
  if (cardDb) {
    const result = valid ? 'valid' : 'invalid';
    const officerZone = (req.user && req.user.zone) || '';
    // Honor client-supplied scan time for flushed offline queue items
    // (iteration V): bound to [now-24h, now+5min] to stop timeline lies
    // without letting a bad clock rewrite history. Else server time.
    let atIso = new Date(nowMs).toISOString();
    const clientAt = Date.parse((req.body || {}).at);
    if (Number.isFinite(clientAt) && clientAt >= nowMs - 86400000 && clientAt <= nowMs + 300000) {
      atIso = new Date(clientAt).toISOString();
    }
    db.prepare('INSERT INTO scans (card_id, at, lat, lng, result, flags, by_user, officer_zone) VALUES (?,?,?,?,?,?,?,?)')
      .run(cardDb.id, atIso, typeof lat === 'number' ? lat : null, typeof lng === 'number' ? lng : null, result, '[]', req.user.id, officerZone || null);
    const recent20 = db.prepare('SELECT lat, lng, at FROM scans WHERE card_id = ? ORDER BY id DESC LIMIT 20').all(cardDb.id);
    const flags = cloneFlags(recent20.map((s) => ({ lat: s.lat, lng: s.lng, at: s.at })));
    // Persist reason-level rescan signal into the row flags too, so the
    // timeline/history views surface it (they read flags, not reasons).
    if (reasons.includes('SAME_POST_RESCAN') && !flags.includes('SAME_POST_RESCAN')) flags.push('SAME_POST_RESCAN');
    if (flags.length) {
      const lastId = db.prepare('SELECT id FROM scans WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(cardDb.id).id;
      db.prepare('UPDATE scans SET flags = ? WHERE id = ?').run(JSON.stringify(flags), lastId);
    }
    alerts = flags;
    lastScans = db.prepare('SELECT at, lat, lng, officer_zone, flags, result FROM scans WHERE card_id = ? ORDER BY at DESC, id DESC LIMIT 5').all(cardDb.id)
      .map((s) => ({ at: s.at, lat: s.lat, lng: s.lng, officerZone: s.officer_zone || '', flags: parseFlags(s.flags), result: s.result }));
  }

  const risk = scoreRisk({ reasons, alerts, valid });
  // photoUrl points at the holder photo endpoint (holder id from the card
  // row). Null when the card/holder is missing; the endpoint 404s when no
  // photo bytes exist.
  const photoUrl = cardDb && holder ? `/api/holders/${cardDb.holder_id}/photo` : null;
  res.json({ valid, reasons, card: cardOut, lastScans, alerts, risk, photoUrl });
});

function scanTriageView(s) {
  return { triage: s.triage || 'open', triagedBy: s.triagedBy || s.triaged_by_username || '', triagedAt: s.triaged_at || s.triagedAt || null };
}

app.get('/api/scans', authMiddleware, requireRole('police', 'admin'), (req, res) => {
  const { cardId } = req.query;
  if (req.user.role !== 'admin' && !cardId) return res.status(403).json({ error: 'cardId required' });
  let rows;
  if (cardId) rows = db.prepare('SELECT s.*, u.username AS triaged_by_username FROM scans s LEFT JOIN users u ON u.id = s.triaged_by WHERE s.card_id = ? ORDER BY s.at DESC, s.id DESC LIMIT 100').all(Number(cardId));
  else rows = db.prepare('SELECT s.*, u.username AS triaged_by_username FROM scans s LEFT JOIN users u ON u.id = s.triaged_by ORDER BY s.at DESC, s.id DESC LIMIT 100').all();
  res.json(rows.map((s) => ({ id: s.id, cardId: s.card_id, at: s.at, lat: s.lat, lng: s.lng, result: s.result, flags: parseFlags(s.flags), by: s.by_user, officerZone: s.officer_zone || '', ...scanTriageView(s) })));
});
app.patch('/api/scans/:id/triage', authMiddleware, requireRole('admin'), (req, res) => {
  const { state } = (req.body || {});
  if (state !== 'acked' && state !== 'resolved') return res.status(400).json({ error: "state must be 'acked' or 'resolved'" });
  const row = db.prepare('SELECT * FROM scans WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Scan not found' });
  const at = now();
  db.prepare('UPDATE scans SET triage = ?, triaged_by = ?, triaged_at = ? WHERE id = ?').run(state, req.user.id, at, row.id);
  audit(req.user.id, 'scan.triage', `scan ${row.id} state=${state}`);
  const tu = db.prepare('SELECT username FROM users WHERE id = ?').get(req.user.id);
  res.json({ id: row.id, triage: state, triagedBy: (tu && tu.username) || '', triagedAt: at });
});
app.get('/api/scans/:cardId/timeline', authMiddleware, requireRole('police', 'admin'), (req, res) => {
  const rows = db.prepare(
    'SELECT s.id, s.at, s.lat, s.lng, s.result, s.flags, s.officer_zone, u.username ' +
    'FROM scans s LEFT JOIN users u ON u.id = s.by_user ' +
    'WHERE s.card_id = ? ORDER BY s.at ASC, s.id ASC LIMIT 500'
  ).all(Number(req.params.cardId));
  // Unknown card → [] (map-friendly; existence is established via /verify).
  res.json(rows.map((s) => ({
    id: s.id, at: s.at, lat: s.lat, lng: s.lng, result: s.result,
    flags: parseFlags(s.flags), byUsername: s.username || '', officerZone: s.officer_zone || '',
  })));
});

app.post('/api/holders/:id/photo', authMiddleware, requireRole('issuer', 'admin'), (req, res) => {
  const holder = holderRow(Number(req.params.id));
  if (!holder) return res.status(404).json({ error: 'Holder not found' });
  if (req.user.role === 'issuer' && holder.org !== req.user.orgName) {
    return res.status(403).json({ error: 'Holder not in your org' });
  }
  const { dataUrl } = (req.body || {});
  const m = typeof dataUrl === 'string' && dataUrl.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'dataUrl must be data:image/(jpeg|png);base64,...' });
  let buf;
  try {
    buf = Buffer.from(m[2], 'base64');
  } catch (_) {
    return res.status(400).json({ error: 'Invalid base64' });
  }
  if (buf.length === 0 || buf.length > 700 * 1024) return res.status(400).json({ error: 'Photo must decode to 1 byte - 700KB' });
  const photoHash = crypto.createHash('sha256').update(buf).digest('hex');
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PHOTOS_DIR, `${photoHash}.bin`), buf);
  db.prepare('UPDATE holders SET photo_hash = ? WHERE id = ?').run(photoHash, holder.id);
  audit(req.user.id, 'holder.photo', `holder ${holder.id}`);
  res.json({ photoHash });
});

// Holder photo bytes (police/admin any org — checkpoints are cross-org;
// issuer only for holders in their own org). 404 when the holder has no
// photo hash or the file is missing. Content-Type sniffed from magic bytes
// (JPEG FFD8 / PNG 89504E47); no-store like the other credential routes.
app.get('/api/holders/:id/photo', authMiddleware, requireRole('police', 'admin', 'issuer'), (req, res) => {
  const holder = holderRow(Number(req.params.id));
  if (!holder) return res.status(404).json({ error: 'Holder not found' });
  if (req.user.role === 'issuer' && holder.org !== req.user.orgName) {
    return res.status(403).json({ error: 'Holder not in your org' });
  }
  if (!holder.photo_hash || !/^[0-9a-f]{64}$/.test(holder.photo_hash)) {
    return res.status(404).json({ error: 'No photo' });
  }
  let buf;
  try {
    buf = fs.readFileSync(path.join(PHOTOS_DIR, `${holder.photo_hash}.bin`));
  } catch (_) {
    return res.status(404).json({ error: 'No photo' });
  }
  res.set('Cache-Control', 'no-store');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) res.set('Content-Type', 'image/jpeg');
  else if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) res.set('Content-Type', 'image/png');
  else res.set('Content-Type', 'application/octet-stream');
  res.send(buf);
});

function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@|%]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

app.get('/api/scans/export', authMiddleware, requireRole('admin'), exportLimiter, (req, res) => {
  const { cardId } = req.query;
  let rows;
  if (cardId) {
    rows = db.prepare(
      'SELECT s.id, s.card_id, s.at, s.lat, s.lng, s.result, s.flags, h.full_name, u.username ' +
      'FROM scans s LEFT JOIN cards c ON c.id = s.card_id LEFT JOIN holders h ON h.id = c.holder_id ' +
      'LEFT JOIN users u ON u.id = s.by_user WHERE s.card_id = ? ORDER BY s.id ASC'
    ).all(Number(cardId));
  } else {
    rows = db.prepare(
      'SELECT s.id, s.card_id, s.at, s.lat, s.lng, s.result, s.flags, h.full_name, u.username ' +
      'FROM scans s LEFT JOIN cards c ON c.id = s.card_id LEFT JOIN holders h ON h.id = c.holder_id ' +
      'LEFT JOIN users u ON u.id = s.by_user ORDER BY s.id ASC'
    ).all();
  }
  const lines = ['id,card_id,holder,at,lat,lng,result,flags,by_user'];
  for (const s of rows) {
    lines.push([
      csvCell(s.id), csvCell(s.card_id), csvCell(s.full_name || ''), csvCell(s.at),
      csvCell(s.lat), csvCell(s.lng), csvCell(s.result),
      csvCell(parseFlags(s.flags).join('|')), csvCell(s.username || ''),
    ].join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="scans.csv"');
  res.send(lines.join('\n') + '\n');
});

app.get('/api/scans/recent', authMiddleware, requireRole('admin'), (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const rows = db.prepare(
    'SELECT s.id, s.card_id, s.at, s.lat, s.lng, s.result, s.flags, s.triage, s.triaged_at, s.officer_zone, h.full_name, h.org, u.username, tu.username AS triaged_by_username ' +
    'FROM scans s LEFT JOIN cards c ON c.id = s.card_id LEFT JOIN holders h ON h.id = c.holder_id ' +
    'LEFT JOIN users u ON u.id = s.by_user LEFT JOIN users tu ON tu.id = s.triaged_by ORDER BY s.at DESC, s.id DESC LIMIT ?'
  ).all(limit);
  res.json(rows.map((s) => ({
    id: s.id, cardId: s.card_id, holderName: s.full_name || '', org: s.org || '',
    at: s.at, lat: s.lat, lng: s.lng, result: s.result,
    flags: parseFlags(s.flags), byUsername: s.username || '', officerZone: s.officer_zone || '',
    triage: s.triage || 'open', triagedBy: s.triaged_by_username || '', triagedAt: s.triaged_at || null,
  })));
});

app.get('/api/stats', authMiddleware, requireRole('admin'), (req, res) => {
  const q = (sql, ...a) => db.prepare(sql).get(...a);
  const day = new Date().toISOString().slice(0, 10);
  const scansToday = q('SELECT COUNT(*) AS c FROM scans WHERE substr(at,1,10) = ?', day).c;
  const scanRows = db.prepare('SELECT flags FROM scans WHERE substr(at,1,10) = ?').all(day);
  const alertsToday = scanRows.filter((r) => parseFlags(r.flags).length > 0).length;
  let alertsOpen = 0;
  try {
    const openRows = db.prepare("SELECT flags FROM scans WHERE (triage IS NULL OR triage = 'open')").all();
    alertsOpen = openRows.filter((r) => parseFlags(r.flags).length > 0).length;
  } catch (_) { alertsOpen = alertsToday; }
  res.json({
    users: q('SELECT COUNT(*) AS c FROM users').c,
    holders: q('SELECT COUNT(*) AS c FROM holders').c,
    cardsActive: q("SELECT COUNT(*) AS c FROM cards WHERE status = 'active'").c,
    cardsRevoked: q("SELECT COUNT(*) AS c FROM cards WHERE status = 'revoked'").c,
    scansToday,
    alertsToday,
    alertsOpen,
  });
});

app.get('/api/audit', authMiddleware, requireRole('admin'), (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const rows = db.prepare(
    'SELECT a.id, a.at, a.by_user, a.action, a.detail, a.prev_hash, a.entry_hash, u.username ' +
    'FROM audit a LEFT JOIN users u ON u.id = a.by_user ORDER BY a.id DESC LIMIT ?'
  ).all(limit);
  res.json(rows.map((a) => ({ id: a.id, at: a.at, byUsername: a.username || '', action: a.action, detail: a.detail || '', prevHash: a.prev_hash || '', entryHash: a.entry_hash || '' })));
});

app.get('/api/audit/verify', authMiddleware, requireRole('admin'), auditVerifyLimiter, (req, res) => {
  const rows = db.prepare('SELECT id, at, by_user, action, detail, prev_hash, entry_hash FROM audit ORDER BY id ASC').all();
  let prev = db.AUDIT_GENESIS || 'GENESIS';
  for (const r of rows) {
    const expected = db.auditHash(prev, r.at, r.by_user, r.action, r.detail);
    if (r.prev_hash !== prev || r.entry_hash !== expected) {
      return res.json({ ok: false, brokenAt: r.id });
    }
    prev = r.entry_hash;
  }
  res.json({ ok: true, entries: rows.length });
});
// ---- key rotation (admin) ----
app.get('/api/admin/key-info', authMiddleware, requireRole('admin'), (req, res) => {
  res.json(keys.keyInfo());
});
app.post('/api/admin/rotate-keys', authMiddleware, requireRole('admin'), (req, res) => {
  const r = keys.rotate();
  audit(req.user.id, 'admin.rotate_keys', `kid ${r.prevKid} -> ${r.currentKid}`);
  res.json(r);
});
// Offline verification bundle: public key only — never private. An offline
// device uses this to check crypto authenticity; validity/revocation still
// need the server.
app.get('/api/admin/verify-bundle', authMiddleware, requireRole('admin'), (req, res) => {
  res.json({
    kid: keys.currentKid(),
    publicKeyJwk: keys.publicJwk(),
    exportedAt: new Date().toISOString(),
    verifyHint: 'offline signature check only — confirm status/revocation online',
  });
});
// ---- JWT secret rotation (admin, cycle 35) ----
// Graceful rotation: verify tries current, falls back to prev (grace window),
// so sessions minted before a rotation keep working. signUser always uses
// current. Writes data/keys/jwt.json (0600); file takes precedence over env
// on next boot. admin gets {hasPrev, rotatedAt, source} — never values.
app.get('/api/admin/secret-info', authMiddleware, requireRole('admin'), (req, res) => {
  res.json(secretInfo());
});
app.post('/api/admin/rotate-secret', authMiddleware, requireRole('admin'), (req, res) => {
  const { newSecret } = (req.body || {});
  if (typeof newSecret !== 'string' || newSecret.length < 32) {
    return res.status(400).json({ error: 'newSecret must be a string >= 32 chars' });
  }
  const r = rotateSecret(newSecret);
  audit(req.user.id, 'admin.rotate_secret', 'jwt secret rotated at ' + r.rotatedAt);
  res.json({ ok: true, rotatedAt: r.rotatedAt });
});

function checkJwtSecretOrExit() {
  // File rotation takes precedence over env: fail-fast only when neither exists.
  if (!process.env.JWT_SECRET && !process.env.ALLOW_DEV_SECRET && !hasJwtFile()) {
    console.error('[server] FATAL: JWT_SECRET is not set. Refusing to boot. Set JWT_SECRET or ALLOW_DEV_SECRET=1 for dev only.');
    process.exit(1);
  }
  if (!process.env.JWT_SECRET && !hasJwtFile()) {
    console.warn('[server] WARNING: JWT_SECRET not set, using dev default (ALLOW_DEV_SECRET=1). Set JWT_SECRET in production.');
  }
}

const PORT = process.env.PORT || 4000;
if (require.main === module) {
  checkJwtSecretOrExit();
  // seed admin on first boot if no users
  const n = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (n === 0) require('./seed');
  const srv = app.listen(PORT, () => console.log(`PressID API on :${PORT}`));
  const shutdown = () => {
    srv.close(() => {
      try { db.close(); } catch (_) {}
      process.exit(0);
    });
    // If connections linger, force-close after 5s.
    setTimeout(() => { try { db.close(); } catch (_) {} process.exit(0); }, 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;
module.exports.limiters = { verifyLimiter, exportLimiter, auditVerifyLimiter, authedBackstop, issueLimiter };
