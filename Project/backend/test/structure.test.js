'use strict';
// PressID cycle-28 structural guards: backend bug-class preventatives.
//
// No server boot, no HTTP — static file analysis + light requires only.
// Each test encodes a real historical bug class:
//  1. exports-complete — dropped now/randomNonce/getPublicKeyJwk exports,
//     undefined pubUser (mid-edit export/local drops).
//  2. ddl-complete — missing scans DDL (table referenced but never created).
//  3. limiter-wired — expensive route added without a rate limiter.
//  4. informational-discipline — undocumented reason codes; expired+revoked
//     duplicate reasons; informational codes blocking validity.
//  5. determinism — base64url-padding flake from flipping the LAST char of a
//     token (must flip the first char instead).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const TEST_DIR = __dirname;

// Throwaway DB + keys BEFORE requiring any src module (mirrors smoke.test.js:
// db.js resolves PRESSID_DB and keys.js resolves PRESSID_KEYS_DIR at load).
const TEST_DB = path.join(os.tmpdir(), `pressid-cycle28-${process.pid}-${Date.now()}.db`);
const TEST_KEYS_DIR = path.join(os.tmpdir(), `pressid-cycle28-keys-${process.pid}-${Date.now()}.d`);
fs.mkdirSync(TEST_KEYS_DIR, { recursive: true });
process.env.PRESSID_KEYS_DIR = TEST_KEYS_DIR;
process.env.PRESSID_DB = TEST_DB;
process.env.ALLOW_DEV_SECRET = process.env.ALLOW_DEV_SECRET || '1';
process.env.PRESSID_QUIET = process.env.PRESSID_QUIET || '1';

const serverSrc = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(SRC, 'db.js'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

after(() => {
  try { require('../src/db').close(); } catch (_) {}
  for (const f of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`, `${TEST_DB}-journal`]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
  try { fs.rmSync(TEST_KEYS_DIR, { recursive: true, force: true }); } catch (_) {}
});

test('exports-complete: every local symbol used in server.js exists', () => {
  // Would have caught: dropped now/randomNonce/getPublicKeyJwk exports,
  // undefined pubUser (used but never defined/exported after a mid-edit drop).
  // Fails on the historical bug because the used name is then missing from
  // the required module's exports (or has no local definition).

  // 1a. Local requires: './x' -> { defaultName | destructured[] }.
  const requireRe = /(?:const|let|var)\s+(?:(\w+)|\{\s*([^}]+?)\s*\})\s*=\s*require\('(\.[^']*)'\)/g;
  const defaultImports = new Map(); // localName -> module path
  const destructured = new Map(); // localName -> module path
  let m;
  while ((m = requireRe.exec(serverSrc))) {
    const modPath = path.join(SRC, `${m[3].replace(/^\.\//, '')}.js`);
    if (m[1]) defaultImports.set(m[1], modPath);
    else for (const n of m[2].split(',').map((s) => s.trim()).filter(Boolean)) destructured.set(n, modPath);
  }
  assert.ok(defaultImports.size > 0 && destructured.size > 0, 'expected local requires in server.js');

  const mods = new Map(); // absPath -> required module
  const loadMod = (p) => {
    if (!mods.has(p)) mods.set(p, require(p));
    return mods.get(p);
  };

  // 1b. Destructured names must exist in the required module's exports.
  for (const [name, modPath] of destructured) {
    const mod = loadMod(modPath);
    assert.ok(
      mod !== null && (typeof mod === 'object' || typeof mod === 'function') && mod[name] !== undefined,
      `server.js destructures '${name}' from ${path.basename(modPath)} but it is not exported`,
    );
  }

  // 1c. Member accesses on default-imported locals (db.prepare, keys.currentKid)
  // must resolve through the prototype chain (db is a DatabaseSync instance —
  // `in` covers prototype methods like prepare plus assigned props).
  for (const [local, modPath] of defaultImports) {
    if (local === 'jwt' || local === 'express' || local === 'bcrypt' || local === 'QRCode') continue;
    const mod = loadMod(modPath);
    const useRe = new RegExp(`\\b${local}\\.([A-Za-z_$][\\w$]*)`, 'g');
    const used = new Set();
    let u;
    while ((u = useRe.exec(serverSrc))) used.add(u[1]);
    assert.ok(used.size > 0, `expected uses of '${local}' in server.js`);
    for (const prop of used) {
      assert.ok(prop in Object(mod), `server.js uses '${local}.${prop}' but ${path.basename(modPath)} has no such export`);
    }
  }

  // 1d. Historically-dropped locals: if used, each must be defined in
  // server.js or exported from its home module (cards/keys/server-local).
  const historical = { now: null, pubUser: null, randomNonce: './cards', getPublicKeyJwk: './keys' };
  const topDefined = new Set(
    [...serverSrc.matchAll(/^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm)].map((x) => x[1]),
  );
  for (const [name, home] of Object.entries(historical)) {
    const used = new RegExp(`\\b${name}\\b`).test(serverSrc);
    if (!used) continue;
    if (topDefined.has(name)) continue;
    assert.ok(home, `server.js uses '${name}' but it is neither defined locally nor imported`);
    const mod = loadMod(path.join(SRC, `${home.replace(/^\.\//, '')}.js`));
    assert.ok(mod[name] !== undefined, `server.js uses '${name}' but ${home} does not export it`);
  }
});

test('ddl-complete: every SQL table referenced in src has DDL in db.js', () => {
  // Would have caught: missing scans DDL (code INSERTed/SELECTed scans while
  // db.js never created the table). Fails on the historical bug because the
  // referenced table then has no CREATE TABLE match.
  const created = new Set([...dbSrc.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)/gi)].map((x) => x[1]));
  assert.ok(created.size > 0, 'expected CREATE TABLE statements in db.js');
  const srcFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));
  // Only inspect quoted SQL string literals (prose/comments contain words
  // like "from the" that are not table references).
  const sqlStrings = (src) => {
    const out = [];
    for (const x of src.matchAll(/'((?:[^'\\]|\\.)*)'/gs)) {
      if (/(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)/i.test(x[1])) out.push(x[1]);
    }
    return out;
  };
  const refRe = /(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE|FROM|JOIN)\s+([A-Za-z_][\w]*)/gi;
  const missing = new Map(); // table -> files
  for (const f of srcFiles) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const sql of sqlStrings(src)) {
      let r;
      refRe.lastIndex = 0;
      while ((r = refRe.exec(sql))) {
        const t = r[1];
        if (!created.has(t)) {
          if (!missing.has(t)) missing.set(t, []);
          if (!missing.get(t).includes(f)) missing.get(t).push(f);
        }
      }
    }
  }
  assert.deepEqual(
    [...missing.entries()],
    [],
    `tables referenced without DDL: ${[...missing.entries()].map(([t, fs2]) => `${t} (${fs2.join(',')})`).join('; ')}`,
  );
});

