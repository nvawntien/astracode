variable "access" {}

mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      subscription_id = "00000000-0000-0000-0000-000000000004"
      tenant_id       = "00000000-0000-0000-0000-000000000010"
    }
  }
}

run "separate_storage_and_principals" {
  command = plan

  assert {
    condition = (
      length(azurerm_storage_account.shared) == 3 &&
      alltrue([for account in azurerm_storage_account.shared :
        !account.shared_access_key_enabled && !account.allow_nested_items_to_be_public &&
        one(account.network_rules).default_action == "Deny"
      ]) &&
      one(azurerm_storage_account.shared["state"].network_rules).ip_rules !=
      one(azurerm_storage_account.shared["receipts"].network_rules).ip_rules
    )
    error_message = "State, backup and receipt access must be separate, network-restricted and Entra-only."
  }

  assert {
    condition = (
      length(azurerm_storage_container.state) == 5 &&
      output.state_backend.S2.container_name != output.state_backend.S3.container_name &&
      azurerm_storage_container.receipts.container_access_type == "private" &&
      azurerm_storage_container_immutability_policy.receipts.locked &&
      !contains(one(azurerm_role_definition.receipt_publisher.permissions).data_actions,
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete")
    )
    error_message = "Each slot requires an independent state container and receipt publishers must not be able to replace or delete accepted receipts."
  }
}

run "reject_wrong_subscription" {
  command = plan

  override_data {
    target = data.azurerm_client_config.current
    values = {
      subscription_id = "00000000-0000-0000-0000-000000000099"
      tenant_id       = "00000000-0000-0000-0000-000000000010"
    }
  }

  expect_failures = [terraform_data.target]
}

run "reject_shared_receipt_and_state_identity" {
  command = plan

  variables {
    access = merge(var.access, { receipt_publisher_id = var.access.state_operator_ids.S2 })
  }

  expect_failures = [var.access]
}
