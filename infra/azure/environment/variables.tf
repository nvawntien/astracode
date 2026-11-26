variable "target" {
  description = "Reviewed environment placement and the matching S4 state container."
  type = object({
    slot            = string
    subscription_id = string
    tenant_id       = string
    location        = string
    storage_prefix  = string
    state_container = string
  })

  validation {
    condition = (
      contains(["S2", "S3"], var.target.slot) &&
      lower(var.target.subscription_id) == lower(lookup(var.approved_subscription_ids, var.target.slot, "")) &&
      var.target.state_container == "${lower(var.target.slot)}-tfstate" &&
      can(regex("^[a-z0-9]{4,14}$", var.target.storage_prefix))
    )
    error_message = "Use S2 or S3, the independently approved subscription for that slot, its matching S4 state container and a lowercase alphanumeric storage prefix of 4 through 14 characters."
  }
}

variable "approved_subscription_ids" {
  description = "The approved S2 and S3 subscription mapping, kept separate from the selected target."
  type        = map(string)

  validation {
    condition = (
      toset(keys(var.approved_subscription_ids)) == toset(["S2", "S3"]) &&
      length(toset([for id in values(var.approved_subscription_ids) : lower(id)])) == 2
    )
    error_message = "S2 and S3 must be mapped to different approved subscriptions."
  }
}

variable "network" {
  description = "VNet address space and approved IPv4 sources for App HTTPS."
  type = object({
    vnet_cidr   = string
    tester_ipv4 = optional(set(string), [])
  })

  validation {
    condition = (
      can(cidrnetmask(var.network.vnet_cidr)) &&
      can(cidrsubnet(var.network.vnet_cidr, 3, 3)) &&
      try(tonumber(split("/", var.network.vnet_cidr)[1]) <= 24, false) &&
      alltrue([for cidr in var.network.tester_ipv4 : can(cidrnetmask(cidr)) && !endswith(cidr, "/0")])
    )
    error_message = "Use an IPv4 VNet of /24 or larger and explicit IPv4 tester CIDRs."
  }
}

variable "compute" {
  description = "Reviewed VM configuration. Enabling compute requires evidence that the controller is armed."
  type = object({
    enabled           = optional(bool, false)
    app_size          = optional(string, "Standard_B2as_v2")
    judge_size        = optional(string, "Standard_B2als_v2")
    app_os_disk_gib   = optional(number, 64)
    judge_os_disk_gib = optional(number, 64)
    app_data_disk_gib = optional(number, 64)
    app_data_uuid     = optional(string)
    ssh_public_key    = optional(string)
    os_image = optional(object({
      publisher = string
      offer     = string
      sku       = string
      version   = string
    }))
    startup = optional(object({
      approval_ref  = string
      controller_id = string
      target_vm_ids = set(string)
      expires_at    = string
    }))
  })
  default = {}

  validation {
    condition = alltrue([
      for size in [var.compute.app_os_disk_gib, var.compute.judge_os_disk_gib, var.compute.app_data_disk_gib] :
      size >= 32 && size == floor(size)
    ])
    error_message = "Use integer disk sizes of at least 32 GiB."
  }
}

variable "controller" {
  description = "Non-secret settings for the Flex Consumption controller and its independent monitor."
  type = object({
    api_client_id       = string
    caller_client_ids   = set(string)
    alert_email         = string
    emergency_object_id = string
    armed               = optional(bool, false)
    policy_json         = optional(string, "{}")
  })

  validation {
    condition = (
      can(regex("^[0-9a-fA-F-]{36}$", var.controller.api_client_id)) &&
      length(var.controller.caller_client_ids) > 0 &&
      can(regex("^[^@ ]+@[^@ ]+$", var.controller.alert_email))
    )
    error_message = "Set the controller's Entra API client ID, allowed calling applications and alert recipient."
  }
}

variable "runtime_secret_names" {
  description = "Existing Key Vault secret names approved for the App loader. Payloads are managed outside Terraform."
  type        = set(string)
  default     = []

  validation {
    condition     = alltrue([for name in var.runtime_secret_names : can(regex("^[A-Za-z0-9-]{1,127}$", name))])
    error_message = "Use exact Key Vault secret names without paths or versions."
  }
}

variable "budget" {
  description = "Approved monthly budget for the target subscription."
  type = object({
    amount    = number
    starts_at = string
    email     = set(string)
  })
}
