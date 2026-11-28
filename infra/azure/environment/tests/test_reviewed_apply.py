"""Regressions for initial compute, failed replacement recovery and plan scoping."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import runpy
import unittest
from unittest.mock import patch


runner = runpy.run_path(Path(__file__).resolve().parents[1] / "reviewed-apply.py")
verify = runner["verify"]
live = runner["check_azure_compute"]
Refused = runner["Refused"]
NODES, ATTACHMENT, DISK, SCHEDULES = (
    runner[name] for name in ("NODES", "ATTACHMENT", "DISK", "SCHEDULES")
)


class ReviewedApply(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 28, 12, tzinfo=timezone.utc)
        self.deadline = (self.now + timedelta(minutes=10)).isoformat()
        self.sha = "d" * 64
        self.target = dict(
            slot="S2",
            subscription_id="00000000-0000-4000-8000-000000000002",
            tenant_id="00000000-0000-4000-8000-000000000010",
            resource_group="astra-s2",
            state_container="s2-tfstate",
            state_key="terraform.tfstate",
        )
        scope = (
            "/subscriptions/"
            + self.target["subscription_id"]
            + "/resourceGroups/astra-s2"
        )
        self.ids = {
            role: scope
            + "/providers/Microsoft.Compute/virtualMachines/astra-s2-"
            + role
            for role in NODES
        }
        self.sizes = {"app": "Standard_B4s_v2", "judge": "Standard_B2ls_v2"}
        self.plan = dict(
            complete=True,
            resource_changes=[],
            variables={
                "compute": {
                    "value": dict(
                        enabled=True,
                        startup=None,
                        **{role + "_size": size for role, size in self.sizes.items()},
                    )
                },
                "operations": {
                    "value": dict(
                        approved="window", earliest_start="0700", shutdown="1800"
                    )
                },
            },
            planned_values=dict(
                outputs={
                    name: {"value": value}
                    for name, value in dict(
                        plan_target=self.target, vm_ids=self.ids
                    ).items()
                }
            ),
        )
        self.approval = dict(
            target=self.target,
            plan_sha256=self.sha,
            operation="maintenance",
            approval_ref="approved-plan",
            expires_at=self.deadline,
        )
        for role, address in NODES.items():
            name = f"astra-s2-{role}"
            nic, ip = scope + "/nic-" + role, scope + "/ip-" + role
            self.row(
                address,
                dict(
                    name=name,
                    size=self.sizes[role],
                    resource_group_name="astra-s2",
                    location="koreacentral",
                    network_interface_ids=[nic],
                ),
            )
            self.row(
                f'azurerm_network_interface.node["{role}"]',
                dict(
                    id=nic,
                    name=name + "-nic",
                    ip_configuration=[dict(public_ip_address_id=ip)],
                ),
            )
            self.row(f'azurerm_public_ip.node["{role}"]', dict(id=ip))
            self.row(SCHEDULES[role], dict(enabled=True, timezone="UTC"))
        disk = scope + "/providers/Microsoft.Compute/disks/astra-s2-app-data"
        self.row(DISK, dict(id=disk))
        self.row(ATTACHMENT, dict(managed_disk_id=disk, lun=0))

    def row(self, addr, value):
        self.plan["resource_changes"].append(
            dict(
                address=addr,
                mode="managed",
                type=addr.split(".")[0],
                change=dict(actions=["no-op"], before=value, after=deepcopy(value)),
            )
        )

    def change(self, addr, actions=None):
        row = next(
            row for row in self.plan["resource_changes"] if row["address"] == addr
        )
        if actions:
            row["change"]["actions"] = actions
            if actions == ["create"]:
                row["change"]["before"] = None
        return row["change"]

    def approve(self, mode, role=None):
        self.plan["variables"]["compute"]["value"]["startup"] = dict(
            approval_ref="bounded",
            expires_at=self.deadline,
            target_vm_ids=list(self.ids.values()),
        )
        self.approval.update(
            operation=mode,
            role=role,
            window_ref="window",
            startup_approval_ref="bounded",
        )

    def check(self):
        return verify(self.plan, self.approval, self.sha, self.now)

    def cloud(
        self, existing, bad_schedule=False, existing_power="PowerState/deallocated"
    ):
        def query(*args):
            if args[:2] == ("vm", "list"):
                return [dict(id=self.ids[r]) for r in existing]
            if args[:2] == ("vm", "get-instance-view"):
                return {"instanceView": {"statuses": [{"code": existing_power}]}}
            role = args[-1].split("-")[-1]
            return {
                "tags": {"owner_approval": "window"},
                "properties": {
                    "status": "Disabled" if bad_schedule else "Enabled",
                    "targetResourceId": self.ids[role],
                    "taskType": "ComputeVmShutdownTask",
                    "timeZoneId": "UTC",
                    "dailyRecurrence": {"time": "1800"},
                },
            }

        with patch.dict(live.__globals__, azure_json=query):
            live(self.plan, self.approval, self.target)

    def test_initial_create_has_no_off_history_and_uses_exact_native_schedules(self):
        for addr in (*NODES.values(), ATTACHMENT):
            self.change(addr, ["create"])
        with self.assertRaises(Refused):
            self.check()
        self.approve("create")
        self.check()
        self.cloud(set())
        with self.assertRaisesRegex(Refused, "native automatic shutdown"):
            self.cloud(set(), bad_schedule=True)
        with self.assertRaisesRegex(Refused, "actual absent VMs"):
            self.cloud({"judge"})

    def test_failed_app_replacement_can_recreate_only_missing_app(self):
        self.change(NODES["app"], ["create"])
        self.change(ATTACHMENT, ["create"])
        self.plan["resource_drift"] = [
            dict(address=addr, type=addr.split(".")[0], change=dict(actions=["delete"]))
            for addr in (NODES["app"], ATTACHMENT)
        ]
        self.approve("recover", "app")
        self.check()
        self.cloud({"judge"})
        with self.assertRaisesRegex(Refused, "verify existing VM deallocation"):
            self.cloud({"judge"}, existing_power="PowerState/running")
        self.approval["role"] = "judge"
        with self.assertRaisesRegex(Refused, "approved operation"):
            self.check()
        self.approval["role"] = "app"
        self.change(ATTACHMENT)["after"]["managed_disk_id"] = "wrong-disk"
        with self.assertRaisesRegex(Refused, "retained App disk"):
            self.check()

    def test_failed_judge_replacement_reuses_existing_network_and_app_disk(self):
        self.change(NODES["judge"], ["create"])
        self.approve("recover", "judge")
        self.check()
        self.cloud({"app"})
        self.change(NODES["judge"])["after"]["network_interface_ids"] = ["another-nic"]
        with self.assertRaisesRegex(Refused, "exact reviewed NIC"):
            self.check()

    def test_delete_before_create_is_one_exact_target(self):
        self.change(NODES["app"], ["delete", "create"])
        self.change(ATTACHMENT, ["delete", "create"])
        self.approve("replace", "app")
        self.check()
        self.cloud({"app", "judge"})
        self.change(NODES["judge"], ["delete", "create"])
        with self.assertRaisesRegex(Refused, "one delete-before-create"):
            self.check()

    def test_maintenance_keeps_power_and_retained_resources_unchanged(self):
        self.check()
        self.change('azurerm_public_ip.node["app"]', ["delete", "create"])
        with self.assertRaisesRegex(Refused, "unapproved destructive"):
            self.check()

    def test_approval_must_preserve_cutoff_and_digest(self):
        for addr in (*NODES.values(), ATTACHMENT):
            self.change(addr, ["create"])
        self.approve("create")
        self.approval["plan_sha256"] = "a" * 64
        with self.assertRaisesRegex(Refused, "does not bind"):
            self.check()
        self.approval["plan_sha256"] = self.sha
        self.plan["variables"]["operations"]["value"]["shutdown"] = "1215"
        with self.assertRaisesRegex(Refused, "shutdown margin"):
            self.check()


if __name__ == "__main__":
    unittest.main()
