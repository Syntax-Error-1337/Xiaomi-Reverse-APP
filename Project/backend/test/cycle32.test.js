'use strict';
// PressID cycle-32: backend parity for cycle-31 + KeyPanel currentKid mapping lock.
//
// 1. no-bare-names — CJS accidental-global guard for src/*.js: collect bare
//    identifiers used inside function bodies, subtract require names,
//    destructured/declared locals, params, module-scope declarators, labels,
//    and node/globals. Historical kills: `days` dropped from the quota edit
//    (ReferenceError debug-crash), `now` displaced by a seed edit.
//    Zero-false-positive tuning lives in scrub(): string/comment/template-text
//    /regex-literal removal, object-key + member-access + spread handling.
//    Mutation-probed (drop a local → this test names it).
// 2. key-shape-contract — behavioral: GET /api/admin/verify-bundle responds
//    with EXACTLY {kid, publicKeyJwk, exportedAt, verifyHint} and key-info
//    with EXACTLY {currentKid, hasPrev} (+rotatedAt after a rotation); plus
//    static pins that KeyPanel.jsx references every key it reads (currentKid,
//    rotatedAt, hasPrev) — locks the `kid`-only regression class.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const KEYPANEL = path.join(ROOT, '..', 'frontend', 'src', 'components', 'KeyPanel.jsx');

// ---------------------------------------------------------------------------
// 1. no-bare-names
// ---------------------------------------------------------------------------
const NODE_GLOBALS = new Set([
  'require', 'module', 'exports', '__dirname', '__filename', 'process',
  'console', 'Buffer', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate', 'queueMicrotask',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'JSON', 'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Date',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'BigInt',
  'Intl', 'Reflect', 'Proxy', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'globalThis', 'undefined', 'NaN', 'Infinity', 'structuredClone',
  'fetch', 'FormData', 'Headers', 'Request', 'Response',
]);
const JS_KEYWORDS = new Set([
  'true', 'false', 'null', 'this', 'new', 'typeof', 'instanceof', 'in', 'of',
  'void', 'delete', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'function',
  'class', 'extends', 'await', 'async', 'yield', 'let', 'const', 'var',
  'default', 'export', 'import', 'super', 'debugger', 'with',
]);

const isIdent = (s) => /^[A-Za-z_$][\w$]*$/.test(s);

