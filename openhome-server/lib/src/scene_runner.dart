import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:pointycastle/export.dart';

import 'database.dart';

/// Executes validated scene actions as MIOT commands on the LAN.
/// Wire format is identical to the Flutter app's `MiioPacket`
/// (`openhome/lib/protocol/miio_packet.dart`); AES-128-CBC via pointycastle,
/// md5 via package:crypto.
class SceneRunner {
  SceneRunner(this.store);

  final Store store;

  /// Runs scene [id] now. Returns per-action results. Throws [StateError]
  /// for unknown/disabled scenes.
  Future<List<Map<String, dynamic>>> run(String id) async {
    final rows = store.query('SELECT * FROM scenes WHERE id = ?', [id]);
    if (rows.isEmpty) throw StateError('no such scene');
    if ((rows.first['enabled'] as int) != 1) {
      throw StateError('scene disabled');
    }
    final actions = jsonDecode(rows.first['actions_json'] as String) as List;
    final results = <Map<String, dynamic>>[];
    for (final a in actions) {
      final m = a as Map<String, dynamic>;
      try {
        final value = await _exec(m);
        results.add({'ok': true, 'result': value});
      } catch (e) {
        results.add({'ok': false, 'error': '$e'});
      }
    }
    store.logEvent('scene.run',
        detail:
            '$id:${results.where((r) => r['ok'] == true).length}/${results.length} ok');
    return results;
  }

  Future<dynamic> _exec(Map<String, dynamic> action) async {
    final devRows = store.query(
        'SELECT * FROM devices WHERE id = ?', [action['device']]);
    if (devRows.isEmpty) throw StateError('unknown device');
    final dev = devRows.first;
    final session = MiioSession(
      ip: dev['ip'] as String,
      token: _hex(dev['token_hex'] as String),
    );
    await session.connect();
    final siid = action['siid'] as int;
    if (action['op'] == 'set') {
      return session.call('set_properties', [
        {'siid': siid, 'piid': action['piid'] as int, 'value': action['value']}
      ]);
    }
    return session.call('action', {
      'siid': siid,
      'aiid': action['aiid'] as int,
      'in': (action['args'] as List?) ?? [],
    });
  }

  static Uint8List _hex(String s) {
    final out = Uint8List(16);
    for (var i = 0; i < 16; i++) {
      out[i] = int.parse(s.substring(i * 2, i * 2 + 2), radix: 16);
    }
    return out;
  }
}

/// Minimal miIO UDP session (HELLO + JSON-RPC). Mirrors the app's
/// `MiioSession` semantics: device-clock-relative timestamps.
class MiioSession {
  MiioSession({required this.ip, required this.token});

  final String ip;
  final Uint8List token;
  int _id = 1;
  int? _did;
  int? _stampBase;
  DateTime? _stampEpoch;

  Future<void> connect() async {
    final sock = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
    try {
      sock.send(MiioPacket.hello(), InternetAddress(ip), MiioPacket.port);
      await for (final ev in sock.timeout(const Duration(seconds: 3))) {
        if (ev == RawSocketEvent.read) {
          Datagram? dg = sock.receive();
          while (dg != null) {
            if (dg.address.address == ip &&
                dg.data.length >= MiioPacket.headerLength) {
              final data = Uint8List.fromList(dg.data);
              _did = MiioPacket.deviceIdOf(data);
              _stampBase = MiioPacket.timestampOf(data);
              _stampEpoch = DateTime.now();
              return;
            }
            dg = sock.receive();
          }
        }
      }
    } on TimeoutException {
      throw StateError('handshake timed out ($ip)');
    } finally {
      sock.close();
    }
    throw StateError('handshake failed ($ip)');
  }

  Future<dynamic> call(String method, dynamic params) async {
    if (_did == null || _stampBase == null || _stampEpoch == null) {
      await connect();
    }
    final payload = Uint8List.fromList(utf8.encode(
        jsonEncode({'id': _id++, 'method': method, 'params': params})));
    final stamp =
        _stampBase! + DateTime.now().difference(_stampEpoch!).inSeconds;
    final packet = MiioPacket.encrypt(payload, token,
        deviceId: _did!, timestamp: stamp);
    final sock = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
    try {
      final addr = InternetAddress(ip);
      sock.send(packet, addr, MiioPacket.port);
      await for (final ev in sock.timeout(const Duration(seconds: 5))) {
        if (ev == RawSocketEvent.read) {
          Datagram? dg = sock.receive();
          while (dg != null) {
            if (dg.address == addr && dg.data.length > MiioPacket.headerLength) {
              try {
                final plain =
                    MiioPacket.decrypt(Uint8List.fromList(dg.data), token);
                final msg = jsonDecode(utf8.decode(plain));
                if (msg is Map && msg['id'] == _id - 1) {
                  if (msg.containsKey('error')) {
                    throw StateError('device error: ${msg['error']}');
                  }
                  return msg['result'];
                }
              } on FormatException {
                // Not our reply; keep waiting.
              }
            }
            dg = sock.receive();
          }
        }
      }
    } on TimeoutException {
      throw StateError('request $method timed out ($ip)');
    } finally {
      sock.close();
    }
    throw StateError('no reply ($ip)');
  }
}

