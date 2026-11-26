"""Operator CLI for the separately authorized, deallocate-only identity."""

import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import time
import uuid

from azure_adapters import Power
from transport import azure_token


def deallocate(
    power,
    *,
    clock=lambda: datetime.now(timezone.utc),
    sleep=time.sleep,
    timeout=timedelta(minutes=15)
):
    until = clock() + timeout
    pending = {}
    observed = {}
    while clock() < until:
        for role, url in list(pending.items()):
            if power.outcome(url) in {"Succeeded", "Failed", "Canceled"}:
                del pending[role]
        observed = power.observe()
        if all(v == "deallocated" for v in observed.values()) and not pending:
            return observed, True
        for role, state in observed.items():
            if state != "deallocated" and role not in pending:
                try:
                    url = power.send(role, "deallocate", str(uuid.uuid4()))
                    if url:
                        pending[role] = url
                except (ValueError, OSError):
                    pass
        sleep(15)
    return observed, False


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("reviewed_targets", type=Path)
    args = parser.parse_args()
    targets = json.loads(args.reviewed_targets.read_text())
    power = Power(
        targets, lambda: azure_token("https://management.azure.com/"), allow_start=False
    )
    observed, confirmed = deallocate(power)
    print(json.dumps(dict(confirmed=confirmed, power=observed)))
    raise SystemExit(0 if confirmed else 1)
