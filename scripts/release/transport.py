"""Bounded HTTPS adapters. No shared storage keys or deployment authority."""

import base64
from datetime import datetime, timezone
import json
import re
import subprocess
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

from policy import Refused, digest


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Refused("unexpected authenticated HTTP redirect")


def request(url, method="GET", body=None, headers=None, expected=(200,)):
    if urlsplit(url).scheme != "https":
        raise Refused("HTTPS required")
    try:
        response = build_opener(NoRedirect).open(
            Request(url, data=body, headers=headers or {}, method=method), timeout=20
        )
    except HTTPError as error:
        response = error
    with response:
        if response.code not in expected:
            raise Refused("remote request refused: HTTP " + str(response.code))
        data = response.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            raise Refused("oversize response")
        return response.code, response.headers, data


class Blob:
    def __init__(self, account, container, token):
        if (
            not re.fullmatch("[a-z0-9]{3,24}", account)
            or container != "canonical-releases"
        ):
            raise Refused("unexpected release-records target")
        self.base = f"https://{account}.blob.core.windows.net/{container}/"
        self.token = token

    def call(self, key, method, body=None, extra=None, expected=(200,)):
        if not re.fullmatch("[a-f0-9]{40}[.]json", key):
            raise Refused("invalid receipt key")
        headers = {
            "Authorization": "Bearer " + self.token(),
            "x-ms-version": "2023-11-03",
            "x-ms-date": datetime.now(timezone.utc).strftime(
                "%a, %d %b %Y %H:%M:%S GMT"
            ),
        }
        headers.update(extra or {})
        return request(self.base + key, method, body, headers, expected)

    def read(self, key):
        code, _, raw = self.call(key, "GET", expected=(200, 404))
        return raw if code == 200 else None

    def create(self, key, body):
        code, _, _ = self.call(
            key,
            "PUT",
            body,
            {
                "If-None-Match": "*",
                "x-ms-blob-type": "BlockBlob",
                "Content-Type": "application/json",
            },
            (201, 409, 412),
        )
        return code == 201


def azure_token(resource="https://storage.azure.com/"):
    return subprocess.check_output(
        [
            "az",
            "account",
            "get-access-token",
            "--resource",
            resource,
            "--query",
            "accessToken",
            "-o",
            "tsv",
        ],
        stderr=subprocess.DEVNULL,
        text=True,
    ).strip()


class Registry:
    def __init__(self, repository, user, credential):
        if not re.fullmatch(r"[a-z0-9._-]+/[a-z0-9._/-]+", repository):
            raise Refused("unexpected OCI repository")
        self.repository = repository
        self.user, self.credential = user, credential
        self.base = "https://ghcr.io/v2/" + repository
        auth = base64.b64encode((user + ":" + credential).encode()).decode()
        _, _, raw = request(
            "https://ghcr.io/token?"
            + urlencode(
                dict(service="ghcr.io", scope="repository:" + repository + ":pull,push")
            ),
            headers={"Authorization": "Basic " + auth},
        )
        self.headers = {"Authorization": "Bearer " + json.loads(raw)["token"]}

    def blob(self, raw):
        sha = digest(raw)
        code, _, _ = request(
            self.base + "/blobs/" + sha,
            "HEAD",
            headers=self.headers,
            expected=(200, 404),
        )
        if code == 404:
            _, headers, _ = request(
                self.base + "/blobs/uploads/", "POST", b"", self.headers, (202,)
            )
            location = headers["Location"]
            if location.startswith("/"):
                location = "https://ghcr.io" + location
            if not location.startswith(self.base + "/blobs/uploads/"):
                raise Refused("unexpected upload destination")
            location += ("&" if "?" in location else "?") + urlencode(dict(digest=sha))
            request(
                location,
                "PUT",
                raw,
                dict(self.headers, **{"Content-Type": "application/octet-stream"}),
                (201,),
            )

    def publish(self, record):
        raw = base64.b64decode(record["payload"], validate=True)
        manifest = base64.b64decode(record["manifest"], validate=True)
        self.blob(b"{}")
        self.blob(raw)
        request(
            self.base + "/manifests/" + record["bundle"],
            "PUT",
            manifest,
            dict(
                self.headers,
                **{"Content-Type": "application/vnd.oci.image.manifest.v1+json"},
            ),
            (201,),
        )
        self.verify(record)

    def verify(self, record):
        _, _, raw = request(
            self.base + "/manifests/" + record["bundle"],
            headers=dict(
                self.headers, Accept="application/vnd.oci.image.manifest.v1+json"
            ),
        )
        if digest(raw) != record["bundle"] or raw != base64.b64decode(
            record["manifest"], validate=True
        ):
            raise Refused("published OCI manifest differs")
        payload = base64.b64decode(record["payload"], validate=True)
        for body in (b"{}", payload):
            code, headers, actual = request(
                self.base + "/blobs/" + digest(body),
                headers=self.headers,
                expected=(200, 307),
            )
            if code == 307:
                location = headers["Location"]
                host = urlsplit(location).hostname or ""
                if not (
                    host.endswith(".githubusercontent.com")
                    or host.endswith(".blob.core.windows.net")
                ):
                    raise Refused("unexpected public artifact download destination")
                # Registry redirects carry a short-lived download signature.
                # Never forward the registry credential to the storage host.
                _, _, actual = request(location)
            if actual != body:
                raise Refused("published release blob differs")
        for reference in set(json.loads(payload)["images"].values()):
            name, expected = reference.rsplit("@", 1)
            if name.startswith("ghcr.io/"):
                image = Registry(name[len("ghcr.io/") :], self.user, self.credential)
                _, _, actual = request(
                    image.base + "/manifests/" + expected,
                    headers=dict(
                        image.headers,
                        Accept="application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
                    ),
                )
            else:
                actual = subprocess.check_output(
                    ["docker", "buildx", "imagetools", "inspect", "--raw", reference],
                    timeout=30,
                )
            if digest(actual) != expected and digest(actual.rstrip(b"\n")) != expected:
                raise Refused("release image descriptor unavailable or changed")
