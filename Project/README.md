# PressID — Tamper-Proof Press Credential Registry

PressID issues signed press credentials (QR cards) and verifies them at checkpoints with anti-cloning detection.

- **Backend** (`backend/`): Express + SQLite API. Cards are Ed25519-signed tokens (`P1.payload.sig`); the QR holds the token only — all truth lives server-side. Keys persist in `backend/data/keys/ed25519.json` (mode `0600`).
- **Frontend** (`frontend/`): React + Vite UI with four role dashboards (admin, issuer, police, press) and print-only ID-card CSS.

```
┌──────────┐  issue / revoke   ┌───────────┐  QR token    ┌───────────┐
│  Issuer  │ ───────────────▶ │  Backend  │ ◀────────── │  Police   │
│ dashboard│                  │ Express + │  verify +    │ checkpoint│
└──────────┘                  │ SQLite DB │  log scan    └───────────┘
      ▲                       │  Ed25519  │         ▲            ▲
      │  manage users/        │  keys     │         │ scan       │ scan
      │  stats/audit/CSV      └─────┬─────┘         │ history    │ timeline
┌──────────┐              ┌─────────┴─────┐   ┌──────────┐  ┌──────────┐
│  Admin   │              │ Press holder  │   │ /verify  │  │ /scans/  │
│ dashboard│              │ dashboard     │   │ verdict  │  │ :id/     │
└──────────┘              │ (my cards +   │   │ + alerts │  │ timeline │
                          │  print)       │   └──────────┘  └──────────┘
```

## Quickstart

Pick one:

**Local dev** — backend → http://localhost:4000, frontend → http://localhost:5173:

```bash
cd backend && npm install && npm start        # seeds admin / admin123, serves :4000
cd frontend && npm install && npm run dev     # dev server :5173
```

Env vars: `PORT` (default `4000`), `JWT_SECRET` (fail-fast — server refuses to boot without it unless `ALLOW_DEV_SECRET=1` dev-only). Frontend talks to `http://localhost:4000/api` by default; override with `VITE_API_URL`. Auth is `Authorization: Bearer <jwt>`; the session is stored in `localStorage` (`pressid_token`, `pressid_user`).

**Demo (one command)** — seed demo users + card on a fresh DB:

```bash
cd backend && npm run demo   # ALLOW_DEV_SECRET=1 PRESSID_DEMO=1 seed + server
# issuer-demo / pass1234 (org Demo Press), officer-demo / pass1234 (zone north),
# one holder + one active card (zones [north])
```

**Docker** — backend :4000, frontend :8080:

```bash
JWT_SECRET=<real-secret> docker compose up --build
# frontend http://localhost:8080 → proxies /api to backend:4000
# data persists in the pressid-data volume (/app/data)
```

`JWT_SECRET` is REQUIRED — the server refuses to boot without it (unless `ALLOW_DEV_SECRET=1`, dev only). Compose passes `${JWT_SECRET}` with an obvious `change-me-…` placeholder that must be replaced for real use.

## Default credentials

`admin` / `admin123` (seeded by `node src/seed.js`).

> ⚠️ **Change immediately.** The admin password is a public dev default and `JWT_SECRET` has no production default (fail-fast boot check). Set `JWT_SECRET` and change/reset the admin password before any real use.

## Role matrix

| Role | Login lands on | Can do |
|---|---|---|
| `admin` | `/admin` | Create issuer/police accounts, activate/deactivate users (instant), per-user quota editor, registry stats (+ `alertsOpen` inbox count), recent scans with triage ack/resolve + open-only filter, CSV export (card-ID filter), full audit trail + chain-verify, key rotation + bundle download, change password |
| `issuer` | `/issuer` | Register holders (scoped to own org), upload holder photos (480 px downscale, ≤700 KB), issue cards (QR + token, optional event name/end, replacement of terminal cards with lineage chips), revoke cards, search/filter cards |
| `police` | `/police` | Verify token (+ optional lat/lng or geolocation, camera scan via `BarcodeDetector` w/ fallback), see VALID/INVALID verdict with reason explainers + clone alerts, holder box (photo chip + voluntary "holder device on file" check-in chip, informational only), last-5-scans, scan-trail map + timeline lookup by card ID, EVENT_ACTIVE duty chip |
| `press` | `/press` | View own cards (grid, large QR + copy), credential detail, print card, voluntary device check-in (→ police "holder device on file" chip, printed cards work either way), my-scans self-detect table, report-loss freeze (→ `CARD_REPORTED`), must-change-password banner + change-password form |

