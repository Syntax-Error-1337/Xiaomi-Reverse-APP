#!/usr/bin/env node
'use strict';
// Offline press-card signature check — no server, no npm deps.
//
// Usage:
//   node scripts/offline-verify.js <token> --key bundle.json
//
// bundle.json comes from GET /api/admin/verify-bundle (admin) and holds the
// public key only. This script checks crypto authenticity (Ed25519 signature
// over the payload segment bytes). Card validity / revocation / zones still
// need the server (/api/verify) — a valid signature alone is NOT clearance.
//
// Exits: 0 = valid signature, 2 = bad signature, 1 = format/usage error.
const fs = require('node:fs');
const crypto = require('node:crypto');

function usage() {
  console.error('usage: node scripts/offline-verify.js <P1.token> --key bundle.json');
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  let token = null;
  let keyPath = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--key' || a === '--keyfile') {
      keyPath = args[++i] || null;
    } else if (a.startsWith('--key=')) {
      keyPath = a.slice('--key='.length) || null;
    } else if (a === '-h' || a === '--help') {
      usage();
      process.exit(1);
    } else if (!a.startsWith('-') && token === null) {
      token = a;
    } else {
      usage();
      process.exit(1);
    }
  }
  if (!token || !keyPath) {
    usage();
    process.exit(1);
  }

  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  } catch (_) {
    fail(`cannot read key bundle: ${keyPath}`);
  }
  // Accept the full bundle ({kid, publicKeyJwk, …}) or a bare JWK.
  const jwk = bundle.publicKeyJwk || bundle.publicKey || bundle;
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    fail('key bundle has no usable Ed25519 public JWK (expected {kid, publicKeyJwk, …} from /api/admin/verify-bundle)');
  }
  if (jwk.d || bundle.privateKey) {
    fail('key bundle contains private key material — refuse to use');
  }

  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch (_) {
    fail('cannot import public JWK');
  }

  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'P1') fail('INVALID_FORMAT: token must be P1.<payload>.<sig>');
  let payloadBytes, sig;
  try {
    payloadBytes = Buffer.from(parts[1], 'base64url');
    sig = Buffer.from(parts[2], 'base64url');
    if (payloadBytes.length === 0 || sig.length === 0) throw new Error('empty');
  } catch (_) {
    fail('INVALID_FORMAT: payload/signature are not base64url');
  }

  let ok = false;
  try {
    ok = crypto.verify(null, payloadBytes, publicKey, sig);
  } catch (_) {
    ok = false;
  }

  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch (_) {
    fail('INVALID_FORMAT: payload is not JSON');
  }

  console.log(JSON.stringify(payload, null, 2));
  console.log(`signature: ${ok ? 'OK' : 'FAIL'}`);
  const rows = [
    ['cardId', payload.cardId],
    ['holderId', payload.holderId],
    ['name', payload.name],
    ['org', payload.org],
    ['issuedAt', payload.issuedAt],
    ['validTill', payload.validTill],
    ['nonce', payload.nonce],
    ['kid', payload.kid],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`  ${k.padEnd(width)}  ${v ?? ''}`);
  if (bundle.kid && payload.kid && bundle.kid !== payload.kid) {
    console.log(`  note: token kid ${payload.kid} != bundle kid ${bundle.kid} (rotated key?)`);
  }
  console.log('note: signature only — confirm status/revocation online via POST /api/verify');

  process.exit(ok ? 0 : 2);
}

main();
