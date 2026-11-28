"""Deliver one migration attempt to its fixed Kubernetes Secret over a host-local socket."""

import base64
import json
import os
from pathlib import Path
import pwd
import re
import socket
import struct
import subprocess
import uuid

SOCKET = "/run/astra-attempt/loader.sock"
OWNERS = ("auth", "problem", "submission")


def deliver(attempt, passwords):
    with socket.socket(socket.AF_UNIX) as conn:
        conn.settimeout(8)
        conn.connect(SOCKET)
        conn.sendall(json.dumps({"attempt": attempt, "passwords": passwords}).encode())
        conn.shutdown(socket.SHUT_WR)
        if conn.recv(16) != b"OK":
            raise RuntimeError("attempt credential update refused")


def update(message):
    attempt = str(uuid.UUID(message["attempt"]))
    values = message["passwords"]
    if values is not None and (
        set(values) != set(OWNERS)
        or not all(
            isinstance(p, str) and re.fullmatch("[a-f0-9]{64}", p)
            for p in values.values()
        )
    ):
        raise ValueError("invalid attempt credential set")
    # Conditional writes bind cleanup to the same attempt. A retry for a
    # different generation cannot erase the currently active Job's password.
    args = [
        "/usr/local/bin/k3s",
        "kubectl",
        "--request-timeout=5s",
        "--kubeconfig=/etc/astracode/secret-loader.kubeconfig",
        "-n",
        "astracode-app",
    ]
    raw = subprocess.check_output(
        [*args, "get", "secret/migrate-attempt", "-o", "json"], timeout=7
    )
    secret = json.loads(raw)
    previous = secret.get("data", {}).get("operation")
    encoded = base64.b64encode(attempt.encode()).decode()
    if previous and previous != encoded:
        raise ValueError("another migration attempt requires reconciliation")
    if values is None and not previous:
        return
    data = {name: None for name in (*OWNERS, "operation")}
    if values is not None:
        data.update(
            {name: base64.b64encode(p.encode()).decode() for name, p in values.items()}
        )
        data["operation"] = encoded
    patch = {
        "metadata": {"resourceVersion": secret["metadata"]["resourceVersion"]},
        "data": data,
    }
    subprocess.run(
        [
            *args,
            "patch",
            "secret/migrate-attempt",
            "--type=merge",
            "--patch-file=/dev/stdin",
            "-o",
            "name",
        ],
        input=json.dumps(patch).encode(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=7,
        check=True,
    )


def serve():
    poller = pwd.getpwnam("astra-activation")
    Path(SOCKET).unlink(missing_ok=True)
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(SOCKET)
        os.chmod(SOCKET, 0o666)
        server.listen(4)
        while True:
            conn, _ = server.accept()
            with conn:
                conn.settimeout(3)
                _, uid, _ = struct.unpack(
                    "3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                )
                if uid != poller.pw_uid:
                    continue
                try:
                    with conn.makefile("rb") as reader:
                        body = reader.read(2049)
                    if len(body) > 2048:
                        raise ValueError("oversize attempt request")
                    update(json.loads(body))
                    conn.sendall(b"OK")
                except (
                    ValueError,
                    TypeError,
                    KeyError,
                    OSError,
                    subprocess.SubprocessError,
                ):
                    # Payload and kubectl diagnostics can contain credentials.
                    continue


if __name__ == "__main__":
    serve()
