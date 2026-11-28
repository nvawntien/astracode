"""App-side fixed activation authority. Read boot-bound operations from the protected local record."""

import threading

from kube_rollout import APP, EXECUTION, Cluster, Issuer
from node_state import RecoveryRequired
from permits import qualified_image


class Authority:
    def __init__(self, activation, catalog, migration, slot, platform):
        self.control, self.catalog, self.migration = activation, catalog, migration
        self.clients = {
            r: Cluster(r, platform / "activation.kubeconfig") for r in ("app", "judge")
        }
        self.issuer = Issuer(self.clients, platform / "issuer.key", slot)
        self.slot = slot
        self._lock = threading.RLock()
        self._pending = set()
        self._verified_schemas = None
        self._operation = None
        self._error = None
        self._stop = threading.Event()

    def current_epochs(self):
        return {r: c.observation()["epoch"] for r, c in self.clients.items()}

    def release(self, digest):
        return self.catalog.verified_bundle(digest, self.slot)

    def verify_release(self, request, release):
        return release == self.release(request["release"])

    def revoke(self, request):
        with self._lock:
            self._pending.clear()
            self._verified_schemas = None
            self._operation = None
            self.issuer.revoke()

    def begin(self, request):
        with self._lock:
            if self._operation and self._operation["id"] == request["id"]:
                raise RecoveryRequired("duplicate host activation")
            self.control.authorization(request)
            self.revoke(request)
            self._error = None

    def close_workload(self, request, name):
        with self._lock:
            names = EXECUTION if name == "judge-worker" else (name,)
            self._pending.difference_update(names)
            self._refresh(request)

    def _refresh(self, request):
        # Require a fresh local authorization after any change to the local step,
        # and compare the current immutable operation binding on each renewal.
        snapshot = self.control.authorization(request)
        if (
            snapshot["operation"] != request["id"]
            or snapshot["environment"] != self.slot
        ):
            raise RecoveryRequired("wrong durable operation binding")
        release = self.release(request["release"])
        views = {r: c.observation() for r, c in self.clients.items()}
        if any(views[r]["epoch"] != snapshot[r + "_epoch"] for r in views):
            raise RecoveryRequired("node restarted during operation")
        allowed = set(snapshot["allowed_workloads"]) & self._pending
        bindings = {}
        for view in views.values():
            for c in view["containers"]:
                name = c["workload"]
                if name not in allowed:
                    continue
                if (
                    c["image"] != release["images"][name]
                    or name in bindings
                    or c["config"]
                    != release["environments"][self.slot]["workloads"][name]
                ):
                    raise RecoveryRequired("wrong or ambiguous running candidate")
                if name == "migrate" and snapshot.get("migration_uid") != c["uid"]:
                    raise RecoveryRequired("migration attempt differs")
                bindings[name] = {
                    "uid": c["uid"],
                    "image": c["image"],
                    "config": release["config_digest"],
                    "pid_namespace": c["pid_namespace"],
                }
        grant = dict(snapshot, workloads=bindings)
        self.issuer.refresh(grant)
        return bindings

    def admit(self, request, workload):
        if workload not in (*APP, "judge-worker", "migrate"):
            raise RecoveryRequired("unknown workload")
        release = self.release(request["release"])
        if workload != "migrate" and self._verified_schemas != (
            request["id"],
            release["digest"],
        ):
            raise RecoveryRequired(
                "host has no verified all-owner schema result for this operation"
            )
        approval = self.control.authorization(request)
        names = EXECUTION if workload == "judge-worker" else (workload,)
        if not set(names) <= set(approval["allowed_workloads"]):
            raise RecoveryRequired("activation step has no authorization")
        self.clients["judge" if workload == "judge-worker" else "app"].prepare_template(
            workload,
            release["images"],
            True,
            release["environments"][self.slot]["configmaps"],
        )
        with self._lock:
            self._pending.update(names)
            self._operation = request

    def refresh_permits(self, request, role):
        with self._lock:
            if self._error:
                raise RecoveryRequired("host authorization renewal failed")
            self._refresh(request)

    def renew_loop(self):
        while not self._stop.wait(2):
            with self._lock:
                if self._operation is None:
                    continue
                try:
                    self._refresh(self._operation)
                except Exception as exc:
                    self._error = type(exc).__name__
                    failed = self._operation
                    self._operation = None
                    self._pending.clear()
                    try:
                        self.issuer.revoke()
                    finally:
                        try:
                            self.control.require_recovery(failed)
                        except Exception:
                            # Short-lived grants still expire locally when the
                            # activation service cannot durably record this failure.
                            pass

    def running_digests(self, request, role):
        approved = self.control.authorization(request)
        view = self.clients[role].observation()
        if view["epoch"] != approved[role + "_epoch"]:
            raise RecoveryRequired("unverified node epoch")
        current = {}
        for c in view["containers"]:
            if c["workload"] == "migrate":
                continue
            if c["workload"] in current:
                raise RecoveryRequired("overlapping workload containers")
            current[c["workload"]] = c["image"]
        return current

    def observed_release(self, release):
        if self._operation is None:
            raise RecoveryRequired("missing active operation")
        observed = {}
        for role, client in self.clients.items():
            view = client.observation()
            if view["epoch"] != self._operation[role + "_epoch"]:
                raise RecoveryRequired("node restarted before recording evidence")
            expected = set(APP if role == "app" else EXECUTION)
            rows = {c["workload"]: c for c in view["containers"]}
            if len(rows) != len(view["containers"]) or set(rows) != expected:
                raise RecoveryRequired("runtime inventory differs from release")
            for name, row in rows.items():
                if (
                    row["image"] != release["images"][name]
                    or row["config"]
                    != release["environments"][self.slot]["workloads"][name]
                ):
                    raise RecoveryRequired("running image or configuration differs")
            observed[role] = {
                "boot": view["boot_id"],
                "epoch": view["epoch"],
                "containers": rows,
                "backing": {
                    n: qualified_image(p) for n, p in view.get("backing", {}).items()
                },
            }
        return observed

    def prior_submission(self, uid):
        view = self.clients["app"].observation()
        rows = [r for r in view["containers"] if r["workload"] == "submission-service"]
        if not rows:
            # A verified old permit can be withdrawn immediately after the
            # durable rollout claim. Use a positive CRI exit for the same Pod.
            rows = [
                row
                for row in view["exited"]
                if row["workload"] == "submission-service"
                and row["uid"] == uid
                and row["finished_at"] > 0
            ][:1]
        if len(rows) != 1 or rows[0]["uid"] != uid:
            raise RecoveryRequired("prior Submission is ambiguous")
        return dict(rows[0], epoch=view["epoch"])

    def submission_stopped(self, prior):
        view = self.clients["app"].observation()
        if view["epoch"] != prior["epoch"]:
            raise RecoveryRequired(
                "App restarted before prior Submission exit was confirmed"
            )
        return not any(
            c["workload"] == "submission-service" for c in view["containers"]
        ) and any(
            c["uid"] == prior["uid"]
            and c["container"] == prior["container"]
            and c["workload"] == "submission-service"
            and c["finished_at"] > 0
            for c in view["exited"]
        )

    def verify_termination_history(self, request, state):
        proof = self.control.termination_proof(request)
        view = self.clients["app"].observation()
        if any(c["workload"] == "submission-service" for c in view["containers"]):
            return False
        if proof["epoch"] != view["epoch"] or proof["session"] != request["session"]:
            return False
        if (
            proof["fresh"]
            and state["last_verified"] is None
            and not state["submission_uid"]
        ):
            return True
        if (
            proof["clean"]
            and state["clean_drain"]
            and proof.get("uid") == state["submission_uid"]
        ):
            return True
        if request["action"] == "deploy":
            if proof.get("sealed_recovery") and not state["in_flight"]:
                return proof.get("boot") == view["boot_id"]
        # A service restart alone does not fence a runtime shim. A verified
        # new kernel boot on the same uniquely bound App VM fences its old PIDs.
        return (
            request["action"] == "recover"
            and proof.get("same_app_vm") is True
            and proof.get("work_reconciled") is True
            and proof.get("previous_boot")
            and proof["previous_boot"] != view["boot_id"]
            and proof.get("boot") == view["boot_id"]
            and proof.get("uid") == state["submission_uid"]
        )

    def migrate_or_verify(self, request, release):
        self._verified_schemas = None
        versions = self.migration(request, release)
        if versions != release["versions"]:
            raise RecoveryRequired("all-owner schema verification failed")
        self._verified_schemas = (request["id"], release["digest"])
        return versions
