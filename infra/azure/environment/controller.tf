locals {
  private_services = {
    blob = {
      resource_id = azurerm_storage_account.controller.id
      dns_zone    = "privatelink.blob.core.windows.net"
    }
    vault = {
      resource_id = azurerm_key_vault.runtime.id
      dns_zone    = "privatelink.vaultcore.azure.net"
    }
  }
}

resource "azurerm_storage_account" "controller" {
  name                            = "${var.target.storage_prefix}controller"
  resource_group_name             = azurerm_resource_group.operations.name
  location                        = azurerm_resource_group.operations.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true
  public_network_access_enabled   = false

  blob_properties {
    delete_retention_policy {
      days = 14
    }
    container_delete_retention_policy {
      days = 14
    }
  }
}

resource "azurerm_storage_container" "controller" {
  for_each = toset(["controller-state", "controller-package"])

  name                  = each.key
  storage_account_id    = azurerm_storage_account.controller.id
  container_access_type = "private"
}

resource "azurerm_private_dns_zone" "service" {
  for_each = local.private_services

  name                = each.value.dns_zone
  resource_group_name = azurerm_resource_group.operations.name
}

resource "azurerm_private_dns_zone_virtual_network_link" "service" {
  for_each = local.private_services

  name                  = "${local.name}-${each.key}-link"
  resource_group_name   = azurerm_resource_group.operations.name
  private_dns_zone_name = azurerm_private_dns_zone.service[each.key].name
  virtual_network_id    = azurerm_virtual_network.environment.id
}

resource "azurerm_private_endpoint" "service" {
  for_each = local.private_services

  name                = "${local.name}-${each.key}-private"
  resource_group_name = azurerm_resource_group.operations.name
  location            = azurerm_resource_group.operations.location
  subnet_id           = azurerm_subnet.network["private-endpoints"].id

  private_service_connection {
    name                           = each.key
    private_connection_resource_id = each.value.resource_id
    subresource_names              = [each.key]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = each.key
    private_dns_zone_ids = [azurerm_private_dns_zone.service[each.key].id]
  }
}

resource "azurerm_role_assignment" "controller_storage" {
  # The Functions host creates and owns its host and lease containers.
  scope                = azurerm_storage_account.controller.id
  role_definition_name = "Storage Blob Data Owner"
  principal_id         = azurerm_user_assigned_identity.runtime["controller"].principal_id
}

resource "azurerm_service_plan" "controller" {
  name                = "${local.name}-controller"
  resource_group_name = azurerm_resource_group.operations.name
  location            = azurerm_resource_group.operations.location
  os_type             = "Linux"
  sku_name            = "FC1"
}

resource "azurerm_function_app_flex_consumption" "controller" {
  name                = local.controller_name
  resource_group_name = azurerm_resource_group.operations.name
  location            = azurerm_resource_group.operations.location
  service_plan_id     = azurerm_service_plan.controller.id

  virtual_network_subnet_id                      = azurerm_subnet.network["controller"].id
  storage_container_type                         = "blobContainer"
  storage_container_endpoint                     = "${azurerm_storage_account.controller.primary_blob_endpoint}${azurerm_storage_container.controller["controller-package"].name}"
  storage_authentication_type                    = "UserAssignedIdentity"
  storage_user_assigned_identity_id              = azurerm_user_assigned_identity.runtime["controller"].id
  runtime_name                                   = "python"
  runtime_version                                = "3.11"
  maximum_instance_count                         = 10
  instance_memory_in_mb                          = 512
  https_only                                     = true
  public_network_access_enabled                  = var.controller.armed
  webdeploy_publish_basic_authentication_enabled = false

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.runtime["controller"].id]
  }

  auth_settings_v2 {
    auth_enabled           = true
    require_authentication = true
    unauthenticated_action = "Return401"
    require_https          = true
    active_directory_v2 {
      client_id                       = var.controller.api_client_id
      tenant_auth_endpoint            = "https://login.microsoftonline.com/${var.target.tenant_id}/v2.0"
      allowed_audiences               = ["api://${var.controller.api_client_id}"]
      jwt_allowed_client_applications = setunion(var.controller.caller_client_ids, [azurerm_user_assigned_identity.runtime["app-poller"].client_id])
    }
    login {
      token_store_enabled = false
    }
  }

  site_config {
    minimum_tls_version                    = "1.2"
    application_insights_connection_string = azurerm_application_insights.controller.connection_string
  }

  app_settings = {
    AzureWebJobsStorage__accountName          = azurerm_storage_account.controller.name
    AzureWebJobsStorage__credential           = "managedidentity"
    AzureWebJobsStorage__clientId             = azurerm_user_assigned_identity.runtime["controller"].client_id
    APPLICATIONINSIGHTS_AUTHENTICATION_STRING = "Authorization=AAD;ClientId=${azurerm_user_assigned_identity.runtime["controller"].client_id}"
    ASTRA_ENVIRONMENT                         = var.target.slot
    ASTRA_CONTROLLER_MODE                     = var.target.slot == "S3" ? "rehearsal" : "staging"
    ASTRA_TARGET_VM_IDS                       = jsonencode(local.vm_ids)
    ASTRA_CONTROLLER_BLOB_ENDPOINT            = azurerm_storage_account.controller.primary_blob_endpoint
    ASTRA_CONTROLLER_STATE_CONTAINER          = azurerm_storage_container.controller["controller-state"].name
  }

  depends_on = [
    azurerm_private_endpoint.service,
    azurerm_private_dns_zone_virtual_network_link.service,
    azurerm_role_assignment.controller_storage,
    azurerm_role_assignment.controller_monitor,
    azurerm_subnet_nat_gateway_association.controller,
  ]
}
