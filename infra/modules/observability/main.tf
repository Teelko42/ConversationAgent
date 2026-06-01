variable "name" { type = string }

# Cost + latency dashboards are P0 features (doc 11 §7, doc 12 §8). The metric
# namespace + log groups land here; the dashboards/alarms are defined with the
# app emitting the custom metrics (tokens/hr by tier, Opus escalation rate,
# cache-hit, $/session-hr, SLO-L1..L4 traces keyed to t_word).
resource "aws_cloudwatch_log_group" "app" {
  name              = "/aizen/${var.name}/app"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "audit" {
  name              = "/aizen/${var.name}/audit"
  retention_in_days = 365 # ≥1yr (team-09 §10); ≥6yr for HIPAA tenants (silo)
}

# Custom metric namespace used by the FinOps + SLO instrumentation.
locals {
  metric_namespace = "Aizen/${var.name}"
}

output "metric_namespace" { value = local.metric_namespace }
output "app_log_group" { value = aws_cloudwatch_log_group.app.name }
