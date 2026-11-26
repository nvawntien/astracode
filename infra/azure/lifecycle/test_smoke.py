"""Exercise the production smoke client through loopback HTTPS with client authentication."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
import unittest
import uuid

from smoke import smoke, SmokeFailed


class TestSmoke(unittest.TestCase):
    def test_complete_and_wrong_attempt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            def ssltool(*args):
                subprocess.run(
                    ["openssl", *args], cwd=root, check=True, capture_output=True
                )

            ssltool(
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-subj",
                "/CN=fixture-ca",
                "-days",
                "1",
                "-addext",
                "basicConstraints=critical,CA:TRUE",
                "-addext",
                "keyUsage=critical,keyCertSign,cRLSign",
                "-keyout",
                "ca.key",
                "-out",
                "ca.crt",
            )
            for role, ext in (("server", "serverAuth"), ("client", "clientAuth")):
                ssltool(
                    "req",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-subj",
                    "/CN=" + role,
                    "-keyout",
                    role + ".key",
                    "-out",
                    role + ".csr",
                )
                (root / "ext").write_text(
                    "extendedKeyUsage=" + ext + "\nsubjectAltName=IP:127.0.0.1\n"
                )
                ssltool(
                    "x509",
                    "-req",
                    "-in",
                    role + ".csr",
                    "-CA",
                    "ca.crt",
                    "-CAkey",
                    "ca.key",
                    "-CAcreateserial",
                    "-days",
                    "1",
                    "-extfile",
                    "ext",
                    "-out",
                    role + ".crt",
                )
            first, second = str(uuid.uuid4()), str(uuid.uuid4())

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass

                def reply(self, data):
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(json.dumps({"data": data}).encode())

                def do_POST(self):
                    self.rfile.read(int(self.headers.get("Content-Length", 0)))
                    if self.path.endswith("/login"):
                        self.reply({"access_token": "synthetic"})
                    elif self.path.endswith("/rejudge"):
                        self.server.attempt = second
                        self.reply(
                            {"attempt_id": first if self.server.stale else second}
                        )
                    elif self.path.endswith("/ticket"):
                        self.reply({"ticket": "fixture"})
                    elif self.path.endswith("/run"):
                        self.reply(
                            {"status": "completed", "tests": [{"stdout": "2\n"}]}
                        )
                    else:
                        self.reply({"id": 7})

                def do_GET(self):
                    if self.path.startswith("/events/"):
                        self.send_response(200)
                        self.send_header("Content-Type", "text/event-stream")
                        self.end_headers()
                        self.wfile.write(
                            b'event: submission.snapshot\ndata: {"submission_id":7}\n\n'
                        )
                    elif self.path.endswith("/fixture"):
                        self.reply({"id": 9})
                    else:
                        self.reply(
                            {"attempt_id": self.server.attempt, "status": "ACCEPTED"}
                        )

            with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
                ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                ctx.load_cert_chain(root / "server.crt", root / "server.key")
                ctx.load_verify_locations(root / "ca.crt")
                ctx.verify_mode = ssl.CERT_REQUIRED
                server.socket = ctx.wrap_socket(server.socket, server_side=True)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                tls = dict(
                    ca=root / "ca.crt",
                    cert=root / "client.crt",
                    key=root / "client.key",
                )
                fixture = dict(
                    tester={},
                    moderator={},
                    slug="fixture",
                    submission={"problem_id": 9},
                    custom_case={"id": "synthetic"},
                    expected_stdout="2",
                )

                def exercise(stale):
                    server.attempt, server.stale = first, stale
                    return smoke(
                        f"https://127.0.0.1:{server.server_port}",
                        tls,
                        fixture,
                        lambda: None,
                    )

                try:
                    exercise(False)
                    with self.assertRaises(SmokeFailed):
                        exercise(True)
                finally:
                    server.shutdown()
                    thread.join(3)


if __name__ == "__main__":
    unittest.main()
