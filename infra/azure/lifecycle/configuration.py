"""Hash the public workload configuration actually mounted on a node."""

import hashlib
import json
from pathlib import Path


FILES = {
    "auth-service": ("/app/config", ("config.yaml",)),
    "problem-service": ("/app/config", ("config.yaml",)),
    "submission-service": ("/app/config", ("config.yaml",)),
    "judge-worker": ("/app/config", ("config.yaml",)),
    "envoy": ("/etc/envoy", ("edge.lua", "envoy.yaml")),
}


def mounted_config(workload, uid, mounts):
    if workload not in FILES:
        return content_digest({})
    dest, names = FILES[workload]
    paths = [
        Path(m["hostPath"])
        for m in mounts
        if m["containerPath"] == dest and m["readonly"]
    ]
    # Kubelet's projected symlinks are valid inside this one ConfigMap.
    # Never follow a path supplied by the application or traverse Secret volumes.
    if (
        len(paths) != 1
        or len(paths[0].parents) < 3
        or paths[0].parent.name != "kubernetes.io~configmap"
        or paths[0].parents[1].name != "volumes"
        or paths[0].parents[2].name != uid
    ):
        raise ValueError("missing fixed ConfigMap mount")
    root = paths[0].resolve(strict=True)
    files = {}
    for name in names:
        path = (root / name).resolve(strict=True)
        if not path.is_relative_to(root) or path.stat().st_size > 1024 * 1024:
            raise ValueError("unexpected ConfigMap projection")
        files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return content_digest(files)


def content_digest(obj):
    raw = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()