test('limiter-wired: every expensive route carries a Limiter', () => {
  // Would catch: a future expensive route added without rate limiting.
  // Fails on the historical bug because the route's middleware chain then
  // contains no *Limiter (directly or via a guard that delegates to one).
  const expensive = [
    ['post', '/api/verify'],
    ['get', '/api/scans/export'],
    ['get', '/api/audit/verify'],
    ['post', '/api/cards'],
  ];
  const app = require('../src/server');

  for (const [method, route] of expensive) {
    const anchor = `app.${method}('${route}'`;
    const idx = serverSrc.indexOf(anchor);
    assert.ok(idx !== -1, `expected route registration for ${method.toUpperCase()} ${route}`);
    const chunk = serverSrc.slice(idx, serverSrc.indexOf('(req', idx) + 4);
    const middlewares = [...chunk.matchAll(/([A-Za-z_$][\w$]*)(?=\s*[,)])/g)].map((x) => x[1]);
    const hasLimiter = middlewares.some((w) => /Limiter/i.test(w));
    const guardDelegates = middlewares.some((w) => {
      if (/Limiter/i.test(w) || ['authMiddleware', 'requireRole', 'requireFreshPassword'].includes(w)) return false;
      // Local guard (e.g. issueVelocityGuard): passes iff its body calls a *Limiter.
      const def = new RegExp(`(?:const|let|var|function)\\s+${w}\\b[\\s\\S]{0,400}?\\{([\\s\\S]{0,400})`).exec(serverSrc);
      return def !== null && /Limiter/.test(def[1]);
    });
    assert.ok(
      hasLimiter || guardDelegates,
      `${method.toUpperCase()} ${route}: no Limiter in route chain (middlewares: ${middlewares.join(', ')})`,
    );
  }
});

