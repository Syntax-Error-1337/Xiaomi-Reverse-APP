# Mi Home iOS 11.8.203 — Reverse-Engineering Findings

Target: `com.xiaomi.mihome_11.8.203_und3fined.ipa` (379.3 MB, 10,216 files).
REA evidence: `ev_15ebc2a0e3305acf6f3161e3c222d2957c724bdf0b1ed1528d1f2baa7139d406`
(confidence: `observed`), inspection `ai_2077…ab2d`. Root SHA-256
`bb709c7c6ab0edb51cf49262130447d432f0574d24835cb8a42246214a05c855`.
Graph: 5,274 nodes / 10,217 occurrences. Full JSON: `/tmp/rea-ipa-inventory.json`.

## 1. App identity (Info.plist, observed via `unzip -p`)

- `CFBundleIdentifier = com.xiaomi.mihome`, `CFBundleShortVersionString = 11.8.203`
  (build `11.8.203.304`), `MinimumOSVersion = 13.0`.
- URL schemes (observed; dump truncated mid-list, so PARTIAL): `mihome`, `mijia`,
  `mihomeoauth`, `mihomeappaccess`, `mishopbestpay`, `mishopuppay`,
  `qqmusic-mihome`, `prefs`, WeChat `wx54b959a68fb6f580`, Weibo `wb916875316`,
  Facebook `fb690839864422812`, `ml94803cd7370b24bf`, `amzn-com.xiaomi.mihome`.
- Background modes: `audio`, `bluetooth-central`, `location`,
  `remote-notification`, `nearby-interaction`.
- 19 usage descriptions, incl. Bluetooth always, location always/when-in-use,
  camera, microphone, local network, NFC, FaceID, HealthKit update/share,
  HomeKit, user tracking, nearby interaction.
- `NSAppTransportSecurity.NSAllowsArbitraryLoads = true` — cleartext HTTP
  permitted (matches `http://test-shop-api.retail.mi.com` inside shipped JS).
- Fonts: MiSansLatin family, DIN, Lanting GBK.

## 2. Native layout (`unzip -l` + REA inventory)

- Main Mach-O `Payload/MiHome.app/MiHome`: 187.9 MB, arm64 `MH_MAGIC_64`
  `EXECUTE`, 176 load commands.
- 10 `.appex` binaries + watch extension: device-status/scene/operation/desktop
  widgets, share extension, notification content/service, Siri `MiIntents` +
  `MiIntentsUI`, `MiHomeMatter` (26 MB, largest extension).
- ~29 framework binaries: `MJFCrypto`/`MJFNetwork`/`MJFJsonKit`/`MJFLog`,
  `MiHomeFoundation`, `MiHomeMediator`, `MHEnvironment`/`MHEnvConfig`,
  `AFNetworking`, `CocoaAsyncSocket`, `CocoaLumberjack`, `FMDB`,
  `YYCache`/`YYText`/`YYCategories`, `SDWebImage`, `Masonry`, `libpag`,
  `libwebp`, `UnityFramework` (3D — `MiHome3D.bundle` present),
  `AIVSClientSDK` + `libvoiceconvert` (voice), `FBLPromises`, zip trio,
  `MHOpenUDID`.
- CoreData model: `database.momd`. `mfp.cer` ships under `WeiboSDK.bundle`
  (third-party pinning material — no Xiaomi-API `.cer` observed).
- Observed absences (listing greps): no `.proto`, `.sqlite`, `.mlmodel`,
  `.jsbundle`. ~40+ `.lproj` locales. `Watch/MiHomeWatch.app` + extension.
- `Payload/decrypt.day` + `_und3fined` filename + re-sign dates 09-20/26-2026
  → decrypted/repackaged sideload build. Binary is unencrypted (good for
  follow-up Hopper/Ghidra work).

## 3. Server-driven RN layer (`MSSForMJ.bundle`) — observed, not guessed

- Per-module manifests (`moduleId`, `version`, `buildNum`, `makeTime`, `urlmd5`,
  `maxNativeApiLevel`, `maxCommonJSApiLevel`, `urlcdn`, `residentMemory`,
  `updateType`): home 11.166.24, common 10.272.15, mstd 11.209.34,
  msusr 11.204.8, dghd 11.212.21, search 11.97.5, chat 11.190.29,
  servicetab 11.218.9, service 11.218.11, live 10.225.4, crowdfunding 11.204.22.
- CDN pattern:
  `https://res.youpin.mi-img.com/bundle/rn/product/com-xiaomi-shop-smarthome/<module>/<id>/skytree/<module>.ios.tar.zip`
  — downloaded bundles overlay shipped copies (`updateType` 2/3).
- Inner tar = `index.ios.bundle` + `res/` + `buz.config.json`
  (`moduleIDPrefix: hm`, `SDKVersion: 610`, `YRN_BUNDLE_MD5`,
  `maxNativeApiLevel: 4`, `maxCommonJSApiLevel: 6`).
- `index.ios.bundle` is Metro-style JS (`__d`/`__r` module registry,
  `__yrn_options__` sandbox flags, ErrorUtils, timer polyfills) = Xiaomi "YRN"
  runtime ([INFERENCE] YRN = Youpin RN fork, from `__yrn_` prefix + youpin
  hosts). Native bridge: `BSLAppInterface` (`iRequest`/`iHost`/`iNotify`/
  `iCookie`/`iAuth`) + `CommonBridgeModule`.
