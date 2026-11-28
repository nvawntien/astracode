variable "approved_subscription_ids" {}
variable "controller" {}
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

run "prepare_operations_before_compute" {
  command = plan

  assert {
    condition = (
      length(azurerm_linux_virtual_machine.node) == 0 &&
      length(azurerm_virtual_machine_data_disk_attachment.app) == 0 &&
      azurerm_managed_disk.app.disk_size_gb == 64 &&
      !azurerm_managed_disk.app.public_network_access_enabled &&
      !azurerm_function_app_flex_consumption.controller.public_network_access_enabled &&
      !azurerm_monitor_scheduled_query_rules_alert_v2.heartbeat.enabled &&
      azurerm_function_app_flex_consumption.controller.storage_authentication_type == "UserAssignedIdentity"
    )
    error_message = "Prepare private durable storage, controller and alert infrastructure before arming or creating compute."
  }

  assert {
    condition = (
      alltrue([for subnet in azurerm_subnet.network : !subnet.default_outbound_access_enabled]) &&
      length(azurerm_public_ip.node) == 2 &&
      azurerm_nat_gateway.controller.sku_name == "Standard" &&
      alltrue([for rule in azurerm_network_security_group.node["judge"].security_rule :
        rule.direction != "Inbound" || rule.access != "Allow" || contains(["Flannel", "Kubelet"], rule.name)
      ]) &&
      !azurerm_key_vault.runtime.public_network_access_enabled &&
      !azurerm_storage_account.controller.shared_access_key_enabled
    )
    error_message = "Node egress must be explicit, Judge ingress private and shared secrets/state network restricted."
  }

  assert {
    condition = (
      contains(one(azurerm_role_definition.power["controller"].permissions).actions, "Microsoft.Compute/virtualMachines/start/action") &&
      !contains(one(azurerm_role_definition.power["emergency"].permissions).actions, "Microsoft.Compute/virtualMachines/start/action") &&
      azurerm_resource_group_policy_assignment.vm_names.enforce
    )
    error_message = "The S2 controller and emergency operator must have different, pair-scoped power authority."
  }
}

run "s3_has_deallocate_only_controller" {
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
      azurerm_function_app_flex_consumption.controller.app_settings.ASTRA_CONTROLLER_MODE == "rehearsal" &&
      toset(one(azurerm_role_definition.power["controller"].permissions).actions) ==
      toset(one(azurerm_role_definition.power["emergency"].permissions).actions)
    )
    error_message = "The S3 rehearsal controller must not be able to start VMs or use S2 state."
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

run "reject_startup_approval_for_unarmed_compute" {
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
        approval_ref  = "synthetic-approval"
        controller_id = "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/astra-s2-ops/providers/Microsoft.Web/sites/astras2mock-controller"
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
    controller = merge(var.controller, { armed = true })
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
        approval_ref  = "synthetic-approval"
        controller_id = "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/astra-s2-ops/providers/Microsoft.Web/sites/astras2mock-controller"
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
    error_message = "An armed compute plan must provision the exact App/Judge pair and attach storage and runtime identities to App only."
  }
}
