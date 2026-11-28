locals {
  subnet_indices = { app = 0, judge = 1, private-endpoints = 3 }
  subnet_cidrs   = { for name, index in local.subnet_indices : name => cidrsubnet(var.network.vnet_cidr, 3, index) }
  node_ips       = { for role in keys(local.vm_names) : role => cidrhost(local.subnet_cidrs[role], 4) }

  common_egress = [
    { name = "DNS-UDP", protocol = "Udp", port = "53", prefixes = ["AzurePlatformDNS"] },
    { name = "DNS-TCP", protocol = "Tcp", port = "53", prefixes = ["AzurePlatformDNS"] },
    { name = "NTP", protocol = "Udp", port = "123", prefixes = ["Internet"] },
    { name = "HTTPS", protocol = "Tcp", port = "443", prefixes = ["Internet"] },
  ]
  peer_rules = { for role, peer in { app = "judge", judge = "app" } : role => [
    { name = "Flannel", protocol = "Udp", port = "8472", prefixes = [local.node_ips[peer]] },
    { name = "Kubelet", protocol = "Tcp", port = "10250", prefixes = [local.node_ips[peer]] },
  ] }
  node_ingress = {
    app = concat(local.peer_rules.app, [
      { name = "Kubernetes-API", protocol = "Tcp", port = "6443", prefixes = [local.node_ips.judge] },
      ], length(var.network.tester_ipv4) == 0 ? [] : [
      { name = "Tester-HTTPS", protocol = "Tcp", port = "443", prefixes = sort(tolist(var.network.tester_ipv4)) },
    ])
    judge = local.peer_rules.judge
  }
  node_egress = {
    app = concat(local.common_egress, local.peer_rules.app, [
      { name = "Private-HTTPS", protocol = "Tcp", port = "443", prefixes = [local.subnet_cidrs["private-endpoints"]] },
      { name = "App-Host-Identity", protocol = "Tcp", port = "80", prefixes = ["AzurePlatformIMDS"] },
    ])
    judge = concat(local.common_egress, local.peer_rules.judge, [
      { name = "Kubernetes-API", protocol = "Tcp", port = "6443", prefixes = [local.node_ips.app] },
    ])
  }
}

resource "azurerm_virtual_network" "environment" {
  name                = "${local.name}-vnet"
  resource_group_name = azurerm_resource_group.workload.name
  location            = azurerm_resource_group.workload.location
  address_space       = [var.network.vnet_cidr]
}

resource "azurerm_subnet" "network" {
  for_each = local.subnet_cidrs

  name                            = each.key
  resource_group_name             = azurerm_resource_group.workload.name
  virtual_network_name            = azurerm_virtual_network.environment.name
  address_prefixes                = [each.value]
  default_outbound_access_enabled = false
  service_endpoints               = each.key == "app" && var.target.slot == "S2" ? ["Microsoft.Storage.Global"] : []
}

resource "azurerm_network_security_group" "node" {
  for_each = local.vm_names

  name                = "${each.value}-nsg"
  resource_group_name = azurerm_resource_group.workload.name
  location            = azurerm_resource_group.workload.location

  dynamic "security_rule" {
    for_each = local.node_ingress[each.key]
    content {
      name                       = security_rule.value.name
      priority                   = 100 + security_rule.key
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = security_rule.value.protocol
      source_port_range          = "*"
      destination_port_range     = security_rule.value.port
      source_address_prefix      = length(security_rule.value.prefixes) == 1 ? security_rule.value.prefixes[0] : null
      source_address_prefixes    = length(security_rule.value.prefixes) > 1 ? security_rule.value.prefixes : null
      destination_address_prefix = "*"
    }
  }

  dynamic "security_rule" {
    for_each = local.node_egress[each.key]
    content {
      name                       = "Egress-${security_rule.value.name}"
      priority                   = 100 + security_rule.key
      direction                  = "Outbound"
      access                     = "Allow"
      protocol                   = security_rule.value.protocol
      source_port_range          = "*"
      destination_port_range     = security_rule.value.port
      source_address_prefix      = "*"
      destination_address_prefix = security_rule.value.prefixes[0]
    }
  }

  dynamic "security_rule" {
    for_each = toset(["Inbound", "Outbound"])
    content {
      name                       = "Deny-Remaining-${security_rule.value}"
      priority                   = 4096
      direction                  = security_rule.value
      access                     = "Deny"
      protocol                   = "*"
      source_port_range          = "*"
      destination_port_range     = "*"
      source_address_prefix      = "*"
      destination_address_prefix = "*"
    }
  }
}

resource "azurerm_subnet_network_security_group_association" "node" {
  for_each = local.vm_names

  subnet_id                 = azurerm_subnet.network[each.key].id
  network_security_group_id = azurerm_network_security_group.node[each.key].id
}

resource "azurerm_public_ip" "node" {
  for_each = local.vm_names

  name                = "${each.value}-ipv4"
  resource_group_name = azurerm_resource_group.workload.name
  location            = azurerm_resource_group.workload.location
  allocation_method   = "Static"
  sku                 = "Standard"
  ip_version          = "IPv4"
}

resource "azurerm_network_interface" "node" {
  for_each = local.vm_names

  name                = "${each.value}-nic"
  resource_group_name = azurerm_resource_group.workload.name
  location            = azurerm_resource_group.workload.location

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.network[each.key].id
    private_ip_address_allocation = "Static"
    private_ip_address            = local.node_ips[each.key]
    public_ip_address_id          = azurerm_public_ip.node[each.key].id
  }
}