- **Signed QR, server truth.** Card token: `P1.<base64url(canonical JSON payload)>.<base64url(ed25519 signature)>`, fixed key order `{v, cardId, holderId, name, org, issuedAt, validTill, nonce}` plus `kid` (first 8 hex of `sha256(SPKI DER)`). QR carries only the token; verify cross-checks signed fields against the DB — mismatch → `TAMPER_MISMATCH`, bad signature → `INVALID_SIGNATURE`. Verify tries current key then previous (`.prev`) so pre-rotation tokens keep working; mint always uses current.
- **Rules:** issuers only see their own org's holders/cards; press users only see their own cards (press login created automatically on holder registration); wrong-role routes redirect home; deactivation kills access on the next request (auth middleware re-checks `active`).
- **Fail-fast secrets.** No production default for `JWT_SECRET`; boot refuses without it unless `ALLOW_DEV_SECRET=1` or a rotated `data/keys/jwt.json` exists (file takes precedence). Keys stored `0600` (`ed25519.json` current + `ed25519.prev.json` + `meta.json`); JWT rotation writes `jwt.json` (`{current, prev, rotatedAt}`, `0600`). Graceful rotation: verify tries current then prev, so old sessions survive one rotation and die on the second. Details: [backend/README JWT secret rotation](backend/README.md#jwt-secret-rotation).
- **Login rate-limit.** 10 failed logins per IP per 5 min → `429 Too many attempts`; successful login resets the counter.
- **Authed rate limits (cycle 18).** Sliding window per user (`src/rateLimit.js` `makeLimiter`): verify 60/min, export 10/min, audit-verify 20/min, backstop 300/min on all other authed `/api` (except `/health`). Exceed → `429 {error:"Too many requests"}` + `Retry-After` header (exposed for browser countdown); admins obey the same limits.
- **429 UX (cycle 19).** Verify/export/audit surfaces show a Retry-After countdown chip + manual retry; double-submit guards on forms.
- **Anti-clone.** Every `/verify` logs a scan (time + geo + officer). Flags computed over the last 20 scans:

### Canonical verify codes

| Code | When | Blocks? |
|---|---|---|
| `INVALID_FORMAT` | malformed token | yes |
| `INVALID_SIGNATURE` | bad signature | yes |
| `CARD_NOT_FOUND` | card/holder row missing | yes |
| `TAMPER_MISMATCH` | signed fields differ from DB | yes |
| `REVOKED` | card status revoked | yes |
| `CARD_REPORTED` | card status reported (press-reported loss; terminal like revoked) | yes |
| `STATUS_EXPIRED` | status expired **or** `valid_till` passed **or** `event_end` passed (never bare `EXPIRED`) | yes |
| `STATUS_<X>` | any other non-active status | yes |
| `OUT_OF_ZONE` | card zones non-empty, officer zone non-empty, no match | yes |
| `UNKNOWN_ZONE` | officer has no zone assigned | no (note chip) |
| `EVENT_ACTIVE` | card carries a live `event_name` whose `event_end` has not passed | no (note chip) |
| `DUPLICATE_SCAN` | identical lat/lng (tolerance 1e-6) for same card within 60 s | no (note chip) |

## API index (32 routes)

Base `/api`. Full endpoint table + curl examples: [backend/README](backend/README.md#endpoints-base-api).

| Area | Endpoints |
|---|---|
| Health / auth (3) | `GET /health` (`{ok,version,time,db,keyKid}`), `POST /auth/login`, `POST /auth/change-password` |
| Users (4) | `GET /users`, `POST /users`, `PATCH /users/:id/active`, `PATCH /users/:id/quota` |
| Holders (4) | `POST /holders`, `GET /holders`, `POST /holders/:id/photo`, `GET /holders/:id/photo` |
| Cards (4) | `POST /cards` (event fields + `replacesId`), `GET /cards`, `GET /cards/:id`, `POST /cards/:id/revoke` (card view: `holder`, `photoHash`, `holderCheckedIn`, `eventName`/`eventEnd`, `replacesId`/`replacedBy`) |
| Press self-service (3) | `GET /me/scans`, `POST /me/report-loss` (→ `reported`, audit `card.report_loss`), `POST /me/check-in` `{deviceId}` (voluntary device signal → `holderCheckedIn`, audit `holder.checkin`) |
| Verify / scans (6) | `POST /verify` (`risk`, `photoUrl`), `GET /scans?cardId=` (police: cardId required; admin: all), `PATCH /scans/:id/triage` (admin ack/resolve), `GET /scans/:cardId/timeline`, `GET /scans/export?cardId=&format=csv`, `GET /scans/recent?limit=` |
| Oversight (3) | `GET /stats` (incl. `alertsOpen`), `GET /audit?limit=` (incl. `card.replace`, `scan.triage`), `GET /audit/verify` |
| Signing keys (3) | `GET /admin/key-info`, `POST /admin/rotate-keys`, `GET /admin/verify-bundle` (public key only) |
| Session secret (2) | `GET /admin/secret-info`, `POST /admin/rotate-secret` |
Frontend guide (role flows, printing, offline verify + PWA): [frontend/README](frontend/README.md).

## Ops env table

| Var | Default | Notes |
|---|---|---|
| `JWT_PREV_SECRET` | unset | Previous JWT secret for the grace window (env fallback when no `jwt.json` file). |
| `ALLOW_DEV_SECRET` | unset | `=1` permits the dev default secret; never in production. |
| `PORT` | `4000` | Backend port; restore script refuses if `/health` answers on it. |
| `PRESSID_DB` | `data/pressid.db` | Honored by backup/restore scripts + server. |
| `PRESSID_KEYS_DIR` | `data/keys` | Honored by backup/restore scripts + server. |
| `PRESSID_QUIET` | unset | `=1` silences the request logger (`NODE_ENV=test` does too). |
| `PRESSID_DEMO` | unset | `=1` seeds demo issuer/officer/holder/card on fresh DBs. |
| `VITE_API_URL` | `http://localhost:4000/api` | Frontend backend override. |

## Backup / restore, rotation, offline ops

- **Backup:** `cd backend && ./scripts/backup.sh` → timestamped DB + keys tarball in `backend/backups/`. Uses `sqlite3 .backup` when the CLI exists, else a file copy (stop the server first for consistency). Honors `PRESSID_DB` / `PRESSID_KEYS_DIR`.
- **Restore:** `cd backend && ./scripts/restore.sh backups/pressid-backup-<ts>.tar.gz` — refuses if the server answers `/health` on `$PORT` (stop it first), asks for confirmation, then overwrites DB + keys (keys restored `0600`).
- **Session-secret rotation:** via API only — `POST /api/admin/rotate-secret` `{newSecret ≥ 32 chars}` (admin). Old sessions survive one rotation (prev fallback), die on the second. Inspect via `GET /api/admin/secret-info` (`{hasPrev, rotatedAt, source}` — never values). Details: [backend/README JWT secret rotation](backend/README.md#jwt-secret-rotation).
- **Offline verify:** export the public-key bundle once (`GET /api/admin/verify-bundle`), then `node backend/scripts/offline-verify.js 'P1.…' --key bundle.json` anywhere offline — signature check only, confirm status/revocation online. Details: [backend/README offline verification](backend/README.md#offline-verification-no-connectivity). The frontend also has a public `/offline` page (bundle upload + paste token, airplane-mode capable): [frontend/README](frontend/README.md#offline-verify--pwa).
- **Readiness drill:** `cd backend && ./scripts/drill.sh` runs a throwaway 10-step protest scenario (event pass → verify → clone flag → triage → report-loss → audit). Checklist + runbook: [docs/DRILL.md](docs/DRILL.md).

## Changelog (from `git log --oneline`)

- **Cycle 1** — PressID cycle 1: backend (signed QR, anti-clone verify) + frontend (4 roles, print CSS) — smoke passed
- **Cycle 2** — admin stats/scans-recent/audit, login rate-limit, auto-expiry, police timeline + flag explainers, issuer search
- **Cycle 3** — canonical reason codes, zone enforcement, duplicate-scan, timeline, photo upload, CSV export, scan-trail map, note-chip verdict
- **Cycle 4** — hash-chained audit + /audit/verify, node:test suite 7/7, camera QR scan, Hindi toggle, mount Topbar fix
- **Cycle 5** — issuer quotas, press must-change password, Ed25519 rotation w/ fallback, full Hindi chrome, admin key panel, press QR+copy
- **Cycle 6** — offline verify bundle + CLI, PWA shell, prod hardening (fail-fast secret, no-store, graceful shutdown), fix flaky sig-flip tests
- **Cycle 7** — npm start/demo + demo seed, rich health, Hindi explainers, SW update banner, localhost demo hint, fix missing /login route + PressDashboard import
- **Cycle 8** — E2E-proven in real browser (6/6) — CORS middleware, GET card mints token+QR, police geolocation + flat-card fixes
- **Cycle 9** — card.holder embedded (press detail names), Hindi geolocation errors, CORS + card-QR regression tests (16/16)
- **Cycle 10** — deploy packaging — Dockerfiles, nginx proxy, compose, backup/restore scripts, root README ops refresh
- **Cycle 11** — alert triage workflow — open/acked/resolved states, admin inbox actions + filter, stats.alertsOpen (18/18 tests)
- **Cycle 12** — event-scoped protest passes — event_name/end, EVENT_ACTIVE duty chip, expiry by event, list filters (20/20 tests)
- **Cycle 13** — press self-service — my scans (clone self-detect), report-loss freeze w/ CARD_REPORTED, Hindi strings (22/22 tests)
- **Cycle 14** — card replacement chain (replaces_id, inheritance, lineage UI) + missing issued i18n key (24/24 tests)
- **Cycle 15** — second E2E sweep 5/5 (keys, replace chain, triage, offline) — fix admin white-screen quotaSupported crash
- **Cycle 16** — crash-proofing — error boundaries on all role routes, global error listeners, setter audit clean, i18n gap-fill
- **Cycle 17** — frontend static regression suite (8 node:test, zero deps) — catches missing i18n keys + setter crashes
- **Cycle 18** — authed rate limits — verify 60/min, export 10/min, audit-verify 20/min, backstop 300/min + Retry-After (28/28 tests)
- **Cycle 19** — 429 UX — Retry-After countdown chips + manual retry on verify/export/audit, double-submit guards (9/9 frontend tests)
- **Cycle 20** — third E2E sweep green — expose Retry-After for browser countdown, Hindi gap-fill (lat/lng, hints, bundle), expose-header regression test
- **Cycle 21** — docs refresh — 28-route table matches grep, changelog from git log, no stale endpoints, no inference text
- **Cycle 22** — protest-day readiness — drill.sh 10/10 live scenario, Demo Bandh event seed, DRILL.md runbook + checklist
- **Cycle 23** — verify-all.sh — one command runs backend 28 + frontend 9 + build + drill 10 (all green ~6s)
- **Cycle 24** — threat-model pass (docs/THREAT.md) — mustChange enforced (403 gate + press lock), issuance velocity 20/hr, hasPhoto chip, 401 auto-logout
- **Cycle 25** — screenshot-sharing tripwires — FIRST_SCAN_LATE note on stale first scans, officer_zone provenance on all scan views
- **Cycle 26** — fourth E2E sweep — press gate reload, issuer raw-error chip, timeline t-shadow crash, shared Hindi context (verify-all green)
- **Cycle 27** — static tests encode 4 E2E-caught bug classes (t-shadow, shared context, raw errors, effect reload) — 14/14, mutation-probed
- **Cycle 28** — backend structural guards (exports, DDL, limiter wiring, code-docs discipline, no last-char flips) + reason-code coverage — 39/39
- **Cycle 29** — perf pass — covering scan index, expiry sweep index, touchExpiry write-lock fast-path, bench script (p95 ~1ms, budget 50ms)
- **Cycle 30** — fifth E2E sweep all-green — fix PressCard cardId crash on Issued panel, KeyPanel currentKid mapping
- **Cycle 31** — bare-identifier static test kills cardId-class crashes (15/15, mutation-probed)
- **Cycle 32** — backend bare-name guard + key-shape contract (behavioral + KeyPanel pins), mutation-probed — 41/41
- **Cycle 33** — sixth E2E smoke 5/5 zero errors + changelog catch-up (cycles 21-32), counts current (41/15), routes confirmed 28
- **Cycle 34** — dependency hygiene — 0 vulns both dirs, all-MIT licenses, engines pinned (backend >=22, frontend >=20)
- **Cycle 35** — JWT secret rotation without downtime — dual-secret grace, file store, secret-info, KeyPanel section (43/43 tests, routes 30)
- **Cycle 36** — seventh E2E sweep — secret rotation in browser (session survives, old tokens grace, new logins work), THREAT case F closed
- **Cycle 37** — changelog catch-up (cycles 32-36) + backend README test count 41→43
- **Cycle 38** — backup checkpoint — bundle at /tmp/pressid-backup.bundle (no remote configured)
- **Cycle 39** — voluntary press device check-in — `POST /me/check-in` stores client UUID (`holders.device_id`/`device_at`, audit `holder.checkin`); `holderCheckedIn` on cardView + verify → police "holder device on file" chip (signal only, zero validity effect; printed cards keep working) — 44/15, routes 31
- **Cycle 40** — eighth E2E sweep (check-in end-to-end, absence correct) — fix Login render-phase nav() console errors; bundle refreshed
- **Cycle 41** — SW cache v2 + lifecycle pins (skipWaiting/claim/purge tested) — 16/16 frontend
- **Cycle 42** — fresh-eyes review — 14 findings fixed (dead press-admin role, police scrape scope, CSV injection, compose secret, restore perms, no-store spread, quota wiring, dead code purge)
- **Cycle 43** — lock review fixes — 5 behavioral regression tests (roles, scrape gate, active validation, quota shape, CSV injection) + browser-proven — 49/16, routes 31
- **Cycle 44** — changelog catch-up (37-43), counts current (49 backend/16 frontend, 31 routes), bundle refreshed
- **Cycle 45** — tenth E2E sweep all-green, zero fallout (post-review regression: roles, gates, quota, CSV, velocity, Hindi, offline — verify-all green)
- **Cycle 46** — changelog catch-up (44-45)
- **Cycle 47** — adversarial review fixes — admin must-change seed+middleware gate, trust-proxy, crypto temp creds, validDays clamp, last-admin guard, photoHash ignore, fork 409, oracle guard, headers, drill rotation (56 backend tests)
- **Cycle 48** — eleventh E2E sweep — admin first-login gate graceful in browser, rotation unlocks, full regression zero fallout
- **Cycle 49** — admin must-change banner parity (why + anchor to password form, gate-lift reload) — 17/17 frontend
- **Cycle 50** — milestone: verify-all green (56 backend + 17 frontend + build + drill 10/10), 31 routes, 12 E2E sweeps, 2 adversarial reviews
- **Cycle 51** — dependency re-check — 0 vulns both dirs (unchanged since cycle 34), verify-all green
- **Cycle 52** — twelfth E2E sweep all-green (admin banner, rotation grace, lineage, check-in, offline, Hindi) + bundle refreshed
- **Cycle 53** — changelog catch-up (51-52)
- **Cycle 54** — drill refresh 10/10, runbook rotation checklist confirmed current — no changes needed
- **Cycle 55** — THREAT.md audit — A-K current (G-K from cycle 47 verified present), no gaps
- **Cycle 56** — changelog catch-up (53-55) + bundle refresh
- **Cycle 57** — thirteenth E2E sweep all-green, zero fallout (gate, rotation, lineage, check-in, offline, Hindi — verify-all exit 0, no pipe mask)
- **Cycle 58** — changelog catch-up (56-57)
- **Cycle 59** — kill native dialogs — two-tap inline confirm on revoke/report-loss/quota, dialog-ban test (18/18 frontend)
- **Cycle 60** — fourteenth E2E sweep all-green, zero fallout (two-tap revoke + report-loss proven dialog-free with surviving tabs, quota inline edit, gate, issue, verify, timeline, Hindi, check-in, offline — verify-all green 56+18+build+drill, console clean)
- **Cycle 61** — state audit — verify-all green (exit 0); drill 151s anomaly isolated to machine contention (2.4s standalone), no strays
- **Cycle 62** — timing transparency — drill warns on slow boot/steps, verify-all notes slow totals (fast path unchanged)
- **Cycle 63** — fifteenth E2E sweep all-green, zero fallout (gate→banner→rotate admin+press, issue+replace+lineage, verify+chips+timeline+Hindi, check-in+my-scans+loss→CARD_REPORTED, offline OK — verify-all green, console clean) + changelog 61-63
- **Cycle 64** — gate-lift clears stale 403 banners (admin, press, KeyPanel) + static pin (19/19 frontend)
- **Cycle 65** — sixteenth E2E sweep all-green, zero fallout (gate-lift proven without reload: admin banner gone + stats + key kid 2820ec3f live, press banner gone + cards render — verify-all green 56+19+build+drill 10/10, console clean)
- **Cycle 66** — changelog catch-up (64-65)
- **Cycle 67** — seventeenth E2E sweep all-green, zero fallout (gate→banner→rotate admin+press incl. press 3-field no-reload lift, secret+key rotation session-survives, issue+replace+lineage replacesId 3→4/replacedBy 4, verify+timeline zone north+Hindi EN/हिं, check-in holderCheckedIn+my-scans, two-tap loss→CARD_REPORTED tab survives, offline bundle kid 1f34d518 signature-OK airplane-render — verify-all green 56+19+build+drill 10/10 exit 0, console clean)
- **Cycle 68** — endpoint docs verified correct (agent probe guesses were wrong, docs right) — no changes needed
- **Cycle 69** — light review — restore org cell dropped by cycle-59 quota edit (admin table misaligned)
- **Cycle 70** — table column-parity static test kills org-cell class (20/20 frontend, verify-all green)
- **Cycle 71** — state audit + verify-all green + changelog 68-71 + bundle refresh
- **Cycle 72** — eighteenth E2E sweep all-green, zero fallout (gate→banner→rotate admin+press incl. press 3-field no-reload lift, secret+key rotation session-survives kid e6b8af7c→1bf13c6e, issue+replace+lineage replacesId 1→4/replacedBy 4, verify+chips+timeline zone north+Hindi EN/हिं, check-in holderCheckedIn+my-scans, two-tap loss→reported tab survives, offline bundle kid 1bf13c6e signature-OK — verify-all green 56+20+build+drill 10/10 exit 0, console clean)
- **Cycle 73** — state audit — verify-all green exit 0; live :4000 demo server (external, ttys001) healthy, left untouched
- **Cycle 74** — nineteenth E2E sweep all-green, zero fallout (gate→banner→rotate admin+press incl. press temp-creds 3-field no-reload lift, secret+key rotation session-survives kid 98391033→4c7f3516, revoke+replace+lineage replacesId 1→3/replacedBy 3, verify VALID+timeline zone north+Hindi EN/हिं, check-in holderCheckedIn+my-scans, two-tap loss→CARD_REPORTED tab survives, offline bundle kid 4c7f3516 signature-OK — verify-all green 56+20+build+drill 10/10 exit 0, console clean)
- **Cycle 75** — server-watch: dead :4000 demo restarted detached (healthy, same DB/keys), verify-all green
- **Cycle 76** — twentieth E2E sweep all-green, zero fallout (gate→banner→rotate admin+press incl. press temp-creds 3-field no-reload lift, key rotation session-survives kid feacbff8→f78adf26, revoke+replace+lineage replacesId 3→4/replacedBy 4, verify VALID+timeline zone north+Hindi EN/हिं, check-in holderCheckedIn+my-scans, two-tap loss→CARD_REPORTED tab survives, offline bundle kid f78adf26 signature-OK — verify-all green 56+20+build+drill 10/10 exit 0, console clean)
- **Cycle 77** — serve-live.sh (detached, refuse-double-boot) + docs; :4000 alive, verify-all green
- **Cycle 78** — live check healthy + changelog 77-78 + bundle refresh
- **Cycle 79** — twenty-first E2E sweep all-green, zero fallout (gate→banner→rotate admin+press incl. press temp-creds 3-field no-reload lift, key rotation session-survives kid 43a80af5→c83eaf1f, revoke+replace+lineage replacesId 3→4/replacedBy 4, verify VALID→INVALID CARD_REPORTED+holder-device chip+timeline zone north+Hindi EN/हिं, check-in+my-scans, two-tap loss→reported tab survives dialog-free, offline bundle kid c83eaf1f signature-OK airplane-render — verify-all green 56+20+build+drill 10/10 exit 0, console clean)
- **Scan upgrades** — continuous scan + torch/zoom + upload fallback + holder photo serve/compare + SAME_POST_RESCAN pass-back flag + risk score + offline verify queue (62 backend, 20 frontend)
- **Iteration A** — E2E-proved scan upgrades (6/7 + 1 honest partial): fixed verify cardOut missing holderId (photo pane never rendered) + test pin; verify-all green
- **Iteration B** — persist SAME_POST_RESCAN into scan-row flags so timeline/history surface it (was reasons-only) + test pin; verify-all green
- **Iteration C** — provisional offline verdict shows signed holder snapshot (name/org + trustworthy-but-unconfirmed caption, en+hi)
- **Iteration D** — issuer photo messages through i18n (en+hi); audit found flow solid otherwise
- **Iteration E** — auto-location on verify (consent toggle persisted, freshness stamp, manual fields behind Adjust disclosure)
- **Iteration F** — E2E-proved C+D+E (3/3 DOM evidence, zero fallout) + localized photo input label
- **Iteration G** — verify lastScans rows carry flags+result so the gate table shows flag chips + test pin; verify-all green
- **Iteration H** — E2E-proved G+E (flags chips, toggle+disclosure+fallback); fixed closed-details leaking lat/lng (flex override); verify-all green
- **Iteration I** — risk driver chips show human explainer text + action tooltip (was bare codes)
- **Iteration J** — one flag renders once: SAME_POST_RESCAN as note chip + alerts deduped against shown reasons (was 5x scary UI)
- **Iteration K** — dedup proven (1 chip 0 alerts); scan-next flow (clear+refocus+scroll on valid-only)
- **Iteration L** — last-verified receipt survives scan-next clear (name/org/score, en+hi)
- **Iteration M** — E2E-proved receipt (valid/invalid/loading) — receipt renders with verdict; next gap: auto-loc blocks scans up to 8s on GPS
- **Iteration N** — non-blocking auto-location (GPS races 900ms timer, stale fallback + hint); verify-all green
- **Iteration O** — E2E-proved non-blocking GPS (947ms vs 8s stall) + same 900ms race on manual location button
- **Iteration P** — fourth review: fixed serve-live boot, forged-provisional gate, rescan notes on invalid, verdict-top CSS, counts/index/docs; dropped redundant effect
- **Iteration Q** — E2E-proved P fixes (3.5/4 + serve-live fallout fixed in-tree); gate offline payload table on valid signature (forged QR showed attacker name)
- **Iteration R** — E2E-proved offline gate + pin; provisional verdict demoted to signature-OK/status-unknown with no accept badge (was full green VALID)
- **Iteration S** — E2E-proved demotion (en+hi); hint no longer claims active card offline (provisional_hint, en+hi)
- **Iteration T** — E2E-proved hint + pin; queue banner is the confirmation (no-bundle errors no longer clobber it)
- **Iteration V** — flushed offline scans keep true scan time (bounded client `at`, 24h/5min window) + test; verify-all green
- **Iteration W** — scan reads order by scan time (at DESC) so backdated flushes sort chronologically + test; verify-all green
- **Cycle 84** — twenty-second E2E sweep all-green, zero fallout (gate→banner→rotate admin+press incl. press temp-creds 3-field no-reload lift, key rotation session-survives kid e05fde6f→c3943c7d, revoke+replace+lineage replacesId 3→4/replacedBy 4, verify VALID 100/low→INVALID CARD_REPORTED 0/high risk panel+holder-device chip+timeline zone north+Hindi EN/हिं incl. जोखिम स्कोर, check-in+my-scans, two-tap loss→reported tab survives dialog-free, offline bundle kid c3943c7d signature-OK — verify-all green 62+21+build+drill 10/10 exit 0, console clean; mid-sweep catch: :4471 booted pre-scan-upgrades served no-risk verify shape, killed + reseeded fresh on HEAD, first-run evidence discarded; :4000 healthy, sha unchanged)

## Verify (one command)

```bash
./scripts/verify-all.sh
```

Runs, in order: (1) backend tests, (2) frontend tests, (3) frontend build, (4) readiness drill. Exits non-zero on the first failure; prints per-stage PASS + timing and a final `verify-all: 4 passed` line.

