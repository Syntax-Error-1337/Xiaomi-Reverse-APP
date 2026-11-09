# PressID Frontend

React UI for the PressID credential registry. Runs against the backend at `http://localhost:4000/api` (override with `VITE_API_URL`).

## Install & run

```bash
npm install
npm run dev      # dev server, default http://localhost:5173
npm run build    # production build
npm run preview -- --port 5173
```

## Role flows

- **Login** (`/login`): username + password → session in `localStorage` (`pressid_token`, `pressid_user`), redirect by role. On `localhost`/`127.0.0.1` only, a demo-creds hint shows below the form; hidden in prod. Links to public `/offline`.
- **Admin** (`/admin`, `ErrorBoundary`-wrapped): registry stat tiles (incl. `alertsOpen` inbox count), signing-key panel (`KeyPanel`: key-info + rotate with confirm, bundle download, audit-chain status), create issuer/police accounts, activate/deactivate toggle, per-user quota editor, recent-scans table with triage ack/resolve buttons + open-only filter, CSV export with optional card-ID filter + 429 retry, audit trail + chain-verify with 429 retry, change-password form (`ChangePassword`).
- **Issuer** (`/issuer`, `ErrorBoundary`-wrapped): register holders, upload holder photos (JPEG/PNG, downscaled to 480px client-side, ≤700KB), issue cards (QR + token shown; optional event name/end + zones; `replacesId` replacement flow for terminal cards with replacing banner, holder lock, `replaces`/`replaced_by` lineage chips, `replaced_link` notice), revoke cards, search/filter by name, org, or card ID.
- **Police** (`/police`, `ErrorBoundary`-wrapped): paste token + lat/lng (or "Use my location"), VALID/INVALID verdict with reason explainers (incl. `CARD_REPORTED`, `EVENT_ACTIVE` duty chip with event name/end, note chips for `UNKNOWN_ZONE`/`DUPLICATE_SCAN`/`EVENT_ACTIVE`/`FIRST_SCAN_LATE`/`SAME_POST_RESCAN` pass-back), holder box (photo chip + voluntary "holder device on file" `holderCheckedIn` chip, informational only), clone alerts in red, last-5-scans table, scan-trail map + timeline lookup by card ID (rows carry a "checked by {zone} post" badge from `officerZone`), 429 countdown chip + manual retry. "Scan with camera" (`ScanCamera`: `getUserMedia` + `window.BarcodeDetector` `qr_code`); on unsupported browsers shows a fallback message and paste-token stays the path.
- **Police scan-upgrade**: `ScanCamera` continuous loop (~600ms `detect()` until first decode, auto-stop, "Scan next" re-arms; single-capture fallback kept), torch toggle + 1–3x zoom slider only when `getCapabilities` reports them, upload-photo fallback (file → canvas → same detect path). Verdict shows risk panel (score bar 0–100 + low/watch/high badge + driver chips, overrides nothing) above reasons. `SAME_POST_RESCAN` is a flag with pass-back explainer. Holder photo pane (`GET /holders/:id/photo` as authed blob → objectURL, hidden on 404; "hold card photo next to holder"). Offline queue in `localStorage pressid-scan-queue` with provisional crypto verdict (shared `src/offlineCrypto.js` extracted from `OfflineVerify.jsx`) + oldest-first auto-flush on `online` with 429 backoff and manual Flush. New print-hidden surfaces: `.risk-panel`, `.photo-compare`.
- **Press** (`/press`, `ErrorBoundary`-wrapped): my cards grid, large QR view + token with copy button (clipboard + select fallback), voluntary device check-in section (`pressid-device` UUID in `localStorage` → `POST /me/check-in`, "device on file since" status line; printed cards work either way), my-scans self-detect table (with "checked by {zone} post" column from `officerZone`), report-loss button (freezes card → `reported`, terminal like revoked), must-change-password banner, change-password form (`ChangePassword`). Print stylesheet isolates the ID card.

## Offline verify + PWA

- **Offline verify** (`/offline`, public, no login; linked from login as "Verify offline"): upload `bundle.json` once (admin downloads it from the KeyPanel "Download verify bundle" button → `GET /admin/verify-bundle` → cached in `localStorage` as `pressid-bundle`), then paste a `P1.…` token. Verification is pure client-side via `crypto.subtle` Ed25519; shows payload fields + OK/FAIL plus a "signature only — confirm revocation/expiry online" warning. Works in airplane mode after the bundle + app shell are cached.
- **Installable PWA**: `public/manifest.webmanifest` (name PressID, `start_url /`, `display standalone`, icons reuse `favicon.svg` for 192+512 `purpose any`), `public/sw.js` (cache-first app shell `/`, `/index.html`, `favicon.svg`, manifest; `activate` purges old caches; `/api*` requests pass straight through to network; navigations fall back to cached `index.html`), manifest/theme-color/apple-touch-icon links in `index.html`, service worker registered from `main.jsx` in production builds only (plus global error listeners). `main.jsx` dispatches `pressid-sw-update` when an installing/waiting worker appears; `App.jsx` shows a print-hidden `role=status` banner ("New version available — Refresh" / Hindi equivalent) with a reload button.

## Tests

```bash
npm test   # node --test test/ — 22 static regression tests (i18n keys, setter audit, routes, handlers, dialogs, tables, SW lifecycle, zero deps)
```
