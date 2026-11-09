import 'package:flutter_test/flutter_test.dart';
import 'package:openhome/services/ble_pairing_scan.dart';

/// BLE pairing scan: MiBeacon UUID + open-scan classification + frame decode.
void main() {
  group('BlePairingScan', () {
    test('MiBeacon service UUID is 0xFE95', () {
      expect(
          BlePairingScan.miBeacon.toString().toLowerCase(), contains('fe95'));
    });

    test('combo provisioning UUIDs are 0x1A00/0x1A01', () {
      expect(BlePairingScan.comboProvision1.toString().toLowerCase(),
          contains('1a00'));
      expect(BlePairingScan.comboProvision2.toString().toLowerCase(),
          contains('1a01'));
    });

    test('starts empty and idle', () {
      final scan = BlePairingScan();
      expect(scan.found, isEmpty);
      expect(scan.scanning, isFalse);
      expect(scan.error, isNull);
      scan.dispose();
    });
  });

  group('MiBeaconFrame', () {
    test('parses PID-6 MAC frame', () {
      // frameControl=0x0660 (MAC capability frame), devId, counter, cap=0x40,
      // mac AA:BB:CC:DD:EE:FF, pid 0x1234.
      final frame = MiBeaconFrame.parse([
        0x60,
        0x06,
        0x01,
        0x02,
        0x07,
        0x40,
        0xAA,
        0xBB,
        0xCC,
        0xDD,
        0xEE,
        0xFF,
        0x34,
        0x12,
      ]);
      expect(frame?.mac, 'AA:BB:CC:DD:EE:FF');
      expect(frame?.productId, 0x1234);
    });

    test('rejects truncated frames', () {
      expect(MiBeaconFrame.parse([0x60, 0x06]), isNull);
      expect(MiBeaconFrame.parse([]), isNull);
    });
  });
}
