"""Pure release checks shared by the publisher, reconciler and eligibility reader."""

import base64
import hashlib
import json
import re

SHA = re.compile(r"[a-f0-9]{40}")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")
ARTIFACT = "application/vnd.astracode.release.v1+json"
APPLICATIONS = {
    "website",
    "auth-service",
    "problem-service",
    "submission-service",
    "judge-worker",
    "go-judge",
}
WORKLOADS = APPLICATIONS | {
    "envoy",
    "postgres",
    "redis",
    "kafka",
    "kafka-init",
    "minio",
    "migrate",
}
OWNERS = {"auth", "problem", "submission"}
CHECKS = {
    "go",
    "postgres-integration",
    "frontend",
    "edge",
    "compose",
    "deployment-scripts",
    "judge-benchmark",
    "images",
    "openspec",
}


class Refused(ValueError):
    pass


def canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode()


def digest(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def provenance(sha, prs, history):
    if not SHA.fullmatch(sha) or sha not in history:
        raise Refused("revision is outside the protected develop history")
    matches = [
        p
        for p in prs
        if p.get("merged_at")
        and p.get("merge_commit_sha") == sha
        and p["base"]["ref"] == "develop"
    ]
    if len(matches) != 1:
        raise Refused("revision has no unique merged pull request")
    return {"pull_request": matches[0]["number"], "base": "develop", "source": sha}


def evidence(value, sha, run, attempt):
    if (
        value.get("source") != sha
        or value.get("run") != str(run)
        or value.get("attempt") != str(attempt)
        or set(value.get("checks", {})) != CHECKS
        or set(value["checks"].values()) != {"success"}
    ):
        raise Refused("missing or failed exact-revision checks")
    repository = value.get("repository", "")
    if (
        not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository)
        or not str(run).isdigit()
        or not str(attempt).isdigit()
        or value.get("run_url")
        != f"https://github.com/{repository}/actions/runs/{run}/attempts/{attempt}"
    ):
        raise Refused("linked CI run evidence required")
    return value


def publication_context(event, ref, kind):
    allowed = {
        "canonical": {
            ("push", "refs/heads/develop"),
            ("schedule", "refs/heads/main"),
            ("workflow_dispatch", "refs/heads/main"),
        },
        "rehearsal": {("workflow_dispatch", "refs/heads/main")},
    }
    if (event, ref) not in allowed.get(kind, set()):
        raise Refused("unapproved publication entry point")


def validate_payload(payload):
    if payload.get("kind") not in {"canonical", "rehearsal"} or not SHA.fullmatch(
        payload.get("source", "")
    ):
        raise Refused("invalid release identity")
    if set(payload.get("images", {})) != WORKLOADS or not all(
        re.fullmatch(
            r"ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}|[a-z0-9.-]+/[a-z0-9._/-]+@sha256:[a-f0-9]{64}",
            p,
        )
        for p in payload["images"].values()
    ):
        raise Refused("incomplete image digest set")
    if set(payload.get("versions", {})) != OWNERS or any(
        type(v) is not int or v < 1 for v in payload["versions"].values()
    ):
        raise Refused("incomplete schema version set")
    ci = payload["ci"]
    evidence(ci, payload["source"], ci["run"], ci["attempt"])
    if (
        payload["kind"] == "canonical"
        and payload["merge"]["source"] != payload["source"]
    ):
        raise Refused("merge evidence differs")
    if payload.get("configuration_revision") != payload["source"] or not payload.get(
        "environments"
    ):
        raise Refused("missing configuration inputs")
    if set(payload["environments"]) != {"s2", "s3"}:
        raise Refused("both environment overlays required")
    configured = {
        "auth-service",
        "problem-service",
        "submission-service",
        "judge-worker",
        "envoy",
    }
    for config in payload["environments"].values():
        if (
            set(config["workloads"]) != APPLICATIONS | {"envoy", "migrate"}
            or digest(canonical(config["workloads"])) != config["digest"]
            or set(config["files"]) != configured
            or set(config["configmaps"]) != configured
        ):
            raise Refused("incomplete environment configuration")
        for name, value in config["workloads"].items():
            files = config["files"].get(name, {})
            if value != digest(
                canonical(
                    {
                        k: hashlib.sha256(v.encode()).hexdigest()
                        for k, v in files.items()
                    }
                )
            ):
                raise Refused("configuration bytes differ")
            if name in configured and not re.fullmatch(
                re.escape(name + "-config-") + "[a-z0-9]{10}",
                config["configmaps"][name],
            ):
                raise Refused("unexpected configuration destination")
    files = payload["migration_package"]
    expected = set(payload["migration_files"])
    for owner, version in payload["versions"].items():
        expected.add(owner + ".version")
        expected.update(f"{owner}.{i}.catalog" for i in range(version + 1))
        names = sorted(
            n for n in payload["migration_files"] if n.startswith(owner + "/")
        )
        if len(names) != version or any(
            not re.fullmatch(f"{owner}/{i:05d}_[a-z0-9_]+[.]sql", n)
            for i, n in enumerate(names, 1)
        ):
            raise Refused("incomplete migration sequence")
        if (
            base64.b64decode(files[owner + ".version"], validate=True).strip()
            != str(version).encode()
        ):
            raise Refused("packaged version differs")
    if set(files) != expected:
        raise Refused("unexpected migration inventory")
    for name, sha in payload["migration_files"].items():
        if digest(base64.b64decode(files[name], validate=True)) != "sha256:" + sha:
            raise Refused("migration hash differs")
    return payload


