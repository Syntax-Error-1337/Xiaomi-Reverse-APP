import 'dart:io';

import 'package:test/test.dart';

/// Server-side region-free guarantee: the registry, spec cache, and scene
/// runner must accept devices of ANY origin. The original app binds devices
/// to a per-country server shard; this server has no country/shard column,
/// no allowlist, and no geo branch anywhere.
void main() {
  group('no region gating in server source', () {
    test('no region/country symbols in lib/', () async {
      final lib = Directory('lib');
      final hits = <String>[];
      await for (final f in lib.list(recursive: true)) {
        if (f is! File || !f.path.endsWith('.dart')) continue;
        final src = await f.readAsString();
        final code =
            src.split('\n').where((l) => !l.trimLeft().startsWith('///'));
        for (final line in code) {
          final stripped = line.split('//').first;
          if (RegExp(
                  r'region|country|locale|serverCode|isChina|oversea|chinaOnly|CN_ONLY',
                  caseSensitive: false)
              .hasMatch(stripped)) {
            hits.add('${f.path}: $stripped');
          }
        }
      }
      expect(hits, isEmpty, reason: hits.take(10).join('\n'));
    });

    test('schema has no region/shard column', () async {
      final src =
          await File('lib/src/database.dart').readAsString();
      expect(
          RegExp(r'region|shard|country|locale', caseSensitive: false)
              .hasMatch(src),
          isFalse);
    });
  });
}
