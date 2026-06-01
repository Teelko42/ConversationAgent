variable "name" { type = string }
variable "shard_count" { type = number }

# D13 — EventBus = Kinesis Data Streams at MVP. Per-session ordering via the
# `session_id` partition key (set by producers, not here). Graduates to MSK at
# Year-1 behind the `EventBus` abstraction (a config swap, not a rewrite).
resource "aws_kinesis_stream" "session_log" {
  name             = "${var.name}-session-log"
  shard_count      = var.shard_count
  retention_period = 24 # hours (transcript.seg/concept.card hot window; team-08 §4.3)

  stream_mode_details {
    stream_mode = "PROVISIONED"
  }

  # SSE-KMS at rest (team-09 §5). TODO: per-tenant CMK for silo tenants.
  encryption_type = "KMS"
  kms_key_id      = "alias/aws/kinesis"

  tags = { Component = "eventbus", Decision = "D13" }
}

# graph.delta is log-compacted on MSK at Year-1; Kinesis has no compaction, so at
# MVP the kg_delta resync (Seam C) relies on the DeltaIndex + S3 snapshots instead.

output "stream_name" { value = aws_kinesis_stream.session_log.name }
output "stream_arn" { value = aws_kinesis_stream.session_log.arn }
