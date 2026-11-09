import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:openhome/protocol/miio_client.dart';
import 'package:openhome/protocol/miio_packet.dart';
import 'package:openhome/services/device_store.dart';

/// Auto-find: unicast HELLO works without broadcast, and an authenticated
/// `miIO.info` fills in model/firmware (wrong token stays silent).
void main() {
  group('subnet sweep', () {
    test('finds a responder via unicast (no broadcast needed)', () async {
      final sock = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
      sock.listen((ev) {
        if (ev == RawSocketEvent.read) {
          Datagram? dg = sock.receive();
          while (dg != null) {
            final reply = Uint8List(32)
              ..[0] = 0x21
              ..[1] = 0x31
              ..[2] = 0
              ..[3] = 32;
            ByteData.sublistView(reply)
              ..setUint32(8, 4242)
              ..setUint32(12, 7);
            sock.send(reply, dg.address, dg.port);
            dg = sock.receive();
          }
        }
      });
      addTearDown(sock.close);

      final s = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
      addTearDown(s.close);
      s.send(MiioPacket.hello(), InternetAddress('127.0.0.1'), sock.port);
      DiscoveredDevice? got;
      await for (final ev in s.timeout(const Duration(seconds: 3))) {
        if (ev == RawSocketEvent.read) {
          Datagram? dg = s.receive();
          while (dg != null) {
            if (dg.data.length >= MiioPacket.headerLength) {
              final data = Uint8List.fromList(dg.data);
              got = DiscoveredDevice(
                ip: '127.0.0.1',
                deviceId: MiioPacket.deviceIdOf(data),
                stamp: MiioPacket.timestampOf(data),
              );
            }
            dg = s.receive();
          }
          if (got != null) break;
        }
      }
      expect(got?.deviceId, 4242);
    });

    test('localSubnet returns null or x.y.z shape', () async {
      final subnet = await DeviceStore.localSubnet();
      expect(
          subnet == null || RegExp(r'^\d+\.\d+\.\d+$').hasMatch(subnet), isTrue);
    });
  });

  group('enrich over loopback fake device', () {
    test('fills model with the right token, silent with wrong token',
        () async {
      final token = Uint8List.fromList(List.generate(16, (i) => i));
      final info = {'model': 'chuangmi.plug.v3', 'fw_ver': '1.2.3'};
      final dev = await FakeDevice.bind(token, info: info);
      addTearDown(dev.close);

      final good = await enrichAt(dev.port, token);
      expect(good?['model'], 'chuangmi.plug.v3');
      expect(good?['fw_ver'], '1.2.3');

      final bad = await enrichAt(dev.port, Uint8List(16));
      expect(bad, isNull);
    });
  });
}

/// HELLO + encrypted `miIO.info` against 127.0.0.1:[port].
/// Returns the result map, or null when the device stays silent.
Future<Map<String, dynamic>?> enrichAt(int port, Uint8List token) async {
  final s = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
  try {
    final helloReply = Completer<(int, int)>();
    final infoReply = Completer<Map<String, dynamic>?>();
    var helloDone = false;
    s.listen((ev) {
      if (ev != RawSocketEvent.read) return;
      Datagram? dg = s.receive();
      while (dg != null) {
        if (dg.data.length >= MiioPacket.headerLength) {
          if (!helloDone) {
            helloDone = true;
            final data = Uint8List.fromList(dg.data);
            helloReply.complete(
                (MiioPacket.deviceIdOf(data), MiioPacket.timestampOf(data)));
          } else {
            try {
              final plain =
                  MiioPacket.decrypt(Uint8List.fromList(dg.data), token);
              final msg = jsonDecode(utf8.decode(plain)) as Map;
              if (!infoReply.isCompleted) {
                infoReply.complete(
                    Map<String, dynamic>.from(msg['result'] as Map));
              }
            } catch (_) {
              // Not our reply (or wrong token); keep waiting.
            }
          }
        }
        dg = s.receive();
      }
    });
    s.send(MiioPacket.hello(), InternetAddress('127.0.0.1'), port);
    late int did;
    late int stamp;
    try {
      (did, stamp) =
          await helloReply.future.timeout(const Duration(seconds: 2));
    } on TimeoutException {
      return null;
    }
    final payload = Uint8List.fromList(utf8
        .encode(jsonEncode({'id': 1, 'method': 'miIO.info', 'params': []})));
    s.send(
        MiioPacket.encrypt(payload, token, deviceId: did, timestamp: stamp),
        InternetAddress('127.0.0.1'),
        port);
    try {
      return await infoReply.future.timeout(const Duration(seconds: 3));
    } on TimeoutException {
      return null; // wrong token: fake stays silent, like real hardware.
    }
  } finally {
    s.close();
  }
}


/// Fake miIO device on 127.0.0.1: answers HELLO, then one encrypted
/// JSON-RPC reply with [info] as result. Wrong token: stays silent.
class FakeDevice {
  FakeDevice._(this._sock, this.port, this._token, this._info);

  final RawDatagramSocket _sock;
  final int port;
  final Uint8List _token;
  final Map<String, dynamic> _info;

  static Future<FakeDevice> bind(Uint8List token,
      {required Map<String, dynamic> info}) async {
    final sock = await RawDatagramSocket.bind(InternetAddress.loopbackIPv4, 0);
    final dev = FakeDevice._(sock, sock.port, token, info);
    sock.listen((ev) {
      if (ev != RawSocketEvent.read) return;
      Datagram? dg = sock.receive();
      while (dg != null) {
        if (dg.data.length == 32) {
          final reply = Uint8List(32)
            ..[0] = 0x21
            ..[1] = 0x31
            ..[2] = 0
            ..[3] = 32;
          ByteData.sublistView(reply)
            ..setUint32(8, 9)
            ..setUint32(12, 777);
          sock.send(reply, dg.address, dg.port);
        } else if (dg.data.length > 32) {
          try {
            final plain = MiioPacket.decrypt(
                Uint8List.fromList(dg.data), dev._token);
            final msg = jsonDecode(utf8.decode(plain)) as Map;
            final payload = Uint8List.fromList(utf8.encode(jsonEncode(
                {'id': msg['id'], 'result': dev._info})));
            sock.send(
                MiioPacket.encrypt(payload, dev._token,
                    deviceId: 9, timestamp: 777),
                dg.address,
                dg.port);
          } catch (_) {
            // Wrong token: stay silent, like a real device.
          }
        }
        dg = sock.receive();
      }
    });
    return dev;
  }

  void close() => _sock.close();
}
