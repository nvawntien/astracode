"""Offline packaging/consumer integration with real renders and extracted SQL; no publication."""

from pathlib import Path
import subprocess
import sys
import tempfile

import yaml

from build import DOCKERFILES, ROOT, assemble, source_tree
from policy import CHECKS, Refused, verify_record

sys.path.insert(0, str(ROOT / "infra/azure/lifecycle"))
sys.path.insert(0, str(ROOT / "infra/postgres/managed"))
from release_catalog import Catalog, unpack_migrations
from coordinator import inspect_package


def main(package):
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        (repo / "tracked").write_text("reviewed")
        subprocess.run(["git", "add", "tracked"], cwd=repo, check=True)
        subprocess.run(
            [
                "git",
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-qm",
                "fixture",
            ],
            cwd=repo,
            check=True,
        )
        sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=repo, text=True
        ).strip()
        (repo / ".env").write_text("synthetic fixture credential")
        context = source_tree(repo, sha, Path(tmp))
        assert (context / "tracked").read_text() == "reviewed"
        assert not (context / ".env").exists() and not (context / ".git").exists()
    objects = list(
        yaml.safe_load_all(
            subprocess.check_output(
                ["kustomize", "build", "infra/kubernetes/overlays/testing"], cwd=ROOT
            )
        )
    )
    images = {
        c["name"]: c["image"]
        for obj in objects
        if obj["kind"] in {"Deployment", "Job"}
        for c in obj["spec"]["template"]["spec"]["containers"]
        if c["name"] in DOCKERFILES
    }
    sha = "a" * 40
    ci = dict(
        source=sha,
        run="0",
        attempt="1",
        checks=dict.fromkeys(CHECKS, "success"),
        repository="fixture/repo",
        run_url="https://github.com/fixture/repo/actions/runs/0/attempts/1",
    )
    record = assemble(
        ROOT, "rehearsal", ci, dict(source=sha, rehearsal=True), sha, images, package
    )
    verify_record(record, sha)

    class Controller:
        operation = "offline-fixture"

        def call(self, *args, **kwargs):
            return record

    catalog = Catalog(Controller(), images["go-judge"].split("@")[1])
    release = catalog.verified_bundle(record["bundle"], "s3")
    with tempfile.TemporaryDirectory() as tmp:
        unpack_migrations(release, tmp)
        prefixes = inspect_package(Path(tmp), release["migration_files"])
        assert {o: len(p) - 1 for o, p in prefixes.items()} == release["versions"]
    try:
        catalog.verified_bundle(record["bundle"], "s2")
    except RuntimeError:
        pass
    else:
        raise Refused("fixture rehearsal accepted by S2")
    print(
        "PASS offline package: sealed Git context excludes credentials, real overlays/SQL match host reader, S2 rejects rehearsal; CI evidence is synthetic"
    )


if __name__ == "__main__":
    main(Path(sys.argv[1]))
