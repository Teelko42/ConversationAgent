variable "region" {
  description = "Primary AWS region (D03: us-east-1 at MVP)."
  type        = string
  default     = "us-east-1"
}

variable "env" {
  description = "Environment name (mvp | staging | prod)."
  type        = string
  default     = "mvp"
}

variable "az_count" {
  description = "Number of AZs to span (multi-AZ at MVP)."
  type        = number
  default     = 3
}

variable "vpc_cidr" {
  description = "VPC CIDR."
  type        = string
  default     = "10.0.0.0/16"
}

variable "kinesis_shard_count" {
  description = "Kinesis shards (D13). MVP ~200 concurrent sessions; size for 2x peak."
  type        = number
  default     = 8
}

variable "aurora_min_acu" {
  description = "Aurora Serverless v2 min ACU (MVP)."
  type        = number
  default     = 0.5
}

variable "aurora_max_acu" {
  description = "Aurora Serverless v2 max ACU (MVP)."
  type        = number
  default     = 8
}

variable "audio_retention_days" {
  description = "S3 audio lifecycle (D10/D18: default 0 = no-audio-retention; tenant opt-in raises it)."
  type        = number
  default     = 0
}
