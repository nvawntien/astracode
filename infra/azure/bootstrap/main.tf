locals {
  subscription_scope = "/subscriptions/${var.target.subscription_id}"
  slots              = ["S1", "S2", "S3", "S4", "S5"]
  operator_ipv4      = toset([for cidr in var.access.operator_ipv4 : trimsuffix(cidr, "/32")])

}

data "azurerm_client_config" "current" {}

resource "terraform_data" "target" {
  input = {
    subscription_id = lower(var.target.subscription_id)
    tenant_id       = lower(var.target.tenant_id)
    slot            = var.target.slot
    location        = lower(var.target.location)
    storage_prefix  = var.target.storage_prefix
  }

  lifecycle {
    ignore_changes  = [input]
    prevent_destroy = true

    precondition {
      condition = (
        lower(data.azurerm_client_config.current.subscription_id) == lower(var.target.subscription_id) &&
        lower(data.azurerm_client_config.current.tenant_id) == lower(var.target.tenant_id)
      )
      error_message = "The provider subscription and tenant must match the approved S4 target."
    }

    postcondition {
      condition = self.output == {
        subscription_id = lower(var.target.subscription_id)
        tenant_id       = lower(var.target.tenant_id)
        slot            = var.target.slot
        location        = lower(var.target.location)
        storage_prefix  = var.target.storage_prefix
      }
      error_message = "This Terraform state is already bound to a different S4 target."
    }
  }
}

resource "azurerm_resource_group" "shared" {
  name     = "astra-s4-shared"
  location = var.target.location

  depends_on = [terraform_data.target]
}

resource "azurerm_storage_account" "shared" {
  for_each = toset(["state", "backup", "receipts"])

  name                            = "${var.target.storage_prefix}${each.key}"
  resource_group_name             = azurerm_resource_group.shared.name
  location                        = azurerm_resource_group.shared.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false
  public_network_access_enabled   = true
  default_to_oauth_authentication = true

  network_rules {
    default_action             = each.key == "receipts" ? "Allow" : "Deny"
    bypass                     = ["None"]
    ip_rules                   = each.key == "receipts" ? [] : local.operator_ipv4
    virtual_network_subnet_ids = []
  }

  dynamic "blob_properties" {
    for_each = each.key == "receipts" ? [] : [true]
    content {
      versioning_enabled = true
      delete_retention_policy {
        days = 30
      }
      container_delete_retention_policy {
        days = 30
      }
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "state" {
  for_each = toset(local.slots)

  name                  = "${lower(each.key)}-tfstate"
  storage_account_id    = azurerm_storage_account.shared["state"].id
  container_access_type = "private"

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_role_assignment" "state_operator" {
  for_each = var.access.state_operator_ids

  scope                = azurerm_storage_container.state[each.key].id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = each.value
}

resource "azurerm_storage_container" "backup" {
  name                  = "recovery"
  storage_account_id    = azurerm_storage_account.shared["backup"].id
  container_access_type = "private"

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_role_assignment" "backup_operator" {
  count = var.access.backup_operator_id == null ? 0 : 1

  scope                = azurerm_storage_container.backup.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = var.access.backup_operator_id
}

resource "azurerm_storage_container" "receipts" {
  name                  = "canonical-releases"
  storage_account_id    = azurerm_storage_account.shared["receipts"].id
  container_access_type = "private"

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container_immutability_policy" "receipts" {
  storage_container_resource_manager_id = azurerm_storage_container.receipts.id
  immutability_period_in_days           = var.access.receipt_retention_days
  locked                                = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_role_definition" "receipt_publisher" {
  name              = "AstraCode S4 receipt publisher"
  scope             = local.subscription_scope
  assignable_scopes = [azurerm_resource_group.shared.id]

  permissions {
    data_actions = [
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
    ]
  }
}

resource "azurerm_role_assignment" "receipt_publisher" {
  count = var.access.receipt_publisher_id == null ? 0 : 1

  scope              = azurerm_storage_container.receipts.id
  role_definition_id = azurerm_role_definition.receipt_publisher.role_definition_resource_id
  principal_id       = var.access.receipt_publisher_id

  depends_on = [azurerm_storage_container_immutability_policy.receipts]
}

resource "azurerm_role_assignment" "receipt_reader" {
  for_each = var.access.receipt_reader_ids

  scope                = azurerm_storage_container.receipts.id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = each.key
}

module "budget" {
  source             = "../modules/budget"
  name               = "astra-s4-monthly"
  subscription_scope = local.subscription_scope
  settings           = var.budget

  depends_on = [terraform_data.target]
}

output "state_backend" {
  value = {
    for slot in local.slots : slot => {
      storage_account_name = azurerm_storage_account.shared["state"].name
      tenant_id            = var.target.tenant_id
      container_name       = azurerm_storage_container.state[slot].name
      key                  = "terraform.tfstate"
    }
  }
}

output "receipt_container_id" {
  value = azurerm_storage_container.receipts.id
}
