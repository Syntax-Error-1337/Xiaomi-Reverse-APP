import 'dart:convert';

import 'package:sqlite3/sqlite3.dart';

/// SQLite store. Single-writer: all mutations go through one Database held
/// by the server isolate. Schema versioned via `_meta`.
class Store {
  Store._(this.db);

  final Database db;

  factory Store.open(String path) {
    final db = sqlite3.open(path);
    final store = Store._(db).._migrate();
    return store;
  }

  factory Store.memory() {
    final db = sqlite3.openInMemory();
    return Store._(db).._migrate();
  }

  void _migrate() {
    db.execute('''
      CREATE TABLE IF NOT EXISTS _meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        pass_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        label TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ip TEXT NOT NULL,
        token_hex TEXT NOT NULL,
        model TEXT,
        urn TEXT,
        room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS specs (
        model TEXT PRIMARY KEY,
        urn TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scenes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        trigger_json TEXT NOT NULL,
        actions_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        device_id TEXT,
        detail TEXT NOT NULL DEFAULT ''
      );
    ''');
  }

  void logEvent(String kind, {String? deviceId, String detail = ''}) {
    db.execute(
      'INSERT INTO events (ts, kind, device_id, detail) VALUES (?, ?, ?, ?)',
      [DateTime.now().millisecondsSinceEpoch, kind, deviceId, detail],
    );
  }

  List<Map<String, Object?>> _rows(ResultSet rs) {
    final names = rs.columnNames;
    return [
      for (final row in rs)
        {for (var i = 0; i < names.length; i++) names[i]: row[i]}
    ];
  }

  List<Map<String, Object?>> query(String sql, [List<Object?> args = const []]) =>
      _rows(db.select(sql, args));

  void execute(String sql, [List<Object?> args = const []]) =>
      db.execute(sql, args);

  String? metaGet(String k) {
    final rs = db.select('SELECT v FROM _meta WHERE k = ?', [k]);
    return rs.isEmpty ? null : rs.first['v'] as String?;
  }

  void metaSet(String k, String v) {
    db.execute(
        'INSERT INTO _meta (k, v) VALUES (?, ?) '
        'ON CONFLICT(k) DO UPDATE SET v = excluded.v',
        [k, v]);
  }

  Map<String, dynamic> exportAll() {
    Map<String, List<Map<String, Object?>>> table(String t) =>
        {t: query('SELECT * FROM $t')};
    return {
      ...table('users'),
      ...table('rooms'),
      ...table('devices'),
      ...table('specs'),
      ...table('scenes'),
      ...table('events'),
      'exported_at': DateTime.now().toIso8601String(),
    };
  }

  String exportJson() => jsonEncode(exportAll());
}
