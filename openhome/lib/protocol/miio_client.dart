import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'miio_packet.dart';

/// A device answering HELLO on the LAN. [model]/[firmware] are filled by
/// [MiioTransport.enrich] (needs the token) or from the server registry.
class DiscoveredDevice {
  DiscoveredDevice({
    required this.ip,
    required this.deviceId,
    required this.stamp,
    this.model,
    this.firmware,
    this.known = false,
  });

  final String ip;
  final int deviceId;
  final int stamp;
  String? model;
  String? firmware;
  bool known;
}

class MiioException implements Exception {
  MiioException(this.message);

  final String message;

  @override
  String toString() => 'MiioException: $message';
}

/// Single-socket UDP transport. All operations are serialized through a
/// mutex because RawDatagramSocket delivers one event stream.
class MiioTransport {
  RawDatagramSocket? _socket;
  Future<void> _mutex = Future.value();

  Future<T> _locked<T>(Future<T> Function() fn) {
    final next = _mutex.then((_) => fn());
    _mutex = next.then((_) {}, onError: (_) {});
    return next;
  }

  Future<RawDatagramSocket> _sock() async {
    final existing = _socket;
    if (existing != null) return existing;
    final s = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
    s.broadcastEnabled = true;
    _socket = s;
    return s;
  }

  void close() {
    _socket?.close();
    _socket = null;
  }

  /// Broadcasts HELLO and collects responders until [timeout].
  Future<List<DiscoveredDevice>> discover(
      {Duration timeout = const Duration(seconds: 3)}) {
    return _locked(() async {
      final s = await _sock();
      final found = <String, DiscoveredDevice>{};
      s.send(MiioPacket.hello(), InternetAddress('255.255.255.255'),
          MiioPacket.port);
      final deadline = DateTime.now().add(timeout);
      await for (final ev in s) {
        if (ev == RawSocketEvent.read) {
          Datagram? dg = s.receive();
          while (dg != null) {
            if (dg.data.length >= MiioPacket.headerLength) {
              final data = Uint8List.fromList(dg.data);
              found[dg.address.address] = DiscoveredDevice(
                ip: dg.address.address,
                deviceId: MiioPacket.deviceIdOf(data),
                stamp: MiioPacket.timestampOf(data),
              );
            }
            dg = s.receive();
          }
        }
        if (DateTime.now().isAfter(deadline)) break;
      }
      return found.values.toList();
    });
  }

  /// Subnet sweep: unicast HELLO to every host in [subnet]/24. iOS blocks
  /// UDP broadcast, so this is the reliable path on iPhones — the broadcast
  /// in [discover] stays as a fast path where the OS allows it.
  /// [subnet] is the first three octets, e.g. "192.168.1".
  /// Calls [onFound] as each device answers; returns the full list.
  Future<List<DiscoveredDevice>> sweepSubnet(
    String subnet, {
    void Function(DiscoveredDevice)? onFound,
    Duration perHost = const Duration(milliseconds: 350),
    int concurrency = 32,
  }) async {
    final found = <String, DiscoveredDevice>{};
    final ips = [
      for (var i = 1; i < 255; i++)
        if (i != 255) '$subnet.$i',
    ];
    for (var off = 0; off < ips.length; off += concurrency) {
      final batch = ips.sublist(
          off, off + concurrency > ips.length ? ips.length : off + concurrency);
      final results = await Future.wait([
        for (final ip in batch)
          handshake(ip, timeout: perHost)
              .then<DiscoveredDevice?>((d) => d, onError: (_) => null),
      ]);
      for (final d in results) {
        if (d != null && !found.containsKey(d.ip)) {
          found[d.ip] = d;
          onFound?.call(d);
        }
      }
    }
    return found.values.toList();
  }

  /// Fills [device.model]/[firmware] via an authenticated `miIO.info` call.
  /// Returns null when the token is wrong or the device stays silent.
  Future<DiscoveredDevice?> enrich(
      DiscoveredDevice device, Uint8List token) async {
    try {
      final session = MiioSession(transport: this, ip: device.ip, token: token);
      final info = await session.info().timeout(const Duration(seconds: 4));
      device.model = info['model'] as String?;
      final fw = info['fw_ver'] ?? info['fwVer'] ?? info['version'];
      device.firmware = fw == null ? null : '$fw';
      return device;
    } catch (_) {
      return null;
    }
  }

