#!/usr/bin/env python3
"""Pinned-image black-box regression suite on a disposable Docker network.

No application DB, credentials, or production containers are used. Optional
--legacy DIR compares the migration with an externally captured old bootstrap
and rendered KrakenD JSON in DIR; legacy files are not runtime dependencies.
"""
import argparse
import base64
import hashlib
import hmac
import http.client
import json
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time
import unittest
import uuid
import yaml

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "envoyproxy/envoy:v1.34.2"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--legacy")
parser.add_argument("--long-stream", action="store_true", help="hold SSE beyond the old 45-second edge timeout")
ARGS = parser.parse_args()


def docker(*args):
    result = subprocess.run(["docker", *args], text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip()[-4000:])
    return result.stdout.strip()


def b64(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


class EdgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.secret = secrets.token_bytes(32)
        cls.temp = tempfile.TemporaryDirectory(prefix="astracode-edge-")
        cls.directory = Path(cls.temp.name)
        cls.network = "astracode-edge-" + uuid.uuid4().hex[:12]
        cls.containers = []
        cls.addClassCleanup(cls.cleanup)
        key = cls.directory / "symmetric.json"
        key.write_text(json.dumps({"keys": [{"kty": "oct", "k": b64(cls.secret), "alg": "HS256", "use": "sig"}]}))
        key.chmod(0o600)
        # Model the separate, networkless Compose initializer. The canonical
        # owner-only key is never chmod'ed or chown'ed to make Envoy readable.
        docker("run", "--rm", "--network", "none", "--user", "0:0", "--cap-drop", "ALL",
               "--cap-add", "DAC_OVERRIDE", "--cap-add", "CHOWN", "--entrypoint", "/bin/bash",
               "-v", f"{key}:/source:ro", "-v", f"{cls.directory}:/keys", IMAGE, "-ec",
               "umask 077; cp /source /keys/runtime.json; chmod 0400 /keys/runtime.json; chown 101:101 /keys/runtime.json")
        cls.runtime_key = cls.directory / "runtime.json"
        docker("network", "create", cls.network)
        docker("run", "-d", "--name", cls.network + "-upstreams", "--network", cls.network,
               *sum((["--network-alias", name] for name in ("auth-service", "problem-service", "submission-service", "website", "minio")), []),
               "-v", f"{ROOT / 'tests/upstreams.py'}:/upstreams.py:ro", "python:3.12.12-slim", "python", "/upstreams.py")
        cls.containers.append(cls.network + "-upstreams")
        cls.ports = {}
        for mode in ("dev", "prod"):
            config = ROOT / ("envoy.yaml" if mode == "dev" else "envoy.prod.yaml")
            cls.start_edge(mode, config, cls.runtime_key)
        if ARGS.legacy:
            legacy = Path(ARGS.legacy).resolve()
            docker("run", "-d", "--name", cls.network + "-legacy-gateway", "--network", cls.network,
                   "--network-alias", "gateway", "-v", f"{legacy / 'krakend.json'}:/etc/krakend/krakend.json:ro",
                   "-v", f"{key}:/etc/krakend/symmetric.json:ro", "devopsfaith/krakend:2.6.0",
                   "run", "-c", "/etc/krakend/krakend.json")
            cls.containers.append(cls.network + "-legacy-gateway")
            cls.start_edge("legacy", legacy / "envoy.yaml", cls.runtime_key)

    @classmethod
    def start_edge(cls, mode, config, key, ready_status=200):
        name = cls.network + "-" + mode
        mounts = ["-v", f"{config}:/etc/envoy/envoy.yaml:ro", "-v", f"{key}:/etc/envoy/secrets/symmetric.json:ro",
                  "-v", f"{ROOT / 'edge.lua'}:/etc/envoy/edge.lua:ro"]
        common = ["--user", "101:101", "--cap-drop", "ALL",
                  "--security-opt", "no-new-privileges", "--entrypoint", "envoy"]
        docker("run", "--rm", *common, *mounts, IMAGE, "--mode", "validate", "-c", "/etc/envoy/envoy.yaml")
        docker("run", "-d", "--name", name, "--network", cls.network, "-p", "127.0.0.1::8080",
               *common, *mounts, IMAGE, "-c", "/etc/envoy/envoy.yaml", "--concurrency", "2", "--log-level", "error")
        cls.containers.append(name)
        cls.ports[mode] = int(docker("port", name, "8080/tcp").rsplit(":", 1)[1])
        for _ in range(60):
            try:
                if cls.request("GET", "/envoy-health", mode=mode)[0] == ready_status:
                    time.sleep(1)  # DNS cluster warmup
                    return
            except OSError:
                pass
            time.sleep(.2)
        raise RuntimeError("Envoy failed readiness: " + docker("logs", name))

    @classmethod
    def cleanup(cls):
        for name in reversed(cls.containers):
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        subprocess.run(["docker", "network", "rm", cls.network], capture_output=True)
        cls.temp.cleanup()

    @classmethod
    def request(cls, method, path, headers=None, body=None, mode="dev"):
        conn = http.client.HTTPConnection("127.0.0.1", cls.ports[mode], timeout=65 if ARGS.long_stream else 12)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            res = conn.getresponse()
            return res.status, res.getheaders(), res.read()
        finally:
            conn.close()

    @classmethod
    def raw_request(cls, headers, mode="dev", path="/api/v1/me"):
        conn = http.client.HTTPConnection("127.0.0.1", cls.ports[mode], timeout=12)
        try:
            conn.putrequest("GET", path)
            for name, value in headers:
                conn.putheader(name, value)
            conn.endheaders()
            res = conn.getresponse()
            return res.status, res.read()
        finally:
            conn.close()

    def test_token_source_ambiguity_and_claim_schema(self):
        user = self.token({"sub": "user-principal", "username": "user-name", "role": "user", "iat": 100})
        admin = self.token({"sub": "admin-principal", "username": "admin-name", "role": "admin", "iat": 200})
        ambiguous = [
            [("Cookie", "access_token=" + user), ("Authorization", "Bearer " + admin)],
            [("Cookie", "access_token=" + admin), ("Authorization", "Bearer " + user)],
            [("Cookie", "access_token=" + user), ("Authorization", "Bearer bad")],
            [("Cookie", "access_token=bad"), ("Authorization", "Bearer " + user)],
            [("Cookie", "access_token=" + user + "; access_token=" + admin)],
            [("Cookie", "access_token=" + admin + "; access_token=" + user)],
            [("Cookie", "access_token=" + user), ("Cookie", "access_token=" + admin)],
            [("Authorization", "Bearer " + user), ("aUtHoRiZaTiOn", "Bearer " + admin)],
            [("Authorization", "Bearer " + admin), ("Authorization", "Bearer " + user)],
            [("Cookie", "access_token=" + user), ("Authorization", "Bearer " + user)],
            [("Cookie", "access_token=" + user + "; access_token=" + user)],
            [("Cookie", "access_token=" + user), ("Authorization", "Basic ignored")],
        ]
        forged = list(self.identity().items()) + [(name, "duplicate-forged") for name in
            ("x-user-id", "x-role", "x-username", "x-token-iat")]
        for mode in ("dev", "prod"):
            for index, headers in enumerate(ambiguous):
                for spoof in ([], forged):
                    with self.subTest(mode=mode, ambiguous=index, forged=bool(spoof)):
                        self.assertEqual(self.raw_request(headers + spoof, mode)[0], 401)
            for source in ("cookie", "bearer"):
                headers = [("Cookie", "access_token=" + user)] if source == "cookie" else [("Authorization", "Bearer " + user)]
                status, body = self.raw_request(headers + forged, mode)
                self.assertEqual(status, 200)
                identity = {k.lower(): v for k, v in json.loads(body)["headers"].items()}
                self.assertEqual([identity[k] for k in ("x-user-id", "x-role", "x-username", "x-token-iat")],
                                 ["user-principal", "user", "user-name", "100"])
            malformed = [{claim: None} for claim in ("sub", "role", "username", "iat")]
            malformed += [{"sub": []}, {"role": {}}, {"role": True}, {"role": "unknown"},
                          {"sub": ""}, {"username": ["admin"]}, {"username": ""}, {"username": "a\nb"},
                          {"iat": "bad"}, {"iat": -1}, {"iat": True}, {"iat": 100.5}]
            for claims in malformed:
                with self.subTest(mode=mode, claims=claims):
                    status, _ = self.raw_request([("Cookie", "access_token=" + self.token(claims))] + forged, mode)
                    self.assertIn(status, (401, 403))

    def test_lua_errors_fail_closed_and_native_sanitization(self):
        for index, code in enumerate((
            'function envoy_on_request(h) error("injected before sanitizer") end',
            'function envoy_on_request(h) h:headers():remove("x-role"); error("injected mid-sanitizer") end',
        )):
            config = yaml.safe_load((ROOT / "envoy.yaml").read_text())
            hcm = config["static_resources"]["listeners"][0]["filter_chains"][0]["filters"][0]["typed_config"]
            sanitizer = next(f for f in hcm["http_filters"] if f["name"] == "envoy.filters.http.lua")
            sanitizer["typed_config"]["default_source_code"] = {"inline_string": code}
            path = self.directory / f"fault-{index}.yaml"
            path.write_text(yaml.safe_dump(config))
            # Health is deliberately fail-closed too; readiness uses raw TCP startup below.
            mode = f"fault-{index}"
            self.start_edge(mode, path, self.runtime_key, ready_status=403)
            for target in ("/api/v1/me", "/api/v1/problems"):
                status, _ = self.raw_request([("Cookie", "access_token=" + self.token())] + list(self.identity().items()), mode, target)
                self.assertEqual(status, 403)
            result = subprocess.run(["docker", "logs", self.network + "-" + mode], capture_output=True, text=True, check=True)
            logs = result.stdout + result.stderr
            self.assertIn("injected", logs)

    def test_nonroot_runtime_and_owner_only_key(self):
        name = self.network + "-dev"
        output = docker("exec", name, "/bin/bash", "-ec",
            'test "$(id -u)" = 101; test ! -w /etc/envoy/secrets/symmetric.json; '
            'test "$(stat -c %a /etc/envoy/secrets/symmetric.json)" = 400; '
            'grep -Eq "^CapEff:[[:space:]]+0+$" /proc/1/status; '
            'grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/1/status')
        self.assertEqual(output, "")
        self.assertEqual((self.directory / "symmetric.json").stat().st_mode & 0o777, 0o600)

    def test_cors_scope_and_malformed_inputs(self):
        for mode in ("dev", "prod"):
            self.assertEqual(self.raw_request([("X-Role", "admin\x00forged")], mode)[0], 400)
            for query in ("search=%zz", "search=&page=1&&page=2", "%73earch=a%2Bb", "search=x;admin=1"):
                status, _, _ = self.request("GET", "/api/v1/problems?" + query, self.identity(), mode=mode)
                self.assertEqual(status, 200)
            for path in ("/envoy-health", "/events/submissions/1?ticket=fixture"):
                status, headers, _ = self.request("GET", path, {"Origin": "http://localhost:3000"}, mode=mode)
                self.assertEqual(status, 200)
                self.assertNotIn("access-control-allow-origin", {k.lower(): v for k, v in headers})
        for path in ("/", "/avatars/example.png"):
            for method in ("GET", "OPTIONS"):
                status, headers, body = self.request(method, path, {"Origin": "http://localhost:3000",
                    "Access-Control-Request-Method": "GET"}, mode="prod")
                self.assertEqual(status, 200)  # upstream response, never API preflight conversion
                self.assertNotIn("access-control-allow-origin", {k.lower(): v for k, v in headers})
                self.assertEqual(json.loads(body)["method"], method)

    def token(self, claims=None, secret=None, alg="HS256"):
        payload = {"iss": "auth-service", "sub": "edge-user", "role": "user", "username": "edge-name",
                   "iat": int(time.time()) - 5, "exp": int(time.time()) + 600}
        payload.update(claims or {})
        payload = {k: v for k, v in payload.items() if v is not None}
        data = b64(json.dumps({"alg": alg, "typ": "JWT"}).encode()) + "." + b64(json.dumps(payload).encode())
        digest = {"HS256": hashlib.sha256, "HS384": hashlib.sha384, "HS512": hashlib.sha512}.get(alg, hashlib.sha256)
        return data + "." + b64(hmac.new(secret or self.secret, data.encode(), digest).digest())

    def identity(self):
        return {"X-User-ID": "victim", "X-Role": "admin", "X-Username": "forged", "X-Token-Iat": "9999999999",
                "X-Forwarded-For": "198.51.100.99", "X-Real-IP": "198.51.100.99", "Forwarded": "for=198.51.100.99",
                "X-Client-IP": "198.51.100.99", "X-Forwarded-Client-Cert": "forged"}

    def test_every_route_and_claim_contract(self):
        routes = json.loads((ROOT / "routes.json").read_text())
        self.assertEqual(len(routes), 50)
        for mode in ("dev", "prod"):
            for route in routes:
                with self.subTest(mode=mode, route=route["path"], method=route["method"]):
                    path = re.sub(r"\{[^}]+\}", "sample", route["path"])
                    headers = {**self.identity(), "Cookie": "access_token=" + self.token()}
                    status, _, body = self.request(route["method"], path, headers, mode=mode)
                    self.assertEqual(status, 200)
                    data = json.loads(body)
                    self.assertEqual(data["service_port"], {"auth-service": 8081, "problem-service": 8082, "submission-service": 8083}[route["service"]])
                    self.assertEqual((data["method"], data["path"]), (route["method"], path))
                    received = {k.lower(): v for k, v in data["headers"].items()}
                    for key in ("x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-client-cert"):
                        self.assertNotIn(key, received)
                    self.assertNotEqual(received.get("x-client-ip"), "198.51.100.99")
                    if route["auth"]:
                        self.assertEqual(received["x-user-id"], "edge-user")
                        self.assertEqual(received["x-role"], "user")
                        self.assertEqual(received["x-username"], "edge-name")
                        self.assertTrue(received["x-token-iat"].isdigit())
                        self.assertEqual(self.request(route["method"], path, self.identity(), mode=mode)[0], 401)
                    else:
                        self.assertNotIn("x-role", received)
                        self.assertNotIn("x-user-id", received)

    def test_invalid_tokens_fail_closed(self):
        for label, token in [("malformed", "garbage"), ("signature", self.token(secret=b"wrong-key")),
                             ("expired", self.token({"exp": int(time.time()) - 120})),
                             ("nbf", self.token({"nbf": int(time.time()) + 600})),
                             ("HS384", self.token(alg="HS384")), ("HS512", self.token(alg="HS512"))]:
            with self.subTest(token=label):
                self.assertEqual(self.request("GET", "/api/v1/me", {**self.identity(), "Cookie": "access_token=" + token})[0], 401)
        self.assertEqual(self.request("GET", "/api/v1/me", {"Authorization": "Bearer " + self.token()})[0], 200)
        self.assertEqual(self.request("GET", "/api/v1/problems", {"Cookie": "access_token=expired"})[0], 200)
        # Missing verified claims cannot fall back to client-controlled identity.
        status, _, _ = self.request("GET", "/api/v1/me", {**self.identity(), "Cookie": "access_token=" + self.token({"role": None, "iat": None})})
        self.assertEqual(status, 403)  # native RBAC rejects malformed verified identity

    def test_methods_unknown_paths_and_encoding(self):
        for mode in ("dev", "prod"):
            for method, path in [("DELETE", "/api/v1/auth/login"), ("HEAD", "/api/v1/me"),
                                 ("GET", "/api/v1/health"), ("GET", "/api/v1/auth/internal"),
                                 ("GET", "/events/health"), ("POST", "/events/submissions/1"),
                                 ("GET", "/api/v1/admin/problems/1/extra")]:
                self.assertEqual(self.request(method, path, mode=mode)[0], 404)
        self.assertEqual(self.request("GET", "/api/v1/users/alice%2Fadmin/profile")[0], 400)
        status, _, body = self.request("GET", "/api/v1/users/alice%20smith/profile")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["path"], "/api/v1/users/alice%20smith/profile")

    def test_query_upload_cookies_and_backend_errors(self):
        status, _, body = self.request("GET", "/api/v1/problems?search=a%2Bb+%26c&page=1&page=2&ignored=1")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["path"], "/api/v1/problems?search=a%2Bb+%26c&page=1&page=2")
        multipart = b'--boundary\r\nContent-Disposition: form-data; name="file"; filename="x.zip"\r\n\r\n\x00\xff\r\n--boundary--\r\n'
        for path in ("/api/v1/admin/problems/1/testcases", "/api/v1/me/avatar"):
            status, headers, body = self.request("POST", path, {"Cookie": "access_token=" + self.token(),
                "Content-Type": "multipart/form-data; boundary=boundary", "X-Fixture-Status": "422"}, multipart)
            self.assertEqual(status, 422)
            self.assertEqual(base64.b64decode(json.loads(body)["body"]), multipart)
            self.assertEqual(len([h for h in headers if h[0].lower() == "set-cookie"]), 2)
            self.assertIn(("retry-after", "7"), [(k.lower(), v) for k, v in headers])
        status, headers, body = self.request("POST", "/api/v1/auth/refresh-token", {
            "Cookie": "access_token=expired; refresh_token=refresh", "X-Unlisted": "removed"})
        self.assertEqual(status, 200)
        self.assertNotIn("X-Unlisted", json.loads(body)["headers"])
        self.assertEqual(len([h for h in headers if h[0].lower() == "set-cookie"]), 2)

    def test_timeouts_and_untrusted_overrides(self):
        status, _, body = self.request("GET", "/api/v1/problems", {"x-fixture-delay": "4",
            "x-envoy-upstream-rq-timeout-ms": "10000", "x-envoy-retry-on": "5xx"})
        self.assertEqual((status, body), (500, b""))
        status, _, _ = self.request("POST", "/api/v1/submissions/run", {
            "Cookie": "access_token=" + self.token(), "x-fixture-delay": "4"}, b'{}')
        self.assertEqual(status, 200)

    def test_cors_and_streaming_and_production_routes(self):
        status, headers, _ = self.request("OPTIONS", "/api/v1/me", {"Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "PATCH", "Access-Control-Request-Headers": "content-type"})
        self.assertEqual(status, 204)
        self.assertIn(("access-control-allow-credentials", "true"), [(k.lower(), v) for k, v in headers])
        start = time.monotonic()
        status, headers, body = self.request("GET", "/events/submissions/1?ticket=fixture" + ("&long=1" if ARGS.long_stream else ""))
        self.assertEqual(status, 200)
        self.assertIn(b"data: 4", body)
        self.assertGreater(time.monotonic() - start, 4)
        if ARGS.long_stream:
            self.assertIn(b"data: 46", body)
            self.assertGreater(time.monotonic() - start, 45)
        for path, port in [("/", 3000), ("/avatars/example.png", 9000)]:
            self.assertEqual(json.loads(self.request("GET", path, mode="prod")[2])["service_port"], port)

    @unittest.skipUnless(ARGS.legacy, "optional old gateway differential comparison")
    def test_legacy_equivalence(self):
        for route in json.loads((ROOT / "routes.json").read_text()):
            path = re.sub(r"\{[^}]+\}", "sample", route["path"])
            query = route["query"]
            if query and query != ["*"]:
                path += "?" + query[0] + "=a%2Bb&ignored=1"
            headers = {"Cookie": "access_token=" + self.token(), "Content-Type": "application/json"}
            payload = b'{}' if route["method"] in ("POST", "PUT", "PATCH") else None
            old = self.request(route["method"], path, headers, payload, mode="legacy")
            new = self.request(route["method"], path, headers, payload)
            self.assertEqual(old[0], new[0], route["path"])
            left, right = json.loads(old[2]), json.loads(new[2])
            for field in ("method", "path", "service_port", "body"):
                self.assertEqual(left[field], right[field], route["path"])
        for claims in ([{"exp": int(time.time()) - age} for age in (1, 10, 31, 59, 61, 120)] + [{"nbf": int(time.time()) + 600}, {"exp": None}]):
            headers = {"Cookie": "access_token=" + self.token(claims)}
            with self.subTest(claims=claims):
                self.assertEqual(self.request("GET", "/api/v1/me", headers, mode="legacy")[0],
                                 self.request("GET", "/api/v1/me", headers)[0])
        old = self.request("GET", "/api/v1/problems", {"x-fixture-delay": "4"}, mode="legacy")
        new = self.request("GET", "/api/v1/problems", {"x-fixture-delay": "4"})
        self.assertEqual((old[0], old[2]), (new[0], new[2]), "ordinary API timeout response")
        for cookie in ("", "access_token=invalid", "access_token=" + self.token({"exp": int(time.time()) - 120})):
            old = self.request("GET", "/api/v1/me", {"Cookie": cookie}, mode="legacy")
            new = self.request("GET", "/api/v1/me", {"Cookie": cookie})
            self.assertEqual((old[0], old[2]), (new[0], new[2]), "JWT rejection response")
        for origin in ("http://localhost:3000", "https://untrusted.example"):
            for method, headers in [("GET", {"Origin": origin}), ("OPTIONS", {"Origin": origin,
                "Access-Control-Request-Method": "GET"})]:
                with self.subTest(origin=origin, method=method):
                    self.assertEqual(self.request(method, "/api/v1/problems", headers, mode="legacy")[0],
                                     self.request(method, "/api/v1/problems", headers)[0])


if __name__ == "__main__":
    unittest.main(argv=[__file__], verbosity=2)
