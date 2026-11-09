# PressID protest-day readiness drill

Throwaway end-to-end check: spins a temp backend (`/tmp/drill.db`,
`/tmp/drill-keys`, port 4100) and scripts a full protest scenario — issue
event pass → checkpoint verify → clone flag → triage → lost-card freeze →
audit verify. Server is killed and throwaways removed on exit.

## Run

```bash
cd backend && ./scripts/drill.sh [port]   # default 4100; refuses if the port is live
```

Needs `curl` + `node` only. Prints `PASS`/`FAIL` per step (10 steps);
exit code is non-zero on any failure. Steps:

1. admin login → 2. issuer login → 3. issue event card (`Demo Bandh`,
   zones `north`, end now+48h) → 4. police verify `valid:true` +
   `EVENT_ACTIVE` → 5. far scan (Delhi then Mumbai) → 6. `SIMULTANEOUS_FAR`
   flag → 7. admin triage ack → 8. press report-loss → 9. verify now
   `CARD_REPORTED` (invalid) → 10. `GET /audit/verify` ok.

## Readiness checklist (before protest day)

- [ ] `JWT_SECRET` set (no `ALLOW_DEV_SECRET=1` in prod), admin password rotated off `admin123`.
- [ ] Keys backed up: `./scripts/backup.sh` → tarball in `backend/backups/`; bundle downloaded (`GET /api/admin/verify-bundle`) for offline checkpoints.
- [ ] Rotation sanity: `GET /api/admin/key-info` shows expected `currentKid`; old tokens still verify (`.prev` fallback).
- [ ] Bundle downloaded + offline CLI tested (`node scripts/offline-verify.js`).
- [ ] Issuer quotas set (`PATCH /users/:id/quota`) for expected headcount.
- [ ] Triage inbox empty: `GET /stats` → `alertsOpen: 0`.
- [ ] Chain verify ok: `GET /api/audit/verify` → `{ok:true}`.
- [ ] Drill green: `./scripts/drill.sh` → 10/10 PASS.

## Protest-day runbook

1. **Issue event passes** — issuer: `POST /api/holders` (creates press login),
   then `POST /api/cards {holderId, zones, eventName, eventEnd}`. Event name
   requires zones; `eventEnd` must be ISO. Confirm `GET /api/cards` shows
   `eventName`/`eventEnd`.
2. **Checkpoint verify** — police: `POST /api/verify {token, lat, lng}`.
   `valid:true` + `EVENT_ACTIVE` = clear. Blocking codes (`REVOKED`,
   `CARD_REPORTED`, `STATUS_EXPIRED`, `OUT_OF_ZONE`, `TAMPER_MISMATCH`) = hold.
   No connectivity? Offline signature check only (`offline-verify.js`), then
   confirm status online — a valid offline signature alone is NOT clearance.
3. **Triage flags** — admin `/admin` scans panel (or `GET /api/scans`):
   `IMPOSSIBLE_TRAVEL` / `SIMULTANEOUS_FAR` / `VELOCITY_BURST` mean possible
   cloning. `PATCH /api/scans/:id/triage {acked|resolved}`; watch
   `alertsOpen` in `GET /stats` back to 0.
4. **Replace lost cards** — press: `POST /api/me/report-loss {cardId}`
   freezes the card (`CARD_REPORTED`, terminal). Issuer re-issues with
   `POST /api/cards {replacesId}` (inherits holder/zones/event; audit
   `card.replace` keeps lineage). Verify the old token now fails.
