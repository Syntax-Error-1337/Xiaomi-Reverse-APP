import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:uuid/uuid.dart';

import 'database.dart';

/// Local accounts. Deliberately NOT Xiaomi OAuth: devices stay bound to
/// Xiaomi's cloud account-side, but YOUR server owns who in your home may
/// drive them over the LAN.
class Auth {
  Auth(this.store);

  final Store store;
  final _uuid = const Uuid();

  static String hashPassword(String username, String password) {
    // Per-user salt keeps two identical passwords distinct. SHA-256 with a
    // strong unique password is adequate for a LAN server; pepper via env
    // `OPENHOME_PEPPER` when exposed beyond localhost.
    final salt = sha256.convert(utf8.encode('openhome:$username')).toString();
    final pepper =
        const String.fromEnvironment('OPENHOME_PEPPER', defaultValue: '');
    return sha256.convert(utf8.encode('$salt:$password:$pepper')).toString();
  }

  static bool _constantTimeEquals(String a, String b) {
    if (a.length != b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      diff |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
    }
    return diff == 0;
  }

  bool get hasUsers =>
      store.query('SELECT COUNT(*) AS c FROM users').first['c'] != 0;

  /// First-run bootstrap. Throws [StateError] once a user exists —
  /// later accounts are created via the authenticated API.
  String bootstrap(String username, String password) {
    if (hasUsers) throw StateError('server already has users');
    return _createUser(username, password);
  }

  String _createUser(String username, String password) {
    final id = _uuid.v4();
    store.execute(
      'INSERT INTO users (id, username, pass_hash, created_at) '
      'VALUES (?, ?, ?, ?)',
      [id, username, hashPassword(username, password),
        DateTime.now().millisecondsSinceEpoch],
    );
    return _issueToken(id, 'bootstrap');
  }

  String createUser(String username, String password) =>
      _createUser(username, password);

  String _issueToken(String userId, String label) {
    final token = _uuid.v4().replaceAll('-', '') + _uuid.v4().replaceAll('-', '');
    store.execute(
      'INSERT INTO tokens (token, user_id, created_at, label) '
      'VALUES (?, ?, ?, ?)',
      [token, userId, DateTime.now().millisecondsSinceEpoch, label],
    );
    return token;
  }

  /// Returns the user id for valid credentials, else null.
  String? login(String username, String password) {
    final rows = store
        .query('SELECT id, pass_hash FROM users WHERE username = ?', [username]);
    if (rows.isEmpty) return null;
    final want = rows.first['pass_hash'] as String;
    if (!_constantTimeEquals(want, hashPassword(username, password))) {
      return null;
    }
    final userId = rows.first['id'] as String;
    return _issueToken(userId, 'login');
  }

  String? userForToken(String? bearer) {
    if (bearer == null || bearer.isEmpty) return null;
    final rows = store
        .query('SELECT user_id FROM tokens WHERE token = ?', [bearer]);
    return rows.isEmpty ? null : rows.first['user_id'] as String;
  }

  void revoke(String token) {
    store.execute('DELETE FROM tokens WHERE token = ?', [token]);
  }
}
