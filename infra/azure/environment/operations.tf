locals {
  private_services = {
    vault = {
      resource_id = azurerm_key_vault.runtime.id
      dns_zone    = "privatelink.vaultcore.azure.net"
    }
  }
}

resource "azurerm_dev_test_global_vm_shutdown_schedule" "node" {
  for_each              = local.vm_ids
  location              = azurerm_resource_group.workload.location
  virtual_machine_id    = each.value
  enabled               = true
  daily_recurrence_time = var.operations.shutdown
  timezone              = "UTC"
  tags                  = { owner_approval = var.operations.approved }

  notification_settings {
    enabled         = true
    time_in_minutes = 30
    email           = var.operations.alert_email
  }
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
