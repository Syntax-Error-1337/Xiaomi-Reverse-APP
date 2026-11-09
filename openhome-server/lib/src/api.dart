import 'dart:async';
import 'dart:convert';

import 'package:shelf/shelf.dart';
import 'package:shelf_router/shelf_router.dart';
import 'package:uuid/uuid.dart';

import 'auth.dart';
import 'database.dart';
import 'spec_cache.dart';

/// REST surface. Every route except bootstrap/login/health requires
/// `Authorization: Bearer <token>`.
///
/// Devices:  POST/GET /api/devices, PATCH/DELETE /api/devices/:id
/// Rooms:    POST/GET /api/rooms, POST /api/devices/:id/room
/// Specs:    GET /api/specs/:model[?refresh=1], GET /api/specs/:model/local
/// Scenes:   POST/GET /api/scenes, POST /api/scenes/:id/run,
///           PATCH /api/scenes/:id
/// Events:   GET /api/events?limit=100
/// Backup:   GET /api/backup
class Api {
  Api(this.store, this.auth, this.specs);

  final Store store;
  final Auth auth;
  final SpecCache specs;
  final _uuid = const Uuid();

  Router get router {
    final r = Router();

    r.get('/health', (Request req) => _json({'ok': true}));

    r.post('/api/bootstrap', (Request req) async {
      final body = await _body(req);
      final username = body['username'] as String?;
      final password = body['password'] as String?;
      if (username == null || password == null || password.length < 8) {
        return _json({'error': 'username + password (8+ chars) required'},
            status: 400);
      }
      try {
        final token = auth.bootstrap(username, password);
        return _json({'token': token});
      } on StateError {
        return _json({'error': 'already bootstrapped'}, status: 409);
      }
    });

    r.post('/api/login', (Request req) async {
      final body = await _body(req);
      final token = auth.login(
          body['username'] as String? ?? '', body['password'] as String? ?? '');
      if (token == null) {
        return _json({'error': 'invalid credentials'}, status: 401);
      }
      return _json({'token': token});
    });

    // ---- authenticated below ----
    Response? guard(Request req) {
      final header = req.headers['authorization'] ?? '';
      final token = header.startsWith('Bearer ') ? header.substring(7) : '';
      final user = auth.userForToken(token);
      if (user == null) return _json({'error': 'unauthorized'}, status: 401);
      return null;
    }

    r.get('/api/devices', (Request req) {
      final denied = guard(req);
      if (denied != null) return denied;
      return _json(store.query(
          'SELECT d.*, r.name AS room FROM devices d '
          'LEFT JOIN rooms r ON r.id = d.room_id'));
    });

    r.post('/api/devices', (Request req) async {
      final denied = guard(req);
      if (denied != null) return denied;
      final body = await _body(req);
      final ip = body['ip'] as String?;
      final tokenHex = body['token'] as String?;
      if (ip == null || tokenHex == null) {
        return _json({'error': 'ip + token required'}, status: 400);
      }
      if (!_validTokenHex(tokenHex)) {
        return _json({'error': 'token must be 32 hex chars'}, status: 400);
      }
      final model = body['model'] as String?;
      final id = _uuid.v4();
      // Opportunistic URN attach: exact-model hit in the cached index.
      String? urn;
      if (model != null) {
        urn = specs.resolveUrn(model);
        if (urn != null) {
          unawaited(specs.fetchSpec(model, urn));
        }
      }
      store.execute(
        'INSERT INTO devices (id, name, ip, token_hex, model, urn, created_at) '
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, body['name'] ?? ip, ip, tokenHex.toLowerCase(), model, urn,
          DateTime.now().millisecondsSinceEpoch],
      );
      store.logEvent('device.added', deviceId: id, detail: ip);
      return _json({'id': id, 'urn': urn});
    });

    r.patch('/api/devices/<id>', (Request req, String id) async {
      final denied = guard(req);
      if (denied != null) return denied;
      final body = await _body(req);
      final sets = <String>[];
      final args = <Object?>[];
      for (final k in const ['name', 'ip', 'token_hex', 'model', 'room_id']) {
        if (body.containsKey(k)) {
          if (k == 'token_hex' && !_validTokenHex(body[k] as String)) {
            return _json({'error': 'token must be 32 hex chars'}, status: 400);
          }
          sets.add('$k = ?');
          args.add(body[k]);
        }
      }
      if (sets.isEmpty) return _json({'error': 'nothing to update'}, status: 400);
      args.add(id);
      store.execute('UPDATE devices SET ${sets.join(', ')} WHERE id = ?', args);
      return _json({'ok': true});
    });

    r.delete('/api/devices/<id>', (Request req, String id) {
      final denied = guard(req);
      if (denied != null) return denied;
      store.execute('DELETE FROM devices WHERE id = ?', [id]);
      store.logEvent('device.removed', deviceId: id);
      return _json({'ok': true});
    });

    r.get('/api/rooms', (Request req) {
      final denied = guard(req);
      if (denied != null) return denied;
      return _json(store.query('SELECT * FROM rooms'));
    });

    r.post('/api/rooms', (Request req) async {
      final denied = guard(req);
      if (denied != null) return denied;
      final body = await _body(req);
      final name = body['name'] as String?;
      if (name == null || name.isEmpty) {
        return _json({'error': 'name required'}, status: 400);
      }
      final id = _uuid.v4();
      store.execute('INSERT INTO rooms (id, name) VALUES (?, ?)', [id, name]);
      return _json({'id': id});
    });

