import 'dart:convert';
import 'dart:typed_data';

/// Stored device credential. The token is the 16-byte AES key material shown
/// as 32 hex chars by extraction tools (see README). It never leaves the LAN.
class DeviceEntry {
  DeviceEntry({
    required this.id,
    required this.name,
    required this.ip,
    required this.tokenHex,
    this.model,
    this.deviceId,
  });

  final String id;
  String name;
  String ip;
  String tokenHex;
  String? model;
  int? deviceId;

  Uint8List get token {
    final clean =
        tokenHex.replaceAll(RegExp(r'[^0-9a-fA-F]'), '');
    if (clean.length != 32) {
      throw FormatException('token must be 32 hex chars');
    }
    final out = Uint8List(16);
    for (var i = 0; i < 16; i++) {
      out[i] = int.parse(clean.substring(i * 2, i * 2 + 2), radix: 16);
    }
    return out;
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'ip': ip,
        'tokenHex': tokenHex,
        'model': model,
        'deviceId': deviceId,
      };

  factory DeviceEntry.fromJson(Map<String, dynamic> json) => DeviceEntry(
        id: json['id'] as String,
        name: json['name'] as String,
        ip: json['ip'] as String,
        tokenHex: json['tokenHex'] as String,
        model: json['model'] as String?,
        deviceId: (json['deviceId'] as num?)?.toInt(),
      );

  String encode() => jsonEncode(toJson());

  factory DeviceEntry.decode(String raw) =>
      DeviceEntry.fromJson(jsonDecode(raw) as Map<String, dynamic>);
}

/// MIOT property descriptor from a local spec file (`assets/specs/[model].json`).
class MiotProperty {
  MiotProperty({
    required this.siid,
    required this.piid,
    required this.name,
    required this.format,
    required this.access,
    this.unit,
    this.valueList,
    this.valueRange,
  });

  final int siid;
  final int piid;
  final String name;
  final String format;
  final List<String> access;
  final String? unit;
  final List<Map<String, dynamic>>? valueList;
  final List<num>? valueRange;

  bool get readable => access.contains('read');
  bool get writable => access.contains('write');

  factory MiotProperty.fromJson(Map<String, dynamic> json) => MiotProperty(
        siid: json['siid'] as int,
        piid: json['piid'] as int,
        name: json['name'] as String? ?? 'prop',
        format: json['format'] as String? ?? 'string',
        access: List<String>.from(json['access'] as List? ?? const ['read']),
        unit: json['unit'] as String?,
        valueList: (json['value-list'] as List?)
            ?.map((e) => Map<String, dynamic>.from(e as Map))
            .toList(),
        valueRange: (json['value-range'] as List?)
            ?.map((e) => e as num)
            .toList(),
      );
}

/// MIOT service grouping from a local spec file.
class MiotService {
  MiotService({required this.siid, required this.name, required this.props});

  final int siid;
  final String name;
  final List<MiotProperty> props;

  factory MiotService.fromJson(Map<String, dynamic> json) => MiotService(
        siid: json['siid'] as int,
        name: json['name'] as String? ?? 'service',
        props: ((json['properties'] as List?) ?? const [])
            .map((e) => MiotProperty.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

/// Local replacement for the app's server-driven device plugins
/// (RE_FINDINGS §3: official plugins download per-device from Xiaomi cloud).
/// Ship one JSON per model under `assets/specs/` (one file per model):
/// `{"model": "...", "services": [{"siid": 2, "name": "...",
/// "properties": [{"siid": 2, "piid": 1, "name": "on", "format": "bool",
/// "access": ["read", "write"]}]}]}`. Property reads/writes not covered by a
/// spec still work through the raw console.
class LocalSpec {
  LocalSpec({required this.model, required this.services});

  final String model;
  final List<MiotService> services;

  factory LocalSpec.fromJson(Map<String, dynamic> json) => LocalSpec(
        model: json['model'] as String? ?? 'unknown',
        services: ((json['services'] as List?) ?? const [])
            .map((e) => MiotService.fromJson(e as Map<String, dynamic>))
            .toList(),
      );

  MiotProperty? lookup(int siid, int piid) {
    for (final s in services) {
      if (s.siid != siid) continue;
      for (final p in s.props) {
        if (p.piid == piid) return p;
      }
    }
    return null;
  }
}
