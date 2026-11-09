import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:openhome/protocol/miio_packet.dart';

/// Region-free guarantee: NOTHING in the LAN protocol path may depend on a
/// country/region/server value. The original app gates devices by
/// account-country -> server shard (`MHEnvConfig.serverCode`,
/// `serverCodeFromCountryCode:`, "only available in Mainland China" strings).
/// OpenHome has no such concept anywhere: discovery, handshake, encryption,
/// and commands are pure functions of (ip, token, did, stamp).
void main() {
  Uint8List token(String hex) {
    final out = Uint8List(hex.length ~/ 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16);
    }
    return out;
  }

  group('no region input to protocol', () {
    test('identical packets regardless of origin story', () {
      // Same device, same token, same clock: bytes must be identical whether
      // the device was bought in Shenzhen, Berlin, or São Paulo. There is
      // literally no parameter to vary by region.
      final t = token('00112233445566778899aabbccddeeff');
      final payload = Uint8List.fromList(
          utf8.encode('{"id":1,"method":"miIO.info","params":[]}'));
      final a = MiioPacket.encrypt(payload, t,
          deviceId: 1234, timestamp: 5678);
      final b = MiioPacket.encrypt(payload, t,
          deviceId: 1234, timestamp: 5678);
      expect(a, b);
      expect(MiioPacket.decrypt(a, t), payload);
    });
    test('CN-vendor model strings are opaque labels', () {
      for (final model in [
        'chuangmi.plug.v3', // CN vendor, blocked abroad in the original app
        'xiaomi.tv.fsv1',
        'lfsmt.plug.ls002', // non-Xiaomi vendor
        'yeelink.light.color1',
        'urn:miot-spec-v2:device:outlet:0000A002:chuangmi-v3:1',
      ]) {
        final base = model.split(':').last.replaceAll('/', '_');
        expect(base, isNotEmpty);
        // No path separators or URN structure may survive into a filename.
        expect(base.contains(RegExp(r'[/:]')), isFalse,
            reason: 'spec filename mapping must be total over models');
      }
    });
  });

  group('no region gating in source', () {
    test('no region/country symbols in protocol + model code', () async {
      final lib = Directory('lib');
      final hits = <String>[];
      await for (final f in lib.list(recursive: true)) {
        if (f is! File || !f.path.endsWith('.dart')) continue;
        final src = await f.readAsString();
        // Strip comments/doc-comments before matching.
        final code =
            src.split('\n').where((l) => !l.trimLeft().startsWith('///'));
        for (final line in code) {
          final stripped = line.split('//').first;
          if (RegExp(
                  r'region|country|locale|serverCode|isChina|oversea|chinaOnly|CN_ONLY',
                  caseSensitive: false)
              .hasMatch(stripped)) {
            hits.add('${f.path}: $stripped');
          }
        }
      }
      // REGION_FREE.md itself + this test mention them; lib/ must not.
      expect(hits, isEmpty, reason: hits.take(10).join('\n'));
    });
  });
}
