import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openhome/main.dart';
import 'package:openhome/services/device_store.dart';
import 'package:openhome/services/server_client.dart';

void main() {
  testWidgets('shows empty state with no devices',
      (WidgetTester tester) async {
    final store = DeviceStore();
    final server = ServerClient();
    await tester
        .pumpWidget(OpenHomeApp(store: store, server: server));
    await tester.pumpAndSettle();
    expect(find.text('OpenHome'), findsOneWidget);
    expect(find.textContaining('No devices yet'), findsOneWidget);
    expect(find.byType(FloatingActionButton), findsOneWidget);
    // No server configured: offline indicator, still fully usable.
    expect(find.byIcon(Icons.cloud_off), findsOneWidget);
  });

  testWidgets('server settings reachable from app bar',
      (WidgetTester tester) async {
    final store = DeviceStore();
    final server = ServerClient();
    await tester
        .pumpWidget(OpenHomeApp(store: store, server: server));
    await tester.pumpAndSettle();
    await tester.tap(find.byIcon(Icons.cloud_off));
    await tester.pumpAndSettle();
    expect(find.text('Home server'), findsOneWidget);
  });
}
