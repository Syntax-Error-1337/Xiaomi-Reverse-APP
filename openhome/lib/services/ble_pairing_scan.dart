import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';

/// A Xiaomi-family device seen in pairing mode.
///
/// Fresh/reset devices advertise over BLE BEFORE they join Wi-Fi — this is
/// what Mi Home's "Discover nearby devices" shows. These devices have no IP
/// and no miIO yet, so they can't be controlled; they need Wi-Fi
/// provisioning first.
class BlePairingDevice {
  BlePairingDevice({
    required this.id,
    required this.name,
    required this.rssi,
    this.model,
    this.mac,
    this.productId,
    this.frameCounter,
  });

  final String id;
  final String name;
  String? model;

  /// BLE MAC parsed from the advert (MiBeacon PID-6 frame), if present.
  String? mac;

  /// MiBeacon product id (pid), if the frame carried one.
  int? productId;
  final int rssi;
  int? frameCounter;
}

/// Passive BLE listener matching Mi Home's nearby-device scan.
///
/// RE (Mi Home 11.8.203, `docs/RE_FINDINGS.md` §7): the nearby list is fed
/// by `MHNearlyDistributeNetworkManager_startSearchBloothFromMainPage`,
/// which drives `MiioBluetoothThread centralManagerStartSearch` — an OPEN
/// scan whose `handleScanResponsePackage` parses BOTH `kCBAdvDataServiceData`
/// (MiBeacon `0xFE95`, provisioning `0x1A00/0x1A01`, accessory `0x30F1…`)
/// AND `kCBAdvDataManufacturerData` (Xiaomi company id `0x038F`). Devices
/// are then filtered against `DeviceConfig` (`isModelConnectable`), with
/// `version exceeds max MiBeacon version` dropped.
///
/// The critical consequence: filtering the scan to `withServices: [FE95]`
/// misses combo devices (like a reset BOFON air control) whose pairing
/// advert carries only manufacturer data. So this scan is OPEN (no service
/// filter) and classifies in Dart, exactly like `handleScanResponsePackage`.
/// No connection, no pairing, no bonding — purely passive.
class BlePairingScan extends ChangeNotifier {
  BlePairingScan();

  final List<BlePairingDevice> found = [];
  bool scanning = false;
  String? error;
  StreamSubscription<List<ScanResult>>? _sub;
  Timer? _stopTimer;

  /// Xiaomi company id in manufacturer data (little-endian `8F 03`).
  static const int xiaomiCompanyId = 0x038F;

  /// Service UUIDs Mi Home's scan parses (from binary string inventory):
  /// MiBeacon, Wi-Fi combo provisioning, suitcase/accessory service.
  static final Guid miBeacon = Guid('0000fe95-0000-1000-8000-00805f9b34fb');
  static final Guid comboProvision1 =
      Guid('00001a00-0000-1000-8000-00805f9b34fb');
  static final Guid comboProvision2 =
      Guid('00001a01-0000-1000-8000-00805f9b34fb');
  static final Guid accessory = Guid('000030f1-0000-1000-8000-00805f9b34fb');

  static final List<Guid> knownServices = [
    miBeacon,
    comboProvision1,
    comboProvision2,
    accessory,
  ];

  Future<void> start({Duration timeout = const Duration(seconds: 20)}) async {
    if (scanning) return;
    found.clear();
    error = null;
    scanning = true;
    notifyListeners();
    try {
      if (!await FlutterBluePlus.isSupported) {
        error = 'Bluetooth not available on this device.';
        return;
      }
      final state = await FlutterBluePlus.adapterState.first;
      if (state != BluetoothAdapterState.on) {
        error = 'Turn on Bluetooth to find pairing devices.';
        return;
      }
      await _sub?.cancel();
      _sub = FlutterBluePlus.scanResults.listen(_onResults);
      // OPEN scan: no withServices filter. iOS only reports adverts it sees;
      // filtering to FE95 drops combo devices advertising manufacturer data
      // only (the reset-BOFON case). Classification happens in _classify.
      await FlutterBluePlus.startScan(
        timeout: timeout,
        androidUsesFineLocation: true,
      );
      _stopTimer?.cancel();
      _stopTimer = Timer(timeout + const Duration(seconds: 1), stop);
    } catch (e) {
      error = 'Bluetooth scan failed: $e';
    } finally {
      if (error != null) {
        scanning = false;
        notifyListeners();
      }
    }
  }

  void _onResults(List<ScanResult> results) {
    var changed = false;
    for (final r in results) {
      if (found.any((d) => d.id == r.device.remoteId.str)) {
        continue;
      }
      final hit = _classify(r);
      if (hit != null) {
        found.add(hit);
        changed = true;
      }
    }
    if (changed) notifyListeners();
  }

