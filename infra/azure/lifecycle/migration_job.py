"""Run the fixed Job and confirm its local container exit under the host writer lease."""

import time

from node_state import RecoveryRequired


class MigrationJob:
    def __init__(
        self,
        rollout,
        deliver_secret,
        authorize,
        revoke,
        approved_template,
        retired_job,
        observation,
    ):
        self.rollout = rollout
        self.deliver_secret = deliver_secret
        self.authorize = authorize
        self.revoke = revoke
        self.approved_template = approved_template
        self.retired_job = retired_job
        self.observation = observation

    def prepare(self, renew):
        current = self.rollout.call("get", "job/migrate", "--ignore-not-found")
        if current:
            status = current.get("status", {})
            untouched = current["spec"].get("suspend") and not status.get("startTime")
            if not untouched and not self.retired_job(current["metadata"]["uid"]):
                raise RecoveryRequired(
                    "previous migration Job requires confirmed termination"
                )
            renew()
            self.rollout.retire_migration(current)
            until = time.monotonic() + 30
            while self.rollout.call("get", "job/migrate", "--ignore-not-found"):
                renew()
                if time.monotonic() >= until:
                    raise RecoveryRequired("previous Job deletion unconfirmed")
                time.sleep(0.25)
        template = self.approved_template()
        metadata = template["metadata"]
        labels = metadata["labels"]
        if labels.get("astracode.io/template") != "migrate":
            raise RecoveryRequired("wrong migration template")
        renew()
        return self.rollout.call(
            "create",
            "-f",
            "-",
            body={
                "apiVersion": "batch/v1",
                "kind": "Job",
                "metadata": {
                    "name": "migrate",
                    "namespace": "astracode-app",
                    "labels": labels,
                },
                "spec": {
                    "suspend": True,
                    "backoffLimit": 0,
                    "completions": 1,
                    "parallelism": 1,
                    "activeDeadlineSeconds": 600,
                    "template": template,
                },
            },
        )

    def __call__(self, attempt, passwords, renew):
        uid = None
        cid = None
        seen = False
        try:
            renew()
            job = self.prepare(renew)
            self.deliver_secret(attempt, passwords)
            job = self.rollout.call(
                "patch",
                "job/migrate",
                patch={
                    "metadata": {"resourceVersion": job["metadata"]["resourceVersion"]},
                    "spec": {"suspend": False},
                },
            )
            expected = job["metadata"]["uid"]
            until = time.monotonic() + 590
            while time.monotonic() < until:
                renew()
                job = self.rollout.call("get", "job/migrate")
                if job["metadata"]["uid"] != expected or job.get("status", {}).get(
                    "failed", 0
                ):
                    raise RecoveryRequired("migration Job failed or changed")
                view = self.observation()
                current = [c for c in view["containers"] if c["workload"] == "migrate"]
                if len(current) > 1 or any(c["job_uid"] != expected for c in current):
                    raise RecoveryRequired("ambiguous migration container")
                if current:
                    c = current[0]
                    if cid and (c["container"] != cid or c["uid"] != uid):
                        raise RecoveryRequired("migration container changed")
                    uid, cid = c["uid"], c["container"]
                    self.authorize(uid, expected)
                    seen = True
                elif seen and job.get("status", {}).get("succeeded") == 1:
                    if any(
                        c["job_uid"] == expected
                        and c["container"] == cid
                        and c["uid"] == uid
                        and c["exit_code"] == 0
                        and c["finished_at"] > 0
                        for c in view["exited"]
                        if c["workload"] == "migrate"
                    ):
                        return
                time.sleep(1)
            raise RecoveryRequired("migration Job deadline expired")
        finally:
            try:
                self.revoke()
            finally:
                self.deliver_secret(attempt, None)
