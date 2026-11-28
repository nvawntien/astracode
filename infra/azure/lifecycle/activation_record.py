"""Durable App-local workload authorization. This module has no Azure power authority."""

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import threading
import uuid

from activation_client import timestamp
from node_state import RecoveryRequired

APP = {"auth-service", "problem-service", "submission-service", "website", "envoy"}
JUDGE = {"judge-worker", "go-judge"}


def transition(state, action, data, now, bundle):
    """Apply an operation previously admitted by the trusted host."""
    op = state.get("operation")
    if action == "poll":
        state["app_seen"] = now.isoformat()
        if (
            op
            and op["phase"] == "approved"
            and now < timestamp(op["request"]["deadline"])
        ):
            return {"ticket": op["request"]["id"]}
        return {"ticket": None}
    if not op or (data.get("operation") or data.get("ticket")) != op["request"]["id"]:
        raise RecoveryRequired("unknown App operation")
    req = op["request"]
    if action == "app-heartbeat":
        if req["session"] != state["generation"] or op["phase"] not in {
            "approved",
            "running",
            "verified",
        }:
            raise RecoveryRequired("stale App operation")
        state["app_seen"] = now.isoformat()
        return {}
    if action == "recovery-required":
        state["tester_open"] = False
        if op["phase"] != "forward-required":
            op["phase"] = "recovery-required"
        return {}
    if action == "close":
        state["tester_open"] = False
        return {}
    if (
        req["session"] != state["generation"]
        or state["phase"] not in {"starting", "ready"}
        or now >= timestamp(state["expires"])
        or state["epochs"] != {r: req[r + "_epoch"] for r in ("app", "judge")}
    ):
        raise RecoveryRequired("session, deadline or node epoch changed")
    heartbeat = timestamp(state["heartbeat"])
    poll = timestamp(state["app_seen"])
    if not (
        timedelta(0) <= now - heartbeat < timedelta(minutes=3)
        and timedelta(0) <= now - poll < timedelta(seconds=15)
    ):
        raise RecoveryRequired("lost App observation")
    if op["phase"] != "verified" and (
        now >= timestamp(req["deadline"]) or state["contest"]
    ):
        raise RecoveryRequired("closed operation window")
    if action == "operation":
        return req
    if action == "contest":
        return {"frozen": state["contest"]}
    if action == "state":
        return op["before"]
    if action == "termination":
        return op["termination"]
    if action == "bundle":
        if data["digest"] != req["release"]:
            raise RecoveryRequired("wrong release")
        return bundle(req["release"], req["environment"])
    if action == "verified":
        accepted = state["verified_releases"].get(data["digest"], {})
        return {"verified": accepted.get("versions") == data["versions"]}
    if action == "begin":
        if op["phase"] != "approved" or data["release"] != req["release"]:
            raise RecoveryRequired("operation is already claimed or changed")
        op["phase"] = "running"
        state["in_flight"] = req["id"]
        state["tester_open"] = False
        return {}
    if op["phase"] not in {"approved", "running", "verified"}:
        raise RecoveryRequired("operation requires fresh reconciliation")
    if action == "authorization":
        until = min(
            timestamp(state["expires"]),
            poll + timedelta(seconds=15),
            now + timedelta(seconds=15),
        )
        allowed = set()
        if op["phase"] == "verified":
            allowed = APP | JUDGE
        elif op["phase"] == "running":
            until = min(until, timestamp(req["deadline"]))
            allowed = APP | JUDGE
            if req["action"] == "deploy":
                allowed = allowed | {"migrate"}
        return {
            "environment": req["environment"],
            "session": req["session"],
            "operation": req["id"],
            "app_epoch": req["app_epoch"],
            "judge_epoch": req["judge_epoch"],
            "until": until.isoformat(),
            "allowed_workloads": sorted(allowed),
            "migration_uid": op.get("migration_uid"),
        }
    if action == "open" and op["phase"] == "verified":
        state["tester_open"] = True
        return {}
    if op["phase"] != "running" or state["in_flight"] != req["id"]:
        raise RecoveryRequired("active exclusive operation required")
    if action == "migration":
        return op["migration"]
    if action == "sealed-recovery":
        versions = data["versions"]
        if (
            req["action"] != "recover"
            or versions != op["migration"]["observed_versions"]
            or versions == op["expected"]["versions"]
        ):
            raise RecoveryRequired("no sealed partial recovery for this operation")
        op["phase"] = "forward-required"
        state["forward_required"] = dict(
            recovery=req["id"],
            release=req["release"],
            epochs=dict(state["epochs"]),
            versions=versions,
        )
        state.update(in_flight=None, tester_open=False)
        return {}
    if action == "bind-migration" and req["action"] == "deploy":
        uid = str(uuid.UUID(data["uid"]))
        if op.get("migration_uid", uid) != uid:
            raise RecoveryRequired("migration attempt already bound to a different Pod")
        job = str(uuid.UUID(data["job"])) if "job" in data else op.get("migration_job")
        if op.get("migration_job", job) != job:
            raise RecoveryRequired("migration Job instance changed")
        op["migration_job"] = job
        op["migration_uid"] = uid
        return {}
    if action == "retired-job":
        return {
            "confirmed": data["uid"]
            in state.get("nodes", {})
            .get("app", {})
            .get("retired_jobs", op["migration"].get("confirmed_retired_jobs", []))
        }
    if action == "complete":
        versions = data["versions"]
        evidence = data["observed"]
        expected = op["expected"]
        if versions != expected["versions"]:
            raise RecoveryRequired("all-owner versions differ")
        for role, names in (("app", APP), ("judge", JUDGE)):
            view = evidence[role]
            if (
                view["epoch"] != req[role + "_epoch"]
                or not view["boot"]
                or set(view["containers"]) != names
            ):
                raise RecoveryRequired("missing or stale attestation")
            for name, row in view["containers"].items():
                if (
                    not row["uid"]
                    or not row["container"]
                    or row["workload"] != name
                    or row["image"] != expected["images"][name]
                    or row["config"] != expected["workloads"][name]
                ):
                    raise RecoveryRequired("runtime evidence differs")
        if "backing" in evidence["app"] and evidence["app"]["backing"] != {
            name: expected["images"][name]
            for name in ("postgres", "redis", "kafka", "minio")
        }:
            raise RecoveryRequired("backing-store descriptors differ")
        state["verified_releases"][req["release"]] = dict(
            versions=versions,
            evidence=evidence,
            config=expected["config"],
            operation=req["id"],
            ready=now.isoformat(),
            smoke="passed",
        )
        state["last_verified"] = req["release"]
        state["last_app_boot"] = evidence["app"]["boot"]
        state["submission_uid"] = evidence["app"]["containers"]["submission-service"][
            "uid"
        ]
        state["in_flight"] = None
        state.pop("forward_required", None)
        state["clean_drain"] = False
        op["phase"] = "verified"
        return {}
    raise RecoveryRequired("invalid App operation transition")


