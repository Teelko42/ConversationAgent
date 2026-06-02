variable "name" { type = string }
variable "location" { type = string }
variable "resource_group_name" { type = string }
variable "partition_count" { type = number }
variable "capacity" { type = number }
variable "zone_redundant" { type = bool }

# D13 — EventBus = Azure Event Hubs at MVP. Per-session ordering via the
# `session_id` partition key (set by producers, not here). Graduates to a
# Kafka-compatible log (MSK / Event Hubs Kafka surface) at Year-1 behind the
# `EventBus` abstraction (a config swap, not a rewrite).
resource "azurerm_eventhub_namespace" "this" {
  name                = "${var.name}-ehns"
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "Standard"
  capacity            = var.capacity # throughput units
  zone_redundant      = var.zone_redundant

  # Encryption at rest is on by default with Microsoft-managed keys (team-09 §5).
  # TODO: customer-managed key (Key Vault) for silo tenants — requires the Dedicated tier.

  tags = { Component = "eventbus", Decision = "D13" }
}

resource "azurerm_eventhub" "session_log" {
  name              = "${var.name}-session-log"
  namespace_id      = azurerm_eventhub_namespace.this.id
  partition_count   = var.partition_count
  message_retention = 1 # day — transcript.seg/concept.card hot window (team-08 §4.3)
}

# graph.delta is log-compacted on the Year-1 Kafka surface; Event Hubs has no
# compaction, so at MVP the kg_delta resync (Seam C) relies on the DeltaIndex +
# Blob snapshots instead.

output "eventhub_name" { value = azurerm_eventhub.session_log.name }
output "namespace_id" { value = azurerm_eventhub_namespace.this.id }
