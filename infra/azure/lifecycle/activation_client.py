"""Fixed Unix-socket access to the App activation service."""

from datetime import datetime
import uuid

import local_rpc


class ActivationClient:
    def __init__(self, socket_path):
        self.socket_path = socket_path
        self.operation = None

    def call(self, action, **payload):
        return local_rpc.call(self.socket_path, action, payload, timeout=20)

    def approved_operation(self, ticket):
        ticket = str(uuid.UUID(ticket))
        op = self.call("operation", ticket=ticket)
        if op["id"] != ticket:
            raise ValueError("activation record returned another operation")
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
        raise ValueError("activation timestamp requires timezone")
    return dt


def encode(value):
    if isinstance(value, datetime) and value.tzinfo is not None:
        return value.isoformat()
    raise TypeError("unsupported activation value")
