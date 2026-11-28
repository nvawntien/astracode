locals {
  name               = "astra-${lower(var.target.slot)}"
  subscription_scope = "/subscriptions/${lower(var.target.subscription_id)}"
  vm_names           = { for role in ["app", "judge"] : role => "${local.name}-${role}" }
  vm_ids             = { for role, name in local.vm_names : role => "${local.subscription_scope}/resourceGroups/${local.name}/providers/Microsoft.Compute/virtualMachines/${name}" }

  state_target = {
    slot            = var.target.slot
    subscription_id = lower(var.target.subscription_id)
    tenant_id       = lower(var.target.tenant_id)
    location        = lower(var.target.location)
    storage_prefix  = var.target.storage_prefix
    state_container = var.target.state_container
  }
}

data "azurerm_client_config" "current" {}

resource "terraform_data" "target" {
  input = local.state_target

  lifecycle {
    ignore_changes  = [input]
    prevent_destroy = true

    precondition {
      condition = (
        lower(data.azurerm_client_config.current.subscription_id) == local.state_target.subscription_id &&
        lower(data.azurerm_client_config.current.tenant_id) == local.state_target.tenant_id
      )
      error_message = "The provider subscription and tenant must match the approved environment target."
    }

    postcondition {
      condition     = self.output == local.state_target
      error_message = "This Terraform state is already bound to a different environment target."
    }
  }
}

resource "azurerm_resource_group" "workload" {
  name     = local.name
  location = var.target.location

  depends_on = [terraform_data.target]
}

resource "azurerm_resource_group" "operations" {
  name     = "${local.name}-ops"
  location = var.target.location

  depends_on = [terraform_data.target]
}

# Power roles must work before either VM exists. Reserve the workload RG for
# the named pair so the resource-group assignments cannot pick up another VM.
resource "azurerm_policy_definition" "vm_names" {
  name         = "${local.name}-vm-names"
  display_name = "${local.name} permitted VM names"
  policy_type  = "Custom"
  mode         = "All"

  policy_rule = jsonencode({
    if = {
      allOf = [
        { field = "type", equals = "Microsoft.Compute/virtualMachines" },
        { field = "name", notIn = values(local.vm_names) },
      ]
    }
    then = { effect = "deny" }
  })

  depends_on = [terraform_data.target]
}

resource "azurerm_resource_group_policy_assignment" "vm_names" {
  name                 = "${local.name}-vm-names"
  resource_group_id    = azurerm_resource_group.workload.id
  policy_definition_id = azurerm_policy_definition.vm_names.id
  enforce              = true
}

module "budget" {
  source             = "../modules/budget"
  name               = "${local.name}-monthly"
  subscription_scope = local.subscription_scope
  settings           = var.budget

  depends_on = [terraform_data.target]
}

output "plan_target" {
  description = "Target values to compare to the reviewed backend and saved plan independently of the Azure login."
  value = {
    slot            = var.target.slot
    subscription_id = local.state_target.subscription_id
    tenant_id       = local.state_target.tenant_id
    resource_group  = azurerm_resource_group.workload.name
    state_container = var.target.state_container
    state_key       = "terraform.tfstate"
  }
}

output "vm_ids" {
  description = "Exact precomputable names for approved scheduling and observed power-state checks."
  value       = local.vm_ids
}


output "app_subnet_id" {
  description = "App source subnet for the separately scoped S4 receipt firewall."
  value       = azurerm_subnet.network["app"].id
}

output "receipt_reader_principal_id" {
  value = azurerm_user_assigned_identity.runtime["app-receipts"].principal_id
}

output "deployment_client_id" {
  value = try(azurerm_user_assigned_identity.delivery[0].client_id, null)
}
