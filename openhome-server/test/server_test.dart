import 'dart:convert';
import 'dart:typed_data';

import 'package:openhome_server/src/api.dart';
import 'package:openhome_server/src/auth.dart';
import 'package:openhome_server/src/database.dart';
import 'package:openhome_server/src/scene_runner.dart';
import 'package:openhome_server/src/spec_cache.dart';
import 'package:http/http.dart' as http;
import 'package:shelf/shelf.dart';
import 'package:test/test.dart';

/// FIPS-197 Appendix B AES-128-CBC vector, exercised through the packet
/// layer: encrypt a 16-byte payload with the token-derived key/iv and
/// compare against pointycastle-independent expectations is overkill —
/// instead pin the KNOWN-ANSWER ciphertext for a fixed token/payload so any
/// future crypto swap breaks loudly.
Uint8List _hex(String s) {
  final out = Uint8List(s.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(s.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

void main() {
  group('MiioPacket (server)', () {
    final token = _hex('00112233445566778899aabbccddeeff');

    test('hello shape', () {
      final h = MiioPacket.hello();
      expect(h.length, 32);
      expect(ByteData.sublistView(h).getUint16(0), 0x2131);
      expect(h.sublist(16), everyElement(0xFF));
    });

    test('round-trip incl. multi-block', () {
      final payload = Uint8List.fromList(List.generate(200, (i) => i & 0xFF));
      final pkt = MiioPacket.encrypt(payload, token,
          deviceId: 7, timestamp: 9);
      expect(MiioPacket.decrypt(pkt, token), payload);
      expect(MiioPacket.deviceIdOf(pkt), 7);
      expect(MiioPacket.timestampOf(pkt), 9);
    });

    test('known-answer ciphertext', () {
      // Pinned 2026-10-14 against pointycastle AESEngine. If this changes,
      // the wire format changed and real devices will reject packets.
      final payload = Uint8List.fromList(utf8.encode('0123456789abcdef'));
      final pkt = MiioPacket.encrypt(payload, token,
          deviceId: 0x01020304, timestamp: 0x05060708);
      expect(
          pkt.map((b) => b.toRadixString(16).padLeft(2, '0')).join(),
          '21310040000000000102030405060708'
          'b4521e067b08e0a7ca3c1d8b3e76d8f8'
          'ce6c659add94d49a13a40a1b3eb5c39'
          'ec5d0fcb8fe39dee43637d0a4aa36fac7');
    });

    test('rejects wrong token, bad magic, tamper', () {
      final pkt = MiioPacket.encrypt(Uint8List.fromList([1, 2, 3]),
          token, deviceId: 1, timestamp: 1);
      expect(() => MiioPacket.decrypt(pkt, Uint8List(16)),
          throwsA(isA<FormatException>()));
      final badMagic = Uint8List.fromList(pkt)..[0] = 0;
      expect(() => MiioPacket.decrypt(badMagic, token),
          throwsA(isA<FormatException>()));
      final tampered = Uint8List.fromList(pkt)..[40] ^= 1;
      expect(() => MiioPacket.decrypt(tampered, token),
          throwsA(isA<FormatException>()));
    });
  });

  group('Auth', () {
    test('bootstrap once, login, token round-trip', () {
      final store = Store.memory();
      final auth = Auth(store);
      final t0 = auth.bootstrap('admin', 'password123');
      expect(auth.userForToken(t0), isNotNull);
      expect(() => auth.bootstrap('x', 'password123'), throwsStateError);
      final t1 = auth.login('admin', 'password123');
      expect(t1, isNotNull);
      expect(auth.login('admin', 'wrong'), isNull);
      expect(auth.login('nobody', 'password123'), isNull);
      auth.revoke(t1!);
      expect(auth.userForToken(t1), isNull);
    });
  });

  group('API', () {
    Future<Map<String, dynamic>> call(Api api, String method, String path,
        {Map<String, dynamic>? body, String? token}) async {
      final req = Request(method, Uri.parse('http://x$path'),
          body: body == null ? null : jsonEncode(body),
          headers: {
            if (body != null) 'content-type': 'application/json',
            if (token != null) 'authorization': 'Bearer $token',
          });
      final resp = await api.router.call(req);
      return {
        'status': resp.statusCode,
        'body': jsonDecode(await resp.readAsString()),
      };
    }

    test('bootstrap -> devices -> scenes -> events -> backup', () async {
      final store = Store.memory();
      final auth = Auth(store);
      // Fake spec cache: no network in tests.
      final specs = SpecCache(store,
          client: _FailingClient());
      final api = Api(store, auth, specs);

      var r = await call(api, 'GET', '/api/devices');
      expect(r['status'], 401);

      r = await call(api, 'POST', '/api/bootstrap',
          body: {'username': 'a', 'password': 'short'});
      expect(r['status'], 400);

      r = await call(api, 'POST', '/api/bootstrap',
          body: {'username': 'admin', 'password': 'password123'});
      expect(r['status'], 200);
      final token = (r['body'] as Map)['token'] as String;

      r = await call(api, 'POST', '/api/devices',
          body: {'ip': '192.168.1.2', 'token': 'zz'},
          token: token);
      expect(r['status'], 400);

      r = await call(api, 'POST', '/api/devices',
          body: {
            'name': 'plug',
            'ip': '192.168.1.2',
            'token': '00' * 16,
            'model': 'chuangmi.plug.v3'
          },
          token: token);
      expect(r['status'], 200);
      final devId = (r['body'] as Map)['id'] as String;

      r = await call(api, 'GET', '/api/devices', token: token);
      expect((r['body'] as List).length, 1);

      r = await call(api, 'POST', '/api/scenes',
          body: {
            'name': 'off',
            'actions': [
              {'device': devId, 'op': 'set', 'siid': 2, 'piid': 1,
                'value': false}
            ]
          },
          token: token);
      expect(r['status'], 200);
      final sceneId = (r['body'] as Map)['id'] as String;

      r = await call(api, 'POST', '/api/scenes',
          body: {
            'name': 'bad',
            'actions': [
              {'device': devId, 'op': 'explode'}
            ]
          },
          token: token);
      expect(r['status'], 400);

      r = await call(api, 'POST', '/api/scenes/$sceneId/run', token: token);
      expect(r['status'], 200);

      r = await call(api, 'GET', '/api/events', token: token);
      expect((r['body'] as List).length, greaterThanOrEqualTo(2));

      r = await call(api, 'GET', '/api/backup', token: token);
      expect((r['body'] as Map)['devices'], hasLength(1));
    });
  });

  group('SpecCache.toLocalSpec', () {
    test('projects full spec to app shape', () {
      final local = SpecCache.toLocalSpec('chuangmi.plug.v3', {
        'services': [
          {
            'iid': 2,
            'description': 'switch',
            'properties': [
              {
                'iid': 1,
                'description': 'on',
                'format': 'bool',
                'access': ['read', 'write', 'notify'],
              },
              {
                'iid': 2,
                'description': 'power-consumption',
                'format': 'float',
                'unit': 'watt',
                'access': ['read'],
              }
            ]
          }
        ]
      });
      expect(local['model'], 'chuangmi.plug.v3');
      final props =
          (local['services'] as List).first['properties'] as List;
      expect(props.length, 2);
      expect(props.first['siid'], 2);
      expect(props.first['piid'], 1);
      expect(props.first['format'], 'bool');
      expect(props.last['unit'], 'watt');
    });
  });
}

// HTTP client that fails every request: keeps API tests hermetic.
class _FailingClient extends http.BaseClient {
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      Future.error(HttpExceptionF('offline'));
}

class HttpExceptionF implements Exception {
  const HttpExceptionF(this.message);
  final String message;
  @override
  String toString() => 'HttpExceptionF: $message';
}
