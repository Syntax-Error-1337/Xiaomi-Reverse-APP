import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:openhome/models/device.dart';
import 'package:openhome/protocol/miio_packet.dart';

void main() {
  group('MiioPacket framing', () {
    test('hello is 32 bytes with FF tail', () {
      final hello = MiioPacket.hello();
      expect(hello.length, MiioPacket.headerLength);
      expect(ByteData.sublistView(hello).getUint16(0), MiioPacket.magic);
      expect(ByteData.sublistView(hello).getUint16(2), 32);
      expect(hello.sublist(16), everyElement(0xFF));
    });

    test('encrypt/decrypt round-trips payload', () {
      final token = Uint8List.fromList(List.generate(16, (i) => i));
      final payload = Uint8List.fromList(
          utf8.encode('{"id":1,"method":"miIO.info","params":[]}'));
      final packet = MiioPacket.encrypt(payload, token,
          deviceId: 12345, timestamp: 67890);
      expect(ByteData.sublistView(packet).getUint16(0), MiioPacket.magic);
      expect(ByteData.sublistView(packet).getUint16(2), packet.length);
      expect(MiioPacket.deviceIdOf(packet), 12345);
      expect(MiioPacket.timestampOf(packet), 67890);
      expect(MiioPacket.decrypt(packet, token), payload);
    });

    test('encrypt/decrypt handles multi-block payloads', () {
      final token = Uint8List.fromList(List.generate(16, (i) => 15 - i));
      final payload =
          Uint8List.fromList(List.generate(200, (i) => i & 0xFF));
      final packet = MiioPacket.encrypt(payload, token,
          deviceId: 1, timestamp: 1);
      expect(packet.length % 16, 0);
      expect(MiioPacket.decrypt(packet, token), payload);
    });

    test('decrypt rejects wrong token', () {
      final token = Uint8List(16);
      final other = Uint8List.fromList(List.filled(16, 1));
      final packet = MiioPacket.encrypt(
          Uint8List.fromList([1, 2, 3]), token,
          deviceId: 1, timestamp: 1);
      expect(() => MiioPacket.decrypt(packet, other),
          throwsA(isA<FormatException>()));
    });

    test('decrypt rejects corrupt magic and length', () {
      final token = Uint8List(16);
      final packet = MiioPacket.encrypt(Uint8List.fromList([9]), token,
          deviceId: 1, timestamp: 1);
      final badMagic = Uint8List.fromList(packet)..[0] = 0x00;
      expect(() => MiioPacket.decrypt(badMagic, token),
          throwsA(isA<FormatException>()));
      final badLen = Uint8List.fromList(packet)
        ..[2] = packet[2] ^ 0xFF;
      expect(() => MiioPacket.decrypt(badLen, token),
          throwsA(isA<FormatException>()));
    });

    test('decrypt rejects tampered ciphertext', () {
      final token = Uint8List(16);
      final packet = MiioPacket.encrypt(
          Uint8List.fromList(List.generate(32, (i) => i)), token,
          deviceId: 1, timestamp: 1);
      final tampered = Uint8List.fromList(packet)
        ..[MiioPacket.headerLength + 3] ^= 0x01;
      expect(() => MiioPacket.decrypt(tampered, token),
          throwsA(isA<FormatException>()));
    });
  });

  group('DeviceEntry token', () {
    test('parses 32 hex chars', () {
      final entry = DeviceEntry(
          id: '1',
          name: 'plug',
          ip: '192.168.1.2',
          tokenHex: '00112233445566778899aabbccddeeff');
      expect(entry.token.length, 16);
      expect(entry.token[0], 0x00);
      expect(entry.token[15], 0xFF);
    });

    test('rejects short tokens', () {
      final entry =
          DeviceEntry(id: '1', name: 'x', ip: 'y', tokenHex: 'abcd');
      expect(() => entry.token, throwsA(isA<FormatException>()));
    });

    test('json round-trip', () {
      final entry = DeviceEntry(
          id: 'abc',
          name: 'lamp',
          ip: '10.0.0.5',
          tokenHex: 'ff' * 16,
          model: 'yeelink.light.test',
          deviceId: 42);
      final back = DeviceEntry.decode(entry.encode());
      expect(back.id, 'abc');
      expect(back.model, 'yeelink.light.test');
      expect(back.deviceId, 42);
    });
  });

  group('LocalSpec', () {
    test('parses services and lookup', () {
      final spec = LocalSpec.fromJson({
        'model': 'chuangmi.plug.v3',
        'services': [
          {
            'siid': 2,
            'name': 'switch',
            'properties': [
              {
                'siid': 2,
                'piid': 1,
                'name': 'on',
                'format': 'bool',
                'access': ['read', 'write', 'notify'],
              }
            ]
          }
        ]
      });
      final prop = spec.lookup(2, 1)!;
      expect(prop.name, 'on');
      expect(prop.readable, isTrue);
      expect(prop.writable, isTrue);
      expect(spec.lookup(2, 99), isNull);
    });
  });
}
