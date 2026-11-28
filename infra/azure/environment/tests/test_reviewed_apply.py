"""Exercise the operator's plan classification and just-in-time authorization."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import runpy
import unittest


runner = runpy.run_path(Path(__file__).resolve().parents[1] / "reviewed-apply.py")
verify = runner["verify"]
verify_controller_status = runner["verify_controller_status"]
classify = runner["classify"]
Refused = runner["Refused"]
NODES = runner["NODES"]
ATTACHMENT = runner["ATTACHMENT"]
DISK = runner["DISK"]
CONTROLLER = runner["CONTROLLER"]
ALERTS = runner["ALERTS"]


class ReviewedApply(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 28, 12, tzinfo=timezone.utc)
        self.deadline = (self.now + timedelta(minutes=10)).isoformat()
        self.sha = "d" * 64
        target = dict(
            slot="S2",
            subscription_id="00000000-0000-4000-8000-000000000002",
            tenant_id="00000000-0000-4000-8000-000000000010",
            resource_group="astra-s2",
            state_container="s2-tfstate",
            state_key="terraform.tfstate",
        )
        scope = f"/subscriptions/{target['subscription_id']}/resourceGroups/astra-s2"
        self.ids = {
            role: f"{scope}/providers/Microsoft.Compute/virtualMachines/astra-s2-{role}"
            for role in NODES
        }
        self.controller_id = scope + "/providers/Microsoft.Web/sites/fixture-controller"
        self.plan = dict(
            complete=True,
            resource_changes=[],
            variables=dict(compute=dict(value=dict(enabled=True, startup=None))),
            planned_values=dict(
                outputs={
                    name: {"value": value}
                    for name, value in dict(
                        plan_target=target,
                        vm_ids=self.ids,
                        controller_id=self.controller_id,
                    ).items()
                }
            ),
        )
        self.approval = dict(
            target=target,
            plan_sha256=self.sha,
            operation="maintenance",
            approval_ref="approved-change",
            expires_at=self.deadline,
        )
        for role, address in NODES.items():
            self.row(
                address,
                ["no-op"],
                dict(
                    name=f"astra-s2-{role}",
                    size="Standard_B4s_v2" if role == "app" else "Standard_B2ls_v2",
                    resource_group_name="astra-s2",
                    location="koreacentral",
                    network_interface_ids=[scope + "/network/" + role],
                ),
            )
        self.row(CONTROLLER, ["no-op"], dict(public_network_access_enabled=True))
        for alert in ALERTS:
            self.row(alert, ["no-op"], dict(enabled=True))
        self.disk = scope + "/providers/Microsoft.Compute/disks/astra-s2-app-data"
        self.row(DISK, ["no-op"], dict(id=self.disk))
        self.row(ATTACHMENT, ["no-op"], dict(managed_disk_id=self.disk, lun=0))
        self.ip = 'azurerm_public_ip.node["app"]'
        self.row(self.ip, ["no-op"], dict(name="astra-s2-app-ipv4"))

    def row(self, address, actions, values):
        change = dict(
            actions=actions,
            before=None if actions == ["create"] else values,
            after=None if actions == ["delete"] else deepcopy(values),
        )
        self.plan["resource_changes"].append(
            dict(
                address=address,
                mode="managed",
                type=address.split(".")[0],
                change=change,
            )
        )

    def change(self, address):
        return next(
            row["change"]
            for row in self.plan["resource_changes"]
            if row["address"] == address
        )

    def approve_power_window(self, mode, role=None):
        startup_ref = "fixture-controller-request"
        self.plan["variables"]["compute"]["value"]["startup"] = dict(
            approval_ref=startup_ref,
            controller_id=self.controller_id,
            target_vm_ids=list(self.ids.values()),
            expires_at=self.deadline,
        )
        self.approval.update(
            operation=mode,
            role=role,
            startup_approval_ref=startup_ref,
            controller_grant=dict(
                accepted=True,
                phase="compute-maintenance",
                requestId=startup_ref,
                expires=self.deadline,
                terraformPlan=dict(
                    sha256=self.sha,
                    operation=mode,
                    role=role,
                    expiresAt=self.deadline,
                ),
            ),
        )

    def check(self):
        return verify(self.plan, self.approval, self.sha, self.now)

    def test_noop_and_routine_deallocated_reconciliation_use_no_startup_approval(self):
        self.check()
        self.row("azurerm_network_security_group.node", ["update"], dict())
        # AzureRM exposes the same managed VM diff when either VM is deallocated.
        self.assertEqual(classify(self.plan), ("maintenance", None))
        self.check()

    def test_initial_pair_creation_requires_armed_dependencies_and_fresh_grant(self):
        for address in (*NODES.values(), ATTACHMENT):
            self.change(address).update(actions=["create"], before=None)
        self.assertEqual(classify(self.plan), ("create", None))
        with self.assertRaises(Refused):
            self.check()
        self.approve_power_window("create")
        self.check()
        self.approval["controller_grant"]["terraformPlan"]["sha256"] = "a" * 64
        with self.assertRaisesRegex(Refused, "matching native-approved"):
            self.check()
        self.approve_power_window("create")
        self.change(ALERTS[0])["before"]["enabled"] = False
        with self.assertRaisesRegex(Refused, "armed controller"):
            self.check()

    def test_expired_saved_plan_and_expired_startup_are_rejected(self):
        for address in (*NODES.values(), ATTACHMENT):
            self.change(address).update(actions=["create"], before=None)
        self.approve_power_window("create")
        self.plan["variables"]["compute"]["value"]["startup"]["expires_at"] = (
            self.now.isoformat()
        )
        with self.assertRaisesRegex(Refused, "fresh startup"):
            self.check()
        self.now += timedelta(minutes=10)
        with self.assertRaisesRegex(Refused, "approval expired"):
            self.check()

    def test_live_status_refuses_a_cancelled_or_changed_grant(self):
        self.approve_power_window("create")
        grant = self.approval["controller_grant"]
        status = dict(
            environment="s2",
            phase="compute-maintenance",
            contest=False,
            expires=self.deadline,
            heartbeat=self.now.isoformat(),
            terraform_window=dict(
                requestId=grant["requestId"],
                terraformPlan=deepcopy(grant["terraformPlan"]),
            ),
        )
        verify_controller_status(status, self.plan, self.approval, self.now)
        status["phase"] = "draining"
        with self.assertRaisesRegex(Refused, "no longer active"):
            verify_controller_status(status, self.plan, self.approval, self.now)
        status["phase"] = "compute-maintenance"
        status["terraform_window"]["terraformPlan"]["sha256"] = "b" * 64
        with self.assertRaisesRegex(Refused, "no longer active"):
            verify_controller_status(status, self.plan, self.approval, self.now)

    def test_approved_replacement_reuses_nic_and_app_disk(self):
        for address in (NODES["app"], ATTACHMENT):
            self.change(address)["actions"] = ["delete", "create"]
        self.approve_power_window("replace", "app")
        self.check()
        self.change(ATTACHMENT)["after"]["managed_disk_id"] += "-new"
        with self.assertRaisesRegex(Refused, "same retained disk"):
            self.check()

    def test_quota_allows_only_single_delete_before_create_with_same_network(self):
        self.change(NODES["judge"])["actions"] = ["delete", "create"]
        self.approve_power_window("replace", "judge")
        self.check()
        for address, actions in (
            (NODES["app"], ["delete", "create"]),
            (NODES["judge"], ["create", "delete"]),
            (self.ip, ["create"]),
        ):
            with self.subTest(address=address):
                change = self.change(address)
                previous = change["actions"]
                change["actions"] = actions
                with self.assertRaises(Refused):
                    self.check()
                change["actions"] = previous

    def test_unapproved_destruction_refuses_existing_vm_or_retained_disk(self):
        for address in (NODES["app"], ATTACHMENT, DISK, self.ip):
            with self.subTest(address=address):
                change = self.change(address)
                change["actions"] = ["delete"]
                with self.assertRaises(Refused):
                    self.check()
                change["actions"] = ["no-op"]


if __name__ == "__main__":
    unittest.main()
