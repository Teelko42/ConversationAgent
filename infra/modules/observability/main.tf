variable "name" { type = string }
variable "location" { type = string }
variable "resource_group_name" { type = string }

# Cost + latency dashboards are P0 features (doc 11 §7, doc 12 §8). The Log Analytics
# workspaces + metric namespace land here; the dashboards/alarms are defined with the
# app emitting the custom metrics (tokens/hr by tier, Opus escalation rate, cache-hit,
# $/session-hr, SLO-L1..L4 traces keyed to t_word) into Azure Monitor.
resource "azurerm_log_analytics_workspace" "app" {
  name                = "${var.name}-app-law"
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

# Audit stream kept separate so it can hold a longer retention than app logs.
resource "azurerm_log_analytics_workspace" "audit" {
  name                = "${var.name}-audit-law"
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "PerGB2018"
  retention_in_days   = 365 # ≥1yr (team-09 §10); ≥6yr for HIPAA tenants (silo)
}

# Custom metric namespace used by the FinOps + SLO instrumentation.
locals {
  metric_namespace = "Aizen/${var.name}"
}

output "workspace_id" { value = azurerm_log_analytics_workspace.app.id }
output "metric_namespace" { value = local.metric_namespace }
output "audit_workspace_id" { value = azurerm_log_analytics_workspace.audit.id }
