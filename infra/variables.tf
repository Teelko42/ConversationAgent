variable "location" {
  description = "Primary Azure region (D03: eastus at MVP)."
  type        = string
  default     = "eastus"
}

variable "env" {
  description = "Environment name (mvp | staging | prod)."
  type        = string
  default     = "mvp"
}

variable "zone_redundant" {
  description = "Span availability zones where the SKU supports it (multi-AZ at MVP)."
  type        = bool
  default     = true
}

variable "vnet_cidr" {
  description = "Virtual Network address space."
  type        = string
  default     = "10.0.0.0/16"
}

variable "eventhub_partition_count" {
  description = "Event Hubs partitions (D13). MVP ~200 concurrent sessions; size for 2x peak."
  type        = number
  default     = 8
}

variable "eventhub_capacity" {
  description = "Event Hubs namespace throughput units (Standard tier)."
  type        = number
  default     = 2
}

variable "pg_sku" {
  description = "PostgreSQL Flexible Server SKU (MVP burstable/general-purpose)."
  type        = string
  default     = "GP_Standard_D2ds_v5"
}

variable "pg_storage_mb" {
  description = "PostgreSQL Flexible Server storage (MB)."
  type        = number
  default     = 32768
}

variable "redis_capacity" {
  description = "Azure Cache for Redis capacity (C-family: 0..6)."
  type        = number
  default     = 1
}

variable "redis_sku" {
  description = "Azure Cache for Redis SKU (Basic | Standard | Premium)."
  type        = string
  default     = "Standard"
}

variable "audio_retention_days" {
  description = "Blob audio lifecycle (D10/D18: default 0 = no-audio-retention; tenant opt-in raises it)."
  type        = number
  default     = 0
}
