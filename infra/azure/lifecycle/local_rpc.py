"""Bounded host-only request transport with fixed dispatch and peer identity."""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import pwd
import socket
import struct
import threading

from node_state import RecoveryRequired

MAX_BODY = 512 * 1024


def receive(conn):
    size = int.from_bytes(read_exact(conn, 4), "big")
    if not 0 < size <= MAX_BODY:
        raise ValueError("invalid request size")
    return json.loads(read_exact(conn, size))


def read_exact(conn, count):
    data = bytearray()
    while len(data) < count:
        part = conn.recv(count - len(data))
        if not part:
            raise ValueError("incomplete request")
        data.extend(part)
    return bytes(data)


def send(conn, obj):
    raw = json.dumps(obj, separators=(",", ":")).encode()
    if len(raw) > MAX_BODY:
        raise ValueError("message too large")
    conn.sendall(len(raw).to_bytes(4, "big") + raw)


def call(path, operation, params, timeout=10):
    with socket.socket(socket.AF_UNIX) as conn:
        conn.settimeout(timeout)
        conn.connect(str(path))
        send(conn, [operation, params])
        ok, value = receive(conn)
        if ok is not True:
            raise RecoveryRequired(f"host service refused {operation}")
        return value


def serve(path, peer, dispatch):
    uid = peer if isinstance(peer, int) else pwd.getpwnam(peer).pw_uid
    slots = threading.BoundedSemaphore(6)

    def handle(conn):
        try:
            with conn:
                conn.settimeout(8)
                _, actual, _ = struct.unpack(
                    "3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                )
                if actual != uid:
                    return
                try:
                    method, params = receive(conn)
                    if method not in dispatch or not isinstance(params, dict):
                        raise ValueError("unknown operation")
                    result = dispatch[method](**params)
                    send(conn, [True, result])
                except Exception:
                    send(conn, [False, None])
        finally:
            slots.release()

    with socket.socket(socket.AF_UNIX) as server, ThreadPoolExecutor(
        max_workers=6
    ) as pool:
        Path(path).unlink(missing_ok=True)
        server.bind(str(path))
        os.chmod(path, 0o666)
        server.listen(8)
        while True:
            slots.acquire()
            conn, _ = server.accept()
            pool.submit(handle, conn)
