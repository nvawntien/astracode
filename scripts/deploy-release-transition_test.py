#!/usr/bin/env python3
import importlib.util
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("transition", ROOT / "scripts/deploy-release-transition.py")
transition = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transition)

OLD = "v1.0.0"
NEW = "v1.0.1"


class FakeNodes:
    def __init__(self, failures=(), *, legacy=False):
        self.events = []
        self.failures = list(failures)
        self.app = OLD
        self.worker = OLD
        self.legacy = legacy
        self.legacy_from = ""

    def record(self, name, *args):
        event = (name, *args)
        self.events.append(event)
        if event in self.failures:
            self.failures.remove(event)
            return True
        return False

    def preflight(self, target):
        self.record("preflight", target)
        return OLD

    def suspend(self, tag):
        if self.record("suspend", tag):
            raise RuntimeError("Judge SSH unavailable")
        self.worker = None

    def suspend_verified(self, tag):
        self.suspend(tag)

    def idle(self):
        if self.record("idle"):
            raise RuntimeError("unexpected Kafka group member")
        assert self.worker is None

    def deploy_app(self, tag):
        assert self.worker is None
        if self.record("app", tag):
            raise subprocess.CalledProcessError(1, "app")
        if self.record("app-response", tag):
            self.app = tag
            raise subprocess.CalledProcessError(255, "ssh")
        self.app = tag

    def rollback_app(self, current, previous):
        assert self.worker is None
        if self.record("rollback", current, previous):
            raise RuntimeError("rollback failed")
        assert self.app == current
        self.app = previous

    def verify(self, tag):
        assert self.worker is None
        if self.record("verify", tag) or (self.legacy and tag == OLD):
            raise RuntimeError("GetTestCase contract missing or replica mismatch")
        assert tag == self.app

    def start_judge(self, tag, previous):
        assert self.worker is None
        assert tag == self.app
        self.worker = tag
        if self.record("judge", tag, previous):
            raise RuntimeError("Judge health failed after container started")


