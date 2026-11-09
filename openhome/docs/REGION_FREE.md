# Region-free guarantee

Any-region IoT devices work in OpenHome because the region lock lives
entirely in layers we did not rebuild. Evidence below is all observed from
`com.xiaomi.mihome_11.8.203_und3fined.ipa` unless marked [INFERENCE].

## Where the original app locks regions (observed)

1. **Account-country → server shard.** `MHEnvConfig.framework` (Swift) exposes
   `DomainItem{normal, core, originHost, serverCode}` +
   `refreshInfoWithServerCode:`; the main binary has `serverCodeFromCountryCode:`,
   `setUserId:countryCode:serverCode:isGrayUser:`, `countryEntitiesByServerCode:`,
   `_preferedServerCode`, and `/v2/product/region_info`. A CN-account device is
   registered on the CN shard; a DE/SG/US-account app talks to another shard
   and never sees it. `isChina*` helpers (`isChinaMainland`, `isChinaCountryCode`,
   …) plus `isCurRegionSupported` / `isNotSupportModel` gate UI per shard.
2. **CN-only model strings.** Observed verbatim: "This poduct is only userd in
   mainland China", "your device is only available in Mainland China…".
3. **Cloud relay is shard-scoped.** `/v2/device/*`, `/v2/home/*`,
   `/v2/homeroom/*`, `/v2/scene/*` all resolve against the account's shard;
   cross-shard devices are invisible even when on the same LAN, because
   control flows phone → shard → device, not phone → device.
4. **The LAN protocol has NO region input.** miIO framing is
   `magic/len/did/ts/md5/AES-CBC` — key `md5(token)`, device-clock-relative
   timestamps. The only `*region*` strings near comms are iOS geofence
   (`CLLocationManager didEnterRegion`), camera VIP (`getVIPDaysWithDid:region:`),
   and detection-region tips — none consulted by discovery/handshake/encrypt.
   [INFERENCE] A CN-sold plug and an EU-sold plug with the same token answer
   identical HELLO/`miIO.info` bytes; nothing in the framing can distinguish
   them.

## Why OpenHome is region-free by construction

- **No account, no shard.** `openhome-server` issues local bearer tokens;
   `devices` table has no country/shard column (pinned by
   `test/region_free_test.dart` schema test).
- **Direct LAN control.** Phone/server → device over UDP 54321. No relay host
   exists to scope by region.
- **Specs are global.** `miot-spec.org` serves every vendor's instances
   without auth (15,955 outlet instances incl. `chuangmi.*`, verified live);
   the server caches by exact model string — CN-vendor models take the same
   code path as all others.
- **No geo symbols in code.** `test/region_free_test.dart` (app + server)
   fails the build if `region|country|locale|serverCode|isChina|oversea|…`
   appears in non-comment source, and proves identical packets for identical
   (token, did, stamp) regardless of device origin.

## What to tell users

"Add any Mi Home-compatible device with its IP + 32-hex token, whatever
country it was sold in. If the original app says 'only available in Mainland
China', that is Xiaomi's account-shard policy — OpenHome never contacts
Xiaomi's servers, so the policy has nothing to enforce against."
Use `miiocli` (python-miio) against your own LAN/account to obtain tokens;
tokens never leave your network.
