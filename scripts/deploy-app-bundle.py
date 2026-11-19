#!/usr/bin/env python3
"""Activate or roll back an App image tag AND its non-secret configuration bundle.

Node-owned external files are never restored or modified by this controller.
Rollback refuses changed external inputs; credential rotations require an explicit
operator decision, not an automatic resurrection of an old signing key.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile

APP = Path(os.environ.get("ASTRACODE_APP_DIR", "/opt/astracode")).resolve()
STATE = Path(os.environ.get("ASTRACODE_APP_STATE_DIR", str(APP / ".deploy/app"))).resolve()
STACK = Path(os.environ.get("ASTRACODE_STACK_ENV", "/etc/astracode/stack.env")).resolve()
OVERRIDE = Path(os.environ.get("ASTRACODE_APP_OVERRIDE", "/etc/astracode/app-node.override.yml")).resolve()
FILES = ("docker-compose.yml", "docker-compose.prod.yml", "envoy/envoy.prod.yaml", "envoy/edge.lua",
         "gateway/krakend.tmpl", "gateway/templates", "gateway/settings", "infra/kafka/kafka-init.sh",
         "infra/postgres/init.sql", "services/auth/config", "services/problem/config", "services/submission/config",
         "scripts/deploy-app-node.sh", "scripts/envoy-runtime.sh", "scripts/deploy-app-bundle.py")
PINNED = "envoyproxy/envoy:v1.34.2"


def tag(value):
    if not re.fullmatch(r"v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?", value):
        raise RuntimeError("Invalid semantic image tag")
    return value


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def digest(path):
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except PermissionError:
        # Read-only, networkless helper supports existing root-owned 0600 files.
        value = subprocess.check_output(["docker", "run", "--rm", "--network", "none", "--user", "0:0",
            "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--entrypoint", "sha256sum",
            "-v", f"{path}:/input:ro", PINNED, "/input"], text=True)
        return value.split()[0]


def external_inputs():
    # Source the existing node-owned shell env just as deploy-app-node.sh does.
    # Only PATH REFERENCES are returned, never their secret values.
    names = ("GATEWAY_JWK_FILE", "SERVICE_ENV_FILE", "POSTGRES_ENV_FILE", "REDIS_ENV_FILE")
    code = 'set -a; source "$1"; for name in GATEWAY_JWK_FILE SERVICE_ENV_FILE POSTGRES_ENV_FILE REDIS_ENV_FILE; do printf "%s\\0" "${!name:-}"; done'
    values = subprocess.check_output(["bash", "-ec", code, "bash", str(STACK)]).decode().split("\0")
    paths = [STACK, OVERRIDE]
    for name, value in zip(names, values):
        if value:
            path = Path(value)
            if not path.is_absolute():
                raise RuntimeError(f"{name} must use an absolute node-owned path")
            paths.append(path)
    return {str(path): digest(path) for path in paths}


def allowed(name):
    return name in FILES or any(name.startswith(prefix + "/") for prefix in FILES)


def inspect_archive(path):
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        seen = set()
        for member in members:
            name = member.name.rstrip("/")
            if (name in seen or Path(name).is_absolute() or ".." in Path(name).parts or not allowed(name)
                    or not (member.isfile() or member.isdir())):
                raise RuntimeError("Unsafe or non-allowlisted bundle member: " + name)
            seen.add(name)
        if "scripts/deploy-app-node.sh" not in seen or "envoy/envoy.prod.yaml" not in seen:
            raise RuntimeError("Incomplete App configuration bundle")


def extract(path):
    with tarfile.open(path, "r:gz") as archive:
        # Explicit validation above rejects links/traversal; avoid following a
        # pre-existing destination symlink as well.
        for member in archive.getmembers():
            target = APP / member.name
            if any(parent.is_symlink() for parent in [target, *target.parents] if parent != APP.parent):
                raise RuntimeError("Symlink in bundle destination")
        archive.extractall(APP, filter="data")


def snapshot(path):
    with tarfile.open(path, "w:gz", dereference=False) as archive:
        for name in FILES:
            if (APP / name).exists():
                archive.add(APP / name, arcname=name)
    inspect_archive(path)


def active_tag():
    state_file = STATE / "current-image-tag"
    containers = os.environ.get("ASTRACODE_RELEASE_CONTAINER_NAMES",
        "astracode_website judge_auth judge_problem judge_submission").split()
    versions = {tag(subprocess.check_output(["docker", "inspect", "--format", "{{.Config.Image}}", name],
                                          text=True).strip().rsplit(":", 1)[-1]) for name in containers}
    if len(versions) != 1:
        raise RuntimeError("Current App images disagree; refuse configuration mutation")
    version = versions.pop()
    if state_file.exists() and state_file.read_text().strip() != version:
        raise RuntimeError("Image/tag state drift; refuse configuration mutation")
    return version


def restore_images(release):
    # Restore even a partially updated fleet before invoking the previous
    # script's normal strict consistency checks. Uses the restored bundle.
    code = '''set -a; source "$1"; set +a; export ASTRACODE_IMAGE_TAG="$2"
docker compose --project-name "$3" --env-file "$1" -f "$4/docker-compose.yml" \\
  -f "$4/docker-compose.prod.yml" -f "$5" up -d --no-deps --pull never \\
  website auth-service problem-service submission-service'''
    run(["bash", "-ec", code, "bash", str(STACK), tag(release),
         os.environ.get("ASTRACODE_APP_COMPOSE_PROJECT", "go-judge-system"), str(APP), str(OVERRIDE)])


def activate(release):
    child_env = dict(os.environ, ASTRACODE_APP_DIR=str(APP), ASTRACODE_APP_STATE_DIR=str(STATE),
                     ASTRACODE_BUNDLE_TRANSACTION="1")
    run(["bash", str(APP / "scripts/deploy-app-node.sh"), tag(release)], env=child_env)


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    os.replace(temporary, path)


def main():
    os.umask(0o077)
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / "bundle.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if len(sys.argv) in (2, 3) and sys.argv[1] == "--current-tag":
            if len(sys.argv) == 3:
                inspect_archive(Path(sys.argv[2]))
                external_inputs()
            print(active_tag())
            return
        if os.environ.get("ASTRACODE_PROTECTED_ROLLOUT") != "1":
            raise RuntimeError("Use the protected production workflow for App activation and paired rollback")
        current = STATE / "current-bundle.json"
        previous = STATE / "previous-bundle.json"
        inputs = external_inputs()
        if len(sys.argv) in (2, 4) and sys.argv[1] == "--rollback":
            target = json.loads(previous.read_text())
            if len(sys.argv) == 4 and (active_tag() != tag(sys.argv[2]) or target["tag"] != tag(sys.argv[3])):
                raise RuntimeError("App rollback references changed since rollout preflight")
            if target["external_inputs"] != inputs:
                raise RuntimeError("External credentials/override changed; refuse automatic rollback. Restore compatible node inputs explicitly first.")
            release, bundle = target["tag"], Path(target["bundle"])
        elif len(sys.argv) == 3:
            release, bundle = tag(sys.argv[1]), Path(sys.argv[2]).resolve()
        else:
            raise RuntimeError("usage: deploy-app-bundle.py <vX.Y.Z> <bundle.tgz> | --rollback")
        inspect_archive(bundle)
        old_tag = active_tag()
        work = Path(tempfile.mkdtemp(prefix="bundle-", dir=STATE))
        backup = work / "before.tgz"
        snapshot(backup)
        prior_inputs = json.loads(current.read_text())["external_inputs"] if current.exists() else inputs
        before = {"tag": old_tag, "bundle": str(backup), "external_inputs": prior_inputs}
        # Keep an immutable copy even if the upload path is removed later.
        candidate = work / "candidate.tgz"
        candidate.write_bytes(bundle.read_bytes())
        old_states = {name: (STATE / name).read_bytes() if (STATE / name).exists() else None
                      for name in ("current-image-tag", "previous-image-tag", "current-bundle.json", "previous-bundle.json")}
        try:
            extract(candidate)
            activate(release)
            if external_inputs() != inputs:
                raise RuntimeError("External inputs changed during activation")
            write_json(previous, before)
            write_json(current, {"tag": release, "bundle": str(candidate), "external_inputs": inputs})
        except Exception:
            if external_inputs() != before["external_inputs"]:
                raise RuntimeError("Activation failed with changed external inputs; rollback requires operator recovery")
            extract(backup)
            restore_images(old_tag)
            # The inner script checks this tag against the running images. It
            # may already have updated the tag file, so omit the stale value.
            state_file = STATE / "current-image-tag"
            if state_file.exists():
                state_file.unlink()
            activate(old_tag)
            for name, value in old_states.items():
                path = STATE / name
                if value is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_bytes(value)
            raise
        print("Activated image/config bundle " + release)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("App bundle activation failed: " + str(error), file=sys.stderr)
        sys.exit(1)