    // Specs: full upstream JSON, or the trimmed local-plugin projection.
    r.get('/api/specs/<model>', (Request req, String model) async {
      final denied = guard(req);
      if (denied != null) return denied;
      final refresh = req.url.queryParameters['refresh'] == '1';
      final spec = await specs.specFor(model, refresh: refresh);
      if (spec == null) {
        return _json(
            {'error': 'unknown model (index not yet synced?)'}, status: 404);
      }
      return _json(spec);
    });

    r.get('/api/specs/<model>/local', (Request req, String model) async {
      final denied = guard(req);
      if (denied != null) return denied;
      final spec = await specs.specFor(model);
      if (spec == null) {
        return _json({'error': 'unknown model'}, status: 404);
      }
      return _json(SpecCache.toLocalSpec(model, spec));
    });

    // Scenes: trigger JSON `{"type":"manual"}` for v0 (time/cron + device
    // triggers arrive with the scheduler); actions are MIOT ops the server
    // executes on the LAN. See SceneRunner in scene_runner.dart.
    r.get('/api/scenes', (Request req) {
      final denied = guard(req);
      if (denied != null) return denied;
      return _json(store.query('SELECT * FROM scenes'));
    });

    r.post('/api/scenes', (Request req) async {
      final denied = guard(req);
      if (denied != null) return denied;
      final body = await _body(req);
      final name = body['name'] as String?;
      final actions = body['actions'];
      if (name == null || actions is! List || actions.isEmpty) {
        return _json({'error': 'name + non-empty actions required'},
            status: 400);
      }
      final check = _validateActions(actions);
      if (check != null) return _json({'error': check}, status: 400);
      final id = _uuid.v4();
      store.execute(
        'INSERT INTO scenes (id, name, enabled, trigger_json, actions_json) '
        'VALUES (?, ?, 1, ?, ?)',
        [id, name, jsonEncode(body['trigger'] ?? {'type': 'manual'}),
          jsonEncode(actions)],
      );
      return _json({'id': id});
    });

    r.patch('/api/scenes/<id>', (Request req, String id) async {
      final denied = guard(req);
      if (denied != null) return denied;
      final body = await _body(req);
      if (body.containsKey('enabled')) {
        store.execute('UPDATE scenes SET enabled = ? WHERE id = ?',
            [(body['enabled'] == true ? 1 : 0), id]);
      }
      if (body['actions'] is List) {
        final check = _validateActions(body['actions'] as List);
        if (check != null) return _json({'error': check}, status: 400);
        store.execute('UPDATE scenes SET actions_json = ? WHERE id = ?',
            [jsonEncode(body['actions']), id]);
      }
      return _json({'ok': true});
    });

    r.post('/api/scenes/<id>/run', (Request req, String id) async {
      final denied = guard(req);
      if (denied != null) return denied;
      final rows = store.query('SELECT * FROM scenes WHERE id = ?', [id]);
      if (rows.isEmpty) return _json({'error': 'no such scene'}, status: 404);
      // Execution happens in scene_runner (needs UDP); the API validates +
      // records intent so a headless scheduler can pick it up.
      store.logEvent('scene.run', detail: id);
      return _json({
        'ok': true,
        'note': 'queued — requires the runner (scene_runner.dart)'
      });
    });

    r.delete('/api/scenes/<id>', (Request req, String id) {
      final denied = guard(req);
      if (denied != null) return denied;
      store.execute('DELETE FROM scenes WHERE id = ?', [id]);
      return _json({'ok': true});
    });

    r.get('/api/events', (Request req) {
      final denied = guard(req);
      if (denied != null) return denied;
      final limit =
          int.tryParse(req.url.queryParameters['limit'] ?? '100') ?? 100;
      return _json(store.query(
          'SELECT * FROM events ORDER BY id DESC LIMIT ?',
          [limit.clamp(1, 1000)]));
    });

    r.get('/api/backup', (Request req) {
      final denied = guard(req);
      if (denied != null) return denied;
      return Response.ok(store.exportJson(),
          headers: {'content-type': 'application/json'});
    });

    return r;
  }

  static bool _validTokenHex(String s) =>
      RegExp(r'^[0-9a-fA-F]{32}$').hasMatch(s);

  /// v0 action schema: `{"device": "<id>", "op": "set|action",
  /// "siid": n, "piid"|"aiid": n, "value"|"args": ...}`.
  static String? _validateActions(List actions) {
    for (final a in actions) {
      if (a is! Map) return 'each action must be an object';
      if (a['device'] is! String) return 'action.device (id) required';
      if (a['op'] != 'set' && a['op'] != 'action') {
        return 'action.op must be set|action';
      }
      if (a['siid'] is! int) return 'action.siid required';
      if (a['op'] == 'set' && a['piid'] is! int) {
        return 'set needs piid';
      }
      if (a['op'] == 'action' && a['aiid'] is! int) {
        return 'action needs aiid';
      }
    }
    return null;
  }

  static Future<Map<String, dynamic>> _body(Request req) async {
    try {
      return jsonDecode(await req.readAsString()) as Map<String, dynamic>;
    } on FormatException {
      return {};
    }
  }

  static Response _json(Object value, {int status = 200}) => Response(
        status,
        body: jsonEncode(value),
        headers: {'content-type': 'application/json'},
      );
}
