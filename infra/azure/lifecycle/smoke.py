"""Exercise a designated, pre-authorized smoke fixture over the protected HTTPS ingress."""

import http.client
import json
import ssl
import time
from urllib.parse import urlencode, urlsplit
from uuid import UUID


class SmokeFailed(RuntimeError):
    pass


def smoke(origin, tls, fixture, check_lease):
    url = urlsplit(origin)
    if (
        url.scheme != "https"
        or url.username
        or url.password
        or url.path not in ("", "/")
        or url.query
        or url.fragment
    ):
        raise SmokeFailed("invalid smoke origin")
    context = ssl.create_default_context(cafile=tls["ca"])
    context.load_cert_chain(tls["cert"], tls["key"])
    until = time.monotonic() + 120

    def request(method, path, body=None, token=None, stream=False):
        check_lease()
        remaining = until - time.monotonic()
        if remaining <= 0:
            raise SmokeFailed("smoke deadline exceeded")
        conn = http.client.HTTPSConnection(
            url.hostname, url.port or 443, context=context, timeout=min(remaining, 40)
        )
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        try:
            conn.request(
                method,
                path,
                json.dumps(body).encode() if body is not None else None,
                headers,
            )
            response = conn.getresponse()
            if not 200 <= response.status < 300:
                raise SmokeFailed(f"smoke API returned HTTP {response.status}")
            if stream:
                if (
                    response.getheader("Content-Type", "").split(";")[0]
                    != "text/event-stream"
                ):
                    raise SmokeFailed("unexpected SSE content type")
                event = None
                for _ in range(32):
                    check_lease()
                    line = response.readline(65537)
                    if not line or len(line) > 65536 or time.monotonic() >= until:
                        break
                    key, _, value = line.decode().partition(":")
                    if key == "event":
                        event = value.strip()
                    elif key == "data" and event in {
                        "submission.snapshot",
                        "submission.updated",
                        "submission.completed",
                    }:
                        return json.loads(value)
                raise SmokeFailed("missing submission stream event")
            raw = response.read(2**20 + 1)
            if len(raw) > 2**20:
                raise SmokeFailed("smoke response too large")
            return json.loads(raw)["data"]
        finally:
            conn.close()

    token = request("POST", "/api/v1/auth/login", fixture["tester"])["access_token"]
    admin = request("POST", "/api/v1/auth/login", fixture["moderator"])["access_token"]
    problem = request("GET", "/api/v1/problems/" + fixture["slug"], token=token)
    body = fixture["submission"]
    if problem["id"] != body["problem_id"]:
        raise SmokeFailed("catalog fixture does not match")
    sid = int(request("POST", "/api/v1/submissions", body, token)["id"])
    path = f"/api/v1/submissions/{sid}"
    ticket = request("POST", path + "/events/ticket", token=token)["ticket"]
    event = request(
        "GET",
        f"/events/submissions/{sid}?" + urlencode({"ticket": ticket}),
        stream=True,
    )
    if event["submission_id"] != sid:
        raise SmokeFailed("wrong stream identity")

    def verdict(attempt=None):
        while time.monotonic() < until:
            detail = request("GET", path, token=token)
            if (attempt is None or attempt == detail["attempt_id"]) and detail[
                "status"
            ] == "ACCEPTED":
                return str(UUID(detail["attempt_id"]))
            if detail["status"] not in {"PENDING", "JUDGING", "ACCEPTED"}:
                raise SmokeFailed("unexpected fixture verdict")
            time.sleep(0.5)
        raise SmokeFailed("fixture verdict timed out")

    initial = verdict()
    new = str(
        UUID(
            request("POST", f"/api/v1/admin/submissions/{sid}/rejudge", token=admin)[
                "attempt_id"
            ]
        )
    )
    if initial == new or verdict(new) != new:
        raise SmokeFailed("rejudge correlation failed")
    result = request(
        "POST",
        "/api/v1/submissions/run",
        dict(body, testcases=[fixture["custom_case"]]),
        token,
    )
    if (
        result["status"] != "completed"
        or len(result["tests"]) != 1
        or result["tests"][0]["stdout"].strip() != fixture["expected_stdout"].strip()
    ):
        raise SmokeFailed("interactive fixture failed")
