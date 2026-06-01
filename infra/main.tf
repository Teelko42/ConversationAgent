locals {
  name = "aizen-${var.env}"
}

module "network" {
  source   = "./modules/network"
  name     = local.name
  vpc_cidr = var.vpc_cidr
  az_count = var.az_count
}

# D13 — EventBus = Kinesis at MVP (→ MSK at Year-1, behind the EventBus abstraction).
module "eventbus" {
  source      = "./modules/eventbus"
  name        = local.name
  shard_count = var.kinesis_shard_count
}

# D14 — Aurora+pgvector, Redis, S3, DynamoDB.
module "datastores" {
  source               = "./modules/datastores"
  name                 = local.name
  subnet_ids           = module.network.data_subnet_ids
  vpc_id               = module.network.vpc_id
  aurora_min_acu       = var.aurora_min_acu
  aurora_max_acu       = var.aurora_max_acu
  audio_retention_days = var.audio_retention_days
}

# D-PLAT-01 — hot path on Fargate.
module "compute" {
  source             = "./modules/compute"
  name               = local.name
  private_subnet_ids = module.network.private_subnet_ids
  vpc_id             = module.network.vpc_id
}

module "observability" {
  source = "./modules/observability"
  name   = local.name
}
