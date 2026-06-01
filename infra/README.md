# Aizen Infrastructure (Terraform skeleton)

> **Status: skeleton, no live deploy.** This is the MVP topology (doc 03 §2) as
> Terraform module structure. `terraform plan/apply` will **not** run until an AWS
> account + credentials exist — that is the hard external gate **MAN-F04-001**
> (AWS org/accounts/billing owner). The skeleton lets the platform shape, sizing,
> and decisions live in code now; wiring real providers is a Phase-0 task once the
> account lands.

## Topology (MVP, D02 = ~200 concurrent, single region us-east-1)

```
modules/
  network        VPC, public/private/data subnets (3 AZ), NAT, VPC endpoints
  eventbus       Kinesis Data Streams, per-session shard (D13 — Kinesis @ MVP)
  datastores     Aurora PostgreSQL + pgvector, ElastiCache Redis, S3, DynamoDB (D14)
  compute        ECS Fargate cluster + service skeletons (gateway / extract-explain)
  observability  CloudWatch log groups, metric namespace (cost/SLO dashboards = P0)
```

## Decisions encoded here

| Decision | Where |
|---|---|
| **D13** EventBus = Kinesis @ MVP → MSK @ Year-1 (behind `EventBus` abstraction) | `modules/eventbus` |
| **D14** Aurora+pgvector, Redis, S3, +DynamoDB (idempotency/audit) | `modules/datastores` |
| **D03** single region us-east-1, multi-AZ | `variables.tf` (`region`, `az_count`) |
| **D-PLAT-01** hot path = Fargate (no Lambda on hot path; GPU=EKS deferred) | `modules/compute` |
| **D10 / D18** no-audio-retention default; audio bucket lifecycle = expire | `modules/datastores` (S3 lifecycle) |

## What is intentionally deferred (scaling triggers, doc 04)

MSK, EKS+Karpenter GPU (self-host STT/LLM), Neptune, dedicated vector DB, Shield
Advanced, second region / EU residency — added when the doc-04 triggers fire,
not at MVP.

## How to use (once MAN-F04-001 lands)

```bash
cd infra
terraform init
terraform plan  -var-file=env/mvp.tfvars
terraform apply -var-file=env/mvp.tfvars
```

State backend (S3 + DynamoDB lock) is left as a TODO in `versions.tf` — set it to
the account's bootstrap bucket before first `init`.
