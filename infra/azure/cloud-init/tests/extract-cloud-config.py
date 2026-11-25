"""Extract cloud-init from the synthetic, provider-mocked compute plan."""

import base64
import json
import sys
from pathlib import Path


destination = Path(sys.argv[1])
destination.mkdir(parents=True, exist_ok=True)
for line in sys.stdin:
    event = json.loads(line)
    if event["type"] != "test_plan" or event["@testrun"] != "plan_only_the_approved_vm_pair":
        continue
    rendered = {
        change["index"]: base64.b64decode(change["change"]["after"]["custom_data"], validate=True)
        for change in event["test_plan"]["resource_changes"]
        if change["type"] == "azurerm_linux_virtual_machine"
    }
    if set(rendered) != {"app", "judge"}:
        raise SystemExit("Expected one App and one Judge cloud-init document")
    for role, config in rendered.items():
        if not config.startswith(b"#cloud-config\n") or len(config) > 64 * 1024:
            raise SystemExit(f"Invalid {role} Azure custom_data document")
        (destination / f"{role}.yaml").write_bytes(config)
    break
else:
    raise SystemExit("Did not find the mocked compute plan")
