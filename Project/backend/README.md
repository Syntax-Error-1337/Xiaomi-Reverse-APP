# PressID Backend

Tamper-proof Press ID issuance + verification API. Cards are Ed25519-signed tokens; QR holds the token only — all truth lives server-side.

## Install & run

```bash
cd backend
npm install
npm start   # seeds admin / admin123 if missing, then serves http://localhost:4000
./scripts/serve-live.sh [port]   # detached demo (survives shell, refuses double-boot, logs /tmp/pressid-live.log)
```

## Demo (one command)

```bash
npm run demo   # ALLOW_DEV_SECRET=1 PRESSID_DEMO=1 seed + server
```

On a fresh DB (only the admin user) this also seeds:

- `issuer-demo` / `pass1234` — issuer, org `Demo Press`
- `officer-demo` / `pass1234` — police, zone `north`
- one holder (`Demo Reporter`, org `Demo Press`) + one active card (zones `[north]`)

Re-running is safe: if the demo users already exist the seed skips them.
If the DB already has other non-admin users, the demo seed skips too (use a
fresh DB for the demo). The seed prints the credentials plus a curl sample.

| Var | Default | Notes |
|---|---|---|
| `JWT_SECRET` | *(none — fail-fast)* | Server refuses to boot with empty secret unless `ALLOW_DEV_SECRET=1` (dev only, warns loudly) or a rotated `data/keys/jwt.json` exists (file takes precedence — see [JWT secret rotation](#jwt-secret-rotation)). Seed prints the same warning. |
| `JWT_PREV_SECRET` | unset | Previous JWT secret for the grace window (env fallback when no `jwt.json` file). Verify tries current then prev. |
| `PORT` | `4000` | |
| `PRESSID_DB` | `data/pressid.db` | sqlite file; tests point it at a throwaway file. |
| `PRESSID_KEYS_DIR` | `data/keys` | Ed25519 key dir; tests use a throwaway dir. |
| `PRESSID_QUIET` | unset | `=1` silences the request logger; tests set this. `NODE_ENV=test` silences it too. |
| `PRESSID_DEMO` | unset | `=1` makes `seed.js` add the demo issuer/officer/holder/card (fresh DBs only). |

## Quick flow (curl)

```bash
BASE=http://localhost:4000/api
# 1. login → save token
TOKEN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")
# 2. register a holder (issuer/admin; creates a press login)
HOLDER=$(curl -s -X POST $BASE/holders -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"fullName":"Asha Rao","org":"City Times","designation":"Reporter","idRef":"EMP-42"}')
echo "$HOLDER"   # {holder, username, tempPassword}
HID=$(echo "$HOLDER" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).holder.id")
# 3. issue a card → token + QR
ISSUE=$(curl -s -X POST $BASE/cards -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"holderId\":$HID,\"validDays\":365,\"zones\":\"north,central\"}")
CTOKEN=$(echo "$ISSUE" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")
CID=$(echo "$ISSUE" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).card.id")
# 4. verify (police/admin)
curl -s -X POST $BASE/verify -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$CTOKEN\",\"lat\":28.61,\"lng\":77.23}"
# 5. revoke (issuer/admin)
curl -s -X POST $BASE/cards/$CID/revoke -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"lost card"}'
```


## Endpoints (base `/api`)

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/health` | — | `{ok, version, time, db, keyKid}` |
| POST | `/auth/login` `{username,password}` | — | `{token, user, mustChange}`; 401 bad creds; press logins return `mustChange:true` until temp password is rotated |
| POST | `/auth/change-password` `{oldPassword,newPassword}` | any (Bearer) | `newPassword` ≥ 8 chars → `{ok:true}`, clears `mustChange`; wrong old → 403 |
| GET | `/users` | admin | `[{id,username,role,orgName,zone,active,quota}]` |
| POST | `/users` `{username,password ≥ 8 chars,role,orgName,zone}` | admin | role: `issuer`\|`police` → 201 created user; 400 bad role/short password; 409 username taken |
| PATCH | `/users/:id/active` `{active}` | admin | |
| PATCH | `/users/:id/quota` `{quota:number|null}` | admin | issuer org cap on active cards (`null` = unlimited); audit `user.quota`; at-cap issuer issues → 403 `{error:"Org quota exceeded"}` |
| POST | `/holders` `{fullName,org,designation,idRef,photoHash}` | issuer, admin | creates press login → `{holder, username, tempPassword}` |
| GET | `/holders` | issuer (own org), admin (all) | |
| POST | `/holders/:id/photo` `{dataUrl}` | issuer (own org), admin | `data:image/(jpeg|png);base64,…` ≤700KB decoded → `{photoHash}` (sha256); bytes stored at `data/photos/<sha256hex>.bin`; audit `holder.photo` |
| GET | `/holders/:id/photo` | police, admin (any org), issuer (own org) | raw photo bytes; `Content-Type` from magic bytes (JPEG `FFD8` → `image/jpeg`, PNG `89504E47` → `image/png`); no `photoHash`/missing file → 404 `{error}`; `Cache-Control: no-store` |
| POST | `/cards` `{holderId,validDays,zones[,eventName,eventEnd,replacesId]}` | issuer, admin | `{card, token, qrDataUrl}`; `replacesId` re-issues a terminal card (`reported`\|`revoked`\|`expired`, own org): holder/zones/event inherit unless overridden (`holderId` optional then, must match old holder; explicit `zones`/`eventName` win); audit `card.replace {oldId newId}`; quota counts post-issue actives as usual |
| GET | `/cards` | issuer (org), admin, press (own) | card view carries `holder {id,fullName,org,designation}`, `photoHash`, `hasPhoto`, `holderCheckedIn` (voluntary device signal), `eventName`/`eventEnd`, `replacesId` + `replacedBy` |
| GET | `/cards/:id` | issuer (org), admin, press (own) | same card view; unknown id → 404 |
| POST | `/cards/:id/revoke` `{reason}` | issuer, admin | `{ok:true}` |
| GET | `/me/scans` | press (own) | newest first `[{cardId,at,lat,lng,result,flags,officerZone}]`, limit 100 (`officerZone` = scanning officer's zone at scan time, `''` if unset) |
| POST | `/me/report-loss` `{cardId}` | press (own card) | sets status `reported` (terminal, like revoked) → `{ok:true}`; audit `card.report_loss`; 403 others' cards, 404 unknown |
| POST | `/me/check-in` `{deviceId: 8-64 chars}` | press (own) | voluntary: stores client UUID as `holders.device_id`/`device_at` → `{ok:true,deviceAt}`; audit `holder.checkin`; zero validity effect (printed cards work either way) |
| POST | `/verify` `{token[,lat,lng]}` | police, admin | `{valid,reasons,card,lastScans,alerts,risk,photoUrl}`; `risk: {score 0-100, level low\|watch\|high, drivers[]}` (see Risk scoring); `photoUrl: '/api/holders/:holderId/photo' \| null`; card carries `hasPhoto` + `holderCheckedIn` (informational chips only); logs a scan (stores `officer_zone` from the officer's profile); `lastScans` carry `officerZone`; rate-limited 60/min; 429 + `Retry-After` |
| GET | `/scans?cardId=` | police (own cardId required), admin (all) | newest first, triage fields; 403 police without `cardId` |
| PATCH | `/scans/:id/triage` `{state}` | admin | `state: acked\|resolved` → `{id,triage,triagedBy,triagedAt}`; audit `scan.triage`; unknown id → 404 |
| GET | `/scans/:cardId/timeline` | police, admin | ascending `[{id,at,lat,lng,result,flags,byUsername,officerZone}]`, limit 500; `[]` for unknown card |
| GET | `/scans/export?cardId=&format=csv` | admin | `text/csv` attachment `scans.csv`; header `id,card_id,holder,at,lat,lng,result,flags,by_user`; rate-limited 10/min; 429 + `Retry-After` |
| GET | `/scans/recent?limit=50` | admin | newest first `{id,cardId,holderName,org,at,lat,lng,result,flags,byUsername,officerZone}` |
| GET | `/audit?limit=100` | admin | newest first `{id,at,byUsername,action,detail,prevHash,entryHash}`; actions: `user.create`, `user.set_active`, `user.quota`, `card.issue`, `card.revoke`, `card.replace`, `card.report_loss`, `holder.photo`, `holder.checkin`, `scan.triage`, `admin.rotate_keys`, `admin.rotate_secret` |
| GET | `/audit/verify` | admin | `{ok:true,entries:N}` or `{ok:false,brokenAt:id}`; recomputes the hash chain |
| GET | `/admin/key-info` | admin | `{currentKid, hasPrev, rotatedAt?}` |
| POST | `/admin/rotate-keys` | admin | new Ed25519 pair → current, old → `.prev`; audit `admin.rotate_keys` |
| GET | `/admin/verify-bundle` | admin | `{kid, publicKeyJwk, exportedAt, verifyHint}` — public key only, for offline signature checks |
| GET | `/admin/secret-info` | admin | `{hasPrev, rotatedAt, source}` — shape only, never secret values |
| POST | `/admin/rotate-secret` `{newSecret >= 32 chars}` | admin | new secret → current, old → prev (grace window); writes `jwt.json` (0600); audit `admin.rotate_secret` |

## JWT secret rotation

Sessions are JWTs signed with a server secret. Rotating used to mean downtime
plus every session dying; now it is graceful (same pattern as Ed25519 key
rotation): verify tries the current secret, then falls back to the previous
one, so sessions minted before a rotation keep working. Signing always uses
the current secret. A second rotation drops the first generation from the
grace window — oldest sessions die then.

Precedence: `data/keys/jwt.json` (`{current, prev, rotatedAt}`, 0600) if
present, else `JWT_SECRET` / `JWT_PREV_SECRET` env. `secret-info` reports
`{hasPrev, rotatedAt, source: 'file'|'env'}` — never secret values. The
fail-fast boot check is unchanged except that a present `jwt.json` also
satisfies it (no restart needed after an API rotation).

```bash
BASE=http://localhost:4000/api
# inspect (shape only — no values)
curl -s $BASE/admin/secret-info -H "Authorization: Bearer $TOKEN"
# → {"hasPrev":false,"rotatedAt":null,"source":"env"}
# rotate (admin; new secret ≥ 32 chars)
curl -s -X POST $BASE/admin/rotate-secret -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"newSecret":"<32-plus-char-secret>"}'
# → {"ok":true,"rotatedAt":"…"}; old sessions keep verifying (prev fallback).
# Emergency rollback: stop the server, delete data/keys/jwt.json, restart
# (falls back to JWT_SECRET env; all rotated sessions die).
```

Auth header: `Authorization: Bearer <jwt>`. Prod hardening: `Cache-Control: no-store`
on `/auth/*` + `POST /verify`; request log lines (`method path status ms`, no tokens/bodies);
graceful shutdown on SIGTERM/SIGINT (closes server + DB).

## Card token format

`P1.<base64url(canonical JSON payload)>.<base64url(ed25519 signature)>`

Payload (fixed key order): `{v:1, cardId, holderId, name, org, issuedAt, validTill, nonce, kid}` where `kid` = first 8 hex of `sha256(SPKI DER)` of the signing key. Keys persisted in `data/keys/ed25519.json` (current, 0600) + `ed25519.prev.json` (previous, 0600) + `meta.json` (`{currentKid, prevKid, rotatedAt}`). Verify tries the current key, then the previous — pre-rotation tokens keep verifying. Mint always uses the current key. Verify cross-checks signed fields vs DB — mismatch → `TAMPER_MISMATCH`; bad signature → `INVALID_SIGNATURE`.

## Key rotation

```bash
BASE=http://localhost:4000/api
# inspect
curl -s $BASE/admin/key-info -H "Authorization: Bearer $TOKEN"
# → {"currentKid":"…","hasPrev":false}
# rotate (generates a fresh pair, moves current → .prev, records meta + audit admin.rotate_keys)
curl -s -X POST $BASE/admin/rotate-keys -H "Authorization: Bearer $TOKEN"
# old tokens keep verifying via the .prev fallback; new cards carry the new kid.
# Emergency rollback: stop the server, copy ed25519.prev.json over ed25519.json,
# delete ed25519.prev.json + meta.json, restart.
```

## Offline verification (no connectivity)

Checkpoints that lose connectivity can still check crypto authenticity
(“was this card really signed by us?”) without the server. Card validity,
revocation, and zones still need `POST /api/verify` once back online — a
valid offline signature alone is NOT clearance.

```bash
BASE=http://localhost:4000/api
# 1. online once: export the public-key bundle (admin; public key only, never private)
curl -s $BASE/admin/verify-bundle -H "Authorization: Bearer $TOKEN" > bundle.json
# → {"kid":"…","publicKeyJwk":{"kty":"OKP","crv":"Ed25519","x":"…"},"exportedAt":"…",
#    "verifyHint":"offline signature check only — confirm status/revocation online"}
# 2. offline any number of times (node only, no npm deps):
node scripts/offline-verify.js 'P1.<payload>.<sig>' --key bundle.json
# → payload JSON, then `signature: OK` (exit 0) or `signature: FAIL` (exit 2),
#   plus a field table (cardId/holderId/name/org/issuedAt/validTill/nonce/kid).
#   Malformed token/bundle → exit 1.
# 3. back online: confirm status/revocation via POST /api/verify as usual.
```

## Issuer quotas & press password rotation
- `PATCH /users/:id/quota` (admin) sets the max active cards per issuer org (`null` = unlimited, default). Issuer `POST /cards` counts active cards across all holders in the issuer's org → 403 `{error:"Org quota exceeded"}` at cap. Admin issues bypass quota. `users.quota` is migrated via `ALTER TABLE … ADD COLUMN` guarded by `PRAGMA table_info`.
- Press logins from `/holders` get one-time temp passwords with `must_change=1` (`users.must_change`, same guarded migration). `/auth/login` returns `mustChange`; press rotates via `POST /auth/change-password` (`oldPassword` verified, `newPassword` ≥ 8 chars, bcrypt cost 10) which clears the flag. Wrong old password → 403.
- Forced rotation is enforced in `authMiddleware` (cycle 47): any press/admin login with `must_change=1` gets 403 `MUST_CHANGE_PASSWORD` on every guarded route except login + change-password. Fresh-seeded `admin/admin123` ships with `must_change=1` — rotate on first login. Deactivating the last active admin → 403.
- Temp passwords are `crypto.randomBytes(9)` (72-bit base64url); user-create requires ≥ 8 chars. `POST /cards` clamps `validDays` to 1..1825 (default 365). Replacements are single: second `replacesId` use → 409 `{replacedBy}` (partial unique index).

`valid` = no blocking reasons (informational codes `UNKNOWN_ZONE`, `DUPLICATE_SCAN`, `EVENT_ACTIVE`, `FIRST_SCAN_LATE`, `SAME_POST_RESCAN` are kept in `reasons` but do not block).

| Code | When | Blocks? |
|---|---|---|
| `INVALID_FORMAT` | malformed token | yes |
| `INVALID_SIGNATURE` | bad signature | yes |
| `CARD_NOT_FOUND` | card/holder row missing | yes |
| `TAMPER_MISMATCH` | signed fields differ from DB | yes |
| `REVOKED` | card status revoked | yes |
| `CARD_REPORTED` | card status reported (holder-reported loss; terminal like revoked) | yes |
| `STATUS_EXPIRED` | status `expired` **or** `valid_till` passed, **or** `event_end` passed (never bare `EXPIRED`) | yes |
| `STATUS_<X>` | any other non-active status | yes |
| `OUT_OF_ZONE` | card zones non-empty, officer zone non-empty, no match | yes |
| `UNKNOWN_ZONE` | officer has no zone assigned | no (informational) |
| `EVENT_ACTIVE` | card carries a live `event_name` whose `event_end` has not passed | no (informational) |
| `DUPLICATE_SCAN` | identical lat/lng (tolerance 1e-6) for same card within 60s | no (informational) |
| `FIRST_SCAN_LATE` | card's first scan ever lands >1h after issue (`valid_from`); possible pre-shared screenshot — fresh event passes scan within minutes at the gate | no (informational) |
| `SAME_POST_RESCAN` | same card re-scanned from the same non-empty officer zone within 10 min (any coords; possible pass-back through a crowd — `DUPLICATE_SCAN` covers identical coords <60s) | no (informational) |

Every scan stores `officer_zone` (the verifying officer's zone at scan time, `NULL` when unset; guarded `ALTER TABLE … ADD COLUMN` migration) for triage provenance. It is surfaced as `officerZone` on `/verify.lastScans`, `/scans`, `/scans/:cardId/timeline`, `/scans/recent`, and `/me/scans`.

## Risk scoring (deterministic; every `POST /verify` returns `risk`)

Start at 100. Each blocking code present sets `score = min(score, value)` (lowest wins). Each clone/note flag present subtracts its weight. Floor 0.

| Code | Effect |
|---|---|
| `INVALID_SIGNATURE` / `TAMPER_MISMATCH` | → 0 |
| `INVALID_FORMAT` (malformed token, early-invalid path) | → 0 |
| `REVOKED` / `CARD_REPORTED` | → 5 |
| `CARD_NOT_FOUND` | → 10 |
| `STATUS_EXPIRED` | → 20 |
| `OUT_OF_ZONE` | → 40 |
| `IMPOSSIBLE_TRAVEL` / `SIMULTANEOUS_FAR` | −30 each |
| `SAME_POST_RESCAN` | −25 |
| `VELOCITY_BURST` | −20 |
| `FIRST_SCAN_LATE` | −10 |
| `UNKNOWN_ZONE` / `DUPLICATE_SCAN` / `EVENT_ACTIVE` | −0 |

Levels: `score >= 80` → `low` (`accept`); `50–79` → `watch` (`accept, watch`); `< 50` → `high` (`do not accept`). `valid=false` forces `high` regardless. `drivers` = top 3 score-reducing codes in application order (blockers first, then clone flags, then notes).

## Anomaly rules (every `/verify` logs a scan; flags computed over last 20 scans)

- `IMPOSSIBLE_TRAVEL` — speed > 500 km/h between consecutive geo scans (haversine).
- `SIMULTANEOUS_FAR` — two scans > 50 km apart within 10 min.
- `VELOCITY_BURST` — > 10 scans within 30 min.

## Audit chain

Every audit row carries `prev_hash` + `entry_hash`, forming a tamper-evident hash chain:

```text
entry_hash = sha256(prev_hash + '|' + at + '|' + by_user + '|' + action + '|' + detail)  (hex)
```

The first row chains from genesis `prev_hash = 'GENESIS'`. Pre-chain databases are
migrated on boot (`ALTER TABLE audit ADD COLUMN …` guarded by `PRAGMA table_info`,
legacy rows backfilled oldest→newest). `GET /api/audit` returns `{prevHash, entryHash}`
per row; `GET /api/audit/verify` (admin) walks the chain oldest→newest recomputing
## Rate limiting

Expensive authed endpoints are capped per user (sliding window, in-memory
`Map`, pruned on access; `src/rateLimit.js` `makeLimiter`). Exceed → 429
`{error:"Too many requests"}` + `Retry-After` header (seconds).

| Group | Window | Cap | Scope |
|---|---|---|---|
| verify (`POST /verify`) | 1 min | 60 | per user |
| export (`GET /scans/export`) | 1 min | 10 | per user |
| auditVerify (`GET /audit/verify`) | 1 min | 20 | per user |
| default backstop (all authed `/api` except `/health`) | 1 min | 300 | per user |

Notes: admins obey the same limits (uniform, simpler). `/auth/login` keeps its
separate IP-based fail counter (10 fails / 5 min → 429), untouched.

## Tests

```bash
npm test   # node --test test/ — 62 tests; boots the app on an ephemeral port against a
           # throwaway DB via PRESSID_DB (+ throwaway keys via PRESSID_KEYS_DIR);
           # covers issue→verify→revoke, tampered token (INVALID_SIGNATURE),
           # REVOKED, OUT_OF_ZONE, rate-limit 429, audit chain link + verify ok,
           # verify tamper detection, issuer quota 403 at cap / ok when
           # unlimited, press mustChange → change-password flow, key
           # rotation (old token still verifies, new cards carry current kid),
           # verify-bundle JWK == current kid (public only), offline CLI
           # exit 0 on a real token / exit 2 on a flipped sig, and
           # `Cache-Control: no-store` on login.
```

## Verify perf (cycle 29)

The verify hot path is indexed: `scans(card_id, id DESC)` (card-scoped
`ORDER BY id DESC LIMIT n` walks one index), `cards(status, valid_till)`
(`touchExpiry` guard SELECT rides it; the UPDATE write-lock is skipped when
nothing is past due). `holders.user_id` needs no index (UNIQUE autoindex).
```bash
node scripts/bench-verify.js   # throwaway DB: 1 card + 5000 scans, 100 verifies;
                               # prints median/p95 + EXPLAIN QUERY PLAN; fails if p95 >= 50ms.
```

## Ops: docker, backup & restore

```bash
# docker (from repo root)
docker compose up --build   # backend :4000, frontend :8080; data in pressid-data volume
# JWT_SECRET is REQUIRED — the server refuses to boot without it unless
# ALLOW_DEV_SECRET=1 (dev only). Compose passes ${JWT_SECRET}; the
# `change-me-set-JWT_SECRET-env` placeholder must be replaced for real use.
```

```bash
# backup (timestamped DB + keys tarball into backend/backups/)
./scripts/backup.sh                       # uses PRESSID_DB / PRESSID_KEYS_DIR if set
# restore (stopped server only — refuses if /health answers on $PORT)
./scripts/restore.sh backups/pressid-backup-<ts>.tar.gz
```

Key rotation is via the API (`POST /api/admin/rotate-keys`); no offline script is needed.
See [key rotation](#key-rotation) and [offline verification](#offline-verification-no-connectivity).
