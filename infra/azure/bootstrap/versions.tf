terraform {
  required_version = "= 1.13.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "= 4.59.0"
    }
  }
}

provider "azurerm" {
  subscription_id                 = var.target.subscription_id
  tenant_id                       = var.target.tenant_id
  storage_use_azuread             = true
  resource_provider_registrations = "none"
  features {}
}
