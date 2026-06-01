variable "name" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }

# D-PLAT-01 — hot path on ECS Fargate (no Lambda on the hot path; GPU=EKS deferred
# to the self-host scaling trigger, doc 04 / RISK-1).
resource "aws_ecs_cluster" "this" {
  name = "${var.name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled" # feeds the cost/SLO dashboards (P0, doc 11 §7 / doc 12 §8)
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE" # warm hot path; Spot reserved for off-path/batch
    weight            = 1
  }
}

# Service skeletons — task definitions/images come with the app build.
# - realtime-gateway : WSS/WebRTC term, seq assigner, consent gate (D18)
# - extract-explain  : F02 worker (adapter D16 → extract → enrich), LLM gateway client
# TODO(app build): aws_ecs_task_definition + aws_ecs_service per the above,
# autoscaling on active-sessions / Kinesis consumer-lag (team-08 §2.3).

output "cluster_arn" { value = aws_ecs_cluster.this.arn }
output "cluster_name" { value = aws_ecs_cluster.this.name }
