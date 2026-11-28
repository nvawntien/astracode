"""Node system service. Exchange only role-scoped observations and signed grants on the private API."""

import json
import os
from pathlib import Path
import subprocess
import time

from configuration import mounted_config
from node_state import cri
from permits import install, revoke, running_image, ROLES


def api(role, *args, data=None):
    proc = subprocess.run(
        [
            "/usr/local/bin/k3s",
            "kubectl",
            "--request-timeout=4s",
            "--kubeconfig=/etc/astracode/node-observer.kubeconfig",
            "-n",
            "astracode-" + role,
            *args,
        ],
        input=data,
        capture_output=True,
        timeout=5,
        check=True,
        text=True,
    )
    return json.loads(proc.stdout) if proc.stdout else None


def observe(role):
    containers = []
    exited = []
    backing = {}
    for c in cri("ps", "-a", "-o", "json")["containers"]:
        labels = c.get("labels", {})
        if labels.get("io.kubernetes.pod.namespace") != "astracode-" + role:
            continue
        name = c["metadata"]["name"]
        if (
            role == "app"
            and name in {"postgres", "redis", "kafka", "minio"}
            and c["state"] == "CONTAINER_RUNNING"
        ):
            if name in backing:
                raise RuntimeError("ambiguous backing-store identity")
            backing[name] = running_image(c)
        if name not in ROLES[role]:
            continue
        row = {
            "workload": name,
            "uid": labels["io.kubernetes.pod.uid"],
            "image": c["image"].get("userSpecifiedImage", ""),
            "container": c["id"],
        }
        if name == "migrate":
            sandbox = cri("inspectp", "-o", "json", c["podSandboxId"])["status"]
            row["job_uid"] = sandbox["labels"]["batch.kubernetes.io/controller-uid"]
        if c["state"] == "CONTAINER_RUNNING":
            row["image"] = running_image(c)
            detail = cri("inspect", "-o", "json", c["id"])
            row["pid_namespace"] = os.readlink(
                f"/proc/{int(detail['info']['pid'])}/ns/pid"
            )
            mounts = detail["status"].get("mounts", [])
            row["config"] = mounted_config(name, row["uid"], mounts)
            containers.append(row)
        elif c["state"] == "CONTAINER_EXITED" and name in {
            "submission-service",
            "migrate",
        }:
            detail = cri("inspect", "-o", "json", c["id"])["status"]
            if int(detail["finishedAt"]) > 0:
                exited.append(
                    dict(
                        row,
                        exit_code=detail["exitCode"],
                        finished_at=int(detail["finishedAt"]),
                    )
                )
    return {
        "epoch": Path("/run/astracode/epoch").read_text().strip(),
        "containers": containers,
        "backing": backing,
        "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        "exited": sorted(exited, key=lambda row: row["finished_at"], reverse=True)[:32],
        "reported_at": int(time.time()),
    }


def run(role, slot):
    root = Path("/run/astracode")
    while True:
        try:
            observed = observe(role)
            payload = {
                "data": {"observation": json.dumps(observed, separators=(",", ":"))}
            }
            api(
                role,
                "patch",
                "configmap/node-observation",
                "--type=merge",
                "--patch-file=/dev/stdin",
                "-o",
                "json",
                data=json.dumps(payload),
            )
            obj = api(role, "get", "configmap/node-permits", "-o", "json")
            grants = json.loads(obj.get("data", {}).get("grants", "{}"))
            for workload in ROLES[role]:
                grant = grants.get(workload)
                if not grant:
                    revoke(root, workload)
                    continue
                try:
                    install(
                        role,
                        slot,
                        grant,
                        Path("/etc/astracode/permit-issuer.pub"),
                        expected_workload=workload,
                    )
                except (
                    ValueError,
                    OSError,
                    KeyError,
                    RuntimeError,
                    subprocess.SubprocessError,
                ):
                    revoke(root, workload)
        except (
            ValueError,
            OSError,
            KeyError,
            RuntimeError,
            subprocess.SubprocessError,
        ):
            for workload in ROLES[role]:
                revoke(root, workload)
        time.sleep(1)


if __name__ == "__main__":
    run(
        Path("/etc/astracode/node-role").read_text().strip(),
        Path("/etc/astracode/slot").read_text().strip(),
    )
