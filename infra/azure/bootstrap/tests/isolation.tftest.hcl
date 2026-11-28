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
        account.public_network_access_enabled &&
        !account.shared_access_key_enabled && !account.allow_nested_items_to_be_public &&
        account.https_traffic_only_enabled && account.min_tls_version == "TLS1_2" &&
        account.default_to_oauth_authentication &&
        toset(one(account.network_rules).bypass) == toset(["None"])
      ]) &&
      alltrue([for purpose in ["state", "backup"] :
        one(azurerm_storage_account.shared[purpose].network_rules).default_action == "Deny" &&
        toset(one(azurerm_storage_account.shared[purpose].network_rules).ip_rules) ==
        toset([for cidr in var.access.operator_ipv4 : trimsuffix(cidr, "/32")]) &&
        length(one(azurerm_storage_account.shared[purpose].network_rules).virtual_network_subnet_ids) == 0
      ]) &&
      one(azurerm_storage_account.shared["receipts"].network_rules).default_action == "Allow" &&
      length(one(azurerm_storage_account.shared["receipts"].network_rules).ip_rules) == 0 &&
      length(one(azurerm_storage_account.shared["receipts"].network_rules).virtual_network_subnet_ids) == 0
    )
    error_message = "Only authenticated receipt access can use ordinary Internet egress. State and backup must allow only the operator firewall ranges."
  }

  assert {
    condition = (
      length(azurerm_storage_container.state) == 5 &&
      output.state_backend.S2.container_name != output.state_backend.S3.container_name &&
      azurerm_storage_container.receipts.container_access_type == "private" &&
      azurerm_storage_container_immutability_policy.receipts.locked &&
      toset(one(azurerm_role_definition.receipt_publisher.permissions).data_actions) == toset([
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write"
      ]) &&
      length(azurerm_role_assignment.state_operator) == 3 &&
      length(azurerm_role_assignment.backup_operator) == 1 &&
      length(azurerm_role_assignment.receipt_publisher) == 1 &&
      length(azurerm_role_assignment.receipt_reader) == 1
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

run "bootstrap_before_optional_principals_exist" {
  command = plan

  variables {
    access = {
      operator_ipv4          = var.access.operator_ipv4
      state_operator_ids     = var.access.state_operator_ids
      receipt_retention_days = var.access.receipt_retention_days
    }
  }

  assert {
    condition = (
      length(azurerm_role_assignment.state_operator) == 3 &&
      length(azurerm_role_assignment.backup_operator) == 0 &&
      length(azurerm_role_assignment.receipt_publisher) == 0 &&
      length(azurerm_role_assignment.receipt_reader) == 0 &&
      azurerm_storage_container_immutability_policy.receipts.locked
    )
    error_message = "First bootstrap must prepare state and lock receipts without granting access to an unknown or unapproved principal."
  }
}

run "reject_receipt_reader_with_writer_access" {
  command = plan

  variables {
    access = merge(var.access, { receipt_reader_ids = [upper(var.access.receipt_publisher_id)] })
  }

  expect_failures = [var.access]
}

run "reject_globally_open_operator_firewall" {
  command = plan

  variables {
    access = merge(var.access, { operator_ipv4 = ["0.0.0.0/0"] })
  }

  expect_failures = [var.access]
}