/// Same wire format as the app's `MiioPacket`. Kept as a sibling
/// implementation (not a shared package) so the server stays a pure-Dart
/// package with no Flutter dependency; the FIPS-197 test vector in
/// `test/miio_packet_test.dart` pins both to identical bytes.
abstract final class MiioPacket {
  static const int magic = 0x2131;
  static const int headerLength = 32;
  static const int port = 54321;

  static Uint8List hello() {
    final bytes = Uint8List(headerLength);
    ByteData.sublistView(bytes)
      ..setUint16(0, magic)
      ..setUint16(2, headerLength)
      ..setUint32(4, 0xFFFFFFFF)
      ..setUint32(8, 0xFFFFFFFF)
      ..setUint32(12, 0xFFFFFFFF);
    bytes.setRange(16, 32, List.filled(16, 0xFF));
    return bytes;
  }

  static Uint8List _md5(List<int> data) =>
      Uint8List.fromList(crypto.md5.convert(data).bytes);

  static Uint8List _aesCbc(
      bool encrypt, Uint8List key, Uint8List iv, Uint8List data) {
    final cipher = CBCBlockCipher(AESEngine())
      ..init(encrypt, ParametersWithIV(KeyParameter(key), iv));
    assert(data.length % 16 == 0, 'AES-CBC input must be block-aligned');
    final out = Uint8List(data.length);
    var offset = 0;
    while (offset < data.length) {
      offset += cipher.processBlock(data, offset, out, offset);
    }
    return out;
  }

  static Uint8List encrypt(Uint8List payload, Uint8List token,
      {required int deviceId, required int timestamp}) {
    final key = _md5(token);
    final iv = _md5([...key, ...token]);
    const block = 16;
    final padLen = block - (payload.length % block);
    final padded = Uint8List(payload.length + padLen)
      ..setAll(0, payload)
      ..fillRange(payload.length, payload.length + padLen, padLen);
    final ciphertext = _aesCbc(true, key, iv, padded);
    final header = Uint8List(headerLength);
    ByteData.sublistView(header)
      ..setUint16(0, magic)
      ..setUint16(2, headerLength + ciphertext.length)
      ..setUint32(4, 0)
      ..setUint32(8, deviceId)
      ..setUint32(12, timestamp);
    final checksum =
        _md5([...header.sublist(0, 16), ...token, ...ciphertext]);
    header.setAll(16, checksum);
    return Uint8List.fromList([...header, ...ciphertext]);
  }

  static Uint8List decrypt(Uint8List packet, Uint8List token) {
    if (packet.length < headerLength) {
      throw const FormatException('miIO packet shorter than header');
    }
    final view = ByteData.sublistView(packet);
    if (view.getUint16(0) != magic) {
      throw const FormatException('bad miIO magic');
    }
    if (view.getUint16(2) != packet.length) {
      throw const FormatException('miIO length mismatch');
    }
    final key = _md5(token);
    final iv = _md5([...key, ...token]);
    final ciphertext = packet.sublist(headerLength);
    final want = _md5([...packet.sublist(0, 16), ...token, ...ciphertext]);
    for (var i = 0; i < 16; i++) {
      if (packet[16 + i] != want[i]) {
        throw const FormatException('miIO checksum mismatch');
      }
    }
    final padded = _aesCbc(false, key, iv, ciphertext);
    if (padded.isEmpty) throw const FormatException('empty miIO payload');
    final padLen = padded.last;
    if (padLen < 1 || padLen > 16 || padLen > padded.length) {
      throw const FormatException('bad PKCS7 padding');
    }
    return padded.sublist(0, padded.length - padLen);
  }

  static int deviceIdOf(Uint8List packet) =>
      ByteData.sublistView(packet).getUint32(8);

  static int timestampOf(Uint8List packet) =>
      ByteData.sublistView(packet).getUint32(12);
}
