"""Fixed Azure targets and conditional state writes. No effects run at import time."""

import json
import re
from urllib.parse import urlsplit

from azure.core import MatchConditions
from azure.core.exceptions import (
    ResourceExistsError,
    ResourceModifiedError,
    ResourceNotFoundError,
)
from azure.storage.blob import BlobClient

from policy import DIGEST, SHA, canonical, verify_record
from state import Refused
from transport import request

ARM = "https://management.azure.com"
COMPUTE_API = "2024-11-01"
VM_ID = re.compile(
    r"/subscriptions/[a-f0-9-]{36}/resourceGroups/[A-Za-z0-9._-]+/providers/Microsoft[.]Compute/virtualMachines/[A-Za-z0-9._-]+",
    re.I,
)


class BlobStore:
    def __init__(self, endpoint, container, name, identity):
        host = urlsplit(endpoint)
        if (
            host.scheme != "https"
            or not re.fullmatch(
                r"[a-z0-9]{3,24}[.]blob[.]core[.]windows[.]net", host.netloc
            )
            or host.path not in {"", "/"}
            or host.query
            or host.fragment
        ):
            raise Refused("unexpected protected Blob endpoint")
        self.client = BlobClient(
            endpoint, container, name, credential=identity, retry_total=1
        )

    def read(self):
        try:
            response = self.client.download_blob(max_concurrency=1, timeout=10)
        except ResourceNotFoundError:
            return None, None
        if response.size > 8 * 1024 * 1024:
            raise Refused("durable object exceeds its bound")
        return json.loads(response.readall()), response.properties.etag

    def write(self, state, revision):
        body = canonical(state)
        if len(body) > 8 * 1024 * 1024:
            raise Refused("controller state exceeded its configured size")
        options = (
            {}
            if revision is None
            else dict(etag=revision, match_condition=MatchConditions.IfNotModified)
        )
        try:
            self.client.upload_blob(
                body, overwrite=revision is not None, timeout=10, **options
            )
            return True
        except (ResourceModifiedError, ResourceExistsError):
            return False


class Releases:
    def __init__(self, policy, identity, state_endpoint):
        self.policy, self.identity, self.state_endpoint = (
            policy,
            identity,
            state_endpoint,
        )
        self.cache = {}

    def __call__(self, bundle):
        if not DIGEST.fullmatch(bundle):
            raise Refused("invalid release digest")
        if bundle in self.cache:
            return self.cache[bundle]
        if self.policy["environment"] == "s2":
            source = self.policy["canonical_sources"].get(bundle, "")
            if not SHA.fullmatch(source):
                raise Refused("bundle has no registered canonical receipt")
            store = BlobStore(
                self.policy["receipt_endpoint"],
                "canonical-releases",
                source + ".json",
                self.identity,
            )
        else:
            if self.policy["experiment"]["release"] != bundle:
                raise Refused("not the reviewed S3 bundle")
            source = self.policy["experiment"]["source"]
            store = BlobStore(
                self.state_endpoint,
                "controller-state",
                "rehearsal-" + bundle[7:] + ".json",
                self.identity,
            )
        record, _ = store.read()
        if not record or record["bundle"] != bundle:
            raise Refused("receipt does not identify the requested bundle")
        verify_record(record, source)
        if len(self.cache) >= 16:
            self.cache.clear()
        self.cache[bundle] = record
        return record


class Power:
    def __init__(self, targets, token, *, allow_start):
        if (
            set(targets) != {"app", "judge"}
            or len(set(v.lower() for v in targets.values())) != 2
            or any(not VM_ID.fullmatch(value) for value in targets.values())
            or len(
                {value.lower().split("/providers/")[0] for value in targets.values()}
            )
            != 1
        ):
            raise Refused("exact App/Judge power target pair required")
        self.targets, self.token, self.allow_start = targets, token, allow_start

    def call(self, url, method="GET", expected=(200,), extra=None):
        value = urlsplit(url)
        if (
            value.scheme != "https"
            or value.netloc != "management.azure.com"
            or value.fragment
        ):
            raise Refused("unexpected ARM operation endpoint")
        headers = {"Authorization": "Bearer " + self.token()}
        headers.update(extra or {})
        return request(
            url, method, b"" if method == "POST" else None, headers, expected
        )

    def observe(self):
        views = {}
        for role, target in self.targets.items():
            try:
                code, _, raw = self.call(
                    f"{ARM}{target}/instanceView?api-version={COMPUTE_API}",
                    expected=(200, 404),
                )
                if code == 404:
                    views[role] = "not-found"
                    continue
                states = [
                    s["code"].split("/", 1)[1]
                    for s in json.loads(raw)["statuses"]
                    if s["code"].startswith("PowerState/")
                ]
                views[role] = states[0] if len(states) == 1 else "unknown"
            except (OSError, ValueError, KeyError):
                views[role] = "unknown"
        return views

    def send(self, role, action, request_id):
        if action != "deallocate" and (action != "start" or not self.allow_start):
            raise Refused("power action forbidden")
        code, headers, _ = self.call(
            f"{ARM}{self.targets[role]}/{action}?api-version={COMPUTE_API}",
            "POST",
            (200, 202, 204),
            {"x-ms-client-request-id": request_id},
        )
        if code != 202:
            return None
        url = headers.get("Azure-AsyncOperation") or headers.get("Location")
        if not url:
            raise Refused("provider omitted ongoing operation identity")
        if url.startswith("/"):
            url = ARM + url
        self.validate_operation(url)
        return url

    def validate_operation(self, url):
        target = urlsplit(url)
        subscription = next(iter(self.targets.values())).split("/")[2].lower()
        if (
            target.scheme != "https"
            or target.netloc != "management.azure.com"
            or not target.path.lower().startswith(
                "/subscriptions/" + subscription + "/providers/microsoft.compute/"
            )
        ):
            raise Refused("unbound Azure operation endpoint")

    def outcome(self, url):
        self.validate_operation(url)
        try:
            code, _, raw = self.call(url, expected=(200, 201, 202, 204, 404))
            if code == 204:
                return "Succeeded"
            if code == 404:
                return "Unknown"
            return json.loads(raw).get("status", "InProgress") if raw else "InProgress"
        except (OSError, ValueError, KeyError):
            return "Unknown"
