/// OpenHome server: your own smart-home server.
///
/// Replaces the Xiaomi-cloud pieces a local app actually needs, grounded in
/// the Mi Home 11.8.203 RE (see `../openhome/docs/RE_FINDINGS.md`):
///
/// * Identity: Xiaomi uses `account.xiaomi.com` OAuth + device binding to
///   THEIR accounts — not clonable, and deliberately not cloned. This server
///   issues its own local accounts + bearer tokens.
/// * Device relay: Xiaomi's `/v2/device/*`, `/v2/home/*`, `/v2/scene/*` are
///   account-gated and request-signed. Instead the server executes MIOT
///   commands directly on your LAN (same protocol as the Flutter app).
/// * Specs: `miot-spec.org` is PUBLIC (no auth). The server caches
///   model -> URN -> full spec JSON in SQLite with nightly refresh, so your
///   whole home keeps working offline and any LAN client can fetch specs.
library openhome_server;

export 'src/database.dart';
export 'src/spec_cache.dart';
export 'src/auth.dart';
export 'src/api.dart';
