"""Read-only promotion eligibility. This entry point cannot build or deploy."""

import json
import os
from pathlib import Path
import sys
import uuid

from approval_client import submit
from policy import Refused, canonical, eligible, mapped_release


def prepare(tag):
    revision = os.environ["GITHUB_SHA"]
    mapping = json.loads(Path(__file__).with_name("promotions.json").read_text())
    bundle = mapped_release(tag, mapping, revision)
    return dict(
        schemaVersion=1,
        environment="s2",
        operation="promotion-eligibility",
        requestId=str(uuid.uuid4()),
        requester=os.environ["GITHUB_ACTOR_ID"],
        releaseDigest=bundle,
        tag=tag,
        mappingRevision=revision,
    )


def evaluate(payload):
    result = submit(payload, "promotion-eligibility", "/v1/eligibility")
    if result["receipt"]["bundle"] != payload["releaseDigest"]:
        raise Refused("eligibility response refers to another release")
    return eligible(
        result["receipt"],
        result["staged"],
        result["approval"],
        result["contest_frozen"],
    )


if __name__ == "__main__":
    if sys.argv[1] == "prepare":
        payload = prepare(os.environ["TAG"])
        text = canonical(payload).decode()
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write("payload=" + text + "\n")
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write(
                "Promotion eligibility only; no build or deployment.\n\n```json\n"
                + text
                + "\n```\n"
            )
    elif sys.argv[1] == "evaluate":
        result = evaluate(json.loads(os.environ["FROZEN_REQUEST"]))
        Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a").write(
            canonical(result).decode() + "\n"
        )
    else:
        raise Refused("unknown eligibility action")
