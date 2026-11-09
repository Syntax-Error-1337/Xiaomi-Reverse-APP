# PressID threat model (cycle 24)

Adversarial pass over issuance → verify. Each case: status, the control that
backs it, and what is still accepted as residual risk.

## A. Stolen police creds → unlimited verify scraping

- **Status: MITIGATED.** Three layers cap a stolen police login:
  - login fail counter: 10 bad tries / 5 min / IP → 429 (`server.js`
    `loginBlocked`/`loginFail`).
  - per-user verify window: 60 verifications / min → 429 + `Retry-After`
    (`verifyLimiter`, cycle 18).
  - global authed backstop: 300 authed calls / min per JWT id → 429; garbage
    tokens fall into an IP bucket so a forged `id` claim can never burn
    someone else's window.
- **Residual risk:** a patient attacker staying under 60/min keeps scraping
  indefinitely. Accepted: verify responses carry the minimum needed for a
  checkpoint (holder name/org/status), not bulk-exportable data; credential
  theft is a detection problem (see C), not a rate problem.

## B. Malicious issuer mass-issues cards for fake press

- **Status: OPEN → controlled this cycle.** Per-org active-card quotas
  (`PATCH /users/:id/quota`) cap *stock* but not *rate*: a compromised issuer
  account could mint dozens of cards in minutes before an admin notices.
- **Control added (cycle 24):** issuance velocity cap — 20 `POST /api/cards`
  per issuer per rolling hour → 429 + `Retry-After`. Admins exempt (trusted
  root; bulk/quota flows stay uncapped). Floods are now bounded to 20/hr per
  account, and every issue is audit-logged (`card.issue`) so the 20 are
  attributable.
- **Residual risk:** 20 fake cards/hr is still non-zero; slow-burn abuse under
  the cap needs admin review of the audit log. Quotas remain the stock control.

## C. QR screenshot shared to 100 phones

- **Status: PARTIAL (by design).** The QR token is a bearer credential: the
  first scans from any number of copies all verify VALID — there is no
  challenge/response or single-use nonce, so no post-hoc flag can prevent the
  first pass-throughs.
- **Controls:** post-hoc clone detection (`cloneFlags`: IMPOSSIBLE_TRAVEL /
  SIMULTANEOUS_FAR / VELOCITY_BURST over the last 20 scans, surfaced as alerts
  + admin triage), press self-service scan history (`GET /me/scans` with the
  "was this you?" hint), instant freeze (`POST /me/report-loss` →
  CARD_REPORTED, terminal), and a voluntary device check-in signal
  (`POST /me/check-in` stores a client-generated device UUID as
  `holders.device_id`/`device_at`; `cardView` + `/verify` surface
  `holderCheckedIn`, rendered as a "holder device on file" chip — no validity
  effect, printed cards keep working).
- **Residual risk:** the first N near-simultaneous entries pass before flags
  trip; the check-in chip is a trust signal, not a control — a copied QR still
  verifies VALID, the device UUID is self-asserted (copyable to another phone),
  and no scan-time device comparison exists. Accepted without hardware-bound
  credentials; the response loop
  (detect → report → freeze → re-issue with lineage) is the control.

## D. Press temp password never rotated

- **Status: OPEN → closed this cycle.** `POST /api/holders` creates press
  logins with `must_change=1` and the login response surfaces `mustChange`,
  but nothing enforced it: a temp-credential session could call `/me/scans`,
  `/me/report-loss`, `/cards` indefinitely. Advisory only.
- **Control added (cycle 24):** `requireFreshPassword` middleware on
  `GET /api/cards`, `GET /api/cards/:id`, `GET /me/scans`,
  `POST /me/report-loss` — press sessions with `must_change=1` get
  `403 { code: 'MUST_CHANGE_PASSWORD' }` on everything except login and
  `POST /auth/change-password`. Frontend `PressDashboard` renders only the
  change-password form until the flag clears.
- **Residual risk:** rotation still relies on the holder acting; a press user
  who never logs in keeps a valid temp password until the 12h JWT lapses
  (login issues a fresh one — see F; the password itself does not expire).

## E. Photo hash spoof / binding photo to holder at verify time

- **Status: INTEGRITY OK, DISPLAY GAP → narrowed this cycle.** Photo bytes are
  set only by the issuer/admin (`POST /holders/:id/photo`, JPEG/PNG ≤ 700KB,
  sha256 stored as `photo_hash`); press cannot self-upload, so a holder cannot
  swap in someone else's photo. But police saw only an opaque `photoHash`
  string — no signal whether a photo is even on file, and no image to compare
  (photos store the hash only, so the image cannot be rendered).