def envelope(payload):
    raw = canonical(validate_payload(payload))
    empty = b"{}"
    manifest = canonical(
        dict(
            schemaVersion=2,
            mediaType="application/vnd.oci.image.manifest.v1+json",
            artifactType=ARTIFACT,
            config=dict(
                mediaType="application/vnd.oci.empty.v1+json",
                digest=digest(empty),
                size=2,
            ),
            layers=[dict(mediaType=ARTIFACT, digest=digest(raw), size=len(raw))],
        )
    )
    return dict(
        origin=payload["kind"],
        source=payload["source"],
        bundle=digest(manifest),
        manifest=base64.b64encode(manifest).decode(),
        payload=base64.b64encode(raw).decode(),
    )


def verify_record(record, source=None):
    manifest = base64.b64decode(record["manifest"], validate=True)
    raw = base64.b64decode(record["payload"], validate=True)
    payload = validate_payload(json.loads(raw))
    if (
        record != envelope(payload)
        or manifest != canonical(json.loads(manifest))
        or (source is not None and payload["source"] != source)
    ):
        raise Refused("receipt or bundle differs")
    return payload


def publish_once(store, record):
    payload = verify_record(record)
    if payload["kind"] != "canonical":
        raise Refused("rehearsal cannot enter the canonical catalog")
    key = payload["source"] + ".json"
    if not store.create(key, canonical(record)):
        accepted = json.loads(store.read(key))
        verify_record(accepted, payload["source"])
        if accepted != record:
            raise Refused("first receipt already binds different content")
    return record


def eligible(record, staged, approval, frozen):
    payload = verify_record(record)
    if (
        payload["kind"] != "canonical"
        or frozen
        or approval.get("approved") is not True
        or approval.get("bundle") != record["bundle"]
        or not approval.get("reviewer")
        or staged.get("environment") != "s2"
        or staged.get("bundle") != record["bundle"]
        or staged.get("images") != payload["images"]
        or staged.get("versions") != payload["versions"]
        or staged.get("configuration") != payload["environments"]["s2"]["digest"]
        or staged.get("smoke") != "passed"
        or not staged.get("operation")
    ):
        raise Refused(
            "canonical S2 evidence and matching approval required outside freeze"
        )
    return {
        "eligible": True,
        "bundle": record["bundle"],
        "source": payload["source"],
        "deploy": False,
    }


def mapped_release(tag, mapping, revision):
    if (
        not SHA.fullmatch(revision)
        or mapping.get("schemaVersion") != 1
        or not re.fullmatch(r"v[0-9]+[.][0-9]+[.][0-9]+(?:[.-][0-9A-Za-z.-]+)?", tag)
    ):
        raise Refused("reviewed semantic tag mapping required")
    selected = mapping.get("tags", {}).get(tag, "")
    if not DIGEST.fullmatch(selected):
        raise Refused("tag has no reviewed canonical bundle mapping")
    return selected


REQUIRED = {
    *(
        f"Go checks ({m})"
        for m in (
            "pkg",
            "services/auth",
            "services/problem",
            "services/submission",
            "workers/judge",
        )
    ),
    *(
        f"Build image ({i})"
        for i in (
            "website",
            "auth-service",
            "problem-service",
            "submission-service",
            "judge-worker",
            "sandbox",
        )
    ),
    "PostgreSQL integration suites",
    "Frontend checks",
    "Envoy routing and authentication",
    "Compose configuration",
    "Deployment script checks",
    "Judge benchmark harness",
    "openspec validate",
    "Record exact release verification",
}


def rehearsal_evidence(run, jobs, sha, repository):
    if (
        not SHA.fullmatch(sha)
        or run["head_sha"] != sha
        or run["event"] != "pull_request"
        or run["path"] != ".github/workflows/rehearsal-checks.yml"
        or run["conclusion"] != "success"
        or run["repository"]["full_name"] != repository
    ):
        raise Refused("passing exact-head rehearsal checks required")
    for name in REQUIRED:
        matching = [
            j for j in jobs if j["name"] == name or j["name"].endswith(" / " + name)
        ]
        if len(matching) != 1 or matching[0]["conclusion"] != "success":
            raise Refused("missing required rehearsal check: " + name)
    return dict(
        source=sha,
        run=str(run["id"]),
        attempt=str(run["run_attempt"]),
        repository=repository,
        run_url=run["html_url"] + "/attempts/" + str(run["run_attempt"]),
        checks=dict.fromkeys(CHECKS, "success"),
    )
