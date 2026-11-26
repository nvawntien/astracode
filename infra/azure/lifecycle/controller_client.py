"""Fixed App-to-controller operations. Tokens come from the trusted host service."""

from datetime import datetime
import http.client
import json
import ssl
from urllib.parse import urlsplit
import uuid


class Controller:
    def __init__(self, endpoint, token):
        target = urlsplit(endpoint)
        if (
            target.scheme != "https"
            or not target.hostname
            or target.username
            or target.password
            or target.netloc != target.hostname
            or target.path not in ("", "/")
            or target.query
            or target.fragment
        ):
            raise ValueError("invalid protected controller endpoint")
        self.host = target.hostname
        self.token = token
        self.operation = None

    def call(self, action, **payload):
        conn = http.client.HTTPSConnection(
            self.host, timeout=5, context=ssl.create_default_context()
        )
        try:
            conn.request(
                "POST",
                "/api/v1/app/" + action,
                json.dumps(payload, default=encode),
                {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + self.token(),
                },
            )
            reply = conn.getresponse()
            if reply.status != 200:
                raise RuntimeError(f"controller refused {action} (HTTP {reply.status})")
            raw = reply.read(524289)
            if len(raw) > 524288:
                raise ValueError("oversize controller response")
            return json.loads(raw)
        finally:
            conn.close()

    def approved_operation(self, ticket):
        ticket = str(uuid.UUID(ticket))
        op = self.call("operation", ticket=ticket)
        if op["id"] != ticket:
            raise ValueError("controller returned another operation")
        op["deadline"] = timestamp(op["deadline"])
        self.operation = ticket
        return op

    def activation_state(self):
        return self.call("state", operation=self.operation)

    def authorization(self, request):
        record = self.call("authorization", operation=request["id"])
        record["until"] = timestamp(record["until"])
        return record

    def lease(self, request):
        return self.authorization(request)["until"]

    def contest_frozen(self):
        return self.call("contest", operation=self.operation)["frozen"] is not False

    def was_verified(self, digest, versions):
        return (
            self.call(
                "verified", operation=self.operation, digest=digest, versions=versions
            )["verified"]
            is True
        )

    def termination_proof(self, request):
        return self.call("termination", operation=request["id"])

    def begin_if_current(self, request, release):
        self.call("begin", operation=request["id"], release=release)

    def close_edge(self, request):
        self.call("close", operation=request["id"])

    def complete_if_current(self, request, observed, versions):
        self.call(
            "complete", operation=request["id"], observed=observed, versions=versions
        )

    def open_verified_edge(self, request):
        self.call("open", operation=request["id"])

    def require_recovery(self, request):
        self.call("recovery-required", operation=request["id"])


def timestamp(text):
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        raise ValueError("controller timestamp requires timezone")
    return dt


def encode(value):
    if isinstance(value, datetime) and value.tzinfo is not None:
        return value.isoformat()
    raise TypeError("unsupported controller value")
