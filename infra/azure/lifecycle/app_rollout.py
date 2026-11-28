"""Protected App rollout participant. The local activation service issues workload permits."""

from datetime import datetime, timezone
import ipaddress
from pathlib import Path
import subprocess
import time

from activation import activate
from kube_rollout import APP, Cluster
from smoke import smoke


class Rollout:
    def __init__(self, activation, authority, settings):
        self.activation = activation
        self.authority = authority
        self.settings = settings
        self.sides = {
            r: Cluster(r, Path("/etc/astracode/rollout.kubeconfig"))
            for r in ("app", "judge")
        }
        self.request = self.release = None

    def run(self, ticket):
        # The command accepts only a ticket ID. Read the operation and bundle
        # from the authenticated services, never from workflow CLI parameters.
        self.request = self.activation.approved_operation(ticket)
        self.release = self.authority.release(self.request["release"])
        return activate(
            self.activation.activation_state(), self.request, self.release, self
        )

    def lease_current(self, request, now):
        return self.activation.lease(request) > now

    def epochs_match(self, request):
        return self.authority.current_epochs() == {
            r: request[r + "_epoch"] for r in self.sides
        }

    def contest_frozen(self):
        return self.activation.contest_frozen()

    def verify_release(self, request, release):
        return self.authority.verify_release(request, release)

    def verified_rollback(self, release):
        return self.activation.was_verified(release["digest"], release["versions"])

    def begin(self, request, release):
        self.activation.begin_if_current(request, release["digest"])

    def close_edge(self):
        self.activation.close_edge(self.request)

    def quiesce_worker(self):
        self.authority.begin(self.request)
        self.authority.close_workload(self.request, "judge-worker")
        self.sides["judge"].scale("judge-worker", 0)

    def group_empty(self):
        # An empty Kafka group alone cannot attest to interactive gRPC work.
        # Wait for a fresh CRI observation of both guarded Judge processes.
        check_until = time.monotonic() + 45
        while self.authority.running_digests(self.request, "judge"):
            if (
                time.monotonic() >= check_until
                or not self.epochs_match(self.request)
                or self.activation.lease(self.request) <= datetime.now(timezone.utc)
            ):
                return False
            time.sleep(0.25)
        broker = self.settings["kafka_ip"]
        ipaddress.ip_address(broker)
        result = subprocess.run(
            [
                "/usr/local/libexec/astra/judge-rollout-probe",
                "kafka-empty",
                broker + ":9092",
                "judge-worker-v1",
                "judge.submission.jobs",
            ],
            timeout=12,
            capture_output=True,
        )
        return result.returncode == 0

    def prior_submission(self, uid):
        return self.authority.prior_submission(uid)

    def stop_submission(self):
        self.authority.close_workload(self.request, "submission-service")
        self.sides["app"].scale("submission-service", 0)

    def stopped(self, prior):
        return self.authority.submission_stopped(prior)

    def verified_empty_or_clean_stop(self, state):
        return self.authority.verify_termination_history(self.request, state)

    def reconcile_databases(self, request, release, check):
        # Retire the current controllers while their old reference templates
        # still admit scale-down. The next image allowlist is installed only
        # after all prior application containers have exited.
        for name in APP:
            self.authority.close_workload(request, name)
            self.sides["app"].scale(name, 0)
        while self.authority.running_digests(request, "app"):
            check()
            time.sleep(0.25)
        check()
        return self.authority.migrate_or_verify(request, release)

    def activate_role(self, role, release):
        for name in (APP if role == "app" else ("judge-worker",)):
            self.sides[role].install_config(
                name, release["environments"][self.request["environment"]]
            )
            self.authority.admit(self.request, name)
            self.sides[role].replace_images(
                name,
                release["images"],
                release["environments"][self.request["environment"]]["configmaps"],
            )

    def wait_ready(self, role, release, check):
        names = APP if role == "app" else ("judge-worker",)
        while True:
            check()
            self.authority.refresh_permits(self.request, role)
            ready = True
            for n in names:
                obj = self.sides[role].call("get", "deployment/" + n)
                spec, status = obj["spec"], obj.get("status", {})
                ready &= (
                    spec["replicas"] == 1
                    and status.get("observedGeneration")
                    == obj["metadata"]["generation"]
                    and status.get("updatedReplicas") == 1
                    and status.get("readyReplicas") == 1
                    and status.get("availableReplicas") == 1
                )
            if ready and self.authority.running_digests(self.request, role) == {
                n: release["images"][n]
                for n in (names if role == "app" else ("judge-worker", "go-judge"))
            }:
                return
            time.sleep(1)

    def problem_contract(self, release):
        ip = ipaddress.ip_address(self.settings["problem_ip"])
        probe = self.settings["problem_probe"]
        subprocess.run(
            [
                "/usr/local/libexec/astra/judge-rollout-probe",
                "metadata",
                f"{ip}:9092",
                *(str(probe[k]) for k in ("id", "time_ms", "memory_kib")),
            ],
            timeout=10,
            check=True,
        )

    def smoke(self, release, check):
        # CI smoke mTLS is a separate identity available while tester access is closed.
        smoke(
            self.settings["origin"],
            self.settings["smoke_tls"],
            self.settings["smoke_fixture"],
            check,
        )

    def record_verified(self, request, release, versions):
        self.activation.complete_if_current(
            request, self.authority.observed_release(release), versions
        )

    def open_edge(self, request):
        self.activation.open_verified_edge(request)

    def revoke_permits(self):
        self.authority.revoke(self.request)

    def recovery_required(self, request):
        self.activation.require_recovery(request)
