import 'package:flutter/material.dart';

import '../models/device.dart';
import '../protocol/miio_client.dart';
import '../services/ble_pairing_scan.dart';
import '../services/device_store.dart';
import '../services/server_client.dart';

/// Auto-find onboarding, Mi-Home-style: opens already scanning, lists every
/// device answering on the LAN plus BLE pairing adverts, tap one to fill
/// IP + name + model. The token still comes from the user — Xiaomi never
/// exposes device keys, so no app can fetch them; the help card shows the
/// two real ways to get yours. No Xiaomi account, no cloud.
class AddDeviceScreen extends StatefulWidget {
  const AddDeviceScreen({super.key, required this.store, required this.server});

  final DeviceStore store;
  final ServerClient server;

  @override
  State<AddDeviceScreen> createState() => _AddDeviceScreenState();
}

class _AddDeviceScreenState extends State<AddDeviceScreen> {
  late final BlePairingScan _ble = BlePairingScan();
  final _name = TextEditingController();
  final _ip = TextEditingController();
  final _token = TextEditingController();
  String? _model;
  String _error = '';
  bool _busy = false;
  bool _showTokenHelp = false;

  @override
  void initState() {
    super.initState();
    // Mi-Home-style: start finding devices the moment the screen opens.
    // LAN sweep + BLE pairing adverts run side by side.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scan();
      _ble.addListener(_onBle);
      _ble.start();
    });
  }

  void _onBle() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _ble.removeListener(_onBle);
    _ble.dispose();
    _name.dispose();
    _ip.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _scan() async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      await widget.store.discover();
      if (mounted && widget.store.lastDiscovery.isEmpty) {
        setState(() => _error =
            'No devices answered. Check Wi-Fi + local-network permission, then Rescan.');
      }
    } on MiioException catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _pick(DiscoveredDevice d) {
    _ip.text = d.ip;
    if (_name.text.isEmpty) {
      _name.text = d.model ?? d.ip;
    }
    setState(() => _model = d.model);
  }

  Future<void> _save() async {
    final entry = DeviceEntry(
      id: DateTime.now().microsecondsSinceEpoch.toString(),
      name: _name.text.trim().isEmpty ? _ip.text.trim() : _name.text.trim(),
      ip: _ip.text.trim(),
      tokenHex: _token.text.trim(),
      model: _model,
    );
    try {
      entry.token; // Validate hex now, not at first command.
    } on FormatException {
      setState(() => _error = 'Token must be 32 hex characters.');
      return;
    }
    // Verify the device answers + fetch its model before persisting.
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final session = MiioSession(
          transport: widget.store.transport, ip: entry.ip, token: entry.token);
      final info = await session.info();
      entry.model = info['model'] as String? ?? entry.model;
      final did = info['did'];
      if (did != null) entry.deviceId = int.tryParse('$did');
      await widget.store.add(entry);
      // Best-effort: mirror to YOUR server so the whole home stays in sync.
      if (widget.server.reachable) {
        try {
          await widget.server.pushDevice(entry);
        } catch (_) {
          // Local save already won; server sync retries via backup later.
        }
      }
      if (mounted) Navigator.of(context).pop();
    } on MiioException catch (e) {
      setState(() => _error = 'Device did not answer: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Add device')),
      body: AnimatedBuilder(
        animation: Listenable.merge([widget.store, _ble]),
        builder: (context, _) {
          final store = widget.store;
          final lanCount = store.lastDiscovery.length;
          final bleCount = _ble.found.length;
          final scanning = _busy || store.discovering || _ble.scanning;
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              _SectionHeader(
                icon: Icons.bluetooth,
                title: 'Nearby (pairing mode)',
                subtitle: _ble.scanning
                    ? 'Listening for pairing adverts…'
                    : _ble.error ??
                        (_ble.found.isEmpty
                            ? 'Nothing advertising nearby'
                            : '${_ble.found.length} nearby'),
              ),
              for (final b in _ble.found)
                ListTile(
                  leading: const Icon(Icons.bluetooth),
                  title: Text(b.model ?? b.name),
                  subtitle: Text(
                      'Pairing mode · ${b.rssi} dBm — needs Wi-Fi setup first'),
                  trailing: TextButton(
                    child: const Text('How?'),
                    onPressed: () => setState(() => _showTokenHelp = true),
                  ),
                ),
              if (_ble.error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(_ble.error!,
                      style: const TextStyle(color: Colors.orange)),
                ),
              _SectionHeader(
                icon: Icons.wifi,
                title: 'On your Wi-Fi (ready to add)',
                subtitle: store.discovering
                    ? 'Scanning LAN… ($lanCount found)'
                    : lanCount == 0
                        ? 'None found yet'
                        : '$lanCount found',
              ),
              ElevatedButton.icon(
                onPressed: scanning
                    ? null
                    : () {
                        _scan();
                        _ble.start();
                      },
                icon: const Icon(Icons.radar),
                label: Text(scanning
                    ? 'Scanning… (LAN $lanCount · nearby $bleCount)'
                    : lanCount == 0 && bleCount == 0
                        ? 'Scan for devices'
                        : 'Rescan (LAN $lanCount · nearby $bleCount)'),
              ),
              for (final d in store.lastDiscovery)
                ListTile(
                  leading: Icon(d.known ? Icons.check_circle : Icons.memory,
                      color: d.known ? Colors.green : null),
                  title: Text(d.model ?? d.ip),
                  subtitle: Text(d.model == null
                      ? 'did ${d.deviceId} · ${d.ip}'
                      : '${d.ip} · did ${d.deviceId}'),
                  trailing: d.known
                      ? const Text('Added',
                          style: TextStyle(color: Colors.green))
                      : TextButton(
                          child: const Text('Use'),
                          onPressed: () => _pick(d),
                        ),
                ),
              TextField(
                controller: _name,
                decoration: const InputDecoration(labelText: 'Name (optional)'),
              ),
              TextField(
                controller: _ip,
                decoration: const InputDecoration(
                    labelText: 'IP address (e.g. 192.168.1.42)'),
                keyboardType: TextInputType.number,
              ),
              TextField(
                controller: _token,
                decoration: InputDecoration(
                  labelText: 'Device token (32 hex chars)',
                  suffixIcon: IconButton(
                    icon: const Icon(Icons.help_outline),
                    tooltip: 'Where do I find the token?',
                    onPressed: () =>
                        setState(() => _showTokenHelp = !_showTokenHelp),
                  ),
                ),
              ),
              if (_showTokenHelp)
                const Card(
                  margin: EdgeInsets.only(top: 8),
                  child: Padding(
                    padding: EdgeInsets.all(12),
                    child: Text(
                      'The token is the per-device key Xiaomi uses for LAN '
                      'encryption — the original app fetches it from your '
                      'Xiaomi account, which no third-party app can do.\n\n'
                      'YOUR case (fresh/reset, seen in pairing): the device '
                      'has no Wi-Fi yet, so it cannot appear below. Add it '
                      'to Wi-Fi in Mi Home first (it stays on your account), '
                      'then extract the token with python-miio from a backup '
                      '(miiocli / micloud), return here, Rescan, tap Use, '
                      'paste the token, Verify + save. The token never '
                      'changes unless you reset again.',
                      style: TextStyle(fontSize: 13),
                    ),
                  ),
                ),
              if (_error.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child:
                      Text(_error, style: const TextStyle(color: Colors.red)),
                ),
              const SizedBox(height: 12),
              ElevatedButton(
                onPressed: _busy ? null : _save,
                child: const Text('Verify + save'),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// Small section header for the Nearby / LAN groups.
class _SectionHeader extends StatelessWidget {
  const _SectionHeader(
      {required this.icon, required this.title, required this.subtitle});

  final IconData icon;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 4),
      child: Row(
        children: [
          Icon(icon, size: 20, color: Colors.grey[700]),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style: const TextStyle(
                        fontSize: 15, fontWeight: FontWeight.w600)),
                Text(subtitle,
                    style: TextStyle(fontSize: 12, color: Colors.grey[600])),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
