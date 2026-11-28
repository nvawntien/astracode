"""Integrate the App rollout and issuer against durable-record and node fixtures."""

import copy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid

from activation_record import transition
from app_rollout import Rollout
from authority import Authority
from activation_client import ActivationClient
from kube_rollout import APP, EXECUTION
from node_state import RecoveryRequired


class Node:
    def __init__(self, role, events):
        self.role, self.events = role, events
        self.view = dict(epoch=role, boot_id="boot-" + role, containers=[], exited=[])
        self.generation = 0

    def observation(self):
        return copy.deepcopy(self.view)

    def scale(self, name, replicas):
        self.events.append(("scale", name, replicas))
        self.view["containers"] = [
            r for r in self.view["containers"] if r["workload"] != name
        ]

    def install_config(self, name, environment):
        self.events.append(("config", name))

    def prepare_template(self, name, images, authorized, configs=None):
        self.events.append(("template", name))

    def replace_images(self, name, images, configs):
        self.generation += 1
        for workload in EXECUTION if name == "judge-worker" else (name,):
            self.view["containers"].append(
                dict(
                    workload=workload,
                    uid=str(uuid.uuid4()),
                    container=workload,
                    image=images[workload],
                    config="config",
                    pid_namespace="pid:[123]",
                )
            )
        self.events.append(("start", name))

    def call(self, *args):
        return dict(
            metadata={"generation": self.generation},
            spec={"replicas": 1},
            status=dict(
                observedGeneration=self.generation,
                updatedReplicas=1,
                readyReplicas=1,
                availableReplicas=1,
            ),
        )


class Records(ActivationClient):
    def __init__(self, state, events):
        self.state, self.events = state, events
        self.operation = None

    def call(self, action, **data):
        current = copy.deepcopy(self.state)
        result = transition(
            current, action, data, datetime.now(timezone.utc), lambda *a: {}
        )
        self.state = current
        self.events.append(("activation", action))
        return copy.deepcopy(result)


class Issuer:
    def __init__(self, events):
        self.events = events

    def refresh(self, grant):
        self.events.append(("grants", set(grant["workloads"])))

    def revoke(self):
        self.events.append(("revoked",))


class RolloutIntegration(unittest.TestCase):
    def execute(self, failure=None):
        events = []
        now = datetime.now(timezone.utc)
        ident = str(uuid.uuid4())
        request = dict(
            id=ident,
            release="release",
            action="deploy",
            environment="s3",
            session="session",
            app_epoch="app",
            judge_epoch="judge",
            deadline=(now + timedelta(minutes=3)).isoformat(),
        )
        names = (*APP, *EXECUTION)
        images = {
            n: "fixture.invalid/" + n + "@sha256:" + "a" * 64
            for n in (*names, "postgres", "redis", "kafka", "minio")
        }
        versions = dict(auth=1, problem=1, submission=1)
        release = dict(
            digest="release",
            images=images,
            versions=versions,
            config_digest="digest",
            environments={
                "s3": dict(workloads=dict.fromkeys(names, "config"), configmaps={})
            },
        )
        before = dict(
            in_flight=None, last_verified=None, submission_uid=None, clean_drain=False
        )
        state = dict(
            phase="starting",
            generation="session",
            epochs=dict(app="app", judge="judge"),
            expires=request["deadline"],
            heartbeat=now.isoformat(),
            app_seen=now.isoformat(),
            contest=False,
            verified_releases={},
            operation=dict(
                request=request,
                phase="approved",
                before=before,
                termination=dict(
                    epoch="app", session="session", fresh=True, clean=False
                ),
                expected=dict(
                    versions=versions,
                    images=images,
                    workloads=dict.fromkeys(names, "config"),
                    config="digest",
                ),
            ),
        )
        control = Records(state, events)

        class Catalog:
            def verified_bundle(self, *args):
                return release

        def migration(req, candidate):
            events.append(("schema",))
            if failure == "schema":
                raise RecoveryRequired("database unknown")
            return versions

        authority = Authority(control, Catalog(), migration, "s3", Path("/unused"))
        nodes = {r: Node(r, events) for r in ("app", "judge")}
        nodes["app"].view["backing"] = {
            name: images[name] for name in ("postgres", "redis", "kafka", "minio")
        }
        authority.clients = nodes
        authority.issuer = Issuer(events)
        rollout = Rollout(
            control,
            authority,
            dict(
                kafka_ip="10.1.0.4",
                problem_ip="10.1.0.5",
                problem_probe=dict(id=1, time_ms=1000, memory_kib=1024),
                origin="https://fixture.invalid",
                smoke_tls={},
                smoke_fixture={},
            ),
        )
        rollout.sides = nodes

        def smoke(*args):
            events.append(("smoke",))
            if failure == "smoke":
                raise RecoveryRequired("smoke failed")

        with (
            patch("app_rollout.subprocess.run") as probe,
            patch("app_rollout.smoke", side_effect=smoke),
        ):
            probe.return_value.returncode = 0
            if failure:
                with self.assertRaises(RecoveryRequired):
                    rollout.run(ident)
            else:
                rollout.run(ident)
        return control.state, events

    def test_first_deploy(self):
        state, events = self.execute()
        self.assertTrue(state["tester_open"])
        self.assertIsNone(state["in_flight"])
        self.assertEqual(state["operation"]["phase"], "verified")
        self.assertLess(
            events.index(("schema",)), events.index(("start", "auth-service"))
        )
        self.assertLess(
            events.index(("start", "envoy")), events.index(("start", "judge-worker"))
        )
        self.assertLess(
            events.index(("smoke",)), events.index(("activation", "complete"))
        )

    def test_failed_schema_or_smoke_keeps_recovery_record(self):
        for failure in ("schema", "smoke"):
            with self.subTest(failure=failure):
                state, events = self.execute(failure)
                self.assertFalse(state["tester_open"])
                self.assertEqual(state["operation"]["phase"], "recovery-required")
                self.assertTrue(state["in_flight"])
                self.assertNotIn(("activation", "complete"), events)
                self.assertIn(("revoked",), events)
                if failure == "schema":
                    self.assertFalse(any(e[0] == "start" for e in events))


if __name__ == "__main__":
    unittest.main()
