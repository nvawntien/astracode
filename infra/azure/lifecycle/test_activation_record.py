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


class LocalJournal(unittest.TestCase):
    def setUp(self):
        from pathlib import Path
        from tempfile import TemporaryDirectory
        from activation_record import APP, JUDGE, Journal

        self.scratch = TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.directory = Path(self.scratch.name)
        self.now = datetime(2026, 11, 28, 12, tzinfo=timezone.utc)
        self.views = {
            role: dict(boot=role + "-boot", epoch=role + "-epoch", retired_jobs=[])
            for role in ("app", "judge")
        }
        self.digest = "sha256:" + "d" * 64
        self.source = "a" * 40
        workloads = {name: "sha256:" + "1" * 64 for name in APP | JUDGE | {"migrate"}}
        self.release = dict(
            digest=self.digest,
            versions=dict(auth=1, problem=1, submission=1),
            images={},
            migration_package={},
            environments={"s3": {"workloads": workloads, "digest": "expected"}},
        )
        self.settings = dict(
            daily_window=dict(earliest_start="0700", shutdown="1800"),
            contest_windows=[],
            migration={"system_id": "10", "recovery_point": "test"},
        )
        self.catalog = type("FixtureCatalog", (), {"load": lambda *_: self.release})()
        self.observed = lambda: self.views
        self.journal = Journal(
            self.directory,
            "s3",
            self.settings,
            self.catalog,
            self.observed,
            clock=lambda: self.now,
            mount=lambda _: True,
        )

    def open(self):
        self.journal.open(approval="owner/window", date="2026-11-28")

    def submit(self, action="deploy", run="123", recovery=None):
        return self.journal.submit(
            action,
            self.source,
            self.digest,
            self.source,
            self.digest,
            run,
            "1",
            recovery,
        )["ticket"]

    def test_no_admission_from_missing_mount_or_unapproved_time(self):
        with self.assertRaises(RecoveryRequired):
            self.open()
        self.journal.initialize()
        self.now = self.now.replace(hour=19)
        with self.assertRaises(RecoveryRequired):
            self.open()
        self.journal.mount = lambda _: False
        with self.assertRaisesRegex(RecoveryRequired, "data mount"):
            self.journal.act("tester")

    def test_single_run_and_changed_epoch_close_rolling_authorization(self):
        self.journal.initialize()
        self.open()
        operation = self.submit()
        with self.assertRaises(RecoveryRequired):
            self.submit(run="124")
        self.journal.act("begin", operation=operation, release=self.digest)
        self.assertTrue(self.journal.act("tester")["smoke"])
        self.assertFalse(self.journal.act("tester")["tester"])
        self.views["judge"]["epoch"] = "different"
        self.journal.observe_current(**self.views)
        self.assertFalse(self.journal.act("tester")["smoke"])
        with self.assertRaises(RecoveryRequired):
            self.journal.act("authorization", operation=operation)

    def test_reboot_preserves_retained_migration_and_requires_exact_recovery(self):
        self.journal.initialize()
        self.open()
        operation = self.submit()
        self.journal.act("begin", operation=operation, release=self.digest)
        self.journal.generation = None
        self.assertFalse(self.journal.act("tester")["tester"])
        self.open()
        with self.assertRaisesRegex(RecoveryRequired, "new App boot"):
            self.submit(
                "recover",
                "124",
                {"operation": operation, "versions": self.release["versions"]},
            )
        self.views["app"] = dict(self.views["app"], epoch="fresh", boot="fresh")
        self.journal.generation = None
        self.open()
        with self.assertRaisesRegex(RecoveryRequired, "explicit recovery"):
            self.submit(run="124")
        with self.assertRaisesRegex(RecoveryRequired, "interrupted operation"):
            self.submit(
                "recover",
                "124",
                {"operation": "wrong", "versions": self.release["versions"]},
            )
        ticket = self.submit(
            "recover",
            "124",
            {"operation": operation, "versions": self.release["versions"]},
        )
        self.assertNotEqual(ticket, operation)
        self.journal.act("begin", operation=ticket, release=self.digest)
        self.assertNotIn(
            "migrate",
            self.journal.act("authorization", operation=ticket)["allowed_workloads"],
        )

    def test_verified_run_does_not_open_access_without_exact_handoff(self):
        from activation_record import APP, JUDGE

        backing = ("postgres", "redis", "kafka", "minio")
        self.release["images"] = {
            name: f"approved/{name}" for name in (*APP, *JUDGE, *backing)
        }
        self.journal.initialize()
        self.open()
        ticket = self.submit()
        self.journal.act("begin", operation=ticket, release=self.digest)
        config = self.release["environments"]["s3"]["workloads"]
        observed = {
            role: dict(
                boot=self.views[role]["boot"],
                epoch=self.views[role]["epoch"],
                containers={
                    name: dict(
                        uid=name,
                        container=name,
                        workload=name,
                        image=self.release["images"][name],
                        config=config[name],
                    )
                    for name in workloads
                },
            )
            for role, workloads in (("app", APP), ("judge", JUDGE))
        }
        observed["app"]["backing"] = {
            name: self.release["images"][name] for name in backing
        }
        self.journal.act(
            "complete",
            operation=ticket,
            versions=self.release["versions"],
            observed=observed,
        )
        self.journal.act("open", operation=ticket)
        self.assertEqual(self.journal.status(ticket)["smoke"], "passed")
        self.assertFalse(self.journal.act("tester")["tester"])
        with self.assertRaises(RecoveryRequired):
            self.journal.admit_testers("124", ticket, self.digest)
        self.journal.admit_testers("123", ticket, self.digest)
        self.assertTrue(self.journal.act("tester")["tester"])
        with self.assertRaises(RecoveryRequired):
            self.journal.admit_testers("123", ticket, self.digest)

    def test_observation_and_daily_cutoff_close_without_workflow(self):
        self.journal.initialize()
        self.open()
        operation = self.submit()
        self.journal.act("begin", operation=operation, release=self.digest)
        self.now += timedelta(seconds=16)
        self.assertFalse(self.journal.act("tester")["smoke"])
        self.journal.observe_current(**self.views)
        self.assertTrue(self.journal.act("tester")["smoke"])
        self.now = self.now.replace(hour=17, minute=58)
        self.assertEqual(
            self.journal.observe_current(**self.views)["phase"], "draining"
        )
        self.assertFalse(self.journal.act("tester")["tester"])


if __name__ == "__main__":
    unittest.main()
