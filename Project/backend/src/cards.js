'use strict';
const crypto = require('node:crypto');
const keys = require('./keys');

function b64uEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}
function b64uDecode(s) {
  return Buffer.from(s, 'base64url');
}

// Canonical JSON with fixed key order
function canonicalPayload(p) {
  const ordered = {
    v: p.v,
    cardId: p.cardId,
    holderId: p.holderId,
    name: p.name,
    org: p.org,
    issuedAt: p.issuedAt,
    validTill: p.validTill,
    nonce: p.nonce,
    kid: p.kid,
  };
  return JSON.stringify(ordered);
}

function mintCard(cardRow, holderRow) {
  const payload = {
    v: 1,
    cardId: cardRow.id,
    holderId: holderRow.id,
    name: holderRow.full_name,
    org: holderRow.org,
    issuedAt: cardRow.valid_from,
    validTill: cardRow.valid_till,
    nonce: cardRow.nonce,
    kid: keys.kid(),
  };
  const canon = canonicalPayload(payload);
  const sig = keys.sign(Buffer.from(canon, 'utf8'));
  const token = `P1.${b64uEncode(Buffer.from(canon, 'utf8'))}.${b64uEncode(sig)}`;
  return { payload, token };
}

function verifyTokenLocal(token) {
  if (typeof token !== 'string') return { ok: false, error: 'INVALID_FORMAT' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'P1') return { ok: false, error: 'INVALID_FORMAT' };
  let payloadBytes, sig;
  try {
    payloadBytes = b64uDecode(parts[1]);
    sig = b64uDecode(parts[2]);
  } catch (_) {
    return { ok: false, error: 'INVALID_FORMAT' };
  }
  let okSig = false;
  try {
    // Current key first, previous key after rotation — pre-rotation tokens
    // (minted without/with an older kid) keep verifying.
    okSig = keys.verifyWithFallback(payloadBytes, sig);
  } catch (_) {
    okSig = false;
  }
  if (!okSig) return { ok: false, error: 'INVALID_SIGNATURE' };
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch (_) {
    return { ok: false, error: 'INVALID_FORMAT' };
  }
  if (payload.v !== 1 || typeof payload.cardId !== 'number') {
    return { ok: false, error: 'INVALID_FORMAT' };
  }
  return { ok: true, payload };
}

function randomNonce() {
  return crypto.randomBytes(12).toString('hex');
}

module.exports = { mintCard, verifyTokenLocal, randomNonce };
