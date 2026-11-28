variable "approved_subscription_ids" {}
variable "operations" {}
variable "network" {}
variable "target" {}

mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      subscription_id = "00000000-0000-0000-0000-000000000002"
      tenant_id       = "00000000-0000-0000-0000-000000000010"
    }
  }
}

run "prepare_native_shutdown_before_compute" {
  command = plan

  assert {
    condition = (
      length(azurerm_linux_virtual_machine.node) == 0 &&
      length(azurerm_virtual_machine_data_disk_attachment.app) == 0 &&
      azurerm_managed_disk.app.disk_size_gb == 64 &&
      !azurerm_managed_disk.app.public_network_access_enabled &&
      length(azurerm_dev_test_global_vm_shutdown_schedule.node) == 2 &&
      alltrue([for schedule in azurerm_dev_test_global_vm_shutdown_schedule.node :
      schedule.enabled && schedule.timezone == "UTC" && schedule.daily_recurrence_time == var.operations.shutdown])
    )
    error_message = "Prepare the retained disk and exact pair's native schedules before creating VMs."
  }

  assert {
    condition = (
      alltrue([for s in azurerm_subnet.network : !s.default_outbound_access_enabled]) &&
      length(azurerm_public_ip.node) == 2 &&
      alltrue([for rule in azurerm_network_security_group.node["judge"].security_rule :
        rule.direction != "Inbound" || rule.access != "Allow" || contains(["Flannel", "Kubelet"], rule.name)
      ]) &&
      !azurerm_key_vault.runtime.public_network_access_enabled
    )
    error_message = "Keep egress explicit, Judge ingress private and Key Vault network restricted."
  }

  assert {
    condition = (
      !contains(one(azurerm_role_definition.emergency.permissions).actions, "Microsoft.Compute/virtualMachines/start/action") &&
      contains(one(azurerm_role_definition.emergency.permissions).actions, "Microsoft.Compute/virtualMachines/deallocate/action") &&
      azurerm_resource_group_policy_assignment.vm_names.enforce
    )
    error_message = "Emergency permissions are pair-scoped and deallocate-only."
  }
}

run "s3_stays_in_separate_state" {
  command = plan

  variables {
    target = merge(var.target, {
      slot            = "S3"
      subscription_id = var.approved_subscription_ids.S3
      state_container = "s3-tfstate"
    })
  }

  override_data {
    target = data.azurerm_client_config.current
    values = {
      subscription_id = "00000000-0000-0000-0000-000000000003"
      tenant_id       = "00000000-0000-0000-0000-000000000010"
    }
  }

  assert {
    condition = (
      output.plan_target.state_container == "s3-tfstate" &&
      azurerm_dev_test_global_vm_shutdown_schedule.node["app"].virtual_machine_id == output.vm_ids.app &&
      length(azurerm_role_assignment.delivery) == 0
    )
    error_message = "S3 must target its own state and schedules with federated delivery inactive by default."
  }
}

run "reject_wrong_tenant" {
  command = plan

  override_data {
    target = data.azurerm_client_config.current
    values = {
      subscription_id = "00000000-0000-0000-0000-000000000002"
      tenant_id       = "00000000-0000-0000-0000-000000000099"
    }
  }

  expect_failures = [terraform_data.target]
}

run "reject_state_slot_mismatch" {
  command = plan

  variables {
    target = merge(var.target, { state_container = "s3-tfstate" })
  }

  expect_failures = [var.target]
}

run "reject_subscription_slot_mismatch" {
  command = plan

  variables {
    target = merge(var.target, { slot = "S3", state_container = "s3-tfstate" })
  }

  expect_failures = [var.target]
}

run "reject_k3s_network_overlap" {
  command = plan

  variables {
    network = merge(var.network, { vnet_cidr = "10.43.128.0/24" })
  }

  expect_failures = [terraform_data.compute_admission]
}

run "reject_stale_boundary_for_compute" {
  command = plan

  variables {
    compute = {
      enabled        = true
      app_data_uuid  = "00000000-0000-4000-8000-000000000001"
      ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      os_image = {
        publisher = "Canonical"
        offer     = "ubuntu-24_04-lts"
        sku       = "server"
        version   = "24.04.1"
      }
      startup = {
        approval_ref = "synthetic-approval"
        target_vm_ids = [
          "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/astra-s2/providers/Microsoft.Compute/virtualMachines/astra-s2-app",
          "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/astra-s2/providers/Microsoft.Compute/virtualMachines/astra-s2-judge",
        ]
        expires_at = "9999-01-01T00:00:00Z"
      }
    }
  }

  expect_failures = [terraform_data.compute_admission]
}

run "plan_only_the_approved_vm_pair" {
  command = plan

  variables {
    compute = {
      enabled        = true
      app_data_uuid  = "00000000-0000-4000-8000-000000000001"
      ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      os_image = {
        publisher = "Canonical"
        offer     = "ubuntu-24_04-lts"
        sku       = "server"
        version   = "24.04.1"
      }
      startup = {
        approval_ref = "synthetic-approval"
        target_vm_ids = [
          "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/astra-s2/providers/Microsoft.Compute/virtualMachines/astra-s2-app",
          "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/astra-s2/providers/Microsoft.Compute/virtualMachines/astra-s2-judge",
        ]
        expires_at = timeadd(timestamp(), "10m")
      }
    }
  }

  assert {
    condition = (
      toset(keys(azurerm_linux_virtual_machine.node)) == toset(["app", "judge"]) &&
      azurerm_linux_virtual_machine.node["app"].size == "Standard_B4s_v2" &&
      azurerm_linux_virtual_machine.node["judge"].size == "Standard_B2ls_v2" &&
      length(azurerm_virtual_machine_data_disk_attachment.app) == 1 &&
      length(azurerm_linux_virtual_machine.node["app"].identity) == 1 &&
      length(azurerm_linux_virtual_machine.node["judge"].identity) == 0
    )
    error_message = "An approved compute plan must provision the exact App/Judge pair and attach storage and runtime identities to App only."
  }
}

run "reject_window_without_off_time_margin" {
  command = plan
  variables {
    operations = merge(var.operations, { earliest_start = "0600", shutdown = "1830" })
  }
  expect_failures = [var.operations]
}

run "delivery_role_cannot_start_or_deallocate" {
  command = plan
  variables {
    operations = merge(var.operations, {
      deployment_subject = "repository_id:2:environment:s2-delivery:ref:refs/heads/main:workflow_ref:example/astra/.github/workflows/staging-deploy.yml@refs/heads/main"
    })
  }
  assert {
    condition = (
      toset(one(azurerm_role_definition.delivery[0].permissions).actions) == toset([
        "Microsoft.Compute/virtualMachines/read",
        "Microsoft.Compute/virtualMachines/runCommand/action",
      ]) &&
      length(azurerm_role_assignment.delivery) == 0
    )
    error_message = "Delivery is narrowly scoped, and the role assignment awaits separate activation."
  }
}
