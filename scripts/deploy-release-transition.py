#!/usr/bin/env python3
"""Coordinate a protected release on the existing App and Judge nodes."""
import ipaddress
import re
import shlex
import subprocess
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
PROTECTED = "ASTRACODE_PROTECTED_ROLLOUT=1"


def release_tag(value):
    if not re.fullmatch(r"v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?", value):
        raise RuntimeError("Expected an immutable semantic release tag")
    return value


class Nodes:
    def __init__(self, app_dir, judge_dir, fixture, legacy_from="", legacy_peer=""):
        for directory in (app_dir, judge_dir):
            if not re.fullmatch(r"/opt/astracode/\.deploy/rollout\.[a-zA-Z0-9]{8}", directory):
                raise RuntimeError("Invalid private upload directory")
        if len(fixture) != 3 or not all(
            re.fullmatch(r"[1-9][0-9]{0,18}", value) and int(value) <= 2**63 - 1
            for value in fixture
        ):
            raise RuntimeError("Configure the probe problem ID and exact expected milliseconds and KiB")
        self.fixture = fixture
        self.app_bundle = f"{app_dir}/astracode-app-deployment.tgz"
        self.judge_bundle = f"{judge_dir}/astracode-judge-deployment.tgz"
        self.app_probe = f"{app_dir}/astracode-judge-rollout-probe"
        self.judge_probe = f"{judge_dir}/astracode-judge-rollout-probe"
        self.settings = ()
        self.worker_id = ""
        self.legacy_from = release_tag(legacy_from) if legacy_from else ""
        if bool(self.legacy_from) != bool(legacy_peer):
            raise RuntimeError("Legacy bootstrap requires both the installed release tag and the Judge broker peer")
        self.legacy_peer = str(ipaddress.IPv4Address(legacy_peer)) if legacy_peer else ""
        self.legacy_member = ""

    def remote(self, host, argv, *, source=None, capture=False):
        return subprocess.run(
            ["ssh", host, shlex.join(argv)], input=source, text=True,
            stdout=subprocess.PIPE if capture else None, check=True,
        ).stdout

    def app(self, *args):
        command = (
            f"tar -xOf {shlex.quote(self.app_bundle)} scripts/deploy-app-bundle.py | "
            + shlex.join(["env", PROTECTED, "python3", "-", *args])
        )
        return self.remote("astracode-app", ["bash", "-o", "pipefail", "-c", command],
                           capture=args[0] == "--current-tag")

    def judge(self, *args, capture=False):
        return self.remote("astracode-judge", [
            "env", PROTECTED, "/opt/astracode/scripts/deploy-judge-node.sh", *args,
        ], capture=capture)

    def app_gate(self, mode, *args, capture=False):
        source = (SCRIPT_DIR / "verify-judge-rollout-app.sh").read_text()
        return self.remote("astracode-app", ["bash", "-s", "--", mode, *self.settings, *args],
                           source=source, capture=capture)

    def preflight(self, target):
        if target == self.legacy_from:
            raise RuntimeError("Legacy bootstrap requires a different, protected target release")
        self.remote("astracode-app", ["chmod", "0700", self.app_probe])
        self.remote("astracode-judge", ["chmod", "0700", self.judge_probe])
        self.remote("astracode-judge", ["mkdir", "-p", "/opt/astracode/scripts"])
        self.remote("astracode-judge", [
            "tar", "-xzf", self.judge_bundle, "-C", "/opt/astracode", "scripts/deploy-judge-node.sh",
        ])
        judge_args = ["--preflight", target, self.judge_probe]
        if self.legacy_from:
            judge_args = ["--legacy-preflight", target, self.judge_probe, self.legacy_from]
        judge_tag, settings, self.worker_id = self.judge(*judge_args, capture=True).strip().splitlines()
        self.settings = tuple(settings.split())
        if len(self.settings) != 4 or not re.fullmatch(r"[0-9a-f]{64}", self.worker_id):
            raise RuntimeError("Judge preflight did not identify the Worker container, Problem endpoint and Kafka group")
        previous = release_tag(self.app("--current-tag", self.app_bundle).strip())
        if previous != release_tag(judge_tag):
            raise RuntimeError("App and Judge started on different tags. Recover the existing pair before deploying.")
        if self.legacy_from:
            if previous != self.legacy_from:
                raise RuntimeError("Running App and Judge tags do not match the approved legacy source")
            self.legacy_member = self.app_gate(
                "legacy-preflight", previous, self.app_probe, self.legacy_peer, *self.fixture, capture=True,
            ).strip()
            if not re.fullmatch(r"[a-zA-Z0-9._-]+", self.legacy_member):
                raise RuntimeError("App probe did not identify the legacy Kafka member")
            print(f"Verified legacy Worker {self.worker_id} and Kafka member {self.legacy_member}. "
                  f"Problem, broker, group and topic: {' '.join(self.settings)}", flush=True)
        else:
            self.app_gate("preflight")
        return previous

    def app_tag(self):
        return release_tag(self.app("--current-tag").strip())

    def suspend(self, tag):
        self.judge("--suspend", tag)

    def suspend_verified(self, tag):
        args = (tag, self.judge_probe, self.worker_id, " ".join(self.settings))
        if self.legacy_from:
            self.judge("--legacy-suspend", *args, self.legacy_peer, self.legacy_member)
        else:
            self.judge("--suspend", *args)

    def idle(self):
        self.app_gate("idle")

    def deploy_app(self, tag):
        self.app(tag, self.app_bundle)

    def rollback_app(self, current, previous):
        self.app("--rollback", current, previous)

    def verify(self, tag):
        if self.app_tag() != tag:
            raise RuntimeError(f"App runtime does not match expected release {tag}")
        self.app_gate("ready", tag, self.app_probe, *self.fixture)

    def verify_legacy(self, tag):
        if self.app_tag() != tag:
            raise RuntimeError("Restored App runtime does not match the legacy release")
        self.app_gate("legacy-ready", tag, self.app_probe, *self.fixture)

    def start_judge(self, tag, previous):
        self.judge("--activate", tag, previous, self.judge_probe, " ".join(self.settings), *self.fixture)


