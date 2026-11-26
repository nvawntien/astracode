"""Obtain a run-bound proof after native Environment approval; never persist tokens."""

import json
import os
from urllib.parse import urlencode, urlsplit

from policy import Refused, canonical, digest
from transport import azure_token, request


def proof(payload, environment):
    if (
        os.environ["GITHUB_REF"] != "refs/heads/main"
        or os.environ["GITHUB_EVENT_NAME"] != "workflow_dispatch"
        or os.environ["GITHUB_RUN_ATTEMPT"] != "1"
    ):
        raise Refused("fresh protected main dispatch required")
    run = os.environ["GITHUB_RUN_ID"]
    repository = os.environ["GITHUB_REPOSITORY"]
    _, _, raw = request(
        f"https://api.github.com/repos/{repository}/actions/runs/{run}/approvals",
        headers={
            "Authorization": "Bearer " + os.environ["GH_TOKEN"],
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    accepted = {int(i) for i in json.loads(os.environ["APPROVER_IDS"])}
    reviews = [
        r
        for r in json.loads(raw)
        if any(e["name"] == environment for e in r["environments"])
    ]
    if (
        not reviews
        or any(r["state"] != "approved" for r in reviews)
        or not any(
            r["user"]["id"] in accepted
            and str(r["user"]["id"]) != os.environ["GITHUB_ACTOR_ID"]
            for r in reviews
        )
    ):
        raise Refused("independent designated review is missing")
    audience = "api://astracode/request/" + digest(canonical(payload))[7:]
    url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
    host = urlsplit(url).hostname or ""
    if (
        not host.endswith(".actions.githubusercontent.com")
        or urlsplit(url).scheme != "https"
    ):
        raise Refused("unexpected GitHub proof endpoint")
    url += ("&" if "?" in url else "?") + urlencode(dict(audience=audience))
    _, _, raw = request(
        url,
        headers={
            "Authorization": "Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]
        },
    )
    return json.loads(raw)["value"]


def submit(payload, environment, route):
    endpoint = os.environ["CONTROLLER_ENDPOINT"].rstrip("/")
    if (
        urlsplit(endpoint).scheme != "https"
        or urlsplit(endpoint).query
        or urlsplit(endpoint).fragment
    ):
        raise Refused("unexpected controller endpoint")
    github_proof = proof(payload, environment)
    access = azure_token(os.environ["CONTROLLER_AUDIENCE"])
    _, _, raw = request(
        endpoint + route,
        "POST",
        canonical(payload),
        {
            "Authorization": "Bearer " + access,
            "X-GitHub-Approval-Proof": github_proof,
            "Content-Type": "application/json",
        },
        (200, 202),
    )
    return json.loads(raw)
