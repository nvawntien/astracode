"""Protected App issuer and per-node permit installer. Uses no Azure credentials on Judge."""

import base64
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

from node_state import RecoveryRequired, cri

ROLES = {
    "app": {
        "website",
        "envoy",
        "auth-service",
        "problem-service",
        "submission-service",
        "migrate",
    },
    "judge": {"judge-worker", "go-judge"},
}
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")


def atomic(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
        tmp.write(data)
        tmp.flush()
        os.fchmod(tmp.fileno(), 0o644)
    os.replace(tmp.name, path)


def sign(binding, expires, issuer_key):
    now = datetime.now(timezone.utc)
    until = min(expires, now + timedelta(seconds=20))
    if until <= now:
        raise RecoveryRequired("expired controller authorization")
    payload = json.dumps(
        dict(binding, issued=now.isoformat(), expires=until.isoformat()),
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    with tempfile.TemporaryFile() as f:
        f.write(payload)
        f.seek(0)
        signature = subprocess.run(
            [
                "openssl",
                "pkeyutl",
                "-sign",
                "-rawin",
                "-inkey",
                str(issuer_key),
                "-in",
                f"/proc/self/fd/{f.fileno()}",
            ],
            pass_fds=(f.fileno(),),
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        ).stdout
    return {
        "payload": base64.b64encode(payload).decode(),
        "signature": base64.b64encode(signature).decode(),
    }


def revoke(root, workload):
    for name in ("binding.json", "permit.json"):
        (root / "permits" / workload / name).unlink(missing_ok=True)


def qualified_image(reference):
    repository, sep, pin = reference.partition("@")
    if "/" not in repository:
        repository = "docker.io/library/" + repository
    elif "." not in repository.split("/")[0] and ":" not in repository.split("/")[0]:
        repository = "docker.io/" + repository
    return repository + sep + pin


def running_image(container, inspect=cri):
    # On pinned containerd the list response's image.image is a config ID.
    # userSpecifiedImage preserves the Pod's index/manifest reference.
    requested = container["image"].get("userSpecifiedImage", "")
    if not DIGEST.fullmatch(requested.partition("@")[2]):
        raise RecoveryRequired("running container lacks a digest-qualified request")
    status = inspect("inspecti", "-o", "json", container["imageRef"])["status"]
    if (
        qualified_image(requested)
        not in {qualified_image(p) for p in status["repoDigests"]}
        or status["id"] != container["imageRef"]
    ):
        raise RecoveryRequired("local descriptor differs from the requested image")
    return requested


def install(
    role,
    slot,
    envelope,
    issuer_pem,
    root=Path("/run/astracode"),
    inspect=cri,
    expected_workload=None,
):
    raw = base64.b64decode(envelope["payload"], validate=True)
    sig = base64.b64decode(envelope["signature"], validate=True)
    with tempfile.TemporaryFile() as content, tempfile.TemporaryFile() as signature:
        content.write(raw)
        signature.write(sig)
        for f in (content, signature):
            f.seek(0)
        subprocess.run(
            [
                "openssl",
                "pkeyutl",
                "-verify",
                "-pubin",
                "-rawin",
                "-inkey",
                str(issuer_pem),
                "-sigfile",
                f"/proc/self/fd/{signature.fileno()}",
                "-in",
                f"/proc/self/fd/{content.fileno()}",
            ],
            pass_fds=(signature.fileno(), content.fileno()),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
    binding = json.loads(raw)
    now = datetime.now(timezone.utc)
    issued = datetime.fromisoformat(binding.pop("issued"))
    expires = datetime.fromisoformat(binding.pop("expires"))
    workload = binding["workload"]
    if (
        set(binding)
        != {
            "environment",
            "workload",
            "pod_uid",
            "session",
            "operation",
            "config",
            "image",
            "app_epoch",
            "judge_epoch",
            "pid_namespace",
        }
        or not all(isinstance(v, str) and v for v in binding.values())
        or not re.fullmatch(r"pid:\[[0-9]+\]", binding["pid_namespace"])
        or (expected_workload is not None and workload != expected_workload)
        or workload not in ROLES[role]
        or slot != binding["environment"]
        or binding[role + "_epoch"] != (root / "epoch").read_text().strip()
        or not issued <= now < expires
        or expires - issued > timedelta(seconds=30)
        or not DIGEST.fullmatch(binding["image"])
        or not DIGEST.fullmatch(binding["config"])
    ):
        raise RecoveryRequired("invalid permit scope")
    ns = "astracode-" + role
    matches = [
        c
        for c in inspect("ps", "-o", "json")["containers"]
        if c["metadata"]["name"] == workload
        and c["labels"].get("io.kubernetes.pod.namespace") == ns
        and c["labels"].get("io.kubernetes.pod.uid") == binding["pod_uid"]
    ]
    if (
        len(matches) != 1
        or running_image(matches[0], inspect).partition("@")[2] != binding["image"]
    ):
        raise RecoveryRequired("local CRI workload or requested digest differs")
    # The same pinned public key verifies both this transport envelope and
    # the supervisor's permit. The approved network peer can never select it.
    der = subprocess.run(
        ["openssl", "pkey", "-pubin", "-in", str(issuer_pem), "-outform", "DER"],
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    if len(der) != 44 or not der.startswith(bytes.fromhex("302a300506032b6570032100")):
        raise RecoveryRequired("invalid Ed25519 issuer")
    scope = root / "permits" / workload
    atomic(scope / "issuer.pub", base64.b64encode(der[-32:]))
    atomic(scope / "binding.json", json.dumps(binding).encode())
    atomic(scope / "permit.json", json.dumps(envelope).encode())