- **Control added (cycle 24):** `hasPhoto` boolean on `cardView` and the
  `/verify` card payload + a "photo on file / photo missing" chip in the
  police holder box. The officer now gets an explicit identity-check signal
  instead of an opaque hash.
- **Residual risk:** still no image at the checkpoint; visual binding depends
  on the officer comparing the person against the physical card / another ID
  when the chip says "missing".

## F. JWT theft

- **Status: MITIGATED.** `signUser` issues `expiresIn: '12h'`
  (`backend/src/auth.js`); `authMiddleware` rejects expired tokens with 401
  and re-checks `active` on every call, so deactivation kills stolen sessions
  within one request. Sensitive endpoints send `Cache-Control: no-store`, and
  the request logger never logs bodies/tokens.
- **Control added (cycle 24):** frontend `api()` clears `pressid_token` +
  `pressid_user` on any 401, so an expired/revoked session bounces to `/login`
  via the existing `RequireAuth` guard instead of failing every call against a
  dead token.
- **Control added (cycle 35, verified cycle 36 E2E):** graceful JWT secret
  rotation (`POST /api/admin/rotate-secret`, KeyPanel UI, `newSecret` ≥ 32
  chars). The old secret is kept as `prev` (grace window): sessions minted
  before the rotation keep verifying, new logins sign with the new secret,
  and state persists to `data/keys/jwt.json` (0600) with an
  `admin.rotate_secret` audit entry. `GET /api/admin/secret-info` reports
  `{hasPrev, rotatedAt, source}` — never secret values.
- **Rotation procedure (suspected theft):** admin opens KeyPanel → enters a
  fresh ≥ 32-char secret → confirms → verifies `secret-info` shows
  `hasPrev: true, source: file` and the session survives (stats reload 200).
  A second rotation evicts the first generation from the grace window, killing
  any tokens stolen before the first rotation. Deactivate the affected account
  as well for immediate kill (one request).
- **Residual risk:** 12h window — a stolen token stays valid until the next
  rotation/expiry unless the account is deactivated. No refresh-token rotation
  (deliberate: short-lived bearer + re-login keeps the design boring).
  Accepted.

## G. Fresh-install default admin (found cycle 47)

- **Status: MITIGATED.** New DBs seeded `admin/admin123`. Now seeded with
  `must_change=1`, and the rotation gate (authMiddleware) 403s every guarded
  route for admin/press logins until `POST /auth/change-password` clears it —
  login itself stays open so rotation is possible. Deploys must still rotate
  immediately; `npm run demo` creds are throwaway-only.
- **Residual risk:** the well-known password exists until first rotation.
  Accepted: fail-closed gate makes it single-use.

## H. Credential caching + framing/sniffing (found cycle 47)

- **Status: MITIGATED.** `Cache-Control: no-store` now covers `/api/auth/`,
  `/api/cards`, `/api/me/`, `/api/holders` (tempPassword mint), `/api/users`
  (account creds), `POST /api/verify`. Backend also sends
  `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer`; nginx
  adds `X-Frame-Options: DENY` + the same two.
- **Residual risk:** none noted; static API (JSON only) has no framing surface.

## I. Weak temp passwords via Math.random (found cycle 47)

- **Status: MITIGATED.** Press temp passwords now come from
  `crypto.randomBytes(9)` (72 bits, base64url) + usernames carry 24 random bits;
  `bcrypt` cost unchanged. User-create enforces ≥ 8 chars (parity with
  change-password).
- **Residual risk:** 72-bit one-time creds are brute-forceable in theory;
  must_change gating + 10-fail login limiter make online guessing infeasible.

## J. Replacement-chain fork (found cycle 47)

- **Status: MITIGATED.** Partial unique index
  `idx_cards_replaces(replaces_id) WHERE replaces_id IS NOT NULL` + pre-check
  → second replacement of the same card gets 409 `{replacedBy}`.
- **Residual risk:** none; chains stay linear.

## K. Last-admin lockout (found cycle 47)

- **Status: MITIGATED.** `PATCH /users/:id/active` 403s deactivating the last
  active admin; unknown ids 404 before any write (no phantom audit); `active`
  must be boolean (no truthy-string deactivation).
- **Residual risk:** a sole admin who loses their password needs DB access to
  recover. Accepted (documented in DRILL runbook scope).