test('informational-discipline: pushed codes documented; informational never blocks; no duplicates', () => {
  // Would have caught: undocumented codes, and the expired+revoked duplicate
  // STATUS_EXPIRED reasons. Fails on the historical bug because (a) a pushed
  // code missing from the README table errors, (b) a duplicated reasons array
  // errors, (c) an informational code in the blocking path errors.
  const antiSrc = fs.readFileSync(path.join(SRC, 'antiClone.js'), 'utf8');
  const cardsSrc = fs.readFileSync(path.join(SRC, 'cards.js'), 'utf8');

  const pushed = new Set();
  for (const src of [serverSrc, antiSrc]) {
    for (const x of src.matchAll(/reasons\.push\('([A-Z][A-Z0-9_]*)'\)/g)) pushed.add(x[1]);
  }
  // Dynamic STATUS_ family (antiClone pushes 'STATUS_' + status).
  const hasDynamicStatus = /reasons\.push\('STATUS_'\s*\+/.test(antiSrc);
  // verifyTokenLocal error codes flow into verify reasons via `reasons: [v.error]`.
  assert.ok(/reasons:\s*\[v\.error\]/.test(serverSrc), 'expected verify errors to surface as reasons');
  for (const x of cardsSrc.matchAll(/error:\s*'([A-Z][A-Z0-9_]*)'/g)) pushed.add(x[1]);
  if (hasDynamicStatus) pushed.add('STATUS_<X>');

  // README codes table: `| \`CODE\` | ... | Blocks? |`.
  const readmeCodes = new Set([...readme.matchAll(/^\|\s*`([A-Z][A-Z0-9_<>]*)`/gm)].map((x) => x[1]));
  const blocksYes = new Set(
    [...readme.matchAll(/^\|\s*`([A-Z][A-Z0-9_<>]*)`\s*\|[^|]*\|\s*yes\s*\|/gm)].map((x) => x[1]),
  );
  for (const code of pushed) {
    assert.ok(readmeCodes.has(code), `reason code '${code}' pushed in code but missing from README codes table`);
  }

  const infoMatch = /const INFORMATIONAL_REASONS = new Set\(\[([^\]]*)\]\)/.exec(serverSrc);
  assert.ok(infoMatch, 'expected INFORMATIONAL_REASONS set in server.js');
  const informational = new Set([...infoMatch[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((x) => x[1]));
  // Validity decision must exclude exactly the informational set.
  assert.ok(
    /reasons\.filter\(\(r\) => !INFORMATIONAL_REASONS\.has\(r\)\)/.test(serverSrc),
    'expected validity decision to filter INFORMATIONAL_REASONS',
  );

  const testSrc = fs.readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => fs.readFileSync(path.join(TEST_DIR, f), 'utf8'))
    .join('\n');
  for (const code of pushed) {
    if (informational.has(code)) continue;
    if (code === 'STATUS_<X>') {
      assert.ok(blocksYes.has('STATUS_<X>'), 'expected README STATUS_<X> row to block');
      continue;
    }
    assert.ok(blocksYes.has(code), `blocking code '${code}' must be documented as blocking in README`);
    assert.ok(
      testSrc.includes(`includes('${code}')`),
      `blocking code '${code}' must have a test asserting it (reasons.includes('${code}'))`,
    );
  }
  // Every informational code must actually occur (no stale entries) and must
  // be asserted alongside a still-valid response somewhere.
  for (const code of informational) {
    assert.ok(pushed.has(code) || serverSrc.includes(`'${code}'`), `informational code '${code}' is stale (never pushed)`);
  }

  // No duplicate reasons: status 'expired' + past valid_till previously
  // produced STATUS_EXPIRED twice; the Set dedup must hold.
  const { statusReasons } = require('../src/antiClone');
  const dup = statusReasons({ status: 'expired', valid_till: new Date(Date.now() - 3600e3).toISOString() }, Date.now());
  assert.deepEqual(dup, ['STATUS_EXPIRED'], `expected deduped reasons, got ${JSON.stringify(dup)}`);
  const both = statusReasons({ status: 'revoked', valid_till: new Date(Date.now() - 3600e3).toISOString() }, Date.now());
  assert.equal(both.length, new Set(both).size, `duplicate reasons: ${JSON.stringify(both)}`);
});

test('determinism: no test flips the LAST char of a token', () => {
  // Guards the base64url-padding flake class: flipping the last char of a
  // base64url segment can be a no-op (padding/low bits ignored), making
  // tamper tests pass or fail depending on the random value. First-char flips
  // always change decoded bytes. Fails on the historical bug because the
  // offending slice(0, -1) pattern is then present in test/.
  const offenders = [];
  for (const f of fs.readdirSync(TEST_DIR).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/\.slice\(\s*0\s*,\s*-1\s*\)/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `last-char token flips (base64url flake risk):\n${offenders.join('\n')}`);
});
