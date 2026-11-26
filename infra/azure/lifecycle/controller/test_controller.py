"""Offline tests of the normal request, App pull and timer boundaries."""

import copy
from datetime import datetime, timedelta, timezone
import json
import sys
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid

import azure.functions as func
from cryptography.hazmat.primitives.asymmetric import rsa
import jwt

ROOT = Path(__file__).resolve().parents[4]
sys.path[:0] = [str(ROOT / "scripts/release"), str(ROOT / "infra/azure/lifecycle")]

from auth import Auth
from azure_adapters import Power
from emergency import deallocate
from function_app import api
from policy import canonical, digest, envelope
from service import Service
from state import Refused
from test_policy import fixture
from edge_lease import Lease


def uid():
    return str(uuid.uuid4())


class Store:
    def __init__(self):
        self.state = None
        self.version = None
        self.reject = False

    def read(self):
        return copy.deepcopy(self.state), self.version

    def write(self, state, version):
        if self.reject:
            self.reject = False
            return False
        if self.version != version:
            return False
        self.state = copy.deepcopy(state)
        self.version = (self.version or 0) + 1
        return True


class Cloud:
    def __init__(self, store):
        self.store = store
        self.states = dict.fromkeys(("app", "judge"), "deallocated")
        self.sent = []
        self.outcomes = {}
        self.lose = None

    def observe(self):
        return dict(self.states)

    def outcome(self, url):
        return self.outcomes[url]

    def send(self, role, action, identifier):
        power = self.store.state["power"][role]
        if not any(
            i["id"] == identifier and i["status"] == "claimed" for i in power["intents"]
        ):
            raise AssertionError("ARM sent before durable claim")
        self.sent.append((role, action))
        if self.lose == (role, action):
            raise OSError("connection lost after dispatch")
        url = role + "/" + action + "/" + identifier
        self.outcomes[url] = "InProgress"
        return url

    def done(self, role, action):
        self.states[role] = "running" if action == "start" else "deallocated"
        for url in self.outcomes:
            if url.startswith(role + "/" + action + "/"):
                self.outcomes[url] = "Succeeded"


