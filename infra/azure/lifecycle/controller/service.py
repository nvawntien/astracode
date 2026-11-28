"""Authenticate typed requests and persist their effects with optimistic concurrency."""

from datetime import datetime, timedelta, timezone
import re
import uuid

from activation_record import transition
from policy import DIGEST, canonical, digest, eligible, mapped_release, verify_record
from state import (
    Refused,
    admit,
    claim,
    drain,
    fresh,
    initial,
    powered,
    power_result,
    ready,
    rehearsal_sources,
    resume_rehearsal,
    stamp,
    tick,
)


class Conflict(RuntimeError):
    pass


ACTIONS = {"start", "extend", "cancel", "deploy", "rollback", "restart", "recover"}
DEPLOY = {"deploy", "rollback", "restart", "recover"}
RESUME = "resume-rehearsal"
OWNERS = {"auth", "problem", "submission"}


def identifier(value):
    if str(uuid.UUID(value)) != value:
        raise Refused("canonical UUID required")
    return value


def validate(payload, slot):
    action = payload["operation"]
    if (
        type(payload["schemaVersion"]) is not int
        or payload["schemaVersion"] != 1
        or payload["environment"] != slot
        or (
            action not in ACTIONS | {"promotion-eligibility"}
            and (slot != "s3" or action != RESUME)
        )
    ):
        raise Refused("invalid operation contract")
    fields = {"schemaVersion", "environment", "operation", "requestId", "requester"}
    identifier(payload["requestId"])
    if not re.fullmatch("[0-9]+", payload["requester"]):
        raise Refused("invalid requester")
    if action in (ACTIONS - {"start"}) | {RESUME}:
        fields.add("sessionGeneration")
        identifier(payload["sessionGeneration"])
    if action == RESUME or (action == "start" and "recoveryAttempt" in payload):
        fields.add("recoveryAttempt")
        identifier(payload["recoveryAttempt"])
    if action == "start" and "terraformPlan" in payload:
        fields.add("terraformPlan")
        plan = payload["terraformPlan"]
        if (
            slot != "s2"
            or set(plan) != {"sha256", "operation", "role", "expiresAt"}
            or not re.fullmatch(r"[a-f0-9]{64}", plan["sha256"])
            or (plan["operation"], plan["role"])
            not in {("create", None), ("replace", "app"), ("replace", "judge")}
        ):
            raise Refused("invalid Terraform compute plan")
        stamp(plan["expiresAt"])
    if action == "extend":
        fields.add("requestedExpiry")
        stamp(payload["requestedExpiry"])
    if action in DEPLOY | {"promotion-eligibility"}:
        fields.add("releaseDigest")
        if not DIGEST.fullmatch(payload["releaseDigest"]):
            raise Refused("invalid bundle digest")
    if action in DEPLOY:
        fields.add("migration")
        migration = payload["migration"]
        if not re.fullmatch("[0-9]+", migration["system_id"]) or not re.fullmatch(
            r"[A-Za-z0-9._/-]{1,160}", migration["recovery_point"]
        ):
            raise Refused("invalid database or recovery-point binding")
        expected = {"system_id", "recovery_point", "rollbackDigest"}
        if action == "recover":
            expected |= {
                "reconcile_attempt",
                "observed_versions",
                "confirmed_retired_jobs",
                "work_reconciled",
            }
            identifier(migration["reconcile_attempt"])
            if (
                set(migration["observed_versions"]) != OWNERS
                or any(
                    type(v) is not int or v < 0
                    for v in migration["observed_versions"].values()
                )
                or len(migration["confirmed_retired_jobs"]) > 8
                or migration["work_reconciled"] is not True
            ):
                raise Refused("invalid recovery evidence")
            for uid in migration["confirmed_retired_jobs"]:
                identifier(uid)
        if set(migration) != expected or not DIGEST.fullmatch(
            migration["rollbackDigest"]
        ):
            raise Refused("invalid migration policy")
    if action == "promotion-eligibility":
        fields |= {"tag", "mappingRevision"}
    if set(payload) != fields or len(canonical(payload)) > 8192:
        raise Refused("unexpected operation fields")


