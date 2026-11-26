"""Trusted host observations for activation and confirmed Submission termination."""

from dataclasses import dataclass
import json
from pathlib import Path
import subprocess


class RecoveryRequired(RuntimeError):
    pass


def cri(*args):
    raw = subprocess.run(
        ["/usr/local/bin/k3s", "crictl", *args],
        timeout=6,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    ).stdout
    return json.loads(raw)


def epoch():
    return Path("/run/astracode/epoch").read_text().strip()


@dataclass(frozen=True)
class Submission:
    epoch: str
    pod_uid: str
    container_id: str


def prior_submission(verified_uid, local_epoch=epoch, inspect=cri):
    """Call on the healthy App host before scale-down, with the recorded UID."""
    if not verified_uid:
        raise RecoveryRequired("prior Submission UID missing")
    found = [
        c
        for c in inspect("ps", "-o", "json")["containers"]
        if c["labels"].get("io.kubernetes.pod.namespace") == "astracode-app"
        and c["metadata"]["name"] == "submission-service"
    ]
    if (
        len(found) != 1
        or found[0]["labels"].get("io.kubernetes.pod.uid") != verified_uid
    ):
        raise RecoveryRequired("prior Submission process ambiguous")
    return Submission(local_epoch(), verified_uid, found[0]["id"])


def stopped(prior, local_epoch=epoch, inspect=cri):
    if local_epoch() != prior.epoch:
        raise RecoveryRequired("App restarted during Submission drain")
    # Require the positive CRI exit record. A missing Pod or a garbage-collected
    # container is insufficient evidence for the in-process outbox relay.
    state = inspect("inspect", "-o", "json", prior.container_id)["status"]
    if (
        state.get("id") != prior.container_id
        or state.get("labels", {}).get("io.kubernetes.pod.uid") != prior.pod_uid
        or state.get("metadata", {}).get("name") != "submission-service"
    ):
        raise RecoveryRequired("prior Submission identity changed")
    if (
        state.get("state") != "CONTAINER_EXITED"
        or int(state.get("finishedAt") or 0) <= 0
    ):
        return False
    return not any(
        c["metadata"]["name"] == "submission-service"
        and c["labels"].get("io.kubernetes.pod.namespace") == "astracode-app"
        for c in inspect("ps", "-o", "json")["containers"]
    )
