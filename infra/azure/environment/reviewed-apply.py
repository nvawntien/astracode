"""Execute a reviewed S2/S3 saved plan from the protected operator context."""

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


NODES = {
    role: f'azurerm_linux_virtual_machine.node["{role}"]' for role in ("app", "judge")
}
ATTACHMENT = "azurerm_virtual_machine_data_disk_attachment.app[0]"
DISK = "azurerm_managed_disk.app"
SCHEDULES = {
    role: f'azurerm_dev_test_global_vm_shutdown_schedule.node["{role}"]'
    for role in NODES
}
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
    missing_role = next(iter(creating)) if len(creating) == 1 else None
    permitted_drift = {NODES[missing_role]} if missing_role else set()
    if missing_role == "app":
        permitted_drift.add(ATTACHMENT)
    require(
        not any(
            (
                row["address"]
                in (*NODES.values(), DISK, ATTACHMENT, *SCHEDULES.values())
                or row["type"] in KEEP_NETWORK
            )
            and not (
                row["address"] in permitted_drift
                and row["change"]["actions"] == ["delete"]
            )
            for row in plan.get("resource_drift", [])
        ),
        "reconcile protected drift before applying; only the exact missing recovery target may be recreated",
    )
    for role in creating:
        vm = changes[NODES[role]]["after"]
        nic = changes[f'azurerm_network_interface.node["{role}"]']["before"]
        ip = changes[f'azurerm_public_ip.node["{role}"]']["before"]
        require(
            vm["name"] == nic["name"].removesuffix("-nic")
            and vm["size"] == plan["variables"]["compute"]["value"][role + "_size"]
            and vm["network_interface_ids"] == [nic["id"]]
            and nic["ip_configuration"][0]["public_ip_address_id"] == ip["id"],
            "VM creation must reuse the exact reviewed NIC, public IP and capacity",
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
            and all(
                changes[address]["before"]["enabled"] is True
                and changes[address]["before"]["timezone"] == "UTC"
                for address in SCHEDULES.values()
            )
            and changes[DISK]["before"]["id"]
            and changes[ATTACHMENT]["after"]["managed_disk_id"]
            == changes[DISK]["before"]["id"]
            and changes[ATTACHMENT]["after"]["lun"] == 0,
            "native shutdown schedules and the retained App disk must already exist",
        )
    if replacing:
        return "replace", role
    if missing_role:
        return "recover", missing_role
    return ("create", None) if creating else ("maintenance", None)


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
        require(
            compute["enabled"]
            and startup
            and ids == expected
            and sorted(i.lower() for i in startup["target_vm_ids"])
            == sorted(i.lower() for i in expected.values())
            and startup["approval_ref"] == approval["startup_approval_ref"]
            and deadline
            <= expires_at(startup["expires_at"])
            <= now + timedelta(minutes=30),
            "fresh owner-approved infrastructure window for the exact pair required",
        )
        schedule = plan["variables"]["operations"]["value"]
        day = now.astimezone(timezone.utc).date().isoformat()
        cutoff = expires_at(
            f"{day}T{schedule['shutdown'][:2]}:{schedule['shutdown'][2:]}:00Z"
        )
        earliest = expires_at(
            f"{day}T{schedule['earliest_start'][:2]}:{schedule['earliest_start'][2:]}:00Z"
        )
        require(
            approval["window_ref"] == schedule["approved"]
            and earliest <= now
            and expires_at(startup["expires_at"]) + timedelta(minutes=10) <= cutoff,
            "approved infrastructure window or shutdown margin differs",
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


def azure_json(*args):
    return json.loads(subprocess.check_output(["az", *args, "-o", "json"], timeout=30))


def check_azure_compute(plan, approval, target):
    ids = plan["planned_values"]["outputs"]["vm_ids"]["value"]
    schedule = plan["variables"]["operations"]["value"]
    approval_tag = schedule["approved"]
    present = {
        vm["id"].lower()
        for vm in azure_json("vm", "list", "--resource-group", target["resource_group"])
    }
    missing = {role for role, vm_id in ids.items() if vm_id.lower() not in present}
    expected = {
        "create": {"app", "judge"},
        "recover": {approval.get("role")},
        "replace": set(),
    }[approval["operation"]]
    require(missing == expected, "actual absent VMs differ from the reviewed operation")
    for role, vm_id in ids.items():
        if role not in missing:
            view = azure_json("vm", "get-instance-view", "--ids", vm_id)
            require(
                any(
                    s["code"] == "PowerState/deallocated"
                    for s in view["instanceView"]["statuses"]
                ),
                "verify existing VM deallocation before compute apply",
            )
        native = azure_json(
            "resource",
            "show",
            "--resource-type",
            "Microsoft.DevTestLab/schedules",
            "--resource-group",
            target["resource_group"],
            "--name",
            "shutdown-computevm-" + vm_id.split("/")[-1],
        )
        props = native["properties"]
        require(
            native["tags"]["owner_approval"] == approval_tag
            and props["status"] == "Enabled"
            and props["targetResourceId"].lower() == vm_id.lower()
            and props["taskType"] == "ComputeVmShutdownTask"
            and props["timeZoneId"] == "UTC"
            and props["dailyRecurrence"]["time"] == schedule["shutdown"],
            "native automatic shutdown must be active for the reviewed VM and cutoff",
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
                    check_azure_compute(plan, approval, target)
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
