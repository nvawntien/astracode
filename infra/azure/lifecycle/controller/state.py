"""Pure durable lifecycle transitions; callers commit them before any power effect."""

from datetime import datetime, time, timedelta, timezone
import re
from zoneinfo import ZoneInfo
import uuid

ZONE = ZoneInfo("Asia/Ho_Chi_Minh")
BOOT = timedelta(minutes=30)
SESSION = timedelta(hours=1)
DRAIN = timedelta(minutes=5)
CLEANUP = timedelta(minutes=15)
OPERATION = timedelta(minutes=10)
REHEARSAL_BOOT = timedelta(minutes=10)


class Refused(ValueError):
    pass


def stamp(value):
    result = datetime.fromisoformat(value)
    if result.tzinfo is None:
        raise Refused("UTC instant required")
    return result.astimezone(timezone.utc)


def fresh(value, now, seconds):
    return bool(value) and timedelta(0) <= now - stamp(value) < timedelta(
        seconds=seconds
    )


def rehearsal_sources(experiment):
    # Retained v1 records may bind one release. Never widen such a record
    # through a change to the Function's configuration.
    if "releases" in experiment:
        sources = experiment["releases"]
    else:
        sources = {experiment.get("release"): experiment.get("source")}
    if (
        not isinstance(sources, dict)
        or not 1 <= len(sources) <= 16
        or any(
            not isinstance(bundle, str)
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", bundle)
            or not isinstance(source, str)
            or not re.fullmatch(r"[a-f0-9]{40}", source)
            for bundle, source in sources.items()
        )
    ):
        raise Refused("exact rehearsal bundle and source bindings required")
    return sources


def initial(policy, now):
    state = dict(
        schemaVersion=1,
        environment=policy["environment"],
        targets=policy["targets"],
        phase="off",
        generation=None,
        expires=None,
        boot_deadline=None,
        heartbeat=None,
        app_seen=None,
        epochs={},
        tester_open=False,
        operation=None,
        in_flight=None,
        last_verified=None,
        submission_uid=None,
        clean_drain=False,
        verified_releases={},
        requests={},
        tickets={},
        power={
            r: dict(state="unknown", sample=None, intents=[]) for r in ("app", "judge")
        },
        off_day=now.astimezone(ZONE).date().isoformat(),
        off_seconds=0,
        off_violation=False,
        contest=False,
        drain=None,
        cleanup=None,
        experiment=policy.get("experiment"),
        inventory_followup=False,
    )
    if policy["environment"] == "s3":
        experiment = state["experiment"]
        if (
            not experiment
            or not experiment.get("approval_ref")
            or experiment["targets"] != policy["targets"]
        ):
            raise Refused("owner-approved immutable S3 experiment required")
        rehearsal_sources(experiment)
        deadline = stamp(experiment["deadline"])
        state.update(
            phase="starting",
            generation=str(uuid.UUID(experiment["id"])),
            expires=deadline.isoformat(),
            boot_deadline=deadline.isoformat(),
        )
    return state


def window(policy, now):
    if policy.get("off_window_confirmed") is not True:
        raise Refused("owner-confirmed daily off window required")
    start = time.fromisoformat(policy["off_start"])
    end = time.fromisoformat(policy["off_end"])
    local = now.astimezone(ZONE)
    windows = []
    for offset in (-1, 0, 1, 2):
        day = local.date() + timedelta(days=offset)
        first = datetime.combine(day, start, ZONE)
        last = datetime.combine(day, end, ZONE)
        if last <= first:
            last += timedelta(days=1)
        if last - first < timedelta(hours=12):
            raise Refused("daily off window is shorter than 12 hours")
        windows.append((first, last))
    if any(first <= local < last for first, last in windows):
        raise Refused("daily off window is active")
    next_start = min(first for first, _ in windows if first > local)
    midnight = datetime.combine(local.date() + timedelta(days=1), time.min, ZONE)
    reserved = max(0, (midnight - next_start).total_seconds())
    return next_start.astimezone(timezone.utc), reserved


def fits(policy, state, now, duration, *, starting=False):
    close, reserved = window(policy, now)
    if now + duration + CLEANUP > close:
        raise Refused("insufficient time before the mandatory off window")
    if starting and state["off_seconds"] + reserved < 12 * 3600:
        raise Refused("insufficient observed daily off time")


