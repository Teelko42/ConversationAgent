variable "name" { type = string }
variable "location" { type = string }
variable "resource_group_name" { type = string }
variable "vnet_id" { type = string }
variable "pg_subnet_id" { type = string }
variable "pg_sku" { type = string }
variable "pg_storage_mb" { type = number }
variable "redis_capacity" { type = number }
variable "redis_sku" { type = string }
variable "audio_retention_days" { type = number }
variable "zone_redundant" { type = bool }

data "azurerm_client_config" "current" {}

# Suffix for the globally-unique names (storage/cosmos/keyvault/postgres/redis are DNS names).
resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

# ---------------------------------------------------------------------------
# Secrets — Key Vault is the Azure analog of KMS + Secrets Manager (team-09 §1.2/§5).
# ---------------------------------------------------------------------------
resource "random_password" "pg" {
  length           = 24
  special          = true
  override_special = "!#$%*-_"
}

resource "azurerm_key_vault" "main" {
  name                       = "${var.name}-kv-${random_string.suffix.result}"
  location                   = var.location
  resource_group_name        = var.resource_group_name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  purge_protection_enabled   = true
  soft_delete_retention_days = 7

  # TODO(MAN-F04-001): replace the deployer access policy with RBAC + the app's
  # managed identity granted "Key Vault Secrets User"; add per-tenant CMKs for silo tenants.
  access_policy {
    tenant_id          = data.azurerm_client_config.current.tenant_id
    object_id          = data.azurerm_client_config.current.object_id
    secret_permissions = ["Get", "List", "Set", "Delete", "Purge", "Recover"]
  }

  tags = { Component = "secrets", Decision = "D14/team-09" }
}

resource "azurerm_key_vault_secret" "pg" {
  name         = "pg-admin-password"
  value        = random_password.pg.result
  key_vault_id = azurerm_key_vault.main.id
}

# ---------------------------------------------------------------------------
# D14 — PostgreSQL Flexible Server (relational + pgvector at MVP), VNet-injected.
# ---------------------------------------------------------------------------
resource "azurerm_private_dns_zone" "pg" {
  name                = "${var.name}.private.postgres.database.azure.com"
  resource_group_name = var.resource_group_name
}

resource "azurerm_private_dns_zone_virtual_network_link" "pg" {
  name                  = "${var.name}-pg-dns-link"
  resource_group_name   = var.resource_group_name
  private_dns_zone_name = azurerm_private_dns_zone.pg.name
  virtual_network_id    = var.vnet_id
}

resource "azurerm_postgresql_flexible_server" "pg" {
  name                          = "${var.name}-pg-${random_string.suffix.result}"
  location                      = var.location
  resource_group_name           = var.resource_group_name
  version                       = "16"
  administrator_login           = "aizen_admin"
  administrator_password        = random_password.pg.result # sourced from Key Vault secret above
  storage_mb                    = var.pg_storage_mb
  sku_name                      = var.pg_sku
  zone                          = "1"
  delegated_subnet_id           = var.pg_subnet_id
  private_dns_zone_id           = azurerm_private_dns_zone.pg.id
  public_network_access_enabled = false # private path only; storage is encrypted at rest (team-09 §5)

  dynamic "high_availability" {
    for_each = var.zone_redundant ? [1] : []
    content {
      mode                      = "ZoneRedundant"
      standby_availability_zone = "2"
    }
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.pg]

  tags = { Component = "datastore", Engine = "postgres-pgvector", Decision = "D14" }
}

