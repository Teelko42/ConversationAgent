locals {
  name = "aizen-${var.env}"
}

# Everything for an env lives in one resource group (the Azure unit of lifecycle/RBAC/cost).
resource "azurerm_resource_group" "this" {
  name     = "${local.name}-rg"
  location = var.location

  tags = {
    Project   = "aizen"
    Env       = var.env
    ManagedBy = "terraform"
  }
}

module "network" {
  source              = "./modules/network"
  name                = local.name
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  vnet_cidr           = var.vnet_cidr
}

module "observability" {
  source              = "./modules/observability"
  name                = local.name
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
}

# D13 — EventBus = Event Hubs at MVP (→ MSK/Kafka-compatible at Year-1, behind the EventBus abstraction).
module "eventbus" {
  source              = "./modules/eventbus"
  name                = local.name
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  partition_count     = var.eventhub_partition_count
  capacity            = var.eventhub_capacity
  zone_redundant      = var.zone_redundant
}

# D14 — PostgreSQL+pgvector, Redis, Blob, Cosmos DB.
module "datastores" {
  source               = "./modules/datastores"
  name                 = local.name
  location             = var.location
  resource_group_name  = azurerm_resource_group.this.name
  vnet_id              = module.network.vnet_id
  pg_subnet_id         = module.network.data_subnet_id
  pg_sku               = var.pg_sku
  pg_storage_mb        = var.pg_storage_mb
  redis_capacity       = var.redis_capacity
  redis_sku            = var.redis_sku
  audio_retention_days = var.audio_retention_days
  zone_redundant       = var.zone_redundant
}

# D-PLAT-01 — hot path on Container Apps.
module "compute" {
  source                     = "./modules/compute"
  name                       = local.name
  location                   = var.location
  resource_group_name        = azurerm_resource_group.this.name
  app_subnet_id              = module.network.app_subnet_id
  log_analytics_workspace_id = module.observability.workspace_id
  zone_redundant             = var.zone_redundant
}