def known_off(state, *, missing=False):
    inactive = {"deallocated", "not-found"} if missing else {"deallocated"}
    return all(
        p["state"] in inactive
        and not any(i["status"] not in {"done", "failed"} for i in p["intents"])
        for p in state["power"].values()
    )


def may_have_uncreated_targets(state):
    if state["environment"] == "s3":
        return not state.get("power_seen_running") and not state.get("nodes")
    window = state.get("terraform_window") or {}
    return (
        window.get("generation") == state["generation"]
        and window.get("plan", {}).get("operation") == "create"
    )


def powered(state):
    return all(
        p["state"] == "running"
        and not any(
            i["action"] == "start"
            and i["generation"] == state["generation"]
            and i["status"] != "done"
            for i in p["intents"]
        )
        for p in state["power"].values()
    )


def drain(state, now, reason):
    state["tester_open"] = False
    if state["phase"] not in {"draining", "stopping"}:
        if state["environment"] == "s3" and state.get("nodes"):
            state["recovery_prior_boots"] = {
                role: node["boot"] for role, node in state["nodes"].items()
            }
        state["phase"] = "draining"
        state["drain"] = dict(
            deadline=(now + DRAIN).isoformat(),
            complete=False,
            reason=reason,
            retained_work=None,
        )
        state["cleanup"] = dict(deadline=(now + CLEANUP).isoformat(), overdue=False)
    if state["operation"] and state["operation"]["phase"] in {"approved", "running"}:
        state["operation"]["phase"] = "recovery-required"


def resume_rehearsal(state, request, identity, now):
    attempt = request["recoveryAttempt"]
    prior = state.get("rehearsal_recovery") or {}
    until = stamp(state["expires"])
    operation = state["operation"]
    if (
        state["environment"] != "s3"
        or identity["role"] != "rehearsal-operator"
        or state["phase"] != "off"
        or state["generation"] != request["sessionGeneration"]
        or state["in_flight"] != attempt
        or not operation
        or operation["request"]["id"] != attempt
        or prior.get("attempt") == attempt
        or set(state.get("nodes", {})) != {"app", "judge"}
        or state["contest"]
        or state["inventory_followup"]
        or not fresh(state["heartbeat"], now, 180)
        or not all(fresh(p["sample"], now, 180) for p in state["power"].values())
        or not known_off(state)
        or now + REHEARSAL_BOOT + OPERATION + timedelta(minutes=1) >= until
    ):
        raise Refused("no current off, retained S3 attempt with time for recovery")
    boot_deadline = min(now + REHEARSAL_BOOT, until)
    state["rehearsal_recovery"] = dict(
        attempt=attempt,
        request=request["requestId"],
        identity=identity,
        approval_ref=state["experiment"]["approval_ref"],
        prior_boots=state.get("recovery_prior_boots")
        or {role: node["boot"] for role, node in state["nodes"].items()},
        accepted=now.isoformat(),
        boots_confirmed=False,
    )
    operation["phase"] = "recovery-required"
    state.update(
        phase="starting",
        tester_open=False,
        app_seen=None,
        epochs={},
        boot_deadline=boot_deadline.isoformat(),
        power_seen_running=False,
    )
    return dict(
        accepted=True,
        generation=state["generation"],
        phase="starting",
        bootDeadline=boot_deadline.isoformat(),
        expires=state["expires"],
    )


def admit_terraform(state, request, identity, policy, now):
    plan = request["terraformPlan"]
    deadline = stamp(plan["expiresAt"])
    create = plan["operation"] == "create"
    if (
        state["phase"] != "off"
        or not known_off(state, missing=create)
        or not all(fresh(p["sample"], now, 180) for p in state["power"].values())
        or (
            create
            and not any(p["state"] == "not-found" for p in state["power"].values())
        )
        or (create and state["last_verified"])
        or state["in_flight"] != request.get("recoveryAttempt")
        or not now < deadline <= now + BOOT
    ):
        raise Refused(
            "Terraform needs confirmed inactive targets and a fresh exact plan"
        )
    fits(policy, state, now, deadline - now, starting=True)
    state.update(
        phase="compute-maintenance",
        generation=str(uuid.uuid4()),
        expires=deadline.isoformat(),
        tester_open=False,
        app_seen=None,
        epochs={},
        terraform_window=dict(
            request=request["requestId"], plan=plan, identity=identity
        ),
    )
    state["terraform_window"]["generation"] = state["generation"]
    return dict(
        accepted=True,
        generation=state["generation"],
        phase=state["phase"],
        expires=state["expires"],
        terraformPlan=plan,
        requestId=request["requestId"],
    )


