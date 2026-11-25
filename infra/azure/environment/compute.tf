locals {
  os_disk_gib = {
    app   = var.compute.app_os_disk_gib
    judge = var.compute.judge_os_disk_gib
  }
  vm_sizes = {
    app   = var.compute.app_size
    judge = var.compute.judge_size
  }
}

resource "terraform_data" "compute_admission" {
  input = var.compute.enabled

  lifecycle {
    precondition {
      condition = !var.compute.enabled || try(
        var.controller.armed &&
        trimspace(var.compute.startup.approval_ref) != "" &&
        lower(var.compute.startup.controller_id) == lower(local.controller_id) &&
        toset([for id in var.compute.startup.target_vm_ids : lower(id)]) == toset([for id in values(local.vm_ids) : lower(id)]) &&
        timecmp(var.compute.startup.expires_at, plantimestamp()) > 0 &&
        timecmp(var.compute.startup.expires_at, timeadd(plantimestamp(), "30m")) <= 0,
        false
      )
      error_message = "Before enabling compute, verify the controller is armed for exactly the approved VM pair and supply its startup approval with a deadline within 30 minutes."
    }

    precondition {
      condition = !var.compute.enabled || try(
        can(regex("^ssh-(ed25519|rsa) +[A-Za-z0-9+/=]+", var.compute.ssh_public_key)) &&
        can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.compute.os_image.version)),
        false
      )
      error_message = "Enabling compute requires an SSH public key and a pinned Marketplace image version."
    }
  }
}

resource "azurerm_managed_disk" "app" {
  name                          = "${local.vm_names.app}-data"
  resource_group_name           = azurerm_resource_group.workload.name
  location                      = azurerm_resource_group.workload.location
  storage_account_type          = "StandardSSD_LRS"
  create_option                 = "Empty"
  disk_size_gb                  = var.compute.app_data_disk_gib
  public_network_access_enabled = false
  network_access_policy         = "DenyAll"

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_linux_virtual_machine" "node" {
  for_each = var.compute.enabled ? local.vm_names : {}

  name                            = each.value
  resource_group_name             = azurerm_resource_group.workload.name
  location                        = azurerm_resource_group.workload.location
  size                            = local.vm_sizes[each.key]
  admin_username                  = "astraops"
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.node[each.key].id]

  admin_ssh_key {
    username   = "astraops"
    public_key = var.compute.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = local.os_disk_gib[each.key]
  }

  source_image_reference {
    publisher = var.compute.os_image.publisher
    offer     = var.compute.os_image.offer
    sku       = var.compute.os_image.sku
    version   = var.compute.os_image.version
  }

  dynamic "identity" {
    for_each = each.key == "app" ? [true] : []
    content {
      type = "UserAssigned"
      identity_ids = [
        azurerm_user_assigned_identity.runtime["app-poller"].id,
        azurerm_user_assigned_identity.runtime["app-secret-loader"].id,
      ]
    }
  }

  lifecycle {
    precondition {
      condition     = try(timecmp(var.compute.startup.expires_at, timestamp()) > 0, false)
      error_message = "The startup approval deadline has passed. Obtain a new verified controller approval before applying."
    }
  }

  depends_on = [
    terraform_data.compute_admission,
    azurerm_monitor_scheduled_query_rules_alert_v2.heartbeat,
    azurerm_resource_group_policy_assignment.vm_names,
    azurerm_role_assignment.power,
    azurerm_subnet_network_security_group_association.node,
  ]
}

resource "azurerm_virtual_machine_data_disk_attachment" "app" {
  count = var.compute.enabled ? 1 : 0

  managed_disk_id    = azurerm_managed_disk.app.id
  virtual_machine_id = azurerm_linux_virtual_machine.node["app"].id
  lun                = 0
  caching            = "None"
}
