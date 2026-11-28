terraform {
  required_providers {
    azurerm = {
      source = "hashicorp/azurerm"
    }
  }
}

variable "name" {
  type = string
}

variable "subscription_scope" {
  type = string
}

variable "settings" {
  type = object({
    amount    = number
    starts_at = string
    email     = set(string)
  })

  validation {
    condition     = var.settings.amount > 0 && length(var.settings.email) > 0 && can(regex("^\\d{4}-\\d{2}-01T00:00:00Z$", var.settings.starts_at))
    error_message = "Set a positive monthly budget, recipients and a UTC start at midnight on the first of a month."
  }
}

resource "azurerm_consumption_budget_subscription" "monthly" {
  name            = var.name
  subscription_id = var.subscription_scope
  amount          = var.settings.amount
  time_grain      = "Monthly"

  time_period {
    start_date = var.settings.starts_at
  }

  dynamic "notification" {
    for_each = toset([50, 80, 100])
    content {
      enabled        = true
      threshold      = notification.value
      operator       = "GreaterThanOrEqualTo"
      threshold_type = "Actual"
      contact_emails = var.settings.email
    }
  }
}