class Service:
    def __init__(
        self,
        policy,
        store,
        auth,
        catalog,
        power,
        clock=lambda: datetime.now(timezone.utc),
    ):
        self.policy, self.store, self.auth = policy, store, auth
        self.catalog, self.power, self.clock = catalog, power, clock
        self.slot = policy["environment"]

    def change(self, mutate):
        for _ in range(8):
            state, revision = self.store.read()
            now = self.clock()
            state = state if state is not None else initial(self.policy, now)
            if (
                state["targets"] != self.policy["targets"]
                or state["environment"] != self.slot
            ):
                raise Refused("durable environment binding changed")
            prior = canonical(state) if revision is not None else None
            result = mutate(state, now)
            if canonical(state) == prior or self.store.write(state, revision):
                return result
        raise Conflict("controller state changed concurrently")

    def load_release(self, selected):
        record = self.catalog(selected)
        payload = verify_record(record)
        expected = "canonical" if self.slot == "s2" else "rehearsal"
        if record["bundle"] != selected or payload["kind"] != expected:
            raise Refused("release ineligible for environment")
        return record, dict(payload, digest=selected)

    def draft(self, caller, payload):
        validate(payload, self.slot)
        if (
            caller["role"] != "member"
            or self.policy["members"][caller["object_id"]] != payload["requester"]
            or payload["operation"] not in ACTIONS
        ):
            raise Refused("member request authority required")

        def create(state, now):
            existing = state["requests"].get(payload["requestId"])
            record = dict(payload=payload, created=now.isoformat())
            if existing and existing["payload"] != payload:
                raise Refused("request is immutable")
            if not existing:
                state["requests"][payload["requestId"]] = record
            return dict(
                requestId=payload["requestId"], digest=digest(canonical(payload))
            )

        return self.change(create)

    def approved(self, caller, proof, payload):
        validate(payload, self.slot)
        if self.slot == "s3":
            if (
                caller["role"] != "rehearsal-operator"
                or payload["operation"] not in DEPLOY | {RESUME}
                or payload["requester"] != self.policy["rehearsal_owner"]
            ):
                raise Refused(
                    "S3 rehearsals require the protected infrastructure operator"
                )
            identity = dict(
                caller,
                run=payload["requestId"],
                attempt="1",
                reviewer=caller["object_id"],
                requester=payload["requester"],
            )
        else:
            identity = self.auth.approval(proof, payload, caller)
        action = payload["operation"]
        power_snapshot = (
            self.power.observe()
            if action == RESUME or "terraformPlan" in payload
            else None
        )
        record, release = (
            self.load_release(payload["releaseDigest"])
            if action in DEPLOY | {"promotion-eligibility"}
            else (None, None)
        )
        rollback_record, rollback = (
            self.load_release(payload["migration"]["rollbackDigest"])
            if action in DEPLOY
            else (None, None)
        )
        ticket_key = identity["run"] + ":" + identity["attempt"]
        binding = digest(canonical(dict(payload=payload, identity=identity)))

        def consume(state, now):
            previous = state["tickets"].get(ticket_key)
            if previous:
                if action == RESUME:
                    raise Refused("S3 recovery authorization already consumed")
                if previous["binding"] != binding:
                    raise Refused("approval ticket is already bound")
                return previous["result"]
            if any(
                t["request"] == payload["requestId"] for t in state["tickets"].values()
            ):
                raise Refused("request already consumed by a prior run")
            if power_snapshot is not None and power_snapshot != {
                role: observation["state"]
                for role, observation in state["power"].items()
            }:
                raise Refused("current VM power differs from the durable observation")
            if action == RESUME:
                result = stored = resume_rehearsal(state, payload, identity, now)
            elif action == "promotion-eligibility":
                mapping = self.policy["promotion_mappings"].get(
                    payload["mappingRevision"], {}
                )
                if (
                    payload["mappingRevision"] != identity["workflow"]
                    or mapped_release(
                        payload["tag"], mapping, payload["mappingRevision"]
                    )
                    != record["bundle"]
                ):
                    raise Refused("promotion mapping changed")
                staged = (
                    state["verified_releases"]
                    .get(record["bundle"], {})
                    .get("acceptance", {})
                )
                approval = dict(
                    approved=True,
                    reviewer=identity["reviewer"],
                    bundle=record["bundle"],
                )
                eligible(record, staged, approval, state["contest"])
                result = dict(
                    receipt=record,
                    staged=staged,
                    approval=approval,
                    contest_frozen=state["contest"],
                )
                # Store only a digest-bound outcome reference. The receipt is immutable.
                stored = dict(
                    bundle=record["bundle"],
                    staged=staged,
                    approval=approval,
                    contest_frozen=False,
                )
            else:
                if self.slot == "s2":
                    draft = state["requests"].get(payload["requestId"])
                    if (
                        not draft
                        or draft["payload"] != payload
                        or not fresh(draft["created"], now, 86400)
                    ):
                        raise Refused(
                            "protected originating request missing or changed"
                        )
                else:
                    experiment = state["experiment"]
                    sources = rehearsal_sources(experiment)
                    if stamp(experiment["deadline"]) <= now or any(
                        sources.get(row["bundle"]) != row["source"]
                        for row in (record, rollback_record)
                    ):
                        raise Refused("release or experiment deadline differs")
                internal = dict(payload)
                if action in DEPLOY:
                    internal.update(
                        self.activation_inputs(state, payload, release, rollback)
                    )
                result = stored = admit(
                    state,
                    internal,
                    (
                        dict(identity, role="deployment")
                        if self.slot == "s3"
                        else identity
                    ),
                    self.policy,
                    now,
                    release,
                )
            state["tickets"][ticket_key] = dict(
                binding=binding, request=payload["requestId"], result=stored
            )
            return result

        result = self.change(consume)
        if action == "promotion-eligibility" and "receipt" not in result:
            result = dict(result, receipt=record)
        return result

    def activation_inputs(self, state, payload, release, rollback):
        policy = dict(payload["migration"])
        action = payload["operation"]
        if rollback["versions"] != release["versions"] or (
            self.slot == "s3"
            and rollback["migration_package"] != release["migration_package"]
        ):
            raise Refused("rollback schema is incompatible")
        if (
            action == "deploy"
            and state["last_verified"]
            and rollback["digest"] not in state["verified_releases"]
        ):
            if rollback["digest"] not in self.policy.get(
                "reviewed_forward_rollback", []
            ):
                raise Refused("rollback artifact was not separately reviewed")
        view = state.get("nodes", {}).get("app")
        if not view:
            raise Refused("fresh local observation required")
        previous = state.get("last_app_boot")
        if self.slot == "s3" and action == "recover":
            recovery = state.get("rehearsal_recovery")
            if recovery and recovery["attempt"] == policy["reconcile_attempt"]:
                previous = recovery["prior_boots"]["app"]
        same = previous and previous != view["boot"]
        termination = dict(
            epoch=view["epoch"],
            session=state["generation"],
            fresh=not state["submission_uid"] and not state["in_flight"],
            clean=state["clean_drain"],
            uid=state["submission_uid"],
            same_app_vm=bool(same),
            previous_boot=previous,
            boot=view["boot"],
            work_reconciled=policy.get("work_reconciled", False),
            sealed_recovery=(
                (state.get("forward_required") or {}).get("recovery")
                if action == "deploy" and not state["in_flight"]
                else None
            ),
        )
        if action == "recover":
            if policy["reconcile_attempt"] != state["in_flight"]:
                raise Refused("recovery does not name the retained operation")
            retired = set(policy["confirmed_retired_jobs"])
            observed = set(view["retired_jobs"])
            previous_job = (state.get("operation") or {}).get("migration_job")
            # Both a fresh local exit or a verified new boot on the same VM
            # fence the old PID. A Kubernetes terminal Job alone is insufficient.
            if previous_job and (
                previous_job not in retired or not (same or previous_job in observed)
            ):
                raise Refused("old migration Job termination is unconfirmed")
            policy["prior_job_exit_verified"] = True
        else:
            policy["confirmed_retired_jobs"] = view["retired_jobs"]
        policy.update(release=release["digest"], rollback_versions=rollback["versions"])
        return dict(migration=policy, termination=termination)

    def app(self, caller, action, data):
        if caller["role"] != "app":
            raise Refused("App host identity required")

        def apply(state, now):
            if action == "observe":
                self.observe(state, data, now)
                return {
                    "phase": state["phase"],
                    "drain": state["drain"],
                    "generation": state["generation"],
                    "submission_uid": state["submission_uid"],
                }
            if action == "poll":
                op = state["operation"]
                if (
                    state["phase"] in {"starting", "ready"}
                    and fresh(state["app_seen"], now, 15)
                    and op
                    and op["phase"] == "approved"
                    and now < stamp(op["request"]["deadline"])
                ):
                    return {"ticket": op["request"]["id"]}
                return {"ticket": None}
            if action == "app-heartbeat":
                if not fresh(state["app_seen"], now, 15):
                    raise Refused("fresh node observation required")
                return {}
            if action == "tester":
                op = state["operation"]
                if not (
                    fresh(state["heartbeat"], now, 180)
                    and fresh(state["app_seen"], now, 15)
                    and state["expires"]
                    and now < stamp(state["expires"])
                    and powered(state)
                ):
                    return {"tester": False, "smoke": False}
                return dict(
                    tester=state["phase"] == "ready" and state["tester_open"],
                    smoke=state["phase"] in {"starting", "ready"}
                    and bool(op)
                    and op["phase"] in {"running", "verified"},
                    until=min(
                        now + timedelta(seconds=5), stamp(state["expires"])
                    ).isoformat(),
                )
            if action == "drained":
                self.drained(state, data, now)
                return {}
            if action == "open" and state["phase"] == "starting":
                result = transition(
                    state, action, data, now, lambda d, _: self.load_release(d)[0]
                )
                ready(state, self.policy, now)
                return result
            if action == "complete":
                result = transition(
                    state, action, data, now, lambda d, _: self.load_release(d)[0]
                )
                op = state["operation"]
                expected_backing = {
                    name: op["expected"]["images"][name]
                    for name in ("postgres", "redis", "kafka", "minio")
                }
                if data["observed"]["app"].get("backing") != expected_backing:
                    raise Refused(
                        "backing-store descriptors do not match the approved bundle"
                    )
                verified = state["verified_releases"][op["request"]["release"]]
                state["last_app_boot"] = data["observed"]["app"]["boot"]
                state["last_operation"] = op["request"]["id"]
                verified["acceptance"] = dict(
                    environment=self.slot,
                    bundle=op["request"]["release"],
                    images=op["expected"]["images"],
                    versions=data["versions"],
                    configuration=op["expected"]["config"],
                    smoke="passed",
                    operation=op["request"]["id"],
                )
                return result
            if action == "bind-migration":
                identifier(data["job"])
                op = state["operation"]
                if op.get("migration_job", data["job"]) != data["job"]:
                    raise Refused("migration Job replaced")
                result = transition(
                    state, action, data, now, lambda d, _: self.load_release(d)[0]
                )
                op["migration_job"] = data["job"]
                return result
            return transition(
                state, action, data, now, lambda d, _: self.load_release(d)[0]
            )

        return self.change(apply)

    def observe(self, state, data, now):
        if set(data) != {"app", "judge"} or state["phase"] not in {
            "starting",
            "ready",
            "draining",
            "stopping",
        }:
            raise Refused("invalid node report")
        for role, row in data.items():
            if (
                set(row) != {"epoch", "boot", "retired_jobs"}
                or len(row["retired_jobs"]) > 32
            ):
                raise Refused("invalid node metadata")
            identifier(row["epoch"])
            identifier(row["boot"])
            for job in row["retired_jobs"]:
                identifier(job)
        epochs = {r: row["epoch"] for r, row in data.items()}
        recovery = state.get("rehearsal_recovery")
        if (
            state["phase"] == "starting"
            and recovery
            and not recovery["boots_confirmed"]
        ):
            if (
                now >= stamp(state["boot_deadline"])
                or not powered(state)
                or any(
                    data[r]["boot"] == boot
                    for r, boot in recovery["prior_boots"].items()
                )
            ):
                raise Refused("both new S3 VM boots must be confirmed before recovery")
            recovery["boots_confirmed"] = True
            # Bound only the externally issued power-on, not the separate rollout.
            state["boot_deadline"] = state["expires"]
        if (
            state["epochs"]
            and epochs != state["epochs"]
            and state["phase"] in {"starting", "ready"}
        ):
            if self.slot == "s3":
                # Keep the old node observations for the eventual two-boot fence.
                drain(state, now, "unapproved S3 node epoch change")
                return
            state["tester_open"] = False
            if state["operation"]:
                if state["operation"]["phase"] == "running":
                    state["in_flight"] = state["operation"]["request"]["id"]
                state["operation"]["phase"] = "recovery-required"
            if (
                not state["clean_drain"]
                and state["last_verified"]
                and not state["in_flight"]
            ):
                state["in_flight"] = (
                    state["operation"]["request"]["id"]
                    if state["operation"]
                    else state.get("last_operation")
                )
        state.update(nodes=data, epochs=epochs, app_seen=now.isoformat())

    def drained(self, state, data, now):
        if (
            state["phase"] != "draining"
            or data["generation"] != state["generation"]
            or now >= stamp(state["drain"]["deadline"])
            or data["epoch"] != state["epochs"].get("app")
            or data["uid"] != state["submission_uid"]
            or data["ceased"] is not True
        ):
            raise Refused("unconfirmed drain")
        evidence = data["retained"]
        if set(evidence) != {"attempts", "outbox", "jobs", "results", "dlt"} or any(
            type(v) is not int or v < 0 for v in evidence.values()
        ):
            raise Refused("durable retained work was not measured")
        state["drain"].update(complete=True, retained_work=evidence)
        state["clean_drain"] = not state["in_flight"]

    def status(self, caller):
        if caller["role"] not in {
            "member",
            "lifecycle",
            "deployment",
            "eligibility",
            "rehearsal-operator",
        }:
            raise Refused("status authority required")

        def view(s, now):
            result = dict(
                environment=self.slot,
                phase=s["phase"],
                generation=s["generation"],
                ready=s.get("ready_at"),
                expires=s["expires"],
                contest=s["contest"],
                release=s["last_verified"],
                heartbeat=s["heartbeat"],
                power={r: p["state"] for r, p in s["power"].items()},
                cleanup=s["cleanup"],
                inventory_followup=s["inventory_followup"],
                operation=(
                    dict(
                        id=s["operation"]["request"]["id"],
                        phase=s["operation"]["phase"],
                    )
                    if s["operation"]
                    else None
                ),
            )
            if self.slot == "s3":
                experiment = s["experiment"]
                result["experiment"] = dict(
                    id=experiment["id"],
                    approvalRef=experiment["approval_ref"],
                    deadline=experiment["deadline"],
                    targets=s["targets"],
                )
                recovery = s.get("rehearsal_recovery")
                if recovery:
                    result["rehearsal_recovery"] = {
                        key: recovery[key]
                        for key in ("attempt", "request", "accepted", "boots_confirmed")
                    }
                    result["rehearsal_recovery"]["bootDeadline"] = s["boot_deadline"]
            elif s["phase"] == "compute-maintenance":
                window = s["terraform_window"]
                result["terraform_window"] = dict(
                    requestId=window["request"],
                    terraformPlan=window["plan"],
                )
            return result

        return self.change(view)

    def reconcile(self):
        state, _ = self.store.read()
        outcomes = {}
        if state:
            if state["targets"] != self.policy["targets"]:
                raise Refused("durable target changed")
            for p in state["power"].values():
                for i in p["intents"]:
                    if i["status"] == "pending":
                        outcomes[i["id"]] = self.power.outcome(i["url"])
        views = self.power.observe()

        def update(s, now):
            s["contest"] = bool(self.policy.get("contest", True))
            confirmations = self.policy.get("confirmed_power_intents", {})
            if all(value == "deallocated" for value in views.values()):
                for role, power in s["power"].items():
                    for intent in power["intents"]:
                        if (
                            intent["status"] in {"unknown", "pending"}
                            and confirmations.get(intent["id"], {}).get("target")
                            == s["targets"][role]
                            and confirmations[intent["id"]].get("evidence")
                        ):
                            intent.update(
                                status="failed",
                                reconciled=confirmations[intent["id"]]["evidence"],
                            )
            return tick(s, self.policy, now, views, outcomes)

        pending = self.change(update)
        for role, uid in pending:
            try:
                intent = self.change(lambda s, now: claim(s, role, uid, now))
            except (Refused, StopIteration):
                continue
            try:
                url = self.power.send(role, intent["action"], intent["id"])
            except Exception:
                # The claim is durable. A retry must reconcile actual state;
                # a start with an ambiguous response is never sent twice.
                continue
            self.change(lambda s, now: power_result(s, role, uid, url, now))
        return self.change(
            lambda s, now: dict(
                overdue=bool(s["cleanup"] and s["cleanup"]["overdue"]),
                inventory=s["inventory_followup"],
                off_violation=s["off_violation"],
                heartbeat=fresh(s["heartbeat"], now, 30),
            )
        )