def admit(state, request, identity, policy, now, release=None):
    """Authentication has already bound this immutable request to native review and a run."""
    action = request["operation"]
    if request["environment"] != policy["environment"]:
        raise Refused("wrong target environment")
    if policy["environment"] == "s3" and action in {"start", "extend"}:
        raise Refused("S3 controller has no power-on or extension authority")
    expected_role = (
        "lifecycle" if action in {"start", "extend", "cancel"} else "deployment"
    )
    if identity["role"] != expected_role:
        raise Refused("approval role cannot authorize this action")
    if action == "cancel":
        if request.get("sessionGeneration") != state["generation"]:
            raise Refused("stale cancellation generation")
        drain(state, now, "approved cancellation")
        return dict(accepted=True, generation=state["generation"], phase=state["phase"])
    if state["contest"]:
        raise Refused("contest freeze")
    if not fresh(state["heartbeat"], now, 180):
        raise Refused("controller heartbeat is stale")
    if action == "start":
        if "terraformPlan" in request:
            return admit_terraform(state, request, identity, policy, now)
        if (
            state["phase"] != "off"
            or not known_off(state)
            or state["in_flight"] != request.get("recoveryAttempt")
        ):
            raise Refused(
                "environment is not confirmed safely off or retained recovery binding differs"
            )
        fits(policy, state, now, BOOT + SESSION, starting=True)
        state.update(
            phase="starting",
            generation=str(uuid.uuid4()),
            expires=(now + BOOT).isoformat(),
            boot_deadline=(now + BOOT).isoformat(),
            tester_open=False,
            app_seen=None,
            epochs={},
            operation=state["operation"] if state["in_flight"] else None,
        )
        state["startup_approval"] = dict(
            request=request["requestId"], identity=identity
        )
        for role in ("app", "judge"):
            state["power"][role]["intents"].append(
                dict(
                    id=str(uuid.uuid4()),
                    action="start",
                    status="planned",
                    created=now.isoformat(),
                    generation=state["generation"],
                    url=None,
                )
            )
        return dict(accepted=True, generation=state["generation"], phase="starting")
    if request.get("sessionGeneration") != state["generation"]:
        raise Refused("stale session generation")
    if state["phase"] not in {"starting", "ready"} or now >= stamp(state["expires"]):
        raise Refused("session expired or unavailable")
    if action == "extend":
        if state["phase"] != "ready" or state["in_flight"]:
            raise Refused("extension needs an idle ready session")
        expires = stamp(request["requestedExpiry"])
        if expires <= stamp(state["expires"]):
            raise Refused("extension must move the current expiry forward")
        fits(policy, state, now, expires - now)
        state["expires"] = expires.isoformat()
        return dict(
            accepted=True, generation=state["generation"], expires=state["expires"]
        )
    if action not in {"deploy", "rollback", "restart", "recover"}:
        raise Refused("unknown lifecycle action")
    if not fresh(state["app_seen"], now, 15) or set(state["epochs"]) != {
        "app",
        "judge",
    }:
        raise Refused("fresh App and Judge observations required")
    if not powered(state):
        raise Refused("both VM starts must be confirmed")
    if state["in_flight"] and action != "recover":
        raise Refused("retained mutation needs separate recovery")
    if state["operation"] and state["operation"]["phase"] in {"approved", "running"}:
        raise Refused("another operation owns the environment")
    if now + OPERATION + timedelta(minutes=1) >= stamp(state["expires"]):
        raise Refused("insufficient safe operation window")
    if release is None or release["digest"] != request["releaseDigest"]:
        raise Refused("verified release required")
    forward = state.get("forward_required")
    if forward and (
        release["digest"] != forward["release"]
        or (
            not state["in_flight"]
            and (action != "deploy" or state["epochs"] != forward["epochs"])
        )
    ):
        raise Refused(
            "sealed recovery requires a separate forward deployment on the same epochs"
        )
    if action == "rollback" and release["digest"] not in state["verified_releases"]:
        raise Refused("rollback release has no verified environment history")
    if action == "restart" and (
        not state["clean_drain"] or state["last_verified"] != release["digest"]
    ):
        raise Refused("restart requires clean drain and the last verified release")
    env = release["environments"][policy["environment"]]
    migration = request.get("migration")
    if not migration or migration.get("release") != release["digest"]:
        raise Refused("protected migration/recovery policy required")
    before = {
        k: state[k]
        for k in ("in_flight", "last_verified", "submission_uid", "clean_drain")
    }
    state["operation"] = dict(
        phase="approved",
        request=dict(
            id=request["requestId"],
            action=action,
            release=release["digest"],
            environment=policy["environment"],
            session=state["generation"],
            app_epoch=state["epochs"]["app"],
            judge_epoch=state["epochs"]["judge"],
            deadline=(now + OPERATION).isoformat(),
        ),
        before=before,
        termination=request["termination"],
        migration=migration,
        expected=dict(
            images=release["images"],
            versions=release["versions"],
            workloads=env["workloads"],
            config=env["digest"],
        ),
        identity=identity,
    )
    return dict(
        accepted=True, generation=state["generation"], operation=request["requestId"]
    )


