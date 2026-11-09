import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'database.dart';

/// Cache over the PUBLIC miot-spec.org API (verified 2026-10-14: no auth,
/// `status=released` instance lists, per-URN full spec JSON).
///
/// Flow: `model -> instances?status=released&type=<device-type>` is too broad
/// to scan per lookup, so resolution is two-step:
///  1. `resolveUrn(model)`: exact-model match against a cached model->URN map
///     (built by `refreshModelIndex`, stored in `_meta` + `specs` URNs).
///  2. `fetchSpec(urn)`: GETs the full instance JSON, stores it in `specs`.
///
/// Offline-first: cached rows serve forever; refresh failures never evict.
class SpecCache {
  SpecCache(this.store, {http.Client? client})
      : client = client ?? http.Client();

  final Store store;
  final http.Client client;

  static const _instancesHost = 'miot-spec.org';
  static const _metaIndexKey = 'spec.model_index_ts';
  static const _metaIndexJson = 'spec.model_index';

  /// model -> URN for every known instance. Refreshed nightly by the server;
  /// ~16k outlet instances alone, so paginate by device type.
  Future<int> refreshModelIndex({List<String>? types}) async {
    types ??= await deviceTypes();
    var count = 0;
    final index = <String, String>{};
    for (final type in types) {
      final uri = Uri.https(_instancesHost, '/miot-spec-v2/instances',
          {'status': 'released', 'type': type});
      final resp = await client.get(uri);
      if (resp.statusCode != 200) continue;
      final body = jsonDecode(resp.body) as Map<String, dynamic>;
      for (final inst in (body['instances'] as List? ?? const [])) {
        final m = inst as Map<String, dynamic>;
        final model = m['model'] as String?;
        final urn = m['type'] as String?;
        if (model != null && urn != null) {
          index[model] = urn;
          count++;
        }
      }
    }
    store.metaSet(_metaIndexJson, jsonEncode(index));
    store.metaSet(_metaIndexKey, DateTime.now().toIso8601String());
    return count;
  }

  Future<List<String>> deviceTypes() async {
    final uri = Uri.https(_instancesHost, '/miot-spec-v2/spec/devices');
    final resp = await client.get(uri);
    if (resp.statusCode != 200) {
      throw StateError('miot-spec.org unreachable (${resp.statusCode})');
    }
    final body = jsonDecode(resp.body) as Map<String, dynamic>;
    return List<String>.from(body['types'] as List);
  }

  Map<String, String> _modelIndex() {
    final raw = store.metaGet(_metaIndexJson);
    if (raw == null) return {};
    return Map<String, String>.from(jsonDecode(raw) as Map);
  }

  String? resolveUrn(String model) => _modelIndex()[model];

  /// Full cached spec for [model], or null when unknown/offline and uncached.
  /// Pass `refresh: true` to re-fetch even when cached.
  Future<Map<String, dynamic>?> specFor(String model,
      {bool refresh = false}) async {
    if (!refresh) {
      final rows =
          store.query('SELECT spec_json FROM specs WHERE model = ?', [model]);
      if (rows.isNotEmpty) {
        return jsonDecode(rows.first['spec_json'] as String)
            as Map<String, dynamic>;
      }
    }
    final urn = resolveUrn(model);
    if (urn == null) return null;
    return fetchSpec(model, urn);
  }

  Future<Map<String, dynamic>?> fetchSpec(String model, String urn) async {
    final uri = Uri.https(
        _instancesHost, '/miot-spec-v2/instance', {'type': urn});
    final resp = await client.get(uri);
    if (resp.statusCode != 200) {
      // Serve stale cache rather than failing offline.
      final rows =
          store.query('SELECT spec_json FROM specs WHERE model = ?', [model]);
      return rows.isEmpty
          ? null
          : jsonDecode(rows.first['spec_json'] as String)
              as Map<String, dynamic>;
    }
    final spec = jsonDecode(resp.body) as Map<String, dynamic>;
    store.execute(
      'INSERT INTO specs (model, urn, spec_json, fetched_at) VALUES (?, ?, ?, ?) '
      'ON CONFLICT(model) DO UPDATE SET urn = excluded.urn, '
      'spec_json = excluded.spec_json, fetched_at = excluded.fetched_at',
      [model, urn, resp.body, DateTime.now().millisecondsSinceEpoch],
    );
    return spec;
  }

  /// Minimal local-plugin projection the Flutter app consumes when it cannot
  /// reach this server: services with siid/name + readable/writable props.
  /// Mirrors `LocalSpec` in the app (`openhome/lib/models/device.dart`).
  static Map<String, dynamic> toLocalSpec(
      String model, Map<String, dynamic> full) {
    final services = <Map<String, dynamic>>[];
    for (final s in (full['services'] as List? ?? const [])) {
      final sm = s as Map<String, dynamic>;
      final props = <Map<String, dynamic>>[];
      for (final p in (sm['properties'] as List? ?? const [])) {
        final pm = p as Map<String, dynamic>;
        props.add({
          'siid': sm['iid'],
          'piid': pm['iid'],
          'name': pm['description'] ?? pm['type'],
          'format': pm['format'] ?? 'string',
          'access': pm['access'] ?? const ['read'],
          if (pm['unit'] != null) 'unit': pm['unit'],
          if (pm['value-list'] != null) 'value-list': pm['value-list'],
          if (pm['value-range'] != null) 'value-range': pm['value-range'],
        });
      }
      services.add({
        'siid': sm['iid'],
        'name': sm['description'] ?? sm['type'],
        'properties': props,
      });
    }
    return {'model': model, 'services': services};
  }
}
