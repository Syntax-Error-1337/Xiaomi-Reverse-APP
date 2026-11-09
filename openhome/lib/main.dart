import 'package:flutter/material.dart';

import 'services/device_store.dart';
import 'services/server_client.dart';
import 'ui/device_list_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = DeviceStore();
  await store.load();
  final server = ServerClient();
  await server.load(); // persisted baseUrl+token (default home.himanshu.pro)
  runApp(OpenHomeApp(store: store, server: server));
}

class OpenHomeApp extends StatelessWidget {
  const OpenHomeApp({super.key, required this.store, required this.server});

  final DeviceStore store;
  final ServerClient server;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'OpenHome',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
        useMaterial3: true,
      ),
      home: DeviceListScreen(store: store, server: server),
    );
  }
}
