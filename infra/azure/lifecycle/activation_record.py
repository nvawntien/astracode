"""Conditional transitions of the App participant in an already-approved environment operation."""

from datetime import timedelta
import uuid

from controller_client import timestamp
from node_state import RecoveryRequired

APP = {"auth-service", "problem-service", "submission-service", "website", "envoy"}
JUDGE = {"judge-worker", "go-judge"}


def transition(state, action, data, now, bundle):
    """Caller authenticates the environment's App identity and CAS-writes state before replying."""
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
        raise RecoveryRequired("lost controller or App lease")
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
            heartbeat + timedelta(minutes=3),
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
            req["environment"] != "s3"
            or req["action"] != "recover"
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
        op["migration_uid"] = uid
        return {}
    if action == "retired-job":
        return {
            "confirmed": data["uid"]
            in op["migration"].get("confirmed_retired_jobs", [])
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
        state["verified_releases"][req["release"]] = dict(
            versions=versions,
            evidence=evidence,
            config=expected["config"],
            operation=req["id"],
            ready=now.isoformat(),
            smoke="passed",
        )
        state["last_verified"] = req["release"]
        state["submission_uid"] = evidence["app"]["containers"]["submission-service"][
            "uid"
        ]
        state["in_flight"] = None
        state.pop("forward_required", None)
        state["clean_drain"] = False
        op["phase"] = "verified"
        return {}
    raise RecoveryRequired("invalid App operation transition")
