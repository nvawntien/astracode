"""Read-only eligibility for a protected tag and a successful S2 deployment run."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory

from policy import Refused, canonical, eligible, mapped_release
from transport import Blob, azure_token


def prepare(tag, run, revision):
    mapping = json.loads(Path(__file__).with_name("promotions.json").read_text())
    if not re.fullmatch("[1-9][0-9]{0,19}", run):
        raise Refused("protected staging run ID required")
    return {"bundle": mapped_release(tag, mapping, revision), "tag": tag, "run": run}


def github(*args):
    return json.loads(subprocess.check_output(["gh", "api", *args], timeout=25))


def review(run, reviews, environment, reviewer_ids):
    matching = [
        row
        for row in reviews
        if any(env["name"] == environment for env in row["environments"])
    ]
    reviewers = [
        str(row["user"]["id"])
        for row in matching
        if str(row["user"]["id"]) in reviewer_ids
        and row["user"]["id"] != run["actor"]["id"]
    ]
    if not reviewers or any(row["state"] != "approved" for row in matching):
        raise Refused("native independent approval missing")
    return reviewers[0]


def check_run(run, repo, workflow, success):
    if (
        run["repository"]["full_name"] != repo
        or run["path"] != ".github/workflows/" + workflow
        or run["head_branch"] != "main"
        or run["event"] != "workflow_dispatch"
        or run["run_attempt"] != 1
        or (success and run["conclusion"] != "success")
    ):
        raise Refused("untrusted deployment or eligibility workflow")


def evaluate(payload):
    repo = os.environ["GITHUB_REPOSITORY"]
    endpoint = f"repos/{repo}/actions/runs/"
    run_id = payload["run"]
    if not re.fullmatch("[1-9][0-9]{0,19}", run_id):
        raise Refused("invalid staging run ID")
    staged_run = github(endpoint + run_id)
    check_run(staged_run, repo, "staging-deploy.yml", True)
    review(
        staged_run,
        github(endpoint + run_id + "/approvals"),
        "s2-delivery",
        os.environ["STAGING_REVIEWER_IDS"].split(),
    )
    this_run = os.environ["GITHUB_RUN_ID"]
    current = github(endpoint + this_run)
    check_run(current, repo, "promotion-eligibility.yml", False)
    reviewer = review(
        current,
        github(endpoint + this_run + "/approvals"),
        "promotion-eligibility",
        os.environ["PROMOTION_REVIEWER_IDS"].split(),
    )
    with TemporaryDirectory() as path:
        subprocess.run(
            [
                "gh",
                "run",
                "download",
                run_id,
                "--repo",
                repo,
                "--name",
                "staged-release-" + run_id,
                "--dir",
                path,
            ],
            check=True,
            timeout=30,
        )
        staged = json.loads((Path(path) / "staged-release.json").read_text())
    if staged["run"] != run_id:
        raise Refused("staged evidence belongs to another run")
    blob = Blob(
        os.environ["RELEASE_RECORDS_ACCOUNT"], "canonical-releases", azure_token
    )
    record = json.loads(blob.read(staged["source"] + ".json"))
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    frozen = any(
        datetime.fromisoformat(row["start"]) <= now < datetime.fromisoformat(row["end"])
        for row in json.loads(os.environ["CONTEST_WINDOWS"])
    )
    return eligible(
        record,
        staged,
        dict(approved=True, bundle=payload["bundle"], reviewer=reviewer),
        frozen,
    )


if __name__ == "__main__":
    if sys.argv[1] == "prepare":
        payload = prepare(
            os.environ["TAG"], os.environ["STAGING_RUN"], os.environ["GITHUB_SHA"]
        )
        text = canonical(payload).decode()
        with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
            output.write("payload=" + text + "\n")
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as summary:
            summary.write(
                "Exact read-only promotion evaluation\n\n```json\n" + text + "\n```\n"
            )
    elif sys.argv[1] == "evaluate":
        result = evaluate(json.loads(os.environ["FROZEN_REQUEST"]))
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as summary:
            summary.write(canonical(result).decode() + "\n")
    else:
        raise Refused("unknown eligibility action")
