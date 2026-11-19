"""Disposable echo upstreams; never used by the application runtime."""
import base64
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import time


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_request(self):
        if self.path.startswith("/events/submissions/"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            for i in range(47 if "long=1" in self.path else 5):
                self.wfile.write(f"event: tick\ndata: {i}\n\n".encode())
                self.wfile.flush()
                time.sleep(1)
            self.close_connection = True
            return
        time.sleep(float(self.headers.get("x-fixture-delay", "0")))
        length = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(length)
        value = {"service_port": self.server.server_port, "method": self.command, "path": self.path,
                 "headers": dict(self.headers), "body": base64.b64encode(data).decode()}
        body = json.dumps(value).encode()
        self.send_response(int(self.headers.get("x-fixture-status", "200")))
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.send_header("Set-Cookie", "access_token=fixture; Path=/; HttpOnly")
        self.send_header("Set-Cookie", "refresh_token=fixture; Path=/; HttpOnly")
        self.send_header("Retry-After", "7")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_request


for port in (8081, 8082, 8083, 3000, 9000):
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
threading.Event().wait()
