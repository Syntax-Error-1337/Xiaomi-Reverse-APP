import 'package:flutter/material.dart';

import '../services/server_client.dart';

/// Points the app at YOUR server (default https://home.himanshu.pro).
/// baseUrl+token persist on-device; logout clears the token.
class ServerSettingsScreen extends StatefulWidget {
  const ServerSettingsScreen({super.key, required this.server});

  final ServerClient server;

  @override
  State<ServerSettingsScreen> createState() => _ServerSettingsScreenState();
}

class _ServerSettingsScreenState extends State<ServerSettingsScreen> {
  final _url = TextEditingController(text: ServerClient.defaultBaseUrl);
  final _user = TextEditingController();
  final _pass = TextEditingController();
  String _status = '';
  bool _busy = false;

  @override
  void dispose() {
    _url.dispose();
    _user.dispose();
    _pass.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() fn) async {
    setState(() {
      _busy = true;
      _status = 'Working…';
    });
    try {
      await fn();
      setState(() => _status = 'Connected.');
    } on ServerException catch (e) {
      setState(() => _status = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Home server')),
      body: AnimatedBuilder(
        animation: widget.server,
        builder: (context, _) {
          final server = widget.server;
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              const Text(
                'Your server replaces Xiaomi cloud: registry, spec cache, '
                'scenes. Leave empty to stay direct-to-device.',
              ),
              TextField(
                controller: _url,
                decoration: const InputDecoration(
                    labelText: 'Server URL (e.g. http://192.168.1.10:8080)'),
                keyboardType: TextInputType.url,
              ),
              TextField(
                controller: _user,
                decoration: const InputDecoration(labelText: 'Username'),
              ),
              TextField(
                controller: _pass,
                decoration: const InputDecoration(labelText: 'Password'),
                obscureText: true,
              ),
              if (_status.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(_status),
                ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                children: [
                  ElevatedButton(
                    onPressed: _busy
                        ? null
                        : () => _run(() async {
                              await server.setBaseUrl(_url.text);
                              await server.checkHealth();
                              if (!server.reachable) {
                                throw ServerException(
                                    'server unreachable — staying direct-to-device');
                              }
                            }),
                    child: const Text('Check'),
                  ),
                  ElevatedButton(
                    onPressed: _busy
                        ? null
                        : () => _run(() async {
                              await server.setBaseUrl(_url.text);
                              await server.bootstrap(
                                  _user.text.trim(), _pass.text);
                            }),
                    child: const Text('Bootstrap'),
                  ),
                  ElevatedButton(
                    onPressed: _busy
                        ? null
                        : () => _run(() async {
                              await server.setBaseUrl(_url.text);
                              await server.login(_user.text.trim(), _pass.text);
                            }),
                    child: const Text('Login'),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              ListTile(
                title: const Text('Status'),
                subtitle: Text(server.reachable
                    ? 'Connected${server.token == null ? '' : ' (authed)'}'
                    : 'Direct-to-device (no server)'),
                trailing: server.reachable
                    ? IconButton(
                        icon: const Icon(Icons.link_off),
                        tooltip: 'Disconnect',
                        onPressed: () async {
                          await server.clearToken();
                          await server.checkHealth();
                        },
                      )
                    : null,
              ),
            ],
          );
        },
      ),
    );
  }
}
