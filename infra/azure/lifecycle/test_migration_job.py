"""Exercise the Job coordinator's retry and fencing decisions."""

import unittest
from unittest.mock import patch

from migration_job import MigrationJob
from node_state import RecoveryRequired


class Jobs(unittest.TestCase):
    def setUp(self):
        self.old = {
            "metadata": {"uid": "old", "resourceVersion": "1"},
            "spec": {"suspend": False},
            "status": {"startTime": "before"},
        }
        self.events = []
        self.retired = False
        self.job = self.old
        self.observations = iter(
            [
                {
                    "containers": [
                        {
                            "workload": "migrate",
                            "job_uid": "new",
                            "uid": "pod",
                            "container": "ctr",
                        }
                    ]
                },
                {
                    "containers": [],
                    "exited": [
                        {
                            "workload": "migrate",
                            "job_uid": "new",
                            "uid": "pod",
                            "container": "ctr",
                            "exit_code": 0,
                            "finished_at": 1,
                        }
                    ],
                },
            ]
        )
        self.adapter = MigrationJob(
            self,
            lambda attempt, values: self.events.append(("credentials", values)),
            lambda uid, job: self.events.append(("permit", (uid, job))),
            lambda: self.events.append(("revoke", None)),
            lambda: {
                "metadata": {"labels": {"astracode.io/template": "migrate"}},
                "spec": {},
            },
            lambda uid: self.retired,
            lambda: next(self.observations),
        )

    def retire_migration(self, obj):
        self.assertIs(obj, self.old)
        self.events.append(("delete", obj["metadata"]["uid"]))
        self.job = None

    def call(self, *args, patch=None, body=None):
        if args[0] == "get":
            return self.job
        if args[0] == "create":
            self.assertTrue(body["spec"]["suspend"])
            self.job = {
                "metadata": {"uid": "new", "resourceVersion": "2"},
                "spec": body["spec"],
            }
        if args[0] == "patch":
            self.assertEqual(patch["metadata"]["resourceVersion"], "2")
            self.job["status"] = {"succeeded": 1}
        return self.job

    def test_stale_job_refuses_credentials(self):
        with self.assertRaises(RecoveryRequired):
            self.adapter("attempt", {"auth": "synthetic"}, lambda: None)
        self.assertNotIn(("delete", "old"), self.events)
        self.assertNotIn(("credentials", {"auth": "synthetic"}), self.events)
        self.assertIn(("revoke", None), self.events)

    def test_confirmed_exit_allows_fresh_job(self):
        self.retired = True
        with patch("migration_job.time.sleep"):
            self.adapter("attempt", {"auth": "synthetic"}, lambda: None)
        self.assertEqual(
            self.events,
            [
                ("delete", "old"),
                ("credentials", {"auth": "synthetic"}),
                ("permit", ("pod", "new")),
                ("revoke", None),
                ("credentials", None),
            ],
        )

    def test_lost_lease_revokes_and_erases_attempt(self):
        self.retired = True
        count = 0

        def lease():
            nonlocal count
            count += 1
            if count == 4:
                raise RecoveryRequired("lease lost")

        with self.assertRaises(RecoveryRequired):
            self.adapter("attempt", {"auth": "synthetic"}, lease)
        self.assertEqual(self.events[-2:], [("revoke", None), ("credentials", None)])
        self.assertFalse(any(name == "permit" for name, _ in self.events))


if __name__ == "__main__":
    unittest.main()
