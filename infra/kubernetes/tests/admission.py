"""Exercise native admission and RBAC against a disposable loopback API server."""

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import yaml


def kubectl(*args, obj=None, success=True):
    result = subprocess.run(
        ["kubectl", "--kubeconfig", os.environ["FIXTURE_KUBECONFIG"], *args],
        input=json.dumps(obj) if obj is not None else None,
        text=True, capture_output=True,
    )
    if success and result.returncode:
        raise RuntimeError(result.stderr)
    return result


def check(obj, denied=False):
    result = kubectl("create", "--dry-run=server", "--validate=strict", "-f", "-", obj=obj, success=False)
    if denied:
        if not result.returncode or "ValidatingAdmissionPolicy" not in result.stderr:
            raise AssertionError(f"Expected admission denial for {obj['metadata']['name']}: {result.stderr}")
    elif result.returncode:
        raise AssertionError(result.stderr)


def exercise(render):
    docs = list(yaml.safe_load_all(render.read_text()))
    for kind in ("Namespace", "ServiceAccount", "PodTemplate", "ValidatingAdmissionPolicy",
                 "ValidatingAdmissionPolicyBinding", "Role", "RoleBinding"):
        for d in docs:
            if d["kind"] == kind:
                kubectl("create", "-f", "-", obj=d)

    worker = next(d for d in docs if d["kind"] == "Deployment" and d["metadata"]["name"] == "judge-worker")
    # Wait for the admission plugin to observe bindings before testing denials.
    invalid = copy.deepcopy(worker)
    invalid["spec"]["template"]["spec"]["containers"][1]["image"] = "offline.invalid/unauthorized:v1"
    for _ in range(60):
        response = kubectl("create", "--dry-run=server", "-f", "-", obj=invalid, success=False)
        if "ValidatingAdmissionPolicy" in response.stderr:
            break
        time.sleep(0.5)
    else:
        raise AssertionError("Native admission did not start enforcing")
    for d in docs:
        if d["kind"] in {"Deployment", "Job"}:
            check(d)
    for key, value in (("hostPID", True), ("hostNetwork", True), ("hostIPC", True),
                       ("serviceAccountName", "default"), ("nodeName", "app"), ("hostUsers", True)):
        candidate = copy.deepcopy(worker)
        candidate["spec"]["template"]["spec"][key] = value
        if key in {"hostNetwork", "hostPID", "hostIPC"}:
            candidate["spec"]["template"]["spec"]["hostUsers"] = True
        check(candidate, denied=True)
    for mutate in (
        lambda s: s["containers"][0].update(securityContext={"privileged": True}),
        lambda s: s["containers"][1].update(image="offline.invalid/unapproved:latest"),
        lambda s: s["containers"][1].update(command=["/opt/executorserver"]),
        lambda s: s["containers"][1]["volumeMounts"][2].update(name="config"),
        lambda s: s.update(initContainers=[{"name": "extra", "image": "offline.invalid/init:v1"}]),
        lambda s: s["volumes"].append({"name": "other", "secret": {"secretName": "other"}}),
        lambda s: s["volumes"].append({"name": "runtime", "hostPath": {"path": "/run/containerd"}}),
        lambda s: s["affinity"]["nodeAffinity"]["requiredDuringSchedulingIgnoredDuringExecution"]
            ["nodeSelectorTerms"][0]["matchExpressions"][0].update(values=["app"]),
    ):
        candidate = copy.deepcopy(worker)
        mutate(candidate["spec"]["template"]["spec"])
        check(candidate, denied=True)
    candidate = copy.deepcopy(worker)
    candidate["spec"]["replicas"] = 1
    check(candidate, denied=True)
    # Only the independent activation authority opens the reference template.
    kubectl("-n", "astracode-judge", "annotate", "podtemplate/approved-judge-worker",
            "astracode.io/activation=authorized", "--overwrite")
    pod = {"apiVersion": "v1", "kind": "Pod", **copy.deepcopy(worker["spec"]["template"])}
    pod["metadata"].update(name="fixture", namespace="astracode-judge")
    for _ in range(30):
        try:
            check(pod)
            break
        except AssertionError:
            time.sleep(0.2)
    else:
        check(pod)
    pod["spec"]["containers"][0]["securityContext"] = {"privileged": True}
    check(pod, denied=True)
    for ns in ("astracode-app", "astracode-judge"):
        for verb, resource in (("patch", "podtemplates"), ("get", "secrets"), ("create", "pods"),
                               ("patch", "networkpolicies"), ("create", "rolebindings")):
            result = kubectl("auth", "can-i", verb, resource, "-n", ns, "--as", "astra-poller", success=False)
            if result.stdout.strip() != "no":
                raise AssertionError(f"Unexpected authorization result for {ns}/{resource}: {result.stdout}")
    print("Native admission accepted the reviewed templates and rejected unauthorized changes. RBAC checks passed.")


if __name__ == "__main__":
    # Never run against an inferred operator context.
    config = yaml.safe_load(Path(os.environ["FIXTURE_KUBECONFIG"]).read_text())
    if len(config["clusters"]) != 1 or not config["clusters"][0]["cluster"]["server"].startswith("https://127.0.0.1:"):
        sys.exit("Requires a disposable local API server")
    exercise(Path(sys.argv[1]))
