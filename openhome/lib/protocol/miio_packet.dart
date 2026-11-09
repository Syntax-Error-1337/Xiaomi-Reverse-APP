import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:pointycastle/export.dart';

/// miIO UDP packet codec.
///
/// Layout (big-endian): magic u16 (`0x2131`), length u16, unknown u32 (`0`),
/// device-id u32, timestamp u32, checksum md5 u128, then AES-128-CBC payload
/// (PKCS7). Key = md5(token), iv = md5(key ‖ token). AES itself is
/// pointycastle's; only the packet framing is ours.
///
/// Timestamp is device-clock-relative: the handshake reply's `ts` is stored
/// and later packets use `ts + elapsed-since-handshake`.
abstract final class MiioPacket {
  static const int magic = 0x2131;
  static const int headerLength = 32;
  static const int port = 54321;

  /// HELLO handshake: unknown/did/ts/checksum all `0xFF`.
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
      Uint8List.fromList(md5.convert(data).bytes);

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

  /// Encrypts [payload] for [token] (raw 16 device-token bytes).
  static Uint8List encrypt(
    Uint8List payload,
    Uint8List token, {
    required int deviceId,
    required int timestamp,
  }) {
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

  /// Decrypts [packet] with [token]. Throws [FormatException] on bad
  /// magic, length, checksum, or padding.
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
    final want =
        _md5([...packet.sublist(0, 16), ...token, ...ciphertext]);
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
