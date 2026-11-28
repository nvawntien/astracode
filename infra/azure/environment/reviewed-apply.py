"""Execute a reviewed S2/S3 saved plan from the protected operator context."""

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


NODES = {
    role: f'azurerm_linux_virtual_machine.node["{role}"]' for role in ("app", "judge")
}
ATTACHMENT = "azurerm_virtual_machine_data_disk_attachment.app[0]"
DISK = "azurerm_managed_disk.app"
CONTROLLER = "azurerm_function_app_flex_consumption.controller"
ALERTS = [
    f"azurerm_monitor_scheduled_query_rules_alert_v2.{name}"
    for name in ("heartbeat", "cleanup")
]
KEEP_NETWORK = {
    "azurerm_network_interface",
    "azurerm_public_ip",
    "azurerm_nat_gateway",
    "azurerm_virtual_network",
    "azurerm_subnet",
}


class Refused(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def expires_at(value):
    deadline = datetime.fromisoformat(value)
    require(deadline.tzinfo is not None, "approval deadline requires a timezone")
    return deadline


def classify(plan):
    rows = {
        row["address"]: row
        for row in plan["resource_changes"]
        if row["mode"] == "managed"
    }
    changes = {address: row["change"] for address, row in rows.items()}
    require(not plan.get("errored") and plan.get("complete") is True, "incomplete plan")
    require(
        not plan.get("deferred_changes"), "deferred resource actions require review"
    )
    require(
        not any(
            r["address"] in (*NODES.values(), DISK, ATTACHMENT)
            or r["type"] in KEEP_NETWORK
            for r in plan.get("resource_drift", [])
        ),
        "reconcile drift on a protected VM, disk or network resource before applying",
    )
    vm_actions = {
        role: changes.get(address, {}).get("actions", ["no-op"])
        for role, address in NODES.items()
    }
    creating = {role for role, actions in vm_actions.items() if actions == ["create"]}
    replacing = {
        role for role, actions in vm_actions.items() if actions == ["delete", "create"]
    }
    require(
        (not creating or not replacing)
        and len(replacing) <= 1
        and all(
            actions in (["no-op"], ["create"], ["delete", "create"])
            for actions in vm_actions.values()
        ),
        "only initial pair creation or one delete-before-create VM replacement is supported",
    )
    approved_deletes = set()
    if replacing:
        role = next(iter(replacing))
        address = NODES[role]
        change = changes[address]
        for key in (
            "name",
            "resource_group_name",
            "location",
            "size",
            "network_interface_ids",
        ):
            require(
                bool(change["before"][key])
                and change["after"].get(key) == change["before"][key],
                "VM replacement must retain its name, scope, size and NIC",
            )
        approved_deletes.add(address)
        if role == "app":
            attachment = changes[ATTACHMENT]
            require(
                attachment["actions"] == ["delete", "create"]
                and attachment["before"]["managed_disk_id"]
                == attachment["after"]["managed_disk_id"]
                and attachment["before"]["lun"] == attachment["after"]["lun"] == 0,
                "replace the App attachment with the same retained disk at LUN 0",
            )
            approved_deletes.add(ATTACHMENT)
    for address, change in changes.items():
        actions = change["actions"]
        require(
            actions in (["no-op"], ["create"], ["update"])
            or (address in approved_deletes and actions == ["delete", "create"]),
            "plan contains an unapproved destructive action",
        )
        if address == ATTACHMENT:
            require(
                actions
                == (
                    ["create"]
                    if "app" in creating
                    else ["delete", "create"]
                    if address in approved_deletes
                    else ["no-op"]
                ),
                "unexpected App disk attachment change",
            )
        if (creating or replacing) and address not in {
            *NODES.values(),
            ATTACHMENT,
            "terraform_data.compute_admission",
        }:
            require(
                actions == ["no-op"], "prepare and arm dependencies before touching VMs"
            )
    if creating or replacing:
        require(
            set(NODES.values()) <= changes.keys()
            and changes[CONTROLLER]["before"]["public_network_access_enabled"] is True
            and all(changes[a]["before"]["enabled"] is True for a in ALERTS)
            and changes[DISK]["before"]["id"]
            and changes[ATTACHMENT]["after"]["managed_disk_id"]
            == changes[DISK]["before"]["id"],
            "armed controller, independent monitors and retained App disk must already exist",
        )
    return (
        ("create", None)
        if creating
        else ("replace", role)
        if replacing
        else ("maintenance", None)
    )


def verify(plan, approval, plan_sha, now):
    outputs = plan["planned_values"]["outputs"]
    target = outputs["plan_target"]["value"]
    slot = target["slot"]
    require(
        plan_sha == approval["plan_sha256"]
        and target == approval["target"]
        and slot in {"S2", "S3"}
        and target["state_container"] == f"{slot.lower()}-tfstate"
        and target["state_key"] == "terraform.tfstate"
        and target["resource_group"] == f"astra-{slot.lower()}"
        and approval["approval_ref"].strip(),
        "approval does not bind this plan and S2/S3 target",
    )
    deadline = expires_at(approval["expires_at"])
    require(now < deadline, "reviewed plan approval expired")
    mode, role = classify(plan)
    require(
        (mode, role) == (approval["operation"], approval.get("role")),
        "plan does not match the approved operation",
    )
    compute = plan["variables"]["compute"]["value"]
    startup = compute.get("startup")
    if mode == "maintenance":
        require(
            startup is None, "remove expired or unused startup inputs for maintenance"
        )
    else:
        ids = outputs["vm_ids"]["value"]
        expected = {
            role: f"/subscriptions/{target['subscription_id']}/resourceGroups/{target['resource_group']}"
            f"/providers/Microsoft.Compute/virtualMachines/{target['resource_group']}-{role}"
            for role in NODES
        }
        controller = outputs["controller_id"]["value"]
        require(
            compute["enabled"]
            and startup
            and ids == expected
            and sorted(i.lower() for i in startup["target_vm_ids"])
            == sorted(i.lower() for i in expected.values())
            and startup["controller_id"].lower() == controller.lower()
            and startup["approval_ref"] == approval["startup_approval_ref"]
            and deadline
            <= expires_at(startup["expires_at"])
            <= now + timedelta(minutes=30),
            "fresh startup approval for the exact controller and pair required",
        )
        grant = approval["controller_grant"]
        if slot == "S2":
            require(
                grant["accepted"] is True
                and grant["phase"] == "compute-maintenance"
                and grant["requestId"] == startup["approval_ref"]
                and grant["terraformPlan"]
                == {
                    "sha256": plan_sha,
                    "operation": mode,
                    "role": role,
                    "expiresAt": startup["expires_at"],
                }
                and expires_at(grant["expires"]) == expires_at(startup["expires_at"]),
                "S2 requires the matching native-approved controller power window",
            )
        else:
            require(
                grant["approvalRef"] == startup["approval_ref"]
                and deadline
                <= expires_at(startup["expires_at"])
                <= expires_at(grant["deadline"]),
                "S3 startup must be within the protected experiment deadline",
            )
    return target, deadline


def check_execution_scope(root, approval, target):
    backend_dir = root / os.environ.get("TF_DATA_DIR", ".terraform")
    backend = json.loads((backend_dir / "terraform.tfstate").read_text())["backend"]
    config = backend["config"]
    require(
        backend["type"] == "azurerm"
        and config["use_azuread_auth"] is True
        and config["use_cli"] is True
        and config.get("access_key") is None
        and config.get("sas_token") is None
        and config["tenant_id"].lower() == target["tenant_id"]
        and config["storage_account_name"] == approval["backend_account"]
        and config["container_name"] == target["state_container"]
        and config["key"] == target["state_key"]
        and subprocess.check_output(
            ["terraform", f"-chdir={root}", "workspace", "show"], text=True
        ).strip()
        == "default",
        "initialized Entra backend does not match the approved slot and state key",
    )
    account = json.loads(
        subprocess.check_output(["az", "account", "show", "-o", "json"])
    )
    require(
        account["id"].lower() == target["subscription_id"]
        and account["tenantId"].lower() == target["tenant_id"]
        and account["state"] == "Enabled",
        "Azure CLI subscription and tenant must match the enabled target",
    )


def verify_controller_status(status, plan, approval, now):
    slot = approval["target"]["slot"].lower()
    heartbeat = expires_at(status["heartbeat"])
    require(
        status["environment"] == slot
        and status["contest"] is False
        and timedelta(0) <= now - heartbeat < timedelta(minutes=3)
        and expires_at(status["expires"]) > now,
        "live controller environment, deadline or heartbeat differs",
    )
    grant = approval["controller_grant"]
    if slot == "s2":
        require(
            status["phase"] == "compute-maintenance"
            and status["terraform_window"]
            == {
                "requestId": grant["requestId"],
                "terraformPlan": grant["terraformPlan"],
            }
            and expires_at(status["expires"]) == expires_at(grant["expires"]),
            "S2 compute approval is no longer active",
        )
    else:
        experiment = status["experiment"]
        ids = plan["planned_values"]["outputs"]["vm_ids"]["value"]
        require(
            status["phase"] == "starting"
            and not status["inventory_followup"]
            and expires_at(status["expires"]) >= expires_at(approval["expires_at"])
            and experiment["approvalRef"] == grant["approvalRef"]
            and expires_at(experiment["deadline"]) == expires_at(grant["deadline"])
            and experiment["targets"] == ids,
            "S3 experiment is no longer active for the exact VM pair",
        )
        recovery = status.get("rehearsal_recovery")
        if approval["operation"] == "replace":
            require(
                recovery
                and not recovery["boots_confirmed"]
                and expires_at(recovery["bootDeadline"])
                >= expires_at(approval["expires_at"]),
                "S3 replacement requires the bounded recovery power window",
            )


def check_controller(plan, approval):
    # Use the standard release HTTPS client so a redirect cannot forward the token.
    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts" / "release"))
    from transport import request

    config = next(
        row["change"]["before"]
        for row in plan["resource_changes"]
        if row["address"] == CONTROLLER
    )
    host = config["default_hostname"]
    require(
        re.fullmatch(r"[a-z0-9][a-z0-9-]*[.]azurewebsites[.]net", host),
        "unexpected Azure Function HTTPS hostname",
    )
    token = sys.stdin.readline(32769).strip()
    require(
        re.fullmatch(r"[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+", token),
        "provide a current controller-scoped access token on standard input",
    )
    _, _, body = request(
        f"https://{host}/api/v1/status",
        "POST",
        b"{}",
        {"Authorization": "Bearer " + token, "Content-Type": "application/json"},
    )
    verify_controller_status(
        json.loads(body), plan, approval, datetime.now(timezone.utc)
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path)
    parser.add_argument("approval", type=Path)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument(
        "--check", action="store_true", help="verify offline without executing apply"
    )
    args = parser.parse_args()
    try:
        require(
            not any(name.startswith("TF_CLI_ARGS") for name in os.environ),
            "unset Terraform command-line overrides in the protected runner",
        )
        approval = json.loads(args.approval.read_text())
        raw = args.plan.read_bytes()
        plan_sha = hashlib.sha256(raw).hexdigest()
        require(plan_sha == approval["plan_sha256"], "saved plan digest changed")
        root = args.root.resolve()
        tf = ["terraform", f"-chdir={root}"]
        with tempfile.TemporaryDirectory(prefix="astracode-reviewed-plan-") as scratch:
            saved = Path(scratch) / "reviewed.tfplan"
            saved.write_bytes(raw)
            plan = json.loads(
                subprocess.check_output([*tf, "show", "-json", str(saved)])
            )
            target, deadline = verify(
                plan, approval, plan_sha, datetime.now(timezone.utc)
            )
            if not args.check:
                check_execution_scope(root, approval, target)
                if approval["operation"] != "maintenance":
                    check_controller(plan, approval)
                require(
                    datetime.now(timezone.utc) < deadline,
                    "approval expired before apply",
                )
                subprocess.run(
                    [*tf, "apply", "-input=false", "-lock-timeout=0s", str(saved)],
                    check=True,
                )
    except (
        Refused,
        OSError,
        KeyError,
        TypeError,
        ValueError,
        subprocess.CalledProcessError,
    ) as exc:
        # Terraform plan JSON and backend settings can include sensitive inputs.
        parser.exit(
            1,
            f"{exc if isinstance(exc, Refused) else 'plan, scope or execution verification failed'}\n",
        )


if __name__ == "__main__":
    main()
