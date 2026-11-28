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
from azure_adapters import Power, Releases
from emergency import deallocate
from function_app import api
from policy import canonical, digest, envelope
from policy import Refused as ReleaseRefused
from node_state import RecoveryRequired
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
                ref_protected="true",
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
            **extra,
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

    def verify_release(self, payload, nodes, *, open_edge=True):
        op = payload["requestId"]
        expected = self.store.state["operation"]["expected"]
        images = expected["images"]
        workloads = expected["workloads"]
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
            dict(operation=op, observed=evidence, versions=expected["versions"]),
        )
        if open_edge:
            self.service.app(self.app, "open", dict(operation=op))

    def rehearsal(self):
        def receipt(char, name):
            data = fixture()
            source = char * 40
            data.update(kind="rehearsal", source=source, configuration_revision=source)
            data["ci"]["source"] = source
            data["images"]["website"] = "ghcr.io/fixture/rehearsal/website@" + digest(
                name.encode()
            )
            return envelope(data)

        self.first, self.second, self.unapproved = (
            receipt("a", "first"),
            receipt("b", "second"),
            receipt("c", "unknown"),
        )
        receipts = (self.first, self.second)
        self.policy.update(
            environment="s3",
            rehearsal_owner="1",
            experiment=dict(
                id=uid(),
                targets=self.policy["targets"],
                approval_ref="reviewed-experiment",
                deadline=(self.time + timedelta(minutes=45)).isoformat(),
                releases={row["bundle"]: row["source"] for row in receipts},
            ),
        )
        self.store = Store()
        self.cloud = Cloud(self.store)
        self.cloud.states = dict.fromkeys(self.cloud.states, "running")
        self.receipts = {
            "rehearsal-" + row["bundle"][7:] + ".json": row
            for row in (*receipts, self.unapproved)
        }
        self.catalog = Releases(
            self.policy, None, "https://fixture.blob.core.windows.net"
        )
        blob = patch("azure_adapters.BlobStore")
        store = blob.start()
        self.addCleanup(blob.stop)
        store.side_effect = self.rehearsal_blob
        self.service = self.rehearsal_service()
        self.service.reconcile()
        self.operator = dict(role="rehearsal-operator", object_id="rehearsal-principal")

    def rehearsal_blob(self, endpoint, container, name, identity):
        self.assertEqual(
            (endpoint, container),
            ("https://fixture.blob.core.windows.net", "controller-state"),
        )
        return type(
            "Receipt", (), {"read": lambda _: (self.receipts.get(name), None)}
        )()

    def rehearsal_service(self):
        return Service(
            self.policy,
            self.store,
            self.auth,
            self.catalog,
            self.cloud,
            lambda: self.time,
        )

    def rehearsal_request(self, action, **extra):
        return dict(
            self.request(action),
            environment="s3",
            sessionGeneration=self.store.state["generation"],
            **extra,
        )

    def rehearsal_deploy(self, selected, rollback, action="deploy", **evidence):
        return self.rehearsal_request(
            action,
            releaseDigest=selected["bundle"],
            migration=dict(
                system_id="123456",
                recovery_point="verified/fixture",
                rollbackDigest=rollback["bundle"],
                **evidence,
            ),
        )

    def rehearsal_begin(self, payload):
        self.service.approved(self.operator, None, payload)
        self.service.app(
            self.app,
            "begin",
            dict(operation=payload["requestId"], release=payload["releaseDigest"]),
        )

    def test_s3_two_reviewed_releases_deploy_and_rollback(self):
        self.rehearsal()
        nodes = self.nodes()
        original = copy.deepcopy(self.store.state["experiment"])
        first = self.rehearsal_deploy(self.first, self.first)
        self.rehearsal_begin(first)
        self.verify_release(first, nodes)
        for candidate in (
            self.rehearsal_deploy(self.first, self.second, "deploy"),
            self.rehearsal_deploy(self.unapproved, self.first),
            self.rehearsal_deploy(self.first, self.unapproved),
            self.rehearsal_deploy(self.second, self.first, "rollback"),
        ):
            with self.assertRaises((Refused, ReleaseRefused)):
                self.service.approved(self.operator, None, candidate)
        self.policy["experiment"] = dict(
            original,
            releases=dict(
                original["releases"],
                **{
                    self.unapproved["bundle"]: self.unapproved["source"],
                },
            ),
        )
        with self.assertRaisesRegex(Refused, "experiment deadline differs"):
            self.service.approved(
                self.operator, None, self.rehearsal_deploy(self.unapproved, self.first)
            )
        self.policy["experiment"] = original
        for selected, previous, action in (
            (self.second, self.first, "deploy"),
            (self.first, self.second, "rollback"),
        ):
            payload = self.rehearsal_deploy(selected, previous, action)
            self.rehearsal_begin(payload)
            self.verify_release(payload, nodes)
            self.assertEqual(self.store.state["last_verified"], selected["bundle"])
        self.assertEqual(self.store.state["experiment"], original)
        self.assertEqual(self.store.state["expires"], original["deadline"])

    def test_s3_drain_hard_stop_resume_and_separate_workload_recovery(self):
        self.rehearsal()
        old_nodes = self.nodes()
        original = copy.deepcopy(self.store.state["experiment"])
        interrupted = self.rehearsal_deploy(self.first, self.first)
        self.rehearsal_begin(interrupted)
        job = uid()
        op = interrupted["requestId"]
        self.service.app(
            self.app, "bind-migration", dict(operation=op, job=job, uid=uid())
        )
        self.cloud.states = dict.fromkeys(self.cloud.states, "deallocated")
        self.advance(60)
        self.service.reconcile()
        self.advance(301)
        self.service.reconcile()
        self.assertEqual(self.store.state["phase"], "off")
        self.assertEqual(self.store.state["in_flight"], op)
        resume = self.rehearsal_request("resume-rehearsal", recoveryAttempt=op)
        for request, caller in (
            (dict(resume, sessionGeneration=uid()), self.operator),
            (dict(resume, recoveryAttempt=uid()), self.operator),
            (resume, self.app),
        ):
            with self.assertRaises(Refused):
                self.service.approved(caller, None, request)
        self.service.approved(self.operator, None, resume)
        with self.assertRaises(Refused):
            self.service.approved(self.operator, None, resume)
        # Recreate the service against the same durable state while powered off.
        self.service = self.rehearsal_service()
        self.service.reconcile()
        self.cloud.states = dict.fromkeys(self.cloud.states, "running")
        self.service.reconcile()
        with self.assertRaises(Refused):
            self.service.app(self.app, "observe", old_nodes)
        nodes = self.nodes()
        self.assertIsNone(self.service.app(self.app, "poll", {})["ticket"])
        with self.assertRaises(RecoveryRequired):
            self.service.app(self.app, "authorization", dict(operation=op))
        self.assertFalse(self.service.app(self.app, "tester", {})["tester"])
        recover = self.rehearsal_deploy(
            self.first,
            self.first,
            "recover",
            reconcile_attempt=op,
            observed_versions=fixture()["versions"],
            confirmed_retired_jobs=[job],
            work_reconciled=True,
        )
        with self.assertRaises(Refused):
            self.service.approved(
                self.operator,
                None,
                dict(
                    recover,
                    migration=dict(recover["migration"], confirmed_retired_jobs=[]),
                ),
            )
        self.rehearsal_begin(recover)
        self.assertNotIn(
            "migrate",
            self.service.app(
                self.app, "authorization", dict(operation=recover["requestId"])
            )["allowed_workloads"],
        )
        self.verify_release(recover, nodes)
        self.assertEqual(self.store.state["experiment"], original)
        self.assertEqual(self.store.state["expires"], original["deadline"])
        self.assertIsNone(self.store.state["in_flight"])
        self.assertEqual(self.cloud.sent, [])

    def test_s3_unapproved_and_expired_external_start_are_drained(self):
        self.rehearsal()
        self.nodes()
        interrupted = self.rehearsal_deploy(self.first, self.first)
        self.rehearsal_begin(interrupted)
        self.cloud.states = dict.fromkeys(self.cloud.states, "deallocated")
        self.advance(60)
        self.service.reconcile()
        self.advance(301)
        self.service.reconcile()
        resume = self.rehearsal_request(
            "resume-rehearsal", recoveryAttempt=interrupted["requestId"]
        )
        self.cloud.states = dict.fromkeys(self.cloud.states, "running")
        self.service.reconcile()
        self.assertEqual(self.store.state["phase"], "draining")
        with self.assertRaises(Refused):
            self.service.approved(self.operator, None, resume)
        self.advance(301)
        self.service.reconcile()
        for role in self.cloud.states:
            self.cloud.done(role, "deallocate")
        self.service.reconcile()
        self.service.approved(self.operator, None, resume)
        self.advance(601)
        self.service.reconcile()
        self.cloud.states = dict.fromkeys(self.cloud.states, "running")
        with self.assertRaises(Refused):
            self.service.approved(self.operator, None, dict(resume, requestId=uid()))
        self.advance(301)
        self.service.reconcile()
        self.assertEqual(self.store.state["phase"], "stopping")
        self.assertEqual(
            set(self.cloud.sent), {("app", "deallocate"), ("judge", "deallocate")}
        )

    def test_s3_sealed_partial_recovery_requires_separate_forward_deploy(self):
        self.rehearsal()
        self.nodes()
        interrupted = self.rehearsal_deploy(self.first, self.first)
        self.rehearsal_begin(interrupted)
        self.cloud.states = dict.fromkeys(self.cloud.states, "deallocated")
        self.advance(60)
        self.service.reconcile()
        self.advance(301)
        self.service.reconcile()
        resume = self.rehearsal_request(
            "resume-rehearsal", recoveryAttempt=interrupted["requestId"]
        )
        self.service.approved(self.operator, None, resume)
        self.cloud.states = dict.fromkeys(self.cloud.states, "running")
        self.service.reconcile()
        nodes = self.nodes()
        versions = dict(auth=0, problem=1, submission=0)
        recover = self.rehearsal_deploy(
            self.first,
            self.first,
            "recover",
            reconcile_attempt=interrupted["requestId"],
            observed_versions=versions,
            confirmed_retired_jobs=[],
            work_reconciled=True,
        )
        self.rehearsal_begin(recover)
        operation = recover["requestId"]
        with self.assertRaises(RecoveryRequired):
            self.service.app(
                self.app,
                "sealed-recovery",
                dict(operation=operation, versions=fixture()["versions"]),
            )
        self.service.app(
            self.app, "sealed-recovery", dict(operation=operation, versions=versions)
        )
        self.service.app(self.app, "recovery-required", dict(operation=operation))
        self.assertEqual(self.store.state["operation"]["phase"], "forward-required")
        self.assertEqual(self.store.state["forward_required"]["versions"], versions)
        self.assertIsNone(self.service.app(self.app, "poll", {})["ticket"])
        self.assertFalse(self.service.app(self.app, "tester", {})["tester"])
        with self.assertRaises(Refused):
            self.service.approved(
                self.operator, None, self.rehearsal_deploy(self.second, self.second)
            )
        deploy = self.rehearsal_deploy(self.first, self.first)
        self.rehearsal_begin(deploy)
        self.verify_release(deploy, nodes)
        self.assertNotIn("forward_required", self.store.state)

    def test_s2_provisioning_window_never_starts_or_admits_workloads(self):
        self.cloud.states = dict.fromkeys(self.cloud.states, "not-found")
        self.service.reconcile()
        plan = dict(
            sha256="d" * 64,
            operation="create",
            role=None,
            expiresAt=(self.time + timedelta(minutes=25)).isoformat(),
        )
        request = self.request("start", terraformPlan=plan)
        result = self.approve(request)
        self.assertEqual(result["terraformPlan"], plan)
        self.assertEqual(result["phase"], "compute-maintenance")
        self.cloud.states["app"] = "running"
        self.advance(60)
        self.service.reconcile()
        self.assertEqual(self.cloud.sent, [])
        with self.assertRaises(Refused):
            self.nodes()
        self.assertFalse(self.service.app(self.app, "tester", {})["tester"])
        self.advance(1500)
        self.service.reconcile()
        self.advance(300)
        self.service.reconcile()
        self.assertEqual(self.cloud.sent, [("app", "deallocate")])

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
            dict(ref_protected="false"),
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
                release=self.release,
                source=self.catalog_record["source"],
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
        with (
            patch.object(
                power,
                "observe",
                side_effect=[
                    dict(app="deallocated", judge="running"),
                    dict(app="deallocated", judge="deallocated"),
                ],
            ),
            patch.object(power, "send", return_value=None) as send,
        ):
            states, confirmed = deallocate(power, sleep=lambda _: None)
            self.assertTrue(confirmed)
            self.assertEqual(states, dict(app="deallocated", judge="deallocated"))
            self.assertEqual(send.call_args.args[:2], ("judge", "deallocate"))


if __name__ == "__main__":
    unittest.main()