class Journal:
    def __init__(
        self,
        directory,
        slot,
        settings,
        catalog,
        observe,
        clock=None,
        mount=os.path.ismount,
    ):
        self.directory = Path(directory)
        self.path = self.directory / "deployment.json"
        self.slot = slot
        self.settings = settings
        self.catalog = catalog
        self.observe = observe
        self.mount = mount
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.lock = threading.RLock()
        self.observations = None
        self.observed_at = None
        # An activation service restart invalidates every live grant, including
        # in the same kernel boot. The persistent record is retained to recover.
        self.generation = None

    def read(self):
        if not self.mount(self.directory.parent):
            raise RecoveryRequired("verified App data mount unavailable")
        try:
            return json.loads(self.path.read_text())
        except FileNotFoundError as exc:
            raise RecoveryRequired("activation journal absent") from exc

    def save(self, state):
        # Commit the effect record before returning a successful mutation.
        scratch = self.path.with_suffix(".tmp")
        with scratch.open("w") as handle:
            json.dump(state, handle, sort_keys=True, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        scratch.replace(self.path)
        fd = os.open(self.directory, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def initialize(self):
        with self.lock:
            if not self.mount(self.directory.parent):
                raise RecoveryRequired("verified App data mount unavailable")
            if self.path.exists():
                raise RecoveryRequired("existing activation journal")
            self.save(
                dict(
                    generation=None,
                    expires=None,
                    phase="closed",
                    operation=None,
                    tester_open=False,
                    in_flight=None,
                    clean_drain=False,
                    epochs={},
                    last_app_boot=None,
                    last_verified=None,
                    submission_uid=None,
                    verified_releases={},
                    runs={},
                )
            )
            return {}

    def open(self, approval, date):
        with self.lock:
            state = self.read()
            now = self.clock()
            if date != now.date().isoformat() or not re.fullmatch(
                r"[A-Za-z0-9._/-]{1,160}", approval
            ):
                raise RecoveryRequired("current dated owner approval required")

            def at(value):
                return timestamp(f"{date}T{value[:2]}:{value[2:]}:00Z")

            policy = self.settings["daily_window"]
            start, cutoff = at(policy["earliest_start"]), at(policy["shutdown"])
            # Testers and workload permits close before platform deallocation.
            stop = cutoff - timedelta(minutes=2)
            if not start <= now < stop or cutoff - start > timedelta(
                hours=11, minutes=30
            ):
                raise RecoveryRequired("outside the owner-approved daily window")
            if (
                state["phase"] in {"starting", "ready", "draining"}
                and self.generation == state["generation"]
            ):
                raise RecoveryRequired("close the existing operating window first")
            views = self.observe()
            op = state["operation"]
            if op and not state["clean_drain"] and not state["in_flight"]:
                state["in_flight"] = op["request"]["id"]
            generation = str(uuid.uuid4())
            state.update(
                phase="starting",
                generation=generation,
                expires=stop.isoformat(),
                tester_open=False,
                approval=approval,
                date=date,
                epochs={role: views[role]["epoch"] for role in ("app", "judge")},
                # Compare old/new kernel boots, never treat a service restart as a new boot.
                window_boots={role: views[role]["boot"] for role in ("app", "judge")},
            )
            self.save(state)
            self.generation = generation
            self.observations, self.observed_at = views, now
            return {"closes_at": stop.isoformat(), "shutdown_at": cutoff.isoformat()}

    def observe_current(self, **views):
        with self.lock:
            state = self.read()
            now = self.clock()
            self.observations, self.observed_at = views, now
            if self.generation and self.generation == state["generation"]:
                invalid = any(
                    views[r]["epoch"] != state["epochs"][r] for r in ("app", "judge")
                )
                if state["phase"] in {"starting", "ready"} and (
                    invalid or now >= timestamp(state["expires"])
                ):
                    state.update(phase="draining", tester_open=False)
                    self.save(state)
            return {
                key: state[key]
                for key in ("phase", "generation", "submission_uid", "in_flight")
            }

    def close(self):
        with self.lock:
            state = self.read()
            state.update(phase="draining", tester_open=False)
            self.save(state)
            return {}

    def _live(self, state, now):
        return (
            self.generation is not None
            and self.generation == state["generation"]
            and state["phase"] in {"starting", "ready"}
            and now < timestamp(state["expires"])
            and self.observed_at is not None
            and timedelta(0) <= now - self.observed_at < timedelta(seconds=15)
            and all(
                self.observations[r]["epoch"] == state["epochs"][r]
                for r in ("app", "judge")
            )
        )

    def frozen(self, now):
        return any(
            timestamp(row["start"]) <= now + timedelta(minutes=10)
            and now < timestamp(row["end"])
            for row in self.settings["contest_windows"]
        )

    def submit(
        self, action, source, digest, fallback_source, fallback, run, attempt, recovery
    ):
        with self.lock:
            state = self.read()
            now = self.clock()
            if (
                not re.fullmatch("[1-9][0-9]{0,19}", run)
                or attempt != "1"
                or run in state["runs"]
                or action not in {"deploy", "rollback", "restart", "recover"}
                or not self._live(state, now)
                or self.frozen(now)
                or now + timedelta(minutes=11) >= timestamp(state["expires"])
            ):
                raise RecoveryRequired("run or window is unavailable for deployment")
            old = state["operation"]
            if (
                old
                and old["request"]["session"] == self.generation
                and old["phase"] in {"approved", "running"}
            ):
                raise RecoveryRequired("a deployment already owns this environment")
            previous = state["in_flight"]
            if bool(previous) != (action == "recover"):
                raise RecoveryRequired(
                    "interrupted work requires a separate explicit recovery"
                )
            if action == "recover" and (
                not isinstance(recovery, dict) or recovery.get("operation") != previous
            ):
                raise RecoveryRequired(
                    "approval does not identify the interrupted operation"
                )
            digest_map = {digest: source}
            if fallback in digest_map and source != fallback_source:
                raise RecoveryRequired("one source per immutable bundle")
            digest_map[fallback] = fallback_source
            candidate = self.catalog.load(digest, source)
            rollback = self.catalog.load(fallback, fallback_source)
            if rollback["versions"] != candidate["versions"] or (
                self.slot == "s3"
                and rollback["migration_package"] != candidate["migration_package"]
            ):
                raise RecoveryRequired("approved fallback cannot use the target schema")
            if (
                action == "deploy"
                and state["last_verified"]
                and (
                    fallback not in state["verified_releases"]
                    and fallback
                    not in self.settings.get("reviewed_forward_rollback", [])
                )
            ):
                raise RecoveryRequired("fallback has no separately reviewed history")
            views = self.observe()
            now = self.clock()
            self.observe_current(**views)
            state = self.read()
            if (
                not self._live(state, now)
                or self.frozen(now)
                or now + timedelta(minutes=11) >= timestamp(state["expires"])
            ):
                raise RecoveryRequired(
                    "deployment window changed during receipt verification"
                )
            boot = self.observations["app"]["boot"]
            prior_boot = state["last_app_boot"] or (old or {}).get("boot")
            new_boot = bool(prior_boot and prior_boot != boot)
            policy = dict(self.settings["migration"])
            retired = set(self.observations["app"]["retired_jobs"])
            if action == "recover":
                versions = recovery["versions"]
                if (
                    not old.get("boot")
                    or old["boot"] == boot
                    or not new_boot
                    or old["request"]["release"] != digest
                    or (
                        set(versions) != {"auth", "problem", "submission"}
                        or any(
                            type(version) is not int or version < 0
                            for version in versions.values()
                        )
                    )
                ):
                    raise RecoveryRequired(
                        "recover requires a verified new App boot, exact release and observed histories"
                    )
                old_job = old.get("migration_job")
                if old_job:
                    retired.add(old_job)
                policy.update(
                    reconcile_attempt=previous,
                    observed_versions=versions,
                    prior_job_exit_verified=True,
                )
            policy.update(
                release=digest,
                rollback_versions=rollback["versions"],
                confirmed_retired_jobs=sorted(retired),
            )
            forward = state.get("forward_required")
            if forward and (
                action != "deploy"
                or forward["release"] != digest
                or forward["epochs"] != state["epochs"]
            ):
                raise RecoveryRequired(
                    "sealed recovery requires a separate forward deployment on the verified epochs"
                )
            ticket = str(uuid.uuid4())
            config = candidate["environments"][self.slot]
            state["operation"] = dict(
                phase="approved",
                sources=digest_map,
                boot=boot,
                request=dict(
                    id=ticket,
                    action=action,
                    release=digest,
                    environment=self.slot,
                    session=self.generation,
                    app_epoch=state["epochs"]["app"],
                    judge_epoch=state["epochs"]["judge"],
                    deadline=(now + timedelta(minutes=10)).isoformat(),
                ),
                expected=dict(
                    images=candidate["images"],
                    versions=candidate["versions"],
                    workloads=config["workloads"],
                    config=config["digest"],
                ),
                before={
                    key: state[key]
                    for key in (
                        "in_flight",
                        "last_verified",
                        "submission_uid",
                        "clean_drain",
                    )
                },
                termination=dict(
                    epoch=state["epochs"]["app"],
                    session=self.generation,
                    uid=state["submission_uid"],
                    fresh=not old and not state["submission_uid"],
                    clean=state["clean_drain"],
                    previous_boot=prior_boot,
                    boot=boot,
                    same_app_vm=new_boot,
                    work_reconciled=action == "recover",
                    sealed_recovery=(forward or {}).get("recovery"),
                ),
                migration=policy,
                run=run,
            )
            state["tester_open"] = False
            state["runs"][run] = ticket
            self.save(state)
            return {"ticket": ticket}

    def status(self, ticket):
        with self.lock:
            state = self.read()
            op = state["operation"]
            if not op or op["request"]["id"] != ticket:
                raise RecoveryRequired("unknown deployment")
            phase = op["phase"]
            if (
                phase == "verified"
                and "handoff_until" in op
                and self._live(state, self.clock())
            ):
                verified = state["verified_releases"][op["request"]["release"]]
                return dict(
                    environment=self.slot,
                    bundle=op["request"]["release"],
                    source=op["sources"][op["request"]["release"]],
                    images=op["expected"]["images"],
                    versions=verified["versions"],
                    configuration=verified["config"],
                    smoke=verified["smoke"],
                    operation=ticket,
                    run=op["run"],
                )
            if phase in {"recovery-required", "forward-required"} or not self._live(
                state, self.clock()
            ):
                raise RecoveryRequired("delivery needs operator recovery")
            return {}

    def admit_testers(self, run, ticket, release):
        with self.lock:
            state = self.read()
            now = self.clock()
            op = state["operation"]
            if (
                not self._live(state, now)
                or op is None
                or op["phase"] != "verified"
                or op["request"]["session"] != self.generation
                or op["request"]["id"] != ticket
                or op["request"]["release"] != release
                or op["run"] != run
                or state["phase"] != "ready"
                or state["tester_open"]
                or now >= timestamp(op["handoff_until"])
            ):
                raise RecoveryRequired(
                    "deployment handoff is missing, expired or replayed"
                )
            state["tester_open"] = True
            self.save(state)
            return {"admitted": True}

    def act(self, action, **data):
        with self.lock:
            state = self.read()
            now = self.clock()
            live = self._live(state, now)
            if action == "tester":
                operation = state["operation"] or {}
                phase = operation.get("phase")
                current = (
                    live
                    and operation.get("request", {}).get("session") == self.generation
                )
                until = (
                    min(
                        now + timedelta(seconds=2),
                        timestamp(state["expires"]),
                        self.observed_at + timedelta(seconds=15),
                    )
                    if current
                    else None
                )
                return dict(
                    tester=current and phase == "verified" and state["tester_open"],
                    smoke=current and phase in {"running", "verified"},
                    until=until.isoformat() if until else None,
                )
            if action == "drained":
                if (
                    state["phase"] != "draining"
                    or state["generation"] != data["generation"]
                    or data["ceased"] is not True
                    or data["epoch"] != state["epochs"]["app"]
                    or state["in_flight"]
                    or data["uid"] != state["submission_uid"]
                ):
                    raise RecoveryRequired("drain cannot attest to safe termination")
                state.update(
                    phase="closed", clean_drain=True, retained=data["retained"]
                )
                self.save(state)
                return {}
            if not live and action not in {"close", "recovery-required"}:
                if action == "poll":
                    return {"ticket": None}
                raise RecoveryRequired("boot or window authorization lost")
            state.update(
                heartbeat=(self.observed_at or now).isoformat(),
                app_seen=(self.observed_at or now).isoformat(),
                nodes=self.observations or {},
                contest=self.frozen(now),
            )
            op = state["operation"]

            def bundle(digest, _slot):
                return self.catalog.record(digest, op["sources"][digest])

            result = transition(state, action, data, now, bundle)
            for field in ("heartbeat", "app_seen", "nodes", "contest"):
                state.pop(field, None)
            if action == "complete" and "backing" not in data["observed"]["app"]:
                raise RecoveryRequired("backing-store runtime evidence required")
            if action == "open":
                state.update(phase="ready", tester_open=False)
                op["handoff_until"] = min(
                    now + timedelta(minutes=2), timestamp(state["expires"])
                ).isoformat()
            if (
                action == "authorization"
                and op["phase"] == "verified"
                and not state["tester_open"]
            ):
                result["until"] = min(
                    timestamp(result["until"]),
                    timestamp(op.get("handoff_until", op["request"]["deadline"])),
                ).isoformat()
                if now >= timestamp(result["until"]):
                    raise RecoveryRequired("verified rollout handoff expired")
            if action in {
                "begin",
                "bind-migration",
                "close",
                "complete",
                "open",
                "recovery-required",
                "sealed-recovery",
            }:
                self.save(state)
            return result
