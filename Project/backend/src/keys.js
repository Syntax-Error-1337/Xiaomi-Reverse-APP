'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// PRESSID_KEYS_DIR overrides the key directory (regression tests point it at a
// throwaway dir). Defaults to data/keys.
const KEYS_DIR = process.env.PRESSID_KEYS_DIR || path.join(__dirname, '..', 'data', 'keys');
const KEY_FILE = path.join(KEYS_DIR, 'ed25519.json');
const PREV_FILE = path.join(KEYS_DIR, 'ed25519.prev.json');
const META_FILE = path.join(KEYS_DIR, 'meta.json');

let keypair;
let prevKeypair = null;

// Key id: first 8 hex chars of sha256 over the raw SPKI DER public key bytes.
function kidOf(publicKey) {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 8);
}

function loadKeyFile(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pub = crypto.createPublicKey({ key: j.publicKey, format: 'jwk' });
  const priv = crypto.createPrivateKey({ key: j.privateKey, format: 'jwk' });
  return { publicKey: pub, privateKey: priv, jwk: j };
}

function writeKeyFile(file, jwk) {
  fs.writeFileSync(file, JSON.stringify(jwk, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function loadOrCreate() {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  if (fs.existsSync(PREV_FILE)) {
    try {
      prevKeypair = loadKeyFile(PREV_FILE);
    } catch (_) {
      prevKeypair = null;
    }
  }
  if (fs.existsSync(KEY_FILE)) {
    keypair = loadKeyFile(KEY_FILE);
    return keypair;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const j = {
    publicKey: publicKey.export({ format: 'jwk' }),
    privateKey: privateKey.export({ format: 'jwk' }),
  };
  writeKeyFile(KEY_FILE, j);
  keypair = { publicKey, privateKey, jwk: j };
  return keypair;
}

loadOrCreate();

function sign(bytes) {
  return crypto.sign(null, Buffer.from(bytes), keypair.privateKey);
}

// Verify against the current key, falling back to the previous key (if any)
// so tokens minted before a rotation keep verifying.
function verifyWithFallback(bytes, sig) {
  try {
    if (crypto.verify(null, Buffer.from(bytes), keypair.publicKey, sig)) return true;
  } catch (_) {}
  if (prevKeypair) {
    try {
      if (crypto.verify(null, Buffer.from(bytes), prevKeypair.publicKey, sig)) return true;
    } catch (_) {}
  }
  return false;
}

// kid of the current signing key (stamped into minted token payloads).
function kid() {
  return kidOf(keypair.publicKey);
}

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function keyInfo() {
  const info = { currentKid: kid(), hasPrev: !!prevKeypair };
  const meta = readMeta();
  if (meta && meta.rotatedAt) info.rotatedAt = meta.rotatedAt;
  return info;
}

// Rotate: current key file → .prev, fresh pair becomes current, meta records kids + time.
function rotate() {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const current = loadKeyFile(KEY_FILE);
  const prevKid = kidOf(current.publicKey);
  writeKeyFile(PREV_FILE, current.jwk);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const j = {
    publicKey: publicKey.export({ format: 'jwk' }),
    privateKey: privateKey.export({ format: 'jwk' }),
  };
  writeKeyFile(KEY_FILE, j);
  const rotatedAt = new Date().toISOString();
  const currentKid = kidOf(publicKey);
  fs.writeFileSync(META_FILE, JSON.stringify({ currentKid, prevKid, rotatedAt }, null, 2));
  keypair = { publicKey, privateKey, jwk: j };
  prevKeypair = current;
  return { currentKid, prevKid, rotatedAt };
}

function publicJwk() {
  return keypair.jwk.publicKey;
}

function currentKid() {
  return kid();
}

module.exports = { sign, verifyWithFallback, publicJwk, kid, currentKid, keyInfo, rotate };
