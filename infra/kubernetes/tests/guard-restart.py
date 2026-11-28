"""Run as root on a disposable, air-gapped K3s guest with the guard installed."""

import base64
import copy
import datetime
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


def run(*args, data=None):
    return subprocess.run(args, input=data, check=True, stdout=subprocess.PIPE).stdout


def kube(*args, data=None):
    return run("k3s", "kubectl", "-n", "guarded-fixture", *args, data=data)


def wait(check, timeout=160):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(1)
    raise RuntimeError(f"timed out waiting for {check}")


def main():
    assert os.getuid() == 0
    with tempfile.TemporaryDirectory(prefix="guard-", dir="/run") as path:
        root = Path(path)
        scope = root / "permits"
        scope.mkdir()
        run("openssl", "genpkey", "-algorithm", "Ed25519", "-out", str(root / "key"))
        public = run(
            "openssl", "pkey", "-in", str(root / "key"), "-pubout", "-outform", "DER"
        )
        (scope / "issuer.pub").write_bytes(base64.b64encode(public[-32:]))
        pod_name = root.name
        ctr = {
            "name": "fixture",
            "image": "docker.io/rancher/mirrored-library-busybox:1.37.0",
            "imagePullPolicy": "Never",
            "command": [
                "/guard",
                "submission-service",
                "--",
                "sh",
                "-ec",
                "echo started >> /evidence/starts; exec sleep 600",
            ],
            "env": [
                {
                    "name": "ASTRA_POD_UID",
                    "valueFrom": {"fieldRef": {"fieldPath": "metadata.uid"}},
                }
            ],
            "volumeMounts": [
                {"name": "guard", "mountPath": "/guard", "readOnly": True},
                {
                    "name": "permits",
                    "mountPath": "/run/astra/permits",
                    "readOnly": True,
                },
                {"name": "evidence", "mountPath": "/evidence"},
            ],
        }
        evidence = root / "evidence"
        evidence.mkdir()
        pod = {
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {"name": pod_name},
            "spec": {
                "automountServiceAccountToken": False,
                "containers": [ctr],
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
                        "hostPath": {"path": str(scope), "type": "Directory"},
                    },
                    {
                        "name": "evidence",
                        "hostPath": {"path": str(evidence), "type": "Directory"},
                    },
                ],
            },
        }
        uid = kube(
            "create",
            "-f",
            "-",
            "-o",
            "jsonpath={.metadata.uid}",
            data=json.dumps(pod).encode(),
        ).decode()
        starts = evidence / "starts"

        def restarts():
            raw = kube("get", "pod", pod_name, "-o", "json")
            states = json.loads(raw).get("status", {}).get("containerStatuses", [])
            return states[0]["restartCount"] if states else 0

        try:
            wait(lambda: restarts() > 0)
            assert not starts.exists()
            binding = dict(
                environment="s3",
                session="fixture",
                operation="fixture",
                app_epoch="app-1",
                judge_epoch="judge-1",
                workload="submission-service",
                image="fixture-image",
                config="fixture-config",
                pod_uid=uid,
            )

            def issue_and_check():
                rows = json.loads(run("k3s", "crictl", "ps", "-o", "json"))[
                    "containers"
                ]
                current = [
                    c
                    for c in rows
                    if c["labels"].get("io.kubernetes.pod.uid") == binding["pod_uid"]
                ]
                if len(current) != 1:
                    return False
                info = json.loads(run("k3s", "crictl", "inspect", current[0]["id"]))[
                    "info"
                ]
                try:
                    binding["pid_namespace"] = os.readlink(
                        f"/proc/{info['pid']}/ns/pid"
                    )
                except FileNotFoundError:
                    return False
                (scope / "binding.json").write_text(json.dumps(binding))
                now = datetime.datetime.now(datetime.timezone.utc)
                payload = json.dumps(
                    dict(
                        binding,
                        issued=now.isoformat(),
                        expires=(now + datetime.timedelta(seconds=25)).isoformat(),
                    )
                ).encode()
                (root / "payload").write_bytes(payload)
                sig = run(
                    "openssl",
                    "pkeyutl",
                    "-sign",
                    "-rawin",
                    "-inkey",
                    str(root / "key"),
                    "-in",
                    str(root / "payload"),
                )
                temp = scope / "next"
                temp.write_text(
                    json.dumps(
                        {
                            "payload": base64.b64encode(payload).decode(),
                            "signature": base64.b64encode(sig).decode(),
                        }
                    )
                )
                temp.replace(scope / "permit.json")
                return starts.exists()

            wait(issue_and_check)
            count = restarts()
            (scope / "binding.json").unlink()
            wait(lambda: restarts() > count)
            assert starts.read_text().splitlines() == ["started"]
            template = {"spec": copy.deepcopy(pod["spec"])}
            template["spec"]["restartPolicy"] = "Never"
            job = {
                "apiVersion": "batch/v1",
                "kind": "Job",
                "metadata": {"name": pod_name},
                "spec": {"suspend": True, "backoffLimit": 0, "template": template},
            }
            kube("create", "-f", "-", data=json.dumps(job).encode())
            try:
                # A persisted Job becomes runnable again while the original permit
                # file remains on disk. Neither a stale UID nor a missing binding
                # can authorize the replacement migration process.
                kube(
                    "patch",
                    "job",
                    pod_name,
                    "--type=merge",
                    "-p",
                    '{"spec":{"suspend":false}}',
                )
                kube(
                    "wait",
                    "--for=condition=Failed",
                    "job/" + pod_name,
                    "--timeout=150s",
                )
                assert starts.read_text().splitlines() == ["started"]
            finally:
                kube("delete", "job", pod_name, "--wait=true", "--timeout=120s")
            print(
                "PASS stale desired Pod and retained Job refused; signed Pod-specific permit launched once; revocation stopped child"
            )
        finally:
            kube("delete", "pod", pod_name, "--wait=true", "--timeout=120s")


if __name__ == "__main__":
    main()
