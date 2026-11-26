"""The HTTPS handler and independent timer share only the conditional Blob record."""

from functools import lru_cache
import json
import logging
import os

import azure.functions as func
from azure.identity import ManagedIdentityCredential

from auth import Auth
from azure_adapters import BlobStore, Power, Releases
from node_state import RecoveryRequired
from policy import Refused as ReleaseRefused
from service import Conflict, Service
from state import Refused

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)


@lru_cache
def service():
    policy = json.loads(os.environ["ASTRA_CONTROLLER_POLICY"])
    policy.update(
        environment=os.environ["ASTRA_ENVIRONMENT"].lower(),
        targets=json.loads(os.environ["ASTRA_TARGET_VM_IDS"]),
        tenant=os.environ["ASTRA_TENANT_ID"],
        audience=os.environ["ASTRA_CONTROLLER_AUDIENCE"],
    )
    policy["clients"][os.environ["ASTRA_POLLER_CLIENT_ID"]] = dict(
        role="app",
        object_id=os.environ["ASTRA_POLLER_OBJECT_ID"],
        application_role="App.Poll",
    )
    identity = ManagedIdentityCredential(
        client_id=os.environ["AzureWebJobsStorage__clientId"]
    )
    endpoint = os.environ["ASTRA_CONTROLLER_BLOB_ENDPOINT"]
    power = Power(
        policy["targets"],
        lambda: identity.get_token("https://management.azure.com/.default").token,
        allow_start=policy["environment"] == "s2",
    )
    store = BlobStore(
        endpoint,
        os.environ["ASTRA_CONTROLLER_STATE_CONTAINER"],
        "session-v1.json",
        identity,
    )
    return Service(
        policy, store, Auth(policy), Releases(policy, identity, endpoint), power
    )


def response(value, status=200):
    return func.HttpResponse(
        json.dumps(value, separators=(",", ":")),
        status_code=status,
        mimetype="application/json",
        headers={"Cache-Control": "no-store"},
    )


@app.route(route="v1/{action}/{subaction?}", methods=["POST"])
def api(req: func.HttpRequest):
    try:
        token = req.headers.get("Authorization", "")
        if not token.startswith("Bearer "):
            return response({"error": "authentication required"}, 401)
        controller = service()
        caller = controller.auth.entra(token[7:])
        body = req.get_body()
        if len(body) > 256 * 1024:
            raise Refused("request too large")
        data = json.loads(body)
        action = req.route_params["action"]
        if action == "app":
            return response(controller.app(caller, req.route_params["subaction"], data))
        if req.route_params.get("subaction"):
            raise Refused("unknown controller endpoint")
        if action == "draft":
            return response(controller.draft(caller, data))
        if action in {"approve", "eligibility"}:
            if (action == "eligibility") != (
                data["operation"] == "promotion-eligibility"
            ):
                raise Refused("wrong approval endpoint")
            return response(
                controller.approved(
                    caller, req.headers.get("X-GitHub-Approval-Proof"), data
                )
            )
        if action == "status" and not data:
            return response(controller.status(caller))
        raise Refused("unknown controller action")
    except (Refused, ReleaseRefused, RecoveryRequired, ValueError, KeyError, TypeError):
        return response({"error": "operation refused"}, 403)
    except Conflict:
        return response({"error": "retry conditional operation"}, 409)
    except Exception:
        logging.error("astra controller request failed")
        return response({"error": "controller unavailable"}, 503)


@app.timer_trigger(
    schedule="0 * * * * *", arg_name="timer", run_on_startup=False, use_monitor=True
)
def expiry(timer: func.TimerRequest):
    try:
        outcome = service().reconcile()
    except Exception:
        logging.error("astra controller reconciliation failed")
        return
    if outcome["heartbeat"]:
        logging.info("reconciliation_succeeded")
    if outcome["overdue"]:
        logging.error("astra-controller-cleanup-overdue")
    if outcome["inventory"]:
        logging.warning("astra-controller-s3-inventory-followup")
    if outcome["off_violation"]:
        logging.warning("astra-controller-daily-off-time-unconfirmed")
