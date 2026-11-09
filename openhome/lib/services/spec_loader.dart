import 'dart:convert';

import 'package:flutter/services.dart';

import '../models/device.dart';
import 'server_client.dart';

/// Spec resolution order:
///   1. YOUR server's cache (`GET /api/specs/:model/local`) — full upstream
///      spec, works for any model the server has seen, even ones with no
///      bundled file.
///   2. Bundled `assets/specs/*.json` — offline fallback.
///   3. null — raw console + info still work.
///
/// Slashes/colons in model URNs map to underscores
/// (`urn:...:chuangmi.plug.v3` -> `chuangmi.plug.v3.json`).
///
/// Region-free by construction: neither the server lookup nor the bundled
/// fallback consults any country/server/region value. See
/// `docs/REGION_FREE.md` for the evidence.
Future<LocalSpec?> loadSpec(String? model, {ServerClient? server}) async {
  if (model == null || model.isEmpty) return null;
  if (server != null && server.reachable) {
    final remote = await server.localSpec(model);
    if (remote != null) return remote;
  }
  final base = model.split(':').last.replaceAll('/', '_');
  for (final candidate in ['$base.json', '${base.toLowerCase()}.json']) {
    try {
      final raw = await rootBundle.loadString('assets/specs/$candidate');
      return LocalSpec.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      // Missing asset throws FlutterError (an Error, not Exception);
      // any load/parse failure just means "no bundled spec".
      continue;
    }
  }
  return null;
}
