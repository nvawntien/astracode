variable "target" {
  description = "Approved S4 placement. The storage prefix must be available globally."
  type = object({
    slot            = string
    subscription_id = string
    tenant_id       = string
    location        = string
    storage_prefix  = string
  })

  validation {
    condition     = var.target.slot == "S4" && can(regex("^[a-z0-9]{4,15}$", var.target.storage_prefix))
    error_message = "Use the S4 slot and a lowercase alphanumeric storage prefix of 4 through 15 characters."
  }
}

variable "access" {
  description = "Approved state and backup operator networks and per-purpose Entra object IDs."
  type = object({
    operator_ipv4          = set(string)
    state_operator_ids     = map(string)
    backup_operator_id     = optional(string)
    receipt_publisher_id   = optional(string)
    receipt_reader_ids     = optional(set(string), [])
    receipt_retention_days = number
  })

  validation {
    condition = (
      length(var.access.operator_ipv4) > 0 &&
      alltrue([for cidr in var.access.operator_ipv4 :
        can(cidrnetmask(strcontains(cidr, "/") ? cidr : "${cidr}/32")) &&
        !endswith(cidr, "/0") && !endswith(cidr, "/31")
      ])
    )
    error_message = "Set explicit state and backup operator networks. Use individual IPv4 addresses or /1–/30 ranges. /32 inputs are normalized to individual addresses."
  }

  validation {
    condition = (
      alltrue([for slot in ["S2", "S3", "S4"] : contains(keys(var.access.state_operator_ids), slot)]) &&
      alltrue([for slot in keys(var.access.state_operator_ids) : contains(["S1", "S2", "S3", "S4", "S5"], slot)]) &&
      length(toset([for id in concat(
        values(var.access.state_operator_ids),
        tolist(var.access.receipt_reader_ids),
        compact([var.access.backup_operator_id, var.access.receipt_publisher_id])
        ) : lower(id)])) == (
        length(var.access.state_operator_ids) + length(var.access.receipt_reader_ids) +
        (var.access.backup_operator_id == null ? 0 : 1) +
        (var.access.receipt_publisher_id == null ? 0 : 1)
      )
    )
    error_message = "Use separate state, backup, receipt publisher and receipt reader principals. Assign a different state principal to each configured slot."
  }

  validation {
    condition     = var.access.receipt_retention_days >= 1 && var.access.receipt_retention_days <= 146000
    error_message = "Azure container immutability requires a retention period between 1 and 146000 days."
  }
}

variable "budget" {
  description = "Approved S4 monthly budget and notification recipients."
  type = object({
    amount    = number
    starts_at = string
    email     = set(string)
  })
}
