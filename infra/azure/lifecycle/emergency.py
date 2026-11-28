"""Observe or deallocate one approved VM pair from the scoped emergency CLI profile."""

import argparse
import json
import re
import subprocess
import time


def cli(*args, timeout=35):
    return json.loads(
        subprocess.check_output(["az", *args, "-o", "json"], timeout=timeout)
    )


def observed(vm_id):
    vm = cli("vm", "get-instance-view", "--ids", vm_id)
    codes = [
        row["code"]
        for row in vm["instanceView"]["statuses"]
        if row["code"].startswith("PowerState/")
    ]
    return codes[0] if len(codes) == 1 else "unknown"


def vm_pair(slot, subscription):
    if slot not in {"s2", "s3"} or not re.fullmatch(
        r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", subscription
    ):
        raise ValueError("exact S2/S3 subscription required")
    group = f"astra-{slot}"
    return {
        role: f"/subscriptions/{subscription}/resourceGroups/{group}/providers/Microsoft.Compute/virtualMachines/{group}-{role}"
        for role in ("app", "judge")
    }


def run(slot, subscription, observe_only, *, clock=time.monotonic, wait=time.sleep):
    account = cli("account", "show")
    if account["id"].lower() != subscription or account["state"] != "Enabled":
        raise ValueError("emergency CLI is on another target")
    ids = vm_pair(slot, subscription)
    deadline = clock() + 15 * 60
    while True:
        states = {}
        for role, vm_id in ids.items():
            try:
                states[role] = observed(vm_id)
            except (ValueError, KeyError, subprocess.SubprocessError):
                states[role] = "unknown"
        if observe_only or all(
            state == "PowerState/deallocated" for state in states.values()
        ):
            return states
        if clock() >= deadline:
            return states
        for role, vm_id in ids.items():
            if states[role] in ("PowerState/deallocated", "PowerState/deallocating"):
                continue
            try:
                subprocess.run(
                    [
                        "az",
                        "vm",
                        "deallocate",
                        "--ids",
                        vm_id,
                        "--no-wait",
                        "-o",
                        "none",
                    ],
                    check=False,
                    timeout=30,
                )
            except subprocess.TimeoutExpired:
                pass  # The next instance view determines whether Azure accepted it.
        wait(15)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slot", choices=("s2", "s3"), required=True)
    parser.add_argument("--subscription", required=True)
    parser.add_argument("--observe", action="store_true")
    args = parser.parse_args()
    states = run(args.slot, args.subscription, args.observe)
    print(json.dumps(states, sort_keys=True))
    if not all(state == "PowerState/deallocated" for state in states.values()):
        raise SystemExit(1)
