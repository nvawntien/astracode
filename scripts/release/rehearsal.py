"""Protected operator's pre-merge S3 packager. No Azure or canonical catalog access."""

import argparse
import os
from pathlib import Path
import tempfile

from build import build, output
from catalog import github, registry
from policy import Refused, canonical, rehearsal_evidence


def main(args):
    if output("git", "rev-parse", "HEAD", cwd=args.source) != args.reviewed_source:
        raise Refused("checkout differs from the owner-reviewed S3 candidate")
    run = github("actions/runs/" + str(args.run))
    jobs = []
    for page in range(1, 21):
        batch = github(
            f"actions/runs/{args.run}/attempts/{run['run_attempt']}/jobs?per_page=100&page={page}"
        )["jobs"]
        jobs.extend(batch)
        if len(batch) < 100:
            break
    else:
        raise Refused("unexpected check count")
    ci = rehearsal_evidence(
        run, jobs, args.reviewed_source, os.environ["GITHUB_REPOSITORY"]
    )
    os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_RUN_ATTEMPT"] = (
        ci["run"],
        ci["attempt"],
    )
    with tempfile.TemporaryDirectory() as tmp:
        record = build(
            args.source,
            "rehearsal",
            ci,
            dict(source=args.reviewed_source, rehearsal=True),
            os.environ["GITHUB_REPOSITORY"].lower() + "/rehearsal",
            Path(tmp),
        )
        registry("rehearsal").publish(record)
        args.output.write_bytes(canonical(record))
    print("Verified rehearsal-only bundle " + record["bundle"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--reviewed-source", required=True)
    parser.add_argument("--run", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    main(parser.parse_args())
