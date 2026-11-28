"""Freeze a native-reviewed release and dispatch its fixed App guest command."""

import base64
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

from policy import DIGEST, SHA, Refused, canonical


def operation(value):
    if not isinstance(value, dict) or set(value) not in (
        {"slot", "action", "source", "digest", "fallback_source", "fallback"},
        {
            "slot",
            "action",
            "source",
            "digest",
            "fallback_source",
            "fallback",
            "recovery",
        },
    ):
        raise Refused("unexpected staging deployment inputs")
    if (
        value["slot"] not in {"s2", "s3"}
        or value["action"] not in {"deploy", "rollback", "restart", "recover"}
        or not all(SHA.fullmatch(value[key]) for key in ("source", "fallback_source"))
        or not all(DIGEST.fullmatch(value[key]) for key in ("digest", "fallback"))
    ):
        raise Refused("invalid slot, action or release digest")
    if value["action"] == "recover":
        recovery = value["recovery"]
        if (
            set(recovery) != {"operation", "versions"}
            or not re.fullmatch(r"[a-f0-9-]{36}", recovery["operation"])
            or set(recovery["versions"]) != {"auth", "problem", "submission"}
            or any(type(v) is not int or v < 0 for v in recovery["versions"].values())
        ):
            raise Refused(
                "exact interrupted operation and observed owner versions required"
            )
    elif "recovery" in value:
        raise Refused("recovery input allowed only for recovery")
    return value


def target(slot, subscription):
    if slot not in {"s2", "s3"} or not re.fullmatch(
        r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", subscription
    ):
        raise Refused("invalid environment subscription")
    group = "astra-" + slot
    return f"/subscriptions/{subscription}/resourceGroups/{group}/providers/Microsoft.Compute/virtualMachines/{group}-app"


def guest_command(slot, subscription, verb, payload):
    encoded = base64.b64encode(canonical(payload)).decode("ascii")
    fixed = shlex.join(
        [
            "/usr/bin/python3",
            "-B",
            "/usr/local/libexec/astra/app/host_services.py",
            "delivery",
            verb,
            encoded,
        ]
    )
    raw = subprocess.check_output(
        [
            "az",
            "vm",
            "run-command",
            "invoke",
            "--ids",
            target(slot, subscription),
            "--command-id",
            "RunShellScript",
            "--scripts",
            fixed,
            "-o",
            "json",
        ],
        timeout=725 if verb == "submit" else 90,
    )
    rows = json.loads(raw)["value"]
    if not rows or any(row["level"] != "Info" for row in rows):
        raise Refused("Azure guest command failed")
    found = [
        json.loads(line.removeprefix("ASTRA_DELIVERY="))
        for row in rows
        for line in row["message"].splitlines()
        if line.startswith("ASTRA_DELIVERY=")
    ]
    if len(found) != 1:
        raise Refused("missing protected guest delivery result")
    return found[0]


def dispatch(value, run, attempt, subscription):
    request = operation(value)
    if not re.fullmatch("[1-9][0-9]{0,19}", run) or attempt != "1":
        raise Refused("start a new approved workflow instead of rerunning")
    guest = dict(request, run=run, attempt=attempt)
    slot = guest.pop("slot")
    guest.setdefault("recovery", None)
    result = guest_command(slot, subscription, "submit", guest)
    if (
        result["environment"] != slot
        or result["source"] != request["source"]
        or result["bundle"] != request["digest"]
        or result["run"] != run
        or result["smoke"] != "passed"
        or not result["operation"]
    ):
        raise Refused("protected guest result differs from the approved release")
    return result


if __name__ == "__main__":
    if sys.argv[1] == "prepare":
        request = operation(json.loads(os.environ["REQUEST"]))
        with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
            output.write("payload=" + canonical(request).decode() + "\n")
            output.write("environment=" + request["slot"] + "-delivery\n")
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as summary:
            summary.write("Exact request for native deployment review\n\n```json\n")
            summary.write(json.dumps(request, indent=2) + "\n```\n")
    elif sys.argv[1] == "deploy":
        result = dispatch(
            json.loads(os.environ["FROZEN_REQUEST"]),
            os.environ["GITHUB_RUN_ID"],
            os.environ["GITHUB_RUN_ATTEMPT"],
            os.environ["TARGET_SUBSCRIPTION_ID"],
        )
        Path("staged-release.json").write_bytes(canonical(result))
    elif sys.argv[1] == "admit":
        staged = json.loads(Path("staged-release.json").read_text())
        current = os.environ["GITHUB_RUN_ID"]
        if staged["run"] != current or os.environ["GITHUB_RUN_ATTEMPT"] != "1":
            raise Refused("staging handoff does not match the current attempt")
        confirmed = guest_command(
            staged["environment"],
            os.environ["TARGET_SUBSCRIPTION_ID"],
            "admit-testers",
            {
                "run": current,
                "ticket": staged["operation"],
                "release": staged["bundle"],
            },
        )
        if confirmed != {"admitted": True}:
            raise Refused("staging handoff was not acknowledged")
    else:
        raise Refused("unknown staging delivery command")
