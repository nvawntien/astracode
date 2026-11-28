"""Fixed Kubernetes mutations for the App poller and its separate permit issuer."""

from datetime import datetime, timezone, timedelta
import json
import hashlib
import re
import subprocess
import time

from node_state import RecoveryRequired
from permits import DIGEST, sign
from configuration import FILES, content_digest


APP = ("auth-service", "problem-service", "submission-service", "website", "envoy")
EXECUTION = ("judge-worker", "go-judge")


class Cluster:
    def __init__(self, role, kubeconfig):
        if role not in {"app", "judge"}:
            raise ValueError("unknown node role")
        self.role = role
        self.config = kubeconfig

    def call(self, *args, patch=None, body=None):
        argv = [
            "/usr/local/bin/k3s",
            "kubectl",
            "--request-timeout=5s",
            "--kubeconfig",
            str(self.config),
            "-n",
            "astracode-" + self.role,
            *args,
        ]
        if patch is not None:
            argv.extend(["--type=merge", "--patch-file=/dev/stdin"])
        content = patch if patch is not None else body
        proc = subprocess.run(
            [*argv, "-o", "json"],
            input=json.dumps(content) if content is not None else None,
            text=True,
            capture_output=True,
            timeout=8,
            check=True,
        )
        return json.loads(proc.stdout) if proc.stdout.strip() else None

    def retire_migration(self, job):
        if self.role != "app" or job["metadata"]["name"] != "migrate":
            raise RecoveryRequired("invalid migration target")
        path = "/apis/batch/v1/namespaces/astracode-app/jobs/migrate"
        meta = job["metadata"]
        body = {
            "apiVersion": "v1",
            "kind": "DeleteOptions",
            "propagationPolicy": "Foreground",
            "preconditions": {
                "uid": meta["uid"],
                "resourceVersion": meta["resourceVersion"],
            },
        }
        subprocess.run(
            [
                "/usr/local/bin/k3s",
                "kubectl",
                "--request-timeout=5s",
                "--kubeconfig",
                str(self.config),
                "delete",
                "--raw",
                path,
                "-f",
                "-",
            ],
            input=json.dumps(body),
            text=True,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=8,
        )

    def observation(self):
        data = json.loads(
            self.call("get", "configmap/node-observation")["data"]["observation"]
        )
        age = time.time() - data["reported_at"]
        if not 0 <= age < 10 or not data["epoch"]:
            raise RecoveryRequired("stale node observation")
        return data

    def scale(self, workload, replicas):
        allowed = APP if self.role == "app" else ("judge-worker",)
        if workload not in allowed or replicas not in {0, 1}:
            raise ValueError("unknown managed deployment")
        return self.call(
            "patch", "deployment/" + workload, patch={"spec": {"replicas": replicas}}
        )

    def install_config(self, name, environment):
        if name not in FILES:
            return
        data = environment["files"][name]
        if set(data) != set(FILES[name][1]) or any(
            not isinstance(v, str) for v in data.values()
        ):
            raise RecoveryRequired("wrong public config inputs")
        value = content_digest(
            {
                key: hashlib.sha256(body.encode()).hexdigest()
                for key, body in data.items()
            }
        )
        if value != environment["workloads"][name]:
            raise RecoveryRequired("release configuration hash differs")
        config_name = environment["configmaps"][name]
        if not re.fullmatch(re.escape(name + "-config-") + "[a-z0-9]{10}", config_name):
            raise RecoveryRequired("configuration name outside approved namespace")
        try:
            self.call(
                "create",
                "-f",
                "-",
                body={
                    "apiVersion": "v1",
                    "kind": "ConfigMap",
                    "metadata": {
                        "namespace": "astracode-" + self.role,
                        "name": config_name,
                    },
                    "immutable": True,
                    "data": data,
                },
            )
        except subprocess.CalledProcessError as failure:
            if "(AlreadyExists)" not in failure.stderr:
                raise
            # The node attests the mounted public bytes before the issuer
            # permits any application process, including on idempotent retry.

    def prepare_template(self, name, images, authorized, configs=None):
        allowed = (*APP, "migrate") if self.role == "app" else ("judge-worker",)
        if name not in allowed:
            raise RecoveryRequired("unknown controlled template")
        obj = self.call("get", "podtemplate/approved-" + name)
        containers = obj["template"]["spec"]["containers"]
        for container in containers:
            pin = images[container["name"]]
            if not re.fullmatch(r"[a-z0-9.-]+/[a-z0-9./_-]+@sha256:[0-9a-f]{64}", pin):
                raise RecoveryRequired("missing approved image digest")
            container["image"] = pin
        spec = {"containers": containers}
        if name in FILES:
            spec["volumes"] = configured_volumes(name, obj["template"]["spec"], configs)
        self.call(
            "patch",
            "podtemplate/approved-" + name,
            patch={
                "metadata": {
                    "resourceVersion": obj["metadata"]["resourceVersion"],
                    "annotations": {
                        "astracode.io/activation": (
                            "authorized" if authorized else "closed"
                        )
                    },
                },
                "template": {"spec": spec},
            },
        )

    def replace_images(self, name, images, configs):
        if name not in (APP if self.role == "app" else ("judge-worker",)):
            raise RecoveryRequired("unknown deployment")
        obj = self.call("get", "deployment/" + name)
        containers = obj["spec"]["template"]["spec"]["containers"]
        for c in containers:
            c["image"] = images[c["name"]]
        spec = {"containers": containers}
        if name in FILES:
            spec["volumes"] = configured_volumes(
                name, obj["spec"]["template"]["spec"], configs
            )
        self.call(
            "patch",
            "deployment/" + name,
            patch={
                "metadata": {"resourceVersion": obj["metadata"]["resourceVersion"]},
                "spec": {"template": {"spec": spec}, "replicas": 1},
            },
        )

    def publish(self, grants):
        self.call(
            "patch",
            "configmap/node-permits",
            patch={"data": {"grants": json.dumps(grants)}},
        )


