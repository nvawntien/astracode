"""Deliver only fixed workload secret fields using the protected App loader account."""

import base64
import http.client
import json
from pathlib import Path
import re
import subprocess

from redis_acl import render

KEYS = {
    "auth-service-runtime": {
        "DATABASE_PASSWORD",
        "REDIS_PASSWORD",
        "JWT_ACCESS_SECRET",
        "JWT_REFRESH_SECRET",
        "MINIO_ACCESS_KEY",
        "MINIO_SECRET_KEY",
        "SMTP_USERNAME",
        "SMTP_PASSWORD",
        "SMTP_HOST",
        "SMTP_PORT",
        "SMTP_SECURITY",
        "SMTP_FROM",
        "APP_FRONTEND_URL",
        "MINIO_PUBLIC_URL",
    },
    "problem-service-runtime": {
        "DATABASE_PASSWORD",
        "REDIS_PASSWORD",
        "MINIO_ACCESS_KEY",
        "MINIO_SECRET_KEY",
    },
    "submission-service-runtime": {
        "DATABASE_PASSWORD",
        "REDIS_PASSWORD",
        "SSE_TICKET_SECRET",
        "SSE_ALLOWED_ORIGIN",
    },
    "minio-runtime": {"MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"},
    "postgres-runtime": {"POSTGRES_PASSWORD"},
}


def generate(values):
    def require_distinct(items):
        if any(len(s) < 16 for s in items) or len(set(items)) != len(items):
            raise ValueError("expected distinct managed credentials")

    result = {}
    for name, keys in KEYS.items():
        item = values[name]
        if set(item) != keys or any(
            not isinstance(v, str) or not v or "\0" in v for v in item.values()
        ):
            raise ValueError("unexpected fields in " + name)
        result[name] = dict(item)
    owners = ("auth", "problem", "submission")
    require_distinct(
        [result[o + "-service-runtime"]["DATABASE_PASSWORD"] for o in owners]
        + [result["postgres-runtime"]["POSTGRES_PASSWORD"]]
    )
    require_distinct(
        [
            result[o + "-service-runtime"]["MINIO_SECRET_KEY"]
            for o in ("auth", "problem")
        ]
        + [result["minio-runtime"]["MINIO_ROOT_PASSWORD"]]
    )
    auth = result["auth-service-runtime"]
    require_distinct(
        [
            auth["JWT_ACCESS_SECRET"],
            auth["JWT_REFRESH_SECRET"],
            result["submission-service-runtime"]["SSE_TICKET_SECRET"],
        ]
    )
    result["redis-runtime"] = {
        "users.acl": render(
            {o: result[o + "-service-runtime"]["REDIS_PASSWORD"] for o in owners}
        ).decode()
    }
    key = (
        base64.urlsafe_b64encode(auth["JWT_ACCESS_SECRET"].encode())
        .decode()
        .rstrip("=")
    )
    result["envoy-jwk"] = {
        "symmetric.json": json.dumps(
            {"keys": [{"kty": "oct", "k": key, "alg": "HS256", "use": "sig"}]}
        )
    }
    return result


def read_vault(host, name, access):
    if (
        not re.fullmatch(r"[a-z][a-z0-9-]{1,22}[a-z0-9]\.vault\.azure\.net", host)
        or name not in KEYS
    ):
        raise ValueError("unexpected vault or object")
    conn = http.client.HTTPSConnection(host, timeout=5)
    try:
        conn.request(
            "GET",
            f"/secrets/{name}?api-version=7.4",
            headers={"Authorization": "Bearer " + access},
        )
        response = conn.getresponse()
        if response.status != 200:
            raise RuntimeError("managed secret unavailable")
        raw = response.read(32769)
        if len(raw) > 32768:
            raise ValueError("oversize managed secret")
        return json.loads(json.loads(raw)["value"])
    finally:
        conn.close()


def deliver_runtime(settings, access):
    data = generate(
        {name: read_vault(settings["vault_host"], name, access) for name in KEYS}
    )
    for name, fields in data.items():
        argv = [
            "/usr/local/bin/k3s",
            "kubectl",
            "--kubeconfig=/etc/astracode/secret-loader.kubeconfig",
            "--request-timeout=5s",
            "-n",
            "astracode-app",
        ]
        get = subprocess.check_output(
            [*argv, "get", "secret/" + name, "-o", "json"], timeout=8
        )
        old = json.loads(get)
        encoded = {k: base64.b64encode(v.encode()).decode() for k, v in fields.items()}
        if encoded == (old.get("data") or {}):
            continue
        patch = {
            "metadata": {"resourceVersion": old["metadata"]["resourceVersion"]},
            "data": dict(dict.fromkeys((old.get("data") or {}).keys()), **encoded),
        }
        subprocess.run(
            [
                *argv,
                "patch",
                "secret/" + name,
                "--type=merge",
                "--patch-file=/dev/stdin",
                "-o",
                "name",
            ],
            input=json.dumps(patch).encode(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=8,
        )


if __name__ == "__main__":
    from host_services import identity_token

    settings = json.loads(Path("/etc/astracode/secret-loader.json").read_text())
    access = identity_token(settings["loader_client_id"], "https://vault.azure.net")
    deliver_runtime(settings, access)
