from datetime import datetime, timedelta, timezone
import unittest
import uuid

from activation_record import APP, JUDGE, transition
from node_state import RecoveryRequired


class Records(unittest.TestCase):
    def setUp(self):
        self.t = datetime.now(timezone.utc)
        self.uid = str(uuid.uuid4())
        self.req = dict(
            id=self.uid,
            release="release",
            environment="s3",
            session="session",
            app_epoch="app",
            judge_epoch="judge",
            deadline=(self.t + timedelta(minutes=4)).isoformat(),
            action="deploy",
        )
        images = {n: "repo/" + n for n in APP | JUDGE}
        configs = {n: "config/" + n for n in images}
        self.versions = dict(auth=1, problem=1, submission=1)
        self.op = dict(
            phase="approved",
            request=self.req,
            before={"clean_drain": True},
            termination={},
            expected=dict(
                versions=self.versions,
                images=images,
                workloads=configs,
                config="aggregate",
            ),
            migration={"release": "release"},
        )
        self.state = dict(
            operation=self.op,
            phase="starting",
            generation="session",
            epochs={"app": "app", "judge": "judge"},
            expires=self.req["deadline"],
            heartbeat=self.t.isoformat(),
            contest=False,
            verified_releases={},
        )
        self.obs = {
            r: dict(
                boot="boot-" + r,
                epoch=r,
                containers={
                    n: dict(
                        uid=n,
                        container="c-" + n,
                        workload=n,
                        image=images[n],
                        config=configs[n],
                    )
                    for n in names
                },
            )
            for r, names in (("app", APP), ("judge", JUDGE))
        }
        self.run_action("poll")

    def run_action(self, action, **args):
        return transition(
            self.state, action, dict(operation=self.uid, **args), self.t, lambda *a: {}
        )

    def test_restart_needs_new_operation(self):
        self.run_action("begin", release="release")
        self.run_action("close")
        pod = str(uuid.uuid4())
        self.run_action("bind-migration", uid=pod)
        with self.assertRaises(RecoveryRequired):
            self.run_action("bind-migration", uid=str(uuid.uuid4()))
        self.assertEqual(self.run_action("authorization")["migration_uid"], pod)
        with self.assertRaises(RecoveryRequired):
            self.run_action("open")
        self.t += timedelta(seconds=16)
        with self.assertRaises(RecoveryRequired):
            self.run_action("authorization")
        self.run_action("recovery-required")
        self.assertEqual(self.state["in_flight"], self.uid)
        self.run_action("poll")
        with self.assertRaises(RecoveryRequired):
            self.run_action("authorization")
        self.assertFalse(self.state["tester_open"])

    def test_verified_activation(self):
        self.assertEqual(self.run_action("authorization")["allowed_workloads"], [])
        self.run_action("begin", release="release")
        with self.assertRaises(RecoveryRequired):
            self.run_action("complete", versions={}, observed=self.obs)
        self.run_action("complete", versions=self.versions, observed=self.obs)
        self.assertFalse(self.state["tester_open"])
        self.run_action("open")
        self.assertTrue(self.state["tester_open"])
        self.assertTrue(
            self.run_action("verified", digest="release", versions=self.versions)[
                "verified"
            ]
        )
        self.assertNotIn(
            "migrate", self.run_action("authorization")["allowed_workloads"]
        )
        self.assertIsNone(self.state["in_flight"])
        self.assertEqual(self.state["submission_uid"], "submission-service")

    def test_stale_controller_and_epoch(self):
        self.run_action("begin", release="release")
        self.t += timedelta(minutes=3)
        self.run_action("app-heartbeat")
        with self.assertRaises(RecoveryRequired):
            self.run_action("authorization")
        self.state["heartbeat"] = self.t.isoformat()
        self.state["epochs"]["judge"] = "reboot"
        with self.assertRaises(RecoveryRequired):
            self.run_action("authorization")


if __name__ == "__main__":
    unittest.main()
