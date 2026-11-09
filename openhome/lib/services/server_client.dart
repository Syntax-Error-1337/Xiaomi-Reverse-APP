import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../models/device.dart';

/// Client for YOUR openhome-server. Defaults to https://home.himanshu.pro;
/// the settings screen can repoint it at a LAN URL instead.
/// baseUrl+token persist via SharedPreferences (token belongs in secure
/// storage on the next hardening pass). Offline-first: every read falls
/// back to the bundled `assets/specs/*.json` + locally stored devices when
/// the server is unreachable; writes queue locally and report pending state.
class ServerClient extends ChangeNotifier {
  ServerClient({http.Client? client}) : _client = client ?? http.Client();

  static const defaultBaseUrl = 'https://home.himanshu.pro';
  static const _prefsBaseUrl = 'openhome.server.baseurl.v1';
  static const _prefsToken = 'openhome.server.token.v1';

  final http.Client _client;
  String? baseUrl = defaultBaseUrl;
  String? token;
  bool reachable = false;
  bool syncing = false;

  Map<String, String> get _headers => {
        'content-type': 'application/json',
        if (token != null) 'authorization': 'Bearer $token',
      };

  Uri _u(String path) => Uri.parse('${baseUrl ?? ''}$path');

  /// Loads persisted baseUrl+token. Call once at startup before first use.
  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    baseUrl = prefs.getString(_prefsBaseUrl) ?? defaultBaseUrl;
    token = prefs.getString(_prefsToken);
    notifyListeners();
  }

  Future<void> _save() async {
    final prefs = await SharedPreferences.getInstance();
    if (baseUrl == null) {
      await prefs.remove(_prefsBaseUrl);
    } else {
      await prefs.setString(_prefsBaseUrl, baseUrl!);
    }
    if (token == null) {
      await prefs.remove(_prefsToken);
    } else {
      await prefs.setString(_prefsToken, token!);
    }
  }

  /// Points at [url] (or the default home server) and persists it.
  Future<void> setBaseUrl(String? url) async {
    baseUrl = (url == null || url.trim().isEmpty) ? defaultBaseUrl : url.trim();
    await _save();
    notifyListeners();
  }

  /// Clears the stored token (logout). Keeps baseUrl.
  Future<void> clearToken() async {
    token = null;
    await _save();
    notifyListeners();
  }

  Future<bool> checkHealth() async {
    if (baseUrl == null || baseUrl!.isEmpty) {
      reachable = false;
      notifyListeners();
      return false;
    }
    try {
      final r =
          await _client.get(_u('/health')).timeout(const Duration(seconds: 3));
      reachable = r.statusCode == 200;
    } catch (_) {
      reachable = false;
    }
    notifyListeners();
    return reachable;
  }

  Future<String> bootstrap(String username, String password) async {
    final r = await _client.post(_u('/api/bootstrap'),
        headers: _headers,
        body: jsonEncode({'username': username, 'password': password}));
    final body = jsonDecode(r.body) as Map<String, dynamic>;
    if (r.statusCode != 200) {
      throw ServerException(body['error'] as String? ?? 'bootstrap failed');
    }
    token = body['token'] as String;
    reachable = true;
    await _save();
    notifyListeners();
    return token!;
  }

  Future<String> login(String username, String password) async {
    final r = await _client.post(_u('/api/login'),
        headers: _headers,
        body: jsonEncode({'username': username, 'password': password}));
    final body = jsonDecode(r.body) as Map<String, dynamic>;
    if (r.statusCode != 200) {
      throw ServerException(body['error'] as String? ?? 'login failed');
    }
    token = body['token'] as String;
    reachable = true;
    await _save();
    notifyListeners();
    return token!;
  }

  /// Full upstream spec via the server's cache (`?refresh=1` to re-fetch).
  /// Returns null when unreachable — caller falls back to bundled specs.
  Future<Map<String, dynamic>?> fullSpec(String model,
      {bool refresh = false}) async {
    if (!reachable) return null;
    try {
      final r = await _client
          .get(_u('/api/specs/$model${refresh ? '?refresh=1' : ''}'),
              headers: _headers)
          .timeout(const Duration(seconds: 10));
      if (r.statusCode != 200) return null;
      return jsonDecode(r.body) as Map<String, dynamic>;
    } catch (_) {
      reachable = false;
      notifyListeners();
      return null;
    }
  }

  /// Trimmed local-plugin projection. Same offline contract as [fullSpec].
  Future<LocalSpec?> localSpec(String model) async {
    if (!reachable) return null;
    try {
      final r = await _client
          .get(_u('/api/specs/$model/local'), headers: _headers)
          .timeout(const Duration(seconds: 10));
      if (r.statusCode != 200) return null;
      return LocalSpec.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
    } catch (_) {
      reachable = false;
      notifyListeners();
      return null;
    }
  }

  Future<List<Map<String, dynamic>>> serverDevices() async {
    final r = await _client
        .get(_u('/api/devices'), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (r.statusCode != 200) {
      throw ServerException('devices: ${r.statusCode}');
    }
    return List<Map<String, dynamic>>.from(jsonDecode(r.body) as List);
  }

  Future<void> pushDevice(DeviceEntry entry) async {
    final r = await _client
        .post(_u('/api/devices'),
            headers: _headers,
            body: jsonEncode({
              'name': entry.name,
              'ip': entry.ip,
              'token': entry.tokenHex,
              if (entry.model != null) 'model': entry.model,
            }))
        .timeout(const Duration(seconds: 10));
    if (r.statusCode != 200) {
      final body = jsonDecode(r.body) as Map<String, dynamic>;
      throw ServerException(body['error'] as String? ?? 'push failed');
    }
  }

  Future<String> createScene(String name, List<Map<String, dynamic>> actions,
      {Map<String, dynamic>? trigger}) async {
    final r = await _client
        .post(_u('/api/scenes'),
            headers: _headers,
            body: jsonEncode({
              'name': name,
              'actions': actions,
              if (trigger != null) 'trigger': trigger
            }))
        .timeout(const Duration(seconds: 10));
    final body = jsonDecode(r.body) as Map<String, dynamic>;
    if (r.statusCode != 200) {
      throw ServerException(body['error'] as String? ?? 'scene failed');
    }
    return body['id'] as String;
  }

  Future<void> runScene(String id) async {
    final r = await _client
        .post(_u('/api/scenes/$id/run'), headers: _headers)
        .timeout(const Duration(seconds: 10));
    if (r.statusCode != 200) {
      throw ServerException('run failed: ${r.statusCode}');
    }
  }
}

class ServerException implements Exception {
  ServerException(this.message);

  final String message;

  @override
  String toString() => 'ServerException: $message';
}
