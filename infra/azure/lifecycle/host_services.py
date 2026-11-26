"""Platform entry points for the rollout user and the independent permit issuer."""

import argparse
from datetime import datetime, timezone
import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
from urllib.parse import urlencode
import uuid

import local_rpc
from app_rollout import Rollout
from attempt_secret import deliver
from authority import Authority
from controller_client import Controller
from coordinator import reconcile
from kube_rollout import Cluster
from migration_job import MigrationJob
from node_state import RecoveryRequired
from release_catalog import Catalog, unpack_migrations

CONFIG = Path("/etc/astracode")
ISSUER = "/run/astra-activation/control.sock"
POLLER = "/run/astra-poller/effects.sock"


def token(settings):
    # The audience and client ID are platform configuration. The host endpoint
    # never accepts either value from a ticket or from the peer socket.
    client = str(uuid.UUID(settings["poller_client_id"]))
    query = urlencode(
        {
            "api-version": "2018-02-01",
            "client_id": client,
            "resource": settings["controller_audience"],
        }
    )
    conn = http.client.HTTPConnection("169.254.169.254", timeout=3)
    try:
        conn.request(
            "GET",
            "/metadata/identity/oauth2/token?" + query,
            headers={"Metadata": "true"},
        )
        response = conn.getresponse()
        if response.status != 200:
            raise RecoveryRequired("controller token unavailable")
        raw = response.read(32769)
        if len(raw) > 32768:
            raise ValueError("invalid identity response")
        data = json.loads(raw)
        if (
            data["resource"] != settings["controller_audience"]
            or data["token_type"].lower() != "bearer"
        ):
            raise ValueError("unexpected token scope")
        return data["access_token"]
    finally:
        conn.close()


class JobEffects:
    def __init__(self, ticket):
        self.ticket = ticket

    def call(self, *args, patch=None, body=None):
        return local_rpc.call(
            POLLER,
            "job",
            dict(ticket=self.ticket, args=list(args), patch=patch, body=body),
        )

    def retire_migration(self, job):
        return local_rpc.call(
            POLLER,
            "retire",
            dict(
                ticket=self.ticket,
                uid=job["metadata"]["uid"],
                version=job["metadata"]["resourceVersion"],
            ),
        )


class RemoteAuthority:
    def __init__(self, ticket):
        self.ticket = ticket

    def invoke(self, method, **params):
        return local_rpc.call(
            ISSUER,
            method,
            dict(ticket=self.ticket, **params),
            timeout=605 if method == "migrate" else 15,
        )

    def release(self, digest):
        return self.invoke("release")

    def verify_release(self, request, release):
        return self.release(request["release"]) == release

    def current_epochs(self):
        return self.invoke("epochs")

    def begin(self, request):
        return self.invoke("begin")

    def close_workload(self, request, name):
        return self.invoke("close", name=name)

    def prior_submission(self, uid):
        return self.invoke("prior", uid=uid)

    def submission_stopped(self, prior):
        return self.invoke("stopped", prior=prior)

    def verify_termination_history(self, request, state):
        return self.invoke("termination")

    def admit(self, request, name):
        return self.invoke("admit", name=name)

    def revoke(self, request):
        return self.invoke("revoke")

    def refresh_permits(self, request, role):
        return self.invoke("refresh", role=role)

    def running_digests(self, request, role):
        return self.invoke("observed", role=role)

    def observed_release(self, release):
        return self.invoke("evidence")

    def migrate_or_verify(self, request, release):
        return self.invoke("migrate")


def controller(settings, provider):
    return Controller(settings["controller_endpoint"], provider)


def run_poller(settings):
    lock = threading.Lock()
    current = {"ticket": None}
    jobs = Cluster("app", CONFIG / "rollout.kubeconfig")

    def check(ticket):
        if current["ticket"] != ticket:
            raise RecoveryRequired("wrong poll operation")
        c = controller(settings, lambda: token(settings))
        op = c.approved_operation(ticket)
        if c.lease(op) <= datetime.now(timezone.utc) or c.contest_frozen():
            raise RecoveryRequired("operation unavailable")

    def job(ticket, args, patch=None, body=None):
        check(ticket)
        if (
            args
            in (["get", "job/migrate"], ["get", "job/migrate", "--ignore-not-found"])
            and patch is None
            and body is None
        ):
            return jobs.call(*args)
        if (
            args == ["create", "-f", "-"]
            and patch is None
            and body["kind"] == "Job"
            and body["metadata"]["name"] == "migrate"
        ):
            return jobs.call(*args, body=body)
        if (
            args == ["patch", "job/migrate"]
            and body is None
            and patch["spec"] == {"suspend": False}
        ):
            return jobs.call(
                *args,
                patch={
                    "metadata": {
                        "resourceVersion": patch["metadata"]["resourceVersion"]
                    },
                    "spec": {"suspend": False},
                }
            )
        raise RecoveryRequired("unknown Job action")

    def retire(ticket, uid, version):
        check(ticket)
        jobs.retire_migration(
            {
                "metadata": {
                    "name": "migrate",
                    "uid": str(uuid.UUID(uid)),
                    "resourceVersion": version,
                }
            }
        )

    threading.Thread(
        target=local_rpc.serve,
        args=(
            POLLER,
            "astra-activation",
            {"token": lambda: token(settings), "job": job, "retire": retire},
        ),
        daemon=True,
    ).start()

    def heartbeat():
        while True:
            ticket = current["ticket"]
            if ticket:
                try:
                    controller(settings, lambda: token(settings)).call(
                        "app-heartbeat", operation=ticket
                    )
                except (OSError, ValueError, RuntimeError):
                    pass
            time.sleep(3)

    threading.Thread(target=heartbeat, daemon=True).start()
    while True:
        try:
            c = controller(settings, lambda: token(settings))
            ticket = c.call("poll")["ticket"]
            if ticket:
                with lock:
                    current["ticket"] = str(uuid.UUID(ticket))
                    Rollout(c, RemoteAuthority(ticket), settings).run(ticket)
        except Exception:
            # Report state through the controller. Never log a token, payload or fixture.
            print("Protected rollout waiting for verified state", flush=True)
        finally:
            current["ticket"] = None
        time.sleep(2)


