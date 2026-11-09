import 'package:flutter/material.dart';

import '../models/device.dart';
import '../services/device_store.dart';
import '../services/server_client.dart';
import 'add_device_screen.dart';
import 'device_detail_screen.dart';
import 'server_settings_screen.dart';

/// Home: the persisted device list. Globe icon opens YOUR server settings;
/// everything keeps working direct-to-device when no server is set.
class DeviceListScreen extends StatelessWidget {
  const DeviceListScreen(
      {super.key, required this.store, required this.server});

  final DeviceStore store;
  final ServerClient server;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('OpenHome'),
        actions: [
          AnimatedBuilder(
            animation: server,
            builder: (context, _) => IconButton(
              icon: Icon(server.reachable ? Icons.cloud_done : Icons.cloud_off),
              tooltip: server.reachable ? 'Server connected' : 'Home server',
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => ServerSettingsScreen(server: server),
              )),
            ),
          ),
        ],
      ),
      body: AnimatedBuilder(
        animation: store,
        builder: (context, _) {
          if (store.devices.isEmpty) {
            return const Center(
              child: Text(
                'No devices yet.\nAdd one with its IP + token.',
                textAlign: TextAlign.center,
              ),
            );
          }
          return ListView.builder(
            itemCount: store.devices.length,
            itemBuilder: (context, i) {
              final DeviceEntry device = store.devices[i];
              return Dismissible(
                key: ValueKey(device.id),
                background: Container(color: Colors.red),
                onDismissed: (_) => store.remove(device.id),
                child: ListTile(
                  leading: const Icon(Icons.power_settings_new),
                  title: Text(device.name),
                  subtitle:
                      Text('${device.model ?? 'unknown model'}\n${device.ip}'),
                  isThreeLine: true,
                  onTap: () => Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => DeviceDetailScreen(
                        store: store, server: server, device: device),
                  )),
                ),
              );
            },
          );
        },
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => AddDeviceScreen(store: store, server: server),
        )),
        tooltip: 'Add device',
        child: const Icon(Icons.add),
      ),
    );
  }
}
