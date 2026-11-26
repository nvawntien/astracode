resource "azurerm_log_analytics_workspace" "controller" {
  name                = "${local.name}-controller"
  resource_group_name = azurerm_resource_group.operations.name
  location            = azurerm_resource_group.operations.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "azurerm_application_insights" "controller" {
  name                          = "${local.name}-controller"
  resource_group_name           = azurerm_resource_group.operations.name
  location                      = azurerm_resource_group.operations.location
  workspace_id                  = azurerm_log_analytics_workspace.controller.id
  application_type              = "web"
  local_authentication_disabled = true
  daily_data_cap_in_gb          = 0.1
  sampling_percentage           = 100
}

resource "azurerm_role_assignment" "controller_monitor" {
  scope                = azurerm_application_insights.controller.id
  role_definition_name = "Monitoring Metrics Publisher"
  principal_id         = azurerm_user_assigned_identity.runtime["controller"].principal_id
}

resource "azurerm_monitor_action_group" "controller" {
  name                = "${local.name}-controller"
  short_name          = "${var.target.slot}-ops"
  resource_group_name = azurerm_resource_group.operations.name

  email_receiver {
    name          = "operations"
    email_address = var.controller.alert_email
  }
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "heartbeat" {
  name                    = "${local.name}-controller-heartbeat"
  resource_group_name     = azurerm_resource_group.operations.name
  location                = azurerm_resource_group.operations.location
  scopes                  = [azurerm_log_analytics_workspace.controller.id]
  severity                = 2
  evaluation_frequency    = "PT1M"
  window_duration         = "PT5M"
  enabled                 = var.controller.armed
  auto_mitigation_enabled = true
  # The AppTraces table may not exist until the first controller telemetry.
  skip_query_validation = true

  criteria {
    query                   = <<-KQL
      let expected = "${azurerm_application_insights.controller.id}";
      union (print Controller=expected, Count=long(0)),
            (AppTraces
             | where TimeGenerated >= ago(5m)
             | where _ResourceId =~ expected and Message == "reconciliation_succeeded"
             | project Controller=expected, Count=long(1))
      | summarize Heartbeats=sum(Count) by Controller
    KQL
    time_aggregation_method = "Minimum"
    metric_measure_column   = "Heartbeats"
    operator                = "LessThan"
    threshold               = 1

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.controller.id]
  }
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "cleanup" {
  name                    = "${local.name}-controller-cleanup"
  resource_group_name     = azurerm_resource_group.operations.name
  location                = azurerm_resource_group.operations.location
  scopes                  = [azurerm_log_analytics_workspace.controller.id]
  severity                = 2
  evaluation_frequency    = "PT1M"
  window_duration         = "PT5M"
  enabled                 = var.controller.armed
  auto_mitigation_enabled = true
  skip_query_validation   = true

  criteria {
    query                   = <<-KQL
      AppTraces
      | where TimeGenerated >= ago(5m)
      | where _ResourceId =~ "${azurerm_application_insights.controller.id}"
      | where Message == "astra-controller-cleanup-overdue"
      | summarize Failures=count()
    KQL
    time_aggregation_method = "Maximum"
    metric_measure_column   = "Failures"
    operator                = "GreaterThan"
    threshold               = 0

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.controller.id]
  }
}
