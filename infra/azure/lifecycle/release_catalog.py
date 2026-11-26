"""Read digest-bound OCI release metadata returned by the protected controller."""

import base64
import hashlib
import json
from pathlib import Path
import re

from configuration import content_digest
from kube_rollout import APP, EXECUTION
from node_state import RecoveryRequired
from permits import DIGEST

OWNERS = ("auth", "problem", "submission")
WORKLOADS = (
    set(APP)
    | set(EXECUTION)
    | {"postgres", "redis", "kafka", "kafka-init", "minio", "migrate"}
)
ARTIFACT = "application/vnd.astracode.release.v1+json"


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


class Catalog:
    def __init__(self, controller, approved_executor):
        self.control = controller
        if not DIGEST.fullmatch(approved_executor):
            raise ValueError("platform executor digest required")
        self.approved_executor = approved_executor
        self.cache = {}

    def verified_bundle(self, requested, slot):
        if slot not in {"s2", "s3"} or not DIGEST.fullmatch(requested):
            raise RecoveryRequired("invalid release target")
        # A release ID is resolved only by the controller within the approved
        # operation. Independent hash checks bind the decoded bytes to that ID.
        key = (self.control.operation, requested, slot)
        if key in self.cache:
            return self.cache[key]
        record = self.control.call(
            "bundle", operation=self.control.operation, digest=requested
        )
        manifest = base64.b64decode(record["manifest"], validate=True)
        document = base64.b64decode(record["payload"], validate=True)
        if digest(manifest) != requested:
            raise RecoveryRequired("release manifest digest differs")
        oci = json.loads(manifest)
        if (
            oci["schemaVersion"] != 2
            or oci.get("artifactType") != ARTIFACT
            or len(oci["layers"]) != 1
            or oci["layers"][0]
            != {
                "digest": digest(document),
                "size": len(document),
                "mediaType": ARTIFACT,
            }
        ):
            raise RecoveryRequired("invalid OCI release descriptor")
        payload = json.loads(document)
        expected = {"s2": "canonical", "s3": "rehearsal"}[slot]
        if (
            payload["kind"] != expected
            or record["origin"] != expected
            or set(payload["images"]) != WORKLOADS
            or payload["images"]["go-judge"].partition("@")[2] != self.approved_executor
            or not re.fullmatch("[a-f0-9]{40}", payload["source"])
            or set(payload["versions"]) != set(OWNERS)
            or any(type(v) is not int or v < 1 for v in payload["versions"].values())
            or not all(
                re.fullmatch(r"[a-z0-9.-]+/[a-z0-9./_-]+@sha256:[a-f0-9]{64}", p)
                for p in payload["images"].values()
            )
        ):
            raise RecoveryRequired("incomplete or ineligible release")
        config = payload["environments"][slot]
        if (
            set(config["workloads"]) != set(APP) | set(EXECUTION) | {"migrate"}
            or not all(DIGEST.fullmatch(v) for v in config["workloads"].values())
            or content_digest(config["workloads"]) != config["digest"]
        ):
            raise RecoveryRequired("missing environment configuration digest")
        release = dict(payload, digest=requested, config_digest=config["digest"])
        self.cache[key] = release
        return release


def unpack_migrations(release, root):
    # The release payload carries the exact migration image's packaged files.
    # Only the known layout can be materialized, with no archive extraction.
    root = Path(root)
    files = release["migration_package"]
    expected = set(release["migration_files"])
    for owner, version in release["versions"].items():
        expected.add(owner + ".version")
        expected.update(f"{owner}.{i}.catalog" for i in range(version + 1))
        (root / owner).mkdir()
    if set(files) != expected:
        raise RecoveryRequired("migration package inventory differs")
    for name, value in files.items():
        if not re.fullmatch(
            r"(auth|submission|problem)(/[0-9]{5}_[a-z0-9_]+\.sql|\.version|\.[0-9]+\.catalog)",
            name,
        ):
            raise RecoveryRequired("unrecognized migration package path")
        (root / name).write_bytes(base64.b64decode(value, validate=True))