def ready(state, policy, now):
    if state["phase"] != "starting" or now >= stamp(state["boot_deadline"]):
        raise Refused("startup deadline expired")
    if (
        not state["operation"]
        or state["operation"]["phase"] != "verified"
        or not powered(state)
    ):
        raise Refused("nodes and approved release are not ready")
    if policy["environment"] == "s2":
        fits(policy, state, now, SESSION)
    expires = now + SESSION
    if policy["environment"] == "s3":
        expires = min(expires, stamp(state["expires"]))
    state.update(
        phase="ready",
        ready_at=now.isoformat(),
        expires=expires.isoformat(),
        tester_open=True,
    )


def tick(state, policy, now, observations, operations):
    """LRO outcomes are sampled before instance views. All returned intents need a durable claim."""
    if (
        state["targets"] != policy["targets"]
        or state["environment"] != policy["environment"]
    ):
        raise Refused("durable target binding changed")
    old_day = state["off_day"]
    local_day = now.astimezone(ZONE).date().isoformat()
    if old_day != local_day:
        state["off_violation"] = state["off_seconds"] < 12 * 3600
        state["off_day"], state["off_seconds"] = local_day, 0
    prior = list(state["power"].values())
    if all(
        p["state"] == "deallocated" and fresh(p["sample"], now, 180) for p in prior
    ) and all(v == "deallocated" for v in observations.values()):
        start = max(stamp(p["sample"]) for p in prior)
        midnight = datetime.combine(
            now.astimezone(ZONE).date(), time.min, ZONE
        ).astimezone(timezone.utc)
        state["off_seconds"] += max(0, (now - max(start, midnight)).total_seconds())
    for role, power in state["power"].items():
        power.update(state=observations[role], sample=now.isoformat())
        for intent in power["intents"]:
            if intent["id"] in operations:
                outcome = operations[intent["id"]]
                if outcome in {"Succeeded", "Failed", "Canceled"}:
                    intent["status"] = "done" if outcome == "Succeeded" else "failed"
            if intent["status"] == "claimed" and now - stamp(
                intent["claimed_at"]
            ) > timedelta(seconds=30):
                intent["status"] = "unknown"
            if intent["action"] == "deallocate":
                if power["state"] == "deallocated" and intent["status"] == "unknown":
                    intent["status"] = "done"
                elif (
                    intent["status"] == "pending"
                    and observations[role] != "deallocated"
                    and now - stamp(intent["responded_at"]) >= timedelta(minutes=3)
                ):
                    intent["status"] = "unknown"
    expired = state["expires"] and now >= stamp(state["expires"])
    experiment = state["experiment"]
    recovering = state.get("rehearsal_recovery")
    was_running = state.get("power_seen_running")
    if experiment and all(v == "running" for v in observations.values()):
        state["power_seen_running"] = True
    if experiment and now >= stamp(experiment["deadline"]):
        if not known_off(state, missing=may_have_uncreated_targets(state)):
            drain(state, stamp(experiment["deadline"]), "S3 experiment deadline")
        else:
            state.update(phase="off", tester_open=False)
        state["inventory_followup"] = True
    elif state["phase"] == "compute-maintenance" and (
        expired or state["contest"] or not fresh(state["heartbeat"], now, 180)
    ):
        drain(
            state,
            stamp(state["expires"]) if expired else now,
            "Terraform power window closed",
        )
    elif state["phase"] in {"starting", "ready"}:
        if expired or (state["heartbeat"] and not fresh(state["heartbeat"], now, 180)):
            drain(
                state,
                stamp(state["expires"]) if expired else now,
                "expiry or missed controller heartbeat",
            )
        elif (state["app_seen"] or state["phase"] == "ready") and not fresh(
            state["app_seen"], now, 15
        ):
            drain(state, now, "App heartbeat lost")
        elif (
            state["phase"] == "starting"
            and recovering
            and not recovering["boots_confirmed"]
            and now >= stamp(state["boot_deadline"])
        ):
            drain(state, now, "S3 recovery power window expired")
        elif any(
            i["action"] == "start"
            and i["generation"] == state["generation"]
            and i["status"] in {"failed", "unknown"}
            for p in state["power"].values()
            for i in p["intents"]
        ):
            drain(state, now, "start outcome failed or uncertain")
        elif (state["phase"] == "ready" or (experiment and was_running)) and any(
            v != "running" for v in observations.values()
        ):
            drain(state, now, "unexpected VM power state")
    elif state["phase"] == "off" and any(
        v not in {"deallocated", "not-found"} for v in observations.values()
    ):
        drain(state, now, "unexpected power while off")
    if state["phase"] == "draining" and (
        state["drain"]["complete"] or now >= stamp(state["drain"]["deadline"])
    ):
        if not state["drain"]["complete"]:
            state["clean_drain"] = False
            if not state["in_flight"]:
                if state.get("forward_required") or (
                    experiment and state["last_verified"] and state["operation"]
                ):
                    state["in_flight"] = state["operation"]["request"]["id"]
                elif state["last_verified"]:
                    state["in_flight"] = state.get("last_operation")
        state["phase"] = "stopping"
    if (
        state["operation"]
        and state["operation"]["phase"] in {"approved", "running"}
        and now >= stamp(state["operation"]["request"]["deadline"])
    ):
        drain(state, now, "operation deadline expired")
    if state["phase"] != "starting":
        for power in state["power"].values():
            for intent in power["intents"]:
                if intent["action"] == "start" and intent["status"] == "planned":
                    intent["status"] = "failed"
    if state["phase"] == "stopping":
        if known_off(state, missing=may_have_uncreated_targets(state)):
            state.update(phase="off", tester_open=False)
        else:
            for role, power in state["power"].items():
                if power["state"] in {"deallocated", "not-found"}:
                    continue
                waiting = [
                    i
                    for i in power["intents"]
                    if i["action"] == "deallocate"
                    and i["status"] in {"planned", "claimed", "pending"}
                ]
                previous = [i for i in power["intents"] if i["action"] == "deallocate"]
                retries = sum(
                    1 for i in previous if i["generation"] == state["generation"]
                )
                if not waiting and (
                    not previous
                    or now - stamp(previous[-1]["created"])
                    >= timedelta(seconds=min(30 * 2 ** min(retries, 4), 300))
                ):
                    power["intents"].append(
                        dict(
                            id=str(uuid.uuid4()),
                            action="deallocate",
                            status="planned",
                            created=now.isoformat(),
                            generation=state["generation"],
                            url=None,
                        )
                    )
        state["cleanup"]["overdue"] = state["phase"] != "off" and now >= stamp(
            state["cleanup"]["deadline"]
        )
    # The service logs heartbeat only after this reconciliation is committed.
    if all(v != "unknown" for v in observations.values()):
        state["heartbeat"] = now.isoformat()
    return [
        (r, i["id"])
        for r, p in state["power"].items()
        for i in p["intents"]
        if i["status"] == "planned"
        and (
            i["action"] == "deallocate"
            or (state["phase"] == "starting" and policy["environment"] == "s2")
        )
    ]


def claim(state, role, identifier, now):
    intent = next(i for i in state["power"][role]["intents"] if i["id"] == identifier)
    if intent["status"] != "planned" or intent["generation"] != state["generation"]:
        raise Refused("power intent already claimed or superseded")
    if intent["action"] == "start" and (
        state["environment"] != "s2"
        or state["phase"] != "starting"
        or now >= stamp(state["boot_deadline"])
    ):
        raise Refused("power-on authority expired")
    intent.update(status="claimed", claimed_at=now.isoformat())
    return dict(intent)


def power_result(state, role, identifier, url, now):
    intent = next(i for i in state["power"][role]["intents"] if i["id"] == identifier)
    if intent["status"] not in {"claimed", "unknown"}:
        raise Refused("unexpected power response")
    intent.update(
        url=url, status="pending" if url else "done", responded_at=now.isoformat()
    )
