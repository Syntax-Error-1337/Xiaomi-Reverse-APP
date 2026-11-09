import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, "..", "src");

function listFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out);
    else if (/\.(jsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = listFiles(src);
const jsxFiles = files.filter((f) => f.endsWith(".jsx"));
const texts = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]));

// --- i18n helpers: extract the key set of one top-level lang block ---
function langKeys(source, lang) {
  const marker = `${lang}: {`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${lang} block in i18n.js`);
  let i = source.indexOf("{", start);
  let depth = 0;
  let j = i;
  for (; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const block = source.slice(i, j);
  const keys = new Set();
  for (const m of block.matchAll(/^\s*([A-Za-z0-9_]+)\s*:/gm)) keys.add(m[1]);
  return { block, keys };
}

const i18nSrc = texts.get(path.join(src, "i18n.js"));
const en = langKeys(i18nSrc, "en");
const hi = langKeys(i18nSrc, "hi");

// Collect t("key") literal usages across jsx (excludes member calls like x.t( and the i18n.js def itself).
function literalTKeys() {
  const used = new Map(); // key -> [files]
  for (const f of jsxFiles) {
    const t = texts.get(f);
    for (const m of t.matchAll(/(?<![A-Za-z0-9_.])t\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*\)/g)) {
      if (!used.has(m[1])) used.set(m[1], []);
      used.get(m[1]).push(path.relative(src, f));
    }
  }
  return used;
}

describe("frontend static regression", () => {
  it("i18n-complete: every t(\"key\") literal exists in the en dict", () => {
    const used = literalTKeys();
    const missing = [...used.keys()].filter((k) => !en.keys.has(k));
    assert.deepEqual(missing, [], `missing en keys: ${missing.map((k) => `${k} (in ${used.get(k).join(", ")})`).join("; ")}`);
  });

  it("i18n-parity: en and hi dicts have identical key sets", () => {
    const missingHi = [...en.keys].filter((k) => !hi.keys.has(k));
    const extraHi = [...hi.keys].filter((k) => !en.keys.has(k));
    assert.deepEqual({ missingHi, extraHi }, { missingHi: [], extraHi: [] });
  });

  it("i18n-unique: no duplicate keys inside either dict", () => {
    for (const [lang, { block }] of [["en", en], ["hi", hi]]) {
      const all = [...block.matchAll(/^\s*([A-Za-z0-9_]+)\s*:/gm)].map((m) => m[1]);
      const dupes = all.filter((k, i) => all.indexOf(k) !== i);
      assert.deepEqual([...new Set(dupes)], [], `duplicate keys in ${lang}`);
    }
  });

  it("i18n-dynamic: template/dynamic t() families resolve (triage_, role_, reason_)", () => {
    const allSrc = jsxFiles.map((f) => texts.get(f)).join("\n");
    assert.ok(allSrc.includes("t(`triage_${tri}`)"), "triage_ template");
    for (const k of ["triage_open", "triage_acked", "triage_resolved"]) assert.ok(en.keys.has(k), k);
    assert.ok(allSrc.includes("`role_${r}`"), "role_ template");
    for (const k of ["role_admin", "role_issuer", "role_police", "role_press"]) assert.ok(en.keys.has(k), k);
    assert.ok(allSrc.includes("`reason_desc_${code}`"), "reason_desc template");
    assert.ok(allSrc.includes("`reason_action_${code}`"), "reason_action template");
    const codes = new Set(
      [...en.keys].filter((k) => k.startsWith("reason_desc_")).map((k) => k.slice("reason_desc_".length)),
    );
    for (const c of codes) assert.ok(en.keys.has(`reason_action_${c}`), `reason_action_${c}`);
    for (const c of codes) assert.ok(hi.keys.has(`reason_desc_${c}`), `hi reason_desc_${c}`);
  });

  it("setter-match: every setX( call resolves to a declaration, import, or context allowlist", () => {
    const allow = new Set(["setItem"]); // localStorage.setItem member calls
    const contextProvided = new Set(["setMustChange", "setUser", "setToken"]);
    const failures = [];
    for (const f of files) {
      const t = texts.get(f);
      const called = new Set([...t.matchAll(/(?<![A-Za-z0-9_.])\b(set[A-Z][A-Za-z0-9]*)\s*\(/g)].map((m) => m[1]));
      if (called.size === 0) continue;
      const declared = new Set([
        ...[...t.matchAll(/\[\s*[A-Za-z0-9_]+\s*,\s*(set[A-Z][A-Za-z0-9]*)\s*\]/g)].map((m) => m[1]),
        ...[...t.matchAll(/const\s+(set[A-Z][A-Za-z0-9]*)\s*=/g)].map((m) => m[1]),
        ...[...t.matchAll(/function\s+(set[A-Z][A-Za-z0-9]*)\s*\(/g)].map((m) => m[1]),
        ...[...t.matchAll(/import\s*\{([^}]*)\}\s*from/g)].flatMap((m) => m[1].split(",").map((s) => s.trim().split(/\s+/)[0])),
        ...[...t.matchAll(/const\s*\{\s*([^}]*)\}\s*=\s*useAuth\(\)/g)].flatMap((m) => m[1].split(",").map((s) => s.trim().split(/[:\s]/)[0])),
      ]);
      for (const c of called) {
        if (allow.has(c)) continue;
        if (!declared.has(c) && !(contextProvided.has(c) && /useAuth|AuthContext|useLang|setLangState/.test(t))) {
          failures.push(`${path.relative(src, f)}: ${c}()`);
        }
      }
    }
    assert.deepEqual(failures, []);
  });

  it("imports-resolve: every relative import target exists on disk", () => {
    const missing = [];
    for (const f of files) {
      const t = texts.get(f);
      for (const m of t.matchAll(/from\s*["'](\.[^"']*)["']/g)) {
        const base = path.resolve(path.dirname(f), m[1]);
        const ok =
          fs.existsSync(base) ||
          fs.existsSync(base + ".js") ||
          fs.existsSync(base + ".jsx") ||
          (fs.existsSync(base) && fs.statSync(base).isDirectory() && fs.existsSync(path.join(base, "index.js")));
        if (!ok) missing.push(`${path.relative(src, f)} -> ${m[1]}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it("routes: /login + all 5 role/offline routes behind ErrorBoundary", () => {
    const app = texts.get(path.join(src, "App.jsx"));
    for (const r of ['"/login"', '"/admin"', '"/issuer"', '"/police"', '"/press"', '"/offline"']) {
      assert.ok(app.includes(r), `missing route ${r}`);
    }
    const eb = (app.match(/<ErrorBoundary>/g) || []).length;
    assert.ok(eb >= 5, `expected >=5 <ErrorBoundary>, found ${eb}`);
  });

  it("handlers: onClick/onSubmit/onChange/onRetry names resolve to declared consts/functions", () => {
    const failures = [];
    for (const f of jsxFiles) {
      const t = texts.get(f);
      const names = new Set(
        [...t.matchAll(/on(?:Click|Submit|Change|Retry)=\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]),
      );
      if (names.size === 0) continue;
      const declared = new Set([
        ...[...t.matchAll(/const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].map((m) => m[1]),
        ...[...t.matchAll(/function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]),
        // function parameters (incl. destructured props like { error, onRetry })
        ...[...t.matchAll(/function\s+[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\{([^}]*)\}/g)].flatMap((m) =>
          m[1].split(",").map((s) => s.trim().split(/[:\s=]/)[0]),
        ),
        ...[...t.matchAll(/\(\s*\{([^}]*)\}\s*\)\s*=>/g)].flatMap((m) =>
          m[1].split(",").map((s) => s.trim().split(/[:\s=]/)[0]),
        ),
        ...[...t.matchAll(/import\s+([A-Za-z_][A-Za-z0-9_]*)(?=[,\s])/g)].map((m) => m[1]),
        ...[...t.matchAll(/import\s*\{([^}]*)\}/g)].flatMap((m) =>
          m[1].split(",").map((s) => s.trim().split(/\s+as\s+|\s+/).pop()),
        ),
        ...[...t.matchAll(/const\s*\{\s*([^}]*)\}\s*=\s*\w+\(\)/g)].flatMap((m) =>
          m[1].split(",").map((s) => s.trim().split(/[:\s=]/)[0]),
        ),
        ...[...t.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)].map((m) => m[1]),
      ]);
      for (const n of names) {
        if (!declared.has(n)) failures.push(`${path.relative(src, f)}: ${n}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  it("rate-limit: Retry-After plumbing + countdown present", () => {
    const apiJs = texts.get(path.join(src, "api.js"));
    assert.match(apiJs, /Retry-After/, "api.js reads Retry-After header");
    assert.match(apiJs, /retryAfter/, "api.js carries retryAfter field");
    assert.ok(en.keys.has("err_rate") && en.keys.has("err_rate_soon"), "en err_rate keys");
    assert.ok(hi.keys.has("err_rate") && hi.keys.has("err_rate_soon"), "hi err_rate keys");
    const fb = texts.get(path.join(src, "components", "Feedback.jsx"));
    assert.match(fb, /useCountdown/, "Feedback.jsx exports useCountdown");
    assert.match(fb, /globalThis\.setInterval/, "countdown ticks via setInterval");
    assert.match(fb, /rate-chip/, "429 countdown chip rendered");
  });

  it("cycle24: expired-session + mustChange + photo-chip guards present", () => {
    const apiJs = texts.get(path.join(src, "api.js"));
    assert.match(apiJs, /pressid_token[\s\S]{0,400}401|401[\s\S]{0,400}pressid_token/, "api.js clears session on 401");
    const press = texts.get(path.join(src, "pages", "PressDashboard.jsx"));
    assert.match(press, /user\?\.mustChange/, "PressDashboard reads mustChange");
    assert.match(press, /if \(user\?\.mustChange\)/, "PressDashboard gates on mustChange before card list");
    const police = texts.get(path.join(src, "pages", "PoliceDashboard.jsx"));
    assert.match(police, /hasPhoto/, "PoliceDashboard reads hasPhoto");
    assert.match(police, /photo_on_file/, "photo presence chip uses photo_on_file key");
    assert.match(police, /photo_missing/, "photo absence chip uses photo_missing key");
    assert.ok(en.keys.has("photo_on_file") && en.keys.has("photo_missing"), "en photo keys");
    assert.ok(hi.keys.has("photo_on_file") && hi.keys.has("photo_missing"), "hi photo keys");
  });
  it("cycle27-no-shadow-i18n: files importing { t } from i18n must not shadow it (prevents PoliceDashboard ts crash)", () => {
    const failures = [];
    for (const f of files) {
      const s = texts.get(f);
      const imp = s.match(/import\s*\{([^}]*)\}\s*from\s*["']([^"']*i18n[^"']*)["']/);
      if (!imp) continue;
      const localNames = new Set();
      for (const b of imp[1].split(",").map((x) => x.trim())) {
        const m = b.match(/^t(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/);
        if (m) localNames.add(m[1] || "t");
      }
      if (localNames.size === 0) continue;
      const rel = path.relative(src, f);
      const body = s.replace(imp[0], "");
      for (const name of localNames) {
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        for (const m of body.matchAll(new RegExp(`(?:const|let|var)\\s+${esc}\\s*=`, "g"))) {
          const line = body.slice(0, m.index).split("\n").pop() + body.slice(m.index).split("\n")[0];
          if (/useLang\(\)/.test(line)) continue;
          failures.push(`${rel}: declaration shadows i18n \`${name}\`: ${line.trim().slice(0, 80)}`);
        }
        if (new RegExp(`function\\s+[A-Za-z_][A-Za-z0-9_]*\\s*\\([^)]*\\b${esc}\\b[^)]*\\)`).test(body)) {
          failures.push(`${rel}: function param shadows i18n \`${name}\``);
        }
        if (new RegExp(`\\(\\s*${esc}\\s*[,)][^;=>]*=>`).test(body)) {
          failures.push(`${rel}: arrow param shadows i18n \`${name}\``);
        }
        if (new RegExp(`\\(\\s*\\{[^}]*\\b${esc}\\b[^}]*\\}\\s*\\)\\s*=>`).test(body)) {
          failures.push(`${rel}: destructured arrow param shadows i18n \`${name}\``);
        }
      }
    }
    assert.deepEqual(failures, []);
  });

  it("cycle27-context-shared: useLang consumers share one provider (prevents isolated Hindi state)", () => {
    const consumers = files.filter((f) => /useLang/.test(texts.get(f)) && !f.endsWith("i18n.js"));
    assert.ok(consumers.length > 1, `expected >1 useLang consumer, found ${consumers.length}`);
    const providerFiles = files.filter((f) => /createContext/.test(texts.get(f)) && /LangProvider|LangCtx/.test(texts.get(f)));
    assert.ok(providerFiles.length >= 1, "no exported LangProvider/context found (i18n.js or a context file)");
    const exported = providerFiles.some((f) => /export\s+(function\s+LangProvider|const\s+LangProvider)/.test(texts.get(f)));
    assert.ok(exported, "LangProvider must be exported from i18n or a context file");
    const app = texts.get(path.join(src, "App.jsx"));
    assert.match(app, /<LangProvider/, "App.jsx must wrap routes in <LangProvider>");
    assert.match(app, /<\/LangProvider>/, "App.jsx must close <LangProvider>");
  });

  it("cycle27-raw-errors: 429-gated ErrorBanner state keeps the raw error object (prevents stringified-error chip bug)", () => {
    const failures = [];
    for (const f of files) {
      const s = texts.get(f);
      for (const m of s.matchAll(/<ErrorBanner\s+error=\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        const v = m[1];
        const gated = new RegExp(`${v}\\?\\.(status|retryAfter)`).test(s);
        if (!gated) continue;
        const setter = `set${v[0].toUpperCase()}${v.slice(1)}`;
        for (const c of s.matchAll(new RegExp(`${setter}\\(friendlyError\\(`, "g"))) {
          failures.push(`${path.relative(src, f)}: ${setter}(friendlyError(...)) drops retryAfter read via ${v}?.status/retryAfter`);
        }
      }
    }
    assert.deepEqual(failures, []);
  });
  it("cycle27-effect-reload: mustChange gate reloads via useEffect (prevents stale empty list after forced rotation)", () => {
    const failures = [];
    for (const f of files) {
      const s = texts.get(f);
      if (!/user\?\.mustChange/.test(s)) continue;
      if (!/\[[^\]]*mustChange[^\]]*\]/.test(s)) {
        failures.push(`${path.relative(src, f)}: reads user?.mustChange but has no [.. mustChange ..] useEffect dep`);
      }
    }
    assert.deepEqual(failures, []);
  });
  it("cycle64-gate-lift-clears-errors: gate-lift reload clears stale 403 banners (prevents stuck 'Password change required' after rotation)", () => {
    const failures = [];
    for (const f of files) {
      const s = texts.get(f);
      if (!/user\?\.mustChange/.test(s)) continue;
      // find the gate-lift effect block and require an error-clear inside it
      const m = s.match(/useEffect\(\(\) => \{[^}]*mustChange[^}]*\}[^)]*\)/s);
      const block = m ? m[0] : s;
      if (!/set\w*Err\(""/.test(block)) {
        failures.push(`${path.relative(src, f)}: gate-lift effect never clears error state`);
      }
    }
    assert.deepEqual(failures, []);
  });
  it("cycle49-admin-banner: AdminDashboard shows must-change banner + change-password anchor (parity with press)", () => {
    const admin = texts.get(path.join(src, "pages", "AdminDashboard.jsx"));
    assert.match(admin, /user\?\.mustChange/, "AdminDashboard reads mustChange");
    assert.match(admin, /must-change-banner/, "AdminDashboard renders must-change banner");
    assert.match(admin, /must_change/, "AdminDashboard banner uses must_change key");
    assert.match(admin, /id="change-password"/, "AdminDashboard anchors banner to change-password form");
    assert.ok(en.keys.has("must_change") && hi.keys.has("must_change"), "must_change key in en+hi");
  });

  it("cycle59-no-native-dialog: no window.confirm/prompt/alert in src (inline two-tap instead)", () => {
    const failures = [];
    for (const f of files) {
      const s = texts.get(f);
      const lines = s.split("\n");
      lines.forEach((line, i) => {
        const code = line.split("//")[0];
        const m = code.match(/window\s*\.\s*(confirm|prompt|alert)\s*\(|(?<![A-Za-z0-9_$.])(confirm|prompt|alert)\s*\(/);
        if (!m) return;
        // Allow globals-allowlist mention context: bare `alert` in the
        // cycle31 globals Set string is a quoted list entry, not a call.
        if (/["'`]/.test(code.slice(Math.max(0, m.index - 1), m.index))) return;
        failures.push(`${path.relative(src, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    assert.deepEqual(failures, []);
    const issuer = texts.get(path.join(src, "pages", "IssuerDashboard.jsx"));
    assert.match(issuer, /armedRevoke/, "IssuerDashboard keeps armed revoke state");
    assert.match(issuer, /confirm_revoke_armed/, "IssuerDashboard uses confirm_revoke_armed key");
    const press = texts.get(path.join(src, "pages", "PressDashboard.jsx"));
    assert.match(press, /armedReport/, "PressDashboard keeps armed report state");
    assert.match(press, /confirm_report_armed/, "PressDashboard uses confirm_report_armed key");
    for (const k of ["confirm_revoke_armed", "confirm_report_armed", "cancel"]) {
      assert.ok(en.keys.has(k), `en ${k}`);
      assert.ok(hi.keys.has(k), `hi ${k}`);
    }
  });



  // Third bare-identifier ReferenceError class (Topbar-never-mounted hiding, quotaSupported,
  // String(cardId)): bare names in JSX expr containers / single-ident call args must resolve to a
  // prop, destructure, import, or global. Scope is tight: JSX text, attr names, member access
  // (a.b), object keys, strings, and comments are stripped first; allowlist grows one line at a
  // time and only for real globals — never to silence a local-looking name.
  it("cycle31-bare-identifiers: bare names in JSX exprs + call args resolve (prevents String(cardId) ReferenceError class)", () => {
    const keywords = new Set(
      "break,case,catch,class,const,continue,debugger,default,delete,do,else,export,extends,finally,for,function,if,import,in,instanceof,new,return,super,switch,this,throw,try,typeof,var,void,while,with,yield,let,static,enum,implements,package,protected,interface,private,public,await,async,true,false,null,undefined,as,from,of,get,set".split(","),
    );
    const globals = new Set(
      "window,document,navigator,console,localStorage,sessionStorage,fetch,alert,setTimeout,clearTimeout,setInterval,clearInterval,requestAnimationFrame,URL,URLSearchParams,Blob,File,FileReader,FormData,location,history,performance,Intl,globalThis,String,Number,Boolean,BigInt,Symbol,Array,Object,Math,JSON,Date,RegExp,Map,Set,WeakMap,WeakSet,Promise,Error,TypeError,RangeError,SyntaxError,isNaN,isFinite,parseInt,parseFloat,encodeURIComponent,decodeURIComponent,Infinity,NaN,queueMicrotask,structuredClone,crypto,BarcodeDetector,atob,btoa,process,screen,devicePixelRatio,innerWidth,innerHeight,scrollTo,matchMedia,CustomEvent,Event,AbortController,TextEncoder,TextDecoder,Component,Fragment,React,StrictMode,createRoot,BrowserRouter,Routes,Route,Link,Navigate,useNavigate,useParams,useLocation,Outlet,useState,useEffect,useRef,useMemo,useCallback,useContext,useReducer,createContext".split(","),
    );
    const addList = (dst, s) => {
      for (let p of s.replace(/[[,\]{}[\]()]/g, ",").split(",")) {
        p = p.trim();
        const m = p.match(/^(?:\.\.\.)?([A-Za-z_$][\w$]*)/);
        if (m && !keywords.has(m[1])) dst.add(m[1]);
      }
    };
    const declaredIn = (t) => {
      const d = new Set();
      for (const m of t.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|\bfrom\b)/g)) d.add(m[1]);
      for (const m of t.matchAll(/import\s*\{([^}]*)\}/g))
        for (const p of m[1].split(",")) {
          const x = p.trim().match(/(?:as\s+)?([A-Za-z_$][\w$]*)$/);
          if (x) d.add(x[1]);
        }
      for (const m of t.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) d.add(m[1]);
      for (const m of t.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) d.add(m[1]);
      for (const m of t.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) d.add(m[1]);
      for (const m of t.matchAll(/(?:const|let|var)\s+(\[[^\]]*\]|\{[^}]*\}|[A-Za-z_$][\w$]*)/g)) {
        const v = m[1];
        if (v[0] === "[" || v[0] === "{") addList(d, v.slice(1, -1));
        else d.add(v);
      }
      for (const m of t.matchAll(/,\s*([A-Za-z_$][\w$]*)\s*=/g)) d.add(m[1]);
      for (const m of t.matchAll(/function\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) addList(d, m[1]);
      for (const m of t.matchAll(/^\s*(?:async\s+)?(?:constructor|[A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) addList(d, m[1]);
      for (const m of t.matchAll(/\(\s*\{([^}]*)\}\s*\)\s*=>/g)) addList(d, m[1]);
      for (const m of t.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) d.add(m[1]);
      for (const m of t.matchAll(/\(\s*([^(){}]*?)\s*\)\s*=>/g)) addList(d, m[1]);
      for (const m of t.matchAll(/\.map\s*\(\s*\(?([^)]*?)\)?\s*=>/g)) addList(d, m[1]);
      for (const m of t.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) d.add(m[1]);
      for (const m of t.matchAll(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) d.add(m[1]);
      return d;
    };
    const exprText = (t) => {
      let s = t;
      s = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^\S'":])\/\/[^\n]*/g, "$1");
      s = s.replace(/`(?:[^`\\$]|\\.|\$(?!\{))*(\$\{(?:[^{}]|\{[^{}]*\})*\}|`)/g, (m) => ` ${[...m.matchAll(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((x) => x[1]).join(" ")} `);
      s = s.replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
      for (let i = 0; i < 5; i++) s = s.replace(/>[^<>{}]*</g, "><");
      s = s.replace(/<[^<>]*>/g, (m) => ` ${[...m.matchAll(/\{([^{}]*)\}/g)].map((x) => x[1]).join(" ")} `);
      s = s.replace(/\.\s*[A-Za-z_$][\w$]*/g, "").replace(/([,{])\s*([A-Za-z_$][\w$]*)\s*:/g, "$1");
      return s;
    };
    const usedIn = (s) => {
      const u = new Set();
      for (const m of s.matchAll(/\{([^{}]*)\}/g))
        for (const im of m[1].matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) u.add(im[1]);
      for (const m of s.matchAll(/\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) u.add(m[1]);
      return u;
    };
    const failures = [];
    for (const f of jsxFiles) {
      const t = texts.get(f);
      const decl = declaredIn(t);
      const used = usedIn(exprText(t));
      for (const u of used) {
        if (/^\d/.test(u) || keywords.has(u) || globals.has(u) || decl.has(u)) continue;
        failures.push(`${path.relative(src, f)}: bare \`${u}\` has no prop/destructure/import/global binding`);
      }
    }
    assert.deepEqual(failures, []);
    const press = texts.get(path.join(src, "components", "PressCard.jsx"));
    const mutants = [
      press.replace('String(card?.id ?? "")', "String(cardId)"),
      press.replace("{qr &&", "{qr && quotaSupported &&"),
    ];
    for (const mut of mutants) {
      const decl = declaredIn(mut);
      const used = usedIn(exprText(mut));
      const viol = [...used].filter((u) => !keywords.has(u) && !globals.has(u) && !decl.has(u));
      assert.ok(viol.length > 0, "matcher failed to flag an injected bare identifier");
    }
  });

  it("cycle41-sw-lifecycle: install skipWaiting + activate claim + stale-cache purge (prevents stale-shell deploys)", () => {
    const sw = fs.readFileSync(path.join(root, "..", "public", "sw.js"), "utf8");
    assert.match(sw, /skipWaiting\(\)/, "sw.js must call self.skipWaiting() on install");
    assert.match(sw, /clients\.claim\(\)/, "sw.js must call self.clients.claim() on activate");
    assert.match(sw, /caches\.keys\(\)/, "sw.js must enumerate caches.keys() on activate");
    assert.match(sw, /caches\.delete/, "sw.js must purge non-matching caches on activate");
    assert.match(sw, /pressid-v\d+/, "sw.js must carry a versioned pressid-vN cache name");
    assert.match(sw, /\/api/, "sw.js must keep /api passthrough");
    assert.match(sw, /caches\.match\(["']\/index\.html["']\)/, "sw.js must keep navigation fallback to cached index.html");
    const main = fs.readFileSync(path.join(src, "main.jsx"), "utf8");
    assert.match(main, /reg\.waiting/, "main.jsx must dispatch update event immediately if reg.waiting exists at load");
  });

  it("cycle70-table-columns: every body <tr> template carries the header's cell count (prevents dropped-cell column drift)", () => {
    const countCells = (inner) => {
      const total = [...inner.matchAll(/<(?:td|th)(?=[\s/>])/g)].length;
      const optional = [...inner.matchAll(/\{[^}{]*&&\s*<(?:td|th)(?=[\s/>])/g)].length;
      return { required: total - optional, optional };
    };
    const analyze = (rel, s) => {
      const failures = [];
      const tables = [...s.matchAll(/<table[\s>][\s\S]*?<\/table>/g)].map((m) => m[0]);
      tables.forEach((tbl, ti) => {
        const thead = tbl.match(/<thead[\s>][\s\S]*?<\/thead>/);
        const headerSigs = thead
          ? [...thead[0].matchAll(/<tr[\s>]([\s\S]*?)<\/tr>/g)].map((m) => countCells(m[1]))
          : [];
        const tbody = tbl.match(/<tbody[\s>][\s\S]*?<\/tbody>/);
        const scope = tbody ? tbody[0] : tbl;
        const dataTrs = [...scope.matchAll(/<tr[\s>]([\s\S]*?)<\/tr>/g)]
          .map((m) => m[1])
          .filter((inner) => !/colSpan/.test(inner)); // LoadingRow/EmptyRow placeholders span the table
        if (headerSigs.length > 0) {
          for (const inner of dataTrs) {
            const c = countCells(inner);
            const ok = headerSigs.some((h) => h.required === c.required && h.optional === c.optional);
            if (!ok) {
              const h = headerSigs.map((x) => `${x.required}+${x.optional}opt`).join("|");
              failures.push(`${rel} table#${ti + 1}: body <tr> has ${c.required}+${c.optional}opt cells, header has ${h}`);
            }
          }
        } else {
          // headerless key/value tables: every row must share one shape
          const sigs = new Set(dataTrs.map((inner) => { const c = countCells(inner); return `${c.required}+${c.optional}opt`; }));
          if (sigs.size > 1) failures.push(`${rel} table#${ti + 1}: headerless rows differ (${[...sigs].join(" vs ")})`);
        }
      });
      return failures;
    };
    const failures = [];
    for (const f of jsxFiles) failures.push(...analyze(path.relative(src, f), texts.get(f)));
    assert.deepEqual(failures, []);
    // mutation probe: dropping the org cell must trip the matcher (cycle-69 bug class)
    const admin = texts.get(path.join(src, "pages", "AdminDashboard.jsx"));
    const dropped = admin.replace(/<td>\{u\.orgName[^<]*<\/td>/, "");
    assert.ok(dropped.length < admin.length, "probe mutant did not apply");
    assert.ok(analyze("AdminDashboard.jsx", dropped).length > 0, "matcher failed to flag a dropped table cell");
  });

  it("iterK-scan-next: submitToken clears token only on valid verdict + focuses + scrolls verdict", () => {
    const police = texts.get(path.join(src, "pages", "PoliceDashboard.jsx"));
    const m = police.match(/const submitToken = async[\s\S]*?\n  \};/);
    assert.ok(m, "submitToken block found");
    const body = m[0];
    const clearIdx = body.indexOf('setToken("")');
    assert.ok(clearIdx >= 0, "success path clears token");
    assert.match(body, /if\s*\(\s*res\s*&&\s*res\.valid\s*\)/, "clear gated on res.valid (invalid verdicts + errors keep token)");
    const gateIdx = body.search(/if\s*\(\s*res\s*&&\s*res\.valid\s*\)/);
    assert.ok(clearIdx > gateIdx, "setToken(\"\") inside the res.valid gate");
    assert.match(body, /tokenRef\.current\?\.focus/, "valid path refocuses token textarea");
    assert.match(body, /verdictRef\.current\?\.scrollIntoView\?*\.\(\{\s*block:\s*["']nearest["']/, "verdict scrolled into view");
    assert.match(police, /ref=\{tokenRef\}/, "textarea carries tokenRef");
    assert.match(police, /ref=\{verdictRef\}/, "verdict section carries verdictRef");
  });

  it("iterK-dedup-once: risk drivers hidden when already shown as note chips (one chip per code)", () => {
    const police = texts.get(path.join(src, "pages", "PoliceDashboard.jsx"));
    assert.match(police, /hideCodes=\{noteReasons\.map\(reasonCode\)\}/, "RiskPanel hides codes shown as note chips");
    assert.match(police, /fresh\s*=\s*drivers\.filter/, "RiskPanel filters drivers against shown codes");
  });

  it("iterR-offline-gate: OfflineVerify rows gated on result.ok (forged QR renders no payload table)", () => {
    const off = texts.get(path.join(src, "pages", "OfflineVerify.jsx"));
    assert.match(off, /rows.*result\.ok|result\.ok.*rows/, "payload rows derived only from a verified result");
    const rowsLine = off.split("\n").find((l) => l.includes("Object.entries(result.payload)"));
    assert.ok(rowsLine && rowsLine.includes("result.ok"), "rows derivation line itself carries the result.ok gate");
    assert.match(off, /FAIL/, "FAIL line present for invalid signatures");
    // mutation probe: dropping the ok gate must trip the matcher (forged-QR table class)
    const dropped = off.replace(/result && result\.ok && result\.payload/, "result && result.payload");
    assert.ok(dropped.length < off.length, "probe mutant did not apply");
    const droppedRowsLine = dropped.split("\n").find((l) => l.includes("Object.entries(result.payload)"));
    assert.ok(!droppedRowsLine.includes("result.ok"), "matcher sanity: ungated rows line is flaggable");
  });
  it("iterS-provisional-hint: provisional valid verdicts use provisional_hint (never verdict_valid_hint)", () => {
    const police = texts.get(path.join(src, "pages", "PoliceDashboard.jsx"));
    assert.match(police, /t\("provisional_hint"\)/, "PoliceDashboard renders provisional_hint");
    assert.match(police, /\(result\.provisional \|\| provisional\) && result\.valid/, "hint branches on provisional flag + valid");
    const hintLine = police.split("\n").find((l) => l.includes('t("provisional_hint")'));
    assert.ok(hintLine && /provisional/.test(hintLine.slice(0, 0) + police.slice(Math.max(0, police.indexOf(hintLine) - 200), police.indexOf(hintLine))), "provisional_hint guarded by provisional condition");
    assert.ok(en.keys.has("provisional_hint") && hi.keys.has("provisional_hint"), "provisional_hint key in en+hi");
    assert.ok(en.keys.has("verdict_valid_hint") && hi.keys.has("verdict_valid_hint"), "verdict_valid_hint key retained in en+hi");
    // mutation probe: swapping provisional_hint for verdict_valid_hint must trip the matcher
    const swapped = police.replace('t("provisional_hint")', 't("verdict_valid_hint")');
    assert.ok(!/t\("provisional_hint"\)/.test(swapped), "matcher sanity: swapped source loses provisional_hint");
  });
});
