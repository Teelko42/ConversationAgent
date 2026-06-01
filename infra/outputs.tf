output "vpc_id" {
  value = module.network.vpc_id
}

output "kinesis_stream_name" {
  value = module.eventbus.stream_name
}

output "aurora_endpoint" {
  value = module.datastores.aurora_endpoint
}

output "ecs_cluster_arn" {
  value = module.compute.cluster_arn
}
