"""Prepare/observe an unclean restart on a disposable K3s VM, never on a real environment."""

import json
import subprocess
import sys
import time
from pathlib import Path


NS = "guarded-fixture"
ROOT = Path("/var/lib/astra-fixture-hard-stop")
BOOT = Path("/proc/sys/kernel/random/boot_id")
NAMES = ("submission-service", "judge-worker", "migrate")


def kube(*args, body=None):
    return subprocess.check_output(
        ["k3s", "kubectl", "-n", NS, *args],
        input=json.dumps(body).encode() if body else None,
    )


def main(mode):
    nodes = json.loads(kube("get", "nodes", "-o", "json"))["items"]
    if len(nodes) != 1 or nodes[0]["metadata"]["name"] != "m013-fixture":
        raise RuntimeError("requires the disposable m013-fixture node")
    if mode == "prepare":
        ROOT.mkdir()
        (ROOT / "boot").write_text(BOOT.read_text())
        for name in NAMES:
            pod = {
                "metadata": {"labels": {"fixture": name}},
                "spec": {
                    "automountServiceAccountToken": False,
                    "restartPolicy": "Never" if name == "migrate" else "Always",
                    "containers": [
                        {
                            "name": name,
                            "image": "docker.io/rancher/mirrored-library-busybox:1.37.0",
                            "imagePullPolicy": "Never",
                            "command": [
                                "/guard",
                                name,
                                "--",
                                "sh",
                                "-ec",
                                "echo started >> /evidence/"
                                + name
                                + "; exec sleep 120",
                            ],
                            "env": [
                                {
                                    "name": "ASTRA_POD_UID",
                                    "valueFrom": {
                                        "fieldRef": {"fieldPath": "metadata.uid"}
                                    },
                                }
                            ],
                            "volumeMounts": [
                                {
                                    "name": "guard",
                                    "mountPath": "/guard",
                                    "readOnly": True,
                                },
                                {
                                    "name": "permits",
                                    "mountPath": "/run/astra/permits",
                                    "readOnly": True,
                                },
                                {"name": "evidence", "mountPath": "/evidence"},
                            ],
                        }
                    ],
                    "volumes": [
                        {
                            "name": "guard",
                            "hostPath": {
                                "path": "/usr/local/bin/astra-launch-guard",
                                "type": "File",
                            },
                        },
                        {
                            "name": "permits",
                            "hostPath": {
                                "path": "/run/astra-hard-stop/" + name,
                                "type": "DirectoryOrCreate",
                            },
                        },
                        {
                            "name": "evidence",
                            "hostPath": {"path": str(ROOT), "type": "Directory"},
                        },
                    ],
                },
            }
            if name == "migrate":
                obj = {
                    "kind": "Job",
                    "apiVersion": "batch/v1",
                    "metadata": {"name": "hard-stop-" + name},
                    "spec": {"backoffLimit": 0, "suspend": True, "template": pod},
                }
            else:
                obj = {
                    "kind": "Deployment",
                    "apiVersion": "apps/v1",
                    "metadata": {"name": "hard-stop-" + name},
                    "spec": {
                        "replicas": 1,
                        "selector": {"matchLabels": {"fixture": name}},
                        "template": pod,
                    },
                }
            kube("create", "-f", "-", body=obj)
        # Preserve the desired state in SQLite. Simulate a retained Job becoming
        # runnable at the time the VM is cut. No runtime permits have been issued.
        kube(
            "patch",
            "job/hard-stop-migrate",
            "--type=merge",
            "-p",
            '{"spec":{"suspend":false}}',
        )
        subprocess.run(["sync"], check=True)
    elif mode == "verify":
        if BOOT.read_text() == (ROOT / "boot").read_text():
            raise RuntimeError("requires a different VM boot")
        for name in NAMES[:-1]:
            kube("get", "deployment/hard-stop-" + name)
        kube("get", "job/hard-stop-migrate")
        deadline = time.monotonic() + 190
        while time.monotonic() < deadline:
            failures = 0
            for name in NAMES[:-1]:
                items = json.loads(
                    kube("get", "pods", "-l", "fixture=" + name, "-o", "json")
                )["items"]
                for pod in items:
                    for c in pod.get("status", {}).get("containerStatuses", []):
                        if (
                            c.get("lastState", {}).get("terminated", {}).get("exitCode")
                            == 1
                        ):
                            failures += 1
            if failures == 2:
                break
            time.sleep(2)
        else:
            raise RuntimeError("guarded application containers did not refuse startup")
        kube(
            "wait", "--for=condition=Failed", "job/hard-stop-migrate", "--timeout=120s"
        )
        if any((ROOT / n).exists() for n in NAMES):
            raise RuntimeError("unauthorized simulated child activity")
        print(
            "PASS new boot; retained Deployments and migration Job closed; no child wrote to the persisted volume"
        )
    else:
        raise ValueError("expected prepare or verify")


if __name__ == "__main__":
    main(sys.argv[1])
