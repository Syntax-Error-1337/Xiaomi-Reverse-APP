import 'dart:convert';

import 'package:flutter/material.dart';

import '../models/device.dart';
import '../protocol/miio_client.dart';
import '../services/device_store.dart';
import '../services/server_client.dart';
import '../services/spec_loader.dart';
/// Per-device control: spec-driven property cards when a local spec matches
class DeviceDetailScreen extends StatefulWidget {
  const DeviceDetailScreen(
      {super.key, required this.store, required this.server, required this.device});

  final DeviceStore store;
  final ServerClient server;
  final DeviceEntry device;

  @override
  State<DeviceDetailScreen> createState() => _DeviceDetailScreenState();
}

class _DeviceDetailScreenState extends State<DeviceDetailScreen> {
  String _status = 'Not connected';
  bool _busy = false;
  LocalSpec? _spec;
  final Map<String, dynamic> _values = {};
  final _method = TextEditingController(text: 'get_prop');
  final _params = TextEditingController(text: '["power","temperature"]');
  String _rawResult = '';

  @override
  void initState() {
    super.initState();
    loadSpec(widget.device.model, server: widget.server).then((spec) {
      if (mounted) setState(() => _spec = spec);
    });
  }

  @override
  void dispose() {
    _method.dispose();
    _params.dispose();
    super.dispose();
  }

  Future<T?> _guard<T>(Future<T> Function() fn, {String? ok}) async {
    if (_busy) return null;
    setState(() {
      _busy = true;
      _status = 'Working…';
    });
    try {
      final result = await fn();
      setState(() => _status = ok ?? 'OK');
      return result;
    } on MiioException catch (e) {
      setState(() => _status = e.toString());
      return null;
    } on FormatException catch (e) {
      setState(() => _status = 'Bad input: ${e.message}');
      return null;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refreshInfo() async {
    final info = await _guard(
        () => widget.store.sessionFor(widget.device).info(),
        ok: 'Info refreshed');
    if (info == null) return;
    final updated = DeviceEntry(
      id: widget.device.id,
      name: widget.device.name,
      ip: widget.device.ip,
      tokenHex: widget.device.tokenHex,
      model: info['model'] as String? ?? widget.device.model,
      deviceId: info['did'] == null
          ? widget.device.deviceId
          : int.tryParse('${info['did']}'),
    );
    await widget.store.update(updated);
  }

  Future<void> _readAll() async {
    final spec = _spec;
    if (spec == null) return;
    final props = [
      for (final s in spec.services)
        for (final p in s.props)
          if (p.readable) {'siid': p.siid, 'piid': p.piid}
    ];
    if (props.isEmpty) return;
    final results = await _guard(
        () => widget.store.sessionFor(widget.device).miotGet(props));
    if (results == null) return;
    setState(() {
      for (final r in results) {
        if (r is Map && r['siid'] is int && r['piid'] is int) {
          _values['${r['siid']}/${r['piid']}'] = r['value'];
        }
      }
    });
  }

  Future<void> _toggleBool(MiotProperty prop, bool current) async {
    final result = await _guard(() => widget.store
        .sessionFor(widget.device)
        .miotSet(prop.siid, prop.piid, !current));
    if (result != null) {
      setState(() => _values['${prop.siid}/${prop.piid}'] = !current);
    }
  }

  Future<void> _sendRaw() async {
    dynamic params;
    try {
      params = _params.text.trim().isEmpty ? [] : _parseJson(_params.text);
    } on FormatException {
      setState(() => _status = 'Params must be valid JSON');
      return;
    }
    final result = await _guard(() => widget.store
        .sessionFor(widget.device)
        .call(_method.text.trim(), params));
    if (result != null) {
      setState(() => _rawResult = '$result');
    }
  }

  dynamic _parseJson(String text) => jsonDecode(text);

  @override
  Widget build(BuildContext context) {
    final spec = _spec;
    return Scaffold(
      appBar: AppBar(title: Text(widget.device.name)),
      body: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          Card(
            child: ListTile(
              title: Text(widget.device.model ?? 'unknown model'),
              subtitle: Text('${widget.device.ip}\n$_status'),
              isThreeLine: true,
              trailing: _busy
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : IconButton(
                      icon: const Icon(Icons.refresh),
                      tooltip: 'miIO.info',
                      onPressed: _refreshInfo,
                    ),
            ),
          ),
          if (spec != null) ...[
            Row(
              children: [
                const Text('Properties',
                    style: TextStyle(fontWeight: FontWeight.bold)),
                const Spacer(),
                TextButton(
                    onPressed: _busy ? null : _readAll,
                    child: const Text('Read all')),
              ],
            ),
            for (final service in spec.services) ...[
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Text(service.name,
                    style: Theme.of(context).textTheme.titleSmall),
              ),
              for (final prop in service.props)
                _propertyTile(prop),
            ],
          ] else
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8),
              child: Text(
                  'No local spec for this model — info + raw console below still work.'),
            ),
          const SizedBox(height: 8),
          const Text('Raw console',
              style: TextStyle(fontWeight: FontWeight.bold)),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _method,
                  decoration:
                      const InputDecoration(labelText: 'method'),
                ),
              ),
              const SizedBox(width: 8),
              ElevatedButton(
                onPressed: _busy ? null : _sendRaw,
                child: const Text('Send'),
              ),
            ],
          ),
          TextField(
            controller: _params,
            decoration:
                const InputDecoration(labelText: 'params (JSON)'),
            minLines: 1,
            maxLines: 4,
          ),
          if (_rawResult.isNotEmpty)
            SelectableText(_rawResult,
                style: const TextStyle(fontFamily: 'monospace')),
        ],
      ),
    );
  }

  Widget _propertyTile(MiotProperty prop) {
    final key = '${prop.siid}/${prop.piid}';
    final value = _values[key];
    if (prop.format == 'bool') {
      final on = value == true;
      return SwitchListTile(
        title: Text(prop.name),
        subtitle: Text('siid ${prop.siid} · piid ${prop.piid}'),
        value: on,
        onChanged: (!prop.writable || _busy)
            ? null
            : (_) => _toggleBool(prop, on),
      );
    }
    return ListTile(
      title: Text(prop.name),
      subtitle: Text(
          'siid ${prop.siid} · piid ${prop.piid}${prop.unit == null ? '' : ' · ${prop.unit}'}'),
      trailing: Text(value == null ? '—' : '$value'),
    );
  }
}