def deploy(nodes, target):
    previous = nodes.preflight(target)
    print(f"Starting pair {previous}. Requested release {target}.", flush=True)
    print("Suspending judging, including interactive Run Code", flush=True)
    try:
        nodes.suspend_verified(previous)
    except Exception as failure:
        print(f"Could not verify Judge suspension: {failure}. Operator action required. "
              "Verify the Worker and its Kafka group before retrying.", file=sys.stderr, flush=True)
        return False
    stage = "verify the Kafka consumer group is empty"
    app_activated = False
    app_uncertain = False
    recovery_start_attempted = False
    try:
        nodes.idle()
        stage = "activate App bundle"
        try:
            nodes.deploy_app(target)
        except subprocess.CalledProcessError as error:
            # An SSH failure can leave the remote transaction still running.
            app_uncertain = error.returncode == 255
            raise
        app_activated = True
        stage = "verify the App limit contract"
        nodes.verify(target)
        stage = "activate Judge and verify its health"
        nodes.start_judge(target, previous)
    except Exception as failure:
        print(f"Release {target} failed during {stage}: {failure}", file=sys.stderr, flush=True)
        try:
            nodes.suspend(target)
            nodes.idle()
            if app_uncertain:
                raise RuntimeError("App activation outcome is unknown after an SSH failure")
            if app_activated:
                nodes.rollback_app(target, previous)
            if nodes.legacy_from:
                nodes.verify_legacy(previous)
                print(f"Restored and verified legacy App {previous}. Operator action required: judging remains suspended. "
                      "Recover to a verified limits-aware pair before resuming.", file=sys.stderr, flush=True)
                return False
            nodes.verify(previous)
            recovery_start_attempted = True
            nodes.start_judge(previous, previous)
        except Exception as recovery_error:
            print(f"Automatic recovery could not verify the previous pair: {recovery_error}", file=sys.stderr)
            if recovery_start_attempted:
                try:
                    nodes.suspend(previous)
                except Exception as suspend_error:
                    print(f"Could not confirm Worker suspension: {suspend_error}", file=sys.stderr)
            print("Operator action required. Verify Worker is stopped with restart disabled, check the Kafka group is empty, "
                  "and restore and verify the App contract before resuming Judge. Check both hosts before retrying.",
                  file=sys.stderr)
        else:
            print(f"Restored and verified the previous App/Judge pair {previous}. The requested deployment failed.",
                  file=sys.stderr)
        return False
    print(f"Deployment {target} verified. Judging has resumed.", flush=True)
    return True


if __name__ == "__main__":
    try:
        target, app_dir, judge_dir, problem, time_ms, memory_kib, *legacy = sys.argv[1:]
        sys.exit(0 if deploy(Nodes(app_dir, judge_dir, [problem, time_ms, memory_kib], *legacy),
                             release_tag(target)) else 1)
    except Exception as error:
        print(f"Release preflight failed: {error}", file=sys.stderr)
        sys.exit(1)