resource "azurerm_postgresql_flexible_server_database" "main" {
  name      = "aizen"
  server_id = azurerm_postgresql_flexible_server.pg.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# pgvector — allowlist the VECTOR extension; the app runs `CREATE EXTENSION vector`.
resource "azurerm_postgresql_flexible_server_configuration" "vector" {
  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.pg.id
  value     = "VECTOR"
}

# ---------------------------------------------------------------------------
# Azure Cache for Redis — hot session state / cache / token buckets.
# ---------------------------------------------------------------------------
resource "azurerm_redis_cache" "redis" {
  name                 = "${var.name}-redis-${random_string.suffix.result}"
  location             = var.location
  resource_group_name  = var.resource_group_name
  capacity             = var.redis_capacity
  family               = "C" # C = Basic/Standard; P = Premium (adds VNet injection)
  sku_name             = var.redis_sku
  minimum_tls_version  = "1.2"
  non_ssl_port_enabled = false # transit encryption (team-09 §5)

  # TODO: Premium SKU for VNet injection + zone redundancy when MVP sizing grows.
  tags = { Component = "datastore", Decision = "D14" }
}

# ---------------------------------------------------------------------------
# Blob Storage — audio (default OFF per no-retention) + kg snapshots (Seam C).
# ---------------------------------------------------------------------------
resource "azurerm_storage_account" "main" {
  name                              = "${replace(var.name, "-", "")}st${random_string.suffix.result}"
  location                          = var.location
  resource_group_name               = var.resource_group_name
  account_tier                      = "Standard"
  account_replication_type          = var.zone_redundant ? "ZRS" : "LRS"
  min_tls_version                   = "TLS1_2"
  https_traffic_only_enabled        = true
  infrastructure_encryption_enabled = true # double encryption at rest (team-09 §5)

  tags = { Component = "datastore", Decision = "D10/D14" }
}

resource "azurerm_storage_container" "audio" {
  name                  = "audio" # DataClass C4 (D10)
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

resource "azurerm_storage_container" "kg_snapshots" {
  name                  = "kg-snapshots" # Seam C: kg_snapshot materializations (INV-8)
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

resource "azurerm_storage_management_policy" "audio" {
  storage_account_id = azurerm_storage_account.main.id

  rule {
    name    = "no-audio-retention-default"
    enabled = var.audio_retention_days == 0
    filters {
      blob_types   = ["blockBlob"]
      prefix_match = ["audio/"]
    }
    actions {
      base_blob {
        # D10/D18: with no-audio-retention the container should hold nothing; the 1-day
        # floor is a backstop for any accidental write. Tenant opt-in raises the var.
        delete_after_days_since_modification_greater_than = 1
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Cosmos DB (SQL API) — idempotency/dedup, audit-append, and the Seam C
# delta_seq↔Position index. Serverless = the DynamoDB PAY_PER_REQUEST analog.
# ---------------------------------------------------------------------------
resource "azurerm_cosmosdb_account" "main" {
  name                = "${var.name}-cosmos-${random_string.suffix.result}"
  location            = var.location
  resource_group_name = var.resource_group_name
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = var.location
    failover_priority = 0
    zone_redundant    = var.zone_redundant
  }

  capabilities {
    name = "EnableServerless"
  }

  tags = { Component = "datastore", Decision = "D14/Seam-C" }
}

resource "azurerm_cosmosdb_sql_database" "main" {
  name                = "aizen"
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name
}

resource "azurerm_cosmosdb_sql_container" "dedup" {
  name                = "dedup"
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name
  database_name       = azurerm_cosmosdb_sql_database.main.name
  partition_key_paths = ["/id"]
  default_ttl         = -1 # TTL enabled; items expire via their own `ttl` (the expires_at analog)
}

resource "azurerm_cosmosdb_sql_container" "kg_delta_index" {
  # doc 10 §3.2 — delta_seq → bus Position, per session.
  name                = "kg-delta-index"
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name
  database_name       = azurerm_cosmosdb_sql_database.main.name
  partition_key_paths = ["/session_id"]
  default_ttl         = -1
}

output "postgres_fqdn" { value = azurerm_postgresql_flexible_server.pg.fqdn }
output "redis_hostname" { value = azurerm_redis_cache.redis.hostname }
output "audio_container" { value = azurerm_storage_container.audio.name }
output "kg_snapshot_container" { value = azurerm_storage_container.kg_snapshots.name }
output "kg_delta_index_container" { value = azurerm_cosmosdb_sql_container.kg_delta_index.name }
output "key_vault_id" { value = azurerm_key_vault.main.id }