class ReleaseTransitionTests(unittest.TestCase):
    def test_legacy_workflow_has_no_deployment_entry_point(self):
        workflow = (ROOT / ".github/workflows/deploy-production.yml").read_text()
        self.assertNotIn("Deploy and verify Judge Node first", workflow)
        self.assertNotIn("workflow_dispatch:", workflow)
        self.assertNotIn("environment: production", workflow)

    def run_transition(self, nodes, target=NEW):
        stderr = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
            result = transition.deploy(nodes, target)
        return result, stderr.getvalue()

    def test_legacy_bootstrap_explicitly_routes_verified_identity_and_refuses_legacy_resume(self):
        nodes = FakeNodes([("verify", NEW)], legacy=True)
        nodes.legacy_from = OLD
        nodes.verify_legacy = lambda tag: nodes.record("verify-legacy", tag)
        ok, log = self.run_transition(nodes)
        self.assertFalse(ok)
        self.assertEqual(nodes.events[-4:], [
            ("suspend", NEW), ("idle",), ("rollback", NEW, OLD), ("verify-legacy", OLD),
        ])
        self.assertIn("judging remains suspended", log)
        self.assertIsNone(nodes.worker)

    def test_retired_workflow_has_no_credentials_or_legacy_inputs(self):
        workflow = (ROOT / ".github/workflows/deploy-production.yml").read_text()
        self.assertNotIn("legacy_from:", workflow)
        self.assertNotIn("secrets.", workflow)
        self.assertIn("permissions: {}", workflow)

    def test_legacy_coordinator_carries_broker_evidence_to_suspension(self):
        for member in ("sarama-member-A", ""):
            with self.subTest(member=member):
                node = transition.Nodes("/opt/astracode/.deploy/rollout.abcdefgh",
                                        "/opt/astracode/.deploy/rollout.hgfedcba",
                                        ["42", "1000", "524288"], OLD, "192.0.2.20")
                calls = []
                identifier = "a" * 64
                settings = "192.0.2.10:9092 192.0.2.10:9094 group-A judge.jobs"

                def judge(*args, capture=False):
                    calls.append(args)
                    if capture:
                        return f"{OLD}\n{settings}\n{identifier}\n"

                def gate(*args, capture=False):
                    calls.append(args)
                    self.assertTrue(capture)
                    return member

                node.remote = lambda *args: None
                node.judge = judge
                node.app = lambda *args: OLD
                node.app_gate = gate
                if not member:
                    with self.assertRaisesRegex(RuntimeError, "did not identify"):
                        node.preflight(NEW)
                    self.assertEqual([call[0] for call in calls], ["--legacy-preflight", "legacy-preflight"])
                    continue
                self.assertEqual(node.preflight(NEW), OLD)
                node.suspend_verified(OLD)
                self.assertEqual(calls, [
                    ("--legacy-preflight", NEW, node.judge_probe, OLD),
                    ("legacy-preflight", OLD, node.app_probe, "192.0.2.20", "42", "1000", "524288"),
                    ("--legacy-suspend", OLD, node.judge_probe, identifier, settings, "192.0.2.20", member),
                ])

    def test_legacy_failures_keep_judging_suspended(self):
        for failures, restored in (
            ([("app", NEW)], True),
            ([("verify", NEW)], True),
            ([("judge", NEW, OLD)], True),
            ([("app-response", NEW)], False),
            ([("idle",), ("idle",)], False),
            ([("judge", NEW, OLD), ("rollback", NEW, OLD)], False),
        ):
            with self.subTest(failures=failures):
                nodes = FakeNodes(failures, legacy=True)
                nodes.legacy_from = OLD
                nodes.verify_legacy = lambda tag: nodes.record("verify-legacy", tag)
                ok, log = self.run_transition(nodes)
                self.assertFalse(ok)
                self.assertIsNone(nodes.worker)
                self.assertNotIn(("judge", OLD, OLD), nodes.events)
                self.assertEqual(("verify-legacy", OLD) in nodes.events, restored)
                self.assertIn("Operator action required", log)

    def test_suspend_and_contract_gate_precede_any_new_worker(self):
        nodes = FakeNodes(legacy=True)
        self.assertEqual(self.run_transition(nodes), (True, ""))
        self.assertEqual(nodes.events, [
            ("preflight", NEW), ("suspend", OLD), ("idle",),
            ("app", NEW), ("app-response", NEW), ("verify", NEW), ("judge", NEW, OLD),
        ])

    def test_worker_identity_change_during_verified_suspend_blocks_app_and_recovery(self):
        nodes = FakeNodes([("suspend", OLD)])
        ok, log = self.run_transition(nodes)
        self.assertFalse(ok)
        self.assertIn("Could not verify Judge suspension", log)
        self.assertEqual(nodes.events, [("preflight", NEW), ("suspend", OLD)])

    def test_app_failure_uses_transaction_restore_and_reverifies_old_pair(self):
        nodes = FakeNodes([("app", NEW)])
        ok, log = self.run_transition(nodes)
        self.assertFalse(ok)
        self.assertIn("Restored and verified", log)
        self.assertEqual(nodes.events[-4:], [
            ("suspend", NEW), ("idle",), ("verify", OLD), ("judge", OLD, OLD),
        ])

    def test_probe_or_judge_health_failure_restores_app_first(self):
        for failure in (("verify", NEW), ("judge", NEW, OLD)):
            with self.subTest(failure=failure):
                nodes = FakeNodes([failure])
                ok, log = self.run_transition(nodes)
                self.assertFalse(ok)
                self.assertIn("Restored and verified", log)
                self.assertEqual(nodes.events[-5:], [
                    ("suspend", NEW), ("idle",), ("rollback", NEW, OLD),
                    ("verify", OLD), ("judge", OLD, OLD),
                ])
                if failure[0] == "verify":
                    self.assertNotIn(("judge", NEW, OLD), nodes.events)

    def test_legacy_or_partial_app_rollback_holds_worker_stopped(self):
        for legacy, failures in (
            (True, [("verify", NEW)]),
            (False, [("judge", NEW, OLD), ("rollback", NEW, OLD)]),
        ):
            with self.subTest(legacy=legacy):
                nodes = FakeNodes(failures, legacy=legacy)
                ok, log = self.run_transition(nodes)
                self.assertFalse(ok)
                self.assertIn("Operator action required", log)
                self.assertIsNone(nodes.worker)
                self.assertNotIn(("judge", OLD, OLD), nodes.events)

    def test_partial_judge_recovery_is_stopped_again(self):
        nodes = FakeNodes([("judge", NEW, OLD), ("judge", OLD, OLD)])
        ok, log = self.run_transition(nodes)
        self.assertFalse(ok)
        self.assertIn("Operator action required", log)
        self.assertEqual(nodes.events[-1], ("suspend", OLD))
        self.assertIsNone(nodes.worker)

    def test_ambiguous_ssh_failure_does_not_guess_app_rollback_state(self):
        nodes = FakeNodes([("app-response", NEW)])
        ok, log = self.run_transition(nodes)
        self.assertFalse(ok)
        self.assertIn("activation outcome is unknown", log)
        self.assertEqual(nodes.app, NEW)
        self.assertIsNone(nodes.worker)
        self.assertNotIn(("rollback", NEW, OLD), nodes.events)

    def test_unavailable_judge_blocks_app_mutations(self):
        nodes = FakeNodes([("suspend", OLD)])
        ok, log = self.run_transition(nodes)
        self.assertFalse(ok)
        self.assertIn("Operator action required", log)
        self.assertEqual(nodes.events, [("preflight", NEW), ("suspend", OLD)])

    def test_extra_consumer_blocks_app_and_judge_activation(self):
        nodes = FakeNodes([("idle",), ("idle",)])
        ok, log = self.run_transition(nodes)
        self.assertFalse(ok)
        self.assertIn("unexpected Kafka group member", log)
        self.assertEqual(nodes.events, [("preflight", NEW), ("suspend", OLD), ("idle",), ("suspend", NEW), ("idle",)])

    def test_same_tag_still_requires_suspension_and_verification(self):
        nodes = FakeNodes()
        self.assertEqual(self.run_transition(nodes, OLD), (True, ""))
        self.assertEqual(nodes.events[-2:], [("verify", OLD), ("judge", OLD, OLD)])
        self.assertIn(("suspend", OLD), nodes.events)


class AppGateTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name)
        self.probes = path / "probes"
        docker = path / "docker"
        docker.write_text("""#!/usr/bin/env python3
import os
import sys
cmd, *args = sys.argv[1:]
scenario = os.environ['SCENARIO']
if cmd == 'ps':
    service = args[-1].split('=')[-1]
    if service == 'problem-service':
        print('problem\\nextra' if scenario == 'replica' else 'problem')
    elif service == 'kafka':
        print('broker')
elif cmd == 'inspect':
    pattern, name = args[1:3]
    if pattern == '{{.Id}}':
        print({'judge_problem':'problem', 'judge_kafka':'broker'}[name])
    elif pattern == '{{.Config.Image}}':
        print('registry/astra/problem-service:' + ('v1.0.0' if scenario == 'old-image' else 'v1.0.1'))
    elif pattern == '{{.Image}}':
        print('sha256:actual')
    else:
        sys.exit(2)
elif cmd == 'image':
    print('sha256:actual')
elif cmd == 'port':
    print('192.0.2.10:' + ('9092' if args[0] == 'problem' else '9094'))
elif cmd == 'exec':
    if 'kafka-consumer-groups.sh' in args:
        count = 'Stable 1' if scenario == 'active-consumer' else 'Empty 0'
        print('judge-worker-v1 192.0.2.10:9094 (1) ' + count)
    elif 'kafka-topics.sh' not in args:
        sys.exit(2)
else:
    sys.exit(2)
""")
        sleep = path / "sleep"
        sleep.write_text("#!/bin/sh\nexit 0\n")
        self.probe = path / "probe"
        self.probe.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$PROBES"\n')
        for executable in (docker, sleep, self.probe):
            executable.chmod(0o700)
        self.env = dict(os.environ, PATH=str(path) + os.pathsep + os.environ["PATH"], PROBES=str(self.probes))

    def gate(self, scenario):
        return subprocess.run([
            "bash", str(ROOT / "scripts/verify-judge-rollout-app.sh"), "ready",
            "192.0.2.10:9092", "192.0.2.10:9094", "judge-worker-v1", "judge.submission.jobs",
            NEW, str(self.probe), "42", "1000", "524288",
        ], text=True, capture_output=True, env=dict(self.env, SCENARIO=scenario))

    def test_probe_runs_with_expected_units_for_single_matching_problem(self):
        result = self.gate("ready")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.probes.read_text(), "metadata 192.0.2.10:9092 42 1000 524288\n")

    def test_replica_old_image_and_active_group_block_readiness(self):
        for scenario, reason in (
            ("replica", "exactly one running problem-service"),
            ("old-image", "does not match release"),
            ("active-consumer", "did not report Empty"),
        ):
            with self.subTest(scenario=scenario):
                result = self.gate(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(reason, result.stderr)
                self.assertFalse(self.probes.exists())


class JudgeGateTests(unittest.TestCase):
    def test_worker_is_started_only_after_private_probe_and_suspended_on_health_failure(self):
        for scenario in ("ready", "probe-fails", "health-fails"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                path = Path(directory)
                (path / "compose.yml").write_text("services: {}\n")
                (path / "config.yaml").write_text("grpc_port: 9093\n")
                docker = path / "docker"
                docker.write_text("""#!/usr/bin/env python3
import os, pathlib, sys
cmd, *args = sys.argv[1:]
root = pathlib.Path(os.environ['FIXTURE_DIR'])
active = root / 'active'
def record(value):
    with (root / 'trace').open('a') as f:
        print(value, file=f)
if cmd == 'ps':
    print('workerid')
elif cmd == 'inspect':
    pattern, name = args[1:3]
    if pattern == '{{.Id}}':
        print('workerid')
    elif pattern.startswith('{{.State.Status}}'):
        print('running unless-stopped' if active.exists() else 'exited no')
    elif pattern == '{{.State.Running}}':
        print('true')
    elif pattern == '{{.State.StartedAt}}':
        print('2026-01-01T00:00:00Z')
    elif '.State.Health' in pattern and name == 'workerid' and os.environ['SCENARIO'] == 'health-fails':
        print('unhealthy')
elif cmd == 'compose':
    operation, *rest = args[4:]
    if operation == 'config':
        print('{}')
    elif operation == 'up':
        record('start ' + rest[-1])
        if rest[-1] == 'judge-worker':
            active.touch()
    elif operation == 'ps':
        print('workerid' if rest[-1] == 'judge-worker' else 'sandboxid')
elif cmd == 'stop':
    record('stop worker')
    active.unlink()
elif cmd not in ('exec', 'update'):
    sys.exit(2)
""")
                probe = path / "probe"
                probe.write_text("""#!/bin/sh
if [ "$1" = worker-settings ]; then
  cat >/dev/null
  echo '192.0.2.10:9092 192.0.2.10:9094 judge-worker-v1 judge.submission.jobs'
else
  echo 'private probe' >> "$FIXTURE_DIR/trace"
  test "$SCENARIO" != probe-fails
fi
""")
                for executable in (docker, probe):
                    executable.chmod(0o700)
                result = subprocess.run([
                    "bash", str(ROOT / "scripts/deploy-judge-node.sh"), "--activate", NEW, OLD, str(probe),
                    "192.0.2.10:9092 192.0.2.10:9094 judge-worker-v1 judge.submission.jobs", "42", "1000", "524288",
                ], env=dict(os.environ, PATH=str(path) + os.pathsep + os.environ["PATH"], FIXTURE_DIR=directory,
                            SCENARIO=scenario, ASTRACODE_PROTECTED_ROLLOUT="1",
                            ASTRACODE_JUDGE_COMPOSE=str(path / "compose.yml"),
                            ASTRACODE_JUDGE_CONFIG=str(path / "config.yaml"),
                            ASTRACODE_JUDGE_STATE_DIR=str(path / "state")), capture_output=True, text=True)
                expected = ["start go-judge", "private probe"]
                if scenario != "probe-fails":
                    expected.append("start judge-worker")
                if scenario == "health-fails":
                    expected.append("stop worker")
                self.assertEqual((path / "trace").read_text().splitlines(), expected, result.stderr)
                self.assertEqual(result.returncode == 0, scenario == "ready", result.stderr)
                self.assertEqual((path / "active").exists(), scenario == "ready")

class JudgeRuntimePreflightTests(unittest.TestCase):
    def test_runtime_identity_must_match_plan(self):
        for scenario, succeeds in (
            ("matched", True), ("restored", True),
            ("atomic-replacement", False), ("edited-in-place", False),
            ("different-topic", False), ("different-broker", False),
            ("missing", False), ("stale-process", False),
        ):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                path = Path(directory)
                compose = path / "compose.yml"
                config = path / "config.yaml"
                compose.touch()
                config.touch()
                docker = path / "docker"
                docker.write_text("""#!/usr/bin/env python3
import json, os, sys
cmd, *args = sys.argv[1:]
scenario = os.environ["SCENARIO"]
if cmd == "ps":
    print("workerid")
elif cmd == "inspect":
    value = {
        "{{.Config.Image}}": "registry/astra/judge-worker:v1.0.0",
        "{{.Id}}": "workerid",
        "{{.State.Running}}": "true",
        "{{.State.StartedAt}}": "2026-01-01T00:00:00Z",
        "{{json .}}": "{}",
    }
    print(value[args[1]])
elif cmd == "compose":
    print("{}")
elif cmd == "exec":
    if scenario == "missing":
        sys.exit(1)
    print(scenario)
else:
    raise AssertionError("unexpected deployment command: " + cmd)
""")
                probe = path / "probe"
                probe.write_text("""#!/usr/bin/env python3
import sys
source = sys.stdin.read().strip()
settings = ["192.0.2.10:9092", "192.0.2.10:9094", "group-A", "judge.jobs"]
if sys.argv[3] == "running":
    if source in ("atomic-replacement", "edited-in-place"):
        settings[2] = "group-B"
    if source == "different-topic":
        settings[3] = "other.jobs"
    if source == "different-broker":
        settings[1] = "192.0.2.11:9094"
    if source == "stale-process":
        sys.exit(1)
print(*settings)
""")
                for executable in (docker, probe):
                    executable.chmod(0o700)
                result = subprocess.run([
                    "bash", str(ROOT / "scripts/deploy-judge-node.sh"), "--preflight", NEW, str(probe)
                ], env=dict(os.environ, PATH=str(path) + os.pathsep + os.environ["PATH"], SCENARIO=scenario,
                            ASTRACODE_PROTECTED_ROLLOUT="1", ASTRACODE_JUDGE_COMPOSE=str(compose),
                            ASTRACODE_JUDGE_CONFIG=str(config), ASTRACODE_JUDGE_STATE_DIR=str(path / "state")),
                   capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, succeeds, result.stdout + result.stderr)
                if succeeds:
                    self.assertIn("group-A", result.stdout)
                else:
                    self.assertIn("Worker", result.stderr)



if __name__ == "__main__":
    unittest.main()
