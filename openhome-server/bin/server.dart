import 'dart:async';
import 'dart:io';

import 'package:openhome_server/openhome_server.dart';
import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart' as io;

Future<void> main(List<String> args) async {
  final port = int.tryParse(Platform.environment['OPENHOME_PORT'] ?? '') ?? 8080;
  final dbPath =
      Platform.environment['OPENHOME_DB'] ?? 'openhome.db';
  final store = Store.open(dbPath);
  final auth = Auth(store);
  final specs = SpecCache(store);
  final api = Api(store, auth, specs);

  if (!auth.hasUsers) {
    print('No users yet. Bootstrap:');
    print('  curl -X POST localhost:$port/api/bootstrap '
        "-H 'content-type: application/json' "
        '\'{"username":"admin","password":"…"}\'');
  }

  // Nightly spec-index refresh. Failures log, never evict the cache.
  Timer.periodic(const Duration(hours: 24), (_) async {
    try {
      final n = await specs.refreshModelIndex();
      print('spec index refreshed: $n models');
    } catch (e) {
      print('spec refresh failed (cache kept): $e');
    }
  });
  // Prime the index once in the background at startup.
  unawaited(() async {
    try {
      final n = await specs.refreshModelIndex();
      print('spec index primed: $n models');
    } catch (e) {
      print('spec prime failed (will retry nightly): $e');
    }
  }());

  final handler =
      const Pipeline().addMiddleware(logRequests()).addHandler(api.router.call);
  final server = await io.serve(handler, InternetAddress.anyIPv4, port);
  print('openhome-server on http://${server.address.host}:${server.port}');
}