  /// Mirrors `handleScanResponsePackage`: accept when the advert carries
  /// Xiaomi manufacturer data, a known service-data frame, or a Xiaomi-ish
  /// local name. Returns null for unrelated peripherals (headphones, etc.).
  static BlePairingDevice? _classify(ScanResult r) {
    final adv = r.advertisementData;
    final id = r.device.remoteId.str;

    // 1. Manufacturer data: Xiaomi company id 0x038F.
    for (final entry in adv.manufacturerData.entries) {
      if (entry.key == xiaomiCompanyId && entry.value.isNotEmpty) {
        return BlePairingDevice(
          id: id,
          name: adv.advName.isNotEmpty ? adv.advName : 'Xiaomi device',
          rssi: r.rssi,
          model: _guessModel(adv.advName),
        );
      }
    }

    // 2. Service data under a known UUID: decode the MiBeacon frame for
    // model hints (PID-6 MAC frame) instead of just listing the device.
    for (final entry in adv.serviceData.entries) {
      final uuid = entry.key.toString().toLowerCase();
      if (!uuid.contains('fe95') &&
          !uuid.contains('1a00') &&
          !uuid.contains('1a01') &&
          !uuid.contains('30f1')) {
        continue;
      }
      final frame = MiBeaconFrame.parse(entry.value);
      final advName = adv.advName;
      return BlePairingDevice(
        id: id,
        name: advName.isNotEmpty
            ? advName
            : (frame?.mac != null ? 'Xiaomi ${frame!.mac}' : 'Xiaomi device'),
        rssi: r.rssi,
        model: _guessModel(advName) ?? frame?.mac,
        mac: frame?.mac,
        productId: frame?.productId,
        frameCounter: frame?.frameCounter,
      );
    }

    // 3. Service UUIDs advertised without service data (overflow case).
    for (final uuid in adv.serviceUuids) {
      final s = uuid.toString().toLowerCase();
      if (s.contains('fe95') ||
          s.contains('1a00') ||
          s.contains('1a01') ||
          s.contains('30f1')) {
        return BlePairingDevice(
          id: id,
          name: adv.advName.isNotEmpty ? adv.advName : 'Xiaomi device',
          rssi: r.rssi,
          model: _guessModel(adv.advName),
        );
      }
    }

    // 4. Recognizable local name as a last resort (some combo firmwares
    // name the peripheral before adding service data).
    final guess = _guessModel(adv.advName);
    if (guess != null) {
      return BlePairingDevice(
        id: id,
        name: adv.advName,
        rssi: r.rssi,
        model: guess,
      );
    }
    return null;
  }

  Future<void> stop() async {
    _stopTimer?.cancel();
    try {
      await FlutterBluePlus.stopScan();
    } catch (_) {
      // Already stopped.
    }
    await _sub?.cancel();
    _sub = null;
    scanning = false;
    notifyListeners();
  }

  @override
  void dispose() {
    _stopTimer?.cancel();
    _sub?.cancel();
    super.dispose();
  }

  /// Best-effort model hint from the advert name (e.g. "BOFON ...").
  /// Null when the advert carries no recognizable model.
  static String? _guessModel(String advName) {
    final n = advName.toLowerCase();
    if (n.isEmpty) return null;
    // Ecosystem prefixes seen in MiBeacon/pairing adverts; extend as found.
    const prefixes = [
      'bofon',
      'chuangmi',
      'zhimi',
      'dmaker',
      'leshow',
      'viomi',
      'roborock',
      'dreame',
      'yeelink',
      'philips',
      'lumi',
      'aqara',
      'mijia',
      'xiaomi',
      'mi ',
      'air condition',
      'aircontrol',
    ];
    for (final p in prefixes) {
      if (n.contains(p)) return advName.trim();
    }
    // A non-empty local name on an already-classified Xiaomi advert is
    // still a useful label.
    return advName.trim().isEmpty ? null : advName.trim();
  }
}

/// Minimal MiBeacon frame decoder (public MiBeacon spec + observed layout).
///
/// Frame: `frameControl u16 | deviceId u16 | frameCounter u8 | capability u8`
/// then capability-dependent payload. The PID-6 (` enroll`) MAC frame
/// (`frameControl&0x0F == 0x06`, `capability&0x40`) carries the 6-byte
/// MAC + 2-byte product id — enough to label a pairing device without
/// connecting.
class MiBeaconFrame {
  MiBeaconFrame({this.mac, this.productId, this.frameCounter});

  final String? mac;
  final int? productId;
  final int? frameCounter;

  static MiBeaconFrame? parse(List<int> bytes) {
    final b = Uint8List.fromList(bytes);
    // MiBeacon service data has a 2-byte header some stacks strip and some
    // keep; tolerate both by trying two offsets.
    for (final off in [0, 2]) {
      final f = _parseAt(b, off);
      if (f != null) return f;
    }
    return null;
  }

  static MiBeaconFrame? _parseAt(Uint8List b, int off) {
    if (b.length < off + 6) return null;
    final fc = b[off] | (b[off + 1] << 8);
    final frameCounter = b[off + 4];
    final capability = b[off + 5];
    final frameType = fc & 0x0F;
    String? mac;
    int? pid;
    // MAC capability bit + PID-6 frame carries mac(6) + pid(2).
    if ((capability & 0x40) != 0 && b.length >= off + 6 + 8) {
      final macBytes = b.sublist(off + 6, off + 12);
      mac = macBytes
          .map((x) => x.toRadixString(16).padLeft(2, '0'))
          .join(':')
          .toUpperCase();
      pid = b[off + 12] | (b[off + 13] << 8);
    }
    return MiBeaconFrame(
        mac: mac,
        productId: pid,
        frameCounter: frameType == 0x06 ? null : frameCounter);
  }
}
