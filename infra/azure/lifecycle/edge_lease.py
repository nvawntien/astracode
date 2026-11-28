"""Private Traefik forward-auth endpoint backed by very short local grants."""

from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import threading
import time

from activation_client import timestamp


class Lease:
    def __init__(self, activation):
        self.activation = activation
        self.lock = threading.Lock()
        self.value = {}
        self.until = 0

    def permits(self, scope):
        with self.lock:
            now = time.monotonic()
            if now >= self.until:
                self.value = {}
                try:
                    value = self.activation().call("tester")
                    expiry = value.get("until")
                    if expiry:
                        remaining = (
                            timestamp(expiry) - datetime.now(timezone.utc)
                        ).total_seconds()
                        if remaining > 0:
                            self.value = value
                            self.until = time.monotonic() + min(remaining, 2)
                except (OSError, ValueError, RuntimeError, KeyError):
                    pass
            return self.value.get(scope) is True


def serve(address, activation):
    ip = ipaddress.IPv4Address(address)
    if not ip.is_private or ip.is_unspecified:
        raise ValueError("App private IPv4 address required")
    lease = Lease(activation)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            scope = {"/check": "tester", "/smoke": "smoke"}.get(self.path)
            self.send_response(200 if scope and lease.permits(scope) else 403)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer((str(ip), 18080), Handler) as server:
        server.serve_forever()
