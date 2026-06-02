variable "name" { type = string }
variable "location" { type = string }
variable "resource_group_name" { type = string }
variable "app_subnet_id" { type = string }
variable "log_analytics_workspace_id" { type = string }
variable "zone_redundant" { type = bool }

# D-PLAT-01 — hot path on Azure Container Apps (serverless containers; the Fargate
# analog). No Functions on the hot path; GPU (self-host STT/LLM) is deferred to the
# scaling trigger via a workload-profile / AKS pool (doc 04 / RISK-1).
resource "azurerm_container_app_environment" "this" {
  name                       = "${var.name}-cae"
  location                   = var.location
  resource_group_name        = var.resource_group_name
  log_analytics_workspace_id = var.log_analytics_workspace_id # feeds cost/SLO dashboards (doc 11 §7 / doc 12 §8)
  infrastructure_subnet_id   = var.app_subnet_id
  zone_redundancy_enabled    = var.zone_redundant
}

# Service skeletons — container images / app definitions come with the app build.
# - realtime-gateway : WSS/WebRTC term, seq assigner, consent gate (D18)
# - extract-explain  : F02 worker (adapter D16 → extract → enrich), LLM gateway client
# TODO(app build): azurerm_container_app per the above, with scale rules on
# active-sessions / Event Hubs consumer-lag (KEDA; team-08 §2.3). Spot via the
# Consumption workload profile for off-path/batch.

output "environment_id" { value = azurerm_container_app_environment.this.id }
output "environment_name" { value = azurerm_container_app_environment.this.name }
