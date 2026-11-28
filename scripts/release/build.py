"""Build exact-source images and the OCI payload on the trusted hosted publisher."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

import yaml

from policy import APPLICATIONS, Refused, canonical, digest, envelope, evidence

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "infra/azure/lifecycle"))
from configuration import FILES, content_digest

DOCKERFILES = {
    "website": ("website", "website/Dockerfile"),
    "auth-service": (".", "services/auth/Dockerfile"),
    "problem-service": (".", "services/problem/Dockerfile"),
    "submission-service": (".", "services/submission/Dockerfile"),
    "judge-worker": (".", "workers/judge/Dockerfile"),
    "go-judge": (".", "build/sandbox/Dockerfile"),
    "migrate": (".", "infra/postgres/managed/Dockerfile"),
}


def qualified(pin):
    name, sha = pin.split("@")
    if "/" not in name:
        name = "docker.io/library/" + name
    elif "." not in name.split("/")[0] and ":" not in name.split("/")[0]:
        name = "docker.io/" + name
    return name + "@" + sha


def output(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def source_tree(root, sha, destination):
    # Docker receives only the reviewed Git tree. Ignored environment files,
    # operator credentials and local fixtures must never enter a build context.
    archive = destination / "source.tar"
    with archive.open("wb") as stream:
        subprocess.run(
            ["git", "archive", "--format=tar", sha], cwd=root, stdout=stream, check=True
        )
    sealed = destination / "source"
    sealed.mkdir()
    with tarfile.open(archive) as tree:
        tree.extractall(sealed, filter="data")
    return sealed


def build(root, kind, ci, merge, registry, temporary):
    sha = output("git", "rev-parse", "HEAD", cwd=root)
    evidence(ci, sha, os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_RUN_ATTEMPT"])
    if output("git", "status", "--porcelain", "--untracked-files=no", cwd=root):
        raise Refused("source tree differs from checked revision")
    if kind == "canonical" and merge["source"] != sha:
        raise Refused("merge differs from source")
    epoch = output("git", "show", "-s", "--format=%ct", sha, cwd=root)
    timestamp = output("git", "show", "-s", "--format=%cI", sha, cwd=root)
    root = source_tree(root, sha, temporary)
    images = {}
    for name, (context, dockerfile) in DOCKERFILES.items():
        path = temporary / (name + ".metadata.json")
        tag = f"ghcr.io/{registry}/{name}:sha-{sha}"
        subprocess.run(
            [
                "docker",
                "buildx",
                "build",
                "--platform",
                "linux/amd64",
                "--push",
                "--provenance=false",
                "--metadata-file",
                str(path),
                "--tag",
                tag,
                "--label",
                "org.opencontainers.image.revision=" + sha,
                "--build-arg",
                "VERSION=sha-" + sha,
                "--build-arg",
                "COMMIT_SHA=" + sha,
                "--build-arg",
                "BUILD_TIME=" + timestamp,
                "--build-arg",
                "SOURCE_DATE_EPOCH=" + epoch,
                "--file",
                dockerfile,
                context,
            ],
            cwd=root,
            check=True,
        )
        pin = json.loads(path.read_text())["containerimage.digest"]
        reference = tag.split(":sha-")[0] + "@" + pin
        actual = subprocess.check_output(
            ["docker", "buildx", "imagetools", "inspect", "--raw", reference]
        )
        # imagetools prints a trailing newline when writing a raw descriptor.
        if digest(actual) != pin and digest(actual.rstrip(b"\n")) != pin:
            raise Refused("published image descriptor differs")
        images[name] = reference
    package = temporary / "migrations"
    donor = output("docker", "create", images["migrate"])
    try:
        subprocess.run(
            ["docker", "cp", donor + ":/migrations", str(package)], check=True
        )
    finally:
        subprocess.run(["docker", "rm", donor], check=True, stdout=subprocess.DEVNULL)
    return assemble(root, kind, ci, merge, sha, images, package)


def assemble(root, kind, ci, merge, sha, images, package):
    environments = {}
    for overlay, slot in (("testing", "s3"), ("staging", "s2")):
        rendered = output(
            "kustomize", "build", "infra/kubernetes/overlays/" + overlay, cwd=root
        )
        objects = list(yaml.safe_load_all(rendered))
        configs = {
            o["metadata"]["name"]: o for o in objects if o["kind"] == "ConfigMap"
        }
        workloads, configmaps, files = {}, {}, {}
        for obj in objects:
            if obj["kind"] not in {"Deployment", "Job"}:
                continue
            spec = obj["spec"]["template"]["spec"]
            for c in spec["containers"]:
                name = c["name"]
                if name not in DOCKERFILES:
                    reference = qualified(c["image"])
                    if name in images and images[name] != reference:
                        raise Refused("dependency pins differ between environments")
                    images[name] = reference
                if name not in APPLICATIONS | {"envoy", "migrate"}:
                    continue
                workloads[name] = content_digest({})
                if name in FILES:
                    selected = next(
                        v["configMap"]["name"]
                        for v in spec["volumes"]
                        if v["name"] == "config"
                    )
                    configmaps[name] = selected
                    data = configs[selected]["data"]
                    if set(data) != set(FILES[name][1]):
                        raise Refused("unexpected public configuration files")
                    files[name] = data
                    workloads[name] = content_digest(
                        {
                            k: hashlib.sha256(v.encode()).hexdigest()
                            for k, v in data.items()
                        }
                    )
        environments[slot] = dict(
            digest=content_digest(workloads),
            workloads=workloads,
            files=files,
            configmaps=configmaps,
            render=digest(rendered.encode()),
        )
    versions = {
        o: int((package / (o + ".version")).read_text())
        for o in ("auth", "problem", "submission")
    }
    migration_files = {
        str(p.relative_to(package)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in package.glob("*/*.sql")
    }
    source_files = {
        owner + "/" + path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for owner in versions
        for path in (root / "services" / owner / "migrations").glob("*.sql")
    }
    if migration_files != source_files:
        raise Refused("migration image differs from owning source SQL")
    names = set(migration_files)
    for owner, version in versions.items():
        names.add(owner + ".version")
        names.update(f"{owner}.{i}.catalog" for i in range(version + 1))
    return envelope(
        dict(
            kind=kind,
            source=sha,
            images=images,
            versions=versions,
            ci=ci,
            merge=merge,
            configuration_revision=sha,
            kustomize="v5.7.1",
            environments=environments,
            migration_files=migration_files,
            migration_package={
                n: base64.b64encode((package / n).read_bytes()).decode()
                for n in sorted(names)
            },
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("kind", choices=("canonical", "rehearsal"))
    parser.add_argument("ci", type=Path)
    parser.add_argument("merge", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    registry = os.environ["GITHUB_REPOSITORY"].lower() + (
        "/rehearsal" if args.kind == "rehearsal" else ""
    )
    with tempfile.TemporaryDirectory() as temporary:
        record = build(
            args.source,
            args.kind,
            json.loads(args.ci.read_text()),
            json.loads(args.merge.read_text()),
            registry,
            Path(temporary),
        )
        args.output.write_bytes(canonical(record))
