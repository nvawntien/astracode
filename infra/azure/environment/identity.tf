locals {
  power_actions = [
    "Microsoft.Compute/virtualMachines/read",
    "Microsoft.Compute/virtualMachines/instanceView/read",
    "Microsoft.Compute/virtualMachines/deallocate/action",
  ]
  power_roles = {
    controller = {
      actions      = concat(local.power_actions, var.target.slot == "S2" ? ["Microsoft.Compute/virtualMachines/start/action"] : [])
      principal_id = azurerm_user_assigned_identity.runtime["controller"].principal_id
    }
    emergency = {
      actions      = local.power_actions
      principal_id = var.controller.emergency_object_id
    }
  }
}

resource "azurerm_user_assigned_identity" "runtime" {
  for_each = toset(["controller", "app-poller", "app-secret-loader"])

  name                = "${local.name}-${each.key}"
  location            = azurerm_resource_group.operations.location
  resource_group_name = azurerm_resource_group.operations.name
}

resource "azurerm_role_definition" "power" {
  for_each = local.power_roles

  name              = "AstraCode ${var.target.slot} ${each.key} VM power"
  scope             = local.subscription_scope
  assignable_scopes = [azurerm_resource_group.workload.id]

  permissions {
    actions = each.value.actions
  }
}

resource "azurerm_role_assignment" "power" {
  for_each = local.power_roles

  scope              = azurerm_resource_group.workload.id
  role_definition_id = azurerm_role_definition.power[each.key].role_definition_resource_id
  principal_id       = each.value.principal_id

  depends_on = [azurerm_resource_group_policy_assignment.vm_names]
}

resource "azurerm_key_vault" "runtime" {
  name                          = "${var.target.storage_prefix}-vault"
  resource_group_name           = azurerm_resource_group.operations.name
  location                      = azurerm_resource_group.operations.location
  tenant_id                     = var.target.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = true
  soft_delete_retention_days    = 30
  public_network_access_enabled = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_role_assignment" "runtime_secret" {
  for_each = var.runtime_secret_names

  scope                = "${azurerm_key_vault.runtime.id}/secrets/${each.key}"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.runtime["app-secret-loader"].principal_id
}
