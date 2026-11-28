import base64
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from activation import activate
from node_state import prior_submission, RecoveryRequired, stopped
from permits import install, sign


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(timezone.utc)
        self.state = dict(
            in_flight=None,
            clean_drain=True,
            last_verified="verified",
            submission_uid="uid",
        )
        self.release = dict(
            digest="verified", versions={"auth": 1, "problem": 1, "submission": 1}
        )
        self.request = dict(
            action="rollback",
            release="verified",
            deadline=self.now + timedelta(minutes=2),
        )
        self.calls = []
        self.fail = set()

    def do(self, name, answer=None):
        self.calls.append(name)
        if name in self.fail:
            raise RecoveryRequired(name)
        return answer

    def lease_current(self, *_):
        return self.do("lease", True)

    def epochs_match(self, *_):
        return self.do("epoch", True)

    def contest_frozen(self):
        return False

    def verify_release(self, *_):
        return True

    def verified_rollback(self, *_):
        return True

    def prior_submission(self, uid):
        return uid

    def verified_empty_or_clean_stop(self, state):
        return False

    def group_empty(self):
        return self.do("empty", True)

    def stopped(self, *_):
        return self.do("stopped", True)

    def reconcile_databases(self, *_):
        return self.do("schema", self.release["versions"])

    def activate_role(self, role, *_):
        self.do(role)

    def wait_ready(self, role, *_):
        self.do(role + " ready")

    def begin(self, *_):
        self.do("begin")

    def close_edge(self):
        self.do("closed")

    def stop_submission(self):
        self.do("stop")

    def quiesce_worker(self):
        self.do("quiesce")

    def problem_contract(self, *_):
        self.do("contract")

    def smoke(self, *_):
        self.do("smoke")

    def record_verified(self, *_):
        self.do("verified")

    def open_edge(self, *_):
        self.do("open")

    def revoke_permits(self):
        self.do("revoked")

    def recovery_required(self, *_):
        self.do("recovery")

    def rollout(self):
        activate(self.state, self.request, self.release, self, clock=lambda: self.now)

    def test_compatible_order(self):
        self.rollout()
        steps = [x for x in self.calls if x not in {"lease", "epoch"}]
        self.assertEqual(
            steps,
            [
                "begin",
                "closed",
                "quiesce",
                "empty",
                "stop",
                "stopped",
                "schema",
                "app",
                "app ready",
                "judge",
                "judge ready",
                "contract",
                "smoke",
                "verified",
                "open",
            ],
        )

    def test_uncertainty_retains_closed_edge(self):
        for failure in (
            "epoch",
            "lease",
            "empty",
            "stopped",
            "schema",
            "judge ready",
            "smoke",
        ):
            with self.subTest(failure=failure):
                self.calls.clear()
                self.fail = {failure}
                with self.assertRaises(RecoveryRequired):
                    self.rollout()
                self.assertNotIn("open", self.calls)
                if "begin" in self.calls:
                    self.assertEqual(self.calls[-3:], ["revoked", "closed", "recovery"])
        self.state["in_flight"] = "partial"
        self.fail.clear()
        self.calls.clear()
        with self.assertRaises(RecoveryRequired):
            self.rollout()
        self.assertNotIn("begin", self.calls)

    def test_submission_exit_evidence(self):
        row = dict(
            metadata={"name": "submission-service"},
            id="cid",
            labels={
                "io.kubernetes.pod.uid": "uid",
                "io.kubernetes.pod.namespace": "astracode-app",
            },
        )
        current = lambda: "current"
        prior = prior_submission("uid", current, lambda *_: {"containers": [row]})
        state = dict(row, state="CONTAINER_EXITED", finishedAt="3")

        def inspect(*args):
            return {"status": state} if args[0] == "inspect" else {"containers": []}

        self.assertTrue(stopped(prior, current, inspect))
        state["state"] = "CONTAINER_RUNNING"
        self.assertFalse(stopped(prior, current, inspect))
        with self.assertRaises(RecoveryRequired):
            stopped(prior, lambda: "rebooted", inspect)

    def test_host_permit_binding(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "permits" / "go-judge").mkdir(parents=True)
            (root / "epoch").write_text("judge")
            key, public = root / "key", root / "public"
            subprocess.run(
                ["openssl", "genpkey", "-algorithm", "Ed25519", "-out", key], check=True
            )
            subprocess.run(
                ["openssl", "pkey", "-in", key, "-pubout", "-out", public], check=True
            )
            digest = "sha256:" + "a" * 64
            binding = dict(
                environment="s3",
                workload="go-judge",
                pod_uid="pod",
                image=digest,
                config=digest,
                app_epoch="app",
                judge_epoch="judge",
                operation="fixture",
                session="fixture",
                pid_namespace="pid:[123]",
            )
            grant = sign(binding, self.now + timedelta(seconds=20), key)

            def inspect(command, *_):
                pin = "fixture.invalid/daemon@" + digest
                if command == "inspecti":
                    return {"status": {"id": "local", "repoDigests": [pin]}}
                return {
                    "containers": [
                        dict(
                            metadata={"name": "go-judge"},
                            image={"image": "local", "userSpecifiedImage": pin},
                            imageRef="local",
                            labels={
                                "io.kubernetes.pod.uid": "pod",
                                "io.kubernetes.pod.namespace": "astracode-judge",
                            },
                        )
                    ]
                }

            install("judge", "s3", grant, public, root, inspect)
            self.assertEqual(
                json.loads((root / "permits/go-judge/binding.json").read_text()),
                binding,
            )
            (root / "epoch").write_text("new")
            with self.assertRaises(RecoveryRequired):
                install("judge", "s3", grant, public, root, inspect)
            altered = dict(grant, payload=base64.b64encode(b"{}").decode())
            with self.assertRaises(subprocess.CalledProcessError):
                install("judge", "s3", altered, public, root, inspect)


if __name__ == "__main__":
    unittest.main()
