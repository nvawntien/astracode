"""Collect counts for retained official work after the guarded processes exit."""

import json
import subprocess
import time

from kube_rollout import Cluster
from node_state import RecoveryRequired


def observe(app, judge):
    report = {}
    for role, client in (("app", app), ("judge", judge)):
        view = client.observation()
        report[role] = dict(
            epoch=view["epoch"],
            boot=view["boot_id"],
            retired_jobs=sorted(
                {r["job_uid"] for r in view["exited"] if r["workload"] == "migrate"}
            ),
        )
    return report


def finish(controller, settings, kubeconfig, status):
    app = Cluster("app", kubeconfig)
    judge = Cluster("judge", kubeconfig)
    judge.scale("judge-worker", 0)
    app.scale("submission-service", 0)
    deadline = time.monotonic() + 20
    while True:
        left = app.observation()
        right = judge.observation()
        seen = any(
            c["workload"] == "submission-service" for c in left["containers"]
        ) or bool(right["containers"])
        if not seen:
            break
        if time.monotonic() >= deadline:
            raise RecoveryRequired("drain termination not confirmed")
        time.sleep(0.5)
    uid = status["submission_uid"]
    if uid and not any(
        c["workload"] == "submission-service"
        and c["uid"] == uid
        and c["finished_at"] > 0
        for c in left["exited"]
    ):
        raise RecoveryRequired("prior Submission UID exit not confirmed")
    broker = settings["kafka_ip"] + ":9092"
    probe = subprocess.check_output(
        ["/usr/local/libexec/astra/judge-rollout-probe", "retained-work", broker],
        timeout=15,
        stderr=subprocess.DEVNULL,
    )
    raw = subprocess.check_output(
        [
            "psql",
            "-XqAt",
            "-v",
            "ON_ERROR_STOP=1",
            "service=astra_drain_submission",
            "-c",
            "SELECT astra_control.retained_work()",
        ],
        timeout=10,
        stderr=subprocess.DEVNULL,
    )
    controller.call(
        "drained",
        generation=status["generation"],
        epoch=left["epoch"],
        uid=uid,
        ceased=True,
        retained=dict(json.loads(probe), **json.loads(raw)),
    )
