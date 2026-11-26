"""Prepare and submit the exact originating staging request."""

import argparse
import json
import os

from approval_client import submit
from policy import Refused, canonical, digest


def main(command):
    if command == "prepare":
        if os.environ["GITHUB_RUN_ATTEMPT"] != "1":
            raise Refused("use a fresh dispatch")
        payload = json.loads(os.environ["REQUEST"])
        action = payload["operation"]
        environments = {
            "start": "staging-lifecycle",
            "extend": "staging-lifecycle",
            "cancel": "staging-lifecycle",
            "deploy": "staging-deployment",
            "rollback": "staging-deployment",
            "restart": "staging-deployment",
            "recover": "staging-deployment",
        }
        data = canonical(payload).decode()
        if len(data) > 8192 or payload["environment"] != "s2":
            raise Refused("invalid request target or size")
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(
                "payload=" + data + "\nenvironment=" + environments[action] + "\n"
            )
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write("Review the exact originating request below.\n\n")
            summary.write(
                "Run "
                + os.environ["GITHUB_RUN_ID"]
                + " attempt 1. Digest "
                + digest(data.encode())
                + ".\n\n"
            )
            summary.write("    " + data.replace("\n", "\\n") + "\n")
    else:
        payload = json.loads(os.environ["FROZEN_REQUEST"])
        result = submit(payload, os.environ["APPROVAL_ENVIRONMENT"], "/api/v1/approve")
        print(canonical(result).decode())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("prepare", "submit"))
    main(parser.parse_args().command)
