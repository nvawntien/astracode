"""Trusted workflow entry points; S3 never obtains a canonical receipt credential."""

import argparse
import json
import os
from pathlib import Path
import subprocess

from policy import (
    Refused,
    SHA,
    canonical,
    provenance,
    publication_context,
    publish_once,
    verify_record,
)
from transport import Blob, Registry, azure_token, request


def github(path):
    repository = os.environ["GITHUB_REPOSITORY"]
    _, _, raw = request(
        f"https://api.github.com/repos/{repository}/{path}",
        headers={
            "Authorization": "Bearer " + os.environ["GH_TOKEN"],
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    return json.loads(raw)


def store():
    return Blob(
        os.environ["RELEASE_RECORDS_ACCOUNT"], "canonical-releases", azure_token
    )


def history(root):
    lower = os.environ["M013_FIRST_MERGE"]
    if not SHA.fullmatch(lower):
        raise Refused("owner-reviewed inclusive history bound required")
    subprocess.run(
        ["git", "merge-base", "--is-ancestor", lower, "origin/develop"],
        cwd=root,
        check=True,
    )
    return subprocess.check_output(
        ["git", "rev-list", "--first-parent", "--reverse", lower + "^..origin/develop"],
        cwd=root,
        text=True,
    ).splitlines()


def merge(root, sha):
    return provenance(
        sha, github("commits/" + sha + "/pulls?per_page=100"), history(root)
    )


def registry(kind):
    repository = os.environ["GITHUB_REPOSITORY"].lower()
    return Registry(
        repository + ("/rehearsal" if kind == "rehearsal" else "") + "/release",
        os.environ["GITHUB_ACTOR"],
        os.environ["GH_TOKEN"],
    )


def main(args):
    event, ref = os.environ["GITHUB_EVENT_NAME"], os.environ["GITHUB_REF"]
    publication_context(event, ref, args.kind)
    if args.command == "discover":
        if ref != "refs/heads/main" or args.kind != "canonical":
            raise Refused("reconciliation is registered only on main")
        catalog = store()
        candidates = []
        for sha in history(args.root):
            try:
                merge(args.root, sha)
            except Refused:
                continue
            raw = catalog.read(sha + ".json")
            if raw is None:
                candidates.append(sha)
            else:
                verify_record(json.loads(raw), sha)
            if len(candidates) == 64:
                break
        with open(os.environ["GITHUB_OUTPUT"], "a") as result:
            result.write("commits=" + json.dumps(candidates) + "\n")
        return
    sha = args.sha
    if not sha or not SHA.fullmatch(sha):
        raise Refused("exact revision required")
    if args.command == "prepare":
        if args.kind == "canonical":
            proof = merge(args.root, sha)
            if event == "push" and sha != os.environ["GITHUB_SHA"]:
                raise Refused("push candidate differs from merge event")
            accepted = store().read(sha + ".json")
            if accepted is not None:
                record = json.loads(accepted)
                verify_record(record, sha)
                registry(args.kind).verify(record)
                with open(os.environ["GITHUB_OUTPUT"], "a") as result:
                    result.write("adopted=true\n")
                return
        else:
            # The protected rehearsal environment approves the SHA displayed
            # by the workflow; there is no S4 identity in this job.
            proof = {"source": sha, "rehearsal": True}
        args.file.write_bytes(canonical(proof))
        with open(os.environ["GITHUB_OUTPUT"], "a") as result:
            result.write("adopted=false\n")
        return
    record = json.loads(args.file.read_text())
    payload = verify_record(record, sha)
    if payload["kind"] != args.kind:
        raise Refused("wrong publication destination")
    if args.kind == "canonical":
        if merge(args.root, sha) != payload["merge"]:
            raise Refused("merge provenance changed")
    registry(args.kind).publish(record)
    if args.kind == "canonical":
        publish_once(store(), record)
    print("Verified " + args.kind + " bundle " + record["bundle"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("discover", "prepare", "publish"))
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument(
        "--kind", choices=("canonical", "rehearsal"), default="canonical"
    )
    parser.add_argument("--sha")
    parser.add_argument("--file", type=Path, default=Path("release.json"))
    main(parser.parse_args())