def configured_volumes(name, spec, configs):
    target = configs[name]
    if not re.fullmatch(re.escape(name + "-config-") + "[a-z0-9]{10}", target):
        raise RecoveryRequired("unexpected configuration reference")
    volumes = spec["volumes"]
    matches = [v for v in volumes if v["name"] == "config" and "configMap" in v]
    if len(matches) != 1:
        raise RecoveryRequired("missing reviewed configuration mount")
    matches[0]["configMap"]["name"] = target
    return volumes


class Issuer:
    def __init__(self, clients, issuer_key, slot):
        self.clients, self.key, self.slot = clients, issuer_key, slot

    def refresh(self, approval, now=None):
        """Input is the verified activation lease narrowed by the current rollout step."""
        now = now or datetime.now(timezone.utc)
        expires = min(approval["until"], now + timedelta(seconds=20))
        try:
            views = {
                role: client.observation() for role, client in self.clients.items()
            }
            if (
                expires <= now
                or self.slot != approval["environment"]
                or any(
                    v["epoch"] != approval[role + "_epoch"] for role, v in views.items()
                )
            ):
                raise RecoveryRequired(
                    "node epoch or protected operation lease changed"
                )
            for role, view in views.items():
                grants = {}
                for c in view["containers"]:
                    name = c["workload"]
                    approved = approval["workloads"].get(name)
                    if not approved:
                        continue
                    if (
                        name in grants
                        or c["uid"] != approved["uid"]
                        or c["image"] != approved["image"]
                        or c["pid_namespace"] != approved["pid_namespace"]
                    ):
                        raise RecoveryRequired(
                            "ambiguous container or mismatched authorized Pod"
                        )
                    digest = c["image"].partition("@")[2]
                    if not DIGEST.fullmatch(digest) or not DIGEST.fullmatch(
                        approved["config"]
                    ):
                        raise RecoveryRequired("image/config digest missing")
                    b = {
                        k: approval[k]
                        for k in (
                            "environment",
                            "session",
                            "operation",
                            "app_epoch",
                            "judge_epoch",
                        )
                    }
                    grants[name] = sign(
                        dict(
                            b,
                            workload=name,
                            pod_uid=c["uid"],
                            image=digest,
                            config=approved["config"],
                            pid_namespace=c["pid_namespace"],
                        ),
                        expires,
                        self.key,
                    )
                self.clients[role].publish(grants)
        except Exception:
            self.revoke()
            raise

    def revoke(self):
        failures = []
        for role, client in self.clients.items():
            try:
                client.publish({})
            except (OSError, subprocess.SubprocessError):
                failures.append(role)
        if failures:
            raise RecoveryRequired(
                "permit revocation unconfirmed on " + ", ".join(failures)
            )
