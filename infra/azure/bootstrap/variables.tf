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
  description = "Approved source networks and Entra object IDs, separated by storage purpose."
  type = object({
    operator_ipv4          = set(string)
    receipt_ipv4           = optional(set(string), [])
    receipt_subnet_ids     = optional(set(string), [])
    state_operator_ids     = map(string)
    backup_operator_id     = string
    receipt_publisher_id   = string
    receipt_reader_ids     = set(string)
    receipt_retention_days = number
  })

  validation {
    condition = (
      length(var.access.operator_ipv4) > 0 &&
      alltrue([for cidr in setunion(var.access.operator_ipv4, var.access.receipt_ipv4) :
        can(cidrnetmask(strcontains(cidr, "/") ? cidr : "${cidr}/32")) &&
        !endswith(cidr, "/0") && !endswith(cidr, "/31")
      ]) &&
      length(var.access.receipt_ipv4) + length(var.access.receipt_subnet_ids) > 0
    )
    error_message = "Set explicit operator and release-record networks. Use individual IPv4 addresses or /1–/30 ranges. /32 inputs are normalized to individual addresses."
  }

  validation {
    condition = (
      alltrue([for slot in ["S2", "S3", "S4"] : contains(keys(var.access.state_operator_ids), slot)]) &&
      alltrue([for slot in keys(var.access.state_operator_ids) : contains(["S1", "S2", "S3", "S4", "S5"], slot)]) &&
      length(distinct(values(var.access.state_operator_ids))) == length(var.access.state_operator_ids) &&
      !contains(values(var.access.state_operator_ids), var.access.backup_operator_id) &&
      !contains(values(var.access.state_operator_ids), var.access.receipt_publisher_id) &&
      var.access.backup_operator_id != var.access.receipt_publisher_id &&
      length(setintersection(var.access.receipt_reader_ids, toset(concat(values(var.access.state_operator_ids), [
        var.access.backup_operator_id, var.access.receipt_publisher_id
      ])))) == 0
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