// Strip strings, template text (keep ${...}), comments, regex literals so
// identifier-looking text inside them (SQL, '/api/health', /^Bearer.../,
// `P1.${...}`) never counts as code.
function scrub(src) {
  let s = src
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
  s = s.replace(/`(?:\\.|[^`\\$]|\$(?!\{)|\$\{(?:[^{}]|\{[^{}]*\})*\})*`/g, (m) => {
    const parts = [...m.matchAll(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((x) => `(${x[1]})`);
    return parts.length ? parts.join(' ') : '``';
  });
  s = s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Regex literal only where an operand can start: after ( = , : ! & | ? { }
  // ; [ or return/typeof/in/of. Division (`a / b`, `d / dtH`) never matches:
  // its preceding char is an operand, not an operator.
  s = s.replace(/(^|[(=,:!&|?{};[\]]|\breturn\b|\btypeof\b|\bin\b|\bof\b)(\s*)\/(?![/*])(?:\\.|[^/\n\\])+\/[gimsuy]*/g, '$1$2null');
  return s;
}

function topIndexOf(s, ch) {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '(' || c === '[') d++;
    else if (c === '}' || c === ')' || c === ']') d--;
    else if (c === ch && d === 0) return i;
  }
  return -1;
}

function splitTopLevel(s, sep) {
  const parts = [];
  let d = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{' || ch === '(' || ch === '[') d++;
    else if (ch === '}' || ch === ')' || ch === ']') d--;
    if (ch === sep && d === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

// Names bound by one declarator: `a`, `a = dflt`, `{a, b: c, ...r}`, `[a]`, `...r`.
function namesFromBinding(binding) {
  const names = [];
  const b = (binding || '').trim();
  if (!b) return names;
  if (b.startsWith('...')) {
    const n = b.slice(3).trim().split('=')[0].trim();
    if (isIdent(n)) names.push(n);
    return names;
  }
  if (b.startsWith('{') || b.startsWith('[')) {
    for (const part of splitTopLevel(b.slice(1, -1), ',')) {
      const p = part.trim();
      if (!p) continue;
      if (p.startsWith('...')) {
        const n = p.slice(3).trim().split('=')[0].trim();
        if (isIdent(n)) names.push(n);
        continue;
      }
      const ci = topIndexOf(p, ':');
      if (ci >= 0) {
        const m = /^([A-Za-z_$][\w$]*)/.exec(p.slice(ci + 1).trim().split('=')[0].trim());
        if (m) names.push(m[1]);
        continue;
      }
      const m = /^([A-Za-z_$][\w$]*)/.exec(p);
      if (m) names.push(m[1]);
    }
    return names;
  }
  const m = /^([A-Za-z_$][\w$]*)/.exec(b);
  if (m) names.push(m[1]);
  return names;
}

function namesFromParams(params) {
  let p = (params || '').trim();
  if ((p.startsWith('(') && p.endsWith(')')) || (p.startsWith('{') && p.endsWith('}'))) p = p.slice(1, -1);
  const names = [];
  for (const part of splitTopLevel(p, ',')) names.push(...namesFromBinding(part));
  return names;
}

// const/let/var declarators in text (`for (...)` headers excluded — handled
// separately — so `for (const r of ...)` can't swallow the loop body's decls).
function declaratorsIn(text) {
  const names = [];
  for (const m of text.matchAll(/(?<![\w$(])(?:const|let|var)\s+([^;]*);/g)) {
    let stmt = m[1];
    const eq = topIndexOf(stmt, '=');
    if (eq >= 0) stmt = stmt.slice(0, eq);
    for (const part of splitTopLevel(stmt, ',')) names.push(...namesFromBinding(part));
  }
  return names;
}

function forVarsIn(text) {
  const names = [];
  for (const m of text.matchAll(/for\s*\(\s*(?:const|let|var)\s+([^;]*);/g)) {
    for (const part of splitTopLevel(m[1], ',')) {
      const p = part.trim();
      const ofi = /\bof\b/.exec(p);
      const head = ofi ? p.slice(0, ofi.index) : p;
      names.push(...namesFromBinding(head));
    }
  }
  return names;
}

function catchParamsIn(text) {
  return [...text.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)].map((m) => m[1]);
}

// Statement labels (`outer:`) + line-leading object keys (harmless extras).
function labelsIn(text) {
  return [...text.matchAll(/^[ \t]*([A-Za-z_$][\w$]*)[ \t]*:(?!=)/gm)].map((m) => m[1]);
}

// Every `=>` param list in text (incl. expression-bodied arrows, whose bodies
// attribute to the enclosing scope — e.g. module-level `(group) => (req) =>`
// chains must still declare `group`).
function arrowParamsIn(text) {
  const names = [];
  const re = /([A-Za-z_$][\w$]*|\([^()]*\)|\{[^{}]*\})\s*=>/g;
  let m;
  while ((m = re.exec(text))) {
    const h = m[1].trim();
    if (h.startsWith('(') || h.startsWith('{')) {
      for (const part of splitTopLevel(h.slice(1, -1), ',')) names.push(...namesFromBinding(part));
    } else if (isIdent(h)) names.push(h);
  }
  return names;
}

function requireNamesIn(text) {
  const names = [];
  for (const m of text.matchAll(/(?:const|let|var)\s+(?:([A-Za-z_$][\w$]*)|\{([^}]*)\})\s*=\s*require\(/g)) {
    if (m[1]) names.push(m[1]);
    else for (const part of splitTopLevel(m[2], ',')) names.push(...namesFromBinding(part));
  }
  return names;
}

// Braced functions (function decls + braced arrows), with brace-matched ranges.
function findBracedFunctions(s) {
  const out = [];
  const re = /function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(([^()]*)\)\s*\{|([A-Za-z_$][\w$]*|\([^()]*\)|\{[^{}]*\})\s*=>\s*\{/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index;
    const brace = start + m[0].lastIndexOf('{');
    let d = 0;
    let i = brace;
    for (; i < s.length; i++) {
      if (s[i] === '{') d++;
      else if (s[i] === '}') { d--; if (d === 0) break; }
    }
    if (m[0].startsWith('function')) out.push({ start, open: brace, close: i, name: m[1] || null, params: m[2] || '' });
    else out.push({ start, open: brace, close: i, name: null, params: m[3] || '' });
  }
  return out;
}

function blanked(s, ranges) {
  const arr = [...s];
  for (const r of ranges) for (let i = r.start; i <= r.close && i < arr.length; i++) arr[i] = ' ';
  return arr.join('');
}

// Bare identifier uses in text: skips member access (`.x`, but not spread
// `...x`), object keys (`k:` unless ternary consequent), globals, keywords.
function usesIn(text) {
  const uses = [];
  const re = /[A-Za-z_$][\w$]*/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[0];
    if (name === '$' || name === '_') continue;
    const i = m.index;
    const j = i + name.length;
    if (i > 0 && /[\w$]/.test(text[i - 1])) continue;
    if (j < text.length && /[\w$]/.test(text[j])) continue;
    if (NODE_GLOBALS.has(name) || JS_KEYWORDS.has(name)) continue;
    if (text[i - 1] === '.' && text.slice(i - 3, i) !== '...') continue;
    const am = /^(\s*):(?!=)/.exec(text.slice(j));
    if (am) {
      const before = text.slice(0, i);
      const cut = Math.max(
        before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('}'),
        before.lastIndexOf('('), before.lastIndexOf('\n'),
      );
      if (!before.slice(cut + 1).includes('?')) continue;
    }
    uses.push(name);
  }
  return uses;
}

function analyzeFile(raw) {
  const s = scrub(raw);
  const fns = findBracedFunctions(s);
  const parentOf = new Map();
  for (const f of fns) {
    let best = null;
    for (const g of fns) {
      if (g === f) continue;
      if (g.start < f.start && f.close < g.close && (!best || best.start < g.start)) best = g;
    }
    parentOf.set(f, best);
  }
  const topFns = fns.filter((f) => !parentOf.get(f));
  const ownText = (f) => {
    const kids = fns.filter((g) => parentOf.get(g) === f);
    const body = s.slice(f.open + 1, f.close);
    const rel = kids.map((g) => ({ start: g.start - (f.open + 1), close: g.close - (f.open + 1) }));
    return blanked(body, rel);
  };
  const localsOf = (f) => {
    const t = ownText(f);
    return new Set([
      ...namesFromParams(f.params),
      ...declaratorsIn(t),
      ...forVarsIn(t),
      ...catchParamsIn(t),
      ...labelsIn(t),
      ...arrowParamsIn(t),
      ...(f.name ? [f.name] : []),
    ]);
  };
  const localsCache = new Map();
  const scopeFor = (f) => {
    if (!localsCache.has(f)) {
      const acc = new Set(localsOf(f));
      let p = parentOf.get(f);
      while (p) { for (const n of localsOf(p)) acc.add(n); p = parentOf.get(p); }
      localsCache.set(f, acc);
    }
    return localsCache.get(f);
  };

  // Module scope: everything outside top-level function ranges.
  const modText = blanked(s, topFns);
  const modScope = new Set([
    ...requireNamesIn(modText),
    ...declaratorsIn(modText),
    ...forVarsIn(modText),
    ...catchParamsIn(modText),
    ...labelsIn(modText),
    ...arrowParamsIn(modText),
    ...topFns.map((f) => f.name).filter(Boolean),
    ...NODE_GLOBALS,
    ...JS_KEYWORDS,
  ]);

  const unresolved = [];
  for (const u of usesIn(modText)) {
    if (!modScope.has(u)) unresolved.push({ name: u, where: 'module' });
  }
  for (const f of fns) {
    const scope = new Set([...modScope, ...scopeFor(f)]);
    for (const u of usesIn(ownText(f))) {
      if (!scope.has(u)) unresolved.push({ name: u, where: f.name || 'anonymous' });
    }
  }
  return { unresolved };
}

test('cycle32: no-bare-names — every bare identifier in src/*.js resolves in scope', () => {
  // Fails on the historical class: a dropped local (`days`, `now`) used in a
  // function body with no declaration anywhere in scope.
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();
  assert.ok(files.length > 0, 'expected src/*.js files');
  const violations = [];
  for (const f of files) {
    const { unresolved } = analyzeFile(fs.readFileSync(path.join(SRC, f), 'utf8'));
    for (const u of unresolved) violations.push(`${f} [${u.where}]: '${u.name}' has no declaration in scope`);
  }
  assert.deepEqual(violations, [], `bare identifiers (dropped locals / accidental globals):\n${violations.join('\n')}`);
});

// ---------------------------------------------------------------------------
// 2. key-shape-contract (throwaway boot; real DB untouched)
// ---------------------------------------------------------------------------
const TEST_DB = path.join(os.tmpdir(), `pressid-cycle32-${process.pid}-${Date.now()}.db`);
const TEST_KEYS_DIR = path.join(os.tmpdir(), `pressid-cycle32-keys-${process.pid}-${Date.now()}.d`);
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

test('cycle32: key-shape-contract — exact key sets on both endpoints + KeyPanel pins', async () => {
  // Fresh key dir: no rotation yet → key-info is exactly {currentKid, hasPrev}.
  const info = await json('GET', '/admin/key-info', { token: adminToken });
  assert.equal(info.status, 200);
  assert.deepEqual(Object.keys(info.data).sort(), ['currentKid', 'hasPrev']);
  assert.ok(/^[0-9a-f]{8}$/.test(info.data.currentKid), `currentKid shape: ${JSON.stringify(info.data)}`);
  assert.equal(typeof info.data.hasPrev, 'boolean');
  assert.equal(info.data.hasPrev, false);

  // Bundle is exactly {kid, publicKeyJwk, exportedAt, verifyHint} — the keys
  // an offline verifier consumes.
  const bundle = await json('GET', '/admin/verify-bundle', { token: adminToken });
  assert.equal(bundle.status, 200);
  assert.deepEqual(Object.keys(bundle.data).sort(), ['exportedAt', 'kid', 'publicKeyJwk', 'verifyHint']);
  assert.equal(bundle.data.kid, info.data.currentKid);
  assert.equal(bundle.data.publicKeyJwk && bundle.data.publicKeyJwk.kty, 'OKP');
  assert.ok(!Number.isNaN(Date.parse(bundle.data.exportedAt)), `exportedAt ISO: ${bundle.data.exportedAt}`);
  assert.ok(typeof bundle.data.verifyHint === 'string' && bundle.data.verifyHint.length > 0);

  // Rotate → key-info gains exactly rotatedAt (behavioral pin).
  const rot = await json('POST', '/admin/rotate-keys', { token: adminToken });
  assert.equal(rot.status, 200);
  const info2 = await json('GET', '/admin/key-info', { token: adminToken });
  assert.equal(info2.status, 200);
  assert.deepEqual(Object.keys(info2.data).sort(), ['currentKid', 'hasPrev', 'rotatedAt']);
  assert.equal(info2.data.currentKid, rot.data.currentKid);
  assert.equal(info2.data.hasPrev, true);
  assert.ok(!Number.isNaN(Date.parse(info2.data.rotatedAt)));

  // Auth still enforced on both endpoints.
  assert.equal((await json('GET', '/admin/key-info')).status, 401);
  assert.equal((await json('GET', '/admin/verify-bundle')).status, 401);

  // Static side: KeyPanel.jsx must reference every key-info key it reads
  // (canonical camelCase). Prevents the `kid`-only regression where the
  // backend renames currentKid and the panel silently renders '—'.
  const panel = fs.readFileSync(KEYPANEL, 'utf8');
  for (const k of ['currentKid', 'rotatedAt', 'hasPrev']) {
    assert.ok(panel.includes(k), `KeyPanel.jsx must reference '${k}' (key it reads from key-info)`);
  }
});
