import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/device.dart';
import '../protocol/miio_client.dart';

/// App state: persisted device list + one cached session per device.
/// Tokens live in app-local preferences; a hardened build should move them
/// to the platform keychain (flutter_secure_storage).
class DeviceStore extends ChangeNotifier {
  DeviceStore({MiioTransport? transport})
      : transport = transport ?? MiioTransport();

  final MiioTransport transport;
  final List<DeviceEntry> devices = [];
  final Map<String, MiioSession> _sessions = {};
  bool discovering = false;
  List<DiscoveredDevice> lastDiscovery = [];

  static const _prefsKey = 'openhome.devices.v1';

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    devices.clear();
    for (final raw in prefs.getStringList(_prefsKey) ?? const <String>[]) {
      try {
        devices.add(DeviceEntry.decode(raw));
      } on FormatException {
        // Skip one corrupt entry rather than dropping the whole list.
      }
    }
    notifyListeners();
  }

  Future<void> _save() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_prefsKey, [for (final d in devices) d.encode()]);
  }

  Future<void> add(DeviceEntry entry) async {
    devices.add(entry);
    await _save();
    notifyListeners();
  }

  Future<void> remove(String id) async {
    devices.removeWhere((d) => d.id == id);
    _sessions.remove(id);
    await _save();
    notifyListeners();
  }

  Future<void> update(DeviceEntry entry) async {
    final i = devices.indexWhere((d) => d.id == entry.id);
    if (i != -1) {
      devices[i] = entry;
      _sessions.remove(entry.id); // IP/token may have changed.
      await _save();
      notifyListeners();
    }
  }

  MiioSession sessionFor(DeviceEntry entry) => _sessions.putIfAbsent(
      entry.id,
      () =>
          MiioSession(transport: transport, ip: entry.ip, token: entry.token));

  /// Auto-find: broadcast first (fast where allowed), then a unicast sweep
  /// of the local /24 (reliable on iOS, which blocks UDP broadcast).
  /// Progress streams live via [lastDiscovery] + notifyListeners.
  /// Already-saved IPs are flagged [DiscoveredDevice.known].
  Future<List<DiscoveredDevice>> discover(
      {Duration timeout = const Duration(seconds: 3)}) async {
    discovering = true;
    lastDiscovery = [];
    notifyListeners();
    try {
      final found = <String, DiscoveredDevice>{};
      void remember(DiscoveredDevice d) {
        if (found.containsKey(d.ip)) return;
        d.known = devices.any((e) => e.ip == d.ip);
        found[d.ip] = d;
        lastDiscovery = found.values.toList()
          ..sort((a, b) => a.ip.compareTo(b.ip));
        notifyListeners();
      }

      try {
        for (final d in await transport.discover(timeout: timeout)) {
          remember(d);
        }
      } catch (_) {
        // Broadcast blocked (iOS) — the sweep below still finds devices.
      }
      final subnet = await localSubnet();
      if (subnet != null) {
        await transport.sweepSubnet(subnet, onFound: remember);
      }
      lastDiscovery = found.values.toList()
        ..sort((a, b) => a.ip.compareTo(b.ip));
      return lastDiscovery;
    } finally {
      discovering = false;
      notifyListeners();
    }
  }

  /// First three octets of the Wi-Fi IPv4 address, e.g. "192.168.1".
  /// Null when offline or IPv6-only.
  static Future<String?> localSubnet() async {
    try {
      final ifs = await NetworkInterface.list(
          includeLoopback: false, type: InternetAddressType.IPv4);
      for (final iface in ifs) {
        for (final addr in iface.addresses) {
          final parts = addr.address.split('.');
          if (parts.length == 4 && !addr.address.startsWith('169.254.')) {
            return parts.sublist(0, 3).join('.');
          }
        }
      }
    } catch (_) {
      // No network permission / no interfaces.
    }
    return null;
  }

  @override
  void dispose() {
    transport.close();
    super.dispose();
  }
}
