"""Ordering shared by the protected App poller for deployment, recovery and rollback."""

from datetime import datetime, timezone
import time

from node_state import RecoveryRequired


def activate(
    state, request, release, effects, *, clock=lambda: datetime.now(timezone.utc)
):
    # effects supplies the bounded host operations and the controller's
    # conditional record writes. The record must precede the first mutation.
    def check():
        now = clock()
        if (
            now >= request["deadline"]
            or not effects.lease_current(request, now)
            or not effects.epochs_match(request)
            or effects.contest_frozen()
        ):
            raise RecoveryRequired(
                "approval, node epoch, lease or mutation window lost"
            )

    check()
    if release["digest"] != request["release"] or not effects.verify_release(
        request, release
    ):
        raise RecoveryRequired("release is ineligible for this environment")
    action = request["action"]
    if action not in {"deploy", "rollback", "restart", "recover"}:
        raise RecoveryRequired("unknown activation operation")
    if state["in_flight"] and action != "recover":
        raise RecoveryRequired("partial operation requires authorized reconciliation")
    if action == "restart" and (
        not state["clean_drain"] or release["digest"] != state["last_verified"]
    ):
        raise RecoveryRequired("clean restart evidence missing")
    if action == "rollback" and not effects.verified_rollback(release):
        raise RecoveryRequired("rollback has no compatible verified artifact")
    effects.begin(request, release)
    try:
        effects.close_edge()
        confirmed = effects.verified_empty_or_clean_stop(state)
        prior = None
        if not confirmed:
            if not state["submission_uid"]:
                raise RecoveryRequired("prior Submission termination unresolved")
            prior = effects.prior_submission(state["submission_uid"])
        effects.quiesce_worker()
        check()
        if not effects.group_empty():
            raise RecoveryRequired("Worker or in-flight work still active")
        if prior is not None:
            effects.stop_submission()
            while not effects.stopped(prior):
                check()
                time.sleep(0.25)
        check()
        versions = effects.reconcile_databases(request, release, check)
        if versions != release["versions"]:
            raise RecoveryRequired("one or more owner histories differ")
        for role in ("app", "judge"):
            check()
            effects.activate_role(role, release)
            effects.wait_ready(role, release, check)
        check()
        effects.problem_contract(release)
        effects.smoke(release, check)
        check()
        effects.record_verified(request, release, versions)
        effects.open_edge(request)
    except BaseException:
        try:
            effects.revoke_permits()
        finally:
            try:
                effects.close_edge()
            finally:
                effects.recovery_required(request)
        raise