def run_issuer(settings):
    c = controller(settings, lambda: local_rpc.call(POLLER, "token", {}))
    slot = (CONFIG / "slot").read_text().strip()
    catalog = Catalog(c, settings["executor_digest"])
    single = threading.Lock()

    def migrate(req, release):
        with single:
            policy = c.call("migration", operation=req["id"])
            if policy["release"] != req["release"]:
                raise RecoveryRequired("migration policy refers to another release")
            op = dict(
                policy,
                id=req["id"],
                deadline=req["deadline"].isoformat(),
                action=req["action"],
                target_versions=release["versions"],
                migration_files=release["migration_files"],
            )
            app = authority.clients["app"]

            def fresh():
                now = datetime.now(timezone.utc)
                approval = c.authorization(req)
                views = authority.current_epochs()
                if (
                    approval["operation"] != req["id"]
                    or approval["until"] <= now
                    or c.contest_frozen()
                    or any(views[r] != req[r + "_epoch"] for r in views)
                ):
                    raise RecoveryRequired("migration authority expired")
                return min(req["deadline"], approval["until"])

            def authorize(uid):
                c.call("bind-migration", operation=req["id"], uid=uid)
                authority.admit(req, "migrate")
                authority.refresh_permits(req, "app")

            def exited(uid):
                view = app.observation()
                return (
                    not any(v["workload"] == "migrate" for v in view["containers"])
                    and any(
                        v["workload"] == "migrate" and v.get("job_uid") == uid
                        for v in view["exited"]
                    )
                    and c.call("retired-job", operation=req["id"], uid=uid)["confirmed"]
                    is True
                )

            def run_job(attempt, passwords, renew):
                fresh()
                app.prepare_template("migrate", release["images"], True)
                job = MigrationJob(
                    JobEffects(req["id"]),
                    deliver,
                    authorize,
                    lambda: authority.close_workload(req, "migrate"),
                    lambda: app.call("get", "podtemplate/approved-migrate")["template"],
                    exited,
                    app.observation,
                )
                job(attempt, passwords, renew)

            with tempfile.TemporaryDirectory() as root:
                unpack_migrations(release, root)
                return reconcile(
                    op,
                    root,
                    run_job,
                    fresh,
                    erase_attempt=lambda attempt: deliver(attempt, None),
                )

    authority = Authority(c, catalog, migrate, slot, CONFIG)
    threading.Thread(target=authority.renew_loop, daemon=True).start()

    def handle(method, ticket, **params):
        op = c.approved_operation(ticket)
        if op["environment"] != slot:
            raise RecoveryRequired("wrong host target")
        if method == "admit" and params.get("name") == "migrate":
            raise RecoveryRequired(
                "only the local database coordinator can authorize the migration Job"
            )
        release = lambda: authority.release(op["release"])
        routes = {
            "release": release,
            "epochs": authority.current_epochs,
            "begin": lambda: authority.begin(op),
            "close": lambda name: authority.close_workload(op, name),
            "prior": authority.prior_submission,
            "stopped": authority.submission_stopped,
            "termination": lambda: authority.verify_termination_history(
                op, c.activation_state()
            ),
            "admit": lambda name: authority.admit(op, name),
            "revoke": lambda: authority.revoke(op),
            "refresh": lambda role: authority.refresh_permits(op, role),
            "observed": lambda role: authority.running_digests(op, role),
            "evidence": lambda: authority.observed_release(release()),
            "migrate": lambda: authority.migrate_or_verify(op, release()),
        }
        return routes[method](**params)

    methods = (
        "release",
        "epochs",
        "begin",
        "close",
        "prior",
        "stopped",
        "termination",
        "admit",
        "revoke",
        "refresh",
        "observed",
        "evidence",
        "migrate",
    )
    local_rpc.serve(
        ISSUER,
        "astra-poller",
        {m: (lambda method: lambda **kw: handle(method, **kw))(m) for m in methods},
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("role", choices=("poller", "activation"))
    role = parser.parse_args().role
    settings = json.loads((CONFIG / (role + ".json")).read_text())
    (run_poller if role == "poller" else run_issuer)(settings)
