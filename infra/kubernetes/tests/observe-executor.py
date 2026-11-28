"""Read the actual CRI/OCI state on the dedicated test Judge after guarded activation."""

import json
import os
from pathlib import Path
import subprocess
import sys


def cri(*args):
    return json.loads(subprocess.check_output(["k3s", "crictl", *args]))


def main(namespace, pod_uid):
    rows = [
        c
        for c in cri("ps", "-o", "json")["containers"]
        if c["metadata"]["name"] == "go-judge"
        and c["labels"].get("io.kubernetes.pod.namespace") == namespace
        and c["labels"].get("io.kubernetes.pod.uid") == pod_uid
    ]
    if len(rows) != 1:
        raise ValueError("expected one running executor for the selected Pod")
    info = cri("inspect", rows[0]["id"])["info"]
    pid = info["pid"]
    ns = ("pid", "net", "ipc", "mnt", "uts", "cgroup", "user")
    shared = [
        n
        for n in ns
        if os.readlink(f"/proc/{pid}/ns/{n}") == os.readlink(f"/proc/1/ns/{n}")
    ]
    if shared or any(
        d["type"] == "b" for d in info["runtimeSpec"]["linux"].get("devices", [])
    ):
        raise ValueError("executor inherited a host namespace or block device")
    path = Path(f"/proc/{pid}/cgroup").read_text().strip().split(":", 2)[2]
    scope = Path("/sys/fs/cgroup", path.lstrip("/")).parent
    controllers = set((scope / "cgroup.subtree_control").read_text().split())
    if (
        not {"cpu", "memory", "pids"} <= controllers
        or (scope / "memory.max").read_text().strip() == "max"
    ):
        raise ValueError(
            "executor lacks delegated CPU, memory, process controls or a memory ceiling"
        )
    print(
        "PASS executor namespace, OCI block device, delegated cgroup and outer memory checks"
    )


if __name__ == "__main__":
    main(*sys.argv[1:])
