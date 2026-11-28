terraform {
  backend "azurerm" {
    use_azuread_auth = true
    container_name   = "s4-tfstate"
    key              = "terraform.tfstate"
  }
}