- Shipped content is Mi SHOP commerce ("小米商城首页", hosts
  `m.xiaomiyoupin.com`, APIs `/mtop/mf/home/mihome/v1/index|feed`) — the
  storefront tab, not device control.
- `msnr2UrlMap.json`: `/msnr/*` → `/mfbs/*` rewrites plus force-redirects
  (finance `jr.mi.com`, signed mishop pages). `sdkAction2UrlMap.json`:
  `ShopPlugin://…Fragment` → `/mfbs/<module>/<page>` with `nApiL`/`jsApiL`
  bridge levels — the native↔RN routing table.
- Per-device control plugins are NOT in the IPA (only shop modules ship) →
  [INFERENCE] device plugins download per-device from cloud at runtime, so a
  local-control rebuild must target the miIO/MIOT protocols, not these bundles.

## 4. Cloud API surface (binary `strings`, observed)

- Hosts: `home.mi.com` (59 refs), `account.xiaomi.com` (25),
  `g.home.mi.com` (10), `camera.api.io.mi.com`, `cdn.eco.mi.com`,
  `i.ai.mi.com`, FDS storage endpoints, `jpush.cn` (push).
- Device/home/scene paths (selected): `/v2/device/batch_set_props`,
  `/v2/device/batchgetdatas`, `/v2/device/ble_*` (mesh bind/provision),
  `/v2/home/home_device_list`, `/v2/home/local_device_list`,
  `/v2/home/device_list_page`, `/v2/homeroom/*` (rooms/members/invites),
  `/v2/miotspec/action`, `/v2/miotspec/devicelist`,
  `/v2/scene/get_sceneinfo_by_usid`, `/v2/aiot/get_iot_devices`,
  `/v2/message/*` (alerts/notices), `/v2/share/*`, `/v2/auth/*`.
- Spec traffic confirmed native-side: `miotspec` (9), `miot-spec` (7),
  `MIOTSpecManager`, `MiotSpecProfile`, `pullAllSupportMiotspecMapper`.
- Verdict per subsystem: account/OAuth + relay are account-gated and signed
  (NOT clonable); `miot-spec.org` is public, no auth (verified live:
  203 device types, 15,955 outlet instances, model→URN→full JSON).
  → The self-hosted server (`../openhome-server`) replaces identity with
  local accounts, relay with LAN MIOT execution, and spec hosting with a
  nightly-cached proxy. Shop bundles, push, Siri, Matter, share flows are
  out of scope (server-owned / vendor-gated).

## 5. Rebuild scope decision

BUILD (this repo, local-first): LAN discovery (miIO HELLO), token-authed UDP
control (miIO `get_prop`/`miIO.info` + MIOT `get/set_properties`/`action`),
MIOT-spec-typed models, manual token onboarding, property inspector + raw
command console, device UI rendered from YOUR server's spec cache or LOCAL
spec JSON (never Xiaomi CDN).
NOT BUILDING: Xiaomi account/cloud auth, server-driven shop RN bundles,
official per-device plugins, push/Siri/Matter commissioning (entitlement-gated),
commerce/finance flows. Rationale: server-owned, account-bound, or
OS-entitlement-gated — not reimplementable as open source.
## 6. Nearby-device discovery (binary `strings`, observed 2026-10-14)

Trigger: `MHNearlyDistributeNetworkManager_startSearchBloothFromMainPage`
(the "Discover nearby devices" card). It drives three transports:

- **BLE (pairing devices):** `MiioBluetoothThread centralManagerStartSearch`
  → `centralManager:didDiscoverPeripheral:advertisementData:RSSI:` →
  `handleScanResponsePackage`, which parses BOTH
  `kCBAdvDataServiceData` (MiBeacon `0xFE95`, Wi-Fi combo provisioning
  `0x1A00`/`0x1A01`, accessory `0x30F1`–`0x30F7`, suitcase `0xF091`) AND
  `kCBAdvDataManufacturerData` (Xiaomi company id `0x038F`). Filters after
  parsing: `no btDeviceClass for deviceClass`, `not configured in
  DeviceConfig` (`isModelConnectable`), `version exceeds max MiBeacon
  version`. The scan itself is OPEN (`scanAllDeviceWithRule`,
  `startLeScan:serviceUUID:` with a broad list) — filtering to FE95-only
  misses combo devices advertising manufacturer-data-only adverts (e.g. a
  reset BOFON air control). OpenHome matches this: open scan + Dart-side
  `_classify` (`lib/services/ble_pairing_scan.dart`).
- **mDNS (LAN devices):** `MHCServiceDiscover` wraps `NSNetServiceBrowser`,
  browsing `_miio._udp.` (+ `_matterc._udp.` for Matter gateways) —
  `browser didFindService` → resolve → `netServiceDidResolveAddress`.
  This is why Mi Home lists LAN devices even when UDP broadcast is blocked:
  it never relies on broadcast alone. (OpenHome still uses HELLO
  broadcast + unicast sweep; mDNS browsing is a future upgrade.)
- **Combo provisioning:** `MHComboConnectManager startConnectDevice:ssid:
  bssid:password:bindkey:…` + `MHComboBindCommand` (auth mode 2, standard)
  performs the BLE Wi-Fi handoff — account-bound (`getBindKey`,
  `sharedSecret`), NOT reimplemented. OpenHome points users at Mi Home for
  this one step, then takes over on the LAN.


## 8. Open unknowns (follow-up RE)

Full URL-scheme list (plist dump truncated); device-plugin download
endpoint/format; native bridge method inventory (decrypted binary is ready for
a Hopper/Ghidra session); notification-service protocol; Matter flow.