class Lifecycle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def setUp(self):
        self.time = datetime(2026, 11, 26, 7, tzinfo=timezone.utc)
        self.catalog_record = envelope(fixture())
        self.release = self.catalog_record["bundle"]
        self.tenant = uid()
        self.api_id = uid()
        self.repo = "fixture/repo"
        self.revision = "a" * 40
        self.run = 10
        self.actor = "2"
        self.dispatcher = "2"
        self.reviewer = "1"
        self.review_env = "staging-lifecycle"
        self.members = {"member-1": "1", "member-2": "2"}
        self.policy = dict(
            environment="s2",
            targets=dict(app="fixture-app", judge="fixture-judge"),
            tenant=self.tenant,
            audience="api://" + self.api_id,
            repository=self.repo,
            repository_id=123,
            dispatchers=["1", "2", "3"],
            clients={
                "member-client": dict(role="member", scope="Request.Create"),
                "app-client": dict(
                    role="app", object_id="app-principal", application_role="App.Poll"
                ),
                "lifecycle-client": dict(
                    role="lifecycle",
                    object_id="life-principal",
                    application_role="Staging.Lifecycle",
                ),
                "deployment-client": dict(
                    role="deployment",
                    object_id="deployment-principal",
                    application_role="Staging.Deployment",
                ),
                "eligibility-client": dict(
                    role="eligibility",
                    object_id="reader-principal",
                    application_role="Staging.Eligibility",
                ),
            },
            reviewers=dict(lifecycle=["1"], deployment=["3"], eligibility=["3"]),
            workflows={
                r: dict(
                    path=".github/workflows/staging-request.yml",
                    revisions=[self.revision],
                )
                for r in ("lifecycle", "deployment", "eligibility")
            },
            subjects={
                name: "fixture:" + name
                for name in (
                    "staging-lifecycle",
                    "staging-deployment",
                    "promotion-eligibility",
                )
            },
            members=self.members,
            contest=False,
            off_window_confirmed=True,
            off_start="00:00",
            off_end="12:00",
            promotion_mappings={},
            reviewed_forward_rollback=[],
        )
        self.store = Store()
        self.cloud = Cloud(self.store)
        self.auth = Auth(
            self.policy,
            keys=dict.fromkeys(("entra", "github"), self.key.public_key()),
            github=self.github,
        )
        self.service = Service(
            self.policy,
            self.store,
            self.auth,
            lambda _: self.catalog_record,
            self.cloud,
            lambda: self.time,
        )
        self.service.reconcile()
        # Credited time comes from timer observations. Set the prior measured
        # total here so tests can focus on the transition after noon.
        self.store.state["off_seconds"] = 12 * 3600
        self.app = dict(role="app")

    def github(self, path):
        if path.endswith("/approvals"):
            return [
                dict(
                    state="approved",
                    user=dict(id=int(self.reviewer)),
                    environments=[dict(name=self.review_env)],
                )
            ]
        return dict(
            run_attempt=1,
            head_sha=self.revision,
            event="workflow_dispatch",
            status="in_progress",
            path=".github/workflows/staging-request.yml",
            actor=dict(id=int(self.dispatcher)),
            repository=dict(id=123),
        )

    def token(self, kind, payload=None, **claims):
        now = int(datetime.now(timezone.utc).timestamp())
        values = dict(iat=now, nbf=now - 1, exp=now + 180)
        if kind == "github":
            values.update(
                iss="https://token.actions.githubusercontent.com",
                aud="api://astracode/request/" + digest(canonical(payload))[7:],
                sub=self.policy["subjects"][self.review_env],
                repository=self.repo,
                repository_id="123",
                ref="refs/heads/main",
                event_name="workflow_dispatch",
                environment=self.review_env,
                workflow_ref=self.repo
                + "/.github/workflows/staging-request.yml@refs/heads/main",
                workflow_sha=self.revision,
                sha=self.revision,
                actor_id=self.actor,
                run_attempt="1",
                run_id=str(self.run),
            )
        else:
            values.update(
                iss=self.auth.issuers[0],
                aud=self.api_id,
                sub="app-principal",
                tid=self.tenant,
                azp="app-client",
                oid="app-principal",
                roles=["App.Poll"],
            )
        values.update(claims)
        return jwt.encode(values, self.key, algorithm="RS256")

    def request(self, action, **extra):
        return dict(
            schemaVersion=1,
            environment="s2",
            operation=action,
            requestId=uid(),
            requester="1",
            **extra
        )

    def approve(self, payload, role="lifecycle"):
        self.service.draft(dict(role="member", object_id="member-1"), payload)
        self.run += 1
        return self.service.approved(
            dict(role=role), self.token("github", payload), payload
        )

    def start(self, power=True):
        payload = self.request("start")
        result = self.approve(payload)
        if power:
            self.service.reconcile()
            for role in self.cloud.states:
                self.cloud.done(role, "start")
            self.advance(60)
            self.service.reconcile()
        return result

    def advance(self, seconds):
        self.time += timedelta(seconds=seconds)

    def nodes(self):
        rows = {
            r: dict(epoch=uid(), boot=uid(), retired_jobs=[]) for r in ("app", "judge")
        }
        self.service.app(self.app, "observe", rows)
        return rows

    def deploy(self):
        nodes = self.nodes()
        payload = self.request(
            "deploy",
            sessionGeneration=self.store.state["generation"],
            releaseDigest=self.release,
            migration=dict(
                system_id="123456",
                recovery_point="verified/fixture",
                rollbackDigest=self.release,
            ),
        )
        self.review_env, self.reviewer = "staging-deployment", "3"
        self.approve(payload, "deployment")
        return payload, nodes

    def verify_release(self, payload, nodes):
        op = payload["requestId"]
        images = fixture()["images"]
        workloads = fixture()["environments"]["s2"]["workloads"]
        evidence = {}
        for role, names in (
            (
                "app",
                (
                    "auth-service",
                    "problem-service",
                    "submission-service",
                    "website",
                    "envoy",
                ),
            ),
            ("judge", ("judge-worker", "go-judge")),
        ):
            evidence[role] = dict(
                epoch=nodes[role]["epoch"],
                boot=nodes[role]["boot"],
                containers={
                    n: dict(
                        uid=uid(),
                        container=uid(),
                        workload=n,
                        image=images[n],
                        config=workloads[n],
                    )
                    for n in names
                },
            )
        evidence["app"]["backing"] = {
            name: images[name] for name in ("postgres", "redis", "kafka", "minio")
        }
        self.service.app(
            self.app,
            "complete",
            dict(operation=op, observed=evidence, versions=fixture()["versions"]),
        )
        self.service.app(self.app, "open", dict(operation=op))

    def test_separate_start_deploy_lease_ready_clock_and_extension(self):
        started = self.start()
        self.assertIsNone(self.service.app(self.app, "poll", {})["ticket"])
        self.assertFalse(self.service.app(self.app, "tester", {})["tester"])
        payload, nodes = self.deploy()
        op = payload["requestId"]
        self.assertEqual(self.service.app(self.app, "poll", {})["ticket"], op)
        self.assertEqual(
            self.service.app(self.app, "authorization", dict(operation=op))[
                "allowed_workloads"
            ],
            [],
        )
        self.service.app(self.app, "begin", dict(operation=op, release=self.release))
        self.assertEqual(self.service.app(self.app, "tester", {})["smoke"], True)
        self.verify_release(payload, nodes)
        self.assertEqual(
            self.store.state["expires"], (self.time + timedelta(hours=1)).isoformat()
        )
        self.assertTrue(self.service.app(self.app, "tester", {})["tester"])
        self.review_env, self.reviewer = "staging-lifecycle", "1"
        expires = self.time + timedelta(hours=2)
        extension = self.request(
            "extend",
            sessionGeneration=started["generation"],
            requestedExpiry=expires.isoformat(),
        )
        self.approve(extension)
        self.assertEqual(self.store.state["expires"], expires.isoformat())
        with self.assertRaises(Refused):
            self.approve(
                dict(
                    extension,
                    requestId=uid(),
                    requestedExpiry=(self.time + timedelta(hours=18)).isoformat(),
                )
            )

    def test_proof_and_replay(self):
        p = self.request("start")
        self.service.draft(dict(role="member", object_id="member-1"), p)
        for claims in (
            dict(ref="refs/heads/develop"),
            dict(run_attempt="2"),
            dict(workflow_sha="b" * 40),
            dict(environment="staging-deployment"),
        ):
            with self.assertRaises(Refused):
                self.service.approved(
                    dict(role="lifecycle"), self.token("github", p, **claims), p
                )
        with self.assertRaises(Refused):
            self.service.approved(dict(role="deployment"), self.token("github", p), p)
        with self.assertRaises(Refused):
            self.service.approved(
                dict(role="lifecycle"), self.token("github", p), dict(p, requester="2")
            )
        self.reviewer = "2"
        with self.assertRaises(Refused):
            self.service.approved(dict(role="lifecycle"), self.token("github", p), p)
        self.reviewer = "1"
        self.store.reject = True
        result = self.service.approved(
            dict(role="lifecycle"), self.token("github", p), p
        )
        self.assertEqual(
            result,
            self.service.approved(dict(role="lifecycle"), self.token("github", p), p),
        )
        self.run += 1
        with self.assertRaises(Refused):
            self.service.approved(dict(role="lifecycle"), self.token("github", p), p)
        with self.assertRaises(Refused):
            self.approve(self.request("start"))
        self.assertEqual(
            self.store.state["startup_approval"]["identity"]["requester"], "1"
        )
        self.assertEqual(
            self.store.state["startup_approval"]["identity"]["dispatcher"], "2"
        )
        self.assertEqual(self.cloud.sent, [])

    def test_late_start_partial_stop_and_restart(self):
        self.start(power=False)
        self.cloud.lose = ("judge", "start")
        self.service.reconcile()
        self.cloud.done("app", "start")
        self.advance(60)
        replacement = Service(
            self.policy,
            self.store,
            self.auth,
            lambda _: self.catalog_record,
            self.cloud,
            lambda: self.time,
        )
        replacement.reconcile()
        self.assertEqual(self.store.state["phase"], "draining")
        self.advance(301)
        replacement.reconcile()
        self.assertIn(("app", "deallocate"), self.cloud.sent)
        self.cloud.done("app", "deallocate")
        self.cloud.states["judge"] = "running"
        self.advance(61)
        replacement.reconcile()
        self.assertIn(("judge", "deallocate"), self.cloud.sent)
        self.cloud.done("judge", "deallocate")
        self.advance(601)
        result = replacement.reconcile()
        self.assertEqual(self.cloud.sent.count(("judge", "start")), 1)
        self.assertEqual(self.store.state["phase"], "stopping")
        self.assertTrue(result["overdue"])
        self.assertFalse(replacement.app(self.app, "tester", {})["tester"])

    def test_expiry_drain_with_retained_work_and_timer_after_cancelled_workflow(self):
        self.start()
        payload, nodes = self.deploy()
        self.service.app(
            self.app,
            "begin",
            dict(operation=payload["requestId"], release=self.release),
        )
        self.verify_release(payload, nodes)
        self.advance(3601)
        self.assertFalse(self.service.app(self.app, "tester", {})["tester"])
        self.service.reconcile()
        self.assertEqual(self.store.state["phase"], "draining")
        self.service.app(self.app, "observe", nodes)
        counts = dict(attempts=2, outbox=1, jobs=2, results=1, dlt=1)
        self.service.app(
            self.app,
            "drained",
            dict(
                generation=self.store.state["generation"],
                epoch=nodes["app"]["epoch"],
                uid=self.store.state["submission_uid"],
                ceased=True,
                retained=counts,
            ),
        )
        self.service.reconcile()
        for role in self.cloud.states:
            self.cloud.done(role, "deallocate")
        self.advance(60)
        self.service.reconcile()
        self.assertEqual(self.store.state["phase"], "off")
        self.assertEqual(self.store.state["drain"]["retained_work"], counts)
        self.assertTrue(self.store.state["clean_drain"])

    def test_stale_app_or_changed_epoch_revokes_runtime_authorization(self):
        self.start()
        payload, nodes = self.deploy()
        op = payload["requestId"]
        self.service.app(self.app, "begin", dict(operation=op, release=self.release))
        self.assertTrue(
            self.service.app(self.app, "authorization", dict(operation=op))[
                "allowed_workloads"
            ]
        )
        self.advance(16)
        with self.assertRaises(RuntimeError):
            self.service.app(self.app, "authorization", dict(operation=op))
        changed = dict(nodes, judge=dict(nodes["judge"], epoch=uid()))
        self.service.app(self.app, "observe", changed)
        self.assertEqual(self.store.state["in_flight"], op)
        self.assertEqual(self.store.state["operation"]["phase"], "recovery-required")
        self.assertFalse(self.service.app(self.app, "tester", {})["smoke"])

    def test_s3_frozen_deadline_independent_cleanup(self):
        policy = dict(
            self.policy,
            environment="s3",
            experiment=dict(
                id=uid(),
                targets=self.policy["targets"],
                approval_ref="reviewed",
                deadline=(self.time + timedelta(minutes=20)).isoformat(),
            ),
        )
        store = Store()
        cloud = Cloud(store)
        cloud.states = dict.fromkeys(cloud.states, "running")
        manager = Service(policy, store, self.auth, None, cloud, lambda: self.time)
        manager.reconcile()
        self.assertEqual(cloud.sent, [])
        self.advance(1201)
        manager.reconcile()
        self.assertTrue(store.state["inventory_followup"])
        self.advance(301)
        manager.reconcile()
        self.assertEqual(cloud.sent, [("app", "deallocate"), ("judge", "deallocate")])

    def test_off_window_and_freeze_refuse_start_but_allow_cleanup(self):
        self.store.state["off_seconds"] = 43199
        with self.assertRaises(Refused):
            self.approve(self.request("start"))
        self.store.state["off_seconds"] = 43200
        self.store.state["contest"] = True
        with self.assertRaises(Refused):
            self.approve(self.request("start"))
        self.store.state["contest"] = False
        generation = self.start()["generation"]
        self.store.state["contest"] = True
        self.approve(self.request("cancel", sessionGeneration=generation))
        self.assertEqual(self.store.state["phase"], "draining")

    def test_function_binding_and_expiring_edge_cache(self):
        self.start()
        route = api.build().get_user_function()
        with patch("function_app.service", return_value=self.service):
            request = func.HttpRequest(
                method="POST",
                url="https://fixture.invalid/api/v1/app/tester",
                headers={"Authorization": "Bearer " + self.token("entra")},
                route_params={"action": "app", "subaction": "tester"},
                body=b"{}",
            )
            self.assertEqual(route(request).status_code, 200)
            self.assertFalse(json.loads(route(request).get_body())["tester"])
            wrong = func.HttpRequest(
                method="POST",
                url="https://fixture.invalid/api/v1/app/tester",
                headers={
                    "Authorization": "Bearer "
                    + self.token("entra", roles=["Staging.Lifecycle"])
                },
                route_params={"action": "app", "subaction": "tester"},
                body=b"{}",
            )
            self.assertEqual(route(wrong).status_code, 403)

        class Gate:
            def call(self, _):
                return dict(
                    tester=True,
                    smoke=False,
                    until=(
                        datetime.now(timezone.utc) + timedelta(seconds=2)
                    ).isoformat(),
                )

        lease = Lease(Gate)
        self.assertTrue(lease.permits("tester"))
        self.assertFalse(lease.permits("smoke"))
        lease.until = 0
        lease.controller = lambda: None
        with patch.object(lease, "controller", side_effect=OSError):
            self.assertFalse(lease.permits("tester"))


class Emergency(unittest.TestCase):
    def test_power_boundary_and_two_actual_states(self):
        sub = (
            "/subscriptions/"
            + uid()
            + "/resourceGroups/fixture/providers/Microsoft.Compute/virtualMachines/"
        )
        power = Power(
            dict(app=sub + "app", judge=sub + "judge"),
            lambda: "unused",
            allow_start=False,
        )
        with patch.object(power, "call") as http:
            with self.assertRaises(Refused):
                power.send("app", "start", uid())
            http.assert_not_called()
        with patch.object(
            power,
            "observe",
            side_effect=[
                dict(app="deallocated", judge="running"),
                dict(app="deallocated", judge="deallocated"),
            ],
        ), patch.object(power, "send", return_value=None) as send:
            states, confirmed = deallocate(power, sleep=lambda _: None)
            self.assertTrue(confirmed)
            self.assertEqual(states, dict(app="deallocated", judge="deallocated"))
            self.assertEqual(send.call_args.args[:2], ("judge", "deallocate"))


if __name__ == "__main__":
    unittest.main()
