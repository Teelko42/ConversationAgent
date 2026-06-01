variable "name" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "aurora_min_acu" { type = number }
variable "aurora_max_acu" { type = number }
variable "audio_retention_days" { type = number }

# D14 — Aurora PostgreSQL (relational + pgvector at MVP). Serverless v2.
resource "aws_db_subnet_group" "aurora" {
  name       = "${var.name}-aurora"
  subnet_ids = var.subnet_ids
}

resource "aws_rds_cluster" "aurora" {
  cluster_identifier = "${var.name}-pg"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned" # Serverless v2 uses provisioned + serverlessv2 scaling
  engine_version     = "16.4"
  database_name      = "aizen"
  master_username    = "aizen_admin"
  # TODO(MAN-F04-001): master password via Secrets Manager + rotation (team-09 §1.2).
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.aurora.name
  storage_encrypted           = true # SSE-KMS (team-09 §5)
  skip_final_snapshot         = true

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_min_acu
    max_capacity = var.aurora_max_acu
  }

  tags = { Component = "datastore", Engine = "aurora-pgvector", Decision = "D14" }
}

resource "aws_rds_cluster_instance" "aurora" {
  identifier         = "${var.name}-pg-1"
  cluster_identifier = aws_rds_cluster.aurora.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.aurora.engine
  engine_version     = aws_rds_cluster.aurora.engine_version
}

# ElastiCache Redis — hot session state / cache / token buckets.
resource "aws_elasticache_subnet_group" "redis" {
  name       = "${var.name}-redis"
  subnet_ids = var.subnet_ids
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${var.name}-redis"
  description                = "Aizen session state / cache"
  engine                     = "redis"
  node_type                  = "cache.t4g.small" # MVP sizing
  num_cache_clusters         = 2
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
}

# S3 — audio (default OFF per no-retention) + artifacts + kg snapshots (Seam C).
resource "aws_s3_bucket" "audio" {
  bucket = "${var.name}-audio"
  tags   = { Component = "datastore", DataClass = "C4", Decision = "D10" }
}

resource "aws_s3_bucket_lifecycle_configuration" "audio" {
  bucket = aws_s3_bucket.audio.id

  rule {
    id     = "no-audio-retention-default"
    status = var.audio_retention_days == 0 ? "Enabled" : "Disabled"
    expiration {
      # D10/D18: with no-audio-retention the bucket should hold nothing; the 1-day
      # floor is a backstop for any accidental write. Tenant opt-in raises the var.
      days = 1
    }
  }
}

resource "aws_s3_bucket" "kg_snapshots" {
  bucket = "${var.name}-kg-snapshots" # Seam C: kg_snapshot materializations
  tags   = { Component = "datastore", Decision = "INV-8/Seam-C" }
}

# DynamoDB — idempotency/dedup, audit-append, and the Seam C delta_seq↔Position index.
resource "aws_dynamodb_table" "dedup" {
  name         = "${var.name}-dedup"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"
  attribute {
    name = "id"
    type = "S"
  }
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }
  tags = { Component = "datastore", Decision = "D14" }
}

resource "aws_dynamodb_table" "kg_delta_index" {
  # doc 10 §3.2 — delta_seq → bus Position, per session.
  name         = "${var.name}-kg-delta-index"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "session_id"
  range_key    = "delta_seq"
  attribute {
    name = "session_id"
    type = "S"
  }
  attribute {
    name = "delta_seq"
    type = "N"
  }
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }
  tags = { Component = "datastore", Decision = "Seam-C" }
}

output "aurora_endpoint" { value = aws_rds_cluster.aurora.endpoint }
output "redis_endpoint" { value = aws_elasticache_replication_group.redis.primary_endpoint_address }
output "audio_bucket" { value = aws_s3_bucket.audio.id }
output "kg_snapshot_bucket" { value = aws_s3_bucket.kg_snapshots.id }
output "kg_delta_index_table" { value = aws_dynamodb_table.kg_delta_index.name }
