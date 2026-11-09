# OpenHome — open local client for Xiaomi smart-home devices

Rebuilt from reverse-engineering Mi Home iOS 11.8.203 (`com.xiaomi.mihome`).
See [`docs/RE_FINDINGS.md`](docs/RE_FINDINGS.md) for the evidence. OpenHome
reimplements only the **local device-control core** over the open miIO/MIOT
UDP protocols — no Xiaomi account, cloud, or server-driven bundles.

## What it does (v0)

- LAN discovery via miIO HELLO broadcast (UDP 54321).
- Manual onboarding: IP + 32-hex-char device token (extract yours with
  [python-miio](https://pypi.org/project/python-miio/) — e.g. `miiocli` —
  from your own backup/account; tokens never leave your network).
- Device info (`miIO.info`), MIOT `get/set_properties`, `action`, legacy
  `get_prop`, and a raw JSON-RPC console for any other method.
- Local persistence of the device list (`shared_preferences`).

## Non-goals

Xiaomi cloud/account auth, shop/commerce bundles, official per-device plugins,
push, Siri, Matter commissioning. Tokens are stored in app-local preferences;
for a hardened build move them to the platform keychain.

## Run

```bash
flutter pub get
flutter analyze
flutter test
flutter run
```

iOS needs the local-network permission (`NSLocalNetworkUsageDescription`,
already added in `ios/Runner/Info.plist`) or discovery silently finds nothing.

## Protocol notes (grounded in python-miio behavior)

- HELLO: `21 31 00 20` + 12×`FF` (unknown/did/ts) + 16×`FF` checksum.
- Packet: `magic u16, len u16, unknown u32 = 0, did u32, ts u32, md5(header‖token‖ciphertext) u128`,
  payload AES-128-CBC, key = `md5(token)`, iv = `md5(key‖token)`, PKCS7.
- Timestamp is device-clock-relative: handshake stores `ts`, later packets use
  `ts + elapsed`.
