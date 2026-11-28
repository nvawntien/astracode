locals {
  power_actions = [
    "Microsoft.Compute/virtualMachines/read",
    "Microsoft.Compute/virtualMachines/instanceView/read",
    "Microsoft.Compute/virtualMachines/deallocate/action",
  ]
}

resource "azurerm_user_assigned_identity" "runtime" {
  for_each = toset(["app-receipts", "app-secret-loader"])

  name                = "${local.name}-${each.key}"
  location            = azurerm_resource_group.operations.location
  resource_group_name = azurerm_resource_group.operations.name
}

resource "azurerm_role_definition" "emergency" {
  name              = "AstraCode ${var.target.slot} emergency VM deallocation"
  scope             = local.subscription_scope
  assignable_scopes = [azurerm_resource_group.workload.id]

  permissions {
    actions = local.power_actions
  }
}

resource "azurerm_role_assignment" "emergency" {
  scope              = azurerm_resource_group.workload.id
  role_definition_id = azurerm_role_definition.emergency.role_definition_resource_id
  principal_id       = var.operations.emergency_id

  depends_on = [azurerm_resource_group_policy_assignment.vm_names]
}

resource "azurerm_user_assigned_identity" "delivery" {
  count               = var.operations.deployment_subject != null ? 1 : 0
  name                = "${local.name}-delivery"
  location            = azurerm_resource_group.operations.location
  resource_group_name = azurerm_resource_group.operations.name
}

resource "azurerm_federated_identity_credential" "delivery" {
  count               = length(azurerm_user_assigned_identity.delivery)
  name                = "protected-deployment"
  parent_id           = azurerm_user_assigned_identity.delivery[0].id
  resource_group_name = azurerm_resource_group.operations.name
  audience            = ["api://AzureADTokenExchange"]
  issuer              = "https://token.actions.githubusercontent.com"
  subject             = var.operations.deployment_subject

  lifecycle {
    precondition {
      condition     = can(regex("^repository_id:[0-9]+:environment:${lower(var.target.slot)}-delivery:ref:refs/heads/main:workflow_ref:[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+/[.]github/workflows/staging-deploy[.]yml@refs/heads/main$", var.operations.deployment_subject))
      error_message = "Delivery federation must bind the immutable repository ID, protected environment, main ref and staging deployment workflow."
    }
  }
}

resource "azurerm_role_definition" "delivery" {
  count             = length(azurerm_user_assigned_identity.delivery)
  name              = "AstraCode ${var.target.slot} App guest delivery"
  scope             = local.subscription_scope
  assignable_scopes = [azurerm_resource_group.workload.id]

  permissions {
    actions = ["Microsoft.Compute/virtualMachines/read", "Microsoft.Compute/virtualMachines/runCommand/action"]
  }
}

resource "azurerm_role_assignment" "delivery" {
  count              = var.operations.deployment_active && var.compute.enabled ? length(azurerm_user_assigned_identity.delivery) : 0
  scope              = azurerm_linux_virtual_machine.node["app"].id
  role_definition_id = azurerm_role_definition.delivery[0].role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.delivery[0].principal_id
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
