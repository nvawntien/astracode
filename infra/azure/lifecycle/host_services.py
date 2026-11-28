"""Platform entry points for the rollout user and the independent permit issuer."""

import argparse
import base64
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
from activation_client import ActivationClient
from activation_record import Journal
from coordinator import ForwardRequired, reconcile
from drain_work import finish as finish_drain, observe as observe_nodes
from edge_lease import serve as serve_edge
from kube_rollout import Cluster
from migration_job import MigrationJob
from node_state import RecoveryRequired
from release_catalog import Catalog, ReceiptCatalog, unpack_migrations

CONFIG = Path("/etc/astracode")
ISSUER = "/run/astra-activation/control.sock"
POLLER = "/run/astra-poller/effects.sock"
STATE = "/run/astra-activation/state.sock"
DELIVERY = "/run/astra-activation/delivery.sock"


def identity_token(client_id, audience):
    # The audience and client ID are platform configuration. The host endpoint
    # never accepts either value from a ticket or from the peer socket.
    client = str(uuid.UUID(client_id))
    query = urlencode(
        {
            "api-version": "2018-02-01",
            "client_id": client,
            "resource": audience,
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
            raise RecoveryRequired("managed identity token unavailable")
        raw = response.read(32769)
        if len(raw) > 32768:
            raise ValueError("invalid identity response")
        data = json.loads(raw)
        if data["resource"] != audience or data["token_type"].lower() != "bearer":
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


def run_poller(settings):
    lock = threading.Lock()
    current = {"ticket": None}
    jobs = Cluster("app", CONFIG / "rollout.kubeconfig")

    def check(ticket):
        if current["ticket"] != ticket:
            raise RecoveryRequired("wrong poll operation")
        c = ActivationClient(STATE)
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
                },
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
            {"job": job, "retire": retire},
        ),
        daemon=True,
    ).start()

    def client():
        return ActivationClient(STATE)

    def heartbeat():
        drained = None
        while True:
            try:
                c = client()
                status = c.call("observe")
                if (
                    status["phase"] == "draining"
                    and not status["in_flight"]
                    and drained != status["generation"]
                ):
                    finish_drain(c, settings, CONFIG / "rollout.kubeconfig", status)
                    drained = status["generation"]
            except Exception:
                # Lack of fresh observations closes the edge and process permits.
                # VM shutdown is scheduled independently on Azure.
                pass
            time.sleep(2)

    app_ip = (CONFIG / "bootstrap-network").read_text().split()[1]
    threading.Thread(target=serve_edge, args=(app_ip, client), daemon=True).start()
    threading.Thread(target=heartbeat, daemon=True).start()
    while True:
        try:
            c = ActivationClient(STATE)
            ticket = c.call("poll")["ticket"]
            if ticket:
                with lock:
                    current["ticket"] = str(uuid.UUID(ticket))
                    Rollout(c, RemoteAuthority(ticket), settings).run(ticket)
        except Exception:
            # Report only a fixed error in the host log. Never log a token, payload or fixture.
            print("Protected rollout waiting for verified state", flush=True)
        finally:
            current["ticket"] = None
        time.sleep(2)


def run_issuer(settings):
    c = ActivationClient(STATE + ".issuer")
    slot = (CONFIG / "slot").read_text().strip()
    executor = settings["executor_digest"]
    receipts = ReceiptCatalog(settings, slot, identity_token)
    catalog = Catalog(c, executor)
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

            def authorize(uid, job_uid):
                c.call("bind-migration", operation=req["id"], uid=uid, job=job_uid)
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
                try:
                    return reconcile(
                        op,
                        root,
                        run_job,
                        fresh,
                        erase_attempt=lambda attempt: deliver(attempt, None),
                    )
                except ForwardRequired as exc:
                    c.call(
                        "sealed-recovery", operation=req["id"], versions=exc.versions
                    )
                    raise

    authority = Authority(c, catalog, migrate, slot, CONFIG)
    journal = Journal(
        "/srv/astracode/data/activation",
        slot,
        dict(
            settings,
            daily_window=json.loads((CONFIG / "daily-window.json").read_text()),
        ),
        receipts,
        lambda: observe_nodes(authority.clients["app"], authority.clients["judge"]),
    )
    state_actions = (
        "poll",
        "tester",
        "operation",
        "state",
        "authorization",
        "contest",
        "verified",
        "termination",
        "begin",
        "close",
        "complete",
        "open",
        "recovery-required",
        "bundle",
        "migration",
        "bind-migration",
        "retired-job",
        "sealed-recovery",
        "drained",
    )
    state_routes = {
        action: (lambda action: lambda **params: journal.act(action, **params))(action)
        for action in state_actions
    }
    state_routes["observe"] = lambda: journal.observe_current(**journal.observe())

    # Only the rollout and issuer Unix users can access the state transitions.
    for suffix, peer in (("", "astra-poller"), (".issuer", "astra-activation")):
        threading.Thread(
            target=local_rpc.serve,
            args=(STATE + suffix, peer, state_routes),
            daemon=True,
        ).start()
    threading.Thread(
        target=local_rpc.serve,
        args=(
            DELIVERY,
            0,
            {
                "initialize": journal.initialize,
                "open": journal.open,
                "close": journal.close,
                "submit": journal.submit,
                "status": journal.status,
                "admit-testers": journal.admit_testers,
            },
        ),
        daemon=True,
    ).start()
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


def run_delivery(action, payload):
    import os

    if os.geteuid() != 0:
        raise RecoveryRequired("App platform operator required")
    if action not in {"initialize", "open", "close", "submit", "admit-testers"}:
        raise RecoveryRequired("unsupported guest command")
    result = local_rpc.call(DELIVERY, action, payload, timeout=55)
    if action != "submit":
        return result
    ticket = result
    deadline = time.monotonic() + 635
    while time.monotonic() < deadline:
        result = local_rpc.call(DELIVERY, "status", ticket)
        if result:
            return result
        time.sleep(2)
    raise RecoveryRequired("no successful protected rollout result")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("role", choices=("poller", "activation", "delivery"))
    parser.add_argument("command", nargs="?")
    parser.add_argument("payload", nargs="?", default="e30=")
    args = parser.parse_args()
    if args.role == "delivery":
        try:
            data = json.loads(base64.b64decode(args.payload, validate=True))
            print(
                "ASTRA_DELIVERY="
                + json.dumps(run_delivery(args.command, data), separators=(",", ":"))
            )
        except (ValueError, RuntimeError, OSError, KeyError):
            parser.exit(1, "Protected App guest command refused or requires recovery\n")
    else:
        settings = json.loads((CONFIG / (args.role + ".json")).read_text())
        (run_poller if args.role == "poller" else run_issuer)(settings)
