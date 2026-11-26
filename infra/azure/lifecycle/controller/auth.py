"""Verify both Entra authority and the independent, immutable GitHub approval proof."""

from datetime import datetime, timezone
import json
import re

import jwt

from policy import canonical, digest
from state import Refused
from transport import request


class Auth:
    def __init__(self, policy, *, keys=None, github=None):
        self.policy = policy
        self.keys = keys
        tenant = policy["tenant"]
        if not re.fullmatch(r"[a-f0-9-]{36}", tenant):
            raise Refused("invalid tenant binding")
        self.issuers = [
            f"https://login.microsoftonline.com/{tenant}/v2.0",
            f"https://sts.windows.net/{tenant}/",
        ]
        self.jwks = {
            "entra": jwt.PyJWKClient(
                f"https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys",
                timeout=5,
            ),
            "github": jwt.PyJWKClient(
                "https://token.actions.githubusercontent.com/.well-known/jwks",
                timeout=5,
            ),
        }
        self.github = github or self.github_api

    def github_api(self, path):
        repository = self.policy["repository"]
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        # Public repository review metadata is readable without a credential.
        _, _, body = request(
            f"https://api.github.com/repos/{repository}/" + path, headers=headers
        )
        return json.loads(body)

    def decode(self, token, kind, issuer, audience):
        if not isinstance(token, str) or len(token) > 32768:
            raise Refused("invalid proof")
        try:
            key = (
                self.keys[kind]
                if self.keys is not None
                else self.jwks[kind].get_signing_key_from_jwt(token).key
            )
            return jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                issuer=issuer,
                audience=audience,
                leeway=15,
                options={"require": ["exp", "iat", "nbf", "iss", "aud", "sub"]},
            )
        except jwt.PyJWTError as exc:
            raise Refused("invalid or expired proof") from exc

    def entra(self, token):
        data = self.decode(
            token,
            "entra",
            self.issuers,
            [self.policy["audience"], self.policy["audience"].removeprefix("api://")],
        )
        client = data.get("azp") or data.get("appid")
        allowed = self.policy["clients"].get(client)
        if data.get("tid") != self.policy["tenant"] or not allowed:
            raise Refused("unrecognized Entra caller")
        if allowed["role"] == "member":
            if (
                allowed["scope"] not in data.get("scp", "").split()
                or data.get("oid") not in self.policy["members"]
            ):
                raise Refused("requester is not an authorized member")
        elif (
            data.get("scp")
            or data.get("oid") != allowed["object_id"]
            or allowed["application_role"] not in data.get("roles", [])
        ):
            raise Refused("wrong Entra application authority")
        return dict(role=allowed["role"], client=client, object_id=data["oid"])

    def approval(self, token, payload, caller):
        action = payload["operation"]
        role = (
            "lifecycle"
            if action in {"start", "extend", "cancel"}
            else ("eligibility" if action == "promotion-eligibility" else "deployment")
        )
        environment = {
            "lifecycle": "staging-lifecycle",
            "deployment": "staging-deployment",
            "eligibility": "promotion-eligibility",
        }[role]
        if caller["role"] != role or payload["environment"] != "s2":
            raise Refused("wrong action or target for this Entra role")
        audience = "api://astracode/request/" + digest(canonical(payload))[7:]
        proof = self.decode(
            token, "github", "https://token.actions.githubusercontent.com", audience
        )
        workflow = self.policy["workflows"][role]
        now = datetime.now(timezone.utc).timestamp()
        if (
            proof.get("repository_id") != str(self.policy["repository_id"])
            or proof.get("repository") != self.policy["repository"]
            or proof.get("ref") != "refs/heads/main"
            or proof.get("event_name") != "workflow_dispatch"
            or proof.get("environment") != environment
            or proof.get("sub") != self.policy["subjects"][environment]
            or proof.get("workflow_ref")
            != self.policy["repository"] + "/" + workflow["path"] + "@refs/heads/main"
            or proof.get("workflow_sha") not in workflow["revisions"]
            or proof.get("sha") != proof.get("workflow_sha")
            or str(proof.get("actor_id")) not in self.policy["dispatchers"]
            or proof.get("run_attempt") != "1"
            or not re.fullmatch("[0-9]+", str(proof.get("run_id", "")))
            or not -15 <= now - proof["iat"] <= 600
            or proof["exp"] - proof["iat"] > 600
        ):
            raise Refused("unregistered workflow context or stale run attempt")
        run = self.github("actions/runs/" + proof["run_id"])
        if (
            run["run_attempt"] != 1
            or run["head_sha"] != proof["workflow_sha"]
            or run["event"] != "workflow_dispatch"
            or run["path"] != workflow["path"]
            or run["status"] != "in_progress"
            or str(run["actor"]["id"]) != proof["actor_id"]
            or str(run["repository"]["id"]) != str(self.policy["repository_id"])
        ):
            raise Refused("proof does not match the live approved run")
        reviews = self.github("actions/runs/" + proof["run_id"] + "/approvals")
        relevant = [
            r
            for r in reviews
            if any(e["name"] == environment for e in r["environments"])
        ]
        reviewers = [
            str(r["user"]["id"])
            for r in relevant
            if r["state"] == "approved"
            and str(r["user"]["id"]) in self.policy["reviewers"][role]
            and str(r["user"]["id"]) != proof["actor_id"]
        ]
        if not reviewers or any(r["state"] != "approved" for r in relevant):
            raise Refused("independent native approval missing")
        return dict(
            caller,
            run=proof["run_id"],
            attempt="1",
            dispatcher=proof["actor_id"],
            reviewer=sorted(reviewers)[0],
            workflow=proof["workflow_sha"],
            requester=payload["requester"],
            request_digest=digest(canonical(payload)),
            environment=environment,
        )