  /// Unicast HELLO handshake; returns the device id and its clock stamp.
  Future<DiscoveredDevice> handshake(String ip,
      {Duration timeout = const Duration(seconds: 2)}) {
    return _locked(() async {
      final s = await _sock();
      final addr = InternetAddress(ip);
      s.send(MiioPacket.hello(), addr, MiioPacket.port);
      try {
        await for (final ev in s.timeout(timeout)) {
          if (ev == RawSocketEvent.read) {
            Datagram? dg = s.receive();
            while (dg != null) {
              if (dg.address == addr &&
                  dg.data.length >= MiioPacket.headerLength) {
                final data = Uint8List.fromList(dg.data);
                return DiscoveredDevice(
                  ip: ip,
                  deviceId: MiioPacket.deviceIdOf(data),
                  stamp: MiioPacket.timestampOf(data),
                );
              }
              dg = s.receive();
            }
          }
        }
      } on TimeoutException {
        throw MiioException('handshake timed out ($ip)');
      }
      throw MiioException('handshake failed ($ip)');
    });
  }

  int _nextId = 1;

  /// Sends one JSON-RPC command and awaits the matching reply id.
  Future<dynamic> request({
    required String ip,
    required Uint8List token,
    required int deviceId,
    required int stampBase,
    required DateTime stampEpoch,
    required String method,
    required dynamic params,
    Duration timeout = const Duration(seconds: 5),
  }) {
    return _locked(() async {
      final s = await _sock();
      final id = _nextId++;
      final stamp = stampBase + DateTime.now().difference(stampEpoch).inSeconds;
      final payload = Uint8List.fromList(utf8
          .encode(jsonEncode({'id': id, 'method': method, 'params': params})));
      final packet = MiioPacket.encrypt(payload, token,
          deviceId: deviceId, timestamp: stamp);
      final addr = InternetAddress(ip);
      s.send(packet, addr, MiioPacket.port);
      try {
        await for (final ev in s.timeout(timeout)) {
          if (ev == RawSocketEvent.read) {
            Datagram? dg = s.receive();
            while (dg != null) {
              if (dg.address == addr &&
                  dg.data.length > MiioPacket.headerLength) {
                try {
                  final plain =
                      MiioPacket.decrypt(Uint8List.fromList(dg.data), token);
                  final msg = jsonDecode(utf8.decode(plain));
                  if (msg is Map && msg['id'] == id) {
                    if (msg.containsKey('error')) {
                      throw MiioException('device error: ${msg['error']}');
                    }
                    return msg['result'];
                  }
                } on FormatException {
                  // Checksum/length mismatch: not our reply; keep waiting.
                } on MiioException {
                  rethrow;
                }
              }
              dg = s.receive();
            }
          }
        }
      } on TimeoutException {
        throw MiioException('request $method timed out ($ip)');
      }
      throw MiioException('no reply ($ip)');
    });
  }
}

/// Bound session for one device: handshake once, then reuse did/stamp.
class MiioSession {
  MiioSession({required this.transport, required this.ip, required this.token});

  final MiioTransport transport;
  String ip;
  Uint8List token;
  int? deviceId;
  int? _stampBase;
  DateTime? _stampEpoch;

  Future<void> connect() async {
    final hello = await transport.handshake(ip);
    deviceId = hello.deviceId;
    _stampBase = hello.stamp;
    _stampEpoch = DateTime.now();
  }

  Future<void> _ensure() async {
    if (deviceId == null || _stampBase == null || _stampEpoch == null) {
      await connect();
    }
  }

  Future<dynamic> call(String method, dynamic params) async {
    await _ensure();
    try {
      return await transport.request(
        ip: ip,
        token: token,
        deviceId: deviceId!,
        stampBase: _stampBase!,
        stampEpoch: _stampEpoch!,
        method: method,
        params: params,
      );
    } on MiioException catch (e) {
      // One re-handshake: device reboots reset did/stamp.
      if (e.message.contains('timed out')) {
        await connect();
        return transport.request(
          ip: ip,
          token: token,
          deviceId: deviceId!,
          stampBase: _stampBase!,
          stampEpoch: _stampEpoch!,
          method: method,
          params: params,
        );
      }
      rethrow;
    }
  }

  Future<Map<String, dynamic>> info() async =>
      Map<String, dynamic>.from(await call('miIO.info', []));

  Future<List<dynamic>> getProp(List<String> props) async =>
      List<dynamic>.from(await call('get_prop', props));

  Future<List<dynamic>> miotGet(List<Map<String, int>> props) async =>
      List<dynamic>.from(await call('get_properties', props));

  Future<dynamic> miotSet(int siid, int piid, dynamic value) =>
      call('set_properties', [
        {'siid': siid, 'piid': piid, 'value': value}
      ]);

  Future<dynamic> miotAction(int siid, int aiid,
          [List<dynamic> args = const []]) =>
      call('action', {
        'siid': siid,
        'aiid': aiid,
        'in': args,
      });
}
