"""HTTP adapter: `Api.dispatch` -> `http.server`. No logic lives here."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler


def make_handler(api):
    class Handler(BaseHTTPRequestHandler):
        server_version = "openhome-server-py/0.1"

        def log_message(self, fmt, *args):  # shelf-style request logs
            print("%s - %s" % (self.address_string(), fmt % args), flush=True)

        def _send(self, status: int, payload) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _handle(self) -> None:
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b""
            status, payload = api.dispatch(
                self.command, self.path, dict(self.headers), raw
            )
            self._send(status, payload)

        do_GET = _handle
        do_POST = _handle
        do_PATCH = _handle
        do_DELETE = _handle
        do_PUT = _handle

    return Handler
